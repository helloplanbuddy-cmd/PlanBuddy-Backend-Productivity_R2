'use strict';

/**
 * workers/payment-audit-retention.worker.js
 * PlanBuddy V9 — Payment Audit Log Retention Worker
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCHITECTURE OVERVIEW
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  ┌─────────────────────────────────────────────────────────────────────────┐
 *  │  CRON / BullMQ trigger (02:00 UTC daily)                                │
 *  └────────────────────────┬────────────────────────────────────────────────┘
 *                           │
 *                           ▼
 *  ┌─────────────────────────────────────────────────────────────────────────┐
 *  │  acquireAdvisoryLock()  — ensures single-writer across replicas         │
 *  └────────────────────────┬────────────────────────────────────────────────┘
 *                           │
 *                           ▼
 *  ┌─────────────────────────────────────────────────────────────────────────┐
 *  │  recordJobStart()  — inserts row into retention_job_runs                │
 *  └────────────────────────┬────────────────────────────────────────────────┘
 *                           │
 *                     ┌─────┴──────┐
 *                     │  LOOP      │  (up to maxBatchesPerRun)
 *                     │            ▼
 *                     │  fetchEligibleBatch()                                │
 *                     │    SELECT … WHERE archivable AND created_at < cutoff │
 *                     │    LIMIT batchSize FOR UPDATE SKIP LOCKED            │
 *                     │            │                                          │
 *                     │            ▼                                          │
 *                     │  archiveBatch()  (single transaction)                │
 *                     │    INSERT INTO payment_audit_logs_archive …          │
 *                     │    DELETE FROM payment_audit_logs WHERE id = ANY(…)  │
 *                     │            │                                          │
 *                     │    on fail → retryWithBackoff()                      │
 *                     │    on exhaust → deadLetterBatch()                    │
 *                     │                                                       │
 *                     │  sleep(batchDelayMs)                                 │
 *                     └─────────────────────────────────────────────────────┘
 *                           │
 *                           ▼
 *  ┌─────────────────────────────────────────────────────────────────────────┐
 *  │  recordJobComplete()  — updates retention_job_runs row + emit metrics   │
 *  └─────────────────────────────────────────────────────────────────────────┘
 *
 * SAFETY GUARANTEES
 *  • NEVER touches rows where payment_status != 'completed'
 *  • NEVER touches rows where refund_status NOT IN ('settled','none', null)
 *  • NEVER touches rows where dispute_flag = true
 *  • Uses FOR UPDATE SKIP LOCKED → safe under concurrent writes
 *  • Each batch is a single atomic transaction → no partial moves
 *  • Advisory lock prevents concurrent runs across nodes
 *  • Idempotent: if a batch was partially committed the worker detects
 *    already-archived source_row_ids and skips them
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { Pool }      = require('pg');
const cron          = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const config        = require('../config/retention');
const metrics       = require('../monitoring/paymentMetrics');

// ---------------------------------------------------------------------------
// DATABASE POOL
// The worker uses its own pool with conservative settings so it cannot
// starve the payment application connection pool.
// ---------------------------------------------------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max:              parseInt(process.env.RETENTION_DB_POOL_MAX  ?? '3', 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: 'planbuddy_retention_worker',
});

pool.on('error', (err) => {
  logger.error({ err }, '[retention-pool] Unexpected pool error');
});

// ---------------------------------------------------------------------------
// LOGGER  (replace with your winston/pino instance)
// ---------------------------------------------------------------------------
const logger = {
  info:  (...args) => console.log (new Date().toISOString(), '[INFO ]', ...args),
  warn:  (...args) => console.warn (new Date().toISOString(), '[WARN ]', ...args),
  error: (...args) => console.error(new Date().toISOString(), '[ERROR]', ...args),
};

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/** Non-blocking sleep */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff delay for retry attempt n (1-indexed) */
const backoffMs = (attempt) =>
  config.retryDelayMs * Math.pow(config.retryBackoffMultiplier, attempt - 1);

// ---------------------------------------------------------------------------
// ADVISORY LOCK
// Prevents two worker instances (e.g. multiple pods) from running concurrently.
// Uses session-level advisory lock; released automatically on disconnect.
// ---------------------------------------------------------------------------

async function acquireAdvisoryLock(client) {
  const { rows } = await client.query(
    'SELECT pg_try_advisory_lock($1) AS acquired',
    [config.advisoryLockKey],
  );
  return rows[0].acquired === true;
}

async function releaseAdvisoryLock(client) {
  await client.query('SELECT pg_advisory_unlock($1)', [config.advisoryLockKey]);
}

// ---------------------------------------------------------------------------
// JOB RUN TRACKING
// ---------------------------------------------------------------------------

async function recordJobStart(client, batchId) {
  const { rows } = await client.query(
    `INSERT INTO retention_job_runs
       (batch_id, job_name, started_at, status)
     VALUES ($1, $2, NOW(), 'running')
     RETURNING id`,
    [batchId, config.jobName],
  );
  return rows[0].id;
}

async function recordJobComplete(client, runId, summary) {
  await client.query(
    `UPDATE retention_job_runs SET
       completed_at   = NOW(),
       status         = $1,
       rows_scanned   = $2,
       rows_archived  = $3,
       rows_skipped   = $4,
       error_message  = $5,
       metadata       = $6
     WHERE id = $7`,
    [
      summary.status,
      summary.rowsScanned,
      summary.rowsArchived,
      summary.rowsSkipped,
      summary.errorMessage ?? null,
      JSON.stringify(summary.metadata ?? {}),
      runId,
    ],
  );
}

// ---------------------------------------------------------------------------
// FETCH ELIGIBLE BATCH
//
// Uses FOR UPDATE SKIP LOCKED to safely select rows in a multi-writer env.
// The SKIP LOCKED clause means concurrent payment writes never block this
// query and vice-versa.
// ---------------------------------------------------------------------------

async function fetchEligibleBatch(client, cutoffDate, batchSize) {
  const { rows } = await client.query(
    `SELECT id
     FROM payment_audit_logs
     WHERE
       created_at       < $1
       AND payment_status  = 'completed'
       AND (refund_status  IN ('settled','none') OR refund_status IS NULL)
       AND dispute_flag    = FALSE
     ORDER BY created_at ASC
     LIMIT $2
     FOR UPDATE SKIP LOCKED`,
    [cutoffDate, batchSize],
  );
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// ARCHIVE A SINGLE BATCH  (atomic transaction)
//
// INSERT → DELETE in one transaction.  If either fails the transaction rolls
// back and the source rows are left untouched — no data loss possible.
// ---------------------------------------------------------------------------

async function archiveBatch(batchId, rowIds) {
  const client = await pool.connect();
  const batchStart = Date.now();

  try {
    await client.query('BEGIN');

    // 1. INSERT copies into archive table
    //    source_row_id enables idempotency: if this INSERT has already run
    //    (partial commit from a crash) the UNIQUE constraint will surface it.
    await client.query(
      `INSERT INTO payment_audit_logs_archive (
         payment_id, user_id, event_type, event_data,
         payment_status, refund_status, dispute_flag,
         amount, currency, created_at, updated_at,
         archived_at, archive_batch_id, source_row_id,
         checksum
       )
       SELECT
         payment_id, user_id, event_type, event_data,
         payment_status, refund_status, dispute_flag,
         amount, currency, created_at, updated_at,
         NOW(), $1, id,
         -- lightweight checksum: SHA-256 of business-critical fields
         encode(
           sha256(
             (id::TEXT || payment_id::TEXT || COALESCE(amount::TEXT,'') || created_at::TEXT)::BYTEA
           ),
           'hex'
         )
       FROM payment_audit_logs
       WHERE id = ANY($2::BIGINT[])
       ON CONFLICT (source_row_id) DO NOTHING`,   -- idempotency guard
      [batchId, rowIds],
    );

    // 2. DELETE from source ONLY after successful archive INSERT
    //    Re-check safety predicates inside the same transaction to guard
    //    against race conditions (status changed between fetch and delete).
    const { rowCount } = await client.query(
      `DELETE FROM payment_audit_logs
       WHERE
         id = ANY($1::BIGINT[])
         AND payment_status  = 'completed'
         AND (refund_status  IN ('settled','none') OR refund_status IS NULL)
         AND dispute_flag    = FALSE`,
      [rowIds],
    );

    await client.query('COMMIT');

    const durationMs = Date.now() - batchStart;
    metrics.batchDurationMs.observe({ job_name: config.jobName }, durationMs);

    return { archived: rowCount, skipped: rowIds.length - rowCount };

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// RETRY WRAPPER FOR A SINGLE BATCH
// ---------------------------------------------------------------------------

async function archiveBatchWithRetry(batchId, rowIds, jobName) {
  let attempt = 0;

  while (attempt < config.maxRetries) {
    attempt++;
    try {
      const result = await archiveBatch(batchId, rowIds);
      return result;
    } catch (err) {
      const isLastAttempt = attempt >= config.maxRetries;

      logger.warn(
        { err: err.message, attempt, maxRetries: config.maxRetries, batchId },
        '[retention] Batch failed — retrying',
      );

      metrics.batchRetriesTotal.inc({ job_name: jobName });

      if (isLastAttempt) {
        metrics.batchFailuresTotal.inc({ job_name: jobName });
        await deadLetterBatch(batchId, rowIds, err);
        throw err;
      }

      await sleep(backoffMs(attempt));
    }
  }
}

// ---------------------------------------------------------------------------
// DEAD-LETTER  — persist failed batches for manual review
// ---------------------------------------------------------------------------

async function deadLetterBatch(batchId, rowIds, err) {
  try {
    await pool.query(
      `INSERT INTO retention_job_runs
         (batch_id, job_name, started_at, completed_at, status, error_message, metadata)
       VALUES
         ($1, $2, NOW(), NOW(), 'failed', $3, $4)
       ON CONFLICT (batch_id) DO UPDATE SET
         status = 'failed',
         error_message = EXCLUDED.error_message`,
      [
        uuidv4(),  // new UUID for the dead-letter record
        `${config.jobName}:dead-letter`,
        err.message,
        JSON.stringify({ originalBatchId: batchId, rowIds }),
      ],
    );
    logger.error(
      { batchId, rowCount: rowIds.length, error: err.message },
      '[retention] DEAD-LETTERED batch — manual review required',
    );
  } catch (dlErr) {
    // Dead-letter insert failed — at minimum log to stderr so alerting picks it up
    logger.error({ dlErr, batchId }, '[retention] CRITICAL: Failed to dead-letter batch');
  }
}

// ---------------------------------------------------------------------------
// UPDATE OPERATIONAL GAUGES (non-blocking, best-effort)
// Called after each successful run to give dashboards current state.
// ---------------------------------------------------------------------------

async function updateOperationalGauges() {
  try {
    // Archive table row count (fast approximate)
    const { rows: archiveRows } = await pool.query(
      `SELECT reltuples::BIGINT AS estimate
       FROM pg_class
       WHERE relname = 'payment_audit_logs_archive'`,
    );
    if (archiveRows[0]) {
      metrics.archiveTableSize.set(Number(archiveRows[0].estimate));
    }

    // Locked rows by reason
    const { rows: lockRows } = await pool.query(
      `SELECT lock_reason, COUNT(*) AS cnt
       FROM v_payment_audit_logs_locked
       GROUP BY lock_reason`,
    );
    for (const row of lockRows) {
      metrics.lockedRowsCount.set({ lock_reason: row.lock_reason }, Number(row.cnt));
    }
  } catch (err) {
    logger.warn({ err: err.message }, '[retention] Failed to update operational gauges (non-fatal)');
  }
}

// ---------------------------------------------------------------------------
// MAIN JOB FUNCTION
// ---------------------------------------------------------------------------

async function runRetentionJob() {
  const jobStart   = Date.now();
  const batchId    = uuidv4();
  const jobName    = config.jobName;
  const cutoffDate = new Date(Date.now() - config.retentionDays * 86_400_000);

  logger.info({ batchId, cutoffDate, retentionDays: config.retentionDays }, '[retention] Job starting');

  metrics.jobRunning.set({ job_name: jobName }, 1);

  let lockClient = null;
  let runId      = null;

  const summary = {
    status:       'completed',
    rowsScanned:  0,
    rowsArchived: 0,
    rowsSkipped:  0,
    errorMessage: null,
    metadata:     { batchId, batchCount: 0, cutoffDate },
  };

  try {
    // ── 1. Acquire advisory lock ──────────────────────────────────────────
    lockClient = await pool.connect();
    const locked = await acquireAdvisoryLock(lockClient);

    if (!locked) {
      logger.warn({ batchId }, '[retention] Another instance is running — skipping this run');
      metrics.jobRunning.set({ job_name: jobName }, 0);
      lockClient.release();
      return;
    }

    // ── 2. Record job start ───────────────────────────────────────────────
    runId = await recordJobStart(lockClient, batchId);

    // ── 3. Batch loop ─────────────────────────────────────────────────────
    let batchCount = 0;

    while (batchCount < config.maxBatchesPerRun) {
      // Fetch IDs in their own connection (outside archiveBatch transaction)
      // so SKIP LOCKED gives us rows not currently being processed.
      const fetchClient = await pool.connect();
      let rowIds;
      try {
        await fetchClient.query('BEGIN');
        rowIds = await fetchEligibleBatch(fetchClient, cutoffDate, config.batchSize);
        await fetchClient.query('ROLLBACK'); // release row locks from SELECT
      } finally {
        fetchClient.release();
      }

      if (rowIds.length === 0) {
        logger.info({ batchId, batchCount }, '[retention] No more eligible rows — done');
        break;
      }

      summary.rowsScanned += rowIds.length;

      logger.info(
        { batchId, batchCount: batchCount + 1, rows: rowIds.length },
        '[retention] Processing batch',
      );

      const { archived, skipped } = await archiveBatchWithRetry(batchId, rowIds, jobName);

      summary.rowsArchived += archived;
      summary.rowsSkipped  += skipped;

      metrics.rowsArchivedTotal.inc({ job_name: jobName }, archived);
      metrics.rowsScannedTotal.inc({ job_name: jobName },  rowIds.length);

      if (skipped > 0) {
        metrics.rowsSkippedTotal.inc({ job_name: jobName, skip_reason: 'safety_predicate_mismatch' }, skipped);
      }

      batchCount++;
      summary.metadata.batchCount = batchCount;

      // Yield to event loop / throttle I/O between batches
      await sleep(config.batchDelayMs);
    }

    if (batchCount >= config.maxBatchesPerRun) {
      logger.warn({ batchId, batchCount }, '[retention] Reached maxBatchesPerRun — will continue next run');
      summary.metadata.cappedByMaxBatches = true;
    }

    // ── 4. Finalise ───────────────────────────────────────────────────────
    const durationMs = Date.now() - jobStart;

    logger.info(
      { batchId, ...summary, durationMs },
      '[retention] Job completed successfully',
    );

    metrics.retentionJobDurationMs.observe({ job_name: jobName, status: 'success' }, durationMs);
    metrics.jobSuccessTotal.inc({ job_name: jobName });
    metrics.lastSuccessTimestamp.set({ job_name: jobName }, Math.floor(Date.now() / 1000));

    // Alert on unexpectedly large runs
    if (summary.rowsArchived > config.alertThresholdRows) {
      logger.warn(
        { batchId, rowsArchived: summary.rowsArchived, threshold: config.alertThresholdRows },
        '[retention] ALERT: Archived row count exceeded threshold — verify retention policy',
      );
    }

  } catch (err) {
    const durationMs = Date.now() - jobStart;
    summary.status       = 'failed';
    summary.errorMessage = err.message;

    logger.error({ batchId, err: err.message, durationMs }, '[retention] Job FAILED');

    metrics.jobFailuresTotal.inc({ job_name: jobName, failure_type: err.constructor?.name ?? 'Error' });
    metrics.retentionJobDurationMs.observe({ job_name: jobName, status: 'failure' }, durationMs);

    // Do NOT rethrow — the payment system must not be affected by retention failures

  } finally {
    // ── 5. Update job run record ──────────────────────────────────────────
    if (runId && lockClient) {
      try {
        await recordJobComplete(lockClient, runId, summary);
      } catch (finalErr) {
        logger.error({ finalErr: finalErr.message }, '[retention] Failed to record job completion');
      }
    }

    // ── 6. Release advisory lock + connection ─────────────────────────────
    if (lockClient) {
      try {
        await releaseAdvisoryLock(lockClient);
      } finally {
        lockClient.release();
      }
    }

    metrics.jobRunning.set({ job_name: jobName }, 0);

    // ── 7. Update dashboard gauges (best-effort) ──────────────────────────
    setImmediate(updateOperationalGauges);
  }
}

// ---------------------------------------------------------------------------
// CRON SCHEDULER
// ---------------------------------------------------------------------------

function startCronScheduler() {
  logger.info(
    { schedule: config.cronSchedule, jobName: config.jobName },
    '[retention] Scheduling retention cron job',
  );

  cron.schedule(config.cronSchedule, async () => {
    try {
      await runRetentionJob();
    } catch (err) {
      // runRetentionJob swallows its own errors, but just in case:
      logger.error({ err: err.message }, '[retention] Unhandled error from runRetentionJob');
    }
  });
}

// ---------------------------------------------------------------------------
// BULLMQ INTEGRATION (optional — use instead of cron if you have BullMQ)
// ---------------------------------------------------------------------------

/**
 * Returns a BullMQ processor function.
 * Usage:
 *   const { Worker } = require('bullmq');
 *   const { bullmqProcessor } = require('./payment-audit-retention.worker');
 *   new Worker(config.queueName, bullmqProcessor, { connection });
 */
async function bullmqProcessor(job) {
  logger.info({ jobId: job.id }, '[retention] BullMQ job triggered');
  await runRetentionJob();
}

// ---------------------------------------------------------------------------
// EXPORTS
// ---------------------------------------------------------------------------

module.exports = {
  runRetentionJob,
  startCronScheduler,
  bullmqProcessor,
  // Exported for testing
  _internals: {
    fetchEligibleBatch,
    archiveBatch,
    archiveBatchWithRetry,
    deadLetterBatch,
    acquireAdvisoryLock,
    releaseAdvisoryLock,
    recordJobStart,
    recordJobComplete,
  },
};

// ---------------------------------------------------------------------------
// STANDALONE ENTRY POINT
// Run directly:  node workers/payment-audit-retention.worker.js [--now]
// ---------------------------------------------------------------------------

if (require.main === module) {
  const runImmediately = process.argv.includes('--now');

  if (runImmediately) {
    logger.info('[retention] Running immediately (--now flag)');
    runRetentionJob()
      .then(() => {
        logger.info('[retention] One-shot run complete');
        process.exit(0);
      })
      .catch((err) => {
        logger.error({ err: err.message }, '[retention] One-shot run failed');
        process.exit(1);
      });
  } else {
    startCronScheduler();
    logger.info('[retention] Worker started — waiting for scheduled runs');

    // Keep process alive
    process.on('SIGTERM', async () => {
      logger.info('[retention] SIGTERM received — shutting down gracefully');
      await pool.end();
      process.exit(0);
    });
  }
}

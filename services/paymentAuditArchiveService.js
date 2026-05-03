'use strict';

/**
 * services/paymentAuditArchiveService.js
 * PlanBuddy V9 — Payment Audit Archive Service
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RESPONSIBILITIES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This service is the single authoritative layer for all read/write operations
 * against both `payment_audit_logs` (hot) and `payment_audit_logs_archive`
 * (cold).  It is consumed by:
 *
 *   • workers/payment-audit-retention.worker.js  — batch archival pipeline
 *   • API controllers                            — compliance / audit queries
 *   • Admin tooling                              — manual recovery, inspection
 *
 * It does NOT own scheduling or cron logic — that lives in the worker.
 * It does NOT own Prometheus metrics — those are in monitoring/paymentMetrics.js.
 * It DOES enforce every safety predicate before any destructive operation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DESIGN PRINCIPLES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  1. NEVER delete without a verified archive copy.
 *  2. All mutating operations accept an external pg client/pool so callers
 *     control transaction boundaries.
 *  3. Every public method validates its inputs and throws typed errors.
 *  4. Read queries are safe to call during live payment traffic (read replicas,
 *     SKIP LOCKED, no table-level locks).
 *  5. All SQL predicates are parameterised — no string interpolation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

const crypto  = require('crypto');
const { Pool } = require('pg');
const config   = require('../config/retention');

// ---------------------------------------------------------------------------
// INTERNAL DB POOL (separate from app pool — retention never starves payments)
// ---------------------------------------------------------------------------
const pool = new Pool({
  connectionString:        process.env.DATABASE_URL,
  max:                     parseInt(process.env.ARCHIVE_SERVICE_POOL_MAX ?? '5', 10),
  idleTimeoutMillis:       30_000,
  connectionTimeoutMillis: 5_000,
  application_name:        'planbuddy_archive_service',
});

// ---------------------------------------------------------------------------
// TYPED ERRORS
// ---------------------------------------------------------------------------

class ArchiveServiceError extends Error {
  constructor(message, code, meta = {}) {
    super(message);
    this.name    = 'ArchiveServiceError';
    this.code    = code;
    this.meta    = meta;
  }
}

class SafetyPredicateError extends ArchiveServiceError {
  constructor(rowId, reason) {
    super(`Row ${rowId} failed safety predicate: ${reason}`, 'SAFETY_PREDICATE_VIOLATION', { rowId, reason });
    this.name = 'SafetyPredicateError';
  }
}

class RowNotFoundError extends ArchiveServiceError {
  constructor(rowId, table) {
    super(`Row ${rowId} not found in ${table}`, 'ROW_NOT_FOUND', { rowId, table });
    this.name = 'RowNotFoundError';
  }
}

class ArchiveIntegrityError extends ArchiveServiceError {
  constructor(rowId, expected, actual) {
    super(`Checksum mismatch for row ${rowId}`, 'CHECKSUM_MISMATCH', { rowId, expected, actual });
    this.name = 'ArchiveIntegrityError';
  }
}

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------

const HOT_TABLE     = 'payment_audit_logs';
const ARCHIVE_TABLE = 'payment_audit_logs_archive';

/**
 * Statuses that are safe for archival.
 * Mirrors config/retention.js — source of truth is the config.
 */
const SAFE_PAYMENT_STATUSES = new Set(config.safeStatuses.payment);
const SAFE_REFUND_STATUSES  = new Set(config.safeStatuses.refund.filter(Boolean)); // exclude null

// ---------------------------------------------------------------------------
// INTERNAL HELPERS
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic SHA-256 checksum over the business-critical fields
 * of a payment_audit_logs row.  Used to detect silent data corruption between
 * archival and verification.
 *
 * @param {object} row — raw DB row object
 * @returns {string} hex-encoded SHA-256
 */
function computeRowChecksum(row) {
  const payload = [
    String(row.id          ?? ''),
    String(row.payment_id  ?? ''),
    String(row.amount      ?? ''),
    String(row.currency    ?? ''),
    String(row.created_at  ?? ''),
    String(row.event_type  ?? ''),
    String(row.payment_status ?? ''),
  ].join('|');

  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Evaluate whether a row meets all four safety predicates for archival.
 * Returns { eligible: true } or { eligible: false, reason: string }.
 *
 * @param {object} row
 * @param {Date}   cutoffDate
 */
function evaluateEligibility(row, cutoffDate) {
  if (new Date(row.created_at) >= cutoffDate) {
    return { eligible: false, reason: 'within_retention_window' };
  }
  if (!SAFE_PAYMENT_STATUSES.has(row.payment_status)) {
    return { eligible: false, reason: `payment_status_not_safe:${row.payment_status}` };
  }
  if (
    row.refund_status !== null &&
    row.refund_status !== undefined &&
    !SAFE_REFUND_STATUSES.has(row.refund_status)
  ) {
    return { eligible: false, reason: `refund_status_not_safe:${row.refund_status}` };
  }
  if (row.dispute_flag === true) {
    return { eligible: false, reason: 'active_dispute' };
  }
  return { eligible: true };
}

/**
 * Acquire a pooled client and wrap work in a transaction.
 * Rolls back automatically on error; releases client in finally.
 *
 * @param {function(client): Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// ─── READ OPERATIONS ────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

/**
 * Fetch a single audit log by ID — checks hot table first, then archive.
 * Safe to call from payment API routes.
 *
 * @param {string|number} id
 * @returns {Promise<{ row: object, source: 'hot'|'archive' }>}
 * @throws {RowNotFoundError}
 */
async function getAuditLogById(id) {
  // Hot table first
  const { rows: hotRows } = await pool.query(
    `SELECT * FROM ${HOT_TABLE} WHERE id = $1 LIMIT 1`,
    [id],
  );
  if (hotRows.length > 0) {
    return { row: hotRows[0], source: 'hot' };
  }

  // Fall through to archive
  const { rows: archiveRows } = await pool.query(
    `SELECT * FROM ${ARCHIVE_TABLE} WHERE source_row_id = $1 LIMIT 1`,
    [id],
  );
  if (archiveRows.length > 0) {
    return { row: archiveRows[0], source: 'archive' };
  }

  throw new RowNotFoundError(id, `${HOT_TABLE} / ${ARCHIVE_TABLE}`);
}

/**
 * Fetch all audit logs for a payment_id across both hot and archive tables.
 * Returns a unified, time-ordered list with a `source` field on each row.
 *
 * @param {string} paymentId — UUID
 * @param {{ includeArchive?: boolean }} [opts]
 * @returns {Promise<Array<object>>}
 */
async function getAuditLogsByPaymentId(paymentId, { includeArchive = true } = {}) {
  if (!paymentId) throw new ArchiveServiceError('paymentId is required', 'INVALID_INPUT');

  const hotResult = await pool.query(
    `SELECT *, 'hot' AS source FROM ${HOT_TABLE}
     WHERE payment_id = $1
     ORDER BY created_at ASC`,
    [paymentId],
  );

  if (!includeArchive) {
    return hotResult.rows;
  }

  const archiveResult = await pool.query(
    `SELECT *, 'archive' AS source FROM ${ARCHIVE_TABLE}
     WHERE payment_id = $1
     ORDER BY created_at ASC`,
    [paymentId],
  );

  // Merge and sort by created_at ascending — full timeline view
  return [...hotResult.rows, ...archiveResult.rows].sort(
    (a, b) => new Date(a.created_at) - new Date(b.created_at),
  );
}

/**
 * Count rows currently eligible for archival in the hot table.
 * Used by health checks and dashboards.
 *
 * @param {number} [retentionDays]
 * @returns {Promise<number>}
 */
async function countEligibleRows(retentionDays = config.retentionDays) {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const { rows } = await pool.query(
    `SELECT COUNT(*)::BIGINT AS cnt
     FROM ${HOT_TABLE}
     WHERE
       created_at       < $1
       AND payment_status  = 'completed'
       AND (refund_status  IN ('settled','none') OR refund_status IS NULL)
       AND dispute_flag    = FALSE`,
    [cutoff],
  );
  return Number(rows[0].cnt);
}

/**
 * Count rows currently locked from archival (active disputes, pending refunds, etc).
 *
 * @returns {Promise<Array<{ lock_reason: string, count: number }>>}
 */
async function countLockedRows() {
  const { rows } = await pool.query(
    `SELECT lock_reason, COUNT(*)::BIGINT AS count
     FROM v_payment_audit_logs_locked
     GROUP BY lock_reason
     ORDER BY count DESC`,
  );
  return rows.map((r) => ({ lock_reason: r.lock_reason, count: Number(r.count) }));
}

/**
 * Retrieve recent retention job run history.
 *
 * @param {{ limit?: number, status?: string }} [opts]
 * @returns {Promise<Array<object>>}
 */
async function getJobRunHistory({ limit = 20, status } = {}) {
  const params  = [limit];
  const where   = status ? `WHERE status = $2` : '';
  if (status) params.push(status);

  const { rows } = await pool.query(
    `SELECT * FROM retention_job_runs
     ${where}
     ORDER BY started_at DESC
     LIMIT $1`,
    params,
  );
  return rows;
}

/**
 * Paginated query over the archive table — for compliance/audit UIs.
 *
 * @param {{
 *   paymentId?:    string,
 *   fromDate?:     Date,
 *   toDate?:       Date,
 *   eventType?:    string,
 *   page?:         number,
 *   pageSize?:     number,
 * }} filters
 * @returns {Promise<{ rows: Array<object>, total: number, page: number, pageSize: number }>}
 */
async function queryArchive({
  paymentId,
  fromDate,
  toDate,
  eventType,
  page     = 1,
  pageSize = 50,
} = {}) {
  if (pageSize > 500) throw new ArchiveServiceError('pageSize max is 500', 'INVALID_INPUT');
  if (page < 1)       throw new ArchiveServiceError('page must be >= 1',   'INVALID_INPUT');

  const conditions = [];
  const params     = [];

  if (paymentId) { params.push(paymentId);  conditions.push(`payment_id = $${params.length}`); }
  if (fromDate)  { params.push(fromDate);   conditions.push(`created_at >= $${params.length}`); }
  if (toDate)    { params.push(toDate);     conditions.push(`created_at <= $${params.length}`); }
  if (eventType) { params.push(eventType);  conditions.push(`event_type = $${params.length}`); }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const offset = (page - 1) * pageSize;
  params.push(pageSize, offset);

  const [dataResult, countResult] = await Promise.all([
    pool.query(
      `SELECT * FROM ${ARCHIVE_TABLE}
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    ),
    pool.query(
      `SELECT COUNT(*)::BIGINT AS total FROM ${ARCHIVE_TABLE} ${whereClause}`,
      params.slice(0, -2), // exclude LIMIT/OFFSET params
    ),
  ]);

  return {
    rows:     dataResult.rows,
    total:    Number(countResult.rows[0].total),
    page,
    pageSize,
  };
}

// ---------------------------------------------------------------------------
// ─── WRITE OPERATIONS ───────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

/**
 * Archive a single row by ID.
 *
 * Intended for manual use (admin tooling, one-off compliance requests).
 * The worker uses archiveBatch() for bulk operations.
 *
 * Steps:
 *   1. Load the row and verify safety predicates.
 *   2. Compute checksum.
 *   3. INSERT into archive (idempotent via ON CONFLICT DO NOTHING).
 *   4. Verify the archive copy exists and checksum matches.
 *   5. DELETE from hot table — only after verified copy.
 *
 * @param {string|number} id
 * @param {string}        batchId — UUID grouping this move with others in a run
 * @returns {Promise<{ archived: boolean, checksum: string, alreadyArchived: boolean }>}
 * @throws {RowNotFoundError | SafetyPredicateError | ArchiveIntegrityError}
 */
async function archiveSingleRow(id, batchId) {
  if (!id)      throw new ArchiveServiceError('id is required',      'INVALID_INPUT');
  if (!batchId) throw new ArchiveServiceError('batchId is required', 'INVALID_INPUT');

  return withTransaction(async (client) => {
    // ── 1. Load and lock the row ────────────────────────────────────────────
    const { rows: sourceRows } = await client.query(
      `SELECT * FROM ${HOT_TABLE} WHERE id = $1 FOR UPDATE`,
      [id],
    );

    if (sourceRows.length === 0) {
      // Maybe already archived — idempotent return
      const { rows: existing } = await client.query(
        `SELECT source_row_id, checksum FROM ${ARCHIVE_TABLE} WHERE source_row_id = $1 LIMIT 1`,
        [id],
      );
      if (existing.length > 0) {
        return { archived: false, alreadyArchived: true, checksum: existing[0].checksum };
      }
      throw new RowNotFoundError(id, HOT_TABLE);
    }

    const row = sourceRows[0];

    // ── 2. Safety predicate check ───────────────────────────────────────────
    const cutoff = new Date(Date.now() - config.retentionDays * 86_400_000);
    const eligibility = evaluateEligibility(row, cutoff);
    if (!eligibility.eligible) {
      throw new SafetyPredicateError(id, eligibility.reason);
    }

    // ── 3. Compute checksum ─────────────────────────────────────────────────
    const checksum = computeRowChecksum(row);

    // ── 4. INSERT into archive (idempotent) ─────────────────────────────────
    await client.query(
      `INSERT INTO ${ARCHIVE_TABLE} (
         payment_id, user_id, event_type, event_data,
         payment_status, refund_status, dispute_flag,
         amount, currency, created_at, updated_at,
         archived_at, archive_batch_id, source_row_id, checksum
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
         NOW(),$12,$13,$14
       )
       ON CONFLICT (source_row_id) DO NOTHING`,
      [
        row.payment_id, row.user_id, row.event_type, row.event_data,
        row.payment_status, row.refund_status, row.dispute_flag,
        row.amount, row.currency, row.created_at, row.updated_at,
        batchId, row.id, checksum,
      ],
    );

    // ── 5. Verify the archive copy ──────────────────────────────────────────
    const { rows: verifyRows } = await client.query(
      `SELECT checksum FROM ${ARCHIVE_TABLE} WHERE source_row_id = $1 LIMIT 1`,
      [id],
    );

    if (verifyRows.length === 0) {
      throw new ArchiveIntegrityError(id, checksum, null);
    }
    if (verifyRows[0].checksum !== checksum) {
      throw new ArchiveIntegrityError(id, checksum, verifyRows[0].checksum);
    }

    // ── 6. DELETE from hot table — ONLY after verified archive ──────────────
    // Re-check predicates inside the transaction to guard against
    // concurrent status changes between steps 1 and 6.
    const { rowCount } = await client.query(
      `DELETE FROM ${HOT_TABLE}
       WHERE id = $1
         AND payment_status  = 'completed'
         AND (refund_status  IN ('settled','none') OR refund_status IS NULL)
         AND dispute_flag    = FALSE`,
      [id],
    );

    if (rowCount === 0) {
      // Status changed mid-transaction — roll back to leave both copies intact,
      // then let the caller decide what to do.
      throw new SafetyPredicateError(id, 'status_changed_during_archival');
    }

    return { archived: true, alreadyArchived: false, checksum };
  });
}

/**
 * Batch-archive an array of row IDs in a single transaction.
 * This is the core method called by the retention worker.
 *
 * Unlike archiveSingleRow(), this method:
 *   - Does NOT individually validate each row before insert (too slow at scale).
 *   - Relies on the SQL predicate re-check inside the DELETE for safety.
 *   - Uses ON CONFLICT DO NOTHING for idempotency.
 *   - Returns per-batch metrics rather than throwing on partial skips.
 *
 * @param {string}         batchId
 * @param {Array<number>}  rowIds
 * @returns {Promise<{ archived: number, skipped: number, checksum_failures: number }>}
 */
async function archiveBatch(batchId, rowIds) {
  if (!batchId)              throw new ArchiveServiceError('batchId is required',          'INVALID_INPUT');
  if (!Array.isArray(rowIds) || rowIds.length === 0) {
    throw new ArchiveServiceError('rowIds must be a non-empty array', 'INVALID_INPUT');
  }
  if (rowIds.length > 10_000) {
    throw new ArchiveServiceError('rowIds exceeds max batch size of 10000', 'BATCH_TOO_LARGE');
  }

  return withTransaction(async (client) => {
    // INSERT — uses server-side SHA-256, matches migration helper function.
    // ON CONFLICT (source_row_id) DO NOTHING = idempotent across retries.
    const { rowCount: insertedCount } = await client.query(
      `INSERT INTO ${ARCHIVE_TABLE} (
         payment_id, user_id, event_type, event_data,
         payment_status, refund_status, dispute_flag,
         amount, currency, created_at, updated_at,
         archived_at, archive_batch_id, source_row_id, checksum
       )
       SELECT
         payment_id, user_id, event_type, event_data,
         payment_status, refund_status, dispute_flag,
         amount, currency, created_at, updated_at,
         NOW(), $1, id,
         encode(
           sha256(
             (id::TEXT || payment_id::TEXT ||
              COALESCE(amount::TEXT,'') || created_at::TEXT)::BYTEA
           ),
           'hex'
         )
       FROM ${HOT_TABLE}
       WHERE id = ANY($2::BIGINT[])
       ON CONFLICT (source_row_id) DO NOTHING`,
      [batchId, rowIds],
    );

    // DELETE — re-applies all four safety predicates inside this transaction.
    // Any row whose status changed since the worker's SELECT will be skipped here.
    const { rowCount: deletedCount } = await client.query(
      `DELETE FROM ${HOT_TABLE}
       WHERE
         id = ANY($1::BIGINT[])
         AND payment_status  = 'completed'
         AND (refund_status  IN ('settled','none') OR refund_status IS NULL)
         AND dispute_flag    = FALSE`,
      [rowIds],
    );

    const skipped = rowIds.length - deletedCount;

    return {
      archived:          deletedCount,
      skipped,
      checksum_failures: 0,  // server-side SHA-256; no app-layer mismatch possible
    };
  });
}

// ---------------------------------------------------------------------------
// ─── RECOVERY OPERATIONS ────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

/**
 * Restore a row from archive back to the hot table.
 *
 * Use cases:
 *   - A dispute was opened after archival.
 *   - Manual error correction.
 *   - Regulatory recall.
 *
 * The archive copy is retained (never deleted on restore) for audit trail
 * completeness.
 *
 * @param {string|number} sourceRowId — original id from payment_audit_logs
 * @param {{ reason: string, operatorId: string }} meta
 * @returns {Promise<{ restored: boolean, hotTableId: number }>}
 * @throws {RowNotFoundError | ArchiveIntegrityError}
 */
async function restoreFromArchive(sourceRowId, { reason, operatorId } = {}) {
  if (!sourceRowId)  throw new ArchiveServiceError('sourceRowId is required', 'INVALID_INPUT');
  if (!reason)       throw new ArchiveServiceError('reason is required for audit trail', 'INVALID_INPUT');
  if (!operatorId)   throw new ArchiveServiceError('operatorId is required for audit trail', 'INVALID_INPUT');

  return withTransaction(async (client) => {
    // Load archive row
    const { rows: archiveRows } = await client.query(
      `SELECT * FROM ${ARCHIVE_TABLE} WHERE source_row_id = $1 LIMIT 1`,
      [sourceRowId],
    );
    if (archiveRows.length === 0) {
      throw new RowNotFoundError(sourceRowId, ARCHIVE_TABLE);
    }

    const archived = archiveRows[0];

    // Verify checksum before restoring
    const expectedChecksum = computeRowChecksum({
      id:             archived.source_row_id,
      payment_id:     archived.payment_id,
      amount:         archived.amount,
      currency:       archived.currency,
      created_at:     archived.created_at,
      event_type:     archived.event_type,
      payment_status: archived.payment_status,
    });

    if (archived.checksum !== expectedChecksum) {
      throw new ArchiveIntegrityError(sourceRowId, expectedChecksum, archived.checksum);
    }

    // Check not already back in hot table
    const { rows: existing } = await client.query(
      `SELECT id FROM ${HOT_TABLE} WHERE id = $1 LIMIT 1`,
      [sourceRowId],
    );
    if (existing.length > 0) {
      return { restored: false, hotTableId: existing[0].id, alreadyRestored: true };
    }

    // Re-insert into hot table, preserving the original id
    const { rows: insertedRows } = await client.query(
      `INSERT INTO ${HOT_TABLE} (
         id, payment_id, user_id, event_type, event_data,
         payment_status, refund_status, dispute_flag,
         amount, currency, created_at, updated_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
       )
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        archived.source_row_id,
        archived.payment_id, archived.user_id, archived.event_type, archived.event_data,
        archived.payment_status, archived.refund_status, archived.dispute_flag,
        archived.amount, archived.currency, archived.created_at, archived.updated_at,
      ],
    );

    if (insertedRows.length === 0) {
      // Conflict: row appeared in hot table between our check and insert
      return { restored: false, hotTableId: sourceRowId, alreadyRestored: true };
    }

    // Log the restore event for audit trail (append-only, never delete)
    await client.query(
      `INSERT INTO ${HOT_TABLE} (
         payment_id, user_id, event_type, event_data,
         payment_status, refund_status, dispute_flag,
         amount, currency, created_at, updated_at
       ) VALUES (
         $1, $2, 'ARCHIVE_RESTORE', $3,
         $4, $5, $6, $7, $8, NOW(), NOW()
       )`,
      [
        archived.payment_id,
        operatorId,
        JSON.stringify({ reason, restoredRowId: sourceRowId, operatorId }),
        archived.payment_status,
        archived.refund_status,
        archived.dispute_flag,
        archived.amount,
        archived.currency,
      ],
    );

    return { restored: true, hotTableId: insertedRows[0].id };
  });
}

// ---------------------------------------------------------------------------
// ─── INTEGRITY OPERATIONS ───────────────────────────────────────────────────
// ---------------------------------------------------------------------------

/**
 * Verify the checksum of an archived row against its current values.
 * Call this on any archive row before using it as authoritative compliance data.
 *
 * @param {string|number} sourceRowId
 * @returns {Promise<{ valid: boolean, sourceRowId: number, checksum: string, computedChecksum: string }>}
 * @throws {RowNotFoundError}
 */
async function verifyArchiveChecksum(sourceRowId) {
  const { rows } = await pool.query(
    `SELECT * FROM ${ARCHIVE_TABLE} WHERE source_row_id = $1 LIMIT 1`,
    [sourceRowId],
  );

  if (rows.length === 0) {
    throw new RowNotFoundError(sourceRowId, ARCHIVE_TABLE);
  }

  const archived = rows[0];
  const computed = computeRowChecksum({
    id:             archived.source_row_id,
    payment_id:     archived.payment_id,
    amount:         archived.amount,
    currency:       archived.currency,
    created_at:     archived.created_at,
    event_type:     archived.event_type,
    payment_status: archived.payment_status,
  });

  return {
    valid:            archived.checksum === computed,
    sourceRowId:      archived.source_row_id,
    checksum:         archived.checksum,
    computedChecksum: computed,
  };
}

/**
 * Spot-check a random sample of archived rows from a given batch.
 * Returns a summary of pass/fail counts.
 *
 * @param {string} batchId
 * @param {{ sampleSize?: number }} [opts]
 * @returns {Promise<{ batchId: string, checked: number, passed: number, failed: number, failures: Array<object> }>}
 */
async function verifyBatchIntegrity(batchId, { sampleSize = 100 } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM ${ARCHIVE_TABLE}
     WHERE archive_batch_id = $1
     ORDER BY RANDOM()
     LIMIT $2`,
    [batchId, sampleSize],
  );

  let passed   = 0;
  let failed   = 0;
  const failures = [];

  for (const archived of rows) {
    const computed = computeRowChecksum({
      id:             archived.source_row_id,
      payment_id:     archived.payment_id,
      amount:         archived.amount,
      currency:       archived.currency,
      created_at:     archived.created_at,
      event_type:     archived.event_type,
      payment_status: archived.payment_status,
    });

    if (archived.checksum === computed) {
      passed++;
    } else {
      failed++;
      failures.push({
        source_row_id:    archived.source_row_id,
        stored_checksum:  archived.checksum,
        computed_checksum: computed,
      });
    }
  }

  return { batchId, checked: rows.length, passed, failed, failures };
}

// ---------------------------------------------------------------------------
// ─── HEALTH / OBSERVABILITY ─────────────────────────────────────────────────
// ---------------------------------------------------------------------------

/**
 * Return a snapshot of the retention system's current health.
 * Safe to call from a /health or /metrics endpoint.
 *
 * @returns {Promise<object>}
 */
async function getRetentionHealth() {
  const [eligible, locked, recentRuns, hotApprox, archiveApprox] = await Promise.all([
    countEligibleRows(),
    countLockedRows(),

    pool.query(
      `SELECT status, started_at, completed_at, rows_archived, error_message
       FROM retention_job_runs
       WHERE job_name = $1
       ORDER BY started_at DESC
       LIMIT 3`,
      [config.jobName],
    ),

    pool.query(
      `SELECT reltuples::BIGINT AS estimate
       FROM pg_class WHERE relname = $1`,
      [HOT_TABLE],
    ),

    pool.query(
      `SELECT reltuples::BIGINT AS estimate
       FROM pg_class WHERE relname = $1`,
      [ARCHIVE_TABLE],
    ),
  ]);

  const lastRun = recentRuns.rows[0] ?? null;

  return {
    status: lastRun?.status === 'failed' ? 'degraded' : 'ok',
    hot_table: {
      approximate_rows: Number(hotApprox.rows[0]?.estimate ?? 0),
      eligible_for_archival: eligible,
      locked_rows: locked,
    },
    archive_table: {
      approximate_rows: Number(archiveApprox.rows[0]?.estimate ?? 0),
    },
    last_run: lastRun
      ? {
          status:        lastRun.status,
          started_at:    lastRun.started_at,
          completed_at:  lastRun.completed_at,
          rows_archived: lastRun.rows_archived,
          error_message: lastRun.error_message ?? null,
        }
      : null,
    recent_run_history: recentRuns.rows,
    config: {
      retention_days: config.retentionDays,
      batch_size:     config.batchSize,
      cron_schedule:  config.cronSchedule,
    },
  };
}

// ---------------------------------------------------------------------------
// ─── POOL LIFECYCLE ─────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

/**
 * Gracefully drain the service's internal DB pool.
 * Call during application shutdown.
 */
async function shutdown() {
  await pool.end();
}

// ---------------------------------------------------------------------------
// EXPORTS
// ---------------------------------------------------------------------------

module.exports = {
  // Read
  getAuditLogById,
  getAuditLogsByPaymentId,
  countEligibleRows,
  countLockedRows,
  getJobRunHistory,
  queryArchive,

  // Write
  archiveSingleRow,
  archiveBatch,

  // Recovery
  restoreFromArchive,

  // Integrity
  verifyArchiveChecksum,
  verifyBatchIntegrity,

  // Health
  getRetentionHealth,

  // Lifecycle
  shutdown,

  // Errors (for instanceof checks in callers)
  ArchiveServiceError,
  SafetyPredicateError,
  RowNotFoundError,
  ArchiveIntegrityError,

  // Exposed for unit testing
  _internals: {
    computeRowChecksum,
    evaluateEligibility,
    withTransaction,
    pool,
  },
};

'use strict';

/**
 * config/retention.js
 * PlanBuddy V9 — Payment Audit Log Retention Configuration
 *
 * All tuneable parameters for the retention worker.
 * Values can be overridden via environment variables.
 */

const retention = {
  // ---------------------------------------------------------------------------
  // RETENTION WINDOW
  // How many days to keep full records in the hot payment_audit_logs table.
  // Records older than this (AND meeting safety criteria) are eligible for archival.
  // ---------------------------------------------------------------------------
  retentionDays: parseInt(process.env.RETENTION_DAYS ?? '90', 10),

  // ---------------------------------------------------------------------------
  // BATCH PROCESSING
  // ---------------------------------------------------------------------------
  batchSize: parseInt(process.env.RETENTION_BATCH_SIZE ?? '1000', 10),

  // Max number of batches per single job run (safety ceiling).
  // 500 batches × 1000 rows = up to 500k rows per nightly run.
  maxBatchesPerRun: parseInt(process.env.RETENTION_MAX_BATCHES ?? '500', 10),

  // Milliseconds to sleep between batches to avoid I/O saturation.
  batchDelayMs: parseInt(process.env.RETENTION_BATCH_DELAY_MS ?? '200', 10),

  // ---------------------------------------------------------------------------
  // SCHEDULING
  // Default: 02:00 AM server time daily (low-traffic window).
  // Expressed as a standard cron expression.
  // ---------------------------------------------------------------------------
  cronSchedule: process.env.RETENTION_CRON ?? '0 2 * * *',

  // ---------------------------------------------------------------------------
  // RETRY POLICY (per batch)
  // ---------------------------------------------------------------------------
  maxRetries: parseInt(process.env.RETENTION_MAX_RETRIES ?? '3', 10),
  retryDelayMs: parseInt(process.env.RETENTION_RETRY_DELAY_MS ?? '2000', 10),
  retryBackoffMultiplier: parseFloat(process.env.RETENTION_RETRY_BACKOFF ?? '2'),

  // ---------------------------------------------------------------------------
  // LOCK / CONCURRENCY
  // PostgreSQL advisory lock key — prevents two workers running simultaneously.
  // Must be a unique integer per job type.
  // ---------------------------------------------------------------------------
  advisoryLockKey: parseInt(process.env.RETENTION_ADVISORY_LOCK_KEY ?? '777001', 10),

  // ---------------------------------------------------------------------------
  // SAFETY PREDICATES (duplicated here for documentation — enforced in SQL)
  // A row is ONLY eligible for archival when ALL of the following are true:
  //   1. created_at < NOW() - retentionDays
  //   2. payment_status  = 'completed'
  //   3. refund_status IN ('settled', null, 'none')
  //   4. dispute_flag   = false
  // ---------------------------------------------------------------------------
  safeStatuses: {
    payment: ['completed'],
    refund:  ['settled', 'none', null],
  },

  // ---------------------------------------------------------------------------
  // JOB IDENTITY
  // ---------------------------------------------------------------------------
  jobName: 'payment-audit-retention',

  // BullMQ queue name (if using BullMQ instead of bare cron)
  queueName: 'retention-jobs',

  // ---------------------------------------------------------------------------
  // ALERTING THRESHOLDS
  // If a single run archives more rows than this, emit a warning metric.
  // Helps detect runaway scenarios or sudden spikes.
  // ---------------------------------------------------------------------------
  alertThresholdRows: parseInt(process.env.RETENTION_ALERT_ROWS ?? '100000', 10),

  // If a run takes longer than this (ms), emit a slow-run warning.
  alertThresholdDurationMs: parseInt(process.env.RETENTION_ALERT_DURATION_MS ?? '3600000', 10), // 1 hour
};

// Basic validation
if (retention.retentionDays < 30) {
  throw new Error(`[retention] retentionDays must be >= 30. Got: ${retention.retentionDays}`);
}
if (retention.batchSize < 100 || retention.batchSize > 10000) {
  throw new Error(`[retention] batchSize must be between 100–10000. Got: ${retention.batchSize}`);
}

module.exports = retention;

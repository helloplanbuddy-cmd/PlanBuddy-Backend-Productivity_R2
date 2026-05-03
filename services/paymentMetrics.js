'use strict';

/**
 * monitoring/paymentMetrics.js
 * PlanBuddy V9 — Payment Audit Retention Metrics
 *
 * Defines and exports all Prometheus metrics used by the retention worker.
 * Import this module once at startup so metrics are pre-registered and
 * appear in /metrics even before the first job run.
 */

const {
  getOrCreateCounter,
  getOrCreateGauge,
  getOrCreateHistogram,
} = require('../services/metricsService');

// ---------------------------------------------------------------------------
// COUNTERS  (monotonically increasing across process lifetime)
// ---------------------------------------------------------------------------

/** Total rows successfully moved to the archive table. */
const rowsArchivedTotal = getOrCreateCounter({
  name: 'retention_rows_archived_total',
  help: 'Total payment_audit_logs rows moved to the archive table.',
  labelNames: ['job_name'],
});

/** Total rows skipped because they were still active / in dispute. */
const rowsSkippedTotal = getOrCreateCounter({
  name: 'retention_rows_skipped_total',
  help: 'Rows excluded from archival due to safety predicates (active dispute, pending refund, etc.).',
  labelNames: ['job_name', 'skip_reason'],
});

/** Total rows scanned (regardless of outcome). */
const rowsScannedTotal = getOrCreateCounter({
  name: 'retention_rows_scanned_total',
  help: 'Total payment_audit_logs rows examined by the retention worker.',
  labelNames: ['job_name'],
});

/** Number of batch-level retries attempted. */
const batchRetriesTotal = getOrCreateCounter({
  name: 'retention_batch_retries_total',
  help: 'Number of times a batch was retried after a transient failure.',
  labelNames: ['job_name'],
});

/** Number of batches that failed permanently (dead-lettered). */
const batchFailuresTotal = getOrCreateCounter({
  name: 'retention_batch_failures_total',
  help: 'Batches that exhausted retries and were dead-lettered.',
  labelNames: ['job_name'],
});

/** Number of complete job runs that ended in an error state. */
const jobFailuresTotal = getOrCreateCounter({
  name: 'retention_job_failures_total',
  help: 'Retention job runs that completed with a failure or partial status.',
  labelNames: ['job_name', 'failure_type'],
});

/** Number of successful complete job runs. */
const jobSuccessTotal = getOrCreateCounter({
  name: 'retention_job_success_total',
  help: 'Retention job runs that completed successfully.',
  labelNames: ['job_name'],
});

// ---------------------------------------------------------------------------
// HISTOGRAMS  (latency distributions)
// ---------------------------------------------------------------------------

/**
 * End-to-end duration of a full retention job run (milliseconds).
 * Buckets cover 1s → 1h for nightly batch jobs.
 */
const retentionJobDurationMs = getOrCreateHistogram({
  name: 'retention_job_duration_ms',
  help: 'End-to-end duration of a retention job run in milliseconds.',
  labelNames: ['job_name', 'status'],
  buckets: [1000, 5000, 15000, 30000, 60000, 120000, 300000, 600000, 1800000, 3600000],
});

/** Duration of a single batch INSERT+DELETE transaction (milliseconds). */
const batchDurationMs = getOrCreateHistogram({
  name: 'retention_batch_duration_ms',
  help: 'Duration of a single archive batch transaction in milliseconds.',
  labelNames: ['job_name'],
  buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10000],
});

// ---------------------------------------------------------------------------
// GAUGES  (current state)
// ---------------------------------------------------------------------------

/** 1 while a job is actively running; 0 otherwise.  Alerts on stale 1. */
const jobRunning = getOrCreateGauge({
  name: 'retention_job_running',
  help: '1 while a retention job run is in progress, 0 otherwise.',
  labelNames: ['job_name'],
});

/** Unix timestamp (seconds) of the last successful job completion. */
const lastSuccessTimestamp = getOrCreateGauge({
  name: 'retention_last_success_timestamp_seconds',
  help: 'Unix epoch seconds of the last successful retention run.',
  labelNames: ['job_name'],
});

/** How many rows are currently in the archive table. */
const archiveTableSize = getOrCreateGauge({
  name: 'retention_archive_table_rows',
  help: 'Approximate row count of payment_audit_logs_archive.',
  labelNames: [],
});

/** How many rows in the hot table are currently locked from archival. */
const lockedRowsCount = getOrCreateGauge({
  name: 'retention_locked_rows',
  help: 'Number of rows in payment_audit_logs currently ineligible for archival.',
  labelNames: ['lock_reason'],
});

// ---------------------------------------------------------------------------
// CONVENIENCE WRAPPER
// ---------------------------------------------------------------------------

const metrics = {
  rowsArchivedTotal,
  rowsSkippedTotal,
  rowsScannedTotal,
  batchRetriesTotal,
  batchFailuresTotal,
  jobFailuresTotal,
  jobSuccessTotal,
  retentionJobDurationMs,
  batchDurationMs,
  jobRunning,
  lastSuccessTimestamp,
  archiveTableSize,
  lockedRowsCount,
};

module.exports = metrics;

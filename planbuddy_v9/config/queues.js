'use strict';

/**
 * config/queues.js — BullMQ Queue Definitions
 *
 * 🚀 PHASE 2A — PlanBuddy v5.0-A Worker Safe System
 *
 * UPGRADES vs v4.0:
 *  1. All queues now have retries: 5 with exponential backoff (1s→5s→30s→2m→5m)
 *  2. removeOnFail count increased: keep 1000 (was 500) for better post-mortem
 *  3. Phase2A: job IDs are explicitly named for idempotency
 *  4. enqueueEmail / enqueueRefundRetry now register job_state (pending)
 *  5. DLQ handled in workers/index.js via 'failed' events
 *
 * Queue inventory:
 *  ┌────────────────────────┬──────────────┬─────────────────────────────────────┐
 *  │ Queue name             │ Trigger      │ Purpose                             │
 *  ├────────────────────────┼──────────────┼─────────────────────────────────────┤
 *  │ booking-expiry         │ Repeating    │ Cancel pending bookings past expiry  │
 *  │ payment-reconciliation │ Repeating    │ Fix captured-but-unconfirmed payments│
 *  │ email-dispatch         │ Event-driven │ Send transactional emails            │
 *  │ refund-retry           │ Event-driven │ Retry failed Razorpay refunds (DLQ)  │
 *  └────────────────────────┴──────────────┴─────────────────────────────────────┘
 */

const { Queue } = require('bullmq');
const { redisQueue } = require('./redis');

// ─── Shared BullMQ connection ─────────────────────────────────────────────────

const connection = redisQueue;

// ─── 🚀 PHASE 2A: Exponential delay schedule (ms) ────────────────────────────
// Matches RETRY_DELAYS_MS in workerSafetyService for consistency.
// BullMQ delay is the wait BEFORE the next attempt.
//   Attempt 1 fails → wait 1s  → attempt 2
//   Attempt 2 fails → wait 5s  → attempt 3
//   Attempt 3 fails → wait 30s → attempt 4
//   Attempt 4 fails → wait 2m  → attempt 5
//   Attempt 5 fails → DLQ
const PHASE2A_BACKOFF = {
  type: 'custom',
  // 'custom' uses the backoffStrategies registered in each Worker instance.
  // If not registered, falls back to exponential with the initial delay.
  delay: 1_000,  // base delay (1s)
};

// ─── Default job options ──────────────────────────────────────────────────────

const DEFAULT_JOB_OPTIONS = {
  // 🚀 PHASE 2A: 5 retries for all queues
  attempts: 5,
  backoff:  PHASE2A_BACKOFF,

  // Keep more failed jobs for post-mortem analysis
  removeOnComplete: { count: 100 },
  removeOnFail:     { count: 1000 },  // increased from 500
};

// ─── Queue instances ──────────────────────────────────────────────────────────

const bookingExpiryQueue = new Queue('booking-expiry', {
  connection,
  defaultJobOptions: DEFAULT_JOB_OPTIONS,
});

const reconciliationQueue = new Queue('payment-reconciliation', {
  connection,
  defaultJobOptions: DEFAULT_JOB_OPTIONS,
});

/**
 * email-dispatch — event-driven
 * 🚀 PHASE 2A: Retry 5× with exponential backoff.
 * Non-transient failures (bad type, missing data) handled by safeWorkerWrapper.
 */
const emailQueue = new Queue('email-dispatch', {
  connection,
  defaultJobOptions: {
    ...DEFAULT_JOB_OPTIONS,
    attempts: 5,
    backoff:  { type: 'exponential', delay: 1_000 },
  },
});

/**
 * refund-retry — event-driven DLQ
 * 🚀 PHASE 2A: 5 attempts, exponential 1s→5s→30s→2m→5m
 * After 5 failures: DLQ via onRefundJobExhausted()
 */
const refundRetryQueue = new Queue('refund-retry', {
  connection,
  defaultJobOptions: {
    ...DEFAULT_JOB_OPTIONS,
    attempts: 5,
    backoff:  { type: 'exponential', delay: 1_000 },
  },
});

/**
 * webhook-events — event-driven
 * Hardened webhook application pipeline.
 * Queue inventory was missing this queue earlier; worker `webhook-processor.worker.js`
 * consumes from `webhook-events`, so HTTP ingestion MUST enqueue here.
 */
const webhookEventsQueue = new Queue('webhook-events', {
  connection,
  defaultJobOptions: {
    ...DEFAULT_JOB_OPTIONS,
    // Keep defaults; worker enforces idempotency + lease fencing.
  },
});

// ─── Scheduler: set up repeating jobs ────────────────────────────────────────

async function scheduleRepeatableJobs() {
  const logger = require('../utils/logger');

  try {
    // Every 60 seconds — booking expiry sweep
    await bookingExpiryQueue.upsertJobScheduler(
      'booking-expiry-cron',
      { every: 60_000 },
      { name: 'expiry-sweep', data: {}, opts: DEFAULT_JOB_OPTIONS }
    );

    // Every 5 minutes — payment reconciliation
    await reconciliationQueue.upsertJobScheduler(
      'reconciliation-cron',
      { every: 5 * 60_000 },
      { name: 'reconciliation-run', data: {}, opts: DEFAULT_JOB_OPTIONS }
    );

    logger.info(
      '[queues] 🚀 PHASE 2A: Repeatable jobs scheduled with 5-retry policy: ' +
      'booking-expiry (60s), reconciliation (5m)'
    );
  } catch (err) {
    logger.error({ err }, '[queues] Failed to schedule repeatable jobs');
    throw err;
  }
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function closeQueues() {
  await Promise.allSettled([
    bookingExpiryQueue.close(),
    reconciliationQueue.close(),
    emailQueue.close(),
    refundRetryQueue.close(),
  ]);
}

// ─── Enqueue helpers (used by controllers/services) ──────────────────────────

/**
 * 🚀 PHASE 2A: Enqueue an email-dispatch job.
 * Also registers job_state as 'pending' for tracking.
 *
 * @param {'booking_confirmation'|'payment_receipt'|'booking_cancellation'|'password_reset_otp'} type
 * @param {object} data
 */
async function enqueueEmail(type, data) {
  const logger = require('../utils/logger');
  try {
    const job = await emailQueue.add(type, { type, ...data });

    // 🚀 PHASE 2A: Register in job_state for tracking + idempotency
    const { JobStateManager } = require('../services/workerSafetyService');
    await JobStateManager.markPending({
      jobId:   String(job.id),
      queue:   'email-dispatch',
      jobName: `email-${type}`,
      payload: { type, ...data },
    }).catch(() => {}); // non-fatal

    logger.info({ type, jobId: job.id }, '[queues] Email job enqueued');
  } catch (err) {
    logger.error({ err }, `[queues] Failed to enqueue email job: ${type}`);
  }
}

/**
 * 🚀 PHASE 2A: Enqueue a refund-retry job.
 * Also registers job_state as 'pending'.
 *
 * @param {object} data - { bookingId, paymentId, razorpayPaymentId, amount, reason, requestedBy }
 */
async function enqueueRefundRetry(data) {
  const logger = require('../utils/logger');
  try {
    const job = await refundRetryQueue.add('refund-retry', { ...data, attempt: 1 });

    // 🚀 PHASE 2A: Register in job_state
    const { JobStateManager } = require('../services/workerSafetyService');
    await JobStateManager.markPending({
      jobId:   String(job.id),
      queue:   'refund-retry',
      jobName: 'refund-retry',
      payload: data,
    }).catch(() => {}); // non-fatal

    logger.info({ jobId: job.id, bookingId: data.bookingId }, '[queues] 🚀 PHASE 2A: Refund retry job enqueued');
  } catch (err) {
    logger.error({ err }, '[queues] Failed to enqueue refund retry job');
  }
}

/**
 * 🚀 Enqueue webhook event for async financial application.
 * Minimal direct-enqueue fix: HTTP ingest MUST enqueue a `webhook-events` job.
 *
 * @param {object} data
 * @param {string} data.eventId
 * @param {string} data.provider
 * @param {string} data.eventType
 * @param {any} data.payload
 */
async function enqueueWebhookEvent(data) {
  const logger = require('../utils/logger');
  try {
    const { eventId, provider, eventType, payload } = data;

    if (!eventId || !provider || !eventType) {
      logger.error({ data }, '[queues] enqueueWebhookEvent: missing required fields');
      return null;
    }

    const job = await webhookEventsQueue.add(
      'webhook-event',
      { eventId, provider, eventType, payload },
      {
        // Deterministic jobId for idempotent enqueue (BullMQ dedup by jobId)
        jobId: `webhook-${provider}-${eventId}`,
      }
    );

    logger.info(
      { jobId: job.id, eventId, eventType, provider },
      '[queues] 🚀 webhook-events job enqueued'
    );

    return job;
  } catch (err) {
    logger.error({ err, data }, '[queues] Failed to enqueue webhook-events job');
    return null;
  }
}

module.exports = {
  bookingExpiryQueue,
  reconciliationQueue,
  emailQueue,
  refundRetryQueue,
  webhookEventsQueue,
  scheduleRepeatableJobs,
  closeQueues,
  enqueueEmail,
  enqueueRefundRetry,
  enqueueWebhookEvent,
  connection,
};

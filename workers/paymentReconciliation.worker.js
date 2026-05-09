'use strict';

/**
 * workers/paymentReconciliation.worker.js — Payment Recovery Engine
 *
 * PHASE 4: Guaranteed Payment Recovery (ZERO MONEY LOSS)
 *
 * Problem:
 *  - Webhook lost in transit
 *  - DB commit fails after Razorpay capture
 *  - Race conditions at high load
 *
 * Solution:
 *  - Run every 2 minutes
 *  - Find orphaned payments (created > 2 min ago, no confirmation)
 *  - Call Razorpay API directly to verify status
 *  - Auto-recover: force-confirm if captured, mark failed if not
 *  - Idempotent: safe to run 100 times for same payment
 */

const db = require('../config/db');
const RazorpayService = require('../services/razorpayService');
const logger = require('../utils/logger');
const monitoring = require('../utils/monitoring');
const {
  safeWorkerWrapper,
  JobStateManager,
  isTransientError,
} = require('../services/workerSafetyService');

const WORKER_ID = `payment-recovery-${process.pid}`;
const QUEUE_NAME = 'payment-recovery';
const JOB_NAME = 'payment-recovery';
const RUN_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const LOCK_KEY = 'payment-reconciliation-lock';
const LOCK_TTL_S = 5 * 60; // 5 minutes

/**
 * Find orphaned payments.
 * Payments that are 'created' or 'pending' for > 2 minutes without confirmation.
 */
async function findOrphanedPayments() {
  const result = await db.query(
    `SELECT 
      p.id AS payment_id,
      p.razorpay_payment_id,
      p.razorpay_order_id,
      p.booking_id,
      p.status AS payment_status,
      p.amount,
      b.status AS booking_status,
      b.payment_status AS booking_payment_status,
      p.created_at
    FROM payments p
    LEFT JOIN bookings b ON p.booking_id = b.id
    WHERE p.status IN ('created', 'pending')
      AND p.created_at < NOW() - INTERVAL '2 minutes'
    ORDER BY p.created_at ASC
    LIMIT 100`
  );

  return result.rows;
}

/**
 * Recover a single payment by calling Razorpay API.
 * Returns: { recovered: boolean, action: string, details: object }
 */
async function recoverPayment(payment) {
  const { payment_id, razorpay_payment_id, booking_id } = payment;
  const idempotencyKey = `rec-${payment.payment_id}-${Date.now()}`;

  const ExecutionSafety = require('../services/executionSafety');
  const DbService = require('../services/dbService');

  try {
    // Use unified safety layer
    const result = await ExecutionSafety.executeWithIdempotency(idempotencyKey, async (client) => {
      const razorpayPayment = await RazorpayService.verifyPaymentWithAPI(razorpay_payment_id);
      
      if (!razorpayPayment) return { recovered: false, action: 'razorpay_not_found' };

      const razorpayStatus = razorpayPayment.status;

      // Delegate to service layer for DB mutations
      if (razorpayStatus === 'captured') {
        return await DbService.reconcilePaymentCaptured(client, payment_id, booking_id);
      } 
      if (razorpayStatus === 'failed') {
        return await DbService.reconcilePaymentFailed(client, payment_id, booking_id);
      }
      if (razorpayStatus === 'refunded') {
        return await DbService.reconcilePaymentRefunded(client, payment_id, booking_id);
      }

      return { recovered: false, action: 'unknown_status', razorpayStatus };
    });

    logger.info('Worker payment recovery', { payment_id, result });
    return result;
  } catch (err) {
    logger.error('Worker recovery failed', { payment_id, error: err.message });
    return { recovered: false, action: 'error', details: { payment_id, error: err.message } };
  }
}

/**
 * Main reconciliation cycle.
 */
async function runReconciliation() {
  const correlationId = `pay-rec-${Date.now()}`;
  logger.info('Payment reconciliation started', { correlationId });

  // Acquire distributed lock
  const { redis } = require('../config/redis');
  if (!redis) {
    logger.warn('Redis unavailable — skipping reconciliation to prevent conflicts');
    return { skipped: true, reason: 'redis_unavailable' };
  }

  const lockAcquired = await redis.set(LOCK_KEY, WORKER_ID, 'EX', LOCK_TTL_S, 'NX');
  if (!lockAcquired) {
    logger.info('Payment reconciliation skipped — lock held by another instance', { correlationId });
    return { skipped: true, reason: 'lock_held' };
  }

  logger.info('Payment reconciliation lock acquired', { correlationId, workerId: WORKER_ID });

  let processed = 0;
  let recovered = 0;
  let failed = 0;

  try {
    const orphanedPayments = await findOrphanedPayments();
    monitoring.payment_reconciliation_total.inc(orphanedPayments.length);

    logger.info('Payment reconciliation: found orphans', {
      correlationId,
      count: orphanedPayments.length,
    });

    for (const payment of orphanedPayments) {
      // Idempotent: check if already processed recently
      const recentLog = await db.query(
        `SELECT 1 FROM payment_reconciliation_logs
         WHERE payment_id = $1
           AND created_at > NOW() - INTERVAL '5 minutes'
           AND action_taken = 'confirmed'`,
        [payment.payment_id]
      );

      if (recentLog.rows.length > 0) {
        logger.debug('Payment already recovered recently', { payment_id: payment.payment_id });
        continue;
      }

      const result = await recoverPayment(payment);
      processed++;

      if (result.recovered) {
        recovered++;
        monitoring.payment_recovery_success_total.inc();
      } else {
        failed++;
      }
    }

    const stats = { processed, recovered, failed, total: orphanedPayments.length };
    logger.info('Payment reconciliation complete', { correlationId, stats });

    return stats;
  } catch (err) {
    logger.error('Payment reconciliation failed', {
      correlationId,
      error: err.message,
      stack: err.stack,
    });

    return { processed, recovered, failed, error: err.message };
  } finally {
    // Release lock
    try {
      await redis.del(LOCK_KEY);
      logger.info('Payment reconciliation lock released', { correlationId });
    } catch (err) {
      logger.error('Failed to release lock', { correlationId, error: err.message });
    }
  }
}

/**
 * Run the job with safety wrapper.
 */
async function runJob(jobId) {
  const id = jobId || `pay-rec-${Date.now()}`;

  await JobStateManager.markPending({
    jobId: id,
    queue: QUEUE_NAME,
    jobName: JOB_NAME,
    payload: {},
    correlationId: id,
  });

  try {
    const result = await safeWorkerWrapper({
      jobId: id,
      queue: QUEUE_NAME,
      jobName: JOB_NAME,
      payload: {},
      workerId: WORKER_ID,
      correlationId: id,
      processor: () => runReconciliation(),
    });

    return result;
  } catch (err) {
    throw err;
  }
}

// Run immediately on start
runJob();

// Run every 2 minutes
let shuttingDown = false;

process.on('SIGTERM', () => {
  logger.info('Payment reconciliation worker: SIGTERM received');
  shuttingDown = true;
});

const interval = setInterval(async () => {
  if (shuttingDown) {
    clearInterval(interval);
    logger.info('Payment reconciliation worker: shutting down');
    process.exit(0);
  }

  const jobId = `pay-rec-cron-${Date.now()}`;
  await runJob(jobId).catch((err) => {
    logger.error('Payment reconciliation: unhandled error', {
      error: err.message,
      stack: err.stack,
    });
  });
}, RUN_INTERVAL_MS);

module.exports = { runReconciliation, runJob };

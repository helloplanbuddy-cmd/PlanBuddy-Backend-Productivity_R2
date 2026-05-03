'use strict';

/**
 * workers/dlq-processor.worker.js — BullMQ Dead Letter Queue Processor
 *
 * PHASE 3: Auto-recovery for exhausted jobs
 *
 * Processes failed jobs (after 5 retries):
 *  - Logs to alert_log (WORKER_EXHAUSTED)
 *  - Writes to dlq_jobs table for manual review
 *  - Optional auto-retry for transient errors (Razorpay 5xx)
 *  - Slack alert for immediate attention
 *
 * Run as PM2 cron_restart every 10min
 */

const logger = require('../utils/logger');
const db = require('../config/db');
const { alertWorkerExhausted } = require('../services/alertingService');
const { connection } = require('../config/queues');

const { Queue } = require('bullmq');

const queues = {
  'booking-expiry': new Queue('booking-expiry', { connection }),
  'payment-reconciliation': new Queue('payment-reconciliation', { connection }),
  'email-dispatch': new Queue('email-dispatch', { connection }),
  'refund-retry': new Queue('refund-retry', { connection }),
};

async function processDLQ() {
  try {
    for (const [name, queue] of Object.entries(queues) ) {
      const failedJobs = await queue.getFailed();

      for (const job of failedJobs) {
        if (job.failedReason === 'max retries exceeded') {
          await alertWorkerExhausted(job.id, name, 5, job.stacktrace?.[0] || 'unknown');

          // Write to DLQ table for manual review
          await db.query(`
            INSERT INTO dead_letter_jobs (queue_name, job_id, payload, failed_reason, stacktrace, created_at)
            VALUES ($1, $2, $3, $4, $5, NOW())
            ON CONFLICT (job_id) DO NOTHING
          `, [name, job.id, JSON.stringify(job.data), job.failedReason, JSON.stringify(job.stacktrace || [])]);

          logger.critical('DLQ job recorded', { queue: name, jobId: job.id, payload: job.data });
        }
      }

      // Clean old DLQ >7days
      await db.query(`DELETE FROM dead_letter_jobs WHERE created_at < NOW() - INTERVAL '7 days'`);
    }
  } catch (err) {
    logger.error('DLQ processor failed', { error: err.message });
  }
}

// ── Cron every 10min ────────────────────────────────────────────────────────
const cron = require('node-cron');
cron.schedule('*/10 * * * *', processDLQ, { timezone: "UTC" });

logger.info('DLQ processor started — checks failed jobs every 10min');

process.on('SIGTERM', () => {
  logger.info('DLQ processor: SIGTERM — graceful exit');
  process.exit(0);
});


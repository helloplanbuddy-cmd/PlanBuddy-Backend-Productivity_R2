'use strict';

/**
 * planbuddy_v9/workers/index.js — All-in-one worker runner (v2.0)
 *
 * PURPOSE
 *   Starts ALL workers in a single process for development and simple deployments.
 *   For production, prefer dedicated per-worker processes:
 *
 *     npm run worker:webhook    → planbuddy_v9/workers/start-webhook.js
 *     npm run worker:refund     → planbuddy_v9/workers/start-refund.js
 *     npm run worker:email      → planbuddy_v9/workers/start-email.js
 *     npm run worker:scheduler  → planbuddy_v9/workers/start-scheduler.js
 *
 *   Reason to prefer dedicated processes in production:
 *   - Independent scaling per worker type
 *   - Isolated crash domain (a DLQ bug does not kill the webhook worker)
 *   - Easier PM2 / Docker container per worker
 *
 * STARTUP SEQUENCE
 *   1. Load and validate environment (config/env.js fails fast on missing vars)
 *   2. Warm DB pool (config/db.js)
 *   3. Warm Redis clients (config/redis.js)
 *   4. Schedule repeating BullMQ jobs (config/queues.js)
 *   5. Require each worker module (side-effect: each registers a BullMQ Worker)
 *   6. Keep process alive — BullMQ workers maintain their own event loops
 */

const logger = require('../utils/logger');

// ─── 1. Config (validates env, exits on invalid) ─────────────────────────────
require('../config/env');
require('../config/db');
require('../config/redis');

// ─── 2. Schedule repeating jobs ───────────────────────────────────────────────
const { scheduleRepeatableJobs } = require('../config/queues');

// ─── 3. Start workers (require = side-effect starts BullMQ Worker) ───────────
require('./webhook-processor.worker');
require('./refund-retry.worker');
require('./email-dispatch.worker');
require('./dlq-processor.worker');
require('./payment-reconciliation-queue.worker');

// ─── 4. Schedule repeating jobs after workers are ready ──────────────────────
scheduleRepeatableJobs()
  .then(() => {
    logger.info('[workers/index] All workers started and repeatable jobs scheduled');
  })
  .catch((err) => {
    logger.error({ err }, '[workers/index] Failed to schedule repeatable jobs — process will exit');
    process.exit(1);
  });

// ─── 5. Graceful shutdown ─────────────────────────────────────────────────────
// Each worker module already registers its own SIGTERM/SIGINT handler.
// This catches any uncaught process-level signals and ensures clean exit.

process.on('uncaughtException', (err) => {
  logger.error({ err }, '[workers/index] Uncaught exception — shutting down');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, '[workers/index] Unhandled rejection — shutting down');
  process.exit(1);
});

logger.info('[workers/index] PlanBuddy worker process initialising...');

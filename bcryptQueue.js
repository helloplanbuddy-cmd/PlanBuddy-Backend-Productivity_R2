'use strict';

/**
 * services/bcryptQueue.js — Async BCrypt Processing Queue
 *
 * PHASE 3: Prevent threadpool saturation during login attacks
 *
 * Problem:
 *  - bcrypt is CPU-intensive (12 rounds = ~250ms per hash)
 *  - Under high load (bot attack), threadpool saturates
 *  - All requests slow down, including booking API
 *
 * Solution:
 *  - Queue bcrypt operations to BullMQ
 *  - Process hashes asynchronously in background
 *  - Return immediately with a job ID
 *  - Client polls for result
 *
 * Usage:
 *   const jobId = await bcryptQueue.hash('password');
 *   const result = await bcryptQueue.getResult(jobId);
 *   // Or use async/await:
 *   const hash = await bcryptQueue.hashAsync('password');
 */

const crypto = require('crypto');
const { Queue } = require('bullmq');
const logger = require('../utils/logger');
const monitoring = require('../utils/monitoring');

// BCrypt configuration
const BCRYPT_ROUNDS = 12;
const MAX_PASSWORD_LEN = 72; // BCrypt silently truncates at 72 bytes
const DEFAULT_TOKEN_BYTES = 64;

// Queue configuration
const QUEUE_NAME = 'bcrypt-hash';
const QUEUE_CONCURRENCY = 5; // Process 5 hashes at a time

// In-memory result cache (for short-lived operations)
// In production, consider Redis-based cache for multi-instance
const resultCache = new Map();
const CACHE_TTL_MS = 60_000; // 1 minute

// Redis connection for queue
let redisConnection;
function getRedisConnection() {
  if (!redisConnection) {
    const { redis } = require('../config/redis');
    redisConnection = redis;
  }
  return redisConnection;
}

// Create BullMQ queue
let bcryptQueue;

function getQueue() {
  if (!bcryptQueue) {
    const r = getRedisConnection();
    if (!r) {
      throw new Error('Redis unavailable — bcrypt queue requires Redis');
    }

    bcryptQueue = new Queue(QUEUE_NAME, {
      connection: r,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    });
  }
  return bcryptQueue;
}

// Worker function (processes hashes)
async function hashProcessor(job) {
  const { password, salt } = job.data;
  const bcrypt = require('bcryptjs');

  try {
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // Report metrics
    if (monitoring.bcrypt_hash_total) {
      monitoring.bcrypt_hash_total.inc();
    }

    return { hash };
  } catch (err) {
    logger.error('bcrypt hash failed', { error: err.message, jobId: job.id });
    throw err;
  }
}

// Start worker (exported for worker process)
async function startWorker() {
  const { Worker } = require('bullmq');
  const r = getRedisConnection();

  if (!r) {
    logger.warn('Redis unavailable — bcrypt worker not started');
    return null;
  }

  const worker = new Worker(QUEUE_NAME, hashProcessor, {
    connection: r,
    concurrency: QUEUE_CONCURRENCY,
    limiter: {
      max: 100,
      duration: 60_000,
    },
  });

  worker.on('completed', (job) => {
    // Store result in cache
    resultCache.set(job.id, {
      success: true,
      hash: job.returnvalue?.hash,
      completedAt: Date.now(),
    });

    // Cleanup cache entry after TTL
    setTimeout(() => resultCache.delete(job.id), CACHE_TTL_MS);
  });

  worker.on('failed', (job, err) => {
    logger.error('bcrypt job failed', { jobId: job.id, error: err.message });

    resultCache.set(job.id, {
      success: false,
      error: err.message,
      completedAt: Date.now(),
    });

    setTimeout(() => resultCache.delete(job.id), CACHE_TTL_MS);
  });

  logger.info('bcryptQueue: worker started', { concurrency: QUEUE_CONCURRENCY });
  return worker;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Queue a bcrypt hash operation.
 * Returns immediately with a job ID.
 *
 * @param {string} password - plain text password
 * @returns {Promise<string>} jobId
 */
async function queueHash(password) {
  if (!password || typeof password !== 'string') {
    throw new Error('Password is required');
  }

  // Guard against bcrypt truncation attack
  if (password.length > MAX_PASSWORD_LEN) {
    throw new Error('Invalid credentials');
  }

  const queue = getQueue();
  const job = await queue.add('hash', { password }, {
    jobId: `bcrypt-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`,
  });

  logger.debug('bcrypt: queued', { jobId: job.id });

  return job.id;
}

/**
 * Get result of a queued bcrypt operation.
 *
 * @param {string} jobId
 * @returns {Promise<{success: boolean, hash?: string, error?: string}>}
 */
async function getResult(jobId) {
  // Check cache first
  const cached = resultCache.get(jobId);
  if (cached) {
    return cached;
  }

  // Check if job exists in queue
  const queue = getQueue();
  const job = await queue.getJob(jobId);

  if (!job) {
    return { success: false, error: 'Job not found' };
  }

  if (job.status === 'completed') {
    const result = { success: true, hash: job.returnvalue?.hash, completedAt: Date.now() };
    resultCache.set(jobId, result);
    return result;
  }

  if (job.status === 'failed') {
    const result = { success: false, error: job.failedReason, completedAt: Date.now() };
    resultCache.set(jobId, result);
    return result;
  }

  // Still processing
  return { success: null, error: 'Processing' };
}

/**
 * Hash a password asynchronously.
 * Convenience wrapper around queueHash + getResult.
 *
 * @param {string} password
 * @returns {Promise<string>} hashed password
 */
async function hashAsync(password) {
  const jobId = await queueHash(password);

  // Poll for result (max 10 seconds)
  const maxAttempts = 20;
  const pollInterval = 500;

  for (let i = 0; i < maxAttempts; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    const result = await getResult(jobId);

    if (result.success === false) {
      throw new Error(result.error || 'Hash failed');
    }

    if (result.success === true) {
      return result.hash;
    }
  }

  throw new Error('Hash timeout');
}

/**
 * Compare password with hash (synchronous fallback for quick operations).
 * Uses synchronous bcrypt.compare for single comparisons.
 *
 * @param {string} password
 * @param {string} hash
 * @returns {Promise<boolean>}
 */
async function compare(password, hash) {
  if (!password || !hash) {
    return false;
  }

  // Guard against bcrypt truncation attack
  if (password.length > MAX_PASSWORD_LEN) {
    return false;
  }

  const bcrypt = require('bcryptjs');
  return bcrypt.compare(password, hash);
}

/**
 * Generate a hash synchronously (for immediate use cases like token rotation).
 *
 * @param {string} password
 * @returns {Promise<string>}
 */
async function hashSync(password) {
  if (!password || typeof password !== 'string') {
    throw new Error('Password is required');
  }

  if (password.length > MAX_PASSWORD_LEN) {
    throw new Error('Invalid credentials');
  }

  const bcrypt = require('bcryptjs');

  if (monitoring.bcrypt_hash_total) {
    monitoring.bcrypt_hash_total.inc();
  }

  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

// Cache cleanup job
setInterval(() => {
  const now = Date.now();
  for (const [jobId, result] of resultCache.entries()) {
    if (now - result.completedAt > CACHE_TTL_MS) {
      resultCache.delete(jobId);
    }
  }
}, 30_000);

module.exports = {
  queueHash,
  getResult,
  hashAsync,
  hashSync,
  compare,
  startWorker,
  getQueue,
};

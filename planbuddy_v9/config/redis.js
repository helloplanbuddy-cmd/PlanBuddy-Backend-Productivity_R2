'use strict';

/**
 * config/redis.js — Production Redis Client (v3.0)
 *
 * NEW in v3.0 — replaces PostgreSQL-backed rate limiting + JTI revocation.
 *
 * Two clients are exported:
 *  - `redis`      — general-purpose client (caching, rate limiting, idempotency)
 *  - `redisQueue` — dedicated client for BullMQ (queues must not share a client
 *                   with general I/O — BullMQ uses BLPOP which blocks the connection)
 *
 * Design:
 *  - Both clients are singletons — one connection per process, pooling handled by ioredis.
 *  - Connection errors are logged but never crash the process (fail-open on cache miss).
 *  - `isHealthy()` exposes a PING check for the /health/ready endpoint.
 *  - `isQueueHealthy()` exposes a PING check for the BullMQ queue client.
 *  - TLS is auto-detected from URL scheme (rediss://).
 *  - Reconnect strategy: exponential backoff capped at 30s.
 */

const Redis = require('ioredis');
const env   = require('./env');

// ─── Reconnect strategy ───────────────────────────────────────────────────────

function reconnectStrategy(retries) {
  // Max 30s between retries; escalate: 100ms, 200ms, 400ms ... 30s
  return Math.min(100 * Math.pow(2, retries), 30_000);
}

// ─── Client factory ───────────────────────────────────────────────────────────

function createClient(url, name) {
  const logger = require('../utils/logger');

  const opts = {
    // ioredis parses the URL — TLS auto-enabled for rediss://
    lazyConnect: false,

    // required by BullMQ — don't suppress connection errors
    maxRetriesPerRequest: null,

    enableReadyCheck: true,

    retryStrategy: reconnectStrategy,

    reconnectOnError(err) {
      // Reconnect on READONLY errors (Redis Cluster failover)
      return err.message.includes('READONLY');
    },
  };

  const client = new Redis(url, opts);

  client.on('connect', () => {
    logger.info(`[redis:${name}] Connected`);
  });

  client.on('ready', () => {
    logger.info(`[redis:${name}] Ready`);
  });

  client.on('error', (err) => {
    // Log but do not crash — app degrades gracefully without Redis
    logger.error({ err }, `[redis:${name}] Connection error`);
  });

  client.on('close', () => {
    logger.warn(`[redis:${name}] Connection closed`);
  });

  client.on('reconnecting', (delay) => {
    logger.warn(`[redis:${name}] Reconnecting in ${delay}ms`);
  });

  return client;
}

// ─── Singleton instances ──────────────────────────────────────────────────────

const redis = createClient(env.REDIS_URL, 'cache');

const redisQueue = createClient(
  env.REDIS_QUEUE_URL,
  'queue'
);

// ─── Health probe ─────────────────────────────────────────────────────────────

/**
 * PING the Redis cache client.
 * Returns:
 *   { status: 'ok', latencyMs }
 * or
 *   { status: 'error', error, latencyMs }
 */
async function isHealthy() {
  const start = Date.now();

  try {
    const pong = await redis.ping();

    if (pong !== 'PONG') {
      throw new Error(`Unexpected PING response: ${pong}`);
    }

    return {
      status: 'ok',
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      status: 'error',
      error: err.message,
      latencyMs: Date.now() - start,
    };
  }
}

/**
 * PING the Redis queue client.
 * Used for BullMQ / worker health validation.
 */
async function isQueueHealthy() {
  const start = Date.now();

  try {
    const pong = await redisQueue.ping();

    if (pong !== 'PONG') {
      throw new Error(`Unexpected PING response: ${pong}`);
    }

    return {
      status: 'ok',
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      status: 'error',
      error: err.message,
      latencyMs: Date.now() - start,
    };
  }
}

// ─── Graceful disconnect ──────────────────────────────────────────────────────

/**
 * Called during server shutdown.
 * Closes both clients cleanly.
 */
async function disconnect() {
  await Promise.allSettled([
    redis.quit(),
    redisQueue.quit(),
  ]);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  redis,
  redisQueue,
  isHealthy,
  isQueueHealthy,
  disconnect,
};
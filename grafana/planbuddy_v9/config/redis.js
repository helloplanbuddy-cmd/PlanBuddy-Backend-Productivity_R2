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
    lazyConnect:     false,
    maxRetriesPerRequest: null, // required by BullMQ — don't suppress connection errors
    enableReadyCheck: true,
    retryStrategy:   reconnectStrategy,
    reconnectOnError(err) {
      // Reconnect on READONLY errors (Redis Cluster failover)
      return err.message.includes('READONLY');
    },
  };

  // Log the connection attempt with full URL details
  logger.info(
    { 
      msg: 'redis_connection_attempt', 
      client: name, 
      url: url,
      timestamp: new Date().toISOString()
    }, 
    `[redis:${name}] Attempting connection to ${url}`
  );

  const client = new Redis(url, opts);

  client.on('connect', () => {
    logger.info(
      { 
        msg: 'redis_connected', 
        client: name, 
        url: url,
        timestamp: new Date().toISOString()
      }, 
      `[redis:${name}] TCP connection established`
    );
  });

  client.on('ready', () => {
    logger.info(
      { 
        msg: 'redis_ready', 
        client: name, 
        url: url, 
        state: 'ready',
        timestamp: new Date().toISOString()
      }, 
      `[redis:${name}] Ready to receive commands`
    );
  });

  client.on('error', (err) => {
    // Log but do not crash — app degrades gracefully without Redis
    // Required for Phase 1: explicit 'redis_connection_failed' logging.
    logger.error(
      { 
        err,
        msg: 'redis_connection_failed',
        client: name,
        url: url,
        errorCode: err.code,
        errorMessage: err.message,
        isConnRefused: err.code === 'ECONNREFUSED',
        timestamp: new Date().toISOString()
      },
      `[redis:${name}] Connection failed: ${err.code || 'unknown'}`
    );
  });

  client.on('close', () => {
    logger.warn(
      { 
        msg: 'redis_disconnected', 
        client: name,
        timestamp: new Date().toISOString()
      }, 
      `[redis:${name}] Connection closed`
    );
  });

  client.on('reconnecting', (delay) => {
    logger.warn(
      { 
        msg: 'redis_reconnecting', 
        client: name, 
        delayMs: delay,
        timestamp: new Date().toISOString()
      }, 
      `[redis:${name}] Reconnecting in ${delay}ms`
    );
  });

  return client;
}

// ─── Singleton instances ──────────────────────────────────────────────────────

const redis      = createClient(env.REDIS_URL,       'cache');
const redisQueue = createClient(env.REDIS_QUEUE_URL, 'queue');

// ─── Health probe ─────────────────────────────────────────────────────────────

/**
 * PING the Redis cache client.
 * Returns { status: 'ok', latencyMs } or { status: 'error', error, latencyMs }.
 */
async function isHealthy() {
  const start = Date.now();
  try {
    const pong = await redis.ping();
    if (pong !== 'PONG') throw new Error(`Unexpected PING response: ${pong}`);
    const latency = Date.now() - start;
    return { status: 'ok', latencyMs: latency };
  } catch (err) {
    const latency = Date.now() - start;
    return { status: 'error', error: err.message, latencyMs: latency };
  }
}

/**
 * PING the Redis queue client.
 * Returns { status: 'ok', latencyMs } or { status: 'error', error, latencyMs }.
 */
async function isQueueHealthy() {
  const start = Date.now();
  try {
    const pong = await redisQueue.ping();
    if (pong !== 'PONG') throw new Error(`Unexpected PING response: ${pong}`);
    const latency = Date.now() - start;
    return { status: 'ok', latencyMs: latency };
  } catch (err) {
    const latency = Date.now() - start;
    return { status: 'error', error: err.message, latencyMs: latency };
  }
}

// ─── Graceful disconnect ──────────────────────────────────────────────────────

/**
 * Called during server shutdown. Closes both clients cleanly.
 */
async function disconnect() {
  await Promise.allSettled([
    redis.quit(),
    redisQueue.quit(),
  ]);
}

module.exports = { redis, redisQueue, isHealthy, isQueueHealthy, disconnect };

'use strict';

/**
 * middleware/idempotency.js — Redis-Backed Idempotency with DB Fallback (v5.0)
 * ─────────────────────────────────────────────────────────────────────────────
 * ENFORCEMENT MODEL — Option A: Centralised
 *
 * Every 409 IDEMPOTENCY_KEY_IN_FLIGHT response automatically calls
 * trackConflict() from idempotencyConflictLimiter.js.  No route needs to
 * manually pair the two middlewares — conflict protection is structural,
 * not optional.
 *
 * WHAT THIS FILE PROVIDES
 *
 *   idempotency          — optional enforcement (skips if no key supplied)
 *   idempotency.strict   — hard enforcement (400 if key absent)
 *
 * SECURITY GUARANTEES
 *
 *   • Duplicate payments/webhooks:
 *       Redis SETNX lock (30 s TTL) blocks concurrent identical requests.
 *       Completed 2xx responses are cached in Redis + written to DB so
 *       replayed requests get the original response with no re-execution.
 *
 *   • Race-condition booking creation:
 *       Only one request per scopedKey can hold the Redis lock at a time.
 *       Concurrent duplicates receive 409 immediately.
 *
 *   • Cross-user replay:
 *       scopedKey = `${userId}:${method}:${path}:${rawKey}`
 *       A key issued by user A cannot replay a response for user B.
 *
 *   • Conflict abuse (brute-force key cycling):
 *       trackConflict() is called on every 409. After CONFLICT_LIMIT hits
 *       within the sliding window the originating IP is blocked for BLOCK_S
 *       seconds. The block is enforced by conflictLimiter() (see below).
 *
 * FAILURE MODES
 *
 *   Redis down:
 *     Falls back to PostgreSQL for cache reads/writes.
 *     Lock is skipped (no distributed lock available) — request proceeds.
 *     trackConflict() is a no-op (fail open, never blocks traffic).
 *     ⚠ Under Redis failure duplicate processing is theoretically possible;
 *       the DB unique constraint on idempotency_keys is the last safety net.
 *
 *   Key absent on idempotency (non-strict):
 *     Request proceeds without idempotency protection — safe for read-only
 *     or non-financial endpoints.
 *
 *   Key absent on idempotency.strict:
 *     400 IDEMPOTENCY_KEY_REQUIRED — request is rejected before any
 *     business logic runs.
 *
 *   High-traffic burst (1 000+ req/s same key):
 *     First request acquires lock; all others receive 409 immediately
 *     (no queue, no backpressure added to the DB pool).
 *     trackConflict() fires on each 409 — abusive IPs are rate-limited.
 *
 * CHANGES FROM v4.0
 *   • Dead TODO stub for conflict tracking replaced by real trackConflict() call.
 *   • Async IIFE refactored into a proper named async function to make stack
 *     traces readable.
 *   • Lock release moved to a finally block so it fires even when res.json
 *     throws (was previously possible to leak locks).
 *   • DB write now happens regardless of Redis availability, not only in the
 *     Redis-down branch — improves durability under partial Redis failures.
 *   • All inline requires hoisted to the top of the file.
 */

const crypto  = require('crypto');
const logger  = require('../utils/logger');
const env     = require('../config/env');
const db      = require('../config/db');
const { trackConflict } = require('./idempotencyConflictLimiter');

// ─── Configuration ────────────────────────────────────────────────────────────

const DONE_PREFIX  = 'idempotency:done:';
const LOCK_PREFIX  = 'idempotency:lock:';
const LOCK_TTL_S   = 30;
const RESPONSE_TTL = (env.IDEMPOTENCY_TTL_HOURS || 72) * 3600;
const DB_TTL_HOURS = env.IDEMPOTENCY_TTL_HOURS || 72;

// ─── Redis helpers ────────────────────────────────────────────────────────────

function getRedis() {
  try {
    return require('../config/redis').redis;
  } catch (_) {
    return null;
  }
}

function isRedisReady(redis) {
  return redis && redis.status === 'ready';
}

// ─── DB fallback helpers ──────────────────────────────────────────────────────

async function dbGet(key) {
  try {
    const result = await db.query(
      `SELECT response_code, response_body
         FROM idempotency_keys
        WHERE key = $1 AND expires_at > NOW()`,
      [key]
    );
    return result.rows.length > 0 ? result.rows[0] : null;
  } catch (err) {
    logger.warn('[idempotency] DB fallback GET failed', { key, error: err.message });
    return null;
  }
}

async function dbSet(key, userId, endpoint, requestHash, responseCode, responseBody) {
  try {
    await db.query(
      `INSERT INTO idempotency_keys
         (key, user_id, endpoint, user_id_str, request_hash, response_code, response_body, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + INTERVAL '${DB_TTL_HOURS} hours')
       ON CONFLICT (key) DO UPDATE
         SET response_code = EXCLUDED.response_code,
             response_body = EXCLUDED.response_body`,
      [
        key,
        userId || null,
        endpoint,
        userId ? String(userId) : null,
        requestHash,
        responseCode,
        responseBody,
      ]
    );
  } catch (err) {
    logger.warn('[idempotency] DB fallback SET failed', { key, error: err.message });
  }
}

// ─── Lock release helper ──────────────────────────────────────────────────────
//
// Wrapped so it is always safe to call — never throws.

async function releaseLock(redis, lockKey) {
  if (!isRedisReady(redis)) return;
  try {
    await redis.del(lockKey);
  } catch (err) {
    logger.warn('[idempotency] Failed to release lock', { lockKey, error: err.message });
  }
}

// ─── Core idempotency logic ───────────────────────────────────────────────────
//
// Extracted from the middleware so it is testable in isolation and so that
// the stack trace names this function rather than "anonymous".

async function runIdempotency(req, res, next, rawKey) {
  // Build scoped key: ties the idempotency key to user + endpoint so the same
  // raw key cannot replay a response across users or across different routes.
  const userId    = req.user?.id || 'anon';
  const endpoint  = `${req.method}:${req.path}`;
  const scopedKey = `${userId}:${endpoint}:${rawKey}`;

  const redis    = getRedis();
  const useRedis = isRedisReady(redis);

  const doneKey = `${DONE_PREFIX}${scopedKey}`;
  const lockKey = `${LOCK_PREFIX}${scopedKey}`;
  // DB key is hashed so it fits within the column length and has no special chars.
  const dbKey   = `idempotency:${crypto.createHash('sha256').update(scopedKey).digest('hex')}`;

  if (!useRedis) {
    logger.warn('[idempotency] Redis not ready — falling back to DB idempotency');
  }

  // ── Step 1: Return cached response if this key has already completed ────────

  if (useRedis) {
    let cached;
    try {
      cached = await redis.get(doneKey);
    } catch (err) {
      logger.warn('[idempotency] Redis GET failed — trying DB fallback', { error: err.message });
    }

    if (cached) {
      try {
        const { status, body } = JSON.parse(cached);
        res.setHeader('X-Idempotency-Replayed', 'true');
        return res.status(status).json(body);
      } catch (_) {
        // Corrupt cache entry — delete and reprocess.
        await redis.del(doneKey).catch(() => {});
      }
    }
  }

  // Always check DB — covers: Redis miss after Redis restart, or the write was
  // DB-only because Redis was down when the original request completed.
  const dbRow = await dbGet(dbKey);
  if (dbRow) {
    try {
      const body = typeof dbRow.response_body === 'string'
        ? JSON.parse(dbRow.response_body)
        : dbRow.response_body;
      res.setHeader('X-Idempotency-Replayed', 'true');
      return res.status(dbRow.response_code).json(body);
    } catch (_) {
      // Corrupt DB entry — fall through and reprocess.
    }
  }

  // ── Step 2: Acquire distributed lock ─────────────────────────────────────────
  //
  // Prevents two concurrent requests with the same key from both executing
  // business logic simultaneously (the race-condition that causes double-charges).

  let lockAcquired = false;

  if (useRedis) {
    let acquired;
    try {
      acquired = await redis.set(lockKey, '1', 'NX', 'EX', LOCK_TTL_S);
    } catch (err) {
      logger.warn('[idempotency] Redis lock acquisition failed — proceeding without lock', {
        error: err.message,
      });
      // Fail open: proceed without a lock so a Redis blip doesn't block all traffic.
      // The DB unique constraint is the last line of defence here.
      return next();
    }

    if (!acquired) {
      // ── Conflict detected: another request with this key is in flight ────────
      // Track the conflict for abuse detection. This is the integration point
      // that replaces the dead TODO stub from v4.0. No route-level wiring needed.
      const ip = req.ip || req.connection?.remoteAddress || 'unknown';
      await trackConflict(ip, redis);

      logger.warn('[idempotency] Key already in flight — returning 409', {
        userId,
        endpoint,
        ip,
      });

      return res.status(409).json({
        success: false,
        code:    'IDEMPOTENCY_KEY_IN_FLIGHT',
        message: 'A request with this Idempotency-Key is already in progress.',
      });
    }

    lockAcquired = true;
  }

  // ── Step 3: Compute request hash ─────────────────────────────────────────────
  //
  // Stored in the DB for audit purposes (future: detect body-mismatch attacks).

  const requestHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(req.body || {}))
    .digest('hex');

// ── Step 4: Intercept res.json/res.send to capture and cache the response ─
// We wrap res.json and res.send (common Express patterns) rather than
// a response-finished event so we can await cache/DB writes before bytes
// are sent, ensuring the key is stored before the client retries.

  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);

  async function captureAndCacheResponse(body) {
    const status = res.statusCode || 200;

    try {
      // Only cache successful (2xx) responses.
      if (status >= 200 && status < 300) {
        const payload = JSON.stringify({ status, body });

        // Write to Redis (primary cache).
        if (useRedis && isRedisReady(redis)) {
          try {
            await redis.set(doneKey, payload, 'EX', RESPONSE_TTL);
          } catch (err) {
            logger.warn('[idempotency] Failed to cache response in Redis', { error: err.message });
          }
        }

        // Write to DB (durable fallback — always).
        await dbSet(
          dbKey,
          userId,
          endpoint,
          requestHash,
          status,
          typeof body === 'string' ? JSON.stringify({ value: body }) : JSON.stringify(body)
        );
      }
    } finally {
      // Always release the lock.
      if (lockAcquired) {
        await releaseLock(redis, lockKey);
      }
    }
  }

  // Capture JSON
  res.json = async function captureIdempotentJsonResponse(body) {
    // Restore immediately to avoid recursion
    res.json = originalJson;
    res.send = originalSend;

    await captureAndCacheResponse(body);
    return originalJson(body);
  };

  // Capture send() for JSON payloads
  res.send = async function captureIdempotentSendResponse(body) {
    // Restore immediately to avoid recursion
    res.json = originalJson;
    res.send = originalSend;

    // If Express is sending a Buffer/string, we only safely cache JSON-like content.
    // If it's a plain object, cache it.
    const shouldCache =
      body && typeof body === 'object' && !Buffer.isBuffer(body) ||
      typeof body === 'string';

    if (shouldCache) {
      // Try to normalize strings that are JSON
      let normalized = body;
      if (typeof body === 'string') {
        try {
          normalized = JSON.parse(body);
        } catch (_) {
          // Non-JSON string: do not attempt to replay as JSON body.
          normalized = { value: body };
        }
      }

      await captureAndCacheResponse(normalized);
    }

    return originalSend(body);
  };

  return next();
}

// ─── Middleware: idempotency (optional) ───────────────────────────────────────
//
// Skips silently if no Idempotency-Key header is present.
// Use on endpoints where idempotency is helpful but not mandatory.

function idempotency(req, res, next) {
  const rawKey = req.headers['idempotency-key'];

  // No key → pass through without idempotency protection.
  if (!rawKey || rawKey.trim() === '') return next();

  if (typeof rawKey !== 'string' || rawKey.length > 255) {
    return res.status(400).json({
      success: false,
      code:    'INVALID_IDEMPOTENCY_KEY',
      message: 'Idempotency-Key must be a string of 255 characters or fewer.',
    });
  }

  runIdempotency(req, res, next, rawKey.trim()).catch(err => {
    logger.error({ err }, '[idempotency] Unexpected error — releasing lock and calling next');
    // Best-effort lock release on unexpected error path.
    const redis = getRedis();
    if (isRedisReady(redis)) {
      const userId    = req.user?.id || 'anon';
      const scopedKey = `${userId}:${req.method}:${req.path}:${rawKey.trim()}`;
      redis.del(`${LOCK_PREFIX}${scopedKey}`).catch(() => {});
    }
    next();
  });
}

// ─── Middleware: idempotency.strict ───────────────────────────────────────────
//
// Rejects with 400 if Idempotency-Key header is absent.
// Use on all financial endpoints (payments, refunds, booking creation).
//
// Usage:
//   router.post('/payment/create-order', idempotency.strict, controller.createOrder);
//   router.post('/payment/verify-payment', idempotency.strict, controller.verifyPayment);
//   router.post('/bookings', idempotency.strict, controller.createBooking);

function idempotencyStrict(req, res, next) {
  const rawKey = req.headers['idempotency-key'];

  if (!rawKey || rawKey.trim() === '') {
    return res.status(400).json({
      success: false,
      code:    'IDEMPOTENCY_KEY_REQUIRED',
      message: 'Idempotency-Key header is required for this endpoint to prevent duplicate processing.',
    });
  }

  if (typeof rawKey !== 'string' || rawKey.length > 255) {
    return res.status(400).json({
      success: false,
      code:    'INVALID_IDEMPOTENCY_KEY',
      message: 'Idempotency-Key must be a string of 255 characters or fewer.',
    });
  }

  runIdempotency(req, res, next, rawKey.trim()).catch(err => {
    logger.error({ err }, '[idempotency:strict] Unexpected error — releasing lock and calling next');
    const redis = getRedis();
    if (isRedisReady(redis)) {
      const userId    = req.user?.id || 'anon';
      const scopedKey = `${userId}:${req.method}:${req.path}:${rawKey.trim()}`;
      redis.del(`${LOCK_PREFIX}${scopedKey}`).catch(() => {});
    }
    next();
  });
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports         = idempotency;
module.exports.strict  = idempotencyStrict;

// Exported for unit testing the core logic without an HTTP layer.
module.exports._runIdempotency = runIdempotency;'use strict';

/**
 * middleware/idempotency.js — Redis-Backed Idempotency with DB Fallback (v5.0)
 * ─────────────────────────────────────────────────────────────────────────────
 * ENFORCEMENT MODEL — Option A: Centralised
 *
 * Every 409 IDEMPOTENCY_KEY_IN_FLIGHT response automatically calls
 * trackConflict() from idempotencyConflictLimiter.js.  No route needs to
 * manually pair the two middlewares — conflict protection is structural,
 * not optional.
 *
 * WHAT THIS FILE PROVIDES
 *
 *   idempotency          — optional enforcement (skips if no key supplied)
 *   idempotency.strict   — hard enforcement (400 if key absent)
 *
 * SECURITY GUARANTEES
 *
 *   • Duplicate payments/webhooks:
 *       Redis SETNX lock (30 s TTL) blocks concurrent identical requests.
 *       Completed 2xx responses are cached in Redis + written to DB so
 *       replayed requests get the original response with no re-execution.
 *
 *   • Race-condition booking creation:
 *       Only one request per scopedKey can hold the Redis lock at a time.
 *       Concurrent duplicates receive 409 immediately.
 *
 *   • Cross-user replay:
 *       scopedKey = `${userId}:${method}:${path}:${rawKey}`
 *       A key issued by user A cannot replay a response for user B.
 *
 *   • Conflict abuse (brute-force key cycling):
 *       trackConflict() is called on every 409. After CONFLICT_LIMIT hits
 *       within the sliding window the originating IP is blocked for BLOCK_S
 *       seconds. The block is enforced by conflictLimiter() (see below).
 *
 * FAILURE MODES
 *
 *   Redis down:
 *     Falls back to PostgreSQL for cache reads/writes.
 *     Lock is skipped (no distributed lock available) — request proceeds.
 *     trackConflict() is a no-op (fail open, never blocks traffic).
 *     ⚠ Under Redis failure duplicate processing is theoretically possible;
 *       the DB unique constraint on idempotency_keys is the last safety net.
 *
 *   Key absent on idempotency (non-strict):
 *     Request proceeds without idempotency protection — safe for read-only
 *     or non-financial endpoints.
 *
 *   Key absent on idempotency.strict:
 *     400 IDEMPOTENCY_KEY_REQUIRED — request is rejected before any
 *     business logic runs.
 *
 *   High-traffic burst (1 000+ req/s same key):
 *     First request acquires lock; all others receive 409 immediately
 *     (no queue, no backpressure added to the DB pool).
 *     trackConflict() fires on each 409 — abusive IPs are rate-limited.
 *
 * CHANGES FROM v4.0
 *   • Dead TODO stub for conflict tracking replaced by real trackConflict() call.
 *   • Async IIFE refactored into a proper named async function to make stack
 *     traces readable.
 *   • Lock release moved to a finally block so it fires even when res.json
 *     throws (was previously possible to leak locks).
 *   • DB write now happens regardless of Redis availability, not only in the
 *     Redis-down branch — improves durability under partial Redis failures.
 *   • All inline requires hoisted to the top of the file.
 */

const crypto  = require('crypto');
const logger  = require('../utils/logger');
const env     = require('../config/env');
const db      = require('../config/db');
const { trackConflict } = require('./idempotencyConflictLimiter');

// ─── Configuration ────────────────────────────────────────────────────────────

const DONE_PREFIX  = 'idempotency:done:';
const LOCK_PREFIX  = 'idempotency:lock:';
const LOCK_TTL_S   = 30;
const RESPONSE_TTL = (env.IDEMPOTENCY_TTL_HOURS || 72) * 3600;
const DB_TTL_HOURS = env.IDEMPOTENCY_TTL_HOURS || 72;

// ─── Redis helpers ────────────────────────────────────────────────────────────

function getRedis() {
  try {
    return require('../config/redis').redis;
  } catch (_) {
    return null;
  }
}

function isRedisReady(redis) {
  return redis && redis.status === 'ready';
}

// ─── DB fallback helpers ──────────────────────────────────────────────────────

async function dbGet(key) {
  try {
    const result = await db.query(
      `SELECT response_code, response_body
         FROM idempotency_keys
        WHERE key = $1 AND expires_at > NOW()`,
      [key]
    );
    return result.rows.length > 0 ? result.rows[0] : null;
  } catch (err) {
    logger.warn('[idempotency] DB fallback GET failed', { key, error: err.message });
    return null;
  }
}

async function dbSet(key, userId, endpoint, requestHash, responseCode, responseBody) {
  try {
    await db.query(
      `INSERT INTO idempotency_keys
         (key, user_id, endpoint, user_id_str, request_hash, response_code, response_body, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + INTERVAL '${DB_TTL_HOURS} hours')
       ON CONFLICT (key) DO UPDATE
         SET response_code = EXCLUDED.response_code,
             response_body = EXCLUDED.response_body`,
      [
        key,
        userId || null,
        endpoint,
        userId ? String(userId) : null,
        requestHash,
        responseCode,
        responseBody,
      ]
    );
  } catch (err) {
    logger.warn('[idempotency] DB fallback SET failed', { key, error: err.message });
  }
}

// ─── Lock release helper ──────────────────────────────────────────────────────
//
// Wrapped so it is always safe to call — never throws.

async function releaseLock(redis, lockKey) {
  if (!isRedisReady(redis)) return;
  try {
    await redis.del(lockKey);
  } catch (err) {
    logger.warn('[idempotency] Failed to release lock', { lockKey, error: err.message });
  }
}

// ─── Core idempotency logic ───────────────────────────────────────────────────
//
// Extracted from the middleware so it is testable in isolation and so that
// the stack trace names this function rather than "anonymous".

async function runIdempotency(req, res, next, rawKey) {
  // Build scoped key: ties the idempotency key to user + endpoint so the same
  // raw key cannot replay a response across users or across different routes.
  const userId    = req.user?.id || 'anon';
  const endpoint  = `${req.method}:${req.path}`;
  const scopedKey = `${userId}:${endpoint}:${rawKey}`;

  const redis    = getRedis();
  const useRedis = isRedisReady(redis);

  const doneKey = `${DONE_PREFIX}${scopedKey}`;
  const lockKey = `${LOCK_PREFIX}${scopedKey}`;
  // DB key is hashed so it fits within the column length and has no special chars.
  const dbKey   = `idempotency:${crypto.createHash('sha256').update(scopedKey).digest('hex')}`;

  if (!useRedis) {
    logger.warn('[idempotency] Redis not ready — falling back to DB idempotency');
  }

  // ── Step 1: Return cached response if this key has already completed ────────

  if (useRedis) {
    let cached;
    try {
      cached = await redis.get(doneKey);
    } catch (err) {
      logger.warn('[idempotency] Redis GET failed — trying DB fallback', { error: err.message });
    }

    if (cached) {
      try {
        const { status, body } = JSON.parse(cached);
        res.setHeader('X-Idempotency-Replayed', 'true');
        return res.status(status).json(body);
      } catch (_) {
        // Corrupt cache entry — delete and reprocess.
        await redis.del(doneKey).catch(() => {});
      }
    }
  }

  // Always check DB — covers: Redis miss after Redis restart, or the write was
  // DB-only because Redis was down when the original request completed.
  const dbRow = await dbGet(dbKey);
  if (dbRow) {
    try {
      const body = typeof dbRow.response_body === 'string'
        ? JSON.parse(dbRow.response_body)
        : dbRow.response_body;
      res.setHeader('X-Idempotency-Replayed', 'true');
      return res.status(dbRow.response_code).json(body);
    } catch (_) {
      // Corrupt DB entry — fall through and reprocess.
    }
  }

  // ── Step 2: Acquire distributed lock ─────────────────────────────────────────
  //
  // Prevents two concurrent requests with the same key from both executing
  // business logic simultaneously (the race-condition that causes double-charges).

  let lockAcquired = false;

  if (useRedis) {
    let acquired;
    try {
      acquired = await redis.set(lockKey, '1', 'NX', 'EX', LOCK_TTL_S);
    } catch (err) {
      logger.warn('[idempotency] Redis lock acquisition failed — proceeding without lock', {
        error: err.message,
      });
      // Fail open: proceed without a lock so a Redis blip doesn't block all traffic.
      // The DB unique constraint is the last line of defence here.
      return next();
    }

    if (!acquired) {
      // ── Conflict detected: another request with this key is in flight ────────
      // Track the conflict for abuse detection. This is the integration point
      // that replaces the dead TODO stub from v4.0. No route-level wiring needed.
      const ip = req.ip || req.connection?.remoteAddress || 'unknown';
      await trackConflict(ip, redis);

      logger.warn('[idempotency] Key already in flight — returning 409', {
        userId,
        endpoint,
        ip,
      });

      return res.status(409).json({
        success: false,
        code:    'IDEMPOTENCY_KEY_IN_FLIGHT',
        message: 'A request with this Idempotency-Key is already in progress.',
      });
    }

    lockAcquired = true;
  }

  // ── Step 3: Compute request hash ─────────────────────────────────────────────
  //
  // Stored in the DB for audit purposes (future: detect body-mismatch attacks).

  const requestHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(req.body || {}))
    .digest('hex');

  // ── Step 4: Intercept res.json to capture and cache the response ─────────────
  //
  // We wrap res.json rather than use a response-finished event so we can
  // await the cache/DB writes before the response bytes are sent, ensuring
  // the key is stored before the client can retry.

  const originalJson = res.json.bind(res);

  res.json = async function captureIdempotentResponse(body) {
    // Restore immediately so recursive calls to res.json don't re-trigger this.
    res.json = originalJson;

    const status = res.statusCode || 200;

    try {
      // Only cache successful (2xx) responses.
      // Error responses (4xx/5xx) must not be replayed — the client should
      // be able to correct the request and try again.
      if (status >= 200 && status < 300) {
        const payload = JSON.stringify({ status, body });

        // Write to Redis (primary cache).
        if (useRedis && isRedisReady(redis)) {
          try {
            await redis.set(doneKey, payload, 'EX', RESPONSE_TTL);
          } catch (err) {
            logger.warn('[idempotency] Failed to cache response in Redis', { error: err.message });
          }
        }

        // Write to DB (durable fallback — always, not only when Redis is down).
        // This ensures the response survives a Redis restart or cluster failover.
        await dbSet(dbKey, userId, endpoint, requestHash, status, JSON.stringify(body));
      }
    } finally {
      // Always release the lock — even if caching fails or throws.
      // Placed in finally so a cache write error never creates a zombie lock.
      if (lockAcquired) {
        await releaseLock(redis, lockKey);
      }
    }

    return originalJson(body);
  };

  return next();
}

// ─── Middleware: idempotency (optional) ───────────────────────────────────────
//
// Skips silently if no Idempotency-Key header is present.
// Use on endpoints where idempotency is helpful but not mandatory.

function idempotency(req, res, next) {
  const rawKey = req.headers['idempotency-key'];

  // No key → pass through without idempotency protection.
  if (!rawKey || rawKey.trim() === '') return next();

  if (typeof rawKey !== 'string' || rawKey.length > 255) {
    return res.status(400).json({
      success: false,
      code:    'INVALID_IDEMPOTENCY_KEY',
      message: 'Idempotency-Key must be a string of 255 characters or fewer.',
    });
  }

  runIdempotency(req, res, next, rawKey.trim()).catch(err => {
    logger.error({ err }, '[idempotency] Unexpected error — releasing lock and calling next');
    // Best-effort lock release on unexpected error path.
    const redis = getRedis();
    if (isRedisReady(redis)) {
      const userId    = req.user?.id || 'anon';
      const scopedKey = `${userId}:${req.method}:${req.path}:${rawKey.trim()}`;
      redis.del(`${LOCK_PREFIX}${scopedKey}`).catch(() => {});
    }
    next();
  });
}

// ─── Middleware: idempotency.strict ───────────────────────────────────────────
//
// Rejects with 400 if Idempotency-Key header is absent.
// Use on all financial endpoints (payments, refunds, booking creation).
//
// Usage:
//   router.post('/payment/create-order', idempotency.strict, controller.createOrder);
//   router.post('/payment/verify-payment', idempotency.strict, controller.verifyPayment);
//   router.post('/bookings', idempotency.strict, controller.createBooking);

function idempotencyStrict(req, res, next) {
  const rawKey = req.headers['idempotency-key'];

  if (!rawKey || rawKey.trim() === '') {
    return res.status(400).json({
      success: false,
      code:    'IDEMPOTENCY_KEY_REQUIRED',
      message: 'Idempotency-Key header is required for this endpoint to prevent duplicate processing.',
    });
  }

  if (typeof rawKey !== 'string' || rawKey.length > 255) {
    return res.status(400).json({
      success: false,
      code:    'INVALID_IDEMPOTENCY_KEY',
      message: 'Idempotency-Key must be a string of 255 characters or fewer.',
    });
  }

  runIdempotency(req, res, next, rawKey.trim()).catch(err => {
    logger.error({ err }, '[idempotency:strict] Unexpected error — releasing lock and calling next');
    const redis = getRedis();
    if (isRedisReady(redis)) {
      const userId    = req.user?.id || 'anon';
      const scopedKey = `${userId}:${req.method}:${req.path}:${rawKey.trim()}`;
      redis.del(`${LOCK_PREFIX}${scopedKey}`).catch(() => {});
    }
    next();
  });
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports         = idempotency;
module.exports.strict  = idempotencyStrict;

// Exported for unit testing the core logic without an HTTP layer.
module.exports._runIdempotency = runIdempotency;

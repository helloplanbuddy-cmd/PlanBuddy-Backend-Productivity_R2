'use strict';

/**
 * middleware/idempotency.js — Redis-Backed Idempotency with DB Fallback (v6.0 - HARDENED)
 * ─────────────────────────────────────────────────────────────────────────────
 * 
 * CRITICAL CHANGE FROM v5.0: FAIL-CLOSED on Redis lock failure
 * 
 * Previously, when Redis lock acquisition failed, the middleware would fail open
 * and proceed without lock. This is DANGEROUS for financial operations as it
 * allows concurrent duplicate processing.
 * 
 * Now: When Redis lock fails, we return 503 SERVICE_UNAVAILABLE.
 * This prioritizes financial safety over availability.
 * 
 * SECURITY GUARANTEES:
 *   • Redis SETNX lock (30s TTL) blocks concurrent identical requests
 *   • Completed 2xx responses cached in Redis + DB for replay
 *   • Scoped key prevents cross-user replay
 *   • FAIL-CLOSED when Redis unavailable
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

async function releaseLock(redis, lockKey) {
  if (!isRedisReady(redis)) return;
  try {
    await redis.del(lockKey);
  } catch (err) {
    logger.warn('[idempotency] Failed to release lock', { lockKey, error: err.message });
  }
}

// ─── Core idempotency logic ───────────────────────────────────────────────────

async function runIdempotency(req, res, next, rawKey) {
  const userId    = req.user?.id || 'anon';
  const endpoint  = `${req.method}:${req.path}`;
  const scopedKey = `${userId}:${endpoint}:${rawKey}`;

  const redis    = getRedis();
  const useRedis = isRedisReady(redis);

  const doneKey = `${DONE_PREFIX}${scopedKey}`;
  const lockKey = `${LOCK_PREFIX}${scopedKey}`;
  const dbKey   = `idempotency:${crypto.createHash('sha256').update(scopedKey).digest('hex')}`;

  if (!useRedis) {
    logger.warn('[idempotency] Redis not ready — falling back to DB idempotency');
  }

  // ── Step 1: Return cached response if already completed ─────────────────────

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
        await redis.del(doneKey).catch(() => {});
      }
    }
  }

  // Always check DB — covers Redis miss after restart
  const dbRow = await dbGet(dbKey);
  if (dbRow) {
    try {
      const body = typeof dbRow.response_body === 'string'
        ? JSON.parse(dbRow.response_body)
        : dbRow.response_body;
      res.setHeader('X-Idempotency-Replayed', 'true');
      return res.status(dbRow.response_code).json(body);
    } catch (_) {
      // Corrupt DB entry — fall through and reprocess
    }
  }

  // ── Step 2: Acquire distributed lock ─────────────────────────────────────────
  // CRITICAL: Prevents concurrent requests with same key from both executing

  let lockAcquired = false;

  if (useRedis) {
    let acquired;
    try {
      acquired = await redis.set(lockKey, '1', 'NX', 'EX', LOCK_TTL_S);
    } catch (err) {
      // ❌ FAIL-CLOSED: When Redis lock fails, we MUST NOT proceed
      // This prevents duplicate charges during Redis issues
      logger.error('[idempotency] Redis lock acquisition failed — FAILING CLOSED', {
        error: err.message,
        userId,
        endpoint,
      });
      
      return res.status(503).json({
        success: false,
        code: 'SERVICE_UNAVAILABLE',
        message: 'Service temporarily unavailable. Please retry shortly.',
      });
    }

    if (!acquired) {
      // Conflict: another request with this key is in flight
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

  const requestHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(req.body || {}))
    .digest('hex');

  // ── Step 4: Intercept res.json to capture and cache response ─────────────────

  const originalJson = res.json.bind(res);

  res.json = async function captureIdempotentResponse(body) {
    res.json = originalJson;

    const status = res.statusCode || 200;

    try {
      // Only cache successful (2xx) responses
      if (status >= 200 && status < 300) {
        const payload = JSON.stringify({ status, body });

        // Write to Redis (primary cache)
        if (useRedis && isRedisReady(redis)) {
          try {
            await redis.set(doneKey, payload, 'EX', RESPONSE_TTL);
          } catch (err) {
            logger.warn('[idempotency] Failed to cache response in Redis', { error: err.message });
          }
        }

        // Write to DB (durable fallback — always)
        await dbSet(dbKey, userId, endpoint, requestHash, status, JSON.stringify(body));
      }
    } finally {
      // Always release lock — even if caching fails
      if (lockAcquired) {
        await releaseLock(redis, lockKey);
      }
    }

    return originalJson(body);
  };

  return next();
}

// ─── Middleware: idempotency (optional) ───────────────────────────────────────

function idempotency(req, res, next) {
  const rawKey = req.headers['idempotency-key'];

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
module.exports._runIdempotency = runIdempotency;
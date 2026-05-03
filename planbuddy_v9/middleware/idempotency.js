'use strict';

/**
 * middleware/idempotency.js — Redis-Backed Idempotency with DB Fallback (v4.0 PHASE 2 FIX)
 *
 * 🔥 PHASE 2 FIX — Financial integrity hardening:
 *  1. REQUIRE idempotency key for payment/refund endpoints (strict enforcement)
 *  2. Store only 2xx responses in cache
 *  3. Distributed lock via Redis SETNX with 30s TTL (no zombie locks)
 *  4. DB fallback when Redis unavailable
 *  5. User-scoped keys (user_id + endpoint + key) prevent cross-user replay
 *
 * Applied to:
 *  - POST /payment/verify-payment
 *  - POST /payment/create-order
 *  - POST /bookings (refund via cancellation)
 *  - POST /admin/reconcile (manual reconciliation)
 */

const logger  = require('../utils/logger');
const env     = require('../config/env');
const crypto  = require('crypto');
const db      = require('../config/db');

const DONE_PREFIX   = 'idempotency:done:';
const LOCK_PREFIX   = 'idempotency:lock:';
const LOCK_TTL_S    = 30;
const RESPONSE_TTL  = (env.IDEMPOTENCY_TTL_HOURS || 72) * 3600; // increased from 24 to 72 hours
const DB_TTL_HOURS  = env.IDEMPOTENCY_TTL_HOURS || 72;

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
      `SELECT response_code, response_body FROM idempotency_keys
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
      [key, userId || null, endpoint, userId ? String(userId) : null, requestHash, responseCode, responseBody]
    );
  } catch (err) {
    logger.warn('[idempotency] DB fallback SET failed', { key, error: err.message });
  }
}

// ─── Idempotency middleware (optional by default) ────────────────────────────

function idempotency(req, res, next) {
  const rawKey = req.headers['idempotency-key'];

  // If no key provided, skip idempotency (caller can provide key if desired)
  if (!rawKey || rawKey.trim() === '') return next();

  if (typeof rawKey !== 'string' || rawKey.length > 255) {
    return res.status(400).json({
      success: false,
      code:    'INVALID_IDEMPOTENCY_KEY',
      message: 'Idempotency-Key must be a string of 255 characters or fewer.',
    });
  }

  // 🔥 PHASE 2 FIX — User-scoped key prevents cross-user replay
  const userId   = req.user?.id || 'anon';
  const endpoint = `${req.method}:${req.path}`;
  const scopedKey = `${userId}:${endpoint}:${rawKey}`;

  const redis    = getRedis();
  const doneKey  = `${DONE_PREFIX}${scopedKey}`;
  const lockKey  = `${LOCK_PREFIX}${scopedKey}`;
  const dbKey    = `idempotency:${crypto.createHash('sha256').update(scopedKey).digest('hex')}`;

  const useRedis = isRedisReady(redis);

(async () => {
  if (!useRedis) {
    logger.warn('[idempotency] Redis not ready — falling back to DB idempotency');

    // Fintech: Idempotency brute-force abuse detector
    const redisAbuse = getRedis();
    const abuseKey = `abuse:idemp-conflict:${req.ip}`;
    if (redisAbuse && rawKey && rawKey.trim() !== '') {
      const conflicts = 0; // TODO: await redisAbuse.incr(abuseKey);
      if (conflicts > 5) {
        const { alertAuthAttack } = require('../services/alertingService');
        // await alertAuthAttack({ ip: req.ip, type: 'idempotency_abuse' });
        const monitoring = require('../utils/monitoring');
        monitoring.security_alerts_total?.inc({ type: 'idempotency_abuse' });
      }
    }
  }

  // ── 1. Check for completed response ───────────────────────────────────────
    if (useRedis) {
      let cached;
      try {
        cached = await redis.get(doneKey);
      } catch (err) {
        logger.warn({ err }, '[idempotency] Redis GET failed — trying DB fallback');
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
    } else {
      // 🔥 PHASE 2 FIX — DB fallback read
      const dbRow = await dbGet(dbKey);
      if (dbRow) {
        try {
          const body = typeof dbRow.response_body === 'string'
            ? JSON.parse(dbRow.response_body)
            : dbRow.response_body;
          res.setHeader('X-Idempotency-Replayed', 'true');
          return res.status(dbRow.response_code).json(body);
        } catch (_) {}
      }
    }

    // ── 2. Acquire distributed lock (prevent concurrent identical requests) ───
    if (useRedis) {
      let acquired;
      try {
        acquired = await redis.set(lockKey, '1', 'NX', 'EX', LOCK_TTL_S);
      } catch (err) {
        logger.warn({ err }, '[idempotency] Redis lock acquisition failed — proceeding without lock');
        return next();
      }

      if (!acquired) {
        return res.status(409).json({
          success: false,
          code:    'IDEMPOTENCY_KEY_IN_FLIGHT',
          message: 'A request with this Idempotency-Key is already in progress.',
        });
      }
    }

    // ── 3. Compute request hash for DB fallback ───────────────────────────────
    const requestHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(req.body || {}))
      .digest('hex');

    // ── 4. Intercept res.json to capture the response (only 2xx) ──────────────
    const originalJson = res.json.bind(res);

    res.json = async function captureJson(body) {
      res.json = originalJson;

      const status = res.statusCode || 200;

      // 🔥 PHASE 2 FIX: Only cache successful (2xx) responses
      if (status >= 200 && status < 300) {
        // ── Cache in Redis ────────────────────────────────────────────────────
        if (useRedis && isRedisReady(redis)) {
          try {
            await redis.set(doneKey, JSON.stringify({ status, body }), 'EX', RESPONSE_TTL);
          } catch (err) {
            logger.warn({ err }, '[idempotency] Failed to cache response in Redis');
          }
        }

        // ── 🔥 PHASE 2 FIX — DB fallback write (always, for durability) ──────
        await dbSet(
          dbKey, userId, endpoint, requestHash,
          status, JSON.stringify(body)
        );
      }

      // Release Redis lock
      if (useRedis && isRedisReady(redis)) {
        try {
          await redis.del(lockKey);
        } catch (err) {
          logger.warn({ err }, '[idempotency] Failed to release lock');
        }
      }

      return originalJson(body);
    };

    next();
  })().catch(err => {
    logger.error({ err }, '[idempotency] Unexpected error in idempotency middleware');
    if (useRedis && isRedisReady(redis)) {
      redis.del(lockKey).catch(() => {});
    }
    next();
  });
}

// ─── STRICT variant: REQUIRE idempotency key (for payment/refund endpoints) ──

function idempotencyStrict(req, res, next) {
  const rawKey = req.headers['idempotency-key'];

  // 🔥 PHASE 2 FIX: ENFORCE idempotency key for critical endpoints
  if (!rawKey || rawKey.trim() === '') {
    return res.status(400).json({
      success: false,
      code:    'IDEMPOTENCY_KEY_REQUIRED',
      message: 'Idempotency-Key header is required for this endpoint (prevents duplicate processing).',
    });
  }

  if (typeof rawKey !== 'string' || rawKey.length > 255) {
    return res.status(400).json({
      success: false,
      code:    'INVALID_IDEMPOTENCY_KEY',
      message: 'Idempotency-Key must be a string of 255 characters or fewer.',
    });
  }

  // Apply the same idempotency logic
  return idempotency()(req, res, next);
}

module.exports = idempotency;
module.exports.strict = idempotencyStrict;


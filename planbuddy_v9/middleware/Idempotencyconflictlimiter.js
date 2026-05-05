'use strict';

/**
 * middleware/idempotencyConflictLimiter.js
 * ─────────────────────────────────────────────────────────────────────────────
 * ROLE IN THE ARCHITECTURE
 *
 * This module has TWO public surfaces that work together:
 *
 *   1. trackConflict(ip, redis)          ← pure function, called internally by
 *                                           idempotency.js on every 409 conflict.
 *                                           No route wiring needed.
 *
 *   2. conflictLimiter()                 ← Express middleware factory.
 *      idempotencyConflictLimiter        ← default export (same thing).
 *                                           Mount ONLY if you want a standalone
 *                                           HTTP-layer rate-limit gate BEFORE
 *                                           the idempotency middleware runs.
 *                                           Most routes do NOT need this — the
 *                                           trackConflict() integration inside
 *                                           idempotency.js is sufficient.
 *
 * WHY SPLIT THIS WAY (Option A — Centralised Enforcement)
 *
 *   Problem with the original code:
 *     • Abuse detection was a dead TODO stub inside idempotency.js.
 *     • No route could pair conflict limiting with idempotency reliably.
 *     • Developers would forget to mount both middlewares, creating gaps.
 *
 *   Solution:
 *     • idempotency.js calls trackConflict() directly on every 409.
 *       Conflict counting is therefore automatic and cannot be forgotten.
 *     • conflictLimiter() remains available for routes that want an explicit
 *       pre-flight block (e.g., public webhooks with no auth middleware).
 *
 * REDIS KEY SCHEMA
 *   abuse:idemp-conflict:<ip>          sliding counter, TTL = WINDOW_S
 *   abuse:idemp-blocked:<ip>           block flag,     TTL = BLOCK_S
 *
 * THRESHOLDS (tunable via env)
 *   IDEMP_CONFLICT_LIMIT   max conflicts per WINDOW_S before block  (default 5)
 *   IDEMP_CONFLICT_WINDOW  window in seconds                        (default 60)
 *   IDEMP_BLOCK_DURATION   how long to block after threshold hit    (default 300)
 */

const logger     = require('../utils/logger');
const monitoring = require('../utils/monitoring');

// ─── Configuration ────────────────────────────────────────────────────────────

const CONFLICT_LIMIT   = parseInt(process.env.IDEMP_CONFLICT_LIMIT,  10) || 5;
const WINDOW_S         = parseInt(process.env.IDEMP_CONFLICT_WINDOW, 10) || 60;
const BLOCK_S          = parseInt(process.env.IDEMP_BLOCK_DURATION,  10) || 300;

const COUNTER_PREFIX   = 'abuse:idemp-conflict:';
const BLOCK_PREFIX     = 'abuse:idemp-blocked:';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getRedis() {
  try {
    return require('../config/redis').redis;
  } catch (_) {
    return null;
  }
}

function isRedisReady(r) {
  return r && r.status === 'ready';
}

// ─── Core: trackConflict ─────────────────────────────────────────────────────
//
// Called by idempotency.js every time a 409 IDEMPOTENCY_KEY_IN_FLIGHT is
// returned.  Increments the sliding counter and fires alerting if the
// threshold is exceeded.
//
// Returns:  { blocked: boolean, conflicts: number }
// On Redis failure: returns { blocked: false, conflicts: 0 } — fail open so
//   a Redis outage never blocks legitimate traffic.

async function trackConflict(ip, redis) {
  if (!isRedisReady(redis)) {
    return { blocked: false, conflicts: 0 };
  }

  const counterKey = `${COUNTER_PREFIX}${ip}`;
  const blockKey   = `${BLOCK_PREFIX}${ip}`;

  try {
    // Increment the conflict counter and set TTL on first write.
    const conflicts = await redis.incr(counterKey);
    if (conflicts === 1) {
      // First conflict in this window — arm the TTL.
      await redis.expire(counterKey, WINDOW_S);
    }

    if (conflicts >= CONFLICT_LIMIT) {
      // Arm block flag with its own TTL (survives counter expiry).
      await redis.set(blockKey, '1', 'EX', BLOCK_S);

      logger.warn('[idempotency-conflict] IP blocked for repeated conflicts', {
        ip,
        conflicts,
        limit:   CONFLICT_LIMIT,
        blockSec: BLOCK_S,
      });

      // Fire Prometheus metric (best-effort).
      monitoring.security_alerts_total?.inc({ type: 'idempotency_abuse' });

      // Fire alerting service (best-effort — never throw).
      try {
        const { alertAuthAttack } = require('../services/alertingService');
        await alertAuthAttack({ ip, type: 'idempotency_abuse', conflicts });
      } catch (_) {}

      return { blocked: true, conflicts };
    }

    return { blocked: false, conflicts };
  } catch (err) {
    logger.warn('[idempotency-conflict] trackConflict Redis error — skipping', {
      ip,
      error: err.message,
    });
    return { blocked: false, conflicts: 0 };
  }
}

// ─── isBlocked ───────────────────────────────────────────────────────────────
//
// Synchronous-style check used by conflictLimiter() middleware.
// Returns true if the IP is currently in the block window.

async function isBlocked(ip, redis) {
  if (!isRedisReady(redis)) return false;
  try {
    const val = await redis.get(`${BLOCK_PREFIX}${ip}`);
    return val === '1';
  } catch (_) {
    return false; // fail open
  }
}

// ─── Express middleware factory ───────────────────────────────────────────────
//
// Mount this BEFORE idempotency middleware on routes where you want a hard
// HTTP-layer block for already-flagged IPs.  For most routes the automatic
// trackConflict() integration in idempotency.js is sufficient.
//
// Usage (optional, route-level):
//   router.post('/payment/create-order',
//     conflictLimiter(),        // pre-flight block check
//     idempotency.strict,       // idempotency + built-in conflict tracking
//     paymentController.createOrder
//   );

function conflictLimiter() {
  return async function idempotencyConflictLimiterMiddleware(req, res, next) {
    const redis = getRedis();

    if (!isRedisReady(redis)) {
      // Redis down — skip limiter entirely, don't block traffic.
      return next();
    }

    const ip = req.ip || req.connection?.remoteAddress || 'unknown';

    try {
      const blocked = await isBlocked(ip, redis);

      if (blocked) {
        logger.warn('[idempotency-conflict] Blocked IP attempted request', {
          ip,
          path:   req.path,
          method: req.method,
        });

        monitoring.security_alerts_total?.inc({ type: 'idempotency_blocked_ip' });

        return res.status(429).json({
          success:    false,
          code:       'IDEMPOTENCY_ABUSE_BLOCKED',
          message:    'Too many duplicate request conflicts. Please wait before retrying.',
          retryAfter: BLOCK_S,
        });
      }
    } catch (err) {
      // Never block traffic on unexpected errors.
      logger.warn('[idempotency-conflict] isBlocked check failed — allowing request', {
        error: err.message,
      });
    }

    return next();
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

// Default export: the Express middleware factory (backward-compatible).
module.exports = conflictLimiter;

// Named exports for use inside idempotency.js and tests.
module.exports.conflictLimiter = conflictLimiter;
module.exports.trackConflict   = trackConflict;
module.exports.isBlocked       = isBlocked;
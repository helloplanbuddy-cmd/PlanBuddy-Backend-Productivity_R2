'use strict';

/**
 * middleware/rateLimit.js — Redis-Backed Rate Limiting (v4.0)
 *
 * UPGRADE from v3.0:
 *  - FAIL-CLOSED policy for critical endpoints (auth, payment, webhook).
 *    If Redis is unavailable, these limiters return 503 Service Unavailable
 *    instead of silently falling back to per-process MemoryStore.
 *    Rationale: an attacker who can force Redis down should NOT gain unlimited
 *    login attempts or payment retries — that is a security control bypass.
 *
 *  - Non-critical endpoints (booking, admin) remain fail-open (MemoryStore
 *    fallback) because availability matters more than perfect enforcement.
 *
 * Limiter inventory:
 *  ┌──────────────────────────┬──────────────────────────┬────────────────┐
 *  │ Limiter                  │ Threshold                │ Fail policy    │
 *  ├──────────────────────────┼──────────────────────────┼────────────────┤
 *  │ globalLimiter            │ 500 req / 15 min / IP    │ open (MemStore)│
 *  │ authLimiter              │  20 req / 15 min / IP    │ CLOSED → 503   │
 *  │ bookingLimiter           │  10 req /  1 min / user  │ open (MemStore)│
 *  │ verifyPaymentLimiter     │  10 req /  1 min / user  │ CLOSED → 503   │
 *  │ webhookLimiter           │ 100 req /  1 min / IP    │ CLOSED → 503   │
 *  │ adminLimiter             │ 100 req / 15 min / user  │ open (MemStore)│
 *  │ idempotencyConflictLimtr │   3 req /  5 min / IP    │ open (MemStore)│
 *  └──────────────────────────┴──────────────────────────┴────────────────┘
 */

const rateLimit = require('express-rate-limit');
const logger    = require('../utils/logger');
const monitoring = require('../utils/monitoring');

// ─── Redis store adapter ──────────────────────────────────────────────────────

/**
 * Build a RedisStore for the given prefix.
 * Returns undefined if Redis client or adapter is not available,
 * causing express-rate-limit to fall back to MemoryStore.
 *
 * @param {string} prefix
 * @returns {object|undefined}
 */
function makeRedisStore(prefix) {
  try {
    const { RedisStore } = require('rate-limit-redis');
    const { redis }      = require('../config/redis');

    return new RedisStore({
      prefix,
      sendCommand: (...args) => redis.call(...args),
    });
  } catch (err) {
    logger.error(
      { service: 'rateLimit', err: err.message },
      '[rateLimit] WARN: Could not create RedisStore — non-critical limiters will use MemoryStore'
    );
    monitoring.security_alerts_total?.inc({ type: 'rate_limit_store_fallback' });
    return undefined; // Non-critical: fall back to MemoryStore
  }
}

// ─── Redis health check (synchronous status read) ─────────────────────────────

/**
 * Check whether the Redis cache client is in a usable state.
 * ioredis exposes `.status` as a synchronous property — no await needed.
 * Possible statuses: 'connecting' | 'connect' | 'ready' | 'close' | 'end'
 *
 * @returns {boolean}
 */
function isRedisReady() {
  try {
    const { redis } = require('../config/redis');
    return redis.status === 'ready';
  } catch {
    return false;
  }
}

// ─── Key generators ───────────────────────────────────────────────────────────

const ipKey   = (req) => req.ip;
const userKey = (req) => req.user?.id || req.ip;

// ─── Rate-limit exceeded handler ──────────────────────────────────────────────

function onLimitExceeded(req, res, windowMs, limiterName) {
  logger.warn({
    requestId: req.requestId,
    ip:        req.ip,
    userId:    req.user?.id,
    path:      req.path,
    limiter:   limiterName,
  }, '[rateLimit] Rate limit exceeded');

  monitoring.request_total?.inc({ method: req.method, path: 'rate_limited' });

  return res.status(429).json({
    success:    false,
    message:    'Too many requests. Please try again later.',
    code:       'RATE_LIMIT_EXCEEDED',
    retryAfter: Math.ceil(windowMs / 1000),
  });
}

// ─── Limiter factory ──────────────────────────────────────────────────────────

/**
 * Create a rate limiter middleware.
 *
 * @param {object}   options
 * @param {string}   options.name          - Limiter name (used for metrics/logs)
 * @param {number}   options.windowMs      - Rate window in milliseconds
 * @param {number}   options.max           - Max requests per window
 * @param {Function} [options.keyGenerator] - Key function (default: IP)
 * @param {boolean}  [options.failClosed]  - If true: 503 when Redis is down
 *                                           If false: MemoryStore fallback (default)
 */
function makeLimiter({ name, windowMs, max, keyGenerator = ipKey, failClosed = false }) {
  const store = makeRedisStore(`rl:${name}:`);

  const limiter = rateLimit({
    windowMs,
    max,
    keyGenerator,
    standardHeaders: true,
    legacyHeaders:   false,
    store,           // undefined → MemoryStore (only for fail-open limiters)
    handler(req, res) {
      return onLimitExceeded(req, res, windowMs, name);
    },
    skip(req) {
      return req.path.startsWith('/api/health') || req.path === '/';
    },
  });

  if (!failClosed) {
    // Fail-open: just return the limiter directly.
    return limiter;
  }

  // ── Fail-closed wrapper ────────────────────────────────────────────────────
  // For auth/payment/webhook endpoints: if Redis is unavailable, return 503.
  // This prevents brute-force attacks during Redis downtime.
  // Attackers who deliberately take down Redis should not gain unlimited attempts.
  return function failClosedMiddleware(req, res, next) {
    // Skip fail-closed check for health probes
    if (req.path.startsWith('/api/health') || req.path === '/') {
      return next();
    }

    if (!isRedisReady()) {
      logger.error({
        limiter:     name,
        redisStatus: (() => { try { const { redis } = require('../config/redis'); return redis.status; } catch { return 'unavailable'; } })(),
        ip:          req.ip,
        path:        req.path,
        requestId:   req.requestId,
      }, `[rateLimit] FAIL-CLOSED: Redis unavailable — blocking critical endpoint "${name}"`);

      monitoring.security_alerts_total?.inc({ type: 'rate_limit_fail_closed_triggered' });

      return res.status(503).json({
        success:    false,
        code:       'SERVICE_UNAVAILABLE',
        message:    'Service temporarily unavailable. Please retry in a moment.',
        retryAfter: 30,
      });
    }

    return limiter(req, res, next);
  };
}

// ─── Limiter instances ────────────────────────────────────────────────────────

/** Global limiter — all /api/* routes. Fail-open (availability > enforcement). */
const globalLimiter = makeLimiter({
  name:      'global',
  windowMs:  15 * 60 * 1000,
  max:       500,
  keyGenerator: ipKey,
  failClosed: false,
});

/**
 * Auth limiter — login, register, OTP verification.
 * FAIL-CLOSED: Redis down → 503. Brute-force protection must not be bypassed.
 */
const authLimiter = makeLimiter({
  name:      'auth',
  windowMs:  15 * 60 * 1000,
  max:       20,
  keyGenerator: ipKey,
  failClosed: true,   // ← SECURITY: fail closed
});

/** Booking limiter — booking creation. Fail-open (availability preferred). */
const bookingLimiter = makeLimiter({
  name:      'booking',
  windowMs:  60 * 1000,
  max:       10,
  keyGenerator: userKey,
  failClosed: false,
});

/**
 * Payment verify limiter — POST /payment/verify-payment.
 * FAIL-CLOSED: Redis down → 503. Payment endpoint must enforce per-user limits.
 */
const verifyPaymentLimiter = makeLimiter({
  name:      'verify-payment',
  windowMs:  60 * 1000,
  max:       10,
  keyGenerator: userKey,
  failClosed: true,   // ← SECURITY: fail closed
});

/**
 * Webhook limiter — Razorpay webhook endpoint.
 * FAIL-CLOSED: Redis down → 503.
 * Webhook endpoint is a high-value target for replay attacks.
 */
const webhookLimiter = makeLimiter({
  name:      'webhook',
  windowMs:  60 * 1000,
  max:       100,
  keyGenerator: ipKey,
  failClosed: true,   // ← SECURITY: fail closed
});

/** Admin limiter — dashboard + export. Fail-open (admin downtime is worse than imperfect limiting). */
const adminLimiter = makeLimiter({
  name:      'admin',
  windowMs:  15 * 60 * 1000,
  max:       100,
  keyGenerator: userKey,
  failClosed: false,
});

const adminReconcile = adminLimiter;

/** Idempotency conflict limiter — fintech abuse: repeated conflicting keys. Fail-open. */
const idempotencyConflictLimiter = makeLimiter({
  name:      'idempotency_conflict',
  windowMs:  5 * 60 * 1000,
  max:       3,
  keyGenerator: (req) => req.ip,
  failClosed: false,
});

module.exports = {
  globalLimiter,
  authLimiter,
  bookingLimiter,
  verifyPaymentLimiter,
  webhookLimiter,
  adminLimiter,
  adminReconcile,
  idempotencyConflictLimiter,
};

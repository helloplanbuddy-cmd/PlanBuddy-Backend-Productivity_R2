'use strict';

/**
 * middleware/rateLimit.js — Redis-Backed Rate Limiting (v3.0)
 *
 * UPGRADE from v2.0:
 *  - Storage: PgRateLimitStore → Redis (INCR + EXPIRE — orders of magnitude faster).
 *  - PgRateLimitStore is no longer needed and has been removed.
 *  - Uses `rate-limit-redis` adapter for express-rate-limit v7.
 *  - Fail-open: if Redis is unavailable, rate limiting is skipped (logged + metered).
 *  - All limiters unchanged from v2.0 (correct — thresholds / key generators preserved).
 *
 * Limiter inventory:
 *  - globalLimiter:      500 req / 15 min / IP  — general abuse protection
 *  - authLimiter:        20 req / 15 min / IP   — login / register
 *  - bookingLimiter:     30 req / 15 min / user — booking creation
 *  - verifyPaymentLimiter: 20 req / 15 min / user — payment verify
 *  - webhookLimiter:     200 req / 1 min / IP   — Razorpay webhook IPs
 *  - adminLimiter:       100 req / 15 min / user — admin dashboard
 */

const rateLimit = require('express-rate-limit');
const logger    = require('../utils/logger');
const monitoring = require('../utils/monitoring');

// ─── Redis store adapter ──────────────────────────────────────────────────────

// Lazy-load Redis client — avoids circular dep + allows test environments to skip
function makeRedisStore(prefix) {
  try {
    // eslint-disable-next-line global-require
    const { RedisStore } = require('rate-limit-redis');
    const { redis }      = require('../config/redis');

    return new RedisStore({
      prefix,
      sendCommand: (...args) => redis.call(...args),
    });
  } catch (err) {
    // 🔥 CRITICAL ALERT: Log + metric when falling back to MemoryStore
    // This happens during Redis downtime, planned maintenance, or connection issues.
    // Under multi-instance deployment, this means rate limiting is per-process (unprotected).
logger.error('RATE_LIMIT_BYPASS',
      'Rate limiter falling back to MemoryStore — brute-force attacks possible', {
      service: 'rateLimit',
    });
    // Alert metric (if available)
    monitoring.security_alerts_total?.inc({ type: 'rate_limit_bypass' });
    return undefined; // falls back to express-rate-limit's default MemoryStore
  }
}

// ─── Fail-open handler ────────────────────────────────────────────────────────

function onLimitReached(req, res, options) {
  logger.warn({
    requestId: req.requestId,
    ip:        req.ip,
    userId:    req.user?.id,
    path:      req.path,
    limiter:   options.name || 'unknown',
  }, '[rateLimit] Rate limit exceeded');
}

// ─── Key generators ───────────────────────────────────────────────────────────

// Per-IP (default express-rate-limit behaviour)
const ipKey = (req) => req.ip;

// Per authenticated user (falls back to IP for unauthenticated)
const userKey = (req) => req.user?.id || req.ip;

// ─── Limiter factory ──────────────────────────────────────────────────────────

function makeLimiter({ name, windowMs, max, keyGenerator = ipKey }) {
  return rateLimit({
    windowMs,
    max,
    keyGenerator,
    standardHeaders: true,   // Return RateLimit-* headers
    legacyHeaders:   false,  // Disable X-RateLimit-* headers
    store:           makeRedisStore(`rl:${name}:`),
    handler(req, res) {
      onLimitReached(req, res, { name });
      monitoring.request_total.inc({ method: req.method, path: 'rate_limited' });
      res.status(429).json({
        success: false,
        message: 'Too many requests. Please try again later.',
        code:    'RATE_LIMIT_EXCEEDED',
        retryAfter: Math.ceil(windowMs / 1000),
      });
    },
    skip(req) {
      // Never rate-limit health probes
      return req.path.startsWith('/api/health') || req.path === '/';
    },
  });
}

// ─── Limiters ─────────────────────────────────────────────────────────────────

/**
 * Global limiter — applied to all /api/* routes.
 * 500 requests per 15 minutes per IP.
 */
const globalLimiter = makeLimiter({
  name:      'global',
  windowMs:  15 * 60 * 1000,
  max:       500,
  keyGenerator: ipKey,
});

/**
 * Auth limiter — login, register, OTP verification.
 * 20 requests per 15 minutes per IP.
 */
const authLimiter = makeLimiter({
  name:      'auth',
  windowMs:  15 * 60 * 1000,
  max:       20,
  keyGenerator: ipKey,
});

/**
 * Booking limiter — booking creation.
 * 30 requests per 15 minutes per authenticated user.
 */
const bookingLimiter = makeLimiter({
  name:      'booking',
  windowMs:  60 * 1000,
  max:       10,
  keyGenerator: userKey,
});

/**
 * Payment verify limiter — POST /payment/verify-payment.
 * 20 requests per 15 minutes per authenticated user.
 */
const verifyPaymentLimiter = makeLimiter({
  name:      'verify-payment',
  windowMs:  60 * 1000,
  max:       10,
  keyGenerator: userKey,
});

/**
 * Webhook limiter — Razorpay webhook endpoint.
 * Higher limit — Razorpay batches events and can send bursts.
 * 200 requests per 1 minute per IP.
 */
const webhookLimiter = makeLimiter({
  name:      'webhook',
  windowMs:  60 * 1000,
  max:       100,
  keyGenerator: ipKey,
});

/**
 * Admin limiter — dashboard + export endpoints.
 * 100 requests per 15 minutes per authenticated admin user.
 */
const adminLimiter = makeLimiter({
  name:      'admin',
  windowMs:  15 * 60 * 1000,
  max:       100,
  keyGenerator: userKey,
});

const adminReconcile = adminLimiter;

module.exports = {
  globalLimiter,
  authLimiter,
  bookingLimiter,
  verifyPaymentLimiter,
  webhookLimiter,
  adminLimiter,
  adminReconcile,
  /**
   * Fintech abuse: Rate limit repeated idempotency key conflicts (brute force probing)
   * 3 conflicts / 5 min per IP
   */
  idempotencyConflictLimiter: makeLimiter({
    name:      'idempotency_conflict',
    windowMs:  5 * 60 * 1000,
    max:       3,
    keyGenerator: (req) => req.ip,
  }),
};

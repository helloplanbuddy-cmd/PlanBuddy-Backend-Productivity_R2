'use strict';

/**
 * middleware/index.js — Authentication + RBAC Middleware (v3.0)
 *
 * FIXES from v2.0:
 *  1. RISK-004 FIX: isRevoked() now uses Redis cache first (O(1)), DB fallback.
 *     Redis client injected to avoid circular dependency at load time.
 *  2. RISK-007 FIX: is_active check added per request, cached in Redis for 60s.
 *     Deactivated user's valid tokens are rejected within 60 seconds.
 *  3. RISK-001 SUPPORT: Tokens issued before password_changed_at are rejected.
 *     This closes the session-survival-after-password-reset gap.
 *  4. requireRole() unchanged — already correct.
 */

const { verifyToken, isRevoked } = require('../utils/jwt');
const db      = require('../config/db');
const logger  = require('../utils/logger');
const env     = require('../config/env');
// 🚀 PHASE 2B: Update trace context with user_id after successful auth
const { updateTraceContext } = require('./traceId');

// Lazy-loaded to avoid circular dependency at module load time
function getRedis() {
  return require('../config/redis').redis;
}

// ─── User active-status cache ─────────────────────────────────────────────────

const USER_ACTIVE_PREFIX = 'user:active:';
const USER_ACTIVE_TTL    = env.REDIS_USER_ACTIVE_TTL; // seconds

/**
 * Check if a user is still active.
 * Result is cached in Redis to avoid a DB hit on every request.
 * Cache is invalidated when an admin deactivates the user.
 *
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
async function isUserActive(userId) {
  const redis = getRedis();

  // ── Redis cache ──────────────────────────────────────────────────────────
  if (redis) {
    try {
      const cached = await redis.get(`${USER_ACTIVE_PREFIX}${userId}`);
      if (cached !== null) return cached === '1';
    } catch (_) { /* non-fatal — fall through to DB */ }
  }

  // ── DB fallback ──────────────────────────────────────────────────────────
  try {
    const result = await db.query(
      `SELECT is_active, password_changed_at FROM users WHERE id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      // User deleted — treat as inactive
      return false;
    }

    const { is_active } = result.rows[0];

    // Populate Redis cache
    if (redis) {
      redis
        .set(`${USER_ACTIVE_PREFIX}${userId}`, is_active ? '1' : '0', 'EX', USER_ACTIVE_TTL)
        .catch(() => {});
    }

    return Boolean(is_active);
  } catch (err) {
    logger.error({ err }, '[auth] isUserActive: DB query failed — fail-open');
    return true; // fail-open: don't lock out users on DB error
  }
}

/**
 * Check if the token was issued before the user's password was last changed.
 * Handles RISK-001: password reset must invalidate all prior sessions.
 *
 * @param {string} userId
 * @param {number} tokenIat - token issued-at (seconds, from JWT payload)
 * @returns {Promise<boolean>} true if token predates the last password change
 */
async function isTokenBeforePasswordChange(userId, tokenIat) {
  try {
    const result = await db.query(
      `SELECT password_changed_at FROM users WHERE id = $1`,
      [userId]
    );

    if (result.rows.length === 0) return false;

    const { password_changed_at } = result.rows[0];
    if (!password_changed_at) return false;

    // Token iat is in seconds; password_changed_at is a Date
    const changedAtMs = new Date(password_changed_at).getTime();
    const tokenIatMs  = tokenIat * 1000;

    return tokenIatMs < changedAtMs;
  } catch (err) {
    logger.error({ err }, '[auth] isTokenBeforePasswordChange: DB query failed — fail-open');
    return false;
  }
}

// ─── authenticate ─────────────────────────────────────────────────────────────

/**
 * authenticate — Verifies Bearer JWT and populates req.user.
 *
 * Checks (in order):
 *  1. Bearer token present
 *  2. JWT signature + expiry valid
 *  3. Token not in revocation blacklist (Redis → DB)
 *  4. Token not issued before password_changed_at (RISK-001)
 *  5. User account is still active (RISK-007)
 */
async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      message: 'Authentication required. Provide a Bearer token.',
      code:    'AUTH_REQUIRED',
    });
  }

  const token = authHeader.slice(7);

  try {
    const decoded = verifyToken(token);
    const userId  = decoded.sub;
    const redis   = getRedis();

    // ── 3. JTI revocation check (Redis-cached) ────────────────────────────
    if (decoded.jti) {
      const revoked = await isRevoked(decoded.jti, db, redis);
      if (revoked) {
        return res.status(401).json({
          success: false,
          message: 'Token has been revoked. Please log in again.',
          code:    'TOKEN_REVOKED',
        });
      }
    }

    // ── 4. Password-change session invalidation (RISK-001) ────────────────
    if (decoded.iat) {
      const stale = await isTokenBeforePasswordChange(userId, decoded.iat);
      if (stale) {
        return res.status(401).json({
          success: false,
          message: 'Session expired due to a recent password change. Please log in again.',
          code:    'TOKEN_STALE',
        });
      }
    }

    // ── 5. User active check (RISK-007, Redis-cached 60s) ─────────────────
    const active = await isUserActive(userId);
    if (!active) {
      return res.status(403).json({
        success: false,
        message: 'Account is deactivated. Contact support.',
        code:    'ACCOUNT_DEACTIVATED',
      });
    }

    // ── Populate req.user ─────────────────────────────────────────────────
    req.user = {
      id:    userId,
      role:  decoded.role,
      jti:   decoded.jti,
    };

    // Attach request-scoped logger (consumed by asyncHandler + controllers)
    req.log = logger.child({
      requestId: req.requestId,
      userId,
      role:      decoded.role,
    });

    // 🚀 PHASE 2B: Propagate user_id into AsyncLocalStorage trace context
    // so all subsequent logger calls in this request include user_id automatically
    updateTraceContext({ user_id: userId });

    next();
  } catch (err) {
    logger.warn({
      requestId: req.requestId,
      path:      req.path,
      errName:   err.name,
      err:       env.IS_PROD ? undefined : err,
    }, '[auth] JWT verification failed');

    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token has expired. Please log in again.',
        code:    'TOKEN_EXPIRED',
      });
    }

    return res.status(401).json({
      success: false,
      message: 'Invalid token.',
      code:    'INVALID_TOKEN',
    });
  }
}

// ─── requireRole ──────────────────────────────────────────────────────────────

/**
 * Role-based access control middleware factory.
 *
 * Usage:
 *   router.delete('/trips/:id', authenticate, requireRole('admin', 'agency'), ctrl)
 *
 * @param {...string} roles
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Authentication required.' });
    }
    if (!roles.includes(req.user.role)) {
      logger.warn({
        requestId: req.requestId,
        userId:    req.user.id,
        userRole:  req.user.role,
        required:  roles,
        path:      req.path,
      }, '[auth] Authorization failure — insufficient role');

      return res.status(403).json({
        success: false,
        message: `Access denied. Required role: ${roles.join(' or ')}.`,
        code:    'INSUFFICIENT_ROLE',
      });
    }
    next();
  };
}

// ─── invalidateUserActiveCache ────────────────────────────────────────────────

/**
 * Call this when an admin deactivates a user.
 * Forces the next request from that user to re-check the DB.
 *
 * @param {string} userId
 */
async function invalidateUserActiveCache(userId) {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(`${USER_ACTIVE_PREFIX}${userId}`);
  } catch (_) { /* non-fatal */ }
}

module.exports = { authenticate, requireRole, invalidateUserActiveCache };

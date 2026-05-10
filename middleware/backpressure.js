'use strict';

/**
 * middleware/backpressure.js — Request Throttling & Load Shedding
 *
 * PHASE 3: Prevent system collapse under high load
 *
 * Problem:
 *  - At 500 bookings/min, if DB slows down, requests pile up
 *  - No backpressure = system collapse
 *
 * Solution:
 *  - Monitor queue depth and active connections
 *  - Return 503 when overloaded
 *  - Per-endpoint limits
 *  - [OPTIMIZED] DB pool health is cached with a 5 s TTL; only one
 *    background refresh runs at a time (in-flight guard) so the hot
 *    path never touches the database directly.
 *
 * Usage:
 *   const backpressure = require('./middleware/backpressure');
 *   app.use(backpressure.backpressure());
 *   app.use(backpressure.bookingBackpressure());
 */

const logger = require('../utils/logger');
const metrics = require('../planbuddy_v9/services/metricsService');

// ─── Configuration ────────────────────────────────────────────────────────────

const MAX_CONCURRENT_REQUESTS = 200;
const MAX_DB_CONNECTIONS      = 50;
const MAX_REDIS_PENDING       = 1000;   // kept for future use
const QUEUE_CHECK_INTERVAL_MS = 1000;   // kept for future use

/** How long (ms) to trust the cached DB-pool health result. */
const DB_HEALTH_TTL_MS = 5_000;

/** Fraction of the pool that triggers load-shedding (90 %). */
const DB_POOL_OVERLOAD_THRESHOLD = 0.9;

// ─── Module-level state ───────────────────────────────────────────────────────

let activeRequests = 0;
let requestQueue   = [];        // kept for API surface compatibility
let lastQueueCheck = Date.now();

// ─── DB-health cache (the core optimisation) ─────────────────────────────────

/**
 * Cached result of the last DB-pool health snapshot.
 *
 * Shape:
 *   { isDbOverloaded: boolean, checkedAt: number }
 *
 * `null` means "never checked yet" — treated conservatively as healthy
 * so the system doesn't shed load before it has any data.
 */
let dbHealthCache = null;

/**
 * When a refresh is already running this holds the Promise so every
 * concurrent caller awaits the same work instead of spawning N parallel
 * checks.  Null means no refresh is in flight.
 *
 * @type {Promise<void> | null}
 */
let dbHealthRefreshInFlight = null;

/**
 * Read DB pool counters — zero DB queries, pure in-process metrics.
 *
 * Returns `{ isDbOverloaded: boolean }`.
 * On any error the result is conservatively `{ isDbOverloaded: false }`
 * so a transient require() failure never causes spurious 503s.
 */
async function fetchDbPoolHealth() {
  try {
    const db = require('../config/db');

    if (!db?.pool) {
      // Pool not yet initialised — assume healthy.
      return { isDbOverloaded: false };
    }

    const used      = db.pool.totalCount || 0;
    const idle      = db.pool.idleCount  || 0;
    // "active" = connections currently executing queries
    const active    = used - idle;
    const overloaded = active >= MAX_DB_CONNECTIONS * DB_POOL_OVERLOAD_THRESHOLD;

    return { isDbOverloaded: overloaded };
  } catch (err) {
    // db module not yet initialised or threw — log and fail safe.
    logger.warn('backpressure: could not read DB pool metrics', { error: err.message });
    return { isDbOverloaded: false };
  }
}

/**
 * Refresh the DB-health cache.
 *
 * Thread-safety: if a refresh is already running the existing Promise is
 * returned so concurrent callers share one fetch, never fan-out.
 *
 * @returns {Promise<void>}
 */
function refreshDbHealthCache() {
  if (dbHealthRefreshInFlight !== null) {
    // Another caller already kicked off a refresh — ride along.
    return dbHealthRefreshInFlight;
  }

  dbHealthRefreshInFlight = fetchDbPoolHealth()
    .then((result) => {
      dbHealthCache = {
        isDbOverloaded: result.isDbOverloaded,
        checkedAt: Date.now(),
      };
    })
    .catch((err) => {
      // Should never reach here (fetchDbPoolHealth catches internally),
      // but be defensive: mark healthy so we don't shed load on error.
      logger.warn('backpressure: unexpected error refreshing DB health', { error: err.message });
      dbHealthCache = { isDbOverloaded: false, checkedAt: Date.now() };
    })
    .finally(() => {
      // Release the lock so the next TTL expiry can trigger a fresh fetch.
      dbHealthRefreshInFlight = null;
    });

  return dbHealthRefreshInFlight;
}

/**
 * Return the cached DB-overloaded flag.
 *
 * Hot-path behaviour:
 *  • Cache is warm & fresh  → synchronous boolean read, zero I/O.
 *  • Cache is stale         → start an async background refresh and
 *                             return the *previous* cached value for
 *                             this request (stale-while-revalidate).
 *  • Cache is empty (cold)  → kick off a refresh and return false
 *                             (healthy) until the first result arrives.
 *
 * The stale-while-revalidate approach means the hot path is NEVER
 * blocked waiting for a DB round-trip.
 */
function isDbOverloadedCached() {
  const now = Date.now();

  if (dbHealthCache === null) {
    // First call — start background refresh, optimistically assume healthy.
    refreshDbHealthCache();
    return false;
  }

  if (now - dbHealthCache.checkedAt > DB_HEALTH_TTL_MS) {
    // Cache is stale — revalidate in the background.
    // Return the last known value so this request is not blocked.
    refreshDbHealthCache();
  }

  return dbHealthCache.isDbOverloaded;
}

// ─── Public helpers ───────────────────────────────────────────────────────────

/**
 * Get current system load metrics (used by monitoring / health endpoints).
 * Reads pool counters directly — this function is NOT on the hot path.
 */
function getSystemLoad() {
  const db          = require('../config/db');
  const { redis }   = require('../config/redis');

  const metrics = {
    activeRequests,
    maxConcurrent:      MAX_CONCURRENT_REQUESTS,
    utilizationPercent: 0,
    dbPoolUsed:         0,
    dbPoolMax:          MAX_DB_CONNECTIONS,
    redisPending:       0,
  };

  try {
    if (db?.pool) {
      metrics.dbPoolUsed = db.pool.totalCount || 0;
    }

    if (redis?.llen) {
      metrics.redisPending = 0; // queue-specific check can be added here
    }

    const max = Math.max(metrics.maxConcurrent, metrics.dbPoolMax);
    metrics.utilizationPercent = Math.round((metrics.activeRequests / max) * 100);
  } catch (err) {
    logger.warn('Failed to get system load metrics', { error: err.message });
  }

  return metrics;
}

/**
 * Check if the system is overloaded.
 *
 * OPTIMISED: DB pool status comes from the in-memory cache.
 * No DB query is issued on the hot path.
 */
function isOverloaded() {
  // 1. Concurrency gate — cheapest check first.
  if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
    return true;
  }

  // 2. DB pool gate — reads from cache only (zero I/O).
  if (isDbOverloadedCached()) {
    return true;
  }

  return false;
}

// ─── Middleware factories ─────────────────────────────────────────────────────

/**
 * Global backpressure middleware factory.
 *
 * @param {object} [options]
 * @param {number} [options.maxConcurrent]
 * @param {number} [options.threshold]
 * @returns {import('express').RequestHandler}
 */
function backpressure(options = {}) {
  const maxConcurrent = options.maxConcurrent || MAX_CONCURRENT_REQUESTS;
  // `threshold` kept in signature for API compatibility; isOverloaded()
  // uses the module-level constant internally.
  const threshold = options.threshold || DB_POOL_OVERLOAD_THRESHOLD; // eslint-disable-line no-unused-vars

  return async function backpressureMiddleware(req, res, next) {
    // Always pass through health checks — avoids skewing activeRequests
    // and prevents health probes from being throttled.
    if (req.path.startsWith('/api/health')) {
      return next();
    }

    activeRequests += 1;

    try {
      if (isOverloaded()) {
        metrics.safeMetricCall('backpressure_total', 'inc');

        logger.warn('BACKPRESSURE: Request rejected — system overloaded', {
          path:           req.path,
          method:         req.method,
          activeRequests,
          maxConcurrent,
          dbOverloaded:   dbHealthCache?.isDbOverloaded ?? 'unknown',
        });

        return res.status(503).json({
          success:    false,
          message:    'Service temporarily busy. Please try again.',
          code:       'SERVICE_OVERLOADED',
          retryAfter: 5,
        });
      }

      return next();
    } finally {
      activeRequests -= 1;
    }
  };
}

/**
 * Endpoint-specific backpressure for booking creation.
 * Tighter concurrency limit than the global middleware.
 *
 * @returns {import('express').RequestHandler}
 */
function bookingBackpressure() {
  const BOOKING_MAX = 50;

  return async function bookingBackpressureMiddleware(req, res, next) {
    if (!req.path.includes('/booking') || req.method !== 'POST') {
      return next();
    }

    // Re-use the same activeRequests counter (global view).
    // A dedicated bookingActiveRequests counter can be added if needed.
    const bookingRequests = activeRequests;

    if (bookingRequests >= BOOKING_MAX) {
      metrics.safeMetricCall('backpressure_total', 'inc', { endpoint: 'booking' });

      logger.warn('BACKPRESSURE: Booking request rejected', {
        activeRequests: bookingRequests,
        max:            BOOKING_MAX,
      });

      return res.status(503).json({
        success:    false,
        message:    'Booking temporarily unavailable. Please try again.',
        code:       'BOOKING_OVERLOADED',
        retryAfter: 10,
      });
    }

    return next();
  };
}

/**
 * Snapshot of backpressure state for health-check endpoints.
 */
function getBackpressureStatus() {
  return {
    activeRequests,
    maxConcurrent:  MAX_CONCURRENT_REQUESTS,
    availableSlots: Math.max(0, MAX_CONCURRENT_REQUESTS - activeRequests),
    isOverloaded:   isOverloaded(),
    dbHealth: {
      isOverloaded: dbHealthCache?.isDbOverloaded ?? null,
      cachedAt:     dbHealthCache?.checkedAt       ?? null,
      ageMs:        dbHealthCache ? Date.now() - dbHealthCache.checkedAt : null,
    },
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  backpressure,
  bookingBackpressure,
  getBackpressureStatus,
  getSystemLoad,
  isOverloaded,

  // Exported for unit-testing the cache machinery in isolation.
  _refreshDbHealthCache: refreshDbHealthCache,
  _getDbHealthCache:     () => dbHealthCache,
  _resetDbHealthCache:   () => { dbHealthCache = null; dbHealthRefreshInFlight = null; },
};
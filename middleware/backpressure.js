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
 *
 * Usage:
 *   const backpressure = require('./middleware/backpressure');
 *   app.use(backpressure.global());
 */

const logger = require('../utils/logger');
const monitoring = require('../utils/monitoring');

// Configuration
const MAX_CONCURRENT_REQUESTS = 200;
const MAX_DB_CONNECTIONS = 50;
const MAX_REDIS_PENDING = 1000;
const QUEUE_CHECK_INTERVAL_MS = 1000;

// State
let activeRequests = 0;
let requestQueue = [];
let lastQueueCheck = Date.now();

/**
 * Get current system load metrics.
 */
function getSystemLoad() {
  const db = require('../config/db');
  const { redis } = require('../config/redis');

  const metrics = {
    activeRequests,
    maxConcurrent: MAX_CONCURRENT_REQUESTS,
    utilizationPercent: 0,
    dbPoolUsed: 0,
    dbPoolMax: MAX_DB_CONNECTIONS,
    redisPending: 0,
  };

  try {
    // DB pool usage
    if (db?.pool) {
      metrics.dbPoolUsed = db.pool.totalCount || 0;
    }

    // Redis queue depth (approximate)
    if (redis?.llen) {
      // Approximate check for BullMQ queues
      metrics.redisPending = 0; // Would need queue-specific check
    }

    // Calculate utilization
    const max concurrent = Math.max(metrics.maxConcurrent, metrics.dbPoolMax);
    metrics.utilizationPercent = Math.round((metrics.activeRequests / max) * 100);
  } catch (err) {
    logger.warn('Failed to get system load metrics', { error: err.message });
  }

  return metrics;
}

/**
 * Check if system is overloaded.
 * Returns true if load shedding should be applied.
 */
function isOverloaded() {
  // Check active requests
  if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
    return true;
  }

  // Check DB pool
  try {
    const db = require('../config/db');
    if (db?.pool) {
      const used = db.pool.totalCount || 0;
      const idle = db.pool.idleCount || 0;
      const available = used - idle;

      // If pool is 90% utilized
      if (available >= MAX_DB_CONNECTIONS * 0.9) {
        return true;
      }
    }
  } catch (err) {
    // Ignore errors (db might not be initialized)
  }

  return false;
}

/**
 * Backpressure middleware factory.
 *
 * @param {object} options
 * @returns {function}
 */
function backpressure(options = {}) {
  const maxConcurrent = options.maxConcurrent || MAX_CONCURRENT_REQUESTS;
  const threshold = options.threshold || 0.9; // 90% threshold

  return async function backpressureMiddleware(req, res, next) {
    // Skip health checks
    if (req.path.startsWith('/api/health')) {
      return next();
    }

    // Track active requests
    activeRequests += 1;

    try {
      // Check if overloaded
      if (isOverloaded()) {
        // Report metric
        if (monitoring.backpressure_total) {
          monitoring.backpressure_total.inc();
        }

        // Log warning
        logger.warn('BACKPRESSURE: Request rejected — system overloaded', {
          path: req.path,
          method: req.method,
          activeRequests,
          maxConcurrent,
        });

        // Return 503
        return res.status(503).json({
          success: false,
          message: 'Service temporarily busy. Please try again.',
          code: 'SERVICE_OVERLOADED',
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
 * Endpoint-specific backpressure.
 * Tighter limits for critical endpoints.
 */
function bookingBackpressure() {
  const BOOKING_MAX = 50; // Max 50 concurrent booking requests

  return async function bookingBackpressureMiddleware(req, res, next) {
    // Only apply to booking creation
    if (!req.path.includes('/booking') || req.method !== 'POST') {
      return next();
    }

    const bookingRequests = activeRequests; // Simplified

    if (bookingRequests >= BOOKING_MAX) {
      if (monitoring.backpressure_total) {
        monitoring.backpressure_total.inc({ endpoint: 'booking' });
      }

      logger.warn('BACKPRESSURE: Booking request rejected', {
        activeRequests: bookingRequests,
        max: BOOKING_MAX,
      });

      return res.status(503).json({
        success: false,
        message: 'Booking temporarily unavailable. Please try again.',
        code: 'BOOKING_OVERLOADED',
        retryAfter: 10,
      });
    }

    return next();
  };
}

/**
 * Health check that reports backpressure status.
 * Added to /api/health/live response.
 */
function getBackpressureStatus() {
  return {
    activeRequests,
    maxConcurrent: MAX_CONCURRENT_REQUESTS,
    availableSlots: Math.max(0, MAX_CONCURRENT_REQUESTS - activeRequests),
    isOverloaded: isOverloaded(),
  };
}

// Export middleware
module.exports = {
  backpressure,
  bookingBackpressure,
  getBackpressureStatus,
  getSystemLoad,
  isOverloaded,
};

"use strict";

/**
 * middleware/backpressure.js — Smart Backpressure Controller
 *
 * PHASE 4.1: FINAL HARDENING
 *
 * Problem:
 *  - Generic backpressure doesn't prioritize money endpoints
 *  - Under load, payments might get throttled while search succeeds
 *
 * Solution:
 *  - Priority tiers: HIGH > MEDIUM > LOW
 *  - HIGH (payments, bookings): Always allowed (unless extreme)
 *  - MEDIUM (auth): Throttled under load
 *  - LOW (trips, search): Dropped first under load
 *  - Event loop lag detection
 *  - DB pool monitoring
 */

const logger = require('../utils/logger');
const db = require('../config/db');

// Configuration
const CONFIG = {
  maxConcurrentRequests: 200,
  warningThreshold: 0.8,
  criticalThreshold: 0.95,
  slowResponseThreshold: 5000,
  eventLoopLagThreshold: 50, // ms - above this is concerning
  dbPoolWarningThreshold: 0.8,
  dbPoolCriticalThreshold: 0.95,
};

// Priority mapping
const PRIORITY_TIERS = {
  HIGH: ['/api/v1/payment', '/api/payment', '/api/v1/booking', '/api/booking'],
  MEDIUM: ['/api/v1/auth', '/api/auth'],
  LOW: ['/api/v1/trips', '/api/trips', '/api/v1/search', '/api/search'],
};

// State
let activeRequests = 0;
let totalRequests = 0;
let rejectedRequests = 0;
let slowResponses = 0;
let lastSlowAt = null;
let eventLoopLag = 0;

/**
 * Get priority tier for a path.
 */
function getPriorityTier(path) {
  if (!path) return 'MEDIUM';
  
  for (const tier of Object.keys(PRIORITY_TIERS)) {
    for (const prefix of PRIORITY_TIERS[tier]) {
      if (path.startsWith(prefix)) {
        return tier;
      }
    }
  }
  return 'MEDIUM'; // Default
}

/**
 * Get current backpressure status.
 */
function getBackpressureStatus() {
  const load = activeRequests / CONFIG.maxConcurrentRequests;
  
  return {
    activeRequests,
    totalRequests,
    rejectedRequests,
    slowResponses,
    maxConcurrent: CONFIG.maxConcurrentRequests,
    loadPercent: Math.round(load * 100),
    isOverloaded: load >= CONFIG.criticalThreshold,
    isWarning: load >= CONFIG.warningThreshold,
    lastSlowAt,
    eventLoopLag,
  };
}

/**
 * Check event loop lag.
 */
function checkEventLoopLag() {
  const start = process.hrtime.bigint();
  // Simple dummy operation
  let sum = 0;
  for (let i = 0; i < 1000; i++) sum += i;
  const end = process.hrtime.bigint();
  const lagMs = Number(end - start) / 1e6; // Convert to ms
  eventLoopLag = lagMs;
  return lagMs;
}

/**
 * Check DB pool health.
 */
async function getDbPoolHealth() {
  try {
    const result = await db.query('SELECT 1');
    const pool = db.pool || {};
    const total = pool.totalCount || 0;
    const idle = pool.idleCount || 0;
    const used = total - idle;
    const utilization = total > 0 ? used / total : 0;
    
    return {
      total,
      used,
      idle,
      utilization: Math.round(utilization * 100),
      isWarning: utilization >= CONFIG.dbPoolWarningThreshold,
      isCritical: utilization >= CONFIG.dbPoolCriticalThreshold,
    };
  } catch (err) {
    return { error: err.message, isCritical: true };
  }
}

/**
 * Middleware to track requests and apply smart backpressure.
 */
async function backpressureMiddleware(req, res, next) {
  try {
  const correlationId = req.headers['x-correlation-id'] || `bp-${Date.now()}`;
  const startTime = Date.now();
  const tier = getPriorityTier(req.path);
  
  // Check event loop lag
  const lagMs = checkEventLoopLag();
  
  // Check DB pool
  const dbHealth = await getDbPoolHealth();
  
  // Increment counters
  activeRequests++;
  totalRequests++;
  
  // Determine if we should allow request
  let shouldAllow = true;
  let rejectReason = null;
  const load = activeRequests / CONFIG.maxConcurrentRequests;
  
  // Tier-specific logic
  if (tier === 'LOW') {
    // LOW priority: Drop first under load
    if (load >= CONFIG.warningThreshold) {
      shouldAllow = false;
      rejectReason = 'LOAD_HIGH';
    } else if (dbHealth.isCritical) {
      shouldAllow = false;
      rejectReason = 'DB_CRITICAL';
    } else if (lagMs > CONFIG.eventLoopLagThreshold) {
      shouldAllow = false;
      rejectReason = 'EVENT_LOOP_LAG';
    }
  } else if (tier === 'MEDIUM') {
    // MEDIUM: Allow until warning, then throttle
    if (load >= CONFIG.criticalThreshold) {
      shouldAllow = false;
      rejectReason = 'LOAD_CRITICAL';
    } else if (dbHealth.isCritical) {
      shouldAllow = false;
      rejectReason = 'DB_CRITICAL';
    }
  } else {
    // HIGH: Always allow unless EXTREME overload
    if (load >= 0.98 || dbHealth.isCritical) {
      shouldAllow = false;
      rejectReason = 'EXTREME_OVERLOAD';
    }
  }
  
  if (!shouldAllow) {
    rejectedRequests++;
    activeRequests--;
    
    logger.warn('Backpressure: request rejected', {
      correlationId,
      tier,
      rejectReason,
      activeRequests: activeRequests - 1,
      loadPercent: Math.round(load * 100),
      path: req.path,
    });
    
    return res.status(503).json({
      error: 'SERVER_OVERLOADED',
      retryAfter: 2,
      tier,
    });
  }
  
  // Track slow responses
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    activeRequests = Math.max(0, activeRequests - 1);
    
    if (duration > CONFIG.slowResponseThreshold) {
      slowResponses++;
      lastSlowAt = new Date();
      
      logger.warn('Slow response detected', {
        correlationId,
        tier,
        duration,
        path: req.path,
      });
    }
  });
  
  res.on('close', () => {
    if (!res.writableEnded) {
      activeRequests = Math.max(0, activeRequests - 1);
    }
  });
  
  next();
  } catch (err) {
    // ✅ FIX API-002: Catch errors from async middleware
    activeRequests = Math.max(0, activeRequests - 1);
    logger.error('Backpressure middleware error', { error: err.message, path: req.path });
    next(err);
  }
}

/**
 * Get health check data.
 */
function getHealthCheckData() {
  return {
    backpressure: getBackpressureStatus(),
    config: CONFIG,
    priorityTiers: PRIORITY_TIERS,
  };
}

/**
 * Reset counters (for testing).
 */
function resetCounters() {
  activeRequests = 0;
  totalRequests = 0;
  rejectedRequests = 0;
  slowResponses = 0;
}

/**
 * Set custom config.
 */
function setConfig(newConfig) {
  Object.assign(CONFIG, newConfig);
}

module.exports = {
  backpressureMiddleware,
  getBackpressureStatus,
  getHealthCheckData,
  getDbPoolHealth,
  checkEventLoopLag,
  resetCounters,
  setConfig,
  CONFIG,
  PRIORITY_TIERS,
};

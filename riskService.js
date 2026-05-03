'use strict';

/**
 * services/riskService.js — Fraud & Abuse Detection
 *
 * PHASE 4: Real Revenue Protection
 *
 * Detects:
 *  - Same user → multiple bookings rapidly
 *  - Same IP → multiple accounts
 *  - Payment mismatch patterns
 *  - High-value booking anomalies
 */

const db = require('../config/db');
const logger = require('../utils/logger');
const alertingService = require('./alertingService');
const monitoring = require('../utils/monitoring');

const RISK_TYPES = {
  RAPID_BOOKINGS: 'RAPID_BOOKINGS',
  SAME_IP_MULTIPLE_ACCOUNTS: 'SAME_IP_MULTIPLE_ACCOUNTS',
  HIGH_VALUE_ANOMALY: 'HIGH_VALUE_ANOMALY',
  PAYMENT_MISMATCH: 'PAYMENT_MISMATCH',
  SUSPICIOUS_REFUND_PATTERN: 'SUSPICIOUS_REFUND_PATTERN',
  BOT_DETECTION: 'BOT_DETECTION',
};

const SEVERITY = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
};

/**
 * Check for rapid bookings (same user, multiple in short time).
 */
async function checkRapidBookings(userId, windowMinutes = 10) {
  const result = await db.query(
    `SELECT COUNT(*) AS count
     FROM bookings
     WHERE user_id = $1
       AND created_at > NOW() - INTERVAL '$2 minutes'
       AND status NOT IN ('cancelled', 'failed')`,
    [userId, windowMinutes]
  );

  return parseInt(result.rows[0].count, 10);
}

/**
 * Check for same IP multiple accounts.
 */
async function checkSameIPAccounts(ipAddress, threshold = 5) {
  const result = await db.query(
    `SELECT COUNT(DISTINCT user_id) AS count
     FROM bookings
     WHERE ip_address = $1
       AND created_at > NOW() - INTERVAL '24 hours'`,
    [ipAddress]
  );

  return parseInt(result.rows[0].count, 10) >= threshold;
}

/**
 * Check for high-value anomaly.
 */
async function checkHighValueAnomaly(userId, amount, threshold = 50000) {
  const result = await db.query(
    `SELECT AVG(total_amount) AS avg_amount
     FROM bookings
     WHERE user_id = $1
       AND status = 'confirmed'
       AND created_at > NOW() - INTERVAL '30 days'`,
    [userId]
  );

  const avgAmount = parseFloat(result.rows[0]?.avg_amount || 0);
  
  // If average is low and new amount is very high - suspicious
  if (avgAmount > 0 && amount > avgAmount * 3 && amount > threshold) {
    return { isAnomaly: true, avgAmount, factor: amount / avgAmount };
  }

  return { isAnomaly: false };
}

/**
 * Check for payment amount mismatch.
 */
async function checkPaymentMismatch(bookingId, expectedAmount, receivedAmount) {
  const diff = Math.abs(expectedAmount - receivedAmount);
  
  // Allow 1% difference for gateway fees
  if (diff > expectedAmount * 0.01) {
    return { isMismatch: true, diff, expected: expectedAmount, received: receivedAmount };
  }

  return { isMismatch: false };
}

/**
 * Record a risk event.
 */
async function recordRiskEvent({
  userId,
  riskType,
  severity = SEVERITY.MEDIUM,
  metadata = {},
  blocked = false,
}) {
  try {
    const result = await db.query(
      `INSERT INTO risk_events (user_id, risk_type, severity, metadata, blocked)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [userId, riskType, severity, JSON.stringify(metadata), blocked]
    );

    // Update metrics
    if (monitoring.risk_event_total) {
      monitoring.risk_event_total.inc({ risk_type: riskType, severity });
    }

    // Trigger alert for high severity
    if (severity === SEVERITY.HIGH || severity === SEVERITY.CRITICAL) {
      await alertingService.createAlert({
        alertType: `RISK_${riskType}`,
        severity: severity === SEVERITY.CRITICAL ? 'critical' : 'warning',
        message: `Risk event detected: ${riskType}`,
        entityType: 'user',
        entityId: userId,
        metadata,
      });
    }

    return result.rows[0];
  } catch (err) {
    logger.error('Failed to record risk event', { userId, riskType, error: err.message });
    return null;
  }
}

/**
 * Get recent risk events for a user.
 */
async function getUserRiskEvents(userId, hours = 24) {
  const result = await db.query(
    `SELECT * FROM risk_events
     WHERE user_id = $1
       AND created_at > NOW() - INTERVAL '$2 hours'
     ORDER BY created_at DESC`,
    [userId, hours]
  );

  return result.rows;
}

/**
 * Combined risk check for a booking.
 * Returns: { allowed: boolean, reasons: string[], riskLevel: string }
 */
async function assessBookingRisk(userId, ipAddress, amount, bookingId = null) {
  const reasons = [];
  let riskLevel = SEVERITY.LOW;

  // Check rapid bookings
  const rapidCount = await checkRapidBookings(userId, 10);
  if (rapidCount >= 5) {
    reasons.push(`Rapid bookings: ${rapidCount} in 10 minutes`);
    riskLevel = SEVERITY.HIGH;
    
    await recordRiskEvent({
      userId,
      riskType: RISK_TYPES.RAPID_BOOKINGS,
      severity: SEVERITY.HIGH,
      metadata: { count: rapidCount, window: '10min' },
      blocked: rapidCount >= 10,
    });
  }

  // Check same IP multiple accounts
  if (ipAddress) {
    const sameIp = await checkSameIPAccounts(ipAddress);
    if (sameIp) {
      reasons.push(`Same IP creating multiple accounts: ${ipAddress}`);
      riskLevel = Math.max(riskLevel === SEVERITY.LOW ? 0 : riskLevel === SEVERITY.MEDIUM ? 1 : 2, 2);
      riskLevel = SEVERITY.HIGH;
      
      await recordRiskEvent({
        userId,
        riskType: RISK_TYPES.SAME_IP_MULTIPLE_ACCOUNTS,
        severity: SEVERITY.HIGH,
        metadata: { ipAddress },
        blocked: true,
      });
    }
  }

  // Check high value anomaly
  if (amount) {
    const anomaly = await checkHighValueAnomaly(userId, amount);
    if (anomaly.isAnomaly) {
      reasons.push(`High value anomaly: ${amount} (avg: ${anomaly.avgAmount}, factor: ${anomaly.factor.toFixed(1)}x)`);
      riskLevel = Math.max(riskLevel === SEVERITY.LOW ? 0 : riskLevel === SEVERITY.MEDIUM ? 1 : 2, 1);
      riskLevel = SEVERITY.MEDIUM;
      
      await recordRiskEvent({
        userId,
        riskType: RISK_TYPES.HIGH_VALUE_ANOMALY,
        severity: SEVERITY.MEDIUM,
        metadata: { amount, avgAmount: anomaly.avgAmount, factor: anomaly.factor },
      });
    }
  }

  // Get existing high-risk events
  const userRisks = await getUserRiskEvents(userId, 24);
  const highRiskCount = userRisks.filter(r => r.severity === SEVERITY.HIGH || r.severity === SEVERITY.CRITICAL).length;

  if (highRiskCount >= 3) {
    reasons.push(`User has ${highRiskCount} high-risk events in 24h`);
    riskLevel = SEVERITY.CRITICAL;
  }

  const allowed = reasons.filter(r => !r.includes('blocked')).length === 0;

  return {
    allowed,
    reasons,
    riskLevel,
    blocked: !allowed,
  };
}

/**
 * Get risk statistics.
 */
async function getRiskStats(hours = 24) {
  const result = await db.query(
    `SELECT 
      risk_type,
      severity,
      COUNT(*) AS count,
      SUM(CASE WHEN blocked THEN 1 ELSE 0 END) AS blocked_count
    FROM risk_events
    WHERE created_at > NOW() - INTERVAL '$1 hours'
    GROUP BY risk_type, severity
    ORDER BY count DESC`,
    [hours]
  );

  return result.rows;
}

module.exports = {
  RISK_TYPES,
  SEVERITY,
  recordRiskEvent,
  assessBookingRisk,
  checkRapidBookings,
  checkSameIPAccounts,
  checkHighValueAnomaly,
  checkPaymentMismatch,
  getUserRiskEvents,
  getRiskStats,
};

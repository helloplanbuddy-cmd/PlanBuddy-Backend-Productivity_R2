'use strict';

/**
 * services/alertingService.js — Structured Failure Alerting
 *
 * PHASE 3: Production alerting for silent failure detection
 *
 * Problem:
 *  - Payment failures are silent
 *  - Stuck bookings go unnoticed
 *  - Workers retry forever without visibility
 *
 * Solution:
 *  - Structured alerts to DB + external systems (PagerDuty, Slack)
 *  - Alert history for post-mortem
 *  - Automatic severity classification
 *
 * Alert Types:
 *  - PAYMENT_FAILED: Payment capture failed after payment received
 *  - BOOKING_STUCK: Booking pending for > 30 minutes
 *  - WORKER_EXHAUSTED: Worker retries exhausted
 *  - AUTH_ATTACK: Possible brute force attack
 *  - SYSTEM_OVERLOAD: Backpressure triggered
 */

const db = require('../config/db');
const logger = require('../utils/logger');
const monitoring = require('../utils/monitoring');
const env = require('../config/env');
const axios = require('axios');

async function sendSlackAlert(alert) {
  if (!env.SLACK_WEBHOOK_URL) {
    logger.debug('SLACK_WEBHOOK_URL not set, skipping Slack alert');
    return;
  }

  const slackPayload = {
    text: `🚨 *PlanBuddy Alert* (${alert.severity.toUpperCase()})`,
    blocks: [{
      type: 'header',
      text: { type: 'plain_text', text: `🔥 ${alert.alert_type} - ${alert.severity}` }
    }, {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Message:* ${alert.message}` }
    }, {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `*Entity:* ${alert.entity_type}/${alert.entity_id}`
      }]
    }]
  };

  try {
    await axios.post(env.SLACK_WEBHOOK_URL, slackPayload);
    logger.info('Slack alert sent', { alert_type: alert.alert_type });
  } catch (err) {
    logger.error('Slack alert failed', { error: err.message, alert_type: alert.alert_type });
  }
}

const ALERT_SEVERITY = {
  INFO: 'info',
  WARNING: 'warning',
  CRITICAL: 'critical',
};

const ALERT_TYPES = {
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  BOOKING_STUCK: 'BOOKING_STUCK',
  WORKER_EXHAUSTED: 'WORKER_EXHAUSTED',
  AUTH_ATTACK: 'AUTH_ATTACK',
  SYSTEM_OVERLOAD: 'SYSTEM_OVERLOAD',
  RAZORPAY_WEBHOOK_FAILED: 'RAZORPAY_WEBHOOK_FAILED',
};

/**
 * Create a new alert.
 *
 * @param {object} params
 * @returns {Promise<object>}
 */
async function createAlert({
  alertType,
  severity = ALERT_SEVERITY.WARNING,
  message,
  entityType,
  entityId,
  metadata = {},
}) {
  const alert = {
    alert_type: alertType,
    severity,
    message,
    entity_type: entityType,
    entity_id: entityId,
    metadata: JSON.stringify(metadata),
  };

  try {
    // Try to write to alert_log table
    const result = await db.query(
      `INSERT INTO alert_log
         (alert_type, severity, message, entity_type, entity_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [alert.alert_type, alert.severity, alert.message, alert.entity_type, alert.entity_id, alert.metadata]
    );

    if (result.rows.length > 0) {
      return result.rows[0];
    }
  } catch (err) {
    // Table might not exist yet — continue without DB
    logger.warn('Failed to write alert to DB', { error: err.message });
  }

  // Log to console/file as fallback
  if (severity === ALERT_SEVERITY.CRITICAL) {
    logger.critical(alertType, message, { entityType, entityId, metadata });
    await sendSlackAlert(alert);
  } else {
    logger.warn(alertType, message, { entityType, entityId, metadata });
  }

  // Increment metric
  if (monitoring.alert_total) {
    monitoring.alert_total.inc({ alert_type: alertType, severity });
  }

  return alert;
}

/**
 * Acknowledge an alert.
 *
 * @param {string} alertId
 * @param {string} acknowledgedBy
 * @returns {Promise<object>}
 */
async function acknowledgeAlert(alertId, acknowledgedBy) {
  try {
    const result = await db.query(
      `UPDATE alert_log
       SET acknowledged = TRUE,
           acknowledged_by = $2,
           acknowledged_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [alertId, acknowledgedBy]
    );

    return result.rows[0];
  } catch (err) {
    logger.warn('Failed to acknowledge alert', { alertId, error: err.message });
    return null;
  }
}

/**
 * Get unacknowledged alerts.
 *
 * @param {number} limit
 * @returns {Promise<array>}
 */
async function getUnacknowledgedAlerts(limit = 50) {
  try {
    const result = await db.query(
      `SELECT * FROM alert_log
       WHERE acknowledged = FALSE
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );

    return result.rows;
  } catch (err) {
    logger.warn('Failed to get unacknowledged alerts', { error: err.message });
    return [];
  }
}

/**
 * Convenience: Alert on payment failure.
 */
async function alertPaymentFailed(bookingId, paymentId, error) {
  return createAlert({
    alertType: ALERT_TYPES.PAYMENT_FAILED,
    severity: ALERT_SEVERITY.CRITICAL,
    message: `Payment captured but booking confirmation failed: ${error}`,
    entityType: 'booking',
    entityId: bookingId,
    metadata: { paymentId, error },
  });
}

/**
 * Convenience: Alert on stuck booking.
 */
async function alertBookingStuck(bookingId, durationMinutes) {
  return createAlert({
    alertType: ALERT_TYPES.BOOKING_STUCK,
    severity: ALERT_SEVERITY.WARNING,
    message: `Booking stuck in pending for ${durationMinutes} minutes`,
    entityType: 'booking',
    entityId: bookingId,
    metadata: { durationMinutes },
  });
}

/**
 * Convenience: Alert on worker exhaustion.
 */
async function alertWorkerExhausted(jobId, workerName, attempts, error) {
  return createAlert({
    alertType: ALERT_TYPES.WORKER_EXHAUSTED,
    severity: ALERT_SEVERITY.CRITICAL,
    message: `Worker ${workerName} exhausted after ${attempts} attempts: ${error}`,
    entityType: 'job',
    entityId: jobId,
    metadata: { workerName, attempts, error },
  });
}

/**
 * Convenience: Alert on auth attack.
 */
async function alertAuthAttack(email, ip, reason) {
  return createAlert({
    alertType: ALERT_TYPES.AUTH_ATTACK,
    severity: ALERT_SEVERITY.WARNING,
    message: `Possible auth attack: ${reason}`,
    entityType: 'user',
    entityId: email,
    metadata: { ip, reason },
  });
}

/**
 * Convenience: Alert on system overload (backpressure triggered).
 */
async function alertSystemOverload(metric, value, threshold) {
  return createAlert({
    alertType: ALERT_TYPES.SYSTEM_OVERLOAD,
    severity: ALERT_SEVERITY.WARNING,
    message: `System overload: ${metric} at ${value} (threshold: ${threshold})`,
    entityType: 'system',
    entityId: null,
    metadata: { metric, value, threshold },
  });
}

module.exports = {
  createAlert,
  acknowledgeAlert,
  getUnacknowledgedAlerts,
  alertPaymentFailed,
  alertBookingStuck,
  alertWorkerExhausted,
  alertAuthAttack,
  alertSystemOverload,
  ALERT_SEVERITY,
  ALERT_TYPES,
};

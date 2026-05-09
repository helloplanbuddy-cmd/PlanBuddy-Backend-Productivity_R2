'use strict';

/**
 * workers/alert-poller.worker.js — Unacknowledged Alert Escalation
 *
 * Runs every 5 minutes:
 *  - Polls getUnacknowledgedAlerts(limit=20)
 *  - For CRITICAL alerts older than 5min → sendSlackAlert('STILL UNRESOLVED')
 *  - Prevents alert fatigue: only re-notify once/hour after initial
 *
 * Graceful SIGTERM (like paymentReconciliation.worker.js)
 */

const cron = require('node-cron');
const logger = require('../utils/logger');
const { getUnacknowledgedAlerts, ALERT_SEVERITY } = require('../services/alertingService');
const { sendSlackAlert } = require('../services/alertingService');  // Reuse function

let shuttingDown = false;

async function pollUnacknowledgedAlerts() {
  if (shuttingDown) return;

  try {
    const unacked = await getUnacknowledgedAlerts(20);
    const now = Date.now();

    for (const alert of unacked) {
      if (alert.severity !== ALERT_SEVERITY.CRITICAL) continue;

      const ageMs = now - new Date(alert.created_at).getTime();
      if (ageMs < 5 * 60 * 1000) continue;  // Skip <5min

      // Re-notify with escalation message (once/hour throttle via metadata)
      const lastSlack = alert.metadata ? JSON.parse(alert.metadata).last_slack_escalation : null;
      const hourAgo = now - 60 * 60 * 1000;

      if (!lastSlack || new Date(lastSlack).getTime() < hourAgo) {
        const escalatedAlert = {
          ...alert,
          message: `${alert.message} — *STILL UNRESOLVED* (age: ${Math.round(ageMs / 60000)}min)`,
        };

        await sendSlackAlert(escalatedAlert);
        logger.warn('Escalated unacked CRITICAL alert to Slack', { alert_id: alert.id });
      }
    }
  } catch (err) {
    logger.error('Alert poller failed', { error: err.message });
  }
}

// ─── Cron every 5 minutes ─────────────────────────────────────────────────────
cron.schedule('*/5 * * * *', pollUnacknowledgedAlerts, {
  scheduled: true,
  timezone: "UTC",
});

logger.info('🚨 Alert poller started — checks unacknowledged CRITICAL alerts every 5min');

// ─── Graceful shutdown ────────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  logger.info('Alert poller: SIGTERM received — finishing');
  shuttingDown = true;
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('Alert poller: SIGINT received — finishing');
  shuttingDown = true;
  process.exit(0);
});


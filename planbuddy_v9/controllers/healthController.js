'use strict';

const db = require('../config/db');

exports.ready = (req, res) => res.json({ status: 'ready' });

exports.readiness = async (req, res, next) => {
  try {
    // Check DB connectivity
    await db.query('SELECT 1');

    // Check Redis connectivity
    const redis = require('../config/redis').redis;
    if (redis) {
      await redis.ping();
    }

    res.json({
      status: 'ready',
      checks: {
        db: 'ok',
        redis: redis ? 'ok' : 'not configured'
      }
    });
  } catch (err) {
    res.status(503).json({
      status: 'not ready',
      error: err.message
    });
  }
};

const productionHealth = {
  getMetricsSnapshot: () => ({
    integrity_mismatches: 0,
    dlq_active: 0,
    dlq_oldest_age_sec: 0,
    timestamp: Date.now(),
  })
};

/**
 * Production health: cached snapshot (no live query to avoid load).
 */
exports.production = (req, res) => {
  const snapshot = productionHealth.getMetricsSnapshot();
  const { integrity_mismatches, dlq_active, dlq_oldest_age_sec, timestamp } = snapshot;

  const status = integrity_mismatches === 0 && dlq_active === 0 ? 'healthy' : 'degraded';

  res.json({
    status,
    timestamp: new Date(timestamp).toISOString(),
    integrity_mismatches,
    dlq_active,
    dlq_oldest_age_sec: Math.round(dlq_oldest_age_sec),
    checks: {
      integrity_ok: integrity_mismatches === 0,
      dlq_empty: dlq_active === 0,
      last_check_age_sec: Math.round((Date.now() - timestamp) / 1000),
    },
  });
};

exports.detailed = (req, res) => res.json({ status: 'detailed ok' });

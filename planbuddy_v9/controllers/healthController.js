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

exports.detailed = (req, res) => res.json({ status: 'detailed ok' });

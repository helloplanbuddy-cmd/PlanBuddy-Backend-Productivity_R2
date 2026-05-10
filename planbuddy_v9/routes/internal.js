'use strict';

const express = require('express');
const router = express.Router();
const healthController = require('../controllers/healthController');

/**
 * Internal observability routes (/internal/*)
 * Access is restricted at the app layer via an IP allowlist.
 */

// Health endpoints
router.get('/health/ready',      healthController.ready);
router.get('/health/readiness',  healthController.readiness);
router.get('/health/detailed',   healthController.detailed);
router.get('/health/production', healthController.production);

// Optional integrity endpoint
router.post('/health/check-integrity', async (req, res) => {
  try {
    if (typeof healthController.checkIntegrity === 'function') {
      await healthController.checkIntegrity();

      return res.json({
        status: 'check triggered'
      });
    }

    return res.status(501).json({
      error: 'Integrity check not implemented'
    });
  } catch (err) {
    return res.status(500).json({
      error: err.message
    });
  }
});

module.exports = router;
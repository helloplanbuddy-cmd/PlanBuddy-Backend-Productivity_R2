'use strict';

const express = require('express');
const router = express.Router();

// Temporary sanity routes for startup
router.get('/ping', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

router.get('/status', (req, res) => {
  res.json({ status: 'api ready' });
});

// Health endpoints
const healthController = require('../controllers/healthController');
router.get('/health', healthController.readiness);
router.get('/health/production', healthController.production);


// Stub for future controllers
router.get('/bookings', (req, res) => res.json({ message: 'bookings stub' }));
router.post('/bookings', (req, res) => {
  console.log("STUB ROUTE HIT - planbuddy_v9/routes/index.js");
  res.json({ message: 'booking created stub' });
});

module.exports = router;

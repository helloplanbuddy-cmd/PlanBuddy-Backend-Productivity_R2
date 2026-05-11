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


// ─── Booking controller routes ────────────────────────────────────────────
const bookingController = require('../controllers/bookingController');
const { idempotency } = require('../middleware/idempotency');
const authenticate = require('../middleware/authenticate');

// GET /bookings — list user bookings
router.get('/bookings', authenticate, bookingController.getUserBookings);

// GET /bookings/:bookingId — get single booking
router.get('/bookings/:bookingId', authenticate, bookingController.getBooking);

// POST /bookings/:bookingId/cancel — cancel booking with refund
// ✅ IDEMPOTENCY ENFORCEMENT: Idempotency-Key header REQUIRED
router.post(
  '/bookings/:bookingId/cancel',
  authenticate,
  idempotency.strict,  // ✅ Enforce Idempotency-Key header
  bookingController.cancelBooking
);

// GET /bookings (all bookings — admin only)
router.get('/bookings', authenticate, bookingController.getAllBookings);

// Check availability
router.get('/trips/:tripId/availability', bookingController.checkAvailability);
router.get('/trips/:tripId/slots', bookingController.getAvailableSlots);

module.exports = router;

'use strict';

const express = require('express');
const router = express.Router();

// ─── Health & Status Endpoints ────────────────────────────────────────────────
router.get('/ping', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

router.get('/status', (req, res) => {
  res.json({ status: 'api ready' });
});

const healthController = require('../controllers/healthController');
router.get('/health', healthController.readiness);
router.get('/health/production', healthController.production);

// ─── Payment Endpoints ────────────────────────────────────────────────────────
const paymentController = require('../controllers/paymentController');

// Create a new Razorpay order for a booking
router.post('/payments/create-order', paymentController.createOrder);

// Verify payment after frontend checkout
router.post('/payments/verify', paymentController.verifyPayment);

// Get payment status for a booking
router.get('/payments/:bookingId/status', paymentController.getPaymentStatus);

// Initiate refund for a payment
router.post('/payments/:paymentId/refund', paymentController.initiateRefund);

// ─── Booking Endpoints ────────────────────────────────────────────────────────
const bookingController = require('../controllers/bookingController');

// Create a new booking
router.post('/bookings', bookingController.createBooking);

// Get user's bookings
router.get('/bookings', bookingController.getUserBookings);

// Get single booking details
router.get('/bookings/:bookingId', bookingController.getBooking);

// Cancel a booking
router.post('/bookings/:bookingId/cancel', bookingController.cancelBooking);

// Check trip availability
router.get('/bookings/check-availability', bookingController.checkAvailability);

// Get available slots for a trip
router.get('/bookings/available-slots', bookingController.getAvailableSlots);

// Get all bookings (admin only)
router.get('/admin/bookings', bookingController.getAllBookings);

module.exports = router;

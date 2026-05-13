'use strict';

/**
 * controllers/paymentController.js — Payment Controller (v6.1, hardened)
 *
 * IMPORTANT:
 * - This file was previously corrupted by an unresolved merge conflict.
 * - This rewrite removes ALL merge-conflict markers and restores a valid module.
 *
 * Exposes:
 *  - createOrder
 *  - verifyPayment
 *  - razorpayWebhook (delegates to razorpayWebhookController)
 *  - getPaymentStatus
 *  - manualReconcile
 */

const RazorpayService = require('../services/razorpayService.js');

const {
  razorpay: razorpayClient,
  rupeesToPaise,
  keyId: razorpayKeyId,
} = require('../config/razorpay.js');

const db = require('../config/db.js');
const logger = require('../utils/logger.js');
const monitoring = require('../utils/monitoring.js');

const PaymentAudit = require('../services/paymentAuditService.js');
const metrics = require('../services/metricsService.js');
const { updateTraceContext } = require('../middleware/traceId.js');

// ─── POST /payment/create-order ───────────────────────────────────────────────
exports.createOrder = async (req, res, next) => {
  try {
    const { bookingId } = req.body;
    if (!bookingId) {
      return res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: 'bookingId is required',
      });
    }

    const bookingResult = await db.query(
      `SELECT b.id, b.user_id, b.total_amount, b.currency, b.status, b.payment_status, b.group_size,
              t.price, t.is_active
       FROM bookings b
       JOIN trips t ON b.trip_id = t.id
       WHERE b.id = $1 AND b.user_id = $2`,
      [bookingId, req.user.id]
    );

    if (bookingResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        code: 'BOOKING_NOT_FOUND',
        message: 'Booking not found',
      });
    }

    const booking = bookingResult.rows[0];

    const expectedAmount = booking.price * booking.group_size;
    if (booking.total_amount !== expectedAmount) {
      logger.error(
        {
          service: 'payment',
          booking_id: bookingId,
          user_id: req.user.id,
          expected: expectedAmount,
          actual: booking.total_amount,
          requestId: req.requestId,
          traceId: req.traceId,
        },
        '[payment] Amount validation failed: booking total_amount does not match trip price * group_size'
      );

      return res.status(400).json({
        success: false,
        code: 'AMOUNT_VALIDATION_FAILED',
        message: 'Booking amount validation failed. Please contact support.',
      });
    }

    if (!booking.is_active) {
      return res.status(409).json({
        success: false,
        code: 'TRIP_INACTIVE',
        message: 'Trip is no longer available',
      });
    }

    if (booking.status !== 'pending' || booking.payment_status !== 'unpaid') {
      return res.status(409).json({
        success: false,
        code: 'BOOKING_NOT_ELIGIBLE',
        message: `Cannot create order: booking status is "${booking.status}" / payment is "${booking.payment_status}"`,
      });
    }

    if (!razorpayClient) {
      return res.status(503).json({
        success: false,
        code: 'PAYMENT_SERVICE_UNAVAILABLE',
        message: 'Payment service unavailable',
      });
    }

    const amountPaise = rupeesToPaise(booking.total_amount);

    const order = await razorpayClient.orders.create({
      amount: amountPaise,
      currency: booking.currency || 'INR',
      receipt: bookingId.replace(/-/g, '').slice(0, 40),
      notes: {
        booking_id: bookingId,
        user_id: req.user.id,
      },
    });

    await db.transaction(async (client) => {
      await client.query(
        `INSERT INTO razorpay_order_mappings
           (razorpay_order_id, booking_id, user_id, amount, currency)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (razorpay_order_id) DO NOTHING`,
        [order.id, bookingId, req.user.id, booking.total_amount, 'INR']
      );

      await client.query(
        `UPDATE payments
         SET razorpay_order_id = $1, updated_at = NOW()
         WHERE booking_id = $2 AND status = 'created'`,
        [order.id, bookingId]
      );
    });

    logger.info(
      {
        service: 'payment',
        booking_id: bookingId,
        order_id: order.id,
        amount: amountPaise,
        requestId: req.requestId,
        traceId: req.traceId,
        user_id: req.user.id,
      },
      '[payment] Razorpay order created'
    );

    await PaymentAudit.logPaymentCreated({
      bookingId,
      paymentId: order.id,
      traceId: req.traceId,
      userId: req.user.id,
      metadata: { order_id: order.id, amount_paise: amountPaise },
    });

    metrics.recordPaymentAttempted();
    updateTraceContext({ booking_id: bookingId });

    return res.json({
      success: true,
      data: {
        orderId: order.id,
        amount: amountPaise,
        currency: 'INR',
        keyId: razorpayKeyId,
        bookingId,
      },
    });
  } catch (err) {
    monitoring.payment_failures_total?.inc({ reason: 'order_creation_failed' });
    next(err);
  }
};

// ─── POST /payment/verify-payment ─────────────────────────────────────────────
exports.verifyPayment = async (req, res, next) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      amount,
      currency,
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: 'razorpay_order_id, razorpay_payment_id, and razorpay_signature are required',
      });
    }

    const signaturePayload = `${razorpay_order_id}|${razorpay_payment_id}`;
    RazorpayService.verifySignature(signaturePayload, razorpay_signature);

    const result = await RazorpayService.processPaymentTransaction(
      razorpay_order_id,
      razorpay_payment_id,
      amount,
      currency || 'INR',
      req.user.id,
      req.requestId
    );

    logger.info(
      {
        service: 'payment',
        booking_id: result.data?.booking?.id,
        payment_id: razorpay_payment_id,
        order_id: razorpay_order_id,
        user_id: req.user.id,
        requestId: req.requestId,
        traceId: req.traceId,
        idempotent: result.idempotent,
      },
      '[payment] Payment verified and confirmed'
    );

    return res.json({
      success: true,
      message: result.idempotent
        ? 'Payment already processed'
        : 'Payment verified and booking confirmed',
      data: result.data,
    });
  } catch (err) {
    monitoring.payment_failures_total?.inc({ reason: err.message?.slice(0, 50) || 'unknown' });
    next(err);
  }
};

// ─── POST /payment/webhook/razorpay (delegates) ───────────────────────────────
// IMPORTANT: Production-grade webhook logic lives in razorpayWebhookController.js.
exports.razorpayWebhook = async (req, res, next) => {
  return require('./razorpayWebhookController').handleRazorpayWebhook(req, res, next);
};

// ─── POST /admin/reconcile ────────────────────────────────────────────────────
exports.manualReconcile = async (req, res, next) => {
  try {
    logger.info('Manual reconciliation triggered by admin', {
      userId: req.user.id,
      requestId: req.requestId,
    });

    const { runReconciliation } = require('../workers/paymentReconciliation.worker.js');
    const result = await runReconciliation();

    return res.json({
      success: true,
      message: 'Manual reconciliation completed',
      data: result,
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /payment/status/:paymentId ───────────────────────────────────────────
exports.getPaymentStatus = async (req, res, next) => {
  try {
    const { paymentId } = req.params;
    const userId = req.user.id;

    const result = await db.query(
      `SELECT
         p.id, p.razorpay_payment_id, p.razorpay_order_id,
         p.amount, p.currency, p.status, p.created_at,
         b.id           AS booking_id,
         b.status       AS booking_status,
         b.payment_status,
         t.title        AS trip_title,
         t.location     AS trip_location
       FROM payments p
       LEFT JOIN bookings b ON p.booking_id = b.id
       LEFT JOIN trips    t ON b.trip_id    = t.id
       WHERE p.id = $1 OR p.razorpay_payment_id = $1
         AND (p.user_id = $2 OR $3 = 'admin')`,
      [paymentId, userId, req.user.role]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        code: 'PAYMENT_NOT_FOUND',
        message: 'Payment not found',
      });
    }

    return res.json({ success: true, data: { payment: result.rows[0] } });
  } catch (err) {
    next(err);
  }
};

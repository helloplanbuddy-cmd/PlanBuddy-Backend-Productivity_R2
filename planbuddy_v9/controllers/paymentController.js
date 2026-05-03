'use strict';

/**
 * controllers/paymentController.js — Payment Controller (v6.0)
 *
 * 🚀 PHASE 2B — PlanBuddy v6.0 Full Observability
 *
 * UPGRADES from v4.0:
 *  1. Structured logging with trace_id, booking_id, user_id on every log line
 *  2. Payment audit trail via paymentAuditService (payment_created, webhook events)
 *  3. Business metrics tracking via metricsService
 *  4. Critical alert logging for signature mismatch, webhook failure
 */

const Razorpay         = require('razorpay');
const RazorpayService  = require('../services/razorpayService.js');
const razorpayConfig   = require('../config/razorpay.js');
const db               = require('../config/db.js');
const logger           = require('../utils/logger.js');
const monitoring       = require('../utils/monitoring.js');
// 🚀 PHASE 2B: Payment audit trail
const PaymentAudit     = require('../services/paymentAuditService.js');
// 🚀 PHASE 2B: Business metrics
const metrics          = require('../services/metricsService.js');
// 🚀 PHASE 2B: Trace context updater
const { updateTraceContext } = require('../middleware/traceId.js');

// Razorpay client for order creation
let razorpayClient = null;
try {
  if (razorpayConfig.keyId && razorpayConfig.keySecret) {
    razorpayClient = new Razorpay({
      key_id:     razorpayConfig.keyId,
      key_secret: razorpayConfig.keySecret,
    });
  }
} catch (_) {}

// ─── POST /payment/create-order ───────────────────────────────────────────────
exports.createOrder = async (req, res, next) => {
  try {
    const { bookingId } = req.body;
    if (!bookingId) {
      return res.status(400).json({
        success: false,
        code:    'VALIDATION_ERROR',
        message: 'bookingId is required',
      });
    }

    // Fetch booking and verify ownership
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
        code:    'BOOKING_NOT_FOUND',
        message: 'Booking not found',
      });
    }

    const booking = bookingResult.rows[0];

    // 🔥 CRITICAL FIX — Server-side amount validation BEFORE Razorpay order creation
    // Prevent charging wrong amounts if booking total_amount was tampered or miscalculated
    const expectedAmount = booking.price * booking.group_size;
    if (booking.total_amount !== expectedAmount) {
      logger.error({
        service:    'payment',
        booking_id: bookingId,
        user_id:    req.user.id,
        expected:   expectedAmount,
        actual:     booking.total_amount,
        requestId:  req.requestId,
        traceId:    req.traceId,
      }, '[payment] Amount validation failed: booking total_amount does not match trip price * group_size');
      return res.status(400).json({
        success: false,
        code:    'AMOUNT_VALIDATION_FAILED',
        message: 'Booking amount validation failed. Please contact support.',
      });
    }

    // Additional safety: ensure trip is still active
    if (!booking.is_active) {
      return res.status(409).json({
        success: false,
        code:    'TRIP_INACTIVE',
        message: 'Trip is no longer available',
      });
    }

    // 🔥 PHASE 1 FIX — Only allow order creation for pending/unpaid bookings
    if (booking.status !== 'pending' || booking.payment_status !== 'unpaid') {
      return res.status(409).json({
        success: false,
        code:    'BOOKING_NOT_ELIGIBLE',
        message: `Cannot create order: booking status is "${booking.status}" / payment is "${booking.payment_status}"`,
      });
    }

    if (!razorpayClient) {
      return res.status(503).json({
        success: false,
        code:    'PAYMENT_SERVICE_UNAVAILABLE',
        message: 'Payment service unavailable',
      });
    }

    const amountPaise = razorpayConfig.toSubunit(booking.total_amount);

    const order = await razorpayClient.orders.create({
      amount:   amountPaise,
      currency: booking.currency || 'INR',
      receipt:  bookingId.replace(/-/g, '').slice(0, 40),
      notes: {
        booking_id: bookingId,
        user_id:    req.user.id,
      },
    });

    // 🔥 CRITICAL FIX — Atomically persist order → booking mapping AND update payment record
    // Razorpay order creation is outside the transaction (unavoidable API call).
    // But both DB writes must be atomic: if the INSERT fails, we must NOT update the payment record.
    // If the process crashes between these two writes, the mapping exists but the payment
    // record lacks the order_id, causing webhook ORDER_NOT_MAPPED failures.
    // This is a dead-letter scenario that cascades through reconciliation forever.
    await db.transaction(async (client) => {
      // Step 1: Insert order → booking mapping
      await client.query(
        `INSERT INTO razorpay_order_mappings
           (razorpay_order_id, booking_id, user_id, amount, currency)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (razorpay_order_id) DO NOTHING`,
        [order.id, bookingId, req.user.id, booking.total_amount, 'INR']
      );

      // Step 2: Update payment record with razorpay_order_id (both in same transaction)
      // The payment record (status='created') was created in atomicBookingTransaction.
      // We update it here with the order ID so reconciliation can match later.
      await client.query(
        `UPDATE payments
         SET razorpay_order_id = $1, updated_at = NOW()
         WHERE booking_id = $2 AND status = 'created'`,
        [order.id, bookingId]
      );
    });

    logger.info({
      service:    'payment',
      booking_id: bookingId,
      order_id:   order.id,
      amount:     amountPaise,
      requestId:  req.requestId,
      traceId:    req.traceId,
      user_id:    req.user.id,
    }, '[payment] Razorpay order created');

    // 🚀 PHASE 2B: Audit log — payment_created event
    await PaymentAudit.logPaymentCreated({
      bookingId,
      paymentId:  order.id,
      traceId:    req.traceId,
      userId:     req.user.id,
      metadata:   { order_id: order.id, amount_paise: amountPaise },
    });

    // 🚀 PHASE 2B: Metrics
    metrics.recordPaymentAttempted();

    // 🚀 PHASE 2B: Update trace context with booking_id
    updateTraceContext({ booking_id: bookingId });

    res.json({
      success: true,
      data: {
        orderId:   order.id,
        amount:    amountPaise,
        currency:  'INR',
        keyId:     razorpayConfig.keyId,
        bookingId,
      },
    });
  } catch (err) {
    monitoring.payment_failures_total?.inc({ reason: 'order_creation_failed' });
    // 🔥 PHASE 1 FIX — Structured error; no raw Razorpay SDK errors to client
    if (err.code && err.structured) {
      return res.status(err.status || 500).json(err.structured);
    }
    next(err);
  }
};

// ─── POST /payment/verify-payment ────────────────────────────────────────────
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
        code:    'VALIDATION_ERROR',
        message: 'razorpay_order_id, razorpay_payment_id, and razorpay_signature are required',
      });
    }

    // Signature verification (throws structured error on failure)
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

    logger.info({
      service:    'payment',
      booking_id: result.data?.booking?.id,
      payment_id: razorpay_payment_id,
      order_id:   razorpay_order_id,
      user_id:    req.user.id,
      requestId:  req.requestId,
      traceId:    req.traceId,
      idempotent: result.idempotent,
    }, '[payment] Payment verified and confirmed');

    res.json({
      success: true,
      message: result.idempotent ? 'Payment already processed' : 'Payment verified and booking confirmed',
      data:    result.data,
    });
  } catch (err) {
    monitoring.payment_failures_total?.inc({ reason: err.message?.slice(0, 50) || 'unknown' });

    // 🔥 PHASE 1 FIX — Structured error responses
    if (err.code && err.structured) {
      return res.status(err.status || 400).json(err.structured);
    }
    if (err.status === 400 || err.status === 403 || err.status === 404 || err.status === 409) {
      return res.status(err.status).json({
        success: false,
        code:    err.code || 'PAYMENT_ERROR',
        message: err.message,
      });
    }
    next(err);
  }
};

// ─── POST /admin/reconcile ───────────────────────────────────────────────────
exports.manualReconcile = async (req, res, next) => {
  try {
    logger.info('Manual reconciliation triggered by admin', {
      userId: req.user.id,
      requestId: req.requestId,
    });

    // Trigger reconciliation (idempotent)
    const { runReconciliation } = require('../workers/paymentReconciliation.worker.js');
    const result = await runReconciliation();

    res.json({
      success: true,
      message: 'Manual reconciliation completed',
      data:    result,
    });
  } catch (err) {
    next(err);
  }
};

// ─── POST /payment/webhook/razorpay ───────────────────────────────────────────
exports.razorpayWebhook = async (req, res, next) => {
  const signature     = req.headers['x-razorpay-signature'];
  const correlationId = req.requestId;

  try {
    // Fintech: Webhook retry storm detector
    const redis = require('../config/redis.js').redis;
    const paymentId = req.body.razorpay_payment_id;
    if (paymentId) {
      const retryKey = `webhook_retry:${paymentId}`;
      const retries = await redis.incr(retryKey);
      if (retries === 1) await redis.expire(retryKey, 300); // 5min TTL
      if (retries > 3) {
        const { alertSystemOverload } = require('../services/alertingService.js');
        await alertSystemOverload('webhook_retries', retries, 3);
        monitoring.webhook_retry_storm_total?.inc();
      }
    }

    if (!Buffer.isBuffer(req.body)) {
      monitoring.webhook_errors_total?.inc({ type: 'not_buffer' });
      return res.status(400).json({
        success: false,
        code:    'INVALID_WEBHOOK_BODY',
        message: 'Invalid webhook body',
      });
    }

    const result = await RazorpayService.processWebhook(req.body, signature, correlationId);

    res.json({ success: true, data: result });
  } catch (err) {
    monitoring.webhook_errors_total?.inc({
      type: err.code === 'WEBHOOK_SIGNATURE_INVALID' ? 'sig_fail' : 'processing_error',
    });

    logger.error({
      service:      'webhook',
      correlationId,
      traceId:      req.traceId,
      error:        err.message,
      code:         err.code,
    }, '[webhook] Webhook processing error');

    // 🚀 PHASE 2B: Audit + metrics for webhook failure
    await PaymentAudit.logWebhookFailed({
      errorMessage: err.message,
      traceId:      req.traceId || correlationId,
    }).catch(() => {});

    // 🔥 PHASE 1 FIX — Return 400 for signature failures; 200 for idempotent/mapping errors
    if (err.code === 'WEBHOOK_SIGNATURE_INVALID' || err.code === 'SIGNATURE_MISMATCH') {
      return res.status(400).json({
        success: false,
        code:    err.code,
        message: 'Webhook signature invalid',
      });
    }
    // Return 200 for errors that won't self-resolve (booking not found, already processed)
    // so Razorpay doesn't trigger retry storms
    if (err.status === 404 || err.status === 409) {
      return res.status(200).json({
        success: false,
        code:    err.code || 'WEBHOOK_ERROR',
        message: err.message,
      });
    }
    next(err);
  }
};

// ─── GET /payment/status/:paymentId ──────────────────────────────────────────
exports.getPaymentStatus = async (req, res, next) => {
  try {
    const { paymentId } = req.params;
    const userId        = req.user.id;

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
       WHERE p.razorpay_payment_id = $1
         AND (p.user_id = $2 OR $3 = 'admin')`,
      [paymentId, userId, req.user.role]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        code:    'PAYMENT_NOT_FOUND',
        message: 'Payment not found',
      });
    }

    res.json({ success: true, data: { payment: result.rows[0] } });
  } catch (err) {
    next(err);
  }
};

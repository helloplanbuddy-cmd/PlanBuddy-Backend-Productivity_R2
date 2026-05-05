'use strict';

/**
 * controllers/paymentController.js — Payment Controller (v6.1)
 *
 * 🚀 PHASE 2B — PlanBuddy v6.0 Full Observability
 *
 * Fixes applied (v6.0 → v6.1):
 *  1. REMOVED duplicate `new Razorpay(...)` instantiation block (lines 34–40 of v6.0).
 *     The singleton client now comes exclusively from config/razorpay.js.
 *  2. REPLACED `razorpayConfig.toSubunit(...)` with `rupeesToPaise(...)` — the
 *     correctly exported function name — eliminating the runtime TypeError.
 *  3. Destructured `razorpay` (the client alias) and `rupeesToPaise` directly from
 *     the config import so usage is explicit and grep-able.
 *  4. Removed the `require('razorpay')` SDK import — no controller should ever
 *     import the raw SDK; all SDK access goes through config/razorpay.js.
 *
 * No changes to route handlers, request/response shapes, or business logic.
 */

// ─── REMOVED: `const Razorpay = require('razorpay');`
// The raw SDK must never be imported outside config/razorpay.js.

const RazorpayService  = require('../services/razorpayService.js');

// Destructure the singleton client and the correctly named conversion helper.
// `razorpay` is the SDK instance; `rupeesToPaise` replaces the broken `toSubunit` call.
const {
  razorpay:      razorpayClient,  // singleton — already initialised in config/razorpay.js
  rupeesToPaise,
  keyId:         razorpayKeyId,
  webhookSecret: razorpayWebhookSecret,
} = require('../config/razorpay.js');

const db               = require('../config/db.js');
const logger           = require('../utils/logger.js');
const monitoring       = require('../utils/monitoring.js');
// 🚀 PHASE 2B: Payment audit trail
const PaymentAudit     = require('../services/paymentAuditService.js');
// 🚀 PHASE 2B: Business metrics
const metrics          = require('../services/metricsService.js');
// 🚀 PHASE 2B: Trace context updater
const { updateTraceContext } = require('../middleware/traceId.js');

// ─── REMOVED: duplicate Razorpay instantiation block ─────────────────────────
//
// The following block from v6.0 has been deleted. It created a second SDK
// client with identical credentials, causing:
//   • two separate HTTP agent pools (double keep-alive connections to Razorpay)
//   • two separate retry/timeout configurations (whichever was set last "won")
//   • silent config drift if env vars changed between module load ordering
//
// let razorpayClient = null;
// try {
//   if (razorpayConfig.keyId && razorpayConfig.keySecret) {
//     razorpayClient = new Razorpay({ key_id: ..., key_secret: ... });
//   }
// } catch (_) {}
//
// The `razorpayClient` variable above now comes from config/razorpay.js.
// The null-guard (`if (!razorpayClient)`) below is retained as a safety net;
// in practice it can never fire because config/env.js exits on missing keys.
// ─────────────────────────────────────────────────────────────────────────────

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

    // Safety net: config/env.js should have exited before we reach this point
    // if the SDK could not be initialised, but we guard defensively regardless.
    if (!razorpayClient) {
      return res.status(503).json({
        success: false,
        code:    'PAYMENT_SERVICE_UNAVAILABLE',
        message: 'Payment service unavailable',
      });
    }

    // ✅ FIX: was `razorpayConfig.toSubunit(booking.total_amount)` — caused TypeError.
    // Now uses the correctly named `rupeesToPaise` imported from config/razorpay.js.
    const amountPaise = rupeesToPaise(booking.total_amount);

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
        keyId:     razorpayKeyId,   // ✅ sourced from config import, not a local const
        bookingId,
      },
    });
  } catch (err) {
    monitoring.payment_failures_total?.inc({ reason: 'order_creation_failed' });
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

// Txn webhook + event_id UNIQUE
exports.razorpayWebhook = async (req, res, next) => {
  const signature = req.headers['x-razorpay-signature'];
  const correlationId = req.requestId;
  const body = req.body;
  const eventId = body.razorpay_event_id || body.razorpay_payment_id; // fallback

  try {
    // Sig verify
    RazorpayService.verifySignature(`${body.razorpay_order_id}|${body.razorpay_payment_id}`, signature);

    // Txn: INSERT event (UNIQUE) + process
    const result = await db.transaction(async (client) => {
      // Insert event - fails on dup
      await client.query(`
        INSERT INTO webhook_events (razorpay_event_id, event_type, payload, correlation_id)
        VALUES ($1, $2, $3, $4)
      `, [eventId, body.event, JSON.stringify(body), correlationId]);

      // Process
      return await RazorpayService.processPaymentTransaction(
        body.razorpay_order_id, body.razorpay_payment_id, 
        body.amount, 'INR', null, correlationId, client
      );
    });

    res.json({ success: true });
  } catch (err) {
    if (err.code === '23505') { // UNIQUE violation - idempotent OK
      res.status(200).json({ success: true, idempotent: true });
    } else {
      next(err);
    }
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
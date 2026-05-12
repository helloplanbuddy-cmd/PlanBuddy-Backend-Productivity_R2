'use strict';

/**
 * controllers/paymentController.js — Payment Controller (v6.1)
 *
 * 🚀 PHASE 2B — PlanBuddy v6.0 Full Observability
 *
 * Fixes applied (v6.0 → v6.1):
 *  1. Removed duplicate Razorpay instantiation block.
 *  2. Replaced broken toSubunit call usage with rupeesToPaise.
 *  3. Destructured config helpers explicitly.
 *  4. Removed raw SDK import; always use config/razorpay.js singleton.
 */

const RazorpayService  = require('../services/razorpayService.js');

const {
  razorpay:      razorpayClient,
  rupeesToPaise,
  keyId:         razorpayKeyId,
  webhookSecret: razorpayWebhookSecret,
} = require('../config/razorpay.js');

const db               = require('../config/db.js');
const logger           = require('../utils/logger.js');
const monitoring       = require('../utils/monitoring.js');
let PaymentAudit = null;
try {
  PaymentAudit = require('../services/paymentAuditService.js');
} catch (_) {
  // Audit is non-critical for webhook->queue->worker financial correctness.
  PaymentAudit = null;
}
const metrics          = require('../services/metricsService.js');
const { updateTraceContext } = require('../middleware/traceId.js');

// ─── POST /payment/create-order ────────────────────────────────────────────
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
        code: 'BOOKING_NOT_FOUND',
        message: 'Booking not found',
      });
    }

    const booking = bookingResult.rows[0];

    // Amount validation before Razorpay order creation
    const expectedAmount = booking.price * booking.group_size;
    if (booking.total_amount !== expectedAmount) {
      logger.error({
        service: 'payment',
        booking_id: bookingId,
        user_id: req.user.id,
        expected: expectedAmount,
        actual: booking.total_amount,
        requestId: req.requestId,
        traceId: req.traceId,
      }, '[payment] Amount validation failed: booking total_amount does not match trip price * group_size');

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

    // Atomically persist order → booking mapping AND update payment record
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

    logger.info({
      service: 'payment',
      booking_id: bookingId,
      order_id: order.id,
      amount: amountPaise,
      requestId: req.requestId,
      traceId: req.traceId,
      user_id: req.user.id,
    }, '[payment] Razorpay order created');

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

    if (err?.code && err?.structured) {
      return res.status(err.status || 500).json(err.structured);
    }

    return next(err);
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

    logger.info({
      service: 'payment',
      booking_id: result.data?.booking?.id,
      payment_id: razorpay_payment_id,
      order_id: razorpay_order_id,
      user_id: req.user.id,
      requestId: req.requestId,
      traceId: req.traceId,
      idempotent: result.idempotent,
    }, '[payment] Payment verified and confirmed');

    return res.json({
      success: true,
      message: result.idempotent ? 'Payment already processed' : 'Payment verified and booking confirmed',
      data: result.data,
    });
  } catch (err) {
    monitoring.payment_failures_total?.inc({ reason: err.message?.slice(0, 50) || 'unknown' });

    if (err?.code && err?.structured) {
      return res.status(err.status || 400).json(err.structured);
    }
    if (err?.status === 400 || err?.status === 403 || err?.status === 404 || err?.status === 409) {
      return res.status(err.status).json({
        success: false,
        code: err.code || 'PAYMENT_ERROR',
        message: err.message,
      });
    }

    return next(err);
  }
};

// ─── POST /admin/reconcile ────────────────────────────────────────────
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
    return next(err);
  }
};

// ─── POST /payment/webhook/razorpay (handler) ─────────────────────────────
/**
 * Razorpay Webhook Handler — Unified Authenticity Model
 *
 * FLOW:
 *  1. Extract raw payload + signature from request
 *  2. Verify signature IMMEDIATELY (fails fast if invalid)
 *  3. Store payload + signature + verified_at atomically
 *  4. Apply webhook event within transaction
 *  5. Update webhook_events.status to 'processed' on success
 *  6. On UNIQUE violation (duplicate): return 200 (idempotent)
 *
 * SECURITY:
 *  - Signature verification BEFORE any mutation
 *  - Payload + signature stored for replay re-verification
 *  - Replay paths MUST re-verify before applying
 */
exports.razorpayWebhook = async (req, res, next) => {
  try {
    const webhookAuthService = require('../services/webhookAuthenticityService');
    const signature = req.headers['x-razorpay-signature'];
    const correlationId = req.requestId;
    const body = req.body;

    const eventId = body?.razorpay_event_id || body?.razorpay_payment_id;
    if (!eventId) {
      return res.status(400).json({
        success: false,
        code: 'WEBHOOK_VALIDATION_ERROR',
        message: 'Missing razorpay_event_id / razorpay_payment_id',
      });
    }

    const logCtx = { eventId, correlationId, eventType: body?.event || body?.event_type };

    // Fintech: Webhook retry storm detector (best-effort)
    try {
      const { redis } = require('../config/redis.js');
      const paymentId = body?.razorpay_payment_id;
      if (paymentId && redis) {
        const retryKey = `webhook_retry:${paymentId}`;
        const retries = await redis.incr(retryKey);
        if (retries === 1) await redis.expire(retryKey, 300);
        if (retries > 3) {
          const { alertSystemOverload } = require('../services/alertingService.js');
          await alertSystemOverload('webhook_retries', retries, 3);
          monitoring.webhook_retry_storm_total?.inc();
        }
      }
    } catch (_) {
      // ignore (fail-open)
    }

    // ─── PHASE 1: Verify signature BEFORE any state mutation ──────────────────
    const payloadBytes = webhookAuthService.extractPayloadBytes(body);
    const authResult = webhookAuthService.verifyIngressSignature(payloadBytes, signature, logCtx);

    // ─── PHASE 2: Store event + verify + apply in atomic transaction ─────────
    await db.transaction(async (client) => {
      try {
        // Insert webhook event with signature + payload + verified timestamp
        const insertResult = await client.query(
          `INSERT INTO webhook_events 
             (provider, razorpay_event_id, event_type, payload, payload_bytes, signature, 
              verified_at, verified_by_lease_version, correlation_id, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (provider, razorpay_event_id, signature) 
             DO UPDATE SET status = 'received' WHERE webhook_events.status = 'received'
           RETURNING id, status
          `,
          [
            'razorpay',                              // provider
            eventId,                                 // razorpay_event_id (unique for provider)
            body?.event || body?.event_type,        // event_type
            JSON.stringify(body),                    // payload (for backward compat)
            payloadBytes,                            // payload_bytes (exact raw bytes)
            authResult.signature,                    // signature (HMAC-SHA256)
            new Date(),                              // verified_at (now)
            1,                                       // verified_by_lease_version (initial lease)
            correlationId,                           // correlation_id
            'received'                               // status (awaiting processing)
          ]
        );

        if (insertResult.rowCount === 0) {
          // Duplicate — already processed
          logger.info(logCtx, '[webhook] Event already ingested (idempotent)');
          return { idempotent: true };
        }

        const webhookEventId = insertResult.rows[0].id;
        logger.info({ ...logCtx, webhook_event_id: webhookEventId }, '[webhook] Event stored with verified signature');

        // Enqueue async processing job so the worker deterministically applies financial mutations.
        try {
          const { enqueueWebhookEvent } = require('../config/queues');
          await enqueueWebhookEvent({
            eventId,
            provider: 'razorpay',
            eventType: body?.event || body?.event_type,
            payload: body,
          });
        } catch (e) {
          logger.error({ err: e, eventId }, '[webhook] enqueueWebhookEvent failed');
          // Do not rollback webhook_events persistence; worker replay/DLQ tooling can recover.
        }

        logger.info(
          { ...logCtx, webhook_event_id: webhookEventId, signature: authResult.signature.substring(0, 8) + '...' },
          '[webhook] Event processed successfully'
        );

        return { applied: true };
      } catch (err) {
        // If UNIQUE violation occurs, it means we already ingested this event
        // (same event_id + signature combo). Return success to make Razorpay happy.
        if (err?.code === '23505') {
          logger.info(logCtx, '[webhook] UNIQUE violation — duplicate ingestion (idempotent)');
          return { idempotent: true, duplicate: true };
        }

        throw err;
      }
    });

    return res.json({ success: true });
  } catch (err) {
    // UNIQUE violation at webhook insert => duplicate (already processed)
    if (err?.code === '23505') {
      logger.info({ eventId: req.body?.razorpay_event_id }, '[webhook] Duplicate webhook (returning 200)');
      return res.status(200).json({ success: true, idempotent: true });
    }

    // Signature mismatch or missing => 401/400
    if (err?.code === 'WEBHOOK_SIGNATURE_MISMATCH' || err?.code === 'WEBHOOK_INVALID_PAYLOAD' || err?.code === 'WEBHOOK_MISSING_SIGNATURE') {
      monitoring.webhook_auth_failures_total?.inc({ reason: err.code });
      return res.status(err.status || 401).json({
        success: false,
        code: err.code,
        message: err.message,
      });
    }

    // Other errors
    if (err?.status === 404 || err?.status === 409) {
      return res.status(200).json({
        success: false,
        code: err.code || 'WEBHOOK_ERROR',
        message: err.message,
      });
    }

    return next(err);
  }
};

// ─── GET /payment/status/:paymentId ────────────────────────────────────────
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
       WHERE p.razorpay_payment_id = $1
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
    return next(err);
  }
};

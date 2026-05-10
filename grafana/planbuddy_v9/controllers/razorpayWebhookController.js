'use strict';

const crypto = require('crypto');
const env = require('../config/env');
const logger = require('../utils/logger');
const db = require('../config/db');

function getSignature(req) {
  return req.headers['x-razorpay-signature'];
}

function verifySignature(rawBodyBuffer, signature, secret) {
  if (!Buffer.isBuffer(rawBodyBuffer)) return false;
  if (!secret || typeof secret !== 'string') return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBodyBuffer)
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const signatureBuf = Buffer.from(String(signature || ''), 'utf8');
  if (expectedBuf.length !== signatureBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}

function safeJson(raw) {
  try {
    return JSON.stringify(raw);
  } catch {
    return '[unserializable]';
  }
}

function extractEventId(payload) {
  return (
    payload?.event?.id ||
    payload?.payload?.event?.id ||
    payload?.id ||
    payload?.payload?.id ||
    null
  );
}

function extractEventType(payload) {
  return payload?.event || payload?.payload?.event || null;
}

function extractPaymentEntityId(payload) {
  // Razorpay standard webhook nested shape:
  // payload.payment.entity.id
  return (
    payload?.payload?.payment?.entity?.id ||
    payload?.payment?.entity?.id ||
    payload?.event?.payload?.payment?.entity?.id ||
    null
  );
}

async function insertWebhookEvent(client, { eventId, provider, type, payloadJson }) {
  const result = await client.query(
    `INSERT INTO webhook_events (event_id, provider, type, payload, status)
     VALUES ($1, $2, $3, $4, 'pending')
     ON CONFLICT (event_id) DO NOTHING
     RETURNING id, event_id, status`,
    [eventId, provider, type, payloadJson]
  );
  return result.rows.length > 0;
}

async function setWebhookEventStatus(client, { eventId, status }) {
  await client.query(
    `UPDATE webhook_events
       SET status = $1,
           processed_at = NOW()
     WHERE event_id = $2`,
    [status, eventId]
  );
}

// Maps payment.* events to app state.
async function applyPaymentEvent(client, { eventType, paymentId }) {
  // Validate paymentId exists
  if (!paymentId) {
    throw Object.assign(new Error('Missing payment identifier in webhook payload'), {
      code: 'WEBHOOK_BAD_PAYLOAD',
      status: 400,
    });
  }

  // Ensure exactly-once behavior: ONLY mutate if payment row is still in 'created'
  // and status transition makes sense.
  if (eventType === 'payment.captured') {
    // Update payment + booking atomically. We rely on DB relationships:
    // payments.booking_id references bookings(id)
    const updateRes = await client.query(
      `UPDATE payments p
         SET status = 'captured',
             updated_at = NOW()
       WHERE p.razorpay_payment_id = $1
         AND p.status = 'created'
       RETURNING p.id AS payment_row_id, p.booking_id`,
      [paymentId]
    );

    if (updateRes.rows.length === 0) {
      // Already processed or unknown payment record. Treat as idempotent success.
      return { applied: false };
    }

    const bookingId = updateRes.rows[0].booking_id;
    await client.query(
      `UPDATE bookings
         SET status = 'confirmed',
             payment_status = 'paid',
             updated_at = NOW()
       WHERE id = $1
         AND payment_status NOT IN ('paid', 'refunded')`,
      [bookingId]
    );

    return { applied: true };
  }

  if (eventType === 'payment.failed') {
    const updateRes = await client.query(
      `UPDATE payments p
         SET status = 'failed',
             updated_at = NOW()
       WHERE p.razorpay_payment_id = $1
         AND p.status IN ('created', 'captured')
       RETURNING p.id AS payment_row_id`,
      [paymentId]
    );

    if (updateRes.rows.length === 0) {
      return { applied: false };
    }

    // Booking terminal handling: set booking as cancelled.
    // This avoids forcing invalid state transitions on legacy rows.
    // (Existing state machine prevents some transitions.)
    await client.query(
      `UPDATE bookings b
         SET status = 'cancelled',
             payment_status = 'failed',
             updated_at = NOW()
       WHERE id = (SELECT booking_id FROM payments WHERE razorpay_payment_id = $1 LIMIT 1)
         AND b.payment_status NOT IN ('paid', 'refunded')`,
      [paymentId]
    );

    return { applied: true };
  }

  // Unknown event types: no mutation. Caller will still mark webhook processed.
  return { applied: false, ignored: true };
}

// ─── Refund Event Handling ─────────────────────────────────────────────────────

/**
 * Extract refund entity ID from webhook payload
 */
function extractRefundEntityId(payload) {
  return (
    payload?.payload?.refund?.entity?.id ||
    payload?.refund?.entity?.id ||
    payload?.event?.payload?.refund?.entity?.id ||
    null
  );
}

/**
 * Extract payment entity ID from refund webhook payload
 */
function extractRefundPaymentId(payload) {
  return (
    payload?.payload?.refund?.entity?.payment_id ||
    payload?.refund?.entity?.payment_id ||
    payload?.event?.payload?.refund?.entity?.payment_id ||
    null
  );
}

/**
 * Maps refund.* events to app state.
 * 
 * Refund State Machine:
 *   initiated → processing → succeeded (terminal)
 *   initiated → processing → failed → initiated (retry)
 *   failed → cancelled (terminal)
 */
async function applyRefundEvent(client, { eventType, payload }) {
  const refundId = extractRefundEntityId(payload);
  const paymentId = extractRefundPaymentId(payload);

  if (!refundId) {
    throw Object.assign(new Error('Missing refund identifier in webhook payload'), {
      code: 'WEBHOOK_BAD_PAYLOAD',
      status: 400,
    });
  }

  if (!paymentId) {
    throw Object.assign(new Error('Missing payment identifier in refund webhook payload'), {
      code: 'WEBHOOK_BAD_PAYLOAD',
      status: 400,
    });
  }

  // Map Razorpay refund status to our internal status
  // Razorpay statuses: created, processed, failed, cancelled
  const razorpayStatus = payload?.payload?.refund?.entity?.status || 
                         payload?.refund?.entity?.status || 
                         null;

  if (!razorpayStatus) {
    logger.warn({ refundId, paymentId }, '[webhook] Refund status missing in payload');
    return { applied: false, ignored: true };
  }

  // Determine our internal status based on Razorpay status
  let internalStatus;
  switch (razorpayStatus) {
    case 'processed':
      internalStatus = 'succeeded';
      break;
    case 'failed':
      internalStatus = 'failed';
      break;
    case 'cancelled':
      internalStatus = 'cancelled';
      break;
    case 'created':
      internalStatus = 'processing';
      break;
    default:
      internalStatus = 'processing';
  }

  // Find the payment in our DB
  const paymentResult = await client.query(
    `SELECT id, booking_id FROM payments WHERE razorpay_payment_id = $1`,
    [paymentId]
  );

  if (paymentResult.rows.length === 0) {
    logger.warn({ refundId, paymentId }, '[webhook] Payment not found for refund webhook');
    return { applied: false, ignored: true };
  }

  const payment = paymentResult.rows[0];

  // Check for existing refund record by Razorpay refund ID
  const existingRefund = await client.query(
    `SELECT id, status FROM refunds 
     WHERE razorpay_refund_id = $1 
     FOR UPDATE`,
    [refundId]
  );

  if (existingRefund.rows.length > 0) {
    // Update existing refund
    const refund = existingRefund.rows[0];
    
    // Only update if status is changing (idempotency)
    if (refund.status === internalStatus) {
      logger.info({ refundId, paymentId, status: internalStatus }, 
        '[webhook] Refund already in this status (idempotent)');
      return { applied: false };
    }

    // Validate state transition before updating
    // Valid transitions: initiated → processing → succeeded/failed
    const currentStatus = refund.status;
    let newStatus = internalStatus;
    
    // If trying to jump from 'initiated' to 'succeeded', go through 'processing' first
    if (currentStatus === 'initiated' && internalStatus === 'succeeded') {
      newStatus = 'processing';
      logger.info({ refundId, paymentId, currentStatus, newStatus },
        '[webhook] Transitioning through processing state');
    }
    
    // If trying to jump from 'initiated' to 'failed', that's allowed
    // If trying to jump from 'processing' to 'succeeded' or 'failed', that's allowed
    
    await client.query(
      `UPDATE refunds 
       SET status = $1,
           razorpay_status = $2,
           updated_at = NOW()
       WHERE id = $3`,
      [newStatus, razorpayStatus, refund.id]
    );

    logger.info({ refundId, paymentId, oldStatus: currentStatus, newStatus: newStatus },
      '[webhook] Refund status updated');
    
    // If we transitioned to 'processing', we need to do another update to 'succeeded'
    if (newStatus === 'processing' && internalStatus === 'succeeded') {
      await client.query(
        `UPDATE refunds 
         SET status = 'succeeded',
             razorpay_status = 'processed',
             updated_at = NOW()
         WHERE id = $1`,
        [refund.id]
      );
      
      logger.info({ refundId, paymentId },
        '[webhook] Refund transitioned to succeeded');
    }
  } else {
    // Create new refund record (webhook arrived before API response)
    const amount = payload?.payload?.refund?.entity?.amount || 
                   payload?.refund?.entity?.amount || 0;

    await client.query(
      `INSERT INTO refunds (
        payment_id, booking_id, user_id, razorpay_refund_id,
        razorpay_payment_id, amount, status, razorpay_status,
        processed_by, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
      [
        payment.id,
        payment.booking_id,
        (await client.query('SELECT user_id FROM payments WHERE id = $1', [payment.id])).rows[0]?.user_id,
        refundId,
        paymentId,
        Math.round(amount / 100), // Convert from paise to rupees
        internalStatus,
        razorpayStatus,
        'webhook'
      ]
    );

    logger.info({ refundId, paymentId, status: internalStatus },
      '[webhook] Refund record created from webhook');
  }

  // If refund succeeded, ensure payment and booking are updated
  if (internalStatus === 'succeeded') {
    // Update payment from 'refund_pending' or 'captured' to 'refunded'
    // This handles both cases:
    // 1. API-initiated refund: payment is in 'refund_pending' state
    // 2. Webhook-arrived-first: payment is still in 'captured' state
    await client.query(
      `UPDATE payments 
       SET status = 'refunded', updated_at = NOW()
       WHERE id = $1 AND status IN ('refund_pending', 'captured')`,
      [payment.id]
    );

    // Update booking status only after refund is confirmed
    // This prevents premature booking cancellation if refund fails
    await client.query(
      `UPDATE bookings 
       SET payment_status = 'refunded',
           status = 'cancelled',
           updated_at = NOW()
       WHERE id = $1 AND payment_status != 'refunded'`,
      [payment.booking_id]
    );

    logger.info({ refundId, paymentId, bookingId: payment.booking_id, previousStatus: 'refund_pending' },
      '[webhook] Payment and booking marked as refunded after webhook confirmation');
  }

  return { applied: true, refundId, status: internalStatus };
}

// ─── Queue for async webhook processing ──────────────────────────────────────
// Use the pre-configured webhook queue from config/queues.js
const { webhookQueue } = require('../config/queues');

/**
 * POST /api/v1/webhooks/razorpay
 * 
 * HARDENED: Separates ingestion from processing.
 * 
 * Flow:
 *  1. Verify signature
 *  2. Persist event to DB (idempotent via unique constraint)
 *  3. Queue event for async processing
 *  4. Return 200 immediately
 * 
 * This ensures:
 *  - Fast ACK to Razorpay (no timeout risk)
 *  - Reliable retry via queue
 *  - Replay safety via event ID uniqueness
 */
exports.handleRazorpayWebhook = async (req, res) => {
  const requestId = req.requestId || `webhook-${Date.now()}`;
  
  try {
    const signature = getSignature(req);
    const rawBody = req.body;

    // ── Step 1: Validate signature ───────────────────────────────────────────
    if (!signature) {
      logger.error({ requestId }, '[webhook][razorpay] 🔴 SECURITY: Missing x-razorpay-signature header');
      return res.status(400).json({
        success: false,
        code: 'MISSING_SIGNATURE',
        message: 'x-razorpay-signature header required'
      });
    }

    if (!Buffer.isBuffer(rawBody)) {
      logger.error(
        { requestId, bodyType: typeof rawBody },
        '[webhook][razorpay] 🔴 Raw body missing/invalid (expected Buffer)'
      );
      return res.status(400).json({
        success: false,
        code: 'INVALID_BODY',
        message: 'Raw body required and must be valid'
      });
    }

    const secret = env.RAZORPAY_WEBHOOK_SECRET;
    const ok = verifySignature(rawBody, signature, secret);
    if (!ok) {
      logger.error({ requestId }, '[webhook][razorpay] 🔴 SECURITY: Signature verification FAILED - POSSIBLE ATTACK');
      // Return 403 Forbidden so Razorpay knows to stop retrying
      // Also increment security metric
      try {
        const metrics = require('../services/metricsService');
        metrics.incrementCounter('webhook_signature_failures_total', { provider: 'razorpay' });
      } catch (e) {}
      return res.status(403).json({
        success: false,
        code: 'SIGNATURE_INVALID',
        message: 'Webhook signature verification failed'
      });
    }

    // ── Step 2: Parse payload ────────────────────────────────────────────────
    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch (err) {
      logger.error({ requestId, err: err.message }, '[webhook][razorpay] 🔴 Payload JSON parse failed - malformed webhook');
      // Return 422 (Unprocessable Entity) so Razorpay retries
      return res.status(422).json({
        success: false,
        code: 'INVALID_JSON',
        message: 'Webhook payload is not valid JSON'
      });
    }

    const eventId = extractEventId(payload);
    if (!eventId) {
      logger.error(
        { requestId, eventPreview: safeJson(payload).slice(0, 200) },
        '[webhook][razorpay] 🔴 Missing event id - cannot ensure idempotency'
      );
      // Return 400 so webhook is considered failed
      return res.status(400).json({
        success: false,
        code: 'MISSING_EVENT_ID',
        message: 'Webhook event ID is required for idempotency'
      });
    }

    const provider = 'razorpay';
    const type = extractEventType(payload);

    logger.info({ requestId, eventId, type }, '[webhook][razorpay] Webhook received');

    // ── Step 3: Persist event (idempotent) ───────────────────────────────────
    // This is the ONLY synchronous DB operation - everything else is async
    await db.transaction(async (client) => {
      const inserted = await insertWebhookEvent(client, {
        eventId: String(eventId),
        provider,
        type: type || null,
        payloadJson: payload,
      });

      if (!inserted) {
        // Duplicate webhook - already persisted
        logger.info({ requestId, eventId }, '[webhook][razorpay] Duplicate event already persisted');
      }
    }, 'webhook_ingest');

    // ── Step 4: Queue for async processing ───────────────────────────────────
    try {
      await webhookQueue.add('process-webhook', {
        eventId: String(eventId),
        provider,
        eventType: type,
        payload,
        receivedAt: new Date().toISOString()
      }, {
        jobId: `webhook-${eventId}`, // Idempotent job ID
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 1000
        },
        removeOnComplete: {
          age: 3600, // Keep completed jobs for 1 hour
          count: 100
        },
        removeOnFail: {
          age: 86400 // Keep failed jobs for 24 hours
        }
      });

      logger.info({ requestId, eventId, type }, '[webhook][razorpay] Event queued for processing');
    } catch (queueErr) {
      // ✅ FIX CRIT-004: Queue failure MUST fail the webhook ACK
      // Event is persisted in DB but NEVER queued for processing.
      // Returning 200 would permanently lose the event.
      logger.error(
        { requestId, eventId, error: queueErr.message },
        '[webhook][razorpay] 🔴 CRITICAL: Failed to queue event — returning 500 for retry'
      );
      return res.status(500).json({
        success: false,
        code: 'QUEUE_ERROR',
        message: 'Retry later'
      });
    }

    // ── Step 5: ACK only after persistence + queuing succeed ──────────────────
    return res.status(200).json({ ok: true });
  } catch (err) {
    logger.error(
      { requestId, err: err.message, stack: err.stack },
      '[webhook][razorpay] 🔴 Handler error — NOT returning 200, event may be lost'
    );
    // ✅ FIX CRIT-003: Return 500 for transient errors so Razorpay retries
    // Only validation errors (signature, JSON, missing ID) return non-500 before this catch
    return res.status(500).json({
      success: false,
      code: 'PROCESSING_ERROR',
      message: 'Retry later'
    });
  }
};

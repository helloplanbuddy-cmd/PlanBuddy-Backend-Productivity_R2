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

function leaseFenceError() {
  return Object.assign(new Error('Webhook lease fencing failed (stale owner)'), {
    code: 'WEBHOOK_LEASE_FENCED',
    status: 409,
  });
}

function assertAffectedRows(affectedRows, err) {
  if (affectedRows === 0) throw err;
}

// Maps payment.* events to app state.
async function applyPaymentEvent(client, { eventType, paymentId, eventId, leaseVersion }) {
  if (!paymentId) {
    throw Object.assign(new Error('Missing payment identifier in webhook payload'), {
      code: 'WEBHOOK_BAD_PAYLOAD',
      status: 400,
    });
  }

  const fence = `
    AND EXISTS (
      SELECT 1
      FROM webhook_events
      WHERE event_id = $2
        AND lease_version = $3
    )
  `;

  if (eventType === 'payment.captured') {
    const updateRes = await client.query(
      `UPDATE payments p
         SET status = 'captured',
             updated_at = NOW()
       WHERE p.razorpay_payment_id = $1
         AND p.status IN ('created', 'pending')
         ${fence}
       FOR UPDATE OF p
       RETURNING p.id, p.booking_id`,
      [paymentId, eventId, leaseVersion]
    );

    assertAffectedRows(updateRes.rowCount, leaseFenceError());

    const { booking_id: bookingId } = updateRes.rows[0];

    const bookingRes = await client.query(
      `UPDATE bookings
         SET status = 'confirmed',
             payment_status = 'paid',
             updated_at = NOW()
       WHERE id = $1
         AND payment_status NOT IN ('paid', 'refunded')
         AND EXISTS (
           SELECT 1
           FROM webhook_events
           WHERE event_id = $2
             AND lease_version = $3
         )`,
      [bookingId, eventId, leaseVersion]
    );

    assertAffectedRows(bookingRes.rowCount, leaseFenceError());

    return { applied: true };
  }

  if (eventType === 'payment.failed') {
    const updateRes = await client.query(
      `UPDATE payments p
         SET status = 'failed',
             updated_at = NOW()
       WHERE p.razorpay_payment_id = $1
         AND p.status IN ('created', 'captured')
         ${fence}
       RETURNING p.id AS payment_row_id`,
      [paymentId, eventId, leaseVersion]
    );

    // If payment row didn't match the state predicate, treat as idempotent success.
    if (updateRes.rowCount === 0) return { applied: false };

    const bookingRes = await client.query(
      `UPDATE bookings b
         SET status = 'cancelled',
             payment_status = 'failed',
             updated_at = NOW()
       WHERE id = (
         SELECT booking_id
         FROM payments
         WHERE razorpay_payment_id = $1
         LIMIT 1
       )
         AND b.payment_status NOT IN ('paid', 'refunded')
         AND EXISTS (
           SELECT 1
           FROM webhook_events
           WHERE event_id = $2
             AND lease_version = $3
         )`,
      [paymentId, eventId, leaseVersion]
    );

    assertAffectedRows(bookingRes.rowCount, leaseFenceError());

    return { applied: true };
  }

  return { applied: false, ignored: true };
}

// Refund State Machine:
//   initiated → processing → succeeded (terminal)
//   initiated → processing → failed → initiated (retry)
//   failed → cancelled (terminal)
async function applyRefundEvent(client, { eventType, payload, eventId, leaseVersion }) {
  const refundId = payload?.payload?.refund?.entity?.id ||
                    payload?.refund?.entity?.id ||
                    payload?.event?.payload?.refund?.entity?.id ||
                    null;

  const paymentId = payload?.payload?.refund?.entity?.payment_id ||
                     payload?.refund?.entity?.payment_id ||
                     payload?.event?.payload?.refund?.entity?.payment_id ||
                     null;

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

  const razorpayStatus = payload?.payload?.refund?.entity?.status ||
                          payload?.refund?.entity?.status ||
                          null;

  if (!razorpayStatus) {
    logger.warn({ refundId, paymentId }, '[webhook] Refund status missing in payload');
    return { applied: false, ignored: true };
  }

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

  const fenceExists = `
    AND EXISTS (
      SELECT 1
      FROM webhook_events
      WHERE event_id = $2
        AND lease_version = $3
    )
  `;

  const fenceExistsInsert = `
    WHERE EXISTS (
      SELECT 1
      FROM webhook_events
      WHERE event_id = $2
        AND lease_version = $3
    )
  `;

  const paymentResult = await client.query(
    `SELECT id, booking_id FROM payments WHERE razorpay_payment_id = $1`,
    [paymentId]
  );

  if (paymentResult.rows.length === 0) {
    logger.warn({ refundId, paymentId }, '[webhook] Payment not found for refund webhook');
    return { applied: false, ignored: true };
  }

  const payment = paymentResult.rows[0];

  const existingRefund = await client.query(
    `SELECT id, status FROM refunds
     WHERE razorpay_refund_id = $1
     FOR UPDATE`,
    [refundId]
  );

  if (existingRefund.rows.length > 0) {
    const refund = existingRefund.rows[0];

    if (refund.status === internalStatus) {
      return { applied: false };
    }

    const currentStatus = refund.status;
    let newStatus = internalStatus;

    if (currentStatus === 'initiated' && internalStatus === 'succeeded') {
      newStatus = 'processing';
    }

    const refundUpdateRes = await client.query(
      `UPDATE refunds
         SET status = $1,
             razorpay_status = $2,
             updated_at = NOW()
       WHERE id = $3
         ${fenceExists}`,
      [newStatus, razorpayStatus, refund.id, eventId, leaseVersion]
    );

    assertAffectedRows(refundUpdateRes.rowCount, leaseFenceError());

    if (newStatus === 'processing' && internalStatus === 'succeeded') {
      const refundSecondRes = await client.query(
        `UPDATE refunds
           SET status = 'succeeded',
               razorpay_status = 'processed',
               updated_at = NOW()
         WHERE id = $1
           ${fenceExists}`,
        [refund.id, eventId, leaseVersion]
      );

      assertAffectedRows(refundSecondRes.rowCount, leaseFenceError());
    }

    if (newStatus === 'processing' && internalStatus === 'succeeded') {
      // done above
    }

    logger.info({ refundId, paymentId, oldStatus: currentStatus, newStatus }, '[webhook] Refund status updated');

    // If we need succeeded side effects, do them after refund state transition completes.
  } else {
    const amount = payload?.payload?.refund?.entity?.amount ||
                   payload?.refund?.entity?.amount ||
                   0;

    const userIdRes = await client.query('SELECT user_id FROM payments WHERE id = $1', [payment.id]);
    const userId = userIdRes.rows[0]?.user_id;

    // INSERT with deterministic fencing by converting to INSERT ... SELECT ...
    const insertRes = await client.query(
      `INSERT INTO refunds (
        payment_id, booking_id, user_id, razorpay_refund_id,
        razorpay_payment_id, amount, status, razorpay_status,
        processed_by, created_at
      )
      SELECT
        $1, $4, $5, $2,
        $3, $6, $7, $8,
        'webhook', NOW()
      FROM (SELECT 1) AS one
      ${fenceExistsInsert}`,
      [payment.id, refundId, paymentId, payment.booking_id, userId, Math.round(amount / 100), internalStatus, razorpayStatus, eventId, leaseVersion]
    );

    assertAffectedRows(insertRes.rowCount, leaseFenceError());
  }

  if (internalStatus === 'succeeded') {
    const paymentRes = await client.query(
      `UPDATE payments
         SET status = 'refunded',
             updated_at = NOW()
       WHERE id = $1
         AND status IN ('refund_pending', 'captured')
         AND EXISTS (
           SELECT 1
           FROM webhook_events
           WHERE event_id = $2
             AND lease_version = $3
         )`,
      [payment.id, eventId, leaseVersion]
    );

    assertAffectedRows(paymentRes.rowCount, leaseFenceError());

    const bookingRes = await client.query(
      `UPDATE bookings
         SET payment_status = 'refunded',
             status = 'cancelled',
             updated_at = NOW()
       WHERE id = $1
         AND payment_status != 'refunded'
         AND EXISTS (
           SELECT 1
           FROM webhook_events
           WHERE event_id = $2
             AND lease_version = $3
         )`,
      [payment.booking_id, eventId, leaseVersion]
    );

    assertAffectedRows(bookingRes.rowCount, leaseFenceError());
  }

  return { applied: true, refundId, status: internalStatus };
}

exports.handleRazorpayWebhook = async (req, res) => {
  const requestId = req.requestId || `webhook-${Date.now()}`;

  try {
    const signature = getSignature(req);
    const rawBody = req.body;

    if (!signature) {
      logger.error({ requestId }, '[webhook][razorpay] 🔴 SECURITY: Missing x-razorpay-signature header');
      return res.status(400).json({
        success: false,
        code: 'MISSING_SIGNATURE',
        message: 'x-razorpay-signature header required'
      });
    }

    if (!Buffer.isBuffer(rawBody)) {
      logger.error({ requestId, bodyType: typeof rawBody }, '[webhook][razorpay] 🔴 Raw body missing/invalid (expected Buffer)');
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
      try {
        const metrics = require('../services/metricsService');
        metrics.webhook_received_total.inc({ event_type: 'webhook_event', status: 'invalid_signature' });
      } catch (e) {
        logger.warn({ requestId, err: e.message }, '[webhook][razorpay] Failed to record webhook metric');
      }

      return res.status(403).json({
        success: false,
        code: 'SIGNATURE_INVALID',
        message: 'Webhook signature verification failed'
      });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch (err) {
      logger.error({ requestId, err: err.message }, '[webhook][razorpay] 🔴 Payload JSON parse failed - malformed webhook');
      return res.status(422).json({
        success: false,
        code: 'INVALID_JSON',
        message: 'Webhook payload is not valid JSON'
      });
    }

    const eventId = extractEventId(payload);
    if (!eventId) {
      logger.error({ requestId, eventPreview: safeJson(payload).slice(0, 200) }, '[webhook][razorpay] 🔴 Missing event id - cannot ensure idempotency');
      return res.status(400).json({
        success: false,
        code: 'MISSING_EVENT_ID',
        message: 'Webhook event ID is required for idempotency'
      });
    }

    const provider = 'razorpay';
    const type = extractEventType(payload);

    let leaseVersion = null;

    await db.transaction(async (client) => {
      const inserted = await insertWebhookEvent(client, {
        eventId: String(eventId),
        provider,
        type: type || null,
        payloadJson: payload,
      });

      if (!inserted) {
        logger.info({ requestId, eventId }, '[webhook][razorpay] Duplicate event already persisted');
      }

      // 🔒 STEP 2.1: Retrieve leaseVersion (fencing identity) at queue time
      // This ensures the job carries proof of which version it should process
      const versionRes = await client.query(
        `SELECT lease_version FROM webhook_events WHERE event_id = $1`,
        [String(eventId)]
      );
      leaseVersion = versionRes.rows[0]?.lease_version;

      if (leaseVersion === null || leaseVersion === undefined) {
        throw new Error('[FATAL] Failed to retrieve leaseVersion for webhook event');
      }
    }, 'webhook_ingest');

    const { webhookEventsQueue } = require('../config/queues');

    try {
      await webhookEventsQueue.add('process-webhook', {
        eventId: String(eventId),
        leaseVersion,
        provider,
        eventType: type,
        payload,
        receivedAt: new Date().toISOString()
      }, {
        jobId: `webhook-${eventId}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { age: 3600, count: 100 },
        removeOnFail: { age: 86400 }
      });
    } catch (queueErr) {
      logger.error({ requestId, eventId, error: queueErr.message }, '[webhook][razorpay] 🔴 CRITICAL: Failed to queue event — returning 500 for retry');
      return res.status(500).json({
        success: false,
        code: 'QUEUE_ERROR',
        message: 'Retry later'
      });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    logger.error({ requestId, err: err.message, stack: err.stack }, '[webhook][razorpay] 🔴 Handler error — NOT returning 200, event may be lost');
    return res.status(500).json({
      success: false,
      code: 'PROCESSING_ERROR',
      message: 'Retry later'
    });
  }
};

// Export controller functions for worker usage
exports.applyPaymentEvent = applyPaymentEvent;
exports.applyRefundEvent = applyRefundEvent;

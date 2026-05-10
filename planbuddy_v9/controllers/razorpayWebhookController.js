'use strict';

/**
 * controllers/razorpayWebhookController.js
 *
 * Webhook event application functions used by:
 *  - workers/webhook-processor.worker.js  (async BullMQ processing)
 *  - services/webhookReplayService.js      (manual replay)
 *
 * DESIGN RULES:
 *  1. Both functions receive an active DB client (already inside a transaction).
 *  2. NO external API calls (Razorpay, HTTP) inside these functions — callers
 *     are responsible for acquiring Razorpay data before calling here.
 *  3. All mutations are idempotent: WHERE clauses constrain to expected state.
 *  4. Return { applied: boolean, idempotent?: boolean } always.
 *
 * PAYMENT STATE MACHINE:
 *   created → captured (payment.captured)
 *   created | captured → failed (payment.failed)
 *
 * REFUND STATE MACHINE:
 *   (insert) → initiated (refund.created)
 *   initiated | processing → succeeded (refund.processed)
 *   initiated | processing → failed (refund.failed)
 *   initiated | processing → cancelled (refund.cancelled)
 */

const logger = require('../utils/logger');
const { rupeesToPaise, paiseToRupees } = require('../utils/money');

// ─── Payment event appliers ───────────────────────────────────────────────────

/**
 * Apply a payment.captured or payment.failed Razorpay event.
 *
 * @param {import('pg').PoolClient} client  - Active DB transaction client
 * @param {object} params
 * @param {string} params.eventType         - 'payment.captured' | 'payment.failed'
 * @param {string} params.paymentId         - Razorpay payment ID (pay_XXXXX)
 * @param {string} [params.eventId]         - webhook_events.event_id (for logging)
 * @param {number} [params.leaseVersion]    - Fencing token (for logging)
 * @returns {Promise<{applied: boolean, idempotent?: boolean, ignored?: boolean}>}
 */
async function applyPaymentEvent(client, { eventType, paymentId, eventId, leaseVersion } = {}) {
  if (!paymentId) {
    throw Object.assign(
      new Error('applyPaymentEvent: missing paymentId in webhook payload'),
      { code: 'WEBHOOK_BAD_PAYLOAD', status: 400 }
    );
  }

  const logCtx = { eventType, paymentId, eventId, leaseVersion };

  if (eventType === 'payment.captured') {
    // Idempotent UPDATE: only transitions from 'created' → 'captured'.
    // If already captured (prior replay), rowCount = 0 → idempotent.
    const paymentRes = await client.query(
      `UPDATE payments
         SET status     = 'captured',
             updated_at = NOW()
       WHERE razorpay_payment_id = $1
         AND status = 'created'
       RETURNING id, booking_id, amount`,
      [paymentId]
    );

    if (paymentRes.rowCount === 0) {
      logger.info(logCtx, '[webhook-ctrl] payment.captured idempotent (already captured or not found)');
      return { applied: false, idempotent: true };
    }

    const { booking_id: bookingId } = paymentRes.rows[0];

    if (bookingId) {
      await client.query(
        `UPDATE bookings
           SET status         = 'confirmed',
               payment_status = 'paid',
               updated_at     = NOW()
         WHERE id = $1
           AND payment_status NOT IN ('paid', 'refunded', 'partially_refunded')`,
        [bookingId]
      );
    }

    logger.info({ ...logCtx, bookingId }, '[webhook-ctrl] payment.captured applied');
    return { applied: true };
  }

  if (eventType === 'payment.failed') {
    const paymentRes = await client.query(
      `UPDATE payments
         SET status     = 'failed',
             updated_at = NOW()
       WHERE razorpay_payment_id = $1
         AND status IN ('created', 'captured')
       RETURNING id, booking_id`,
      [paymentId]
    );

    if (paymentRes.rowCount === 0) {
      logger.info(logCtx, '[webhook-ctrl] payment.failed idempotent (already in terminal state)');
      return { applied: false, idempotent: true };
    }

    const { booking_id: bookingId } = paymentRes.rows[0];

    if (bookingId) {
      await client.query(
        `UPDATE bookings
           SET status         = 'cancelled',
               payment_status = 'failed',
               updated_at     = NOW()
         WHERE id = $1
           AND payment_status NOT IN ('paid', 'refunded')`,
        [bookingId]
      );
    }

    logger.info({ ...logCtx, bookingId }, '[webhook-ctrl] payment.failed applied');
    return { applied: true };
  }

  logger.warn(logCtx, '[webhook-ctrl] applyPaymentEvent: unhandled event type');
  return { applied: false, ignored: true };
}

// ─── Refund event appliers ────────────────────────────────────────────────────

/**
 * Extract Razorpay refund entity from webhook payload.
 * Handles multiple Razorpay payload envelope formats.
 */
function extractRefundEntity(payload) {
  return (
    payload?.payload?.refund?.entity ||
    payload?.refund?.entity ||
    payload?.event?.payload?.refund?.entity ||
    null
  );
}

/**
 * Apply a refund.* Razorpay event.
 *
 * @param {import('pg').PoolClient} client  - Active DB transaction client
 * @param {object} params
 * @param {string} params.eventType         - 'refund.created' | 'refund.processed' | 'refund.failed' | 'refund.cancelled'
 * @param {object} params.payload           - Raw Razorpay webhook payload
 * @param {string} [params.eventId]         - webhook_events.event_id (for logging)
 * @param {number} [params.leaseVersion]    - Fencing token (for logging)
 * @returns {Promise<{applied: boolean, idempotent?: boolean, ignored?: boolean}>}
 */
async function applyRefundEvent(client, { eventType, payload, eventId, leaseVersion } = {}) {
  const entity = extractRefundEntity(payload);
  const logCtx = { eventType, eventId, leaseVersion };

  if (!entity) {
    logger.warn({ ...logCtx, payload }, '[webhook-ctrl] applyRefundEvent: no refund entity in payload');
    return { applied: false, ignored: true };
  }

  const razorpayRefundId  = entity.id;
  const razorpayPaymentId = entity.payment_id;
  // Razorpay refund amounts are always in paise (smallest currency unit)
  const amountPaise = Number(entity.amount) || 0;
  const amountRupees = paiseToRupees(amountPaise);

  if (!razorpayRefundId) {
    throw Object.assign(
      new Error('applyRefundEvent: missing refund entity.id in payload'),
      { code: 'WEBHOOK_BAD_PAYLOAD', status: 400 }
    );
  }

  // ── refund.created: upsert refund row ──────────────────────────────────────
  if (eventType === 'refund.created') {
    // Look up internal payment row from Razorpay payment ID
    const paymentRes = await client.query(
      `SELECT id, booking_id, user_id FROM payments WHERE razorpay_payment_id = $1 LIMIT 1`,
      [razorpayPaymentId]
    );

    if (paymentRes.rows.length === 0) {
      logger.warn({ ...logCtx, razorpayPaymentId }, '[webhook-ctrl] refund.created: payment not found');
      return { applied: false, ignored: true };
    }

    const { id: paymentRowId, booking_id: bookingId, user_id: userId } = paymentRes.rows[0];

    // Idempotent INSERT: ON CONFLICT (razorpay_refund_id) DO NOTHING
    const insertRes = await client.query(
      `INSERT INTO refunds (
         payment_id, booking_id, user_id,
         razorpay_refund_id, razorpay_payment_id,
         amount, status, razorpay_status,
         processed_by, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'initiated', $7, 'webhook', NOW())
       ON CONFLICT (razorpay_refund_id) DO NOTHING
       RETURNING id`,
      [
        paymentRowId, bookingId, userId,
        razorpayRefundId, razorpayPaymentId,
        amountRupees,        // refunds.amount is stored in rupees (historical convention)
        entity.status || 'pending',
      ]
    );

    if (insertRes.rowCount === 0) {
      logger.info({ ...logCtx, razorpayRefundId }, '[webhook-ctrl] refund.created idempotent (already exists)');
      return { applied: false, idempotent: true };
    }

    // Move payment to refund_pending
    await client.query(
      `UPDATE payments
         SET status = 'refund_pending', updated_at = NOW()
       WHERE id = $1 AND status = 'captured'`,
      [paymentRowId]
    );

    logger.info({ ...logCtx, razorpayRefundId, amountRupees }, '[webhook-ctrl] refund.created applied');
    return { applied: true };
  }

  // ── refund.processed: transition to succeeded ──────────────────────────────
  if (eventType === 'refund.processed') {
    const updateRes = await client.query(
      `UPDATE refunds
         SET status          = 'succeeded',
             razorpay_status = $2,
             updated_at      = NOW()
       WHERE razorpay_refund_id = $1
         AND status NOT IN ('succeeded', 'cancelled')
       RETURNING id, payment_id, booking_id`,
      [razorpayRefundId, entity.status || 'processed']
    );

    if (updateRes.rowCount === 0) {
      logger.info({ ...logCtx, razorpayRefundId }, '[webhook-ctrl] refund.processed idempotent');
      return { applied: false, idempotent: true };
    }

    const { payment_id: paymentId, booking_id: bookingId } = updateRes.rows[0];

    // Transition payment to refunded
    await client.query(
      `UPDATE payments
         SET status = 'refunded', updated_at = NOW()
       WHERE id = $1 AND status IN ('captured', 'refund_pending')`,
      [paymentId]
    );

    // Transition booking to cancelled with refunded payment status
    if (bookingId) {
      await client.query(
        `UPDATE bookings
           SET payment_status = 'refunded', updated_at = NOW()
         WHERE id = $1 AND payment_status NOT IN ('refunded')`,
        [bookingId]
      );
    }

    logger.info({ ...logCtx, razorpayRefundId }, '[webhook-ctrl] refund.processed applied');
    return { applied: true };
  }

  // ── refund.failed: transition to failed ───────────────────────────────────
  if (eventType === 'refund.failed') {
    const updateRes = await client.query(
      `UPDATE refunds
         SET status          = 'failed',
             razorpay_status = $2,
             last_error      = $3,
             updated_at      = NOW()
       WHERE razorpay_refund_id = $1
         AND status NOT IN ('succeeded', 'failed', 'cancelled')
       RETURNING id, payment_id`,
      [
        razorpayRefundId,
        entity.status || 'failed',
        entity.description || 'Razorpay refund.failed event',
      ]
    );

    if (updateRes.rowCount === 0) {
      logger.info({ ...logCtx, razorpayRefundId }, '[webhook-ctrl] refund.failed idempotent');
      return { applied: false, idempotent: true };
    }

    // Revert payment to captured so it can be retried
    const { payment_id: paymentId } = updateRes.rows[0];
    await client.query(
      `UPDATE payments
         SET status = 'captured', updated_at = NOW()
       WHERE id = $1 AND status = 'refund_pending'`,
      [paymentId]
    );

    logger.info({ ...logCtx, razorpayRefundId }, '[webhook-ctrl] refund.failed applied');
    return { applied: true };
  }

  // ── refund.cancelled ───────────────────────────────────────────────────────
  if (eventType === 'refund.cancelled') {
    const updateRes = await client.query(
      `UPDATE refunds
         SET status          = 'cancelled',
             razorpay_status = $2,
             updated_at      = NOW()
       WHERE razorpay_refund_id = $1
         AND status NOT IN ('succeeded', 'cancelled')
       RETURNING id`,
      [razorpayRefundId, entity.status || 'cancelled']
    );

    if (updateRes.rowCount === 0) {
      logger.info({ ...logCtx, razorpayRefundId }, '[webhook-ctrl] refund.cancelled idempotent');
      return { applied: false, idempotent: true };
    }

    logger.info({ ...logCtx, razorpayRefundId }, '[webhook-ctrl] refund.cancelled applied');
    return { applied: true };
  }

  logger.warn(logCtx, '[webhook-ctrl] applyRefundEvent: unhandled event type');
  return { applied: false, ignored: true };
}

module.exports = { applyPaymentEvent, applyRefundEvent };

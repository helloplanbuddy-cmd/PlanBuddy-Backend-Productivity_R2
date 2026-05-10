'use strict';

const { razorpay } = require('../config/razorpay');
const crypto = require('crypto');
const FinancialStateManager = require('./FinancialStateManager');

const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

/**
 * Verify Razorpay signature
 */
function verifySignature(payload, signature) {
  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');
  if (signature !== expected) {
    const err = new Error('Webhook signature invalid');
    err.code = 'SIGNATURE_MISMATCH';
    err.status = 400;
    throw err;
  }
}

/**
 * Process payment txn using FinancialStateManager (single writer).
 *
 * IMPORTANT: This function MUST NOT do direct financial writes (no UPDATE/INSERT into payments/refunds/bookings).
 */
async function processPaymentTransaction(orderId, paymentId, amount, currency, userId, correlationId, client) {
  // We keep the signature compatible with existing callers,
  // but we no longer perform direct SQL mutations here.
  if (!client) {
    throw new Error('processPaymentTransaction: client is required');
  }

  // Best-effort trace id for FSM logging.
  const traceId = correlationId || `razorpay-${paymentId}`;

  let attempt = 0;
  while (attempt < 3) {
    try {
      // Read path only: lock payment row to make the state read consistent.
      const payment = await client.query(
        'SELECT id, status, booking_id FROM payments WHERE razorpay_payment_id = $1 FOR UPDATE',
        [paymentId]
      );

      if (payment.rows.length === 0) {
        throw new Error(`Payment not found for razorpay_payment_id=${paymentId}`);
      }

      const paymentRow = payment.rows[0];

      // Idempotency: if already not in "created", do nothing (FSM will no-op if transition is same state).
      if (paymentRow.status !== 'created') {
        return { idempotent: true };
      }

      const razorpayPayment = await razorpay.payments.fetch(paymentId);

      if (razorpayPayment.status !== 'captured') {
        await FinancialStateManager.transition(
          'payment',
          paymentRow.id,
          paymentRow.status,
          'failed',
          { traceId, requestId: correlationId }
        );
        return { idempotent: false };
      }

      // captured => payment success + booking confirmed (both via FSM).
      await FinancialStateManager.transition(
        'payment',
        paymentRow.id,
        paymentRow.status,
        'captured',
        { traceId, requestId: correlationId, paymentId: paymentRow.id }
      );

      if (paymentRow.booking_id) {
        await FinancialStateManager.transition(
          'booking',
          paymentRow.booking_id,
          'pending',
          'confirmed',
          { traceId, requestId: correlationId, bookingId: paymentRow.booking_id }
        );
      }

      return { idempotent: false };
    } catch (err) {
      // serialization retry (read-only + FSM internal transaction).
      if (err.code === '40001' && attempt < 2) {
        attempt++;
        await new Promise((r) => setTimeout(r, 100 * attempt));
        continue;
      }
      throw err;
    }
  }
}

module.exports = {
  verifySignature,
  processPaymentTransaction,
};

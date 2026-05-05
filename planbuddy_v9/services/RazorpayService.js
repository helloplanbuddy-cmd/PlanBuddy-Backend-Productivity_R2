'use strict';

const { razorpay } = require('../config/razorpay');
const crypto = require('crypto');
const db = require('../config/db');
const logger = require('../utils/logger');

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
 * Process payment txn in SERIALIZABLE isolation (race-safe)
 */
async function processPaymentTransaction(orderId, paymentId, amount, currency, userId, correlationId, client) {
  let attempt = 0;
  while (attempt < 3) {
    try {
      await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
      
      const payment = await client.query(
        'SELECT * FROM payments WHERE razorpay_payment_id = $1 FOR UPDATE',
        [paymentId]
      );
      
      if (payment.rows[0].status !== 'created') {
        return { idempotent: true };
      }

      const razorpayPayment = await razorpay.payments.fetch(paymentId);
      if (razorpayPayment.status !== 'captured') {
        await client.query('UPDATE payments SET status = $1 WHERE id = $2', ['failed', payment.rows[0].id]);
        return { idempotent: false };
      }

      await client.query(`
        UPDATE payments SET status = 'success' WHERE id = $1;
        UPDATE bookings SET status = 'confirmed' WHERE id = (SELECT booking_id FROM payments WHERE id = $1);
      `, [payment.rows[0].id]);

      return { idempotent: false };
    } catch (err) {
      if (err.code === '40001' && attempt < 2) { // serialization
        attempt++;
        await new Promise(r => setTimeout(r, 100 * attempt));
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


'use strict';

/**
 * controllers/paymentController.js — Payment Controller (v2.0)
 *
 * Handles all payment-related operations:
 *  1. Create Razorpay order
 *  2. Verify payment signature
 *  3. Capture payment and update booking
 *  4. Initiate refund
 *
 * CRITICAL: This controller handles real money operations.
 * All operations must be idempotent and transaction-safe.
 */

const { razorpay, rupeesToPaise, paiseToRupees } = require('../config/razorpay');
const db = require('../config/db');
const logger = require('../utils/logger');
const crypto = require('crypto');
const { razorpayCircuitBreaker } = require('../services/circuitBreaker');

// ─── Create Razorpay Order ────────────────────────────────────────────────────
/**
 * POST /api/v1/payments/create-order
 * 
 * Creates a new Razorpay order for a booking.
 * Expects: { bookingId, amount, currency = 'INR' }
 * 
 * Idempotency: Uses idempotency-key header to prevent duplicate orders.
 */
exports.createOrder = async (req, res, next) => {
  const requestId = req.requestId;
  
  try {
    const { bookingId, amount, currency = 'INR' } = req.body;
    const userId = req.user?.id;

    // Validate required fields
    if (!bookingId || !amount) {
      return res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: 'bookingId and amount are required'
      });
    }

    // Validate amount is a positive number
    if (typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: 'amount must be a positive number'
      });
    }

    // Check idempotency - if we already processed this request, return existing order
    const idempotencyKey = req.headers['idempotency-key'];
    if (idempotencyKey) {
      const existingOrder = await db.query(
        `SELECT * FROM razorpay_order_mappings 
         WHERE booking_id = $1 AND amount = $2`,
        [bookingId, amount]
      );
      
      if (existingOrder.rows.length > 0) {
        logger.info({ requestId, bookingId, idempotencyKey }, '[payment] Returning existing order (idempotent)');
        return res.json({
          success: true,
          data: {
            orderId: existingOrder.rows[0].razorpay_order_id,
            amount: existingOrder.rows[0].amount,
            currency: existingOrder.rows[0].currency,
            bookingId: existingOrder.rows[0].booking_id,
            idempotent: true
          }
        });
      }
    }

    // Verify booking exists and belongs to user
    const bookingResult = await db.query(
      `SELECT b.*, p.id as payment_id, p.status as payment_status
       FROM bookings b
       LEFT JOIN payments p ON p.booking_id = b.id
       WHERE b.id = $1`,
      [bookingId]
    );

    if (bookingResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        code: 'BOOKING_NOT_FOUND',
        message: 'Booking not found'
      });
    }

    const booking = bookingResult.rows[0];

    // Check ownership
    if (booking.user_id !== userId && req.user?.role !== 'admin') {
      return res.status(403).json({
        success: false,
        code: 'ACCESS_DENIED',
        message: 'Access denied'
      });
    }

    // Check if booking already has a successful payment
    if (booking.payment_status === 'paid') {
      return res.status(400).json({
        success: false,
        code: 'ALREADY_PAID',
        message: 'This booking has already been paid for'
      });
    }

    // Create Razorpay order
    const amountInPaise = rupeesToPaise(amount);
    
    const razorpayOrder = await razorpay.orders.create({
      amount: amountInPaise,
      currency: currency,
      receipt: `booking_${bookingId}_${Date.now()}`,
      notes: {
        bookingId: bookingId,
        userId: userId,
        requestId: requestId
      }
    });

    logger.info({ requestId, bookingId, orderId: razorpayOrder.id }, '[payment] Razorpay order created');

    // Store order in database within a transaction
    await db.transaction(async (client) => {
      // Insert or update the razorpay_order_mappings table
      await client.query(
        `INSERT INTO razorpay_order_mappings (
          razorpay_order_id, booking_id, user_id, amount, currency, 
          created_at
        ) VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (razorpay_order_id) DO UPDATE SET
          updated_at = NOW()`,
        [
          razorpayOrder.id,
          bookingId,
          userId,
          amount,
          currency
        ]
      );

      // Create or update payment record
      if (booking.payment_id) {
        await client.query(
          `UPDATE payments 
           SET razorpay_order_id = $1, status = 'created', updated_at = NOW()
           WHERE id = $2`,
          [razorpayOrder.id, booking.payment_id]
        );
      } else {
        await client.query(
          `INSERT INTO payments (
            booking_id, user_id, razorpay_order_id, amount, currency, 
            status, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
          RETURNING id`,
          [bookingId, userId, razorpayOrder.id, amount, currency, 'created']
        );
      }
    }, 'create_payment_order');

    return res.json({
      success: true,
      data: {
        orderId: razorpayOrder.id,
        amount: amount,
        currency: currency,
        bookingId: bookingId,
        keyId: process.env.RAZORPAY_KEY_ID // Needed for frontend Razorpay checkout
      }
    });

  } catch (err) {
    logger.error({ requestId, err: err.message }, '[payment] Error creating order');
    next(err);
  }
};

// ─── Verify Payment Signature ─────────────────────────────────────────────────
/**
 * POST /api/v1/payments/verify
 * 
 * Verifies a Razorpay payment after checkout on the frontend.
 * Expects: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
 * 
 * This is called by the frontend after the user completes payment in the
 * Razorpay checkout modal.
 */
exports.verifyPayment = async (req, res, next) => {
  const requestId = req.requestId;
  
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    // Validate required fields
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: 'razorpay_order_id, razorpay_payment_id, and razorpay_signature are required'
      });
    }

    // Verify signature
    // 🔥 CRITICAL: Use RAZORPAY_KEY_SECRET (not WEBHOOK_SECRET) for payment verification
    // Webhook secret is for webhook validation only
    // Payment signature is verified with API Key Secret
    const { RAZORPAY_KEY_SECRET } = require('../config/env');
    const generatedSignature = crypto
      .createHmac('sha256', RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (generatedSignature !== razorpay_signature) {
      logger.error({ requestId, razorpay_payment_id }, '[payment] 🔴 Signature verification failed - POSSIBLE TAMPERING');
      return res.status(403).json({
        success: false,
        code: 'INVALID_SIGNATURE',
        message: 'Payment signature verification failed'
      });
    }

    // Fetch payment details from Razorpay with circuit breaker protection
    const payment = await razorpayCircuitBreaker.call(() =>
      razorpay.payments.fetch(razorpay_payment_id)
    );

    if (payment.status !== 'captured') {
      logger.warn({ requestId, razorpay_payment_id, status: payment.status }, '[payment] Payment not captured');
      return res.status(400).json({
        success: false,
        code: 'PAYMENT_NOT_CAPTURED',
        message: 'Payment was not successfully captured'
      });
    }

    // 🔥 CRITICAL: Verify amount matches expected order amount
    // Prevents fraud where attacker manipulates frontend to send different amount
    const orderResult = await db.query(
      `SELECT amount, currency FROM razorpay_order_mappings WHERE razorpay_order_id = $1`,
      [razorpay_order_id]
    );
    
    if (orderResult.rows.length > 0) {
      const expectedAmount = orderResult.rows[0].amount;
      const actualAmount = paiseToRupees(payment.amount);
      
      if (Math.abs(expectedAmount - actualAmount) > 0.01) {
        logger.error({ 
          requestId, 
          razorpay_payment_id, 
          expectedAmount, 
          actualAmount,
          razorpayOrderAmount: payment.amount
        }, '[payment] 🔴 AMOUNT MISMATCH - Possible fraud attempt');
        
        return res.status(400).json({
          success: false,
          code: 'AMOUNT_MISMATCH',
          message: 'Payment amount does not match order amount',
          expected: expectedAmount,
          actual: actualAmount
        });
      }
    }

    // Update payment and booking in database
    await db.transaction(async (client) => {
      // Update payment record
      const paymentResult = await client.query(
        `UPDATE payments 
         SET status = 'captured', 
             razorpay_payment_id = $1,
             razorpay_signature = $2,
             updated_at = NOW()
         WHERE razorpay_order_id = $3
           AND status = 'created'
         RETURNING booking_id`,
        [razorpay_payment_id, razorpay_signature, razorpay_order_id]
      );

      if (paymentResult.rows.length > 0) {
        const bookingId = paymentResult.rows[0].booking_id;
        
        // Update booking status
        await client.query(
          `UPDATE bookings 
           SET status = 'confirmed', 
               payment_status = 'paid',
               updated_at = NOW()
           WHERE id = $1
             AND payment_status NOT IN ('paid', 'refunded')`,
          [bookingId]
        );

        logger.info({ requestId, bookingId, razorpay_payment_id }, '[payment] Payment verified and booking confirmed');
      }
    }, 'verify_payment');

    return res.json({
      success: true,
      data: {
        paymentId: razorpay_payment_id,
        status: payment.status,
        amount: paiseToRupees(payment.amount),
        currency: payment.currency
      }
    });

  } catch (err) {
    logger.error({ requestId, err: err.message }, '[payment] Error verifying payment');
    next(err);
  }
};

// ─── Get Payment Status ───────────────────────────────────────────────────────
/**
 * GET /api/v1/payments/:bookingId/status
 * 
 * Returns the current payment status for a booking.
 */
exports.getPaymentStatus = async (req, res, next) => {
  const requestId = req.requestId;
  
  try {
    const { bookingId } = req.params;
    const userId = req.user?.id;

    const result = await db.query(
      `SELECT 
         b.id, b.status as booking_status, b.payment_status,
         p.id as payment_id,
         p.status as payment_status_detail,
         p.razorpay_payment_id,
         p.razorpay_order_id,
         p.amount,
         p.currency,
         ro.status as order_status
       FROM bookings b
       LEFT JOIN payments p ON p.booking_id = b.id
       LEFT JOIN razorpay_order_mappings ro ON ro.razorpay_order_id = p.razorpay_order_id
       WHERE b.id = $1`,
      [bookingId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        code: 'BOOKING_NOT_FOUND',
        message: 'Booking not found'
      });
    }

    const booking = result.rows[0];

    // Check ownership
    if (booking.user_id !== userId && req.user?.role !== 'admin') {
      return res.status(403).json({
        success: false,
        code: 'ACCESS_DENIED',
        message: 'Access denied'
      });
    }

    return res.json({
      success: true,
      data: {
        bookingId: booking.id,
        bookingStatus: booking.booking_status,
        paymentStatus: booking.payment_status,
        paymentDetail: booking.payment_status_detail,
        razorpayPaymentId: booking.razorpay_payment_id,
        razorpayOrderId: booking.razorpay_order_id,
        amount: booking.amount,
        currency: booking.currency,
        orderStatus: booking.order_status
      }
    });

  } catch (err) {
    logger.error({ requestId, err: err.message }, '[payment] Error getting payment status');
    next(err);
  }
};

// ─── Initiate Refund ──────────────────────────────────────────────────────────
/**
 * POST /api/v1/payments/:paymentId/refund
 * 
 * Initiates a refund for a captured payment.
 * Expects: { reason, amount } (amount is optional, defaults to full refund)
 * 
 * Idempotency: Uses idempotency-key header to prevent duplicate refunds.
 * 
 * State Machine:
 *   payment: captured → refunded (only after refund succeeds)
 *   booking: confirmed → cancelled, payment_status: paid → refunded
 * 
 * Safety:
 *   - DB-level row locking prevents concurrent refund attempts
 *   - Idempotency key prevents duplicate processing
 *   - State machine trigger enforces valid transitions
 */
exports.initiateRefund = async (req, res, next) => {
  const requestId = req.requestId;
  
  try {
    const { paymentId } = req.params;
    const { reason, amount } = req.body;
    const userId = req.user?.id;
    
    // REQUIRE idempotency key from client - do NOT generate server-side
    const idempotencyKey = req.headers['idempotency-key'];
    
    if (!idempotencyKey) {
      return res.status(400).json({
        success: false,
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Idempotency-Key header is required for refund requests'
      });
    }
    
    if (!/^[a-zA-Z0-9_-]+$/.test(idempotencyKey)) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_IDEMPOTENCY_KEY',
        message: 'Idempotency-Key must contain only alphanumeric characters, hyphens, and underscores'
      });
    }

    // ── Step 1: Fast idempotency check (no lock needed) ──────────────────────
    const idempotentCheck = await db.query(
      `SELECT r.*, p.razorpay_payment_id 
       FROM refunds r
       JOIN payments p ON p.id = r.payment_id
       WHERE r.idempotency_key = $1`,
      [idempotencyKey]
    );

    if (idempotentCheck.rows.length > 0) {
      const existingRefund = idempotentCheck.rows[0];
      logger.info({ requestId, idempotencyKey, refundId: existingRefund.razorpay_refund_id },
        '[payment] Returning existing refund (idempotent)');
      return res.json({
        success: true, data: {
          refundId: existingRefund.razorpay_refund_id,
          amount: existingRefund.amount,
          status: existingRefund.status,
          message: existingRefund.status === 'succeeded' ? 'Refund completed' : 'Refund is being processed',
          idempotent: true
        }
      });
    }

    // ── Step 2: Acquire dedicated client + SESSION-LEVEL advisory lock ───────
    // ✅ FIX CRIT-001: pg_advisory_lock (session-scoped) holds across queries
    // Unlike pg_advisory_xact_lock which releases when the implicit tx ends.
    const client = await db.pool.connect();
    const lockId = (('x' + require('crypto').createHash('md5').update('refund:' + paymentId).digest('hex').slice(0, 16)));
    const lockBigInt = parseInt(lockId, 16) % 9007199254740991; // Stay within safe integer range

    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_lock($1)`, [lockBigInt]);
      
      // Fetch payment with row lock
      const paymentResult = await client.query(
        `SELECT p.*, b.user_id, b.id as booking_id
         FROM payments p
         JOIN bookings b ON b.id = p.booking_id
         WHERE p.id = $1
         FOR UPDATE OF p`,
        [paymentId]
      );

      if (paymentResult.rows.length === 0) {
        await client.query('ROLLBACK');
        await client.query(`SELECT pg_advisory_unlock($1)`, [lockBigInt]);
        return res.status(404).json({ success: false, code: 'PAYMENT_NOT_FOUND', message: 'Payment not found' });
      }

      const payment = paymentResult.rows[0];

      // Ownership check
      if (payment.user_id !== userId && req.user?.role !== 'admin') {
        await client.query('ROLLBACK');
        await client.query(`SELECT pg_advisory_unlock($1)`, [lockBigInt]);
        return res.status(403).json({ success: false, code: 'ACCESS_DENIED', message: 'Access denied' });
      }

      // Eligibility check
      if (payment.status !== 'captured') {
        await client.query('ROLLBACK');
        await client.query(`SELECT pg_advisory_unlock($1)`, [lockBigInt]);
        return res.status(400).json({ success: false, code: 'PAYMENT_NOT_ELIGIBLE', message: 'Only captured payments can be refunded' });
      }

      // Check for existing active refunds
      const existingRefundCheck = await client.query(
        `SELECT * FROM refunds WHERE payment_id = $1 AND status NOT IN ('cancelled', 'failed') FOR UPDATE`,
        [payment.id]
      );

      if (existingRefundCheck.rows.length > 0) {
        const existingRefund = existingRefundCheck.rows[0];
        await client.query('ROLLBACK');
        await client.query(`SELECT pg_advisory_unlock($1)`, [lockBigInt]);
        if (existingRefund.status === 'succeeded') {
          return res.status(400).json({ success: false, code: 'ALREADY_REFUNDED', message: 'This payment has already been refunded' });
        }
        return res.json({ success: true, data: { refundId: existingRefund.razorpay_refund_id, amount: existingRefund.amount, status: existingRefund.status, message: 'Refund is already being processed', idempotent: true } });
      }

      const refundAmount = amount != null ? amount : payment.amount;

      // Validate refund amount
      if (refundAmount <= 0 || refundAmount > payment.amount) {
        await client.query('ROLLBACK');
        await client.query(`SELECT pg_advisory_unlock($1)`, [lockBigInt]);
        return res.status(400).json({ success: false, code: 'INVALID_REFUND_AMOUNT', message: 'Refund amount must be between 0 and the original payment amount' });
      }

      if (!payment.razorpay_payment_id) {
        await client.query('ROLLBACK');
        await client.query(`SELECT pg_advisory_unlock($1)`, [lockBigInt]);
        return res.status(400).json({ success: false, code: 'PAYMENT_NOT_REFUNDABLE', message: 'This payment cannot be refunded — no gateway reference available' });
      }

      // ── Step 3: Call Razorpay API (lock STILL held) ─────────────────────────
      const razorpayRefund = await razorpayCircuitBreaker.call(() =>
        razorpay.refunds.create({
          payment_id: payment.razorpay_payment_id,
          amount: rupeesToPaise(refundAmount),
          notes: { reason: reason || 'Refund requested by user', requestId, idempotencyKey, internalPaymentId: payment.id }
        })
      );

      // ── Step 4: Record in database (same client, same tx) ───────────────────
      const refundResult = await client.query(
        `INSERT INTO refunds (
          payment_id, booking_id, user_id, razorpay_refund_id, 
          razorpay_payment_id, amount, reason, status, 
          idempotency_key, razorpay_status, processed_by, metadata, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING id`,
        [
          payment.id, payment.booking_id, userId, razorpayRefund.id,
          payment.razorpay_payment_id, refundAmount,
          reason || 'Refund requested by user', 'initiated',
          idempotencyKey, razorpayRefund.status, 'api',
          JSON.stringify({ requestId, reason: reason || 'Refund requested by user', initiatedAt: new Date().toISOString() })
        ]
      );

      if (refundResult.rows.length === 0) {
        await client.query('ROLLBACK');
        await client.query(`SELECT pg_advisory_unlock($1)`, [lockBigInt]);
        return res.status(409).json({ success: false, code: 'DUPLICATE_REFUND', message: 'A refund for this payment is already being processed' });
      }

      await client.query(
        `UPDATE payments SET status = 'refund_pending', updated_at = NOW() WHERE id = $1 AND status = 'captured'`,
        [payment.id]
      );

      await client.query('COMMIT');
      await client.query(`SELECT pg_advisory_unlock($1)`, [lockBigInt]);

      logger.info({ requestId, paymentId, refundId: razorpayRefund.id },
        '[payment] Refund initiated with Razorpay');

      return res.json({
        success: true,
        data: { refundId: razorpayRefund.id, amount: refundAmount, status: razorpayRefund.status,
          message: 'Refund initiated. Funds will be returned in 5-7 business days.' }
      });

    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      await client.query(`SELECT pg_advisory_unlock($1)`, [lockBigInt]).catch(() => {});
      client.release();
      throw err;
    } finally {
      client.release();
    }

  } catch (err) {
    if (err.code === '23505') {
      logger.warn({ requestId, paymentId, idempotencyKey, error: err.message },
        '[payment] Duplicate refund attempt detected');
      return res.status(409).json({ success: false, code: 'DUPLICATE_REFUND', message: 'A refund for this payment is already being processed' });
    }
    logger.error({ requestId, err: err.message }, '[payment] Error initiating refund');
    next(err);
  }
};

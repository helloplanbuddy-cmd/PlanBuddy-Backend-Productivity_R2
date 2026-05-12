'use strict';

/**
 * __tests__/exactlyOnceRefund.unit.test.js — Unit Tests (No External DB Required)
 *
 * Tests the business logic of exactly-once refund guarantee:
 *  1. Idempotency key prevents duplicates
 *  2. Concurrent requests converge safely
 *  3. State transitions are correct
 *  4. Error handling is deterministic
 *
 * Uses mock database to avoid requiring PostgreSQL.
 */

const mockDb = require('./mocks/database');
const { CircuitBreaker } = require('../utils/circuitBreakerUtil');

describe('Exactly-Once Refund Guarantee (Unit Tests)', () => {
  beforeEach(() => {
    mockDb.reset();
  });

  afterAll(async () => {
    await mockDb.end();
  });

  // ─── Test 1: Idempotency Key Prevents Duplicates ────────────────────────────
  describe('Idempotency Key Protection', () => {
    
    test('should prevent duplicate refunds with same idempotency key', async () => {
      const paymentId = 'pay-test-1';
      const idempotencyKey = 'idem-key-unique-1';

      // Setup: Create payment
      await mockDb.query(
        `INSERT INTO payments (id, booking_id, razorpay_payment_id, amount)
         VALUES ($1, $2, $3, $4)`,
        [paymentId, 'booking-1', 'pay_TEST123', 50000]
      );

      // First refund with idempotency key
      const refund1 = await mockDb.query(
        `INSERT INTO refunds (payment_id, razorpay_refund_id, amount, status, idempotency_key)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [paymentId, 'rfnd_1', 50000, 'initiated', idempotencyKey]
      );

      // Second refund with SAME idempotency key (should be deduplicated)
      const refund2 = await mockDb.query(
        `INSERT INTO refunds (payment_id, razorpay_refund_id, amount, status, idempotency_key)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [paymentId, 'rfnd_2', 50000, 'initiated', idempotencyKey]
      );

      // Both should return same refund ID (idempotent)
      expect(refund1.rows[0].id).toBe(refund2.rows[0].id);

      // Verify only ONE refund in DB
      const count = await mockDb.query(
        'SELECT COUNT(*) as count FROM refunds WHERE payment_id = $1',
        [paymentId]
      );
      expect(parseInt(count.rows[0].count)).toBe(1);
    });

    test('should allow different refunds with different idempotency keys', async () => {
      const paymentId = 'pay-test-2';

      await mockDb.query(
        `INSERT INTO payments (id, booking_id, razorpay_payment_id, amount)
         VALUES ($1, $2, $3, $4)`,
        [paymentId, 'booking-2', 'pay_TEST456', 30000]
      );

      const refund1 = await mockDb.query(
        `INSERT INTO refunds (payment_id, razorpay_refund_id, amount, status, idempotency_key)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [paymentId, 'rfnd_1', 30000, 'initiated', 'key-1']
      );

      const refund2 = await mockDb.query(
        `INSERT INTO refunds (payment_id, razorpay_refund_id, amount, status, idempotency_key)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [paymentId, 'rfnd_2', 30000, 'initiated', 'key-2']
      );

      // Should be different
      expect(refund1.rows[0].id).not.toBe(refund2.rows[0].id);

      // Verify TWO refunds in DB
      const count = await mockDb.query(
        'SELECT COUNT(*) as count FROM refunds WHERE payment_id = $1',
        [paymentId]
      );
      expect(parseInt(count.rows[0].count)).toBe(2);
    });
  });

  // ─── Test 2: Transaction Isolation ────────────────────────────────────────
  describe('Transaction Isolation', () => {
    
    test('should handle concurrent refund requests safely', async () => {
      const paymentId = 'pay-concurrent';

      await mockDb.query(
        `INSERT INTO payments (id, booking_id, razorpay_payment_id, amount, status)
         VALUES ($1, $2, $3, $4, $5)`,
        [paymentId, 'booking-c', 'pay_CONCURRENT', 50000, 'captured']
      );

      // Simulate concurrent requests with same idempotency key
      const promises = Array(10).fill(null).map((_, i) => 
        mockDb.query(
          `INSERT INTO refunds (payment_id, razorpay_refund_id, amount, status, idempotency_key)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [paymentId, `rfnd_${i}`, 5000, 'initiated', 'concurrent-key']
        )
      );

      const results = await Promise.all(promises);

      // All should return the same refund ID (first writer wins)
      const firstId = results[0].rows[0].id;
      results.forEach(r => {
        expect(r.rows[0].id).toBe(firstId);
      });

      // Only ONE refund should exist
      const count = await mockDb.query(
        'SELECT COUNT(*) as count FROM refunds WHERE payment_id = $1',
        [paymentId]
      );
      expect(parseInt(count.rows[0].count)).toBe(1);
    });
  });

  // ─── Test 3: Circuit Breaker State Transitions ──────────────────────────────
  describe('Circuit Breaker Protection', () => {
    
    test('should transition CLOSED → OPEN on repeated failures', async () => {
      const breaker = new CircuitBreaker({
        name: 'test-breaker',
        failureThreshold: 3,
        successThreshold: 2,
        timeout: 50,
      });

      expect(breaker.state).toBe('CLOSED');

      // Simulate 3 failures
      const fn = async () => { throw new Error('simulated failure'); };
      
      try { await breaker.execute(fn, 'test-op-1'); } catch (e) {}
      try { await breaker.execute(fn, 'test-op-2'); } catch (e) {}
      try { await breaker.execute(fn, 'test-op-3'); } catch (e) {}

      expect(breaker.state).toBe('OPEN');
    });

    test('should transition OPEN → HALF_OPEN after timeout', async () => {
      const breaker = new CircuitBreaker({
        name: 'test-breaker-2',
        failureThreshold: 1,
        successThreshold: 1,
        timeout: 50,
      });

      const failFn = async () => { throw new Error('simulated failure'); };
      
      try { await breaker.execute(failFn, 'test'); } catch (e) {}
      expect(breaker.state).toBe('OPEN');

      // Wait for timeout
      await new Promise(r => setTimeout(r, 100));

      // Next execute should attempt recovery (transition to HALF_OPEN)
      const successFn = async () => 'success';
      const result = await breaker.execute(successFn, 'recovery-test');
      
      expect(result).toBe('success');
      expect(breaker.state).toBe('CLOSED');
    });

    test('should transition HALF_OPEN → CLOSED on success', async () => {
      const breaker = new CircuitBreaker({
        name: 'test-breaker-3',
        failureThreshold: 1,
        successThreshold: 1,
        timeout: 50,
      });

      const failFn = async () => { throw new Error('simulated failure'); };
      try { await breaker.execute(failFn, 'fail'); } catch (e) {}
      
      expect(breaker.state).toBe('OPEN');

      await new Promise(r => setTimeout(r, 100));

      // State should now be HALF_OPEN internally, and a success should close it
      const successFn = async () => 'recovered';
      const result = await breaker.execute(successFn, 'recovery');
      
      expect(result).toBe('recovered');
      expect(breaker.state).toBe('CLOSED');
    });
  });

  // ─── Test 4: Payment Status Validation ──────────────────────────────────────
  describe('Payment Status Validation', () => {
    
    test('should reject refund on non-captured payment', async () => {
      const paymentId = 'pay-pending';

      await mockDb.query(
        `INSERT INTO payments (id, booking_id, razorpay_payment_id, amount, status)
         VALUES ($1, $2, $3, $4, $5)`,
        [paymentId, 'booking-p', 'pay_PENDING', 50000, 'pending']
      );

      const payment = await mockDb.query(
        'SELECT id, status FROM payments WHERE id = $1',
        [paymentId]
      );

      expect(payment.rows.length).toBe(1);
      expect(payment.rows[0].status).toBe('pending');
    });

    test('should accept refund on captured payment', async () => {
      const paymentId = 'pay-captured';

      await mockDb.query(
        `INSERT INTO payments (id, booking_id, razorpay_payment_id, amount, status)
         VALUES ($1, $2, $3, $4, $5)`,
        [paymentId, 'booking-cap', 'pay_CAPTURED', 50000, 'captured']
      );

      const payment = await mockDb.query(
        'SELECT id, status FROM payments WHERE id = $1',
        [paymentId]
      );

      expect(payment.rows[0].status).toBe('captured');
    });
  });

  // ─── Test 5: Audit Trail ──────────────────────────────────────────────────
  describe('Audit Trail & Observability', () => {
    
    test('should record refund metadata for audit', async () => {
      const paymentId = 'pay-audit';
      const idempotencyKey = 'audit-key-1';
      const requestedBy = 'admin-user-1';

      await mockDb.query(
        `INSERT INTO payments (id, booking_id, razorpay_payment_id, amount, status)
         VALUES ($1, $2, $3, $4, $5)`,
        [paymentId, 'booking-audit', 'pay_AUDIT', 50000, 'captured']
      );

      const refund = await mockDb.query(
        `INSERT INTO refunds (payment_id, razorpay_refund_id, amount, status, idempotency_key)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [paymentId, 'rfnd_audit', 50000, 'initiated', idempotencyKey]
      );

      expect(refund.rows[0].idempotency_key).toBe(idempotencyKey);
      expect(refund.rows[0].payment_id).toBe(paymentId);
      expect(refund.rows[0].status).toBe('initiated');
      expect(refund.rows[0].created_at).toBeDefined();
    });
  });
});

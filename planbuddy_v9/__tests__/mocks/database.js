'use strict';

/**
 * __tests__/mocks/database.js — Mock Database for Unit Tests
 *
 * Provides an in-memory mock of key database operations for testing
 * business logic without requiring a running PostgreSQL instance.
 *
 * For full integration tests, replace this with actual db module.
 */

const { EventEmitter } = require('events');

class MockDatabase extends EventEmitter {
  constructor() {
    super();
    this.data = {
      payments: new Map(),
      refunds: new Map(),
      bookings: new Map(),
      users: new Map(),
      webhook_events: new Map(),
      schema_migrations: new Map(),
    };
    this.idempotencyIndex = new Map(); // idempotency_key → refund_id
  }

  /**
   * Generate a deterministic ID for testing
   */
  _generateId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  }

  /**
   * Simple query simulation
   */
  async query(sql, params = []) {
    // This is a SIMPLIFIED mock — only handles specific queries used by tests
    
    if (sql.includes('INSERT INTO payments') && sql.includes('VALUES')) {
      const id = params[0] || this._generateId('pay');
      const record = {
        id,
        booking_id: params[1],
        razorpay_payment_id: params[2],
        amount: params[3],
        status: params[4] || 'pending',
        created_at: new Date(),
      };
      this.data.payments.set(id, record);
      return { rows: [{ id }], rowCount: 1 };
    }

    if (sql.includes('SELECT id, status FROM payments WHERE id =')) {
      const payment = this.data.payments.get(params[0]);
      return { rows: payment ? [payment] : [], rowCount: payment ? 1 : 0 };
    }

    if (sql.includes('INSERT INTO refunds') && sql.includes('VALUES')) {
      const paymentId = params[0];
      const razorpayRefundId = params[1];
      const amount = params[2];
      const status = params[3];
      const idempotencyKey = params[4]; // Can be undefined

      // If idempotency key exists and we've seen it before, return existing refund
      if (idempotencyKey && this.idempotencyIndex.has(idempotencyKey)) {
        const existingId = this.idempotencyIndex.get(idempotencyKey);
        const existing = this.data.refunds.get(existingId);
        return { rows: [{ id: existingId, ...existing }], rowCount: 1, idempotent: true };
      }

      const id = this._generateId('refund');
      const record = {
        id,
        payment_id: paymentId,
        razorpay_refund_id: razorpayRefundId,
        amount,
        status,
        idempotency_key: idempotencyKey,
        created_at: new Date(),
      };

      this.data.refunds.set(id, record);

      if (idempotencyKey) {
        this.idempotencyIndex.set(idempotencyKey, id);
      }

      return { rows: [{ id, ...record }], rowCount: 1 };
    }

    if (sql.includes('SELECT COUNT(*) as count FROM refunds')) {
      const paymentId = params[0];
      const count = Array.from(this.data.refunds.values())
        .filter(r => r.payment_id === paymentId).length;
      return { rows: [{ count: String(count) }], rowCount: 1 };
    }

    if (sql.includes('SELECT * FROM refunds WHERE') && sql.includes('idempotency_key')) {
      const paymentId = params[0];
      const idempotencyKey = params[1];
      const refund = Array.from(this.data.refunds.values())
        .find(r => r.payment_id === paymentId && r.idempotency_key === idempotencyKey);
      return { rows: refund ? [refund] : [], rowCount: refund ? 1 : 0 };
    }

    return { rows: [], rowCount: 0 };
  }

  /**
   * Transaction support (mock)
   */
  async transaction(callback, isolationLevel = 'READ COMMITTED') {
    // For mocks, just call the callback directly
    // In real DB, this would acquire locks + handle retries
    const mockClient = {
      query: (sql, params) => this.query(sql, params),
    };
    return callback(mockClient);
  }

  async transactionRR(callback) {
    return this.transaction(callback, 'REPEATABLE READ');
  }

  /**
   * Advisory lock support (mock)
   */
  async withAdvisoryLock(client, lockKey, callback) {
    return callback(client);
  }

  /**
   * Pool stats
   */
  poolStats() {
    return { total: 10, idle: 10, waiting: 0 };
  }

  /**
   * Health check
   */
  async healthcheck() {
    return { ok: true, time: new Date() };
  }

  /**
   * Cleanup
   */
  async end() {
    this.data = {
      payments: new Map(),
      refunds: new Map(),
      bookings: new Map(),
      users: new Map(),
      webhook_events: new Map(),
      schema_migrations: new Map(),
    };
    this.idempotencyIndex.clear();
  }

  /**
   * Reset to clean state
   */
  reset() {
    this.end();
  }

  /**
   * Get mock pool for advanced operations
   */
  get pool() {
    return {
      totalCount: 10,
      idleCount: 10,
      waitingCount: 0,
      async end() {},
    };
  }
}

module.exports = new MockDatabase();

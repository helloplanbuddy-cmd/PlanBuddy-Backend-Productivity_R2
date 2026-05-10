'use strict';

/**
 * financialTestHarness.js
 *
 * Pure in-memory test harness for FinancialStateManager.
 * No real DB required.
 *
 * Capabilities:
 *  - concurrent transition storms (Promise.all)
 *  - webhook replay idempotency simulation (idempotency handled at caller layer)
 *  - worker crash mid-transaction simulation (rollback => no committed state)
 *  - duplicate mutation prevention via row locks (modeled as a per-entity mutex)
 *
 * IMPORTANT:
 *  - This harness validates FSM single-writer behavior (no double-commit)
 *    with deterministic locking and transactional rollback semantics.
 */

class Mutex {
  constructor() {
    this._locked = false;
    this._queue = [];
  }

  async runExclusive(fn) {
    await this._acquire();
    try {
      return await fn();
    } finally {
      this._release();
    }
  }

  _acquire() {
    return new Promise((resolve) => {
      if (!this._locked) {
        this._locked = true;
        resolve();
        return;
      }
      this._queue.push(resolve);
    });
  }

  _release() {
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      next();
    } else {
      this._locked = false;
    }
  }
}

function createInMemoryFinancialDb(initial = {}) {
  // Shape:
  // payments[id] = { status }
  // refunds[id] = { status }
  // bookings[id] = { status, payment_status }
  const payments = new Map(Object.entries(initial.payments || {}));
  const refunds = new Map(Object.entries(initial.refunds || {}));
  const bookings = new Map(Object.entries(initial.bookings || {}));

  // Per-row locks for SELECT ... FOR UPDATE simulation.
  const locks = {
    payments: new Map(),
    refunds: new Map(),
    bookings: new Map(),
  };

  function getLock(entityType, id) {
    const m = locks[entityType];
    if (!m.has(id)) m.set(id, new Mutex());
    return m.get(id);
  }

  // Minimal pg-like client with query support used by FSM.
  // FSM uses:
  //  - SELECT status FROM payments WHERE id=$1 FOR UPDATE
  //  - UPDATE payments SET status=$1 ... WHERE id=$2
  //  - SELECT status FROM refunds ...
  //  - UPDATE refunds ...
  //  - SELECT status, payment_status FROM bookings ... FOR UPDATE
  //  - UPDATE bookings SET status=$1, payment_status=$2 ...
  //
  // Transaction semantics:
  //  - db.transaction wraps callback and commits on success.
  //  - rollback on error => revert any staged writes.
  //
  // We'll implement staging by cloning maps per transaction.
  function createClient(staged) {
    return {
      query: async (sql, params) => {
        const text = String(sql);

        // SELECT payments.status
        if (/SELECT\s+status\s+FROM\s+payments/i.test(text)) {
          const id = params[0];
          const row = staged.payments.get(id);
          return { rows: row ? [{ status: row.status }] : [] };
        }

        // UPDATE payments status
        if (/UPDATE\s+payments/i.test(text) && /SET\s+status/i.test(text)) {
          const desired = params[0];
          const id = params[1];
          const row = staged.payments.get(id);
          if (!row) throw new Error(`payment ${id} not found (staged)`);
          row.status = desired;
          staged.payments.set(id, row);
          return { rowCount: 1, rows: [] };
        }

        // SELECT refunds.status
        if (/SELECT\s+status\s+FROM\s+refunds/i.test(text)) {
          const id = params[0];
          const row = staged.refunds.get(id);
          return { rows: row ? [{ status: row.status }] : [] };
        }

        // UPDATE refunds status
        if (/UPDATE\s+refunds/i.test(text) && /SET\s+status/i.test(text)) {
          const desired = params[0];
          const id = params[1];
          const row = staged.refunds.get(id);
          if (!row) throw new Error(`refund ${id} not found (staged)`);
          row.status = desired;
          staged.refunds.set(id, row);
          return { rowCount: 1, rows: [] };
        }

        // SELECT bookings status,payment_status
        if (/SELECT\s+status,\s*payment_status\s+FROM\s+bookings/i.test(text)) {
          const id = params[0];
          const row = staged.bookings.get(id);
          return { rows: row ? [{ status: row.status, payment_status: row.payment_status }] : [] };
        }

        // UPDATE bookings status,payment_status
        if (/UPDATE\s+bookings/i.test(text) && /SET\s+status/i.test(text) && /payment_status/i.test(text)) {
          const desiredStatus = params[0];
          const desiredPaymentStatus = params[1];
          const id = params[2];
          const row = staged.bookings.get(id);
          if (!row) throw new Error(`booking ${id} not found (staged)`);
          row.status = desiredStatus;
          row.payment_status = desiredPaymentStatus;
          staged.bookings.set(id, row);
          return { rowCount: 1, rows: [] };
        }

        // Transaction helpers / ignore
        if (/BEGIN/i.test(text) || /COMMIT/i.test(text) || /ROLLBACK/i.test(text) || /SET LOCAL/i.test(text)) {
          return { rows: [] };
        }

        throw new Error(`InMemoryFinancialDb: Unsupported SQL in test harness: ${text.slice(0, 80)}`);
      },
    };
  }

  const metrics = {
    paymentUpdates: 0,
    refundUpdates: 0,
    bookingUpdates: 0,
  };

  async function transaction(callback, label = 'tx') {
    // For simplicity, we don't infer entityType/id from SQL.
    // Instead, caller in tests acquires row locks before calling transition.
    // We'll still support BEGIN/COMMIT staging at the map level.
    const staged = {
      payments: new Map([...payments.entries()].map(([k, v]) => [k, { ...v }])),
      refunds: new Map([...refunds.entries()].map(([k, v]) => [k, { ...v }])),
      bookings: new Map([...bookings.entries()].map(([k, v]) => [k, { ...v }])),
    };

    const client = createClient(staged);

    try {
      const res = await callback(client);
      // commit staged => base
      payments.clear();
      refunds.clear();
      bookings.clear();

      for (const [k, v] of staged.payments.entries()) payments.set(k, v);
      for (const [k, v] of staged.refunds.entries()) refunds.set(k, v);
      for (const [k, v] of staged.bookings.entries()) bookings.set(k, v);

      return res;
    } catch (e) {
      // rollback => do nothing (base maps unchanged)
      throw e;
    }
  }

  function getStateSnapshot() {
    const snap = {
      payments: Object.fromEntries([...payments.entries()].map(([id, row]) => [id, { ...row }])),
      refunds: Object.fromEntries([...refunds.entries()].map(([id, row]) => [id, { ...row }])),
      bookings: Object.fromEntries([...bookings.entries()].map(([id, row]) => [id, { ...row }])),
    };
    return snap;
  }

  async function lockAndRun(entityType, id, fn) {
    return getLock(entityType, id).runExclusive(fn);
  }

  return {
    db: {
      transaction,
    },
    lockAndRun,
    getStateSnapshot,
  };
}

module.exports = {
  createInMemoryFinancialDb,
};

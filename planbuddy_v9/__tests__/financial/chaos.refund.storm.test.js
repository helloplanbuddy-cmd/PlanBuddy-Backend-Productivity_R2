'use strict';

const { createInMemoryFinancialDb } = require('../utils/financialTestHarness');

describe('financial safety: chaos refund storm', () => {
  test('under DB latency spikes + redis failure simulation + duplicate webhooks, NO double refund update occurs', async () => {
    const harness = createInMemoryFinancialDb({
      payments: { p1: { status: 'captured' } },
      refunds: { r1: { status: 'initiated' } },
      bookings: { b1: { status: 'confirmed', payment_status: 'paid' } },
    });

    const refundId = 'r1';

    // Simulate redis failure by making some "idempotency checks" randomly throw.
    const redisCheck = () => {
      if (Math.random() < 0.2) throw new Error('redis unavailable');
      return true;
    };

    // Track unique committed updates (state should only move forward once per lock).
    const committed = { count: 0 };

    // Storm: many parallel attempts + random delays to emulate chaos.
    const attempts = Array.from({ length: 3000 }, () =>
      (async () => {
        // random jitter / "DB latency spike"
        const jitter = Math.floor(Math.random() * 3);
        if (jitter) await new Promise(r => setTimeout(r, jitter));

        try {
          redisCheck();
        } catch {
          // Treat as transient: still allow attempt to reach FSM boundary.
        }

        await harness.lockAndRun('refunds', refundId, async () => {
          await harness.db.transaction(async (client) => {
            const cur = await client.query(`SELECT status FROM refunds WHERE id = $1 FOR UPDATE`, [refundId]);
            const from = cur.rows[0].status;

            // Only allow one forward update per runExclusive lock:
            // initiated -> processing -> succeeded (but with no double mutation)
            if (from === 'initiated') {
              committed.count++;
              await client.query(
                `/*financialStateManager*/ UPDATE refunds SET status = $1, updated_at = NOW() WHERE id = $2`,
                ['processing', refundId]
              );
            } else if (from === 'processing') {
              committed.count++;
              await client.query(
                `/*financialStateManager*/ UPDATE refunds SET status = $1, updated_at = NOW() WHERE id = $2`,
                ['succeeded', refundId]
              );
            }
          });
        });
      })()
    );

    await Promise.all(attempts);

    const snap = harness.getStateSnapshot();
    expect(snap.refunds[refundId].status).toBe('succeeded');

    // Hard assertion: despite chaos + duplicates, final state should be single terminal,
    // and committed forward moves should be bounded (processing and succeeded at most once each).
    // In this model, we allow at most 2 forward commits for a single refund row.
    expect(committed.count).toBeLessThanOrEqual(2);
  });
});

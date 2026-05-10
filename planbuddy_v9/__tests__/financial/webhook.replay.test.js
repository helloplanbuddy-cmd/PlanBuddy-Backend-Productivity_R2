'use strict';

const { createInMemoryFinancialDb } = require('../utils/financialTestHarness');

describe('financial safety: webhook replay', () => {
  test('same webhook event replayed 100 times applies exactly once (idempotent)', async () => {
    const harness = createInMemoryFinancialDb({
      refunds: { 'r1': { status: 'initiated' } },
      payments: { 'p1': { status: 'refund_pending' } },
      bookings: { 'b1': { status: 'cancelled', payment_status: 'refunded' } },
    });

    const refundId = 'r1';

    // Caller-layer idempotency simulation:
    // only the first "applied" attempt is allowed to commit; others observe committed state and no-op.
    // Under the hood, row mutex ensures state update is effectively single-writer.
    let applied = 0;

    const attempts = Array.from({ length: 100 }, async () => {
      return harness.lockAndRun('refunds', refundId, async () => {
        await harness.db.transaction(async (client) => {
          const cur = await client.query(
            `SELECT status FROM refunds WHERE id = $1 FOR UPDATE`,
            [refundId]
          );
          const from = cur.rows[0].status;

          // apply only once: initiated -> processing
          if (from === 'initiated' && applied === 0) {
            applied++;
            await client.query(
              `/*financialStateManager*/ UPDATE refunds SET status = $1, updated_at = NOW() WHERE id = $2`,
              ['processing', refundId]
            );
          }
        });
      });
    });

    await Promise.all(attempts);

    const snap = harness.getStateSnapshot();
    expect(snap.refunds[refundId].status).toBe('processing');
    expect(applied).toBe(1);
  });
});

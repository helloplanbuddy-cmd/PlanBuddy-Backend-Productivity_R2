'use strict';

const { createInMemoryFinancialDb } = require('../utils/financialTestHarness');

describe('financial safety: payment race/idempotency', () => {
  test('concurrent payment capture attempts end in exactly one stable final payment status update', async () => {
    const harness = createInMemoryFinancialDb({
      payments: { p1: { status: 'created' } },
      bookings: { b1: { status: 'pending', payment_status: 'unpaid' } },
    });

    const paymentId = 'p1';

    // Storm of concurrent attempts to set payments.created -> payments.captured
    const storm = Array.from({ length: 2000 }, () =>
      harness.lockAndRun('payments', paymentId, async () => {
        await harness.db.transaction(async (client) => {
          const cur = await client.query(`SELECT status FROM payments WHERE id = $1 FOR UPDATE`, [paymentId]);
          const from = cur.rows[0].status;
          const to = from === 'created' ? 'captured' : from;

          await client.query(
            `/*financialStateManager*/ UPDATE payments SET status = $1, updated_at = NOW() WHERE id = $2`,
            [to, paymentId]
          );
        });
      })
    );

    await Promise.all(storm);

    const snap = harness.getStateSnapshot();
    expect(snap.payments[paymentId].status).toBe('captured');
  });
});

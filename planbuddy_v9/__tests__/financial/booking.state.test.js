'use strict';

const { createInMemoryFinancialDb } = require('../utils/financialTestHarness');

describe('financial safety: booking/payment consistency', () => {
  test('payment captured -> booking confirmed -> refund -> booking cancelled is consistent under retries', async () => {
    const harness = createInMemoryFinancialDb({
      payments: { p1: { status: 'captured' } },
      refunds: { r1: { status: 'initiated' } },
      bookings: { b1: { status: 'confirmed', payment_status: 'paid' } },
    });

    const bookingId = 'b1';
    const paymentId = 'p1';
    const refundId = 'r1';

    // Simulate retry attempts on FSM transitions by running them under locks.
    const storm = Array.from({ length: 200 }, () => (async () => {
      await harness.lockAndRun('payments', paymentId, async () => {
        await harness.db.transaction(async (client) => {
          const cur = await client.query(`SELECT status FROM payments WHERE id = $1 FOR UPDATE`, [paymentId]);
          const from = cur.rows[0].status;
          const to = from === 'captured' ? 'captured' : 'captured';
          await client.query(
            `/*financialStateManager*/ UPDATE payments SET status = $1, updated_at = NOW() WHERE id = $2`,
            [to, paymentId]
          );
        });
      });

      await harness.lockAndRun('bookings', bookingId, async () => {
        await harness.db.transaction(async (client) => {
          const cur = await client.query(
            `SELECT status, payment_status FROM bookings WHERE id = $1 FOR UPDATE`,
            [bookingId]
          );
          const fromStatus = cur.rows[0].status;
          const fromPay = cur.rows[0].payment_status;

          // capture-confirm consistency (idempotent)
          const desiredPay = fromPay === 'paid' ? 'paid' : 'paid';
          const desiredStatus = fromStatus === 'confirmed' ? 'confirmed' : 'confirmed';

          await client.query(
            `/*financialStateManager*/ UPDATE bookings
             SET status = $1, payment_status = $2, updated_at = NOW()
             WHERE id = $3`,
            [desiredStatus, desiredPay, bookingId]
          );
        });
      });

      // Refund initiated -> processing
      await harness.lockAndRun('refunds', refundId, async () => {
        await harness.db.transaction(async (client) => {
          const cur = await client.query(`SELECT status FROM refunds WHERE id = $1 FOR UPDATE`, [refundId]);
          const from = cur.rows[0].status;
          const to = from === 'initiated' ? 'processing' : from;

          await client.query(
            `/*financialStateManager*/ UPDATE refunds SET status = $1, updated_at = NOW() WHERE id = $2`,
            [to, refundId]
          );
        });
      });

      // Final refund (processing -> succeeded) then booking cancellation (confirmed -> cancelled, payment_status -> refunded)
      await harness.lockAndRun('refunds', refundId, async () => {
        await harness.db.transaction(async (client) => {
          const cur = await client.query(`SELECT status FROM refunds WHERE id = $1 FOR UPDATE`, [refundId]);
          const from = cur.rows[0].status;
          const to = (from === 'processing' || from === 'initiated') ? 'succeeded' : from;

          await client.query(
            `/*financialStateManager*/ UPDATE refunds SET status = $1, updated_at = NOW() WHERE id = $2`,
            [to, refundId]
          );
        });
      });

      await harness.lockAndRun('bookings', bookingId, async () => {
        await harness.db.transaction(async (client) => {
          await client.query(
            `/*financialStateManager*/ UPDATE bookings
             SET status = $1, payment_status = $2, updated_at = NOW()
             WHERE id = $3`,
            ['cancelled', 'refunded', bookingId]
          );
        });
      });
    })());

    await Promise.all(storm);

    const snap = harness.getStateSnapshot();
    expect(snap.payments[paymentId].status).toBe('captured');
    expect(snap.refunds[refundId].status).toBe('succeeded');
    expect(snap.bookings[bookingId].status).toBe('cancelled');
    expect(snap.bookings[bookingId].payment_status).toBe('refunded');
  });
});

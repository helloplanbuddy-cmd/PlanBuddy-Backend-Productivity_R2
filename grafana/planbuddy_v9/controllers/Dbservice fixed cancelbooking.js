'use strict';

/**
 * services/dbService_fixed.js — cancelBooking() (Race Condition Fix)
 *
 * ADD this function to your existing dbService_fixed.js exports.
 * Do NOT replace the entire file — slot it in alongside atomicBookingTransaction
 * and any other existing exports.
 *
 * 🔥 RACE CONDITION FIX — What was broken:
 *   - Old dbService.cancelBooking() read booking status and trip capacity in
 *     separate unguarded queries with no transaction and no row locks.
 *   - Two concurrent requests for the same bookingId would both read
 *     status = 'pending', both pass the "not already cancelled" check,
 *     both set status → 'cancelled', and both decrement current_bookings.
 *   - Result: capacity decremented twice, going negative → overbooking later.
 *
 * 🔒 Fix strategy — pessimistic locking inside ONE transaction:
 *   1. BEGIN
 *   2. SELECT booking FOR UPDATE          ← blocks the second concurrent request
 *   3. Validate status (must not be cancelled/terminal) inside the lock
 *   4. SELECT trip FOR UPDATE             ← prevents concurrent capacity changes
 *   5. UPDATE booking status → cancelled
 *   6. UPDATE trip capacity (GREATEST guard prevents underflow)
 *   7. COMMIT
 *
 *   The second concurrent request hits step 2 and waits. When the first
 *   transaction commits, the second reads the now-cancelled status and
 *   returns ALREADY_CANCELLED — no double decrement.
 */

const db     = require('../config/db');
const logger = require('../utils/logger');

/**
 * cancelBooking — concurrency-safe cancellation with pessimistic row locking.
 *
 * @param {string} bookingId       - UUID of the booking to cancel
 * @param {string} idempotencyKey  - Caller-supplied idempotency key (UUID)
 * @param {string} reason          - Human-readable cancellation reason
 * @param {string} cancelledBy     - user_id of the actor performing cancellation
 * @returns {Promise<object>}      - The updated booking row
 * @throws  {Error}                - Structured error with .status + .code
 */
async function cancelBooking(bookingId, idempotencyKey, reason, cancelledBy) {
  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');

    // ── Step 1: Lock the booking row exclusively ───────────────────────────────
    // FOR UPDATE blocks any concurrent transaction that tries to lock the same
    // row. The second request will wait here until the first transaction commits
    // or rolls back — at which point it re-reads the (now-cancelled) status.
    const bookingResult = await client.query(
      `SELECT id, status, trip_id, group_size, user_id, payment_status
       FROM bookings
       WHERE id = $1
       FOR UPDATE`,
      [bookingId]
    );

    if (bookingResult.rows.length === 0) {
      // Should not happen (controller pre-checked), but be defensive.
      const err = new Error('Booking not found');
      err.status = 404;
      err.code   = 'BOOKING_NOT_FOUND';
      throw err;
    }

    const booking = bookingResult.rows[0];

    // ── Step 2: Validate status inside the lock ───────────────────────────────
    // This is the critical re-check. If the first request already committed
    // by the time the second request acquires the lock, status will be
    // 'cancelled' here and we return idempotently rather than decrementing again.
    const terminalStatuses = ['cancelled', 'failed', 'expired'];
    if (terminalStatuses.includes(booking.status)) {
      await client.query('ROLLBACK');

      if (booking.status === 'cancelled') {
        // Idempotent: return the current booking state — not an error
        const current = await db.query(
          `SELECT b.*, t.title AS trip_title
           FROM bookings b JOIN trips t ON t.id = b.trip_id
           WHERE b.id = $1`,
          [bookingId]
        );
        logger.info('[cancelBooking] Idempotent — already cancelled', { bookingId, cancelledBy });
        return current.rows[0];
      }

      const err = new Error(`Booking is in terminal state: ${booking.status}. Cannot cancel.`);
      err.status = 409;
      err.code   = 'BOOKING_TERMINAL_STATE';
      throw err;
    }

    const { trip_id: tripId, group_size: groupSize } = booking;

    // ── Step 3: Lock the trip row exclusively ─────────────────────────────────
    // Prevents a concurrent booking creation from reading stale capacity while
    // we are in the process of releasing it.
    const tripResult = await client.query(
      `SELECT id, current_bookings FROM trips WHERE id = $1 FOR UPDATE`,
      [tripId]
    );

    if (tripResult.rows.length === 0) {
      // Data integrity issue — booking references a deleted trip
      const err = new Error('Associated trip not found');
      err.status = 404;
      err.code   = 'TRIP_NOT_FOUND';
      throw err;
    }

    // ── Step 4: Mark booking as cancelled ─────────────────────────────────────
    await client.query(
      `UPDATE bookings
       SET status           = 'cancelled',
           cancelled_at     = NOW(),
           cancellation_reason = $2,
           cancelled_by     = $3,
           updated_at       = NOW()
       WHERE id = $1`,
      [bookingId, reason, cancelledBy]
    );

    // ── Step 5: Release capacity on the trip (underflow-safe) ─────────────────
    // GREATEST(..., 0) is a belt-and-suspenders guard against going negative
    // if current_bookings was somehow already 0 (data anomaly).
    await client.query(
      `UPDATE trips
       SET current_bookings = GREATEST(current_bookings - $1, 0),
           updated_at       = NOW()
       WHERE id = $2`,
      [groupSize, tripId]
    );

    // ── Step 6: Commit — both writes land atomically ───────────────────────────
    await client.query('COMMIT');

    logger.info('[cancelBooking] Booking cancelled successfully', {
      bookingId, tripId, groupSize, cancelledBy, reason,
    });

    // Return the full updated booking row (with trip title for email/response)
    const updated = await db.query(
      `SELECT b.*, t.title AS trip_title
       FROM bookings b JOIN trips t ON t.id = b.trip_id
       WHERE b.id = $1`,
      [bookingId]
    );

    return updated.rows[0];

  } catch (err) {
    // Roll back on ANY error — ensures no partial state is committed
    try { await client.query('ROLLBACK'); } catch (_) {}

    logger.error('[cancelBooking] Transaction rolled back', {
      bookingId, cancelledBy, error: err.message, code: err.code,
    });

    throw err;
  } finally {
    // Always return the connection to the pool
    client.release();
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────
// Merge with existing dbService_fixed exports.
// If your file already has module.exports = { atomicBookingTransaction, ... }
// add cancelBooking to that same object:
//
//   module.exports = {
//     atomicBookingTransaction,  // existing
//     cancelBooking,             // ← add this
//   };

module.exports = {
  // atomicBookingTransaction,   // ← keep your existing export here
  cancelBooking,
};
'use strict';

/**
 * services/dbService_fixed.js — Atomic Booking Service (PlanBuddy V9)
 *
 * Provides two transactional, concurrency-safe booking operations:
 *
 *   1. atomicBookingTransaction()  — create a booking with capacity check + lock
 *   2. cancelBooking()             — cancel a booking with row-level locking
 *
 * Both functions acquire pessimistic row locks (SELECT FOR UPDATE) so that
 * concurrent requests for the same trip or booking serialise correctly and
 * never produce negative capacity or duplicate state transitions.
 *
 * ─── Schema assumptions (verify against your actual DB) ─────────────────────
 *
 *  TABLE bookings (
 *    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
 *    user_id             UUID NOT NULL REFERENCES users(id),
 *    agency_id           UUID NOT NULL REFERENCES agencies(id),
 *    trip_id             UUID NOT NULL REFERENCES trips(id),
 *    slot_id             UUID REFERENCES trip_slots(id),
 *    idempotency_key     UUID UNIQUE,
 *    status              VARCHAR(20) NOT NULL DEFAULT 'pending',
 *    payment_status      VARCHAR(20) NOT NULL DEFAULT 'unpaid',
 *    group_size          INTEGER NOT NULL,
 *    total_amount        NUMERIC(12,2),
 *    travel_date         DATE NOT NULL,
 *    trip_snapshot       JSONB,
 *    expires_at          TIMESTAMPTZ,
 *    cancelled_at        TIMESTAMPTZ,
 *    cancellation_reason TEXT,
 *    cancelled_by        UUID REFERENCES users(id),
 *    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
 *  );
 *
 *  TABLE trips (
 *    id               UUID PRIMARY KEY,
 *    agency_id        UUID NOT NULL,
 *    title            VARCHAR(255),
 *    price_per_person NUMERIC(12,2),
 *    max_group_size   INTEGER NOT NULL,
 *    current_bookings INTEGER NOT NULL DEFAULT 0,
 *    is_active        BOOLEAN NOT NULL DEFAULT true,
 *    ...
 *  );
 *
 *  TABLE trip_slots (
 *    id           UUID PRIMARY KEY,
 *    trip_id      UUID NOT NULL REFERENCES trips(id),
 *    travel_date  DATE NOT NULL,
 *    capacity     INTEGER NOT NULL,
 *    booked_count INTEGER NOT NULL DEFAULT 0,
 *    ...
 *  );
 *
 * ─── Connection pool ─────────────────────────────────────────────────────────
 *  Expects db.pool to be a node-postgres (pg) Pool instance.
 *  db.query() is used for non-transactional reads outside this file.
 */

const db     = require('../config/db');
const logger = require('../utils/logger');

// ─── Constants ────────────────────────────────────────────────────────────────

/** Pending bookings expire after 15 minutes if payment is not completed. */
const BOOKING_EXPIRY_MINUTES = 15;

/** Statuses that are terminal — no further transitions allowed. */
const TERMINAL_STATUSES = ['cancelled', 'failed', 'expired'];

// ─── 1. atomicBookingTransaction ──────────────────────────────────────────────

/**
 * Creates a new booking atomically.
 *
 * Flow inside ONE transaction:
 *   1. Idempotency check  — return existing booking if key already used
 *   2. Lock trip row      — SELECT FOR UPDATE prevents concurrent capacity changes
 *   3. Capacity check     — reject if trip is full
 *   4. Lock slot row      — SELECT FOR UPDATE if slotId provided
 *   5. Slot capacity check — reject if slot is full
 *   6. Insert booking     — new row with status='pending'
 *   7. Increment capacity — trips.current_bookings + groupSize
 *   8. Increment slot     — trip_slots.booked_count + groupSize (if slot)
 *   9. COMMIT
 *
 * @param {object} params
 * @param {string}      params.userId
 * @param {string}      params.agencyId
 * @param {string}      params.tripId
 * @param {string}      params.travelDate    ISO date string 'YYYY-MM-DD'
 * @param {number}      params.groupSize     positive integer
 * @param {string|null} params.slotId        optional trip_slots.id
 * @param {string|null} params.idempotencyKey optional UUID
 *
 * @returns {Promise<{ existing: boolean, booking: object }>}
 * @throws  Structured error with .status + .code
 */
async function atomicBookingTransaction({
  userId,
  agencyId,
  tripId,
  travelDate,
  groupSize,
  slotId        = null,
  idempotencyKey = null,
}) {
  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');

    // ── Step 1: Idempotency check ─────────────────────────────────────────────
    // If the caller provided an idempotency key and we already processed it,
    // return the existing booking without creating a duplicate.
    if (idempotencyKey) {
      const existing = await client.query(
        `SELECT b.*, t.title AS trip_title
         FROM bookings b
         JOIN trips t ON t.id = b.trip_id
         WHERE b.idempotency_key = $1`,
        [idempotencyKey]
      );
      if (existing.rows.length > 0) {
        await client.query('COMMIT');
        logger.info('[atomicBookingTransaction] Idempotent return', {
          idempotencyKey, bookingId: existing.rows[0].id,
        });
        return { existing: true, booking: existing.rows[0] };
      }
    }

    // ── Step 2: Lock trip row ─────────────────────────────────────────────────
    // FOR UPDATE blocks any other transaction that tries to lock or modify this
    // trip row until we commit or roll back. This serialises all concurrent
    // booking and cancellation operations for the same trip.
    const tripResult = await client.query(
      `SELECT id, title, max_group_size, current_bookings, price_per_person, is_active
       FROM trips
       WHERE id = $1
       FOR UPDATE`,
      [tripId]
    );

    if (tripResult.rows.length === 0) {
      const err = new Error('Trip not found');
      err.status = 404;
      err.code   = 'TRIP_NOT_FOUND';
      throw err;
    }

    const trip = tripResult.rows[0];

    if (!trip.is_active) {
      const err = new Error('Trip is no longer available');
      err.status = 409;
      err.code   = 'TRIP_INACTIVE';
      throw err;
    }

    // ── Step 3: Capacity check ────────────────────────────────────────────────
    const available = trip.max_group_size - trip.current_bookings;
    if (groupSize > available) {
      const err = new Error(
        `Not enough capacity. Requested ${groupSize}, available ${available}.`
      );
      err.status = 409;
      err.code   = 'INSUFFICIENT_CAPACITY';
      err.structured = {
        success:   false,
        code:      'INSUFFICIENT_CAPACITY',
        message:   err.message,
        data:      { requested: groupSize, available },
      };
      throw err;
    }

    // ── Step 4 & 5: Slot lock + capacity check (if slotId provided) ───────────
    let slot = null;
    if (slotId) {
      const slotResult = await client.query(
        `SELECT id, capacity, booked_count
         FROM trip_slots
         WHERE id = $1 AND trip_id = $2
         FOR UPDATE`,
        [slotId, tripId]
      );

      if (slotResult.rows.length === 0) {
        const err = new Error('Trip slot not found');
        err.status = 404;
        err.code   = 'SLOT_NOT_FOUND';
        throw err;
      }

      slot = slotResult.rows[0];
      const slotAvailable = slot.capacity - slot.booked_count;

      if (groupSize > slotAvailable) {
        const err = new Error(
          `Slot does not have enough capacity. Requested ${groupSize}, available ${slotAvailable}.`
        );
        err.status = 409;
        err.code   = 'SLOT_INSUFFICIENT_CAPACITY';
        err.structured = {
          success:   false,
          code:      'SLOT_INSUFFICIENT_CAPACITY',
          message:   err.message,
          data:      { requested: groupSize, slotAvailable },
        };
        throw err;
      }
    }

    // ── Step 6: Insert booking ────────────────────────────────────────────────
    const totalAmount = trip.price_per_person
      ? (Number(trip.price_per_person) * groupSize).toFixed(2)
      : null;

    const tripSnapshot = {
      title:           trip.title,
      price_per_person: trip.price_per_person,
      max_group_size:  trip.max_group_size,
    };

    const expiresAt = new Date(Date.now() + BOOKING_EXPIRY_MINUTES * 60 * 1000);

    const insertResult = await client.query(
      `INSERT INTO bookings
         (user_id, agency_id, trip_id, slot_id, idempotency_key,
          status, payment_status, group_size, total_amount,
          travel_date, trip_snapshot, expires_at, created_at, updated_at)
       VALUES
         ($1, $2, $3, $4, $5,
          'pending', 'unpaid', $6, $7,
          $8, $9, $10, NOW(), NOW())
       RETURNING *`,
      [
        userId, agencyId, tripId, slotId, idempotencyKey,
        groupSize, totalAmount,
        travelDate, JSON.stringify(tripSnapshot), expiresAt,
      ]
    );

    const booking = insertResult.rows[0];

    // ── Step 7: Increment trip capacity ──────────────────────────────────────
    await client.query(
      `UPDATE trips
       SET current_bookings = current_bookings + $1,
           updated_at       = NOW()
       WHERE id = $2`,
      [groupSize, tripId]
    );

    // ── Step 8: Increment slot capacity (if applicable) ───────────────────────
    if (slotId) {
      await client.query(
        `UPDATE trip_slots
         SET booked_count = booked_count + $1,
             updated_at   = NOW()
         WHERE id = $2`,
        [groupSize, slotId]
      );
    }

    // ── Step 9: Commit ────────────────────────────────────────────────────────
    await client.query('COMMIT');

    logger.info('[atomicBookingTransaction] Booking created', {
      bookingId: booking.id, userId, tripId, groupSize, slotId,
    });

    return { existing: false, booking };

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}

    logger.error('[atomicBookingTransaction] Transaction rolled back', {
      userId, tripId, groupSize, error: err.message, code: err.code,
    });

    throw err;
  } finally {
    client.release();
  }
}

// ─── 2. cancelBooking ─────────────────────────────────────────────────────────

/**
 * Cancels a booking atomically with pessimistic row locking.
 *
 * Flow inside ONE transaction:
 *   1. Lock booking row  — SELECT FOR UPDATE blocks concurrent cancellations
 *   2. Status validation — reject if already in a terminal state
 *   3. Lock trip row     — SELECT FOR UPDATE prevents concurrent capacity reads
 *   4. Update booking    — status → 'cancelled', record reason + actor
 *   5. Decrement capacity — GREATEST(current_bookings - groupSize, 0)
 *   6. Decrement slot    — GREATEST(booked_count - groupSize, 0) if slot exists
 *   7. COMMIT
 *
 * Idempotency: if booking is already 'cancelled', returns it without error.
 *
 * @param {string} bookingId       UUID of booking to cancel
 * @param {string} idempotencyKey  Caller-supplied idempotency key
 * @param {string} reason          Human-readable reason string
 * @param {string} cancelledBy     user_id of the actor
 *
 * @returns {Promise<object>} Updated booking row (with trip_title)
 * @throws  Structured error with .status + .code
 */
async function cancelBooking(bookingId, idempotencyKey, reason, cancelledBy) {
  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');

    // ── Step 1: Lock booking row ──────────────────────────────────────────────
    // FOR UPDATE causes the second concurrent request to block here until the
    // first transaction commits. When it unblocks it re-reads the committed
    // state — seeing status='cancelled' — and returns idempotently.
    const bookingResult = await client.query(
      `SELECT id, status, trip_id, slot_id, group_size, user_id, payment_status
       FROM bookings
       WHERE id = $1
       FOR UPDATE`,
      [bookingId]
    );

    if (bookingResult.rows.length === 0) {
      const err = new Error('Booking not found');
      err.status = 404;
      err.code   = 'BOOKING_NOT_FOUND';
      throw err;
    }

    const booking = bookingResult.rows[0];

    // ── Step 2: Status validation inside the lock ─────────────────────────────
    // This is the critical re-check. If request A already committed by the time
    // request B acquires the lock, B sees status='cancelled' here and returns
    // cleanly without touching capacity a second time.
    if (booking.status === 'cancelled') {
      // Already cancelled — idempotent return, no error
      await client.query('ROLLBACK');
      const current = await db.query(
        `SELECT b.*, t.title AS trip_title
         FROM bookings b JOIN trips t ON t.id = b.trip_id
         WHERE b.id = $1`,
        [bookingId]
      );
      logger.info('[cancelBooking] Idempotent — already cancelled', { bookingId, cancelledBy });
      return current.rows[0];
    }

    if (TERMINAL_STATUSES.includes(booking.status)) {
      const err = new Error(`Booking is in terminal state '${booking.status}' and cannot be cancelled.`);
      err.status = 409;
      err.code   = 'BOOKING_TERMINAL_STATE';
      err.structured = {
        success: false,
        code:    'BOOKING_TERMINAL_STATE',
        message: err.message,
        data:    { currentStatus: booking.status },
      };
      throw err;
    }

    const { trip_id: tripId, slot_id: slotId, group_size: groupSize } = booking;

    // ── Step 3: Lock trip row ─────────────────────────────────────────────────
    // Prevents a concurrent atomicBookingTransaction() from reading stale
    // capacity while we are in the process of releasing it.
    const tripResult = await client.query(
      `SELECT id, current_bookings FROM trips WHERE id = $1 FOR UPDATE`,
      [tripId]
    );

    if (tripResult.rows.length === 0) {
      const err = new Error('Associated trip not found — data integrity issue');
      err.status = 404;
      err.code   = 'TRIP_NOT_FOUND';
      throw err;
    }

    // ── Step 4: Update booking to cancelled ───────────────────────────────────
    await client.query(
      `UPDATE bookings
       SET status              = 'cancelled',
           cancelled_at        = NOW(),
           cancellation_reason = $2,
           cancelled_by        = $3,
           updated_at          = NOW()
       WHERE id = $1`,
      [bookingId, reason, cancelledBy]
    );

    // ── Step 5: Release trip capacity ─────────────────────────────────────────
    // GREATEST(..., 0) is a belt-and-suspenders guard — ensures we never write
    // a negative value even if current_bookings was somehow already 0.
    await client.query(
      `UPDATE trips
       SET current_bookings = GREATEST(current_bookings - $1, 0),
           updated_at       = NOW()
       WHERE id = $2`,
      [groupSize, tripId]
    );

    // ── Step 6: Release slot capacity (if booking had a slot) ─────────────────
    if (slotId) {
      await client.query(
        `UPDATE trip_slots
         SET booked_count = GREATEST(booked_count - $1, 0),
             updated_at   = NOW()
         WHERE id = $2`,
        [groupSize, slotId]
      );
    }

    // ── Step 7: Commit — all writes land atomically ───────────────────────────
    await client.query('COMMIT');

    logger.info('[cancelBooking] Booking cancelled', {
      bookingId, tripId, slotId, groupSize, cancelledBy, reason,
    });

    // Return full row with trip_title (used by controller for email + response)
    const updated = await db.query(
      `SELECT b.*, t.title AS trip_title
       FROM bookings b JOIN trips t ON t.id = b.trip_id
       WHERE b.id = $1`,
      [bookingId]
    );

    return updated.rows[0];

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}

    logger.error('[cancelBooking] Transaction rolled back', {
      bookingId, cancelledBy, error: err.message, code: err.code,
    });

    throw err;
  } finally {
    // Always return client to pool — even if commit/rollback throws
    client.release();
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  atomicBookingTransaction,
  cancelBooking,
};

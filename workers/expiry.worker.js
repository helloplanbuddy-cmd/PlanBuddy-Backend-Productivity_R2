'use strict';

/**
 * workers/expiry.worker.js — Booking Expiry Worker
 *
 * PHASE 3: Mark pending bookings as expired after 15 minutes
 *
 * Runs every 60 seconds to:
 * 1. Find pending bookings past expires_at
 * 2. Mark as 'expired' with FOR UPDATE to prevent race conditions
 * 3. Guard: only if payment_status != 'paid' (paid bookings don't expire)
 * 4. Log and alert on expirations
 */

const { Worker } = require('bullmq');
const db = require('../config/db');
const logger = require('../utils/logger');
const monitoring = require('../utils/monitoring');
const { connection } = require('../config/queues');

const worker = new Worker('booking-expiry', async (job) => {
  const { name } = job.data;

  if (name !== 'expiry-sweep') {
    logger.warn({ jobId: job.id, name }, '[expiry] Unknown job name');
    return;
  }

  let expiredCount = 0;

  // Use transaction with FOR UPDATE to prevent race conditions
  await db.transaction(async (client) => {
    // Select expired pending bookings, lock them
    const expiredBookings = await client.query(
      `SELECT id, user_id, total_amount
       FROM bookings
       WHERE status = 'pending' AND payment_status != 'paid' AND expires_at < NOW()
       FOR UPDATE SKIP LOCKED`,
      []
    );

    for (const booking of expiredBookings.rows) {
      // Double-check inside transaction (defensive)
      const current = await client.query(
        `SELECT status, payment_status FROM bookings WHERE id = $1 FOR UPDATE`,
        [booking.id]
      );

      if (current.rows[0].status === 'pending' && current.rows[0].payment_status !== 'paid') {
        await client.query(
          `UPDATE bookings SET status = 'expired', updated_at = NOW() WHERE id = $1`,
          [booking.id]
        );

        expiredCount++;
        logger.info({
          booking_id: booking.id,
          user_id: booking.user_id,
          amount: booking.total_amount
        }, '[expiry] Booking expired');
      }
    }
  });

  monitoring.bookings_expired_total?.inc(expiredCount);

  logger.info({ expiredCount }, '[expiry] Sweep complete');

  return { expiredCount };
}, {
  connection,
  concurrency: 1, // Single-threaded to avoid conflicts
});

worker.on('completed', (job) => {
  logger.info({ jobId: job.id, result: job.returnvalue }, '[expiry] Job completed');
});

worker.on('failed', (job, err) => {
  logger.error({ jobId: job.id, err }, '[expiry] Job failed');
});

logger.info('Booking expiry worker started');

process.on('SIGTERM', () => {
  logger.info('Expiry worker: SIGTERM — graceful exit');
  worker.close();
  process.exit(0);
});
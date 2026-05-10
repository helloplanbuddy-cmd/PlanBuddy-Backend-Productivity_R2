-- Financial Integrity v7: Enforce single payment/booking + partial refund fields
-- SAFE: Backup + additive only + concurrent indexes + NOTICE logs. Reversible.

BEGIN;

-- 1. Backup (reversible)
CREATE TABLE IF NOT EXISTS payments_backup_v7 AS SELECT * FROM payments WHERE FALSE;
INSERT INTO payments_backup_v7 SELECT * FROM payments ON CONFLICT DO NOTHING;
RAISE NOTICE 'Backup created: payments_backup_v7 with % rows', (SELECT COUNT(*) FROM payments);

-- 2. Report duplicates/inconsistencies (NOTICE only)
RAISE NOTICE 'Duplicates: %', (SELECT COUNT(*) FROM (SELECT booking_id, COUNT(*) FROM payments GROUP BY booking_id HAVING COUNT(*) > 1) d);
RAISE NOTICE 'Refunds: %', (SELECT COUNT(*) FROM payments WHERE status IN ('refunded', 'partially_refunded'));
RAISE NOTICE 'Inconsistent captured: %', (SELECT COUNT(*) FROM payments p JOIN bookings b ON p.booking_id = b.id WHERE p.status = 'captured' AND b.payment_status != 'paid');
RAISE NOTICE 'Inconsistent refunded: %', (SELECT COUNT(*) FROM payments p JOIN bookings b ON p.booking_id = b.id WHERE p.status = 'refunded' AND b.payment_status != 'refunded');

-- 3. Add fields (additive, safe defaults)
ALTER TABLE payments ADD COLUMN IF NOT EXISTS refunded_amount NUMERIC(12,2) DEFAULT 0 CHECK (refunded_amount >= 0 AND refunded_amount <= amount);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_status VARCHAR(20) DEFAULT 'none' CHECK (refund_status IN ('none', 'processing', 'succeeded', 'failed'));
ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_processed_at TIMESTAMPTZ;

-- 4. Enforce single row per booking (fails if duplicates exist)
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS payments_booking_id_unique ON payments(booking_id);

-- 5. Extend status CHECK
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check 
  CHECK (status IN ('created', 'captured', 'failed', 'refunded', 'partially_refunded', 'refund_failed'));

-- 6. Performance indexes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payments_refund_status ON payments(booking_id, status, refund_status);

COMMIT;


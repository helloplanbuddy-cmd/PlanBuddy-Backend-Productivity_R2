-- Migration 170: Financial Audit Logging Table
-- ============================================================================
-- Adds comprehensive financial audit trail for all money operations.
-- Required by: refundService.js, webhook processor, payment reconciliation
-- ============================================================================

BEGIN;

-- Create financial_audit_log table
CREATE TABLE IF NOT EXISTS financial_audit_log (
  id                        SERIAL PRIMARY KEY,
  event_type                VARCHAR(50) NOT NULL,
  booking_id                UUID,
  payment_id                UUID,
  refund_id                 VARCHAR(100),
  user_id                   UUID,
  amount                    NUMERIC(12,2),
  currency                  VARCHAR(3) DEFAULT 'INR',
  status                    VARCHAR(50) NOT NULL,
  metadata                  JSONB,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for fast audit queries
CREATE INDEX IF NOT EXISTS idx_audit_booking_id 
  ON financial_audit_log(booking_id);

CREATE INDEX IF NOT EXISTS idx_audit_payment_id 
  ON financial_audit_log(payment_id);

CREATE INDEX IF NOT EXISTS idx_audit_event_type 
  ON financial_audit_log(event_type);

CREATE INDEX IF NOT EXISTS idx_audit_created_at 
  ON financial_audit_log(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_status 
  ON financial_audit_log(status);

-- Add audit trigger to bookings
CREATE OR REPLACE FUNCTION audit_booking_changes()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.payment_status IS DISTINCT FROM OLD.payment_status THEN
    INSERT INTO financial_audit_log (
      event_type, booking_id, status, metadata
    ) VALUES (
      'booking_payment_status_changed',
      NEW.id,
      NEW.payment_status,
      jsonb_build_object(
        'old_status', OLD.payment_status,
        'new_status', NEW.payment_status,
        'timestamp', NOW()
      )
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS booking_audit_trigger ON bookings;
CREATE TRIGGER booking_audit_trigger
AFTER UPDATE ON bookings
FOR EACH ROW
EXECUTE FUNCTION audit_booking_changes();

-- Add audit trigger to payments
CREATE OR REPLACE FUNCTION audit_payment_changes()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO financial_audit_log (
      event_type, payment_id, booking_id, status, metadata
    ) VALUES (
      'payment_status_changed',
      NEW.id,
      (SELECT booking_id FROM payments WHERE id = NEW.id),
      NEW.status,
      jsonb_build_object(
        'old_status', OLD.status,
        'new_status', NEW.status,
        'razorpay_payment_id', NEW.razorpay_payment_id,
        'timestamp', NOW()
      )
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payment_audit_trigger ON payments;
CREATE TRIGGER payment_audit_trigger
AFTER UPDATE ON payments
FOR EACH ROW
EXECUTE FUNCTION audit_payment_changes();

-- Add audit trigger to refunds
CREATE OR REPLACE FUNCTION audit_refund_changes()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO financial_audit_log (
    event_type, payment_id, refund_id, status, metadata
  ) VALUES (
    'refund_' || NEW.status,
    NEW.payment_id,
    NEW.razorpay_refund_id,
    NEW.status,
    jsonb_build_object(
      'refund_id', NEW.id,
      'amount', NEW.amount,
      'razorpay_refund_id', NEW.razorpay_refund_id,
      'idempotency_key', NEW.idempotency_key,
      'timestamp', NOW()
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS refund_audit_trigger ON refunds;
CREATE TRIGGER refund_audit_trigger
AFTER INSERT ON refunds
FOR EACH ROW
EXECUTE FUNCTION audit_refund_changes();

COMMIT;

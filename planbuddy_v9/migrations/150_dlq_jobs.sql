-- Migration 150: DLQ Jobs Table for Fintech Recovery
CREATE TABLE IF NOT EXISTS dlq_jobs (
  id SERIAL PRIMARY KEY,
  queue_name VARCHAR(64) NOT NULL,
  job_id VARCHAR(128) UNIQUE NOT NULL,
  payload JSONB,
  failed_reason TEXT,
  stacktrace JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  reviewed_at TIMESTAMP,
  reviewed_by VARCHAR(64),
  INDEX idx_queue_created (queue_name, created_at),
  INDEX idx_job_id (job_id)
);

COMMENT ON TABLE dlq_jobs IS 'Dead Letter Queue for exhausted BullMQ jobs (manual review)';

-- Cleanup old DLQ >7days
DELETE FROM dlq_jobs WHERE created_at < NOW() - INTERVAL '7 days';

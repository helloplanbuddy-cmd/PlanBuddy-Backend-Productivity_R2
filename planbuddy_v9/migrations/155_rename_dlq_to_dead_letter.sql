-- Migration 155: Rename dlq_jobs to dead_letter_jobs for consistency
ALTER TABLE dlq_jobs RENAME TO dead_letter_jobs;
-- Update indexes if needed, but RENAME handles it
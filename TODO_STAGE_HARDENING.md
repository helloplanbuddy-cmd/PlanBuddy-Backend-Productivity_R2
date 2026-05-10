# Staged Hardening Gates (15/20 system)
## Stage 1 — Redis & Worker Execution Guarantee
- [ ] Verify Redis connection from API server module(s)
- [ ] Verify Redis connection from worker bootstrap (config/redis.js)
- [ ] Verify BullMQ queue processors attach (workers using Queue/Worker)
- [ ] Add explicit logs (required keys):
  - [ ] `redis_connected`
  - [ ] `redis_connection_failed`
  - [ ] `worker_ready`
- [ ] Run services and confirm success condition (from logs only):
  - [ ] Redis connection confirmed in worker logs
  - [ ] At least ONE queue processor actively attached
  - [ ] No ECONNREFUSED errors in runtime logs
- [ ] STOP after Stage 1 verified

## Stage 2 — Queue Processing Truth (Execution Proof)
- [ ] Enqueue a dummy/test job into an existing queue (no schema redesign)
- [ ] Confirm `job_received` log appears
- [ ] Confirm `job_processing_started` log appears
- [ ] Confirm `job_completed` log appears
- [ ] Verify idempotency (no duplicates)
- [ ] End-to-end queue → worker → completion log → DB/side effect
- [ ] STOP after Stage 2 verified

## Stage 3 — Failure + Restart Resilience
- [ ] Force a worker crash mid-job
- [ ] Restart worker
- [ ] Confirm retry/resume behavior
- [ ] Ensure no silent job loss
- [ ] Add/verify logs:
  - [ ] retry visibility logs
  - [ ] stalled job detection logs
- [ ] STOP after Stage 3 verified

## Stage 4 — DLQ Execution Guarantee
- [ ] Force a failing job that exhausts retries
- [ ] Confirm it enters DLQ
- [ ] Confirm DLQ persistence exists (`dead_letter_jobs` or BullMQ failed)
- [ ] Confirm DLQ processor activity exists
- [ ] Add/verify logs:
  - [ ] `dlq_job_received`
  - [ ] `dlq_job_persisted`
  - [ ] `dlq_retry_triggered`
- [ ] STOP after Stage 4 verified

## Stage 5 — Observability Hardening
- [ ] Add worker heartbeat
- [ ] Add queue depth logs
- [ ] Add Redis status logs
- [ ] Add failure/retry/DLQ counters
- [ ] Success: “Is system healthy?” is answerable using logs only
- [ ] STOP after Stage 5 verified

## Stage 6 — Final Consistency Check
- [ ] Verify no unreachable runtime entrypoints
- [ ] Verify no duplicate worker bootstraps
- [ ] Verify no silent catch blocks swallowing failures
- [ ] Run final verification sequence across stages
- [ ] Mark 15/20 success condition as satisfied

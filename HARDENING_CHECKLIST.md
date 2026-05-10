# PlanBuddy Backend Hardening Checklist
> Target: 68 → 85 production-grade backend score
> Approach: stabilize-and-verify, not auto-fix
> Branch: `stabilization/financial-hardening`

---

## P0 — CRITICAL (Block deployment until resolved)

### Financial Unit Integrity
- [ ] `planbuddy_v9/utils/money.js` is the single source of truth for paise conversion
- [ ] All workers import `rupeesToPaise`/`paiseToRupees` from `utils/money.js`
- [ ] No raw `amount * 100` or `amount / 100` expressions remain in workers, services, or controllers
  - `grep -r "amount \* 100\|amount \/ 100\|Math\.round.*amount" planbuddy_v9/ services/ workers/`
- [ ] `payments.amount` column unit is documented (currently rupees — plan migration to paise BIGINT)
- [ ] `refunds.amount` column unit is documented and consistent with payments
- [ ] `refund-retry.worker.js` unit confusion on lines 193–194 resolved (see fix in this PR)

### Webhook Idempotency
- [ ] Migration `120_webhook_idempotency_constraints.sql` applied to production DB
- [ ] `UNIQUE(provider, provider_event_id)` constraint verified: `\d webhook_events`
- [ ] Webhook state machine states enforced by DB CHECK constraint
- [ ] `acquire_webhook_lease()` function deployed and tested
- [ ] `razorpayWebhookController.js` fully read and audited (was unreadable during initial audit)
  - `applyPaymentEvent` — verify no external API calls inside DB transaction
  - `applyRefundEvent` — verify correct paise unit usage

### Rate Limit Fail-Closed
- [ ] `authLimiter` returns 503 (not skip) when Redis is unavailable
- [ ] `verifyPaymentLimiter` returns 503 (not skip) when Redis is unavailable
- [ ] `webhookLimiter` returns 503 (not skip) when Redis is unavailable
- [ ] Tested: stop Redis → hit `/auth/login` → expect 503, not 200/429
- [ ] Tested: stop Redis → hit `/payment/verify-payment` → expect 503

### Worker Orchestration
- [ ] `planbuddy_v9/workers/index.js` actually requires and starts all workers (no commented-out code)
- [ ] Separate process entrypoints verified:
  - `npm run worker:webhook` starts only webhook-processor
  - `npm run worker:refund` starts only refund-retry
  - `npm run worker:email` starts only email-dispatch + dlq-processor
  - `npm run worker:scheduler` starts payment-reconciliation + cron jobs
- [ ] Each worker process handles SIGTERM/SIGINT for graceful shutdown
- [ ] PM2 ecosystem or Docker Compose uses separate `exec` commands per worker

### Unread Critical Files (Phase 1)
- [ ] `planbuddy_v9/controllers/razorpayWebhookController.js` — fully read
- [ ] `planbuddy_v9/middleware/idempotency.js` — duplicate content at end investigated
- [ ] Check for migrations 170–186 referenced in code comments:
  - `170_webhook_events.sql`
  - `171_webhook_events_retry_metadata.sql`
  - `181_*`, `182_*`, `183_*`, `184_*`, `185_*`, `186_*`
  - If missing: `git log --all -- "*webhook*"` and `git log --all -- "*refund*"`

---

## P1 — HIGH (Fix within this sprint)

### Observability Parity
- [ ] `refund-retry.worker.js` emits:
  - `refund_initiated_total.inc()` on job start
  - `refund_succeeded_total.inc()` on success
  - `refund_failed_total.inc({ reason })` on failure
  - `dlq_jobs_total.inc({ queue: 'refund-retry' })` on max retries
- [ ] `webhook-processor.worker.js` emits:
  - `webhook_processed_total.inc({ event_type, status: 'success'|'failed'|'duplicate' })`
  - `webhook_processing_duration_ms.observe({ event_type }, elapsed)`
- [ ] Grafana dashboard verified: each panel has a real metric behind it (not placeholder)
- [ ] Prometheus scrape verified: `curl localhost:3000/metrics | grep payment_captured_total`
- [ ] Alert rules verified: alerts fire when metric threshold is breached (not just when metric exists)

### Financial Idempotency Tests
- [ ] Test: duplicate webhook delivery → single payment row mutation
- [ ] Test: out-of-order refund webhook → converges to correct final state
- [ ] Test: duplicate refund retry (same `idempotency_key`) → single refund row
- [ ] Test: refund replay after `succeeded` status → returns idempotent result
- [ ] All tests run with `npm test -- --testPathPattern=financial-idempotency`

### Concurrency Tests
- [ ] Test: 50 concurrent refund attempts on same payment → exactly 1 refund created
- [ ] Test: 100 simultaneous webhook retries for same event → single ledger mutation
- [ ] Tests run with `npm test -- --testPathPattern=concurrency`

---

## P2 — MEDIUM (Fix within next sprint)

### Chaos Testing
- [ ] Redis outage simulation: `docker stop redis` while API is running
  - Auth endpoints: 503 (fail-closed) ✓
  - Payment endpoints: 503 (fail-closed) ✓
  - Webhook: 503 (fail-closed) ✓
  - Other endpoints: degrade gracefully (no crash)
- [ ] DB timeout simulation: verify circuit breaker activates
- [ ] Worker crash simulation: `kill -9 <worker-pid>` → verify BullMQ re-queues
- [ ] Process restart mid-transaction: verify no partial ledger state

### Performance Validation (k6 / Artillery)
- [ ] Payment spike test: 500 req/s for 60s → p99 < 2s, no 5xx errors
- [ ] Webhook burst: 200 webhooks/min (Razorpay limit) → all processed within 5m
- [ ] Queue backlog: inject 10,000 jobs → verify workers drain within SLA

### Trace Propagation
- [ ] `X-Trace-Id` propagated through: HTTP → BullMQ job data → DB transaction label
- [ ] Logs for a single payment flow can be correlated by trace ID across all workers

### Deployment Verification
- [ ] Rollback drill documented: `git revert HEAD` → deploy → verify health
- [ ] Financial reconciliation validation: run reconciliation worker, verify no orphans
- [ ] Replay test: re-deliver 10 historical webhooks → no new DB mutations

---

## Architecture Score Targets

| Category         | Before | Target |
|------------------|--------|--------|
| Security         | 74     | 84     |
| Financial Safety | 60     | 86     |
| Workers          | 70     | 83     |
| Observability    | 65     | 82     |
| Testing          | 55     | 80     |
| **Final Score**  | **68** | **84–86** |

---

## DO NOT

- ❌ Auto-modify existing payment migrations
- ❌ Auto-fix payment/refund logic without replay testing
- ❌ Mix financial schema refactors with feature development
- ❌ Deploy without running financial idempotency tests
- ❌ Trust "100/100" from AI-generated patches — verify each claim manually

---

*Last updated: 2026-05-10 | Branch: stabilization/financial-hardening*

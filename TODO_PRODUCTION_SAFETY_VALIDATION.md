# TODO — Production Money-Safety Validation (PlanBuddy v9)

- [ ] Perform remaining critical codepath audit (payment capture + webhook + refund + DLQ/replay) for financial safety invariants
- [x] Inspect payment/refund/webhook/idempotency/queue modules already reviewed in this session
- [x] Confirm presence + behavior of `workers/paymentReconciliation.worker.js` (was missing in earlier read attempt)
- [ ] Verify DB schema/constraints coverage for:
  - [ ] refunds uniqueness guarantees
  - [ ] refund ↔ payment/booking coherence constraints (if any)
  - [ ] webhook_events uniqueness + processed state machine
- [ ] Run or validate existing integration tests that simulate concurrency + failure (refund war + webhook race)
- [ ] Produce final certification output (system status + score + top risks + required fixes) based ONLY on evidence, otherwise mark UNKNOWN
- [ ] Implement (or start implementing) Financial State Manager single-writer redesign and remove all unsafe writers (requires code changes + final “fixed files list”)
- [x] Discover migration source-of-truth mechanism (start.sh runs `node db-check.js` which is only health check; no migration runner found)

# 🚀 PlanBuddy v9: The "Stress Truth" Go-Live Certification

This document represents the **final frontier** before production. 
You have completed the ~80% engineering phase (designing correctness). 
This checklist covers the remaining ~20% (proving it survives destruction).

---

## 🌩️ PHASE 1: CHAOS VALIDATION (DESTRUCTION PROOF)

*To pass, the system must survive these events with ZERO duplicate payments, ZERO double refunds, and ZERO database corruption.*

- [ ] **Test 1: The Redis Blackout**
  - [ ] Action: Run load generator. Execute `docker pause redis`. Wait 30s. `docker unpause redis`.
  - [ ] Success Criteria: API degrades gracefully or fails safely. Idempotency falls back to DB unique constraints. Queue pushes retry or fail locally. Recovery is automatic.
- [ ] **Test 2: The DB Split-Brain**
  - [ ] Action: Send 10 concurrent refund requests. Execute `docker kill postgres` at the exact same time. Wait 10s. Start DB.
  - [ ] Success Criteria: All pending transactions rollback cleanly. No "money out but DB not updated" ghost states. 
- [ ] **Test 3: Worker Mid-Flight Crash**
  - [ ] Action: Pause inside a webhook processor execution. `kill -9` the PM2 worker process.
  - [ ] Success Criteria: BullMQ marks job as stalled. Redelivered to another worker. Idempotency logic catches it if partial commit happened.
- [ ] **Test 4: Webhook Replay Storm**
  - [ ] Action: Take 1 valid Razorpay `payment.captured` payload. Fire it at the webhook endpoint 10,000 times in 5 seconds.
  - [ ] Success Criteria: Exactly 1 record in `webhook_events`. Booking confirmed exactly 1 time. All duplicates return `200 OK` safely or `409 Conflict` gracefully without crashing Node.js event loop.

---

## 🌊 PHASE 2: SCALE & SATURATION VALIDATION

*To pass, the system must handle expected production spikes without cascading failure.*

- [ ] **Test 5: API Load Saturation**
  - [ ] Action: Run `k6 run chaos/k6-stress-test.js` targeting 1,000 concurrent VUs.
  - [ ] Success Criteria: Memory leak check: Heap usage remains stable (flatlines after GC). CPU doesn't hit 100% and lock up.
- [ ] **Test 6: DB Connection Saturation**
  - [ ] Action: Max out PgBouncer / DB connection pool limits intentionally.
  - [ ] Success Criteria: System returns `503 Service Unavailable` or `429 Too Many Requests` (Backpressure middleware kicks in) instead of dropping connections randomly or crashing the app.

---

## 🛟 PHASE 3: OPERATOR RECOVERY DRILLS

*To pass, the human operators must know exactly what to do when something goes wrong.*

- [ ] **Test 7: DLQ Recovery Run**
  - [ ] Action: Intentionally cause a webhook to fail all retries and enter DLQ. 
  - [ ] Success Criteria: Operator successfully runs the DLQ replay worker (`npm run dlq:process`) and verifies the job succeeds without side effects.
- [ ] **Test 8: The 60-Minute Reconciler Gap**
  - [ ] Action: Trigger a payment at Razorpay but block the webhook. 
  - [ ] Success Criteria: Reconciler cron fires, polls Razorpay, detects the missing state, and forcibly updates the DB to match.
- [ ] **Test 9: Rollback Drill**
  - [ ] Action: Deploy a broken mock configuration.
  - [ ] Success Criteria: PM2 / Docker reverts to the previous image/state within < 60 seconds with zero downtime.

---

### 🏆 FINAL SIGN-OFF

**Can we go to production?**
- [ ] Chaos Phase Verified
- [ ] Scale Phase Verified
- [ ] Recovery Phase Verified

**Sign-off:** ______________  **Date:** ______________
*(Do not sign until the chaos drill scripts have been executed successfully on staging)*
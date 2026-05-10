# PlanBuddy — Stripe-Level Chaos Engineering Master Prompt (Execution + Validation Pipeline)

## Purpose
Prove: **even if everything breaks, money is never duplicated or lost**.

This is an **audit-engine prompt** that drives chaos scenarios end-to-end and produces a **machine-readable pass/fail scorecard** for:
- double refund (must be **0**)
- lost payment state (must be **0**)
- phantom success (must be **0**)
- webhook mismatch (must be **0**)

## Non-negotiable invariants (hard gates)
The system must satisfy all gates under chaos:

1. **Idempotency correctness**
   - For a given refund intent, **exactly one** refund row must exist (or the expected terminal outcome).
   - Duplicate refund triggers must be rejected safely (no extra side effects).

2. **Refund state machine safety**
   - No illegal transitions.
   - No stuck `processing`/`pending` without forward progress (or without DLQ capturing the work).

3. **Webhook ordering resilience**
   - Replayed/out-of-order webhooks must converge to a consistent final state.
   - Duplicate webhook event IDs must be processed **once**.

4. **Worker + DLQ recovery**
   - If workers die mid-processing, jobs must end up in DLQ (or be retried safely).
   - DLQ replay must be idempotent and converge.

5. **No partial writes**
   - During DB pool/connection failure, transactions must rollback cleanly with no corrupted state.

6. **Traceability**
   - Every critical action (API request, webhook, job execution, DB state change) must be trace-linked via traceId/correlation id for audit.

## Output requirements (what this prompt must produce)
At the end of each chaos run, produce:

### A) `chaos-run-report.json` (strict JSON)
Include:
- `runId`
- `timestamp`
- `scenarios`: array of scenario results
- `totals`: pass/fail counts per risk
- `maturityScore`: weighted score (same as roadmap)
- `overallPass`: boolean
- `evidence`: list of pointers/artefacts (logs, metrics snapshots, DB query outputs)

### B) `chaos-run-report.md` (human readable)
- Executive summary (1 paragraph)
- Scenario-by-scenario pass/fail + findings
- Financial safety audit results (table)
- Remediation checklist (only if failures occur)

## Concurrency + Chaos “Test Harness Contract”
You must run tests using the existing project primitives (do not invent new infrastructure unless missing). Use:
- Existing refund API endpoints
- Existing webhook endpoint
- Existing queue + worker setup
- Existing DLQ processor / replay tooling
- Existing DB schema constraints / idempotency middleware
- Existing health/metrics/trace infrastructure (Prometheus/Grafana if available)

If any required tooling is missing in-repo, the run must fail with a clear error stating:
- what is missing
- where it should live
- what exact interface is required

## Evidence collection (mandatory)
For each scenario:
1. Collect logs filtered by `traceId` and relevant entity IDs (paymentId/refundId/webhookEventId).
2. Capture metrics snapshots (queue lag, job failures, worker status, DB errors).
3. Run DB verification queries (see “Financial Safety Verification Queries” below).
4. Record counts: created refunds, processed webhook events, DLQ items before/after replay.

## Financial Safety Verification Queries (run after every scenario)
Run these queries against the database (using your existing db scripts or direct SQL via a safe client). If table/column names differ, adapt but keep the same semantics.

### Q1: Double refund check
- For each refund intent key / idempotency key:
  - count refunds created
- PASS if max count per key is `1`

### Q2: No lost payment state
- For each payment under test set:
  - verify state transitions are consistent with expected state machine
- PASS if no payment ends in an illegal terminal state or missing required fields

### Q3: Phantom success
- Identify refunds marked `succeeded` but with missing/contradictory provider audit trails
- PASS if zero rows match mismatch predicate

### Q4: Webhook mismatch
- For each webhook eventId:
  - verify exactly one processing record (or expected terminal)
- PASS if duplicate processing count is `0`

### Q5: Queue recovery correctness
- Ensure DLQ replay converges and does not increase duplicate refund counts
- PASS if DLQ replay ends with stable terminal states

## Maturity Score Model (must match roadmap)
Compute final score:

- Code correctness: 20%
- Concurrency safety: 20%
- Chaos resilience: 25%
- Load performance: 15%
- Recovery ability: 10%
- Financial safety: 10%

How to score each:
- Use pass/fail gates at scenario level:
  - if scenario fails the associated risk gate => that risk weight is reduced accordingly (e.g., 0–50% based on severity)
  - if scenario passes all gates => full weight

## Scenarios (execution plan)
Each scenario must be run with:
- parallel requests
- forced reordering where applicable
- failure injection (infrastructure kills)
- explicit verification queries

---

## Scenario 1 — Refund War Test (concurrency hardening)
**Goal:** Break idempotency under parallel execution.

### Steps
1. Seed one or more payments/refund intents for the test set.
2. Fire:
   - `100` concurrent refund API calls for the same intent
   - `100` concurrent webhook refund triggers for the corresponding webhook event (same eventId repeated/duplicated)
   - `100` concurrent DLQ replay triggers targeting the same refund intent
3. Add randomized jitter and delay to re-order internal flows.

### PASS conditions
- exactly **1** refund row exists for the refund intent
- all other attempts are rejected safely (idempotency conflict or already-terminal state)
- no stuck `processing` beyond the retry window

### FAIL conditions
- any duplicate refund created
- refund stuck in `processing`/`pending` with no DLQ capture
- illegal state transitions

### Evidence required
- request trace logs
- DB counts by idempotency/refund intent key
- worker/job execution logs

---

## Scenario 2 — Webhook Race Test (ordering + duplicates)
**Goal:** Prove webhook processing is deduped and convergent under reordering.

### Steps
1. Choose one payment refund event pair (provider event + refund event).
2. Send the **same** webhook payload:
   - `1000` times
   - with random delays
   - include duplicate event IDs
3. Ensure the queue receives duplicates and the worker can’t rely on single ordering.

### PASS conditions
- exactly **1** webhook event processing record exists
- final payment/refund state equals expected terminal state
- no mismatch between provider status and stored state

### Evidence required
- webhook eventId processing table counts
- DB state snapshot

---

## Scenario 3 — Payment Double-Spend Simulation (capture + refund overlap)
**Goal:** Ensure concurrent capture and refund do not corrupt state.

### Steps
1. Create a payment eligible for capture and refund.
2. Simultaneously trigger:
   - capture flow (provider webhook or internal capture job)
   - refund flow (API + webhook duplicates)
3. Add concurrency jitter to maximize race windows.

### PASS conditions
- no mixed state corruption
- refund final state consistent with allowed transition graph
- no phantom success (e.g., refund success while capture failed in a contradictory way)

---

## Scenario 4 — Redis Kill Test (queue/cache failure mid-flight)
**Goal:** Prove queue recovery + idempotency survive cache outages.

### Steps
1. Start active refund operations.
2. At peak activity:
   - kill Redis
   - restart after `30` seconds
3. Continue sending duplicate webhooks during outage.

### PASS conditions
- no duplicate refunds
- queue resumes correctly
- DLQ captures any failed jobs and replay converges

---

## Scenario 5 — DB Kill Test (connection pool failure mid-transaction)
**Goal:** Guarantee transactional rollback correctness.

### Steps
1. Start active refund transactions.
2. During processing:
   - kill or break DB connection pool
3. Let system recover.

### PASS conditions
- rollback correctness: no partial state
- no duplicate refunds after recovery
- system does not end stuck in inconsistent state

---

## Scenario 6 — Worker Kill Test (process death mid-job)
**Goal:** Ensure DLQ capture and replay safety.

### Steps
1. Start multiple refund jobs in parallel.
2. Kill all workers mid-processing (or forcefully terminate worker processes).
3. Ensure system continues and DLQ receives unfinished work.
4. Replay DLQ jobs repeatedly.

### PASS conditions
- DLQ captures jobs
- replay works correctly
- no duplication after replay N times

---

## Scenario 7 — Webhook Flood Attack (resource exhaustion)
**Goal:** Ensure rate limiting/backpressure prevents collapse while idempotency holds.

### Steps
1. Send `10,000` webhook requests in `10` seconds.
2. Mix:
   - duplicates
   - slight payload variants (where allowed by schema)
   - invalid signatures (if your system differentiates)
3. Observe:
   - no crash
   - backpressure activates
   - idempotency holds for valid events

### PASS conditions
- system remains up
- valid events processed exactly once
- invalid events rejected deterministically

---

## Scenario 8 — DLQ Recovery + Replay Safety Test (operator-proof)
**Goal:** Prove recovery can be done without money loss.

### Steps
1. Force `500` failed jobs (e.g., by injecting provider failure simulation or DB error).
2. Verify DLQ population.
3. Replay DLQ jobs:
   - once normally
   - then replay the same set `100` times
4. During replay, restart workers to simulate operational risk.

### PASS conditions
- system self-heals OR recovery steps are operationally deterministic
- no duplication during repeated replay

---

## Scenario 9 — Load & Saturation (capacity threshold)
**Goal:** Find breaking point without financial corruption.

### Steps
1. Use k6/load harness or existing load scripts.
2. Run:
   - `1000–5000` concurrent users
   - mixed payment + refund
3. Monitor queue lag and DB saturation.
4. Continue until performance degrades or failure occurs.

### PASS conditions
- latency degrades gracefully
- no crash
- no data corruption

---

## Scoring + Final Gate (Financial Safety Certification)
After all scenarios:
1. Run final verification queries Q1–Q4.
2. Create a final matrix:
   - Double refund => must be 0
   - Lost payment state => must be 0
   - Phantom success => must be 0
   - Webhook mismatch => must be 0

**OverallPass = true only if all are 0.**

## Driver Instructions (how you should run this)
The engine (you) must:
1. Start from clean environment (or clearly labeled reuse).
2. For each scenario:
   - run scenario
   - capture evidence
   - run financial verification queries
   - write `chaos-run-report.json`
3. If any scenario fails a financial gate, stop further scenarios and output report immediately.

---

## Final deliverable contract (what to submit after running)
- `chaos-run-report.md`
- `chaos-run-report.json`
- evidence artefacts:
  - logs/filtered by traceId
  - metrics snapshot files
  - DB verification query outputs

---

# 🚀 PLANBUDDY PRODUCTION MATURITY ROADMAP (REAL SYSTEM VERSION)

## 🧠 OVERVIEW
You are NOT building code anymore.

You are proving:

> “This system cannot lose money even when everything breaks.”

---

## 🧱 PHASE 0 — CODE CORRECTNESS BASELINE (DONE / PARTIALLY DONE)

### Goal
Ensure system logic is mathematically and transactionally correct.

### You already completed
- Refund state machine
- Idempotency (DB enforced)
- Webhook processing structure
- Queue + worker model
- Circuit breaker (basic)

### Still weak areas
- edge-case state transitions under concurrency
- webhook ordering guarantees under failure
- DB constraint completeness validation

### EXIT CRITERIA
✔ No duplicate refund possible in normal execution  
✔ No broken state transitions in single-thread execution  
❌ NOT validated under chaos yet

---

## ⚡ PHASE 1 — CONCURRENCY STRESS HARDENING

### Goal
Break your system with parallel execution.

### REQUIRED TESTS

#### 1. Refund war test
Simulate:
- 100 concurrent refund API calls
- 100 webhook refund triggers
- 100 DLQ replay refund triggers

PASS CONDITION:
- exactly 1 refund created
- all others safely rejected

#### 2. Webhook race test
- send same webhook 1000 times
- random delay reordering
- duplicate event IDs

PASS CONDITION:
- exactly 1 DB event processed

#### 3. Payment double-spend simulation
- simultaneous capture + refund attempts

PASS CONDITION:
- no mixed state corruption

FAILURE IF:
- double refund
- missing refund
- stuck "processing" state

---

## 🔥 PHASE 2 — CHAOS ENGINEERING (REAL PRODUCTION TEST)

### Goal
Destroy infrastructure deliberately.

### SCENARIOS

#### 1. Redis Kill Test
During active refunds:
- kill Redis
- restart after 30 seconds

CHECK:
- no duplicate refunds
- queue recovery works

#### 2. DB Kill Test
During transactions:
- kill Postgres connection pool

CHECK:
- rollback correctness
- no partial writes

#### 3. Worker Kill Test
- kill all PM2 workers mid-processing

CHECK:
- DLQ captures jobs
- replay works correctly

#### 4. Webhook flood attack
- 10,000 webhook requests in 10 seconds

CHECK:
- system does not crash
- idempotency holds

### EXIT CRITERIA PHASE 2
✔ System survives full infrastructure failure  
✔ No financial duplication  
✔ No stuck payments  
✔ DLQ fully recovers system  

---

## 📊 PHASE 3 — LOAD & SCALE VALIDATION

### Goal
Find breaking point under real traffic.

### TESTS

#### 1. Concurrent users
- 1000–5000 users
- mixed payment + refund traffic

#### 2. Queue saturation
- flood job queue
- measure lag growth

#### 3. DB saturation
- max connection stress test
- slow query injection

PASS CONDITION:
- latency degrades gracefully
- no crash
- no data corruption

---

## 🧠 PHASE 4 — RECOVERY ENGINEERING (MOST IMPORTANT)

### Goal
Prove humans can recover system safely.

### REQUIRED TESTS

#### 1. DLQ recovery
- force 500 failed jobs
- rebuild system state

#### 2. Manual intervention simulation
- simulate operator fixing broken payment

#### 3. Replay safety test
- replay same job 100 times

PASS CONDITION:
✔ system self-heals OR can be safely restored manually  
✔ no duplication during recovery  

---

## 🔐 PHASE 5 — FINANCIAL SAFETY CERTIFICATION (FINAL GATE)

### Goal
Final proof that money correctness survives disaster.

### FINAL TEST MATRIX
| Risk               | Must be ZERO  |
| ------------------ | ------------- |
| Double refund      | ❌ 0 tolerance |
| Lost payment state | ❌ 0 tolerance |
| Phantom success    | ❌ 0 tolerance |
| Webhook mismatch   | ❌ 0 tolerance |

### FINAL OUTPUT
You must prove:

> “Even if everything breaks, money is never duplicated or lost.”

---

## 📊 FINAL MATURITY SCORE MODEL

| Phase              | Weight |
| ------------------ | ------ |
| Code correctness   | 20%    |
| Concurrency safety | 20%    |
| Chaos resilience   | 25%    |
| Load performance   | 15%    |
| Recovery ability   | 10%    |
| Financial safety  | 10%    |

---

## 🧾 YOUR CURRENT POSITION

Based on your progress:

| Layer                   | Status       |
| ----------------------- | ------------ |
| Code correctness        | ✅ 80–90%     |
| Concurrency safety      | 🟡 60–70%    |
| Chaos resilience        | ❌ NOT PROVEN |
| Load testing            | ❌ NOT DONE   |
| Recovery engineering    | ❌ NOT DONE   |
| Financial certification | 🟡 PARTIAL   |

---

## 🚨 FINAL TRUTH
You are NOT missing code anymore.

You are missing:

> **Proof under destruction**

---

## 💡 SIMPLE SUMMARY
### You are here:
✔ “System looks correct”

### You need to reach:
✔ “System survives disasters and still preserves money correctness”

# PlanBuddy — REAL Stripe-Level Chaos Execution Runbook (Evidence-Driven)

## Why this exists
A “master prompt” is not production proof. This runbook specifies **how to execute chaos**, **what to measure**, **where evidence is stored**, and **what pass/fail gates must be met**.

## Non-negotiable financial gates (hard stop)
After every scenario, run DB verification and enforce:

- Double refund: **0**
- Lost payment state: **0**
- Phantom success: **0**
- Webhook mismatch: **0**

If any gate fails:
- stop the run immediately
- write report with `overallPass=false`
- keep the evidence bundle for forensic analysis

## Required artefacts produced by every scenario
All outputs must be saved under:

- `diagnostics/chaos/<runId>/`

Required files:
- `chaos-run-report.json`
- `chaos-run-report.md`
- `evidence/server-logs.txt` (filtered traceId/correlation IDs)
- `evidence/metrics-snapshot.json` (queue lag, worker failures, restart counts)
- `evidence/db-verification.json` (results of Q1–Q4)
- `evidence/requests-summary.json` (counts + timing summary)

## Environment pre-check (must pass)
Before any chaos:
1. Services up: API, webhook handler, Redis, worker(s), DB.
2. Metrics up: Prometheus/Grafana (or at least internal metrics endpoint).
3. Queue connectivity works (can enqueue + consume a test job).
4. You have at least:
   - one payment eligible for refund/capture tests
   - one payment eligible for capture + refund overlap tests
5. Choose a single `runId`:
   - format: `chaos-YYYYMMDD-HHMMSS`

## How to run chaos scenarios (execution primitives)
This repo already has:
- k6 load tooling: `chaos/k6-stress-test.js`
- chaos harness scripts: `chaos/chaos-drill.sh`
- Node queue/worker architecture under `planbuddy_v9/workers/*`

### Primitive A — API + Webhook replay driver
Use the API + webhook endpoints via:
- refund endpoints (refund intent -> expected refund record)
- webhook endpoints (provider event payload -> expected webhook event processing record)
- DLQ replay endpoint/job runner (if present; otherwise use the DLQ processor replay worker command)

**If an endpoint/runner is missing**, the scenario is invalid and must fail with:
- “missing interface”
- “required contract”
- file path where it should be added

### Primitive B — Failure injection
Use these points (must be implemented by you if not present):
- Redis kill: stop Redis container/process for N seconds
- DB kill: block DB pool by stopping/iptables/connection pool disruption
- Worker kill: stop worker processes mid-job (PM2/systemd/docker)
- “Webhook flood”: hammer webhook endpoint with duplicates and jitter

### Primitive C — Evidence harvesting
- Filter server logs by `traceId` (and refundId/paymentId/webhookEventId)
- Snapshot queue metrics during/after scenario
- Run DB verification queries (Q1–Q4) post-scenario and store output

## Scenario 0 — Warm-up + baseline verification (required)
**Goal:** establish that the system is “quietly correct” before destruction.

Steps:
1. Create a single control refund intent.
2. Send 1 webhook for it (no duplicates).
3. Wait for terminal state.
4. Run Q1–Q4 (must all be zero failures).

Outputs:
- save baseline evidence into the run folder

If baseline fails, stop immediately.

---

# Scenario 1 — Refund War Test (100 concurrent API + webhooks + DLQ replay)

## Preconditions
- Create 1 payment/refund intent set.
- Identify:
  - `refundIntentKey` (or idempotency key)
  - target `webhookEventId` for refund webhook(s)

## Execution
1. Fire:
   - `100` concurrent refund API calls (same idempotency/refund intent)
   - `100` concurrent webhook refund triggers (same eventId; duplicates allowed)
   - `100` concurrent DLQ replay triggers for same intent (if DLQ replay runner exists)
2. Introduce jitter:
   - random delays 0–300ms between calls

## Evidence
- request counts and status distribution
- refund created count for the intent key
- worker logs for the processing window

## Verification (hard gates)
- Q1 Double refund: max count per refund intent key == 1 (=> duplicates must be 0)
- Q2/Q3/Q4 consistency gates

---

# Scenario 2 — Webhook Race Test (1000 duplicate same eventId with reordering)

## Execution
- Send the same webhook payload:
  - `1000` times
  - random delays to scramble ordering
  - duplicate event IDs included

## Verification
- Q4 webhook mismatch: exactly one processing record per eventId (duplicates processed = 0)
- Q2/Q3 state coherence

---

# Scenario 3 — Payment Double-Spend Simulation (capture + refund overlap)

## Execution
- Start capture flow and refund flow concurrently with jitter.
- Include duplicates:
  - refund webhook duplicates
  - (if possible) capture webhook duplicates

## Verification
- Q2 state-machine legality: no illegal terminal states
- Q3 phantom success: zero

---

# Scenario 4 — Redis Kill Test (crash mid-flight)

## Execution
1. Start refund activity (or begin Scenario 1, then pause at peak).
2. Kill Redis.
3. Restart Redis after 30 seconds.
4. Continue duplicate webhooks after Redis returns.

## Verification
- Q1/Q4 must remain zero
- ensure no stuck `processing` state beyond retry window
- Q5 queue recovery correctness (DLQ replay convergence)

---

# Scenario 5 — DB Kill Test (connection pool disruption mid-transaction)

## Execution
1. Start refunds under load.
2. During active DB writes, disrupt DB connectivity/pool.
3. Restore DB and let workers recover.

## Verification
- Q2 no partial write corruption (state machine integrity)
- Q1 no duplicates post-recovery
- system must not end in inconsistent terminal mismatch

---

# Scenario 6 — Worker Kill Test (mid-job death + DLQ recovery)

## Execution
1. Start multiple refund jobs in parallel.
2. Kill worker processes mid-processing.
3. Wait for DLQ capture/retry.
4. Replay DLQ set multiple times.

## Verification
- DLQ convergence: stable terminal states after replays
- Q1/Q4 remain zero

---

# Scenario 7 — Webhook Flood Attack (10k in 10 seconds)

## Execution
- Hammer webhook endpoint:
  - `10,000` requests / 10 seconds
  - mix: duplicates + invalid signatures/payloads (if supported)
- Ensure backpressure does not crash system.

## Verification
- service availability preserved
- idempotency for valid events: duplicates not processed more than once
- invalid requests rejected deterministically (no side effects)

---

# Scenario 8 — DLQ Recovery + Replay Storm (500 failures, replay 100x)

## Execution
1. Force 500 failures:
   - via controlled provider failure simulation / DB errors
2. Confirm DLQ population
3. Replay DLQ:
   - once normally
   - then replay the same set 100 times
4. During replay, restart workers once (operational stress)

## Verification
- No duplication across repeated replays (Q1 zero)
- Stable terminal states; no phantom success (Q3 zero)

---

# Scenario 9 — Load & Saturation (1000–5000 concurrent users)

## Execution
- Run mixed payment + refund traffic
- Gradually increase concurrency until you find the breaking threshold

## Verification
- system remains up
- latency degrades gracefully
- no data corruption: Q2/Q1/Q4 remain zero

---

## Final Certification Report (must be produced)
Create `chaos-run-report.json` with:

- `runId`, `timestamp`
- per-scenario `pass`/`fail` + evidence paths
- `finalFinancialMatrix`:
  - doubleRefundDuplicates
  - lostPaymentStateCount
  - phantomSuccessCount
  - webhookMismatchCount
- `overallPass` true only if all are zero

Also output `chaos-run-report.md` summarizing:
- what was attacked
- what survived
- exact counts that certify “money-safe”

---

## Interface Checklist (what you must confirm exists in code)
Before attempting a real run, verify the repo has:
- webhook endpoint to accept duplicated events safely
- refund API endpoint with DB-enforced idempotency
- DLQ replay runner (endpoint or worker command)
- DB verification queries (or a safe way to run Q1–Q4)
- a way to export metrics snapshots (queue lag, worker failures)

If any interface is missing, the run cannot claim production safety.

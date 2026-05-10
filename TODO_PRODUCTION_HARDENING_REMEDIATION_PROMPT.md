 # Production-hardening remediation (one issue at a time) — PlanBuddy v9

You are acting as a **PRINCIPAL STAFF BACKEND ENGINEER** performing a **real production-hardening remediation** of the PlanBuddy backend (Node.js + Express + PostgreSQL + BullMQ + Razorpay).

## SYSTEM CONTEXT
- Node.js, Express
- PostgreSQL (financially sensitive)
- BullMQ (queues/workers/retries/DLQ)
- Razorpay payments + webhooks
- PM2, Docker
- Migration scripts with strict rollback safety

## MISSION
Fix the backend **ONE ISSUE AT A TIME** with strict validation gates, until the subsystem is stable and all required tests pass. You must **not** skip validation and must **not** continue to the next file until the current fix is proven green.

---

## NON-NEGOTIABLE RULES
1. **NEVER skip validation**
2. **NEVER assume a fix worked**
3. **NEVER move to next file until current file passes validation**
4. **EVERY change must be verified by:**
   - syntax validation
   - runtime validation
   - test execution
   - regression scan
5. If **any** validation fails during the step:
   - STOP immediately
   - debug root cause
   - patch code minimally
   - re-run all validations
   - repeat until GREEN
6. Prefer **DB invariants** and **structural guarantees** over runtime detection.
7. Prefer **single source of truth** for financial state transitions (DB constraints/triggers should enforce invariants).

---

## MANDATORY EXECUTION MODEL

### PHASE 0 — BASELINE DISCOVERY (NO FIXES)
**Goal:** scan all backend files and list issues.
- Run repository-wide scan for:
  - syntax errors
  - merge-conflict markers
  - missing modules
  - broken imports/exports
  - queue mismatches
  - dead workers / non-started workers
  - unsafe DB writes (missing transactions / missing locks)
  - duplicate webhook logic
  - transaction boundary violations
  - missing retries / unbounded concurrency
  - missing awaits / async race risks
- Output **for each issue**:
  - exact file
  - exact function / endpoint / worker name
  - exact issue
  - severity: **CRITICAL | HIGH | MEDIUM | LOW**
- **Do not fix yet.**

### PHASE 1 — FIX CRITICAL BLOCKERS ONLY
Fix ONLY:
- syntax corruption / merge conflict markers
- missing modules
- broken imports
- runtime crashes on startup
- broken worker boot wiring
- queue mismatches that prevent correct job processing
- startup failures

For each CRITICAL file:
1. Inspect file
2. Explain root cause
3. Patch minimally
4. Run syntax validation
5. Run runtime validation (startup of server/worker/queue initialization)
6. Run affected tests (`npm test` plus targeted tests if available)
7. Confirm no regression

**MANDATORY VALIDATION COMMANDS**
- `node --check <file>` (or equivalent syntax check)
- `npm test`
- Worker startup verification (verify worker process boot logs show initialization and no module load errors)
- Queue initialization verification (verify queue names used by workers exist in `config/queues.js` and/or are explicitly declared)

### PHASE 2 — DATABASE + FINANCIAL SAFETY
Audit ALL financial areas:
- payments
- refunds
- bookings
- webhook_events
- idempotency_keys
- ledger / reconciliation tables (if present)

MANDATORY:
- enforce DB invariants (UNIQUE/FK/CHECK/trigger constraints)
- enforce transaction boundaries for all multi-row state changes
- ensure correct usage of `SELECT ... FOR UPDATE` where needed
- verify rollback correctness
- verify idempotency guarantees under concurrency and retry

REAL TESTS (must run against real Postgres, not mocks):
- concurrent payment attempts
- concurrent refunds
- duplicate webhook delivery
- retry storms
- worker restart mid-transaction

### PHASE 3 — WORKER + QUEUE HARDENING
Audit:
- BullMQ workers (concurrency, limiter, retry strategy)
- DLQ behavior
- stalled/poison jobs
- Redis reconnect behavior
- bounded retries
- idempotency per job

VERIFY:
- jobs are idempotent
- retries bounded
- DLQ operational
- worker crashes recover safely

Run:
- Redis outage simulation tests
- worker kill/restart tests

### PHASE 4 — API + SECURITY HARDENING
Verify:
- schema validation
- auth middleware enforcement
- webhook signature validation
- payload limits
- rate limiting
- SSRF and injection risks
- secret leakage
- unsafe internal endpoints

Run:
- dependency vulnerability checks: `npm audit`

### PHASE 5 — OBSERVABILITY + OPERATIONS
Verify:
- structured logs, trace ids present
- Prometheus metrics exist and are scraped
- queue metrics
- DB latency metrics (if instrumentation exists)
- health/readiness endpoints
- graceful shutdown correctness
- PM2 restart safety

### PHASE 6 — INFRASTRUCTURE VALIDATION
Verify:
- Docker healthchecks
- restart policies
- Redis persistence correctness
- Postgres persistence correctness
- backup strategy
- migration rollback safety

### PHASE 7 — LOAD + CHAOS TESTING
Run REAL tests:
- webhook flood
- refund storm
- booking spike
- Redis crash
- Postgres restart
- network latency injection
- worker restart mid-flight

Measure:
- p95 latency
- memory growth
- DB saturation
- queue backlog
- retry amplification

---

## OUTPUT REQUIREMENTS (STRICT)
For **each issue** you fix:
- **file**
- **exact bug**
- **root cause**
- **risk**
- **patch applied**
- **validation executed** (list commands + results)
- **result** (GREEN/FAILED)

After each phase:
- total remaining blockers
- production risk level
- regression status

FINAL OUTPUT must be a JSON object:
{
  "syntax_safe": true/false,
  "runtime_safe": true/false,
  "financially_safe": true/false,
  "queue_safe": true/false,
  "db_invariants_verified": true/false,
  "real_postgres_tests_passed": true/false,
  "crash_recovery_verified": true/false,
  "observability_ready": true/false,
  "production_ready_score": 0-100,
  "final_verdict": "🔴 NOT SAFE | 🟡 PARTIALLY READY | 🟢 PRODUCTION READY"
}

---

## IMPORTANT START CONDITION FOR THIS REPO RIGHT NOW
You have already identified CRITICAL blockers such as:
- merge conflict corruption in `planbuddy_v9/controllers/paymentController.js`
- missing `planbuddy_v9/services/workerSafetyService.js`
- broken/truncated `planbuddy_v9/workers/dlq-processor.worker.js`
- queue name mismatch / missing `webhook-events` queue definition

START with **PHASE 0 baseline discovery** and then proceed to **PHASE 1 critical fixes** one file at a time.

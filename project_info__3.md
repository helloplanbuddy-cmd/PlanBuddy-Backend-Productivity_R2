# PlanBuddy v9 Backend — Production-Grade v3+ Redesign Audit (Explore Mode)

## Summary
This repository is a Node.js/Express backend for bookings integrated with Razorpay payments/refunds. It implements production-hardening themes around **idempotency** (Redis + DB fallback), **webhook authenticity** + signature verification, and **async financial state transitions** via background workers and DB transaction appliers. However, there are multiple “v3+ gaps” where the HTTP layer is not fully wired to the queue/apply layer, auth/authorization is inconsistently defined, and webhook retry safety depends on partially documented wiring rather than hard guarantees.

## Architecture
- **Primary pattern**: Express HTTP API with layered middleware + asynchronous background workers that apply **financial state machine transitions** in DB transactions.
- **Key subsystems**
  1. HTTP assembly (`planbuddy_v9/app.js`): security headers, request/trace IDs, CORS, JSON/raw parsing, global rate limiting, `/api/v1` versioning, `/internal` observability routes, central error handler.
  2. Booking/payment controllers:
     - `controllers/paymentController.js`: order creation, payment verification, webhook ingestion endpoint, payment status.
     - `routes/index.js`: booking endpoints + idempotency middleware + authentication middleware usage.
  3. Idempotency middleware (`middleware/idempotency.js`): Redis cache/locks for idempotency keys, DB fallback storage in `idempotency_keys`.
  4. Webhook ingestion + authenticity:
     - `paymentController.razorpayWebhook` stores verified webhook payload + signature into `webhook_events`, but **does not apply financial state changes** in HTTP.
     - `controllers/razorpayWebhookController.js`: DB transaction appliers for `payment.captured/failed` and refund events.
  5. Finance state transitions: centralized in applier functions with idempotent SQL update/insert patterns.

## Directory Structure (meaningful)
```txt
project-root/
├─ planbuddy_v9/
│  ├─ app.js                        — Express assembly (v3.0 claims)
│  ├─ routes/
│  │  ├─ index.js                   — Public API routes (bookings, availability)
│  │  └─ internal.js               — Internal health/diagnostics endpoints
│  ├─ controllers/
│  │  ├─ paymentController.js      — Payment create/verify, Razorpay webhook HTTP ingest, payment status
│  │  └─ razorpayWebhookController.js — Idempotent DB appliers for payment/refund event types
│  ├─ middleware/
│  │  ├─ idempotency.js           — Redis+DB idempotency for 2xx responses
│  │  ├─ idempotency-conflict-limiter.js (referenced) — conflict abuse tracking (file exists under a different name in FS)
│  │  └─ traceId.js / others (referenced in app.js)
│  └─ services/, workers/, migrations/, config/ (not fully inspected here)
```

## Key Abstractions

### 1) Express App Assembly (`planbuddy_v9/app.js`)
- **File**: `planbuddy_v9/app.js` (loaded/inspected)
- **Responsibility**: sets up trust proxy, HTTPS redirect (prod), security headers, requestId + traceId, CORS, raw body for Razorpay webhook routes, JSON parsing, global rate limiter, backpressure, metrics, `/api/v1` and `/api` legacy routing, `/internal` endpoints, 404 and centralized error handling, graceful shutdown (SIGTERM closes BullMQ queues and DB).
- **Lifecycle**: singleton created at process startup.
- **Used by**: `planbuddy_v9/server.js` (not read, but referenced by build) and route controllers.

### 2) Idempotency Middleware (`planbuddy_v9/middleware/idempotency.js`)
- **File**: `planbuddy_v9/middleware/idempotency.js` (loaded/inspected)
- **Responsibility**: enforce Idempotency-Key (optional or strict). On successful 2xx responses, caches the response body+status in Redis and persists to `idempotency_keys` for DB fallback. Uses a Redis distributed lock to prevent concurrent identical request execution; returns 409 while “in flight”.
- **Interface**:
  - `module.exports` (optional): runs only if header exists.
  - `module.exports.strict`: 400 if header missing.
  - `module.exports._runIdempotency`: extracted core for unit testing.
- **Lifecycle**: per-request middleware.
- **Used by**: route wiring in `planbuddy_v9/routes/index.js` for `/bookings/:bookingId/cancel` and (likely) other financial endpoints.

### 3) Razorpay Webhook Ingestion (`paymentController.razorpayWebhook`)
- **File**: `planbuddy_v9/controllers/paymentController.js`
- **Responsibility**: HTTP endpoint to receive Razorpay webhook, fail-fast on missing event IDs, perform signature verification, persist webhook event row into `webhook_events`, and respond success without applying financial mutations in HTTP.
- **Interface**: `exports.razorpayWebhook(req,res,next)`
- **Lifecycle**: per-webhook HTTP call; relies on worker processing out-of-band.

### 4) Razorpay Event Appliers (Financial State Transitions)
- **File**: `planbuddy_v9/controllers/razorpayWebhookController.js`
- **Responsibility**: deterministic idempotent SQL transitions for:
  - Payments: `payment.captured`, `payment.failed`
  - Refunds: `refund.created`, `refund.processed`, `refund.failed`, `refund.cancelled`
- **Interface**:
  - `applyPaymentEvent(client, {eventType, paymentId, eventId, leaseVersion})`
  - `applyRefundEvent(client, {eventType, payload, eventId, leaseVersion})`
- **Lifecycle**: invoked by webhook-processor worker inside an active DB transaction (contract stated in header comments).

### 5) Payment Controller Orchestration (`paymentController.js`)
- **File**: `planbuddy_v9/controllers/paymentController.js`
- **Responsibility**:
  - `createOrder`: validate booking ownership/state; validate expected amounts; create Razorpay order; persist mapping + update payment row in a DB transaction; audit + metrics.
  - `verifyPayment`: verify signature then process payment via `RazorpayService.processPaymentTransaction` (not inspected here).
  - `manualReconcile`: triggers worker reconciliation.
  - `getPaymentStatus`: joins payments/bookings/trips and filters by user role.

## Data Flow (primary critical path)
1. **User creates/cancels booking**
   - Route: `routes/index.js` → `bookingController` (not inspected here) uses `authenticate`.
   - Cancel uses `idempotency.strict` so duplicate cancel POSTs are blocked/replayed safely.
2. **Payment order creation**
   - Controller: `paymentController.createOrder`
   - DB read: joins `bookings` + `trips` and validates:
     - booking eligible (`status=pending`, `payment_status=unpaid`)
     - trip active
     - `booking.total_amount === price * group_size` invariant.
   - External call: Razorpay order creation.
   - DB transaction: inserts into `razorpay_order_mappings` and updates `payments` mapping for only `status='created'`.
3. **Razorpay webhook ingestion (HTTP)**
   - `app.js` registers raw body handlers for both `/api/v1/payment/webhook/razorpay` and legacy `/api/payment/webhook/razorpay`.
   - Controller `paymentController.razorpayWebhook`:
     - extracts signature header `x-razorpay-signature`
     - verifies signature using `webhookAuthenticityService`
     - inserts `webhook_events` row with payload_bytes/signature/verified_at
     - does **not** apply financial state (comment says worker does it).
4. **Worker applies financial changes**
   - Worker (not inspected here): `workers/webhook-processor.worker.js` should call `razorpayWebhookController.applyPaymentEvent/applyRefundEvent` within a DB transaction, enforcing the payment/refund state machine.

## Non-Obvious Behaviors & Design Decisions (important)
- **Idempotency caches only 2xx responses**: this is a deliberate safety boundary preventing clients from replaying error states that require input correction.
- **Lock-first, cache-on-success**: the system intentionally blocks concurrent identical requests to prevent double charges/refund initiations.
- **Webhook ingestion is write-only**: design expects “ingest now, apply later”, reducing HTTP latency and isolating financial mutations into workers.
- **Fencing tokens / leaseVersion mentioned but not enforceable from inspected code**: applier signatures include `leaseVersion`, implying ownership/lease concurrency control, but the HTTP ingestion path does not demonstrate how the leaseVersion is assigned or verified.

---

# v3+ Production Redesign Audit (Brutal)

## SYSTEM SCORE (0–10)
- **Architecture**: 6/10 (good separation intent: ingest vs apply; but integration wiring and contracts are not verifiable from the inspected files)
- **Security**: 6/10 (webhook signature verification + raw body handling is strong, but authz is under-specified here and internal routes appear insufficiently guarded)
- **Scalability**: 5/10 (global rate limiting/backpressure exist, but webhook burst safety depends on queue processing wiring; idempotency lock TTL may cause edge-case double processing)
- **Code Quality**: 6/10 (structured controllers + idempotent SQL patterns; but obvious inconsistencies and “fail-open” branches create reliability/security ambiguity)
- **Maintainability**: 5/10 (duplicate/legacy route compatibility and missing module references suggest drift)

**FINAL SCORE: 5.6/10**

## CRITICAL ISSUES (BLOCKERS)
1. **Webhook HTTP ingestion likely not connected to queue processing**
   - In `paymentController.razorpayWebhook`, there is a warning comment that queue wiring is not present and the code avoids calling an unknown queue helper.
   - **Why this is a blocker**: if the worker isn’t guaranteed to process `webhook_events` rows (via DB polling or a correctly configured queue producer), financial state transitions may never happen, creating stuck payments/refunds.

2. **Idempotency conflict limiter integration is inconsistent / possibly broken**
   - `middleware/idempotency.js` imports `./idempotencyConflictLimiter`, but the FS shows only `middleware/idempotency-conflict-limiter.js` (and also `middleware/Idempotencyconflictlimiter.js` with casing).
   - **Why this is a blocker**: if the import path/casing is wrong on the deployed environment, requests that hit the 409 in-flight path will throw and skip conflict tracking. That can cascade into failure to release locks or reduced abuse protection (and possibly runtime crashes if unhandled).

3. **Fail-open semantics under Redis lock acquisition failure can permit duplicate processing**
   - When Redis lock set fails, `idempotency.js` does `return next()` (proceed without lock) and relies on DB unique constraints as last defense.
   - **Why this is a blocker**: for non-unique operations (or where DB constraints are incomplete), this can reintroduce double-charge / double-refund risk exactly when reliability is worst (Redis degradation).

4. **`/internal` routes appear unauthenticated aside from IP gating, but IP checks are brittle**
   - `app.js` implements `/metrics` IP allow-list; `routes/internal.js` explicitly says “No auth — IP restricted via app.js + prometheus IP guard.”
   - **Why this is a blocker**: I only saw metrics IP guard logic in `app.js`, not internal route guards. If internal routes are not actually guarded with the same allow-list, this becomes an SSRF/admin-info leak entry point.

## HIGH ISSUES
1. **Webhook storage uniqueness strategy may not fully prevent replay attacks**
   - In webhook insert SQL in `paymentController.razorpayWebhook`, conflict is on `(provider, razorpay_event_id, signature)` with DO UPDATE only for `status='received'`.
   - **Risk**: If Razorpay reuses event IDs across some scenarios or signature behavior changes, or if your DB uniqueness constraints don’t match this insert conflict target, duplicates may enter in inconsistent states.

2. **Webhook event applier event type mapping is fragile**
   - `applyPaymentEvent` switches only on `'payment.captured'` and `'payment.failed'`.
   - `applyRefundEvent` depends on parsing multiple payload envelope formats, but the `eventType` comparisons are exact strings.
   - **Risk**: if worker passes a different naming scheme (e.g., `captured` without `payment.` prefix), the code will silently ignore/mark ignored without applying mutations.

3. **Inconsistent money units conventions likely exist**
   - `createOrder` validates `total_amount` vs `trip.price * group_size`.
   - Refund applier stores refunds.amount in rupees (historical convention) while Razorpay provides paise.
   - **Risk**: Any mismatch in amount conversion across flows can cause integrity violations that idempotency won’t catch.

4. **No explicit CSRF protection for state-changing endpoints**
   - The app has security headers and CORS. But there is no mention of CSRF tokens for cookie-based auth.
   - **Risk**: If `authenticate` relies on cookies, cross-site POST attacks become possible.

## MEDIUM ISSUES
1. **Global rate limiting might conflict with idempotency behavior**
   - If global limiter triggers 429 before idempotency middleware caches 2xx responses, clients will retry and create lock churn.
2. **Trace/request IDs are logged, but correlation across webhook events is incomplete**
   - Webhook ingestion uses `correlationId = req.requestId` and stores `correlation_id`, but the worker flow is not shown. If worker logs don’t attach stored correlation_id, operational triage suffers.

## LOW ISSUES
1. **Legacy route compatibility increases surface area**
   - Both `/api/v1/...` and `/api/...` webhook endpoints are enabled. This increases testing/verification burden and increases risk of misconfigured raw body parsing.
2. **Unused variables / dead code signals drift**
   - In webhook insert, there are unused commented lines and references to “queue wiring not present”.

---

## ROOT CAUSE ANALYSIS (major issues)

### RC1: Webhook ingestion does not reliably lead to application
- **WHY it exists**: The HTTP handler includes a comment acknowledging missing/wiring uncertainty and avoids calling a queue helper.
- **DESIGN mistake**: Treating “worker processing exists” as an external assumption instead of a hard contract enforced by code (producer/consumer link).
- **WHY it breaks in production**: Under webhook load, without deterministic enqueue or deterministic polling, events accumulate in `webhook_events` in `received` state, causing stale financial state and customer-visible inconsistencies.

### RC2: Middleware module wiring/casing mismatch
- **WHY it exists**: Multiple similar files appear (`idempotency-conflict-limiter.js`, `Idempotencyconflictlimiter.js`).
- **DESIGN mistake**: Case-insensitive dev environment hides casing errors; prod on Linux/containers fails import.
- **WHY it breaks in production**: The 409 in-flight path may crash (or silently skip) conflict tracking; combined with lock release paths, it can create zombie locks or reduce abuse blocking.

### RC3: Fail-open behavior under Redis failures
- **WHY it exists**: Resilience approach: don’t block traffic if Redis is unstable.
- **DESIGN mistake**: Using Redis availability as a gate for safety without verifying that DB constraints are sufficient for *all* mutation paths.
- **WHY it breaks in production**: The precise moment Redis is failing is when you most need strong mutual exclusion; duplicates become more likely.

---

## RE-ARCHITECTURE PLAN (NEXT LEVEL DESIGN)

### 1) Harden the webhook pipeline contract (ingest → durable enqueue → apply)
- Make webhook application **strictly guaranteed** by code:
  - HTTP handler must write `webhook_events` row **and** enqueue a job in the same DB transaction (outbox pattern).
  - Worker consumes jobs from BullMQ only after validating lease ownership and event status.
- Implement an explicit `webhook_outbox` table:
  - `webhook_outbox(id, webhook_event_id, status, attempts, created_at, next_attempt_at)`
  - Ensure atomic insert alongside `webhook_events`.

### 2) Make idempotency a shared invariant with enforced correctness
- Replace fail-open lock acquisition with:
  - DB-level advisory locks / unique constraint fences for critical endpoints.
  - Or fallback to Postgres advisory locks when Redis lock fails.
- Ensure idempotency covers all mutation endpoints, including webhook-driven financial mutations (not only HTTP POSTs).

### 3) Unify authentication/authorization and internal route protection
- Add `requireAdmin` middleware for `/internal/*` and enforce IP allow-list + JWT.
- Remove duplicate legacy endpoints unless there is a strict migration plan.

### 4) Normalize money conversion and state machine names
- Create a single `Money` utility used by all flows (order creation, refund creation, refund appliers).
- Create enums for event types and state transitions to prevent string drift.

### 5) Observability: correlation is not optional
- Standardize event correlation:
  - store `correlation_id` in `webhook_events`
  - worker must load and attach it to logs and metrics
  - expose a `GET /internal/trace/:id` endpoint for triage (authz required)

---

## FIX STRATEGY (STEP-BY-STEP)

### Phase 0 (do first): eliminate production blockers
1. **Verify webhook processing guarantee**
   - Ensure HTTP enqueue or outbox exists. If not, implement it (in code changes; outside Explore Mode).
2. **Fix idempotency conflict limiter import/casing**
   - Ensure only one canonical module path exists and is imported.
3. **Lock failure safety**
   - When Redis locks fail, switch to DB advisory locks or mandatory unique constraint enforcement for critical endpoints.

### Phase 1: tighten security
4. Guard `/internal` endpoints with admin auth + IP allow-list.
5. Add CSRF protection if cookie-based auth is used.

### Phase 2: correctness + maintainability
6. Normalize eventType strings with enums and validation.
7. Normalize money unit conversions via a shared Money module.
8. Remove or fully document legacy route variants.

### Phase 3: scaling/operations
9. Add DLQ handling review for webhook jobs (ensure replay re-verifies signature and status transitions are correct).
10. Improve backpressure to consider queue depth and DB pool saturation.

### What not to touch yet
- Don’t change the SQL idempotent transition structure in appliers until the ingest→apply pipeline is proven, otherwise you risk compounding stuck-state debugging.

### What to refactor vs rewrite
- **Refactor**: idempotency middleware internals to use a single lock strategy abstraction.
- **Rewrite**: webhook ingest/queue coupling using outbox pattern (core correctness path).

---

## CODE IMPROVEMENT PATCHES (patterns, not full implementation)

### Patch A: Replace webhook “no queue wiring” with outbox enqueue (conceptual)
**Before**: webhook ingestion stores `webhook_events` then skips enqueue due to missing wiring.
**After**:
- In same transaction:
  - insert `webhook_events`
  - insert `webhook_outbox` row pointing to it
- Worker consumes outbox entries; marks processed with fencing.

### Patch B: Replace fail-open Redis lock with DB advisory lock fallback
**Before**: Redis lock set failure → `return next()` (fail-open).
**After**:
- If Redis lock fails, acquire a Postgres advisory lock keyed by the idempotency scoped key and endpoint.
- Always hold a single mutual exclusion primitive for correctness.

### Patch C: Canonicalize middleware module path
**Before**: `require('./idempotencyConflictLimiter')` vs actual file `idempotency-conflict-limiter.js` vs `Idempotencyconflictlimiter.js`.
**After**:
- Rename/delete duplicates; update imports to exact canonical file.

---

## SCALABILITY UPGRADES
1. **Outbox + batching**: reduce enqueue pressure during webhook bursts.
2. **Queue-based webhook application only**: never apply financial state in HTTP.
3. **Rate limiting with per-user scopes**:
   - global limiter is blunt; add per-user token buckets for financial endpoints.
4. **Cache hot reads**:
   - payment status and booking availability could be cached with short TTL (careful with consistency).
5. **DB connection pool tuning**
   - appliers and controllers should use bounded concurrency (workers should not share HTTP pool without limits).

---

## SECURITY HARDENING
1. **Authorization gaps**
   - `getPaymentStatus` filters by user role, but internal routes and admin reconcile endpoints must be explicitly guarded by `authenticate` + role check.
2. **Webhook validation**
   - Ensure webhook signature verification uses **raw payload bytes** consistently (raw body path is set, good).
   - Enforce replay handling: signature + eventId + status transitions should be immutable and worker-only.
3. **Injection risks**
   - Current SQL uses parameterized queries (good). Still ensure any JSON.stringify(payload) stored does not later get used in dynamic SQL.
4. **Secret management**
   - Verify `config/razorpay.js` loads secrets from env and never logs them; confirm webhook secret is not exposed through metrics or error traces.
5. **Internal endpoint exposure**
   - `/internal` should require admin auth; IP checks alone are rarely sufficient in production.

---

## FINAL “PRODUCTION READINESS CHECKLIST” (Go/No-Go)

- [ ] Webhook ingest → apply is guaranteed (outbox/queue wiring proven)  
- [ ] Redis outage behavior is safe (no fail-open duplicates on critical mutations)  
- [ ] Idempotency conflict limiter import/casing is fixed and tested on Linux container  
- [ ] Internal endpoints require admin auth + IP allow-list  
- [ ] Webhook signature verification is validated with replay tests in CI  
- [ ] Money conversion is consistent across order + refund flows  
- [ ] Correlation IDs propagate from HTTP ingest to worker logs/metrics  
- [ ] Load tests validate queue depth/backpressure and DB pool saturation behavior  
- [ ] Secrets never appear in logs/metrics and are rotated with runbook  
- [ ] Runbook exists for manual reconciliation and DLQ processing

### Go-Live Verdict
**NO-GO until the webhook pipeline guarantee and the idempotency conflict-limiter/module wiring are verified and corrected.**  
Everything else is “next”, but those two are production correctness and operational safety blockers.

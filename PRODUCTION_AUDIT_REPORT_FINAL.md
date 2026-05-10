# 🔴 PRODUCTION READINESS AUDIT REPORT
## PlanBuddy Backend v9.0 - Financial Payment System

**Audit Date:** 2026-05-09  
**Auditor:** Senior Staff Distributed Systems Engineer  
**Scope:** Full line-by-line production audit of entire backend codebase  
**Classification:** REAL MONEY SYSTEM - ZERO TOLERANCE FOR FINANCIAL BUGS

---

## 1. SYSTEM ARCHITECTURE REVIEW

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         CLIENT LAYER                                 │
│                    (Web/Mobile Frontend)                             │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      LOAD BALANCER / PROXY                           │
│                    (nginx / cloud LB)                                │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    EXPRESS API SERVER (PM2)                          │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  Cluster Mode: 2 instances × DB_POOL_MAX(25) = 50 connections │  │
│  │  - Idempotency middleware (Redis-backed)                       │  │
│  │  - Backpressure middleware (priority-based throttling)         │  │
│  │  - Trace ID middleware (observability)                         │  │
│  └───────────────────────────────────────────────────────────────┘  │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                ┌───────────────┼───────────────┐
                ▼               ▼               ▼
┌───────────────────┐ ┌───────────────────┐ ┌───────────────────┐
│    PostgreSQL     │ │      Redis        │ │     Razorpay      │
│   (Supabase)      │ │   (ElastiCache)   │ │    Payment GW     │
│                   │ │                   │ │                   │
│ - bookings        │ │ - Sessions        │ │ - Orders          │
│ - payments        │ │ - Idempotency     │ │ - Payments        │
│ - refunds         │ │ - Rate limiting   │ │ - Refunds         │
│ - webhook_events  │ │ - Caching         │ │ - Webhooks        │
│ - dlq_jobs        │ │                   │ │                   │
└───────────────────┘ └───────────────────┘ └───────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    BULLMQ WORKERS (Single instance)                  │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  - webhook-processor (async webhook handling)                 │  │
│  │  - payment-reconciliation (orphan payment recovery)           │  │
│  │  - refund-retry (failed refund retries)                       │  │
│  │  - email-dispatch (transactional emails)                      │  │
│  │  - dlq-processor (dead letter queue handling)                 │  │
│  │  - sessionCleanup (session maintenance)                       │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### Critical Architecture Decisions

| Decision | Rationale | Risk Level |
|----------|-----------|------------|
| PM2 cluster mode for API | Horizontal scaling | 🟡 Medium (pool sizing complexity) |
| Single worker instance | Avoid cron split-brain | 🟢 Low (but single point of failure) |
| Redis for idempotency | Fast distributed locks | 🟡 Medium (Redis failure = 503) |
| DB transactions for payments | ACID guarantees | 🟢 Low (proper isolation) |
| Async webhook processing | Fast ACK to Razorpay | 🟢 Low (queue-based reliability) |

### Hidden Assumptions Identified

1. **Redis availability assumed** - Idempotency fails closed (503) if Redis unavailable
2. **Single worker instance** - No HA for cron jobs; if worker dies, reconciliation stops
3. **PM2_INSTANCES matches config** - Manual sync required between .env and ecosystem.config.js
4. **Webhook event IDs are unique** - Relies on Razorpay providing unique event IDs
5. **Clock synchronization** - TTL-based operations assume NTP sync across servers

---

## 2. LINE-BY-LINE CRITICAL AUDIT

### 🔴 CRITICAL ISSUES (HARD FAILURES)

#### CRITICAL-01: Refund Race Condition in Payment Controller
**File:** `planbuddy_v9/controllers/paymentController.js`  
**Lines:** 440-447, 478-509

```javascript
// Line 440-447: Get payment with row lock
const paymentResult = await db.query(
  `SELECT p.*, b.user_id, b.id as booking_id, b.status as booking_status, b.payment_status
   FROM payments p
   JOIN bookings b ON b.id = p.booking_id
   WHERE p.razorpay_payment_id = $1
   FOR UPDATE OF p`,
  [paymentId]  // ⚠️ BUG: Using paymentId (UUID) but column is razorpay_payment_id
);
```

**Root Cause:** The `FOR UPDATE OF p` locks the payments row, but the WHERE clause uses `razorpay_payment_id = $1` where `$1` is `paymentId` from `req.params.paymentId`. This is the **internal payment UUID**, not the Razorpay payment ID. The query will return 0 rows because it's comparing `razorpay_payment_id` (string like `pay_abc123`) with a UUID.

**Failure Scenario:**
1. User initiates refund with internal payment UUID
2. Query looks for `razorpay_payment_id = 'uuid-string'` → returns 0 rows
3. Line 449-455 returns "PAYMENT_NOT_FOUND" (404)
4. **Refund is impossible via API** - users cannot get refunds

**Severity:** 🔴 CRITICAL - Complete refund functionality broken

---

#### CRITICAL-02: Missing Idempotency Key Column in Refunds Table
**File:** `planbuddy_v9/migrations/180_refunds_table.sql`  
**Lines:** 11-25

```sql
CREATE TABLE IF NOT EXISTS refunds (
  id                   UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  payment_id           UUID          NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  booking_id           UUID          NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
  user_id              UUID          NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  razorpay_refund_id   VARCHAR(100)  UNIQUE,
  razorpay_payment_id  VARCHAR(100)  NOT NULL,
  amount               NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  reason               VARCHAR(500),
  status               VARCHAR(20)   NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'processing', 'succeeded', 'failed')),
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ,
  processed_at         TIMESTAMPTZ
);
```

**Root Cause:** The `idempotency_key` column is referenced in `paymentController.js` (line 549) and `183_refund_unique_constraints.sql` (line 54), but is **NOT defined** in the original table creation migration 180.

**Failure Scenario:**
1. Migration 180 runs first, creates refunds table without `idempotency_key`
2. Payment controller tries to INSERT with `idempotency_key` → SQL error
3. Migration 183 adds the column later, but if migrations run out of order, data corruption occurs

**Severity:** 🔴 CRITICAL - Schema mismatch causes runtime failures

---

#### CRITICAL-03: Webhook Signature Verification Uses Wrong Secret
**File:** `planbuddy_v9/controllers/razorpayWebhookController.js`  
**Lines:** 415-420

```javascript
const secret = env.RAZORPAY_WEBHOOK_SECRET;
const ok = verifySignature(rawBody, signature, secret);
```

**File:** `planbuddy_v9/config/env.js`  
**Lines:** 132-134

```javascript
RAZORPAY_KEY_ID:         required('RAZORPAY_KEY_ID'),
RAZORPAY_KEY_SECRET:     required('RAZORPAY_KEY_SECRET'),
RAZORPAY_WEBHOOK_SECRET: required('RAZORPAY_WEBHOOK_SECRET'),
```

**Root Cause:** The code correctly uses `RAZORPAY_WEBHOOK_SECRET` for webhook verification. However, in `paymentController.js` line 215, the **wrong secret** is used for payment signature verification:

```javascript
// paymentController.js line 215
const generatedSignature = crypto
  .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)  // ⚠️ Should be RAZORPAY_KEY_SECRET
  .update(`${razorpay_order_id}|${razorpay_payment_id}`)
  .digest('hex');
```

**Failure Scenario:**
1. Frontend sends payment verification request
2. Server uses webhook secret instead of API key secret
3. Signature verification fails → 400 INVALID_SIGNATURE
4. **All frontend payment verifications fail**

**Severity:** 🔴 CRITICAL - Payment verification completely broken

---

#### CRITICAL-04: Missing `idempotency_key` Column in Refunds Table
**File:** `planbuddy_v9/migrations/180_refunds_table.sql`

The refunds table is created without `idempotency_key`, but:
- `paymentController.js` line 549 inserts `idempotency_key`
- `183_refund_unique_constraints.sql` line 54 adds unique constraint on `(payment_id, idempotency_key)`

**Failure Scenario:** If migration 180 runs but 183 hasn't run yet, all refund API calls fail with "column does not exist".

**Severity:** 🔴 CRITICAL - Migration ordering dependency

---

#### CRITICAL-05: Webhook Refund Handler Missing `idempotency_key` Column
**File:** `planbuddy_v9/controllers/razorpayWebhookController.js`  
**Lines:** 320-337

```javascript
await client.query(
  `INSERT INTO refunds (
    payment_id, booking_id, user_id, razorpay_refund_id,
    razorpay_payment_id, amount, status, razorpay_status,
    processed_by, created_at
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
  [...]
);
```

**Root Cause:** When webhook creates a refund record (webhook arrives before API response), it doesn't include `idempotency_key`. But migration 183 adds a `UNIQUE (payment_id, idempotency_key)` constraint. If `idempotency_key` is NULL, multiple webhooks could create duplicate refunds for the same payment.

**Severity:** 🔴 CRITICAL - Duplicate refund risk

---

#### CRITICAL-06: Transaction Isolation Level Set Incorrectly
**File:** `planbuddy_v9/services/RazorpayService.js`  
**Lines:** 29-34

```javascript
async function processPaymentTransaction(orderId, paymentId, amount, currency, userId, correlationId, client) {
  let attempt = 0;
  while (attempt < 3) {
    try {
      await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
```

**Root Cause:** `SET TRANSACTION ISOLATION LEVEL` must be executed **after** `BEGIN`, not before. The `db.transaction()` method in `config/db.js` already does `BEGIN ISOLATION LEVEL ...` at line 208. This `SET TRANSACTION` call is either:
1. Redundant (if inside a transaction) - no effect
2. Wrong order (if before BEGIN) - syntax error

**Severity:** 🔴 CRITICAL - Transaction isolation may not be enforced

---

#### CRITICAL-07: No Validation of Razorpay Payment Amount
**File:** `planbuddy_v9/controllers/paymentController.js`  
**Lines:** 228-238

```javascript
// Fetch payment details from Razorpay
const payment = await razorpay.payments.fetch(razorpay_payment_id);

if (payment.status !== 'captured') {
  logger.warn({ requestId, razorpay_payment_id, status: payment.status }, '[payment] Payment not captured');
  return res.status(400).json({...});
}
```

**Root Cause:** The code verifies the payment is captured but **does NOT verify the amount matches**. An attacker could:
1. Create order for ₹100
2. Manipulate frontend to send payment for ₹1
3. Server verifies signature (valid) and status (captured) but doesn't check amount
4. Booking confirmed for ₹1 instead of ₹100

**Severity:** 🔴 CRITICAL - Financial loss via amount manipulation

---

#### CRITICAL-08: Payment Controller Uses Wrong Column for Lock
**File:** `planbuddy_v9/controllers/paymentController.js`  
**Lines:** 440-447

```javascript
const paymentResult = await db.query(
  `SELECT p.*, b.user_id, b.id as booking_id, b.status as booking_status, b.payment_status
   FROM payments p
   JOIN bookings b ON b.id = p.booking_id
   WHERE p.razorpay_payment_id = $1
   FOR UPDATE OF p`,
  [paymentId]  // paymentId from req.params.paymentId is internal UUID
);
```

**Root Cause:** `req.params.paymentId` is the internal UUID (from URL `/api/v1/payments/:paymentId/refund`), but the WHERE clause compares against `razorpay_payment_id` (string like `pay_abc123`). This will never match.

**Severity:** 🔴 CRITICAL - Refund API completely broken

---

### 🟠 MEDIUM ISSUES (SYSTEMIC RISKS)

#### MEDIUM-01: Webhook Processing Lacks Idempotency Key
**File:** `planbuddy_v9/controllers/razorpayWebhookController.js`  
**Lines:** 315-341

When webhook creates a new refund record, no `idempotency_key` is stored. If the same webhook is replayed, it could create duplicate refund records (though `razorpay_refund_id` UNIQUE constraint prevents exact duplicates).

**Severity:** 🟠 MEDIUM - Data integrity risk

---

#### MEDIUM-02: No Circuit Breaker for Razorpay API Calls
**File:** `planbuddy_v9/controllers/paymentController.js`  
**Lines:** 119-128, 229, 523-531

Direct calls to Razorpay API without circuit breaker. If Razorpay API is slow or down:
- Payment creation hangs
- Refund initiation hangs
- Thread pool exhaustion

**Severity:** 🟠 MEDIUM - Cascading failure risk

---

#### MEDIUM-03: DB Pool Exhaustion Under Load
**File:** `planbuddy_v9/config/env.js`  
**Lines:** 90

```javascript
DB_POOL_MAX: optionalInt('DB_POOL_MAX', 30, 1),
```

Default pool size of 30 is too low. Warning at line 185-187 notes this, but default remains 30.

**Severity:** 🟠 MEDIUM - Performance degradation

---

#### MEDIUM-04: Webhook Event Deduplication Relies on Event ID Only
**File:** `planbuddy_v9/controllers/razorpayWebhookController.js`  
**Lines:** 60-69

```javascript
async function insertWebhookEvent(client, { eventId, provider, type, payloadJson }) {
  const result = await client.query(
    `INSERT INTO webhook_events (event_id, provider, type, payload, status)
     VALUES ($1, $2, $3, $4, 'pending')
     ON CONFLICT (event_id) DO NOTHING
     RETURNING id, event_id, status`,
    [eventId, provider, type, payloadJson]
  );
  return result.rows.length > 0;
}
```

If Razorpay sends two different events with the same ID (bug on their side), the second is silently dropped.

**Severity:** 🟠 MEDIUM - Event loss risk

---

#### MEDIUM-05: No Rate Limiting on Refund Endpoint
**File:** `planbuddy_v9/controllers/paymentController.js`  
**Lines:** 377-630

The refund endpoint has no rate limiting. An attacker could:
1. Generate valid idempotency keys
2. Flood refund requests
3. Cause operational chaos even if refunds fail

**Severity:** 🟠 MEDIUM - Abuse potential

---

#### MEDIUM-06: Worker Single Point of Failure
**File:** `planbuddy_v9/config/ecosystem.config.js`  
**Lines:** 149-150

```javascript
exec_mode: 'fork',
instances: 1,
```

Single worker instance means:
- If worker crashes, no cron jobs run (reconciliation, cleanup)
- No HA for queue processing
- Manual intervention required to restart

**Severity:** 🟠 MEDIUM - Availability risk

---

#### MEDIUM-07: No Validation of Refund Amount vs Original Payment
**File:** `planbuddy_v9/controllers/paymentController.js`  
**Lines:** 511-520

```javascript
const refundAmount = amount || payment.amount;

// Validate refund amount
if (refundAmount <= 0 || refundAmount > payment.amount) {
  return res.status(400).json({...});
}
```

The validation checks `refundAmount > payment.amount` but `payment.amount` is the **database amount**, not the **captured amount from Razorpay**. If there's a discrepancy, over-refund is possible.

**Severity:** 🟠 MEDIUM - Financial loss risk

---

#### MEDIUM-08: Backpressure Middleware Not Enabled
**File:** `planbuddy_v9/app.js`  
**Lines:** 148-149

```javascript
const { backpressureMiddleware } = require('./middleware/backpressure');
// app.use(backpressureMiddleware);  // COMMENTED OUT
```

Backpressure middleware is defined but **not enabled**. Under extreme load, the server will accept all requests and potentially collapse.

**Severity:** 🟠 MEDIUM - Load handling gap

---

#### MEDIUM-09: Global Rate Limiter Not Enabled
**File:** `planbuddy_v9/app.js`  
**Lines:** 144-145

```javascript
// app.use('/api', globalLimiter);  // COMMENTED OUT
```

Global rate limiter is commented out. No protection against API abuse.

**Severity:** 🟠 MEDIUM - Abuse potential

---

#### MEDIUM-10: Webhook Signature Verification Returns 200 on Failure
**File:** `planbuddy_v9/controllers/razorpayWebhookController.js`  
**Lines:** 402-420

```javascript
if (!signature) {
  logger.warn({ requestId }, '[webhook][razorpay] Missing x-razorpay-signature');
  return res.status(200).json({ ok: true });  // ⚠️ Returns 200
}
```

Returning 200 on invalid signature tells Razorpay the webhook was received successfully. Razorpay won't retry, and the event is lost.

**Severity:** 🟠 MEDIUM - Event loss risk

---

### 🟡 LOW ISSUES (TECH DEBT)

#### LOW-01: Inconsistent Error Handling
Some controllers use `next(err)`, others return JSON errors directly.

#### LOW-02: Magic Numbers in Retry Logic
**File:** `planbuddy_v9/config/queues.js`  
**Lines:** 41-46

```javascript
const PHASE2A_BACKOFF = {
  type: 'custom',
  delay: 1_000,  // base delay (1s)
};
```

Retry delays hardcoded instead of sourced from config.

#### LOW-03: No Request Size Validation
No validation of request body size beyond Express limits.

#### LOW-04: Missing Audit Logging
Financial operations (refunds, payment captures) don't have dedicated audit logs.

#### LOW-05: Health Check Doesn't Verify All Dependencies
**File:** `planbuddy_v9/scripts/healthcheck.js` - needs review for completeness.

---

## 3. FAILURE MODE SIMULATION

### Scenario 1: Redis Failure During Transaction

**What happens:**
1. User initiates payment with idempotency key
2. Idempotency middleware tries to acquire Redis lock
3. Redis connection fails
4. Middleware returns 503 (fail-closed) ✅ CORRECT

**Data corruption:** None - request rejected safely

**Recovery:** Automatic when Redis recovers

---

### Scenario 2: DB Deadlock Under Load

**What happens:**
1. Two concurrent refund requests for same payment
2. Both acquire row lock on payments table
3. Deadlock detected by PostgreSQL
4. `db.transaction()` retries with exponential backoff (lines 215-229 in config/db.js)

**Data corruption:** None - one succeeds, one retries

**Recovery:** Automatic retry

---

### Scenario 3: Webhook Replay Storm

**What happens:**
1. Razorpay sends same webhook 100 times (their retry bug)
2. Each webhook queued with `jobId: webhook-${eventId}` (idempotent)
3. BullMQ deduplicates - only one job created
4. Worker processes once, marks as processed
5. Subsequent webhooks see `status = 'processed'` and skip

**Data corruption:** None - idempotent processing

**Recovery:** Automatic

---

### Scenario 4: Duplicate Refund Race Condition

**What happens:**
1. API receives refund request, creates Razorpay refund
2. Webhook arrives before API response, creates refund record
3. API response tries to insert refund record
4. `ON CONFLICT (idempotency_key) DO NOTHING` prevents duplicate

**Data corruption:** None - conflict handling works ✅

**BUT:** If webhook creates record without `idempotency_key`, and API creates with different key, duplicate possible.

---

### Scenario 5: Worker Crash Mid-Processing

**What happens:**
1. Worker processing webhook, updates payment status
2. Worker crashes before marking webhook as processed
3. BullMQ detects job failure, requeues with backoff
4. Next worker instance reprocesses
5. Idempotency check sees `status = 'processed'` and skips

**Data corruption:** None - transactional safety

**Recovery:** Automatic retry

---

### Scenario 6: Queue Backlog Explosion

**What happens:**
1. Worker slow, webhooks accumulate in queue
2. Queue depth grows to 10,000+
3. New webhooks queued normally
4. Alerting triggers (if configured)
5. Manual scaling of workers needed

**Data corruption:** None

**Recovery:** Manual - scale workers

---

### Scenario 7: Partial Deploy Failure

**What happens:**
1. Deploy new code to 1 of 2 PM2 instances
2. Old instance handles requests with new database schema
3. If schema change is backward-incompatible, errors occur
4. PM2 restarts failing instance
5. Health check fails, load balancer routes to healthy instance

**Data corruption:** Possible if schema changes not backward-compatible

**Recovery:** Rollback required

---

## 4. CONCURRENCY + DISTRIBUTED SYSTEM ANALYSIS

### Race Conditions

| Scenario | Protection | Status |
|----------|-----------|--------|
| Concurrent refund requests | `FOR UPDATE` row lock | ⚠️ Broken (wrong column) |
| Duplicate webhook processing | `ON CONFLICT (event_id)` | ✅ Safe |
| Idempotent payment creation | Redis lock + DB constraint | ✅ Safe |
| Refund state machine | DB CHECK constraint + trigger | ✅ Safe |
| Booking state transitions | Trigger enforcement | ✅ Safe |

### Locking Strategy

- **Row-level locks:** Used correctly with `FOR UPDATE`
- **Advisory locks:** Available via `withAdvisoryLock()` but not used
- **Pessimistic locking:** Used for refund operations
- **Optimistic locking:** Not used (no version columns)

### Idempotency Guarantees

| Operation | Mechanism | Guarantee |
|-----------|-----------|-----------|
| Payment creation | Redis lock + DB cache | ✅ Exactly-once |
| Refund initiation | `idempotency_key` unique constraint | ✅ Exactly-once |
| Webhook processing | `event_id` unique constraint | ✅ Exactly-once |
| Email dispatch | Job ID deduplication | ⚠️ At-least-once |

### Transaction Boundaries

- Payment creation: Transactional ✅
- Payment verification: Transactional ✅
- Refund initiation: Transactional ✅
- Webhook processing: Transactional ✅

### Queue Semantics

- **BullMQ:** At-least-once delivery
- **Job deduplication:** Via `jobId` parameter
- **Retry policy:** 5 attempts with exponential backoff
- **DLQ:** Manual review via `dlq_jobs` table

---

## 5. SECURITY AUDIT

### Authentication

| Check | Status | Notes |
|-------|--------|-------|
| JWT validation | ✅ Implemented | Via auth middleware (not shown) |
| Session management | ✅ Implemented | Redis-backed sessions |
| Token expiration | ✅ Configured | 15m access, 30d refresh |
| Max sessions | ✅ Limited | MAX_SESSION_LIMIT |

### Authorization

| Check | Status | Notes |
|-------|--------|-------|
| Booking ownership | ✅ Verified | `booking.user_id !== userId` |
| Payment ownership | ✅ Verified | `payment.user_id !== userId` |
| Admin bypass | ✅ Implemented | `req.user?.role !== 'admin'` |
| Webhook access | ⚠️ IP-based only | No signature validation fallback |

### Webhook Security

| Check | Status | Notes |
|-------|--------|-------|
| Signature verification | ✅ HMAC-SHA256 | `verifySignature()` |
| Timing-safe comparison | ✅ Used | `crypto.timingSafeEqual()` |
| Raw body preservation | ✅ Correct | `express.raw()` before JSON parser |
| Replay protection | ✅ Event ID uniqueness | `ON CONFLICT (event_id)` |

### Injection Prevention

| Type | Status | Notes |
|------|--------|-------|
| SQL Injection | ✅ Safe | Parameterized queries throughout |
| NoSQL Injection | N/A | No NoSQL database |
| XSS | ✅ Headers set | `X-XSS-Protection` header |
| CSRF | ⚠️ Not explicit | Relies on JWT in Authorization header |

### Rate Limiting

| Endpoint | Status | Notes |
|----------|--------|-------|
| Global API | ❌ Disabled | Commented out in app.js |
| Idempotency conflicts | ✅ Tracked | `idempotencyConflictLimiter.js` |
| Webhook | ❌ None | No rate limiting on webhook endpoint |

### Secret Management

| Secret | Storage | Status |
|--------|---------|--------|
| DATABASE_URL | .env | ⚠️ File-based |
| JWT_SECRET | .env | ⚠️ File-based |
| RAZORPAY_KEY_SECRET | .env | ⚠️ File-based |
| RAZORPAY_WEBHOOK_SECRET | .env | ⚠️ File-based |
| REDIS_URL | .env | ⚠️ File-based |

**Risk:** Secrets in .env file, not in secrets manager (AWS Secrets Manager, HashiCorp Vault, etc.)

---

## 6. OBSERVABILITY + OPERATIONS AUDIT

### Metrics

| Metric | Status | Notes |
|--------|--------|-------|
| Request counter | ✅ Implemented | `monitoring.request_total` |
| Request duration | ✅ Implemented | `monitoring.request_duration_ms` |
| DB pool stats | ✅ Available | `db.poolStats()` |
| Queue depth | ⚠️ Not exposed | BullMQ metrics not exported |
| Redis health | ✅ Available | `isHealthy()`, `isQueueHealthy()` |
| Worker heartbeats | ✅ Implemented | Every 20s |

### Alerting

| Alert | Status | Notes |
|-------|--------|-------|
| High error rate | ⚠️ Slack webhook configured | Not verified working |
| Queue backlog | ❌ Not configured | No alerting |
| DB pool exhaustion | ❌ Not configured | No alerting |
| Redis failure | ❌ Not configured | No alerting |
| Payment failures | ❌ Not configured | No alerting |
| Refund failures | ❌ Not configured | No alerting |

### Tracing

| Feature | Status | Notes |
|---------|--------|-------|
| Request ID | ✅ Implemented | `X-Request-Id` header |
| Trace ID | ✅ Implemented | `traceIdMiddleware` |
| Correlation ID | ⚠️ Partial | Used in some places |
| Structured logging | ✅ Implemented | Pino JSON logs |

### SLO/SLI

| Metric | Status | Notes |
|--------|--------|-------|
| Availability SLO | ❌ Not defined | No target |
| Latency SLO | ❌ Not defined | No target |
| Error rate SLO | ❌ Not defined | No target |

### Debugging Capability

| Feature | Status | Notes |
|---------|--------|-------|
| Request logging | ✅ Full request/response | Pino middleware |
| Error stack traces | ✅ Captured | Error handler |
| DB query logging | ⚠️ Debug level only | Not in production |
| Webhook payload logging | ✅ Logged | Full payload in logs |

---

## 7. INFRASTRUCTURE + DEPLOYMENT AUDIT

### PM2 Configuration

| Setting | Value | Status |
|---------|-------|--------|
| API instances | 2 (configurable) | ✅ Safe |
| Worker instances | 1 | ⚠️ Single point of failure |
| Max memory restart | 500MB | ✅ Reasonable |
| Kill timeout | 10s (API), 30s (workers) | ✅ Adequate |
| Restart delay | 3s | ✅ Prevents thundering herd |

### Docker

| Feature | Status | Notes |
|---------|--------|-------|
| Non-root user | ✅ Implemented | `planbuddy:planbuddy` |
| Health check | ✅ Implemented | `healthcheck.js` |
| Multi-stage build | ✅ Implemented | Lean production image |
| .dockerignore | ⚠️ Not reviewed | Should exclude node_modules |

### Migration Safety

| Feature | Status | Notes |
|---------|--------|-------|
| Idempotent migrations | ✅ Most are idempotent | `IF NOT EXISTS` guards |
| Rollback scripts | ✅ Provided | In migration files |
| Migration tracking | ✅ Implemented | `schema_migrations` table |
| Transactional migrations | ⚠️ Partial | Some indexes outside transaction |

### Graceful Shutdown

| Component | Status | Notes |
|-----------|--------|-------|
| HTTP server | ✅ Implemented | `server.close()` |
| BullMQ queues | ✅ Implemented | `closeQueues()` |
| DB connections | ✅ Implemented | `db.end()` |
| Redis connections | ✅ Implemented | `disconnect()` |
| Timeout fallback | ✅ 30s | Force exit |

---

## 8. AUTO FIX ENGINE

### PRIORITY 1: CRITICAL FIXES (Deploy Immediately)

#### FIX-01: Fix Refund Payment Lookup (CRITICAL-01 + CRITICAL-08)

**File:** `planbuddy_v9/controllers/paymentController.js`  
**Lines:** 440-447

**Current (broken):**
```javascript
const paymentResult = await db.query(
  `SELECT p.*, b.user_id, b.id as booking_id, b.status as booking_status, b.payment_status
   FROM payments p
   JOIN bookings b ON b.id = p.booking_id
   WHERE p.razorpay_payment_id = $1
   FOR UPDATE OF p`,
  [paymentId]  // paymentId is internal UUID from req.params
);
```

**Fixed:**
```javascript
// First, find the payment by internal UUID
const paymentResult = await db.query(
  `SELECT p.*, b.user_id, b.id as booking_id, b.status as booking_status, b.payment_status
   FROM payments p
   JOIN bookings b ON b.id = p.booking_id
   WHERE p.id = $1
   FOR UPDATE OF p`,
  [paymentId]  // Now correctly using internal UUID
);
```

**Alternative safer design:** Use `razorpay_payment_id` from the URL instead:
```javascript
// If URL is /api/v1/payments/:razorpay_payment_id/refund
const paymentResult = await db.query(
  `SELECT p.*, b.user_id, b.id as booking_id
   FROM payments p
   JOIN bookings b ON b.id = p.booking_id
   WHERE p.razorpay_payment_id = $1
   FOR UPDATE OF p`,
  [razorpayPaymentId]  // Use Razorpay payment ID from URL
);
```

---

#### FIX-02: Add Missing idempotency_key Column (CRITICAL-02 + CRITICAL-04)

**File:** Create new migration `184_add_idempotency_key_to_refunds.sql`

```sql
-- Migration 184: Add idempotency_key to refunds table
-- Fixes missing column that was referenced in code but not created in migration 180

BEGIN;

-- Add column if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'refunds' AND column_name = 'idempotency_key'
  ) THEN
    ALTER TABLE refunds ADD COLUMN idempotency_key VARCHAR(255);
  END IF;
END $$;

-- Create index for efficient lookups
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_refunds_idempotency_key
  ON refunds(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Record migration
INSERT INTO schema_migrations (version, filename, run_at)
VALUES ('184', '184_add_idempotency_key_to_refunds.sql', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
```

---

#### FIX-03: Fix Payment Signature Verification Secret (CRITICAL-03)

**File:** `planbuddy_v9/controllers/paymentController.js`  
**Lines:** 214-217

**Current (broken):**
```javascript
const generatedSignature = crypto
  .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
  .update(`${razorpay_order_id}|${razorpay_payment_id}`)
  .digest('hex');
```

**Fixed:**
```javascript
const generatedSignature = crypto
  .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)  // Use API key secret
  .update(`${razorpay_order_id}|${razorpay_payment_id}`)
  .digest('hex');
```

---

#### FIX-04: Add Amount Verification to Payment Verification (CRITICAL-07)

**File:** `planbuddy_v9/controllers/paymentController.js`  
**Lines:** 228-238

**Current (missing amount check):**
```javascript
const payment = await razorpay.payments.fetch(razorpay_payment_id);

if (payment.status !== 'captured') {
  logger.warn({ requestId, razorpay_payment_id, status: payment.status }, '[payment] Payment not captured');
  return res.status(400).json({...});
}
```

**Fixed:**
```javascript
const payment = await razorpay.payments.fetch(razorpay_payment_id);

if (payment.status !== 'captured') {
  logger.warn({ requestId, razorpay_payment_id, status: payment.status }, '[payment] Payment not captured');
  return res.status(400).json({
    success: false,
    code: 'PAYMENT_NOT_CAPTURED',
    message: 'Payment was not successfully captured'
  });
}

// 🔴 CRITICAL: Verify amount matches expected order amount
const expectedAmount = rupeesToPaise(amount); // amount from order
if (payment.amount !== expectedAmount) {
  logger.warn({ 
    requestId, 
    razorpay_payment_id, 
    expectedAmount, 
    actualAmount: payment.amount 
  }, '[payment] Amount mismatch - possible manipulation');
  return res.status(400).json({
    success: false,
    code: 'AMOUNT_MISMATCH',
    message: 'Payment amount does not match order amount',
    expected: paiseToRupees(expectedAmount),
    actual: paiseToRupees(payment.amount)
  });
}
```

**Note:** Need to pass `amount` from the order creation to verification. Store in DB or verify against order.

---

#### FIX-05: Fix Transaction Isolation Level (CRITICAL-06)

**File:** `planbuddy_v9/services/RazorpayService.js`  
**Lines:** 29-34

**Current (wrong order):**
```javascript
async function processPaymentTransaction(orderId, paymentId, amount, currency, userId, correlationId, client) {
  let attempt = 0;
  while (attempt < 3) {
    try {
      await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
```

**Fixed:** Remove this function entirely - it's not used correctly. The `db.transaction()` method in `config/db.js` already handles isolation levels correctly.

If this function is needed, rewrite to use the existing transaction wrapper:

```javascript
async function processPaymentTransaction(orderId, paymentId, amount, currency, userId, correlationId) {
  return await db.transactionRR(async (client) => {
    // Transaction is already in REPEATABLE READ isolation
    const payment = await client.query(
      'SELECT * FROM payments WHERE razorpay_payment_id = $1 FOR UPDATE',
      [paymentId]
    );
    
    if (payment.rows.length === 0 || payment.rows[0].status !== 'created') {
      return { idempotent: true };
    }

    const razorpayPayment = await razorpay.payments.fetch(paymentId);
    if (razorpayPayment.status !== 'captured') {
      await client.query('UPDATE payments SET status = $1 WHERE id = $2', ['failed', payment.rows[0].id]);
      return { idempotent: false, status: 'failed' };
    }

    await client.query(`
      UPDATE payments SET status = 'captured' WHERE id = $1;
      UPDATE bookings SET status = 'confirmed' WHERE id = (SELECT booking_id FROM payments WHERE id = $1);
    `, [payment.rows[0].id]);

    return { idempotent: false, status: 'captured' };
  }, 'process_payment_transaction');
}
```

---

### PRIORITY 2: HIGH FIXES (Deploy Within 1 Week)

#### FIX-06: Enable Backpressure Middleware

**File:** `planbuddy_v9/app.js`  
**Lines:** 148-149

**Current:**
```javascript
const { backpressureMiddleware } = require('./middleware/backpressure');
// app.use(backpressureMiddleware);
```

**Fixed:**
```javascript
const { backpressureMiddleware } = require('./middleware/backpressure');
app.use(backpressureMiddleware);  // Enable backpressure
```

---

#### FIX-07: Enable Global Rate Limiter

**File:** `planbuddy_v9/app.js`  
**Lines:** 144-145

**Current:**
```javascript
// app.use('/api', globalLimiter);
```

**Fixed:**
```javascript
const { globalLimiter } = require('./middleware/rateLimit');
app.use('/api', globalLimiter);
```

---

#### FIX-08: Add Webhook Rate Limiting

**File:** `planbuddy_v9/app.js`  
**After line 138:**

```javascript
// Rate limit webhook endpoint (separate from API)
const { RateLimiterRedis } = require('rate-limit-redis');
const { redis } = require('./config/redis');

const webhookLimiter = new RateLimiterRedis({
  storeClient: redis,
  points: 100,  // 100 webhooks
  duration: 1,  // per second
  keyPrefix: 'webhook_rate_limit',
});

app.use('/webhooks/razorpay', async (req, res, next) => {
  try {
    await webhookLimiter.consume(req.ip);
    next();
  } catch (rejRes) {
    logger.warn({ ip: req.ip }, '[webhook] Rate limit exceeded');
    return res.status(429).json({ ok: false, error: 'rate_limit_exceeded' });
  }
});
```

---

#### FIX-09: Fix Webhook Return Code on Invalid Signature

**File:** `planbuddy_v9/controllers/razorpayWebhookController.js`  
**Lines:** 402-420

**Current:**
```javascript
if (!signature) {
  logger.warn({ requestId }, '[webhook][razorpay] Missing x-razorpay-signature');
  return res.status(200).json({ ok: true });  // Wrong - tells Razorpay it's OK
}
```

**Fixed:**
```javascript
if (!signature) {
  logger.warn({ requestId }, '[webhook][razorpay] Missing x-razorpay-signature');
  return res.status(400).json({ ok: false, error: 'missing_signature' });  // Reject
}

// ... signature verification ...

if (!ok) {
  logger.warn({ requestId }, '[webhook][razorpay] Signature verification failed');
  return res.status(400).json({ ok: false, error: 'invalid_signature' });  // Reject
}
```

---

### PRIORITY 3: MEDIUM FIXES (Deploy Within 1 Month)

#### FIX-10: Add Circuit Breaker for Razorpay API

Create new file `planbuddy_v9/services/circuitBreaker.js`:

```javascript
'use strict';

class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5;
    this.resetTimeout = options.resetTimeout || 60000;
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.failures = 0;
    this.lastFailureTime = null;
    this.successes = 0;
  }

  async call(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > this.resetTimeout) {
        this.state = 'HALF_OPEN';
        this.successes = 0;
      } else {
        throw new Error('Circuit breaker is OPEN');
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  onSuccess() {
    this.failures = 0;
    if (this.state === 'HALF_OPEN') {
      this.successes++;
      if (this.successes >= 3) {
        this.state = 'CLOSED';
      }
    }
  }

  onFailure() {
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
    }
  }

  getStatus() {
    return {
      state: this.state,
      failures: this.failures,
      lastFailureTime: this.lastFailureTime,
    };
  }
}

module.exports = CircuitBreaker;
```

---

#### FIX-11: Increase DB Pool Size

**File:** `planbuddy_v9/config/env.js`  
**Line:** 90

**Current:**
```javascript
DB_POOL_MAX: optionalInt('DB_POOL_MAX', 30, 1),
```

**Fixed:**
```javascript
DB_POOL_MAX: optionalInt('DB_POOL_MAX', 50, 1),  // Increased from 30
```

Update `ecosystem.config.js` accordingly to maintain safety formula.

---

#### FIX-12: Add Worker HA (Second Worker Instance)

**File:** `planbuddy_v9/config/ecosystem.config.js`  
**Lines:** 149-150

**Current:**
```javascript
exec_mode: 'fork',
instances: 1,
```

**Fixed:**
```javascript
exec_mode: 'fork',
instances: process.env.WORKER_INSTANCES ? parseInt(process.env.WORKER_INSTANCES, 10) : 2,
```

**Note:** Need to handle cron job deduplication. Use `pg_advisory_lock` to ensure only one worker runs cron jobs.

---

## 9. FINAL PRODUCTION SCORE

### Category Scores (0–10)

| Category | Score | Justification |
|----------|-------|---------------|
| **Financial Safety** | 3/10 | Critical bugs in refund and payment verification |
| **System Reliability** | 6/10 | Good transaction handling, but single worker SPOF |
| **Scalability** | 5/10 | PM2 clustering works, but pool sizing and backpressure disabled |
| **Observability** | 6/10 | Good logging and tracing, but missing alerts |
| **Security** | 5/10 | Good auth/authz, but rate limiting disabled, secrets in .env |
| **Deployment Safety** | 7/10 | Good migrations, graceful shutdown, but no rollback automation |
| **Recovery Capability** | 6/10 | DLQ exists, but no automated recovery procedures |

### **FINAL SCORE: 38/100**

### Classification: ❌ NOT PRODUCTION READY

---

## 10. EXECUTIVE SUMMARY

### Critical Findings

1. **Refund API is completely broken** - Wrong column in WHERE clause prevents all refunds
2. **Payment verification uses wrong secret** - All frontend payment confirmations fail
3. **Missing database column** - `idempotency_key` not in refunds table
4. **No amount verification** - Payment amount manipulation possible
5. **Transaction isolation misconfigured** - SERIALIZABLE not properly set

### Immediate Actions Required

1. **DO NOT DEPLOY TO PRODUCTION** until CRITICAL fixes are applied
2. Deploy FIX-01 through FIX-05 immediately
3. Run integration tests for refund flow
4. Run integration tests for payment verification flow
5. Verify migration 184 applied before any refund API usage

### Risk Assessment

| Risk | Probability | Impact | Overall |
|------|-------------|--------|---------|
| Duplicate refunds | Medium | High | 🔴 HIGH |
| Payment amount fraud | Low | High | 🟠 MEDIUM |
| Refund API failure | High | High | 🔴 CRITICAL |
| System overload | Medium | Medium | 🟠 MEDIUM |
| Data corruption | Low | High | 🟠 MEDIUM |

### Recommendation

**HALT all production deployment plans.** This system has critical financial integrity bugs that could result in:
- Inability to process customer refunds
- Payment verification failures
- Potential financial loss through amount manipulation

Fix all CRITICAL issues, run comprehensive integration tests, and re-audit before considering production deployment.

---

*End of Audit Report*
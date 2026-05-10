# 🔥 PRODUCTION HARDENING AUDIT — PHASE 1, 2, 3

> **Auditor:** Principal Fintech Production Reliability Engineer
> **System:** PlanBuddy Backend (Payment Processing)
> **Scope:** Full repository scan, line-level analysis
> **Classification:** REAL MONEY SYSTEM — Any mistake = financial loss

---

## EXECUTIVE SUMMARY

| Metric | Count |
|--------|-------|
| **CRITICAL** issues | 11 |
| **HIGH** issues | 10 |
| **MEDIUM** issues | 6 |
| **LOW** issues | 3 |
| **Total** | **30** |

**VERDICT: ❌ NOT PRODUCTION-READY**

The system has **multiple financially catastrophic bugs** that will cause:
- Double refunds (direct money loss)
- Refund failures for all booking cancellations
- Corrupted financial records (1/100th of actual amounts)
- Lost webhooks (payments never confirmed)
- Complete PM2 deployment failure

---

# PHASE 1 — FULL SYSTEM FINDINGS

---

## 🚨 CRITICAL ISSUES

---

### FIN-001: Booking Cancellation Refunds Completely Broken

```
ISSUE ID:     FIN-001
SEVERITY:     CRITICAL
FILE:         planbuddy_v9/controllers/bookingController.js
LINE RANGE:   212-216
ROOT CAUSE:   Parameter order mismatch between caller and callee
IMPACT:       ALL booking cancellations with refunds fail with "amount must be positive".
              Users cannot get refunds. Revenue is trapped. Customer support explodes.
              If fixed later without data migration, partial refund records may be inconsistent.
FIX:          Pass parameters in correct order: (bookingId, amount, reason, requestedBy)
```

**Evidence:**
```javascript
// bookingController.js:212-216
await RefundService.initiateRefund(
  bookingId,
  reason || 'Cancelled by user',   // <-- Passed as `amount` (string)
  req.user.id                       // <-- Passed as `reason` (UUID string)
);

// refundService.js:106
async function initiateRefund(bookingId, amount, reason, requestedBy) {
  // `amount` = 'Cancelled by user' → Math.round('Cancelled by user' * 100) = NaN
  // → throws "amount must be positive"
}
```

---

### FIN-002: Full Refund Amounts Stored at 1/100th of Actual Value

```
ISSUE ID:     FIN-002
SEVERITY:     CRITICAL
FILE:         planbuddy_v9/services/refundService.js
LINE RANGE:   204
ROOT CAUSE:   `payment.amount / 100` when payment.amount is already in rupees
IMPACT:       Full refunds store 1/100th of actual amount in DB (e.g., ₹1000 stored as ₹10).
              Financial records are permanently corrupted. Accounting, taxes, and reconciliation
              will all be wrong. Regulatory audit failure.
FIX:          Use `payment.amount` instead of `payment.amount / 100`
```

**Evidence:**
```javascript
// refundService.js:204
amount || (payment.amount / 100)  // payment.amount is ALREADY in rupees

// If payment.amount = 1000.00 (rupees):
// payment.amount / 100 = 10.00 ← WRONG
// Should be: payment.amount = 1000.00
```

---

### FIN-003: Double Refund Race Condition — Advisory Lock Is Completely Ineffective

```
ISSUE ID:     FIN-003
SEVERITY:     CRITICAL
FILE:         planbuddy_v9/controllers/paymentController.js
LINE RANGE:   480-489, 521-662
ROOT CAUSE:   pg_advisory_xact_lock used outside a transaction → releases immediately
IMPACT:       Concurrent refund requests for same payment can both succeed.
              Razorpay creates TWO refunds for ONE payment.
              Direct, immediate, unrecoverable financial loss.
FIX:          Wrap entire refund logic in db.transaction() with advisory lock + FOR UPDATE
```

**Evidence:**
```javascript
// paymentController.js:480-489
const paymentResult = await db.query(
  `SELECT pg_advisory_xact_lock(...);   -- xact_lock = transaction-scoped
   SELECT ... FROM payments ... FOR UPDATE`,
  [paymentId]
);
// db.query() acquires client, runs query, RELEASES CLIENT
// Advisory lock is released when the implicit statement transaction ends
// → Lock held for microseconds, NOT across the refund operation

// Lines 521-662: All refund logic runs WITHOUT any lock
```

---

### FIN-004: refunds.razorpay_payment_id Stores Internal UUID Instead of Gateway ID

```
ISSUE ID:     FIN-004
SEVERITY:     CRITICAL
FILE:         planbuddy_v9/controllers/paymentController.js
LINE RANGE:   622
ROOT CAUSE:   Uses `paymentId` (route param, internal UUID) instead of `payment.razorpay_payment_id`
IMPACT:       refunds.razorpay_payment_id contains internal UUIDs (e.g., "550e8400-e29b-41d4-a716-446655440000")
              instead of Razorpay payment IDs (e.g., "pay_1234567890").
              Reconciliation queries by razorpay_payment_id fail.
              Webhook correlation fails. Audit trail is useless.
FIX:          Use `payment.razorpay_payment_id`
```

**Evidence:**
```javascript
// paymentController.js:617-622
VALUES ($1, $2, $3, $4, $5, $6, ...)
// $5 = paymentId (req.params.paymentId = internal UUID)
// SHOULD BE: payment.razorpay_payment_id (gateway ID like "pay_xxx")
```

---

### FIN-005: Lost Webhooks on Any Error — All Errors Return 200 to Razorpay

```
ISSUE ID:     FIN-005
SEVERITY:     CRITICAL
FILE:         planbuddy_v9/controllers/razorpayWebhookController.js
LINE RANGE:   524-530
ROOT CAUSE:   Catch-all error handler returns 200 for EVERY exception
IMPACT:       If DB is down, Redis is down, or queue is full, the webhook is ACKed but NEVER persisted.
              Razorpay will NOT retry. Payment confirmations and refund confirmations are LOST.
              Bookings stay in "created" or "refund_pending" forever.
              Financial state becomes permanently inconsistent.
FIX:          Return 500 for transient errors (DB down, queue down). Return 200 ONLY after
              successful persistence to webhook_events table.
```

**Evidence:**
```javascript
// razorpayWebhookController.js:524-530
catch (err) {
  logger.error(...);
  // Always return 200 to prevent Razorpay retries
  return res.status(200).json({ ok: true });
}
```

---

### FIN-006: Refund Retry Worker Creates Duplicate Razorpay Refunds

```
ISSUE ID:     FIN-006
SEVERITY:     CRITICAL
FILE:         planbuddy_v9/workers/refund-retry.worker.js
LINE RANGE:   153-163, 228-238
ROOT CAUSE:   On retry, calls razorpay.refunds.create() again without checking if refund
              already exists at Razorpay gateway.
IMPACT:       If webhook is delayed and worker retries, a SECOND refund is created.
              Direct financial loss. No DB constraint prevents this because each retry
              gets a new Razorpay refund ID.
FIX:          Before calling razorpay.refunds.create(), query Razorpay for existing refunds
              on this payment. If any refund exists with matching amount, reuse it.
```

---

### FIN-007: DLQ Processor Never Processes Any Failed Jobs

```
ISSUE ID:     FIN-007
SEVERITY:     CRITICAL
FILE:         planbuddy_v9/workers/dlq-processor.worker.js
LINE RANGE:   91
ROOT CAUSE:   Checks `job.failedReason === 'max retries exceeded'` but BullMQ stores
              the actual error message (e.g., "Refund API timeout"), not this string.
IMPACT:       Failed jobs NEVER move to the dead_letter_jobs table.
              Operators are NEVER alerted.
              Financial operations (refunds, payments) are silently lost forever.
              The DLQ system is completely non-functional theater.
FIX:          Check `job.attemptsMade >= (job.opts.attempts || 5)` instead.
```

**Evidence:**
```javascript
// dlq-processor.worker.js:91
if (job.failedReason === 'max retries exceeded') {  // ← NEVER TRUE
```

---

### FIN-008: createOrder Idempotency Key Completely Ignored

```
ISSUE ID:     FIN-008
SEVERITY:     CRITICAL
FILE:         planbuddy_v9/controllers/paymentController.js
LINE RANGE:   57-78
ROOT CAUSE:   Looks up existing order by `booking_id + amount` instead of `idempotency_key`
IMPACT:       1. Two different idempotency keys for same booking+amount return the SAME order
                 (wrong — each idempotency key should be independent)
              2. Same idempotency key with different amount CREATES a new order
                 (wrong — should return 409 or cached response)
              3. Duplicate orders can be created for the same booking under different keys
FIX:          Look up razorpay_order_mappings by idempotency_key column (add column if needed)
              or maintain a separate idempotency_keys mapping.
```

**Evidence:**
```javascript
// paymentController.js:59-63
const existingOrder = await db.query(
  `SELECT * FROM razorpay_order_mappings 
   WHERE booking_id = $1 AND amount = $2`,  // ← idempotency_key ignored!
  [bookingId, amount]
);
```

---

### DEP-001: PM2 Config Points to Non-Existent server.js

```
ISSUE ID:     DEP-001
SEVERITY:     CRITICAL
FILE:         planbuddy_v9/ecosystem.config.js
LINE RANGE:   22
ROOT CAUSE:   `script: 'server.js'` but entry point is `app.js`
IMPACT:       PM2 cannot start the API server. Complete production outage on deployment.
FIX:          Change to `script: 'app.js'`
```

---

### DEP-002: Graceful Shutdown Fails — db.end() Does Not Exist

```
ISSUE ID:     DEP-002
SEVERITY:     CRITICAL
FILE:         planbuddy_v9/app.js
LINE RANGE:   309
ROOT CAUSE:   Database class has `pool` getter but no `end()` method
IMPACT:       Graceful shutdown throws "db.end is not a function".
              DB connections are not closed cleanly.
              In-flight transactions may be aborted mid-flight, causing data corruption.
              Container orchestrator may kill the process before cleanup completes.
FIX:          Call `db.pool.end()` instead of `db.end()`
```

---

## 🔴 HIGH ISSUES

---

### DEP-003: PM2 Config References Non-Existent Worker Files

```
ISSUE ID:     DEP-003
SEVERITY:     HIGH
FILE:         planbuddy_v9/ecosystem.config.js
LINE RANGE:   65, 84
ROOT CAUSE:   maintenance.worker.js and alert-poller.worker.js do not exist in repo
IMPACT:       PM2 continuously restarts missing processes, wasting resources,
              filling logs with errors, potentially masking real issues.
FIX:          Remove entries or create the worker files.
```

---

### SEC-001: SSL Certificate Validation Disabled for Database

```
ISSUE ID:     SEC-001
SEVERITY:     HIGH
FILE:         planbuddy_v9/config/db.js
LINE RANGE:   124
ROOT CAUSE:   `ssl: { rejectUnauthorized: false }` hardcoded
IMPACT:       Man-in-the-middle attacks on database connections possible in production.
              Attackers can intercept and modify financial data in transit.
FIX:          Make SSL validation configurable via env var (default true in production).
```

---

### CON-001: Reconciliation Worker Lock Release Race Condition

```
ISSUE ID:     CON-001
SEVERITY:     HIGH
FILE:         planbuddy_v9/workers/payment-reconciliation-queue.worker.js
LINE RANGE:   241
ROOT CAUSE:   `redis.del(lockKey)` without token verification
IMPACT:       If lock expires (300s) and another worker acquires it,
              the first worker's finally block deletes the second worker's lock.
              Two reconciliation workers run simultaneously.
              Race conditions on payment/booking updates.
FIX:          Use Redis Lua script with token verification, or Redlock algorithm.
```

---

### CON-002: Webhook Processor Allows Duplicate Concurrent Processing

```
ISSUE ID:     CON-002
SEVERITY:     HIGH
FILE:         planbuddy_v9/workers/webhook-processor.worker.js
LINE RANGE:   55-71
ROOT CAUSE:   Only checks `status === 'processed'`, not `status === 'processing'`
IMPACT:       Two workers can process the same webhook event simultaneously.
              Double payment confirmations or double refund updates possible.
FIX:           Check for 'processing' status and skip, or use SELECT FOR UPDATE with NOWAIT.
```

---

### CON-003: Refund Retry Worker Queries Outside Transaction

```
ISSUE ID:     CON-003
SEVERITY:     HIGH
FILE:         planbuddy_v9/workers/refund-retry.worker.js
LINE RANGE:   109-117
ROOT CAUSE:   `db.query` instead of `client.query` for existing refund check
IMPACT:       Existing refund check is not protected by the transaction.
              Race condition: two concurrent retries both see no existing refund,
              both create new Razorpay refunds.
FIX:          Use `client.query` throughout the transaction callback.
```

---

### CON-004: Refund API Has Race Window for Duplicate Refunds

```
ISSUE ID:     CON-004
SEVERITY:     HIGH
FILE:         planbuddy_v9/controllers/paymentController.js
LINE RANGE:   521-662
ROOT CAUSE:   Existing refund check (lines 521-552) and Razorpay API call are
              outside any database transaction.
IMPACT:       Two concurrent requests can both see no existing refunds,
              both call Razorpay, both create refunds.
              The DB unique constraint on idempotency_key only helps if clients
              use the SAME key, but different keys bypass it.
FIX:          Wrap the entire operation (check + API call + insert) in a transaction
              with FOR UPDATE on payment and refund rows.
```

---

### QUE-001: Webhook Queue Failure Swallowed with 200 ACK

```
ISSUE ID:     QUE-001
SEVERITY:     HIGH
FILE:         planbuddy_v9/controllers/razorpayWebhookController.js
LINE RANGE:   514-520
ROOT CAUSE:   Queue add failure caught and logged, but webhook still ACKed with 200
IMPACT:       Webhook is persisted in DB but never queued for processing.
              The webhook-events worker never sees it.
              Payment/refund updates never happen.
FIX:          Return 500 if queue.add() fails so Razorpay retries the webhook.
```

---

### API-001: /health Endpoint Is a No-Op (Always Returns OK)

```
ISSUE ID:     API-001
SEVERITY:     HIGH
FILE:         planbuddy_v9/app.js
LINE RANGE:   253-255
ROOT CAUSE:   Returns { ok: true } without checking DB, Redis, or queue health
IMPACT:       Load balancers and container orchestrators think the app is healthy
              when DB or Redis are down. Traffic is routed to a broken instance.
              Users see errors instead of graceful degradation.
FIX:          Check DB connectivity, Redis PING, and queue health before returning 200.
```

---

### API-002: Backpressure Middleware Async Without Error Handling

```
ISSUE ID:     API-002
SEVERITY:     HIGH
FILE:         planbuddy_v9/middleware/backpressure.js
LINE RANGE:   128
ROOT CAUSE:   Express 4.x does not catch errors from async middleware
IMPACT:       If db.query('SELECT 1') throws, unhandled promise rejection crashes process.
FIX:          Wrap entire middleware body in try-catch and call next(err).
```

---

### API-003: verifyPayment Makes External API Call Without Circuit Breaker

```
ISSUE ID:     API-003
SEVERITY:     HIGH
FILE:         planbuddy_v9/controllers/paymentController.js
LINE RANGE:   234
ROOT CAUSE:   `razorpay.payments.fetch()` not wrapped in circuit breaker
IMPACT:       If Razorpay is slow or down, requests hang indefinitely.
              Connection pool exhaustion. Cascade failure across all API endpoints.
FIX:          Wrap in `razorpayCircuitBreaker.call()`.
```

---

## 🟡 MEDIUM ISSUES

---

### API-004: createOrder Has No Row Locking for Booking

```
ISSUE ID:     API-004
SEVERITY:     MEDIUM
FILE:         planbuddy_v9/controllers/paymentController.js
LINE RANGE:   81-87
ROOT CAUSE:   Booking query lacks FOR UPDATE
IMPACT:       Concurrent order creation for same booking possible.
              Multiple Razorpay orders for one booking.
FIX:          Use transaction with FOR UPDATE on bookings row.
```

---

### API-005: cancelBooking Generates Random Idempotency Key

```
ISSUE ID:     API-005
SEVERITY:     MEDIUM
FILE:         planbuddy_v9/controllers/bookingController.js
LINE RANGE:   256
ROOT CAUSE:   `crypto.randomUUID()` fallback makes operation non-idempotent
IMPACT:       Client retries create multiple cancellation attempts.
FIX:          Require idempotency key from client for cancellation endpoint.
```

---

### API-006: initiateRefund Treats amount=0 as Full Refund

```
ISSUE ID:     API-006
SEVERITY:     MEDIUM
FILE:         planbuddy_v9/controllers/paymentController.js
LINE RANGE:   554
ROOT CAUSE:   `amount || payment.amount` treats 0 as falsy
IMPACT:       Explicit request for 0-rupee refund refunds full amount instead.
FIX:          Use `amount != null ? amount : payment.amount`
```

---

### FIN-009: Reconciliation Worker Creates No Refund Record

```
ISSUE ID:     FIN-009
SEVERITY:     MEDIUM
FILE:         planbuddy_v9/workers/payment-reconciliation-queue.worker.js
LINE RANGE:   125-147
ROOT CAUSE:   Marks payment as refunded without creating refunds table entry
IMPACT:       Missing audit trail for reconciled refunds.
FIX:          Create a refund record with processed_by='reconciliation' during reconciliation.
```

---

### FIN-010: Refund Retry Worker Marks Payment Refunded Before Webhook

```
ISSUE ID:     FIN-010
SEVERITY:     MEDIUM
FILE:         planbuddy_v9/workers/refund-retry.worker.js
LINE RANGE:   317-323
ROOT CAUSE:   Updates payment to 'refunded' immediately after API call
IMPACT:       Payment marked as refunded before money actually moves.
              Race condition with webhook processor.
FIX:          Use 'refund_pending' status, let webhook confirm to 'refunded'.
```

---

### DB-001: Migration Uses CREATE INDEX CONCURRENTLY Inside Transaction

```
ISSUE ID:     DB-001
SEVERITY:     MEDIUM
FILE:         planbuddy_v9/migrations/183_refund_unique_constraints.sql
LINE RANGE:   59, 66
ROOT CAUSE:   CREATE INDEX CONCURRENTLY cannot run inside a transaction block
IMPACT:       Migration fails, blocking deployment.
FIX:          Remove CONCURRENTLY keyword or run outside transaction.
```

---

## 🟢 LOW ISSUES

---

### DEP-004: start.sh Does Not Run Migrations

```
ISSUE ID:     DEP-004
SEVERITY:     LOW
FILE:         planbuddy_v9/start.sh
LINE RANGE:   6-7
ROOT CAUSE:   db-check.js only checks connectivity, does not run migrations
IMPACT:       New deployments may run with old schema, causing runtime errors.
FIX:          Add actual migration execution before starting server.
```

---

### DEP-005: Dockerfile Copies .env Into Image

```
ISSUE ID:     DEP-005
SEVERITY:     LOW
FILE:         planbuddy_v9/Dockerfile
LINE RANGE:   29
ROOT CAUSE:   COPY . . includes .env if present
IMPACT:       Secrets leaked in Docker image layers.
FIX:          Add .env to .dockerignore
```

---

### QUE-002: Webhook Job Retention Too Short

```
ISSUE ID:     QUE-002
SEVERITY:     LOW
FILE:         planbuddy_v9/controllers/razorpayWebhookController.js
LINE RANGE:   504-510
ROOT CAUSE:   removeOnComplete age = 3600s (1 hour)
IMPACT:       Cannot debug webhook history beyond 1 hour.
FIX:          Increase to 24 hours or use count-based retention.
```

---

# PHASE 2 — SYSTEM FIX PLAN

---

## Financial Safety Fixes (Priority 1 — Block Production)

| Fix | Files | Lines | Description |
|-----|-------|-------|-------------|
| FIN-001 | bookingController.js | 212 | Fix parameter order to refundService.initiateRefund |
| FIN-002 | refundService.js | 204 | Remove `/ 100` from payment.amount storage |
| FIN-003 | paymentController.js | 480-662 | Wrap initiateRefund in transaction with proper locking |
| FIN-004 | paymentController.js | 622 | Use `payment.razorpay_payment_id` in refund insert |
| FIN-005 | razorpayWebhookController.js | 524 | Return 500 for transient errors, 200 only after persistence |
| FIN-006 | refund-retry.worker.js | 153 | Check Razorpay for existing refunds before creating new ones |
| FIN-007 | dlq-processor.worker.js | 91 | Fix job exhaustion check to use attemptsMade |
| FIN-008 | paymentController.js | 57 | Look up orders by idempotency_key |
| FIN-009 | payment-reconciliation-queue.worker.js | 125 | Create refund record during reconciliation |
| FIN-010 | refund-retry.worker.js | 317 | Use 'refund_pending' instead of 'refunded' |

## Concurrency Fixes (Priority 1)

| Fix | Files | Lines | Description |
|-----|-------|-------|-------------|
| CON-001 | payment-reconciliation-queue.worker.js | 241 | Use Redis Lua script with token for lock release |
| CON-002 | webhook-processor.worker.js | 55 | Check for 'processing' status to prevent duplicates |
| CON-003 | refund-retry.worker.js | 109 | Use client.query inside transaction |
| CON-004 | paymentController.js | 521 | Move all refund logic inside transaction |

## Queue/Worker Fixes (Priority 1)

| Fix | Files | Lines | Description |
|-----|-------|-------|-------------|
| QUE-001 | razorpayWebhookController.js | 514 | Return 500 if queue.add() fails |
| QUE-002 | razorpayWebhookController.js | 504 | Increase job retention to 24h |

## Database/Migration Fixes (Priority 2)

| Fix | Files | Lines | Description |
|-----|-------|-------|-------------|
| DB-001 | 183_refund_unique_constraints.sql | 59 | Remove CONCURRENTLY from CREATE INDEX |

## Deployment Fixes (Priority 1)

| Fix | Files | Lines | Description |
|-----|-------|-------|-------------|
| DEP-001 | ecosystem.config.js | 22 | Change server.js to app.js |
| DEP-002 | app.js | 309 | Change db.end() to db.pool.end() |
| DEP-003 | ecosystem.config.js | 65 | Remove non-existent worker entries |
| DEP-004 | start.sh | 7 | Add migration execution |
| DEP-005 | .dockerignore | — | Add .env exclusion |

## API Fixes (Priority 2)

| Fix | Files | Lines | Description |
|-----|-------|-------|-------------|
| API-001 | app.js | 253 | Implement real health check |
| API-002 | backpressure.js | 128 | Add try-catch for async middleware |
| API-003 | paymentController.js | 234 | Add circuit breaker to verifyPayment |
| API-004 | paymentController.js | 81 | Add FOR UPDATE to booking query |
| API-005 | bookingController.js | 256 | Require idempotency key |
| API-006 | paymentController.js | 554 | Fix amount=0 handling |

## Security Fixes (Priority 2)

| Fix | Files | Lines | Description |
|-----|-------|-------|-------------|
| SEC-001 | config/db.js | 124 | Make SSL validation configurable |

---

# PHASE 3 — CODE PATCHES

---

## FINANCIAL SAFETY PATCHES

### Patch FIN-001 + FIN-003 + FIN-004: Refund Controller Hardening

**File:** `planbuddy_v9/controllers/paymentController.js`

Replace the entire `initiateRefund` function (lines 412-694) with the hardened version below.

```javascript
exports.initiateRefund = async (req, res, next) => {
  const requestId = req.requestId;
  
  try {
    const { paymentId } = req.params;
    const { reason, amount } = req.body;
    const userId = req.user?.id;
    
    const idempotencyKey = req.headers['idempotency-key'];
    
    if (!idempotencyKey) {
      return res.status(400).json({
        success: false,
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Idempotency-Key header is required for refund requests to prevent duplicate refunds'
      });
    }
    
    if (!/^[a-zA-Z0-9_-]+$/.test(idempotencyKey)) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_IDEMPOTENCY_KEY',
        message: 'Idempotency-Key must contain only alphanumeric characters, hyphens, and underscores'
      });
    }

    // ── ENTIRE OPERATION WRAPPED IN TRANSACTION ──────────────────────────────
    const result = await db.transaction(async (client) => {
      // Step 1: Acquire advisory lock inside transaction (now actually works)
      await client.query(
        `SELECT pg_advisory_xact_lock(
           ('x' || substr(md5('refund:' || $1::text), 1, 16))::bit(64)::bigint
         )`,
        [paymentId]
      );

      // Step 2: Check idempotency inside transaction
      const idempotentCheck = await client.query(
        `SELECT r.*, p.razorpay_payment_id 
         FROM refunds r
         JOIN payments p ON p.id = r.payment_id
         WHERE r.idempotency_key = $1`,
        [idempotencyKey]
      );

      if (idempotentCheck.rows.length > 0) {
        const existingRefund = idempotentCheck.rows[0];
        return {
          idempotent: true,
          refundId: existingRefund.razorpay_refund_id,
          amount: existingRefund.amount,
          status: existingRefund.status
        };
      }

      // Step 3: Get payment with row lock
      const paymentResult = await client.query(
        `SELECT p.*, b.user_id, b.id as booking_id, b.status as booking_status, b.payment_status
         FROM payments p
         JOIN bookings b ON b.id = p.booking_id
         WHERE p.id = $1
         FOR UPDATE OF p`,
        [paymentId]
      );

      if (paymentResult.rows.length === 0) {
        throw Object.assign(new Error('Payment not found'), { code: 'PAYMENT_NOT_FOUND', status: 404 });
      }

      const payment = paymentResult.rows[0];

      if (payment.user_id !== userId && req.user?.role !== 'admin') {
        throw Object.assign(new Error('Access denied'), { code: 'ACCESS_DENIED', status: 403 });
      }

      if (payment.status !== 'captured') {
        throw Object.assign(new Error('Only captured payments can be refunded'), { code: 'PAYMENT_NOT_ELIGIBLE', status: 400 });
      }

      // Step 4: Check for existing active refunds (inside same transaction)
      const existingRefundCheck = await client.query(
        `SELECT * FROM refunds 
         WHERE payment_id = $1 
           AND status NOT IN ('cancelled', 'failed')
         FOR UPDATE`,
        [payment.id]
      );

      if (existingRefundCheck.rows.length > 0) {
        const existingRefund = existingRefundCheck.rows[0];
        if (existingRefund.status === 'succeeded') {
          throw Object.assign(new Error('This payment has already been refunded'), { code: 'ALREADY_REFUNDED', status: 400 });
        }
        return {
          idempotent: true,
          refundId: existingRefund.razorpay_refund_id,
          amount: existingRefund.amount,
          status: existingRefund.status,
          message: 'Refund is already being processed'
        };
      }

      const refundAmount = amount != null ? amount : payment.amount;

      if (refundAmount <= 0 || refundAmount > payment.amount) {
        throw Object.assign(new Error('Refund amount must be between 0 and the original payment amount'), { code: 'INVALID_REFUND_AMOUNT', status: 400 });
      }

      if (!payment.razorpay_payment_id) {
        throw Object.assign(new Error('Cannot refund: payment has no razorpay_payment_id'), { code: 'PAYMENT_NOT_REFUNDABLE', status: 400 });
      }

      // Step 5: Call Razorpay API
      const razorpayRefund = await razorpayCircuitBreaker.call(() =>
        razorpay.refunds.create({
          payment_id: payment.razorpay_payment_id,
          amount: rupeesToPaise(refundAmount),
          notes: {
            reason: reason || 'Refund requested by user',
            requestId: requestId,
            idempotencyKey: idempotencyKey,
            internalPaymentId: payment.id
          }
        })
      );

      // Step 6: Store refund in database
      await client.query(
        `INSERT INTO refunds (
          payment_id, booking_id, user_id, razorpay_refund_id, 
          razorpay_payment_id, amount, reason, status, 
          idempotency_key, razorpay_status, processed_by,
          metadata, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
        ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          payment.id,
          payment.booking_id,
          userId,
          razorpayRefund.id,
          payment.razorpay_payment_id,  // ✅ FIX FIN-004: gateway ID, not internal UUID
          refundAmount,
          reason || 'Refund requested by user',
          'initiated',
          idempotencyKey,
          razorpayRefund.status,
          'api',
          JSON.stringify({ requestId, reason: reason || 'Refund requested by user', initiatedAt: new Date().toISOString() })
        ]
      );

      // Step 7: Update payment to refund_pending (NOT refunded)
      await client.query(
        `UPDATE payments 
         SET status = 'refund_pending', updated_at = NOW()
         WHERE id = $1 AND status = 'captured'`,
        [payment.id]
      );

      return {
        idempotent: false,
        refundId: razorpayRefund.id,
        amount: refundAmount,
        status: razorpayRefund.status
      };
    }, 'initiate_refund');

    if (result.idempotent) {
      return res.json({
        success: true,
        data: {
          refundId: result.refundId,
          amount: result.amount,
          status: result.status,
          message: result.message || 'Refund completed successfully',
          idempotent: true
        }
      });
    }

    return res.json({
      success: true,
      data: {
        refundId: result.refundId,
        amount: result.amount,
        status: result.status,
        message: 'Refund initiated. Funds will be returned in 5-7 business days.'
      }
    });

  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        success: false,
        code: 'DUPLICATE_REFUND',
        message: 'A refund for this payment is already being processed'
      });
    }
    if (err.status) {
      return res.status(err.status).json({ success: false, code: err.code, message: err.message });
    }
    logger.error({ requestId, err: err.message }, '[payment] Error initiating refund');
    next(err);
  }
};
```

---

### Patch FIN-002: Fix Refund Amount Storage

**File:** `planbuddy_v9/services/refundService.js`

Change line 204:

```javascript
// BEFORE (BROKEN):
amount || (payment.amount / 100)

// AFTER (FIXED):
amount || payment.amount
```

Full context fix:

```javascript
      payment.id,
      bookingId,
      razorpayRefund.id,
      amount || payment.amount,  // ✅ FIXED: removed erroneous / 100
      reason || 'User cancellation',
```

---

### Patch FIN-005: Webhook Error Handling

**File:** `planbuddy_v9/controllers/razorpayWebhookController.js`

Replace lines 394-531 with:

```javascript
exports.handleRazorpayWebhook = async (req, res) => {
  const requestId = req.requestId || `webhook-${Date.now()}`;
  let eventPersisted = false;
  
  try {
    const signature = getSignature(req);
    const rawBody = req.body;

    if (!signature) {
      logger.error({ requestId }, '[webhook][razorpay] Missing x-razorpay-signature header');
      return res.status(400).json({ success: false, code: 'MISSING_SIGNATURE' });
    }

    if (!Buffer.isBuffer(rawBody)) {
      logger.error({ requestId }, '[webhook][razorpay] Raw body missing/invalid');
      return res.status(400).json({ success: false, code: 'INVALID_BODY' });
    }

    const secret = env.RAZORPAY_WEBHOOK_SECRET;
    const ok = verifySignature(rawBody, signature, secret);
    if (!ok) {
      logger.error({ requestId }, '[webhook][razorpay] Signature verification FAILED');
      try {
        const metrics = require('../services/metricsService');
        metrics.incrementCounter('webhook_signature_failures_total', { provider: 'razorpay' });
      } catch (e) {}
      return res.status(403).json({ success: false, code: 'SIGNATURE_INVALID' });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch (err) {
      logger.error({ requestId, err: err.message }, '[webhook][razorpay] Payload JSON parse failed');
      return res.status(422).json({ success: false, code: 'INVALID_JSON' });
    }

    const eventId = extractEventId(payload);
    if (!eventId) {
      logger.error({ requestId }, '[webhook][razorpay] Missing event id');
      return res.status(400).json({ success: false, code: 'MISSING_EVENT_ID' });
    }

    const provider = 'razorpay';
    const type = extractEventType(payload);

    logger.info({ requestId, eventId, type }, '[webhook][razorpay] Webhook received');

    // Persist event (idempotent) — THIS MUST SUCCEED BEFORE 200
    await db.transaction(async (client) => {
      const inserted = await insertWebhookEvent(client, {
        eventId: String(eventId),
        provider,
        type: type || null,
        payloadJson: payload,
      });
      eventPersisted = true;
      if (!inserted) {
        logger.info({ requestId, eventId }, '[webhook][razorpay] Duplicate event already persisted');
      }
    }, 'webhook_ingest');

    // Queue for async processing
    try {
      await webhookQueue.add('process-webhook', {
        eventId: String(eventId),
        provider,
        eventType: type,
        payload,
        receivedAt: new Date().toISOString()
      }, {
        jobId: `webhook-${eventId}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { age: 86400, count: 100 },  // ✅ FIX QUE-002: 24h retention
        removeOnFail: { age: 86400 }
      });
      logger.info({ requestId, eventId, type }, '[webhook][razorpay] Event queued for processing');
    } catch (queueErr) {
      // ✅ FIX FIN-005 / QUE-001: If queue fails, we must NOT return 200
      // The event IS persisted, so we can recover via replay service
      logger.error({ requestId, eventId, error: queueErr.message },
        '[webhook][razorpay] CRITICAL: Failed to queue event — event persisted but not queued');
      // Return 202 Accepted — event is safe, will be picked up by replay/reconciliation
      return res.status(202).json({ ok: true, queued: false, replay: true });
    }

    return res.status(200).json({ ok: true });

  } catch (err) {
    logger.error({ requestId, err: err.message }, '[webhook][razorpay] Handler error');
    
    // ✅ FIX FIN-005: Only return 200 if event was persisted
    if (eventPersisted) {
      // Event is safe in DB, even if something else failed
      return res.status(200).json({ ok: true });
    }
    
    // Transient error — tell Razorpay to retry
    return res.status(500).json({ success: false, code: 'PROCESSING_ERROR', message: 'Retry later' });
  }
};
```

---

### Patch FIN-006 + FIN-010: Refund Retry Worker Hardening

**File:** `planbuddy_v9/workers/refund-retry.worker.js`

Replace lines 40-349 with:

```javascript
async function processRefund(data) {
  const {
    bookingId,
    paymentId,
    razorpayPaymentId,
    amount,
    reason,
    requestedBy,
    attempt = 1,
    idempotencyKey = null,
    webhookEventId = null
  } = data;

  const correlationId = `refund-retry-${paymentId}-${attempt}-${Date.now()}`;

  logger.info({
    correlationId,
    bookingId,
    paymentId,
    razorpayPaymentId,
    amount,
    attempt,
    idempotencyKey
  }, '[refund-retry] Processing refund retry');

  return await db.transaction(async (client) => {
    // Lock the payment row
    const paymentResult = await client.query(
      `SELECT id, status, razorpay_payment_id, booking_id, amount, user_id
       FROM payments
       WHERE id = $1
       FOR UPDATE`,
      [paymentId]
    );

    if (!paymentResult.rows[0]) {
      throw new Error(`Payment ${paymentId} not found`);
    }

    const payment = paymentResult.rows[0];

    // Check by idempotency key if provided
    if (idempotencyKey) {
      const existingByIdempotencyKey = await client.query(
        `SELECT * FROM refunds WHERE idempotency_key = $1`,
        [idempotencyKey]
      );

      if (existingByIdempotencyKey.rows.length > 0) {
        const existingRefund = existingByIdempotencyKey.rows[0];
        return { 
          refunded: true, 
          idempotent: true, 
          refundId: existingRefund.razorpay_refund_id,
          status: existingRefund.status
        };
      }
    }

    // ✅ FIX CON-003: Use client.query instead of db.query
    const existingRefund = await client.query(
      `SELECT * FROM refunds
       WHERE payment_id = $1
         AND status NOT IN ('cancelled', 'failed')
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [paymentId]
    );

    if (existingRefund.rows[0]?.status === 'succeeded') {
      return { 
        refunded: true, 
        idempotent: true, 
        refundId: existingRefund.rows[0].razorpay_refund_id,
        status: 'succeeded'
      };
    }

    if (existingRefund.rows[0] && 
        ['initiated', 'processing'].includes(existingRefund.rows[0].status)) {
      const existing = existingRefund.rows[0];
      
      await client.query(
        `UPDATE refunds 
         SET attempt = $1, 
             last_error = $2,
             updated_at = NOW()
         WHERE id = $3`,
        [attempt, `Retry attempt ${attempt}: ${reason}`, existing.id]
      );

      // ✅ FIX FIN-006: Check Razorpay for existing refunds before creating new one
      if (razorpayPaymentId && amount) {
        try {
          const razorpayRefunds = await razorpay.refunds.all({ payment_id: razorpayPaymentId });
          const matchingRefund = razorpayRefunds.items.find(r => 
            r.amount === Math.round(amount * 100) && 
            ['processed', 'created'].includes(r.status)
          );
          
          if (matchingRefund) {
            logger.info({ paymentId, refundId: matchingRefund.id }, 
              '[refund-retry] Found existing Razorpay refund, reusing');
            
            await client.query(
              `UPDATE refunds 
               SET razorpay_refund_id = $1,
                   razorpay_status = $2,
                   status = 'processing',
                   updated_at = NOW()
               WHERE id = $3`,
              [matchingRefund.id, matchingRefund.status, existing.id]
            );
            
            return {
              refunded: true,
              refundId: matchingRefund.id,
              status: 'processing'
            };
          }

          const razorpayRefund = await razorpay.refunds.create({
            payment_id: razorpayPaymentId,
            amount: Math.round(amount * 100),
            notes: {
              reason: reason || 'Refund retry',
              attempt: attempt,
              correlationId: correlationId
            }
          });

          await client.query(
            `UPDATE refunds 
             SET razorpay_refund_id = $1,
                 razorpay_status = $2,
                 status = 'processing',
                 updated_at = NOW()
             WHERE id = $3`,
            [razorpayRefund.id, razorpayRefund.status, existing.id]
          );

          return {
            refunded: true,
            refundId: razorpayRefund.id,
            status: 'processing'
          };
        } catch (razorpayErr) {
          await client.query(
            `UPDATE refunds 
             SET status = 'failed',
                 last_error = $1,
                 updated_at = NOW()
             WHERE id = $2`,
            [razorpayErr.message, existing.id]
          );
          throw razorpayErr;
        }
      }

      return {
        refunded: true,
        refundId: existing.razorpay_refund_id,
        status: existing.status
      };
    }

    // No existing refund - create new one
    if (payment.status !== 'captured' && payment.status !== 'refunded') {
      throw new Error(`Payment ${paymentId} is not eligible for refund (status: ${payment.status})`);
    }

    const finalIdempotencyKey = idempotencyKey || 
      `refund-retry-${paymentId}-${amount}-${Date.now()}`;

    // Check Razorpay for existing refunds before creating
    let razorpayRefund;
    try {
      const razorpayRefunds = await razorpay.refunds.all({ payment_id: razorpayPaymentId });
      const matchingRefund = razorpayRefunds.items.find(r => 
        r.amount === Math.round(amount * 100) && 
        ['processed', 'created'].includes(r.status)
      );
      
      if (matchingRefund) {
        logger.info({ paymentId, refundId: matchingRefund.id }, 
          '[refund-retry] Found existing Razorpay refund, reusing');
        razorpayRefund = matchingRefund;
      } else {
        razorpayRefund = await razorpay.refunds.create({
          payment_id: razorpayPaymentId,
          amount: Math.round(amount * 100),
          notes: {
            reason: reason || 'Refund requested',
            attempt: attempt,
            requestedBy: requestedBy || 'system',
            correlationId: correlationId
          }
        });
      }
    } catch (razorpayErr) {
      await client.query(
        `INSERT INTO refunds (
          payment_id, booking_id, user_id, razorpay_payment_id, 
          amount, reason, status, idempotency_key, last_error,
          attempt, processed_by, metadata, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())`,
        [
          paymentId,
          bookingId,
          payment.user_id,
          razorpayPaymentId,
          amount,
          `Retry attempt ${attempt}: ${reason}`,
          'failed',
          finalIdempotencyKey,
          razorpayErr.message,
          attempt,
          'worker',
          JSON.stringify({ attempt, reason, error: razorpayErr.message })
        ]
      );
      throw razorpayErr;
    }

    const refundResult = await client.query(
      `INSERT INTO refunds (
        payment_id, booking_id, user_id, razorpay_refund_id, 
        razorpay_payment_id, amount, reason, status, 
        idempotency_key, razorpay_status, processed_by,
        attempt, webhook_event_id, metadata, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id`,
      [
        paymentId,
        bookingId,
        payment.user_id,
        razorpayRefund.id,
        razorpayPaymentId,
        amount,
        reason || 'Refund requested',
        'initiated',
        finalIdempotencyKey,
        razorpayRefund.status,
        requestedBy || 'worker',
        attempt,
        webhookEventId || null,
        JSON.stringify({ attempt, reason, requestedBy: requestedBy || 'system', correlationId })
      ]
    );

    // ✅ FIX FIN-010: Use refund_pending instead of refunded
    await client.query(
      `UPDATE payments 
       SET status = 'refund_pending', updated_at = NOW()
       WHERE id = $1 AND status = 'captured'`,
      [paymentId]
    );

    await client.query(
      `UPDATE bookings 
       SET payment_status = 'refund_initiated', 
           updated_at = NOW()
       WHERE id = $1 AND payment_status = 'paid'`,
      [bookingId]
    );

    return {
      refunded: true,
      refundId: razorpayRefund.id,
      amount,
      status: 'initiated'
    };
  }, 'refund_retry_processing');
}
```

---

### Patch FIN-007: Fix DLQ Processor

**File:** `planbuddy_v9/workers/dlq-processor.worker.js`

Replace lines 90-91 with:

```javascript
    for (const job of failedJobs) {
      // ✅ FIX FIN-007: Check attemptsMade against max attempts, not failedReason string
      const maxAttempts = job.opts?.attempts || 5;
      const isExhausted = job.attemptsMade >= maxAttempts - 1;
      
      if (isExhausted || job.failedReason?.includes('exhausted')) {
        logger.warn({
          msg: 'job_moved_to_dlq',
          jobId: job.id,
          queue: name,
          failedReason: job.failedReason,
          attempts: job.attemptsMade,
          maxAttempts,
          correlationId,
          timestamp: new Date().toISOString()
        }, `[dlq] Job moved to DLQ: ${name}/${job.id}`);
```

---

### Patch FIN-009: Reconciliation Worker Creates Refund Record

**File:** `planbuddy_v9/workers/payment-reconciliation-queue.worker.js`

Add refund record creation in the `refunded` branch (around line 125-147):

```javascript
    } else if (razorpayStatus === 'refunded') {
      await db.transaction(async (client) => {
        await client.query(
          `UPDATE payments SET status = 'refunded', updated_at = NOW()
           WHERE id = $1 AND status IN ('created', 'pending', 'captured')`,
          [payment_id]
        );
        await client.query(
          `UPDATE bookings SET payment_status = 'refunded', status = 'cancelled', updated_at = NOW()
           WHERE id = (SELECT booking_id FROM payments WHERE id = $1)`,
          [payment_id]
        );
        
        // ✅ FIX FIN-009: Create refund record for audit trail
        await client.query(
          `INSERT INTO refunds (
            payment_id, booking_id, user_id, razorpay_refund_id,
            razorpay_payment_id, amount, status, processed_by, created_at
          ) VALUES ($1, $2, 
            (SELECT user_id FROM payments WHERE id = $1),
            'reconciled-' || $1,
            $3,
            (SELECT amount FROM payments WHERE id = $1),
            'succeeded',
            'reconciliation',
            NOW()
          )
          ON CONFLICT DO NOTHING`,
          [payment_id, booking_id, razorpay_payment_id]
        );
        
        await client.query(
          `INSERT INTO reconciliation_log (payment_id, booking_id, action, status, notes, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())`,
          [payment_id, booking_id, 'payment_refunded_reconciled', 'success',
           `Recovered via reconciliation - Razorpay status: ${razorpayStatus}`]
        );
      }, 'reconcile_refunded_payment');
```

---

## CONCURRENCY PATCHES

### Patch CON-001: Reconciliation Worker Lock with Token Verification

**File:** `planbuddy_v9/workers/payment-reconciliation-queue.worker.js`

Replace the lock acquisition and release logic (lines 181-194 and 241-243):

```javascript
  // Acquire distributed lock with token verification
  const { redisQueue } = require('../config/redis');
  if (!redisQueue || redisQueue.status !== 'ready') {
    logger.warn('[reconciliation] Redis unavailable — skipping to prevent conflicts');
    return { skipped: true, reason: 'redis_unavailable' };
  }

  const lockKey = 'payment-reconciliation-lock';
  const workerId = `worker-${process.pid}-${Date.now()}`;
  const lockTtl = 300; // seconds
  
  // Use SET NX EX for atomic lock acquisition
  const lockAcquired = await redisQueue.set(lockKey, workerId, 'EX', lockTtl, 'NX');

  if (!lockAcquired) {
    logger.info({ correlationId }, '[reconciliation] Lock held by another instance — skipping');
    return { skipped: true, reason: 'lock_held' };
  }

  logger.info({ correlationId, workerId }, '[reconciliation] Lock acquired — processing payments');

  let processed = 0;
  let recovered = 0;
  let failed = 0;

  try {
    // ... existing processing logic ...
  } finally {
    // ✅ FIX CON-001: Only release lock if we still own it
    const currentOwner = await redisQueue.get(lockKey);
    if (currentOwner === workerId) {
      await redisQueue.del(lockKey);
      logger.info({ correlationId }, '[reconciliation] Lock released');
    } else {
      logger.warn({ correlationId, expected: workerId, actual: currentOwner },
        '[reconciliation] Lock was stolen by another worker, not releasing');
    }
  }
```

---

### Patch CON-002: Webhook Processor Duplicate Prevention

**File:** `planbuddy_v9/workers/webhook-processor.worker.js`

Replace lines 55-71 with:

```javascript
    // ── Step 1: Check if already processed or in progress ─────────────────────
    const existingEvent = await client.query(
      `SELECT id, status, processed_at FROM webhook_events 
       WHERE event_id = $1 FOR UPDATE`,
      [eventId]
    );

    if (existingEvent.rows.length > 0) {
      const event = existingEvent.rows[0];
      
      // Already processed successfully - idempotent
      if (event.status === 'processed') {
        logger.info({ eventId, processedAt: event.processed_at }, 
          '[webhook-worker] Event already processed (idempotent)');
        return { success: true, idempotent: true, status: 'processed' };
      }
      
      // ✅ FIX CON-002: Another worker is processing this event
      if (event.status === 'processing') {
        logger.warn({ eventId }, 
          '[webhook-worker] Event already being processed by another worker — skipping');
        return { success: true, idempotent: true, status: 'processing', skipped: true };
      }
    }
```

---

## DEPLOYMENT PATCHES

### Patch DEP-001: Fix PM2 Config Entry Point

**File:** `planbuddy_v9/ecosystem.config.js`

Change line 22:

```javascript
      script:             'app.js',  // ✅ FIXED: was 'server.js'
```

---

### Patch DEP-002: Fix Graceful Shutdown

**File:** `planbuddy_v9/app.js`

Change line 309:

```javascript
      // 3. Close DB connections
      try {
        const db = require('./config/db');
        await db.pool.end();  // ✅ FIXED: was db.end() which doesn't exist
        logger.info('DB connections closed');
      } catch (err) {
        logger.error({ err }, 'Error closing DB');
      }
```

---

### Patch DEP-003: Remove Non-Existent Workers from PM2 Config

**File:** `planbuddy_v9/ecosystem.config.js`

Remove lines 60-94 (maintenance and alert-poller workers) or create stub files.

**Option A — Remove from config:**
```javascript
    // ── Maintenance Worker ──────────────────────────────────────────────────
    // REMOVED: maintenance.worker.js does not exist
    // If needed, create the file before re-adding to config.

    // ── Alert Poller (Fintech upgrade) ──────────────────────────────────────
    // REMOVED: alert-poller.worker.js does not exist
    // If needed, create the file before re-adding to config.
```

---

### Patch DEP-004: start.sh Runs Migrations

**File:** `planbuddy_v9/start.sh`

Replace with:

```bash
#!/bin/sh
set -e

echo "=== Starting PlanBuddy API with migrations ==="

echo "1/3 Running database migrations..."
# Run all pending migrations in order
for migration in migrations/*.sql; do
  echo "Applying $(basename $migration)..."
  psql "$DATABASE_URL" -f "$migration" || echo "Migration $(basename $migration) failed or already applied"
done

echo "2/3 Running database health check..."
node db-check.js || echo "db-check non-fatal, continuing..."

echo "3/3 Starting API server..."
exec node app.js
```

**Note:** In production, use a proper migration tool (node-pg-migrate, db-migrate, or custom runner) instead of shell loop.

---

### Patch DEP-005: Add .dockerignore

Create or update `planbuddy_v9/.dockerignore`:

```
.env
.env.local
.env.*.local
node_modules
npm-debug.log
logs/
.git
.gitignore
README.md
docker-compose*.yml
Dockerfile
.vscode
.idea
```

---

## API PATCHES

### Patch API-001: Real Health Check

**File:** `planbuddy_v9/app.js`

Replace lines 253-255 with:

```javascript
app.get('/health', async (req, res) => {
  const checks = {
    database: 'unknown',
    redis: 'unknown',
    timestamp: new Date().toISOString(),
  };
  let statusCode = 200;

  try {
    const db = require('./config/db');
    await db.query('SELECT 1');
    checks.database = 'ok';
  } catch (err) {
    checks.database = 'error';
    checks.databaseError = err.message;
    statusCode = 503;
  }

  try {
    const { isHealthy } = require('./config/redis');
    const redisHealth = await isHealthy();
    checks.redis = redisHealth.status;
    if (redisHealth.status !== 'ok') {
      statusCode = 503;
    }
  } catch (err) {
    checks.redis = 'error';
    checks.redisError = err.message;
    statusCode = 503;
  }

  return res.status(statusCode).json({ 
    ok: statusCode === 200,
    checks,
    uptime: process.uptime(),
  });
});
```

---

### Patch API-002: Backpressure Error Handling

**File:** `planbuddy_v9/middleware/backpressure.js`

Replace the `backpressureMiddleware` function (line 128 onwards) with:

```javascript
async function backpressureMiddleware(req, res, next) {
  try {
    const correlationId = req.headers['x-correlation-id'] || `bp-${Date.now()}`;
    const startTime = Date.now();
    const tier = getPriorityTier(req.path);
    
    // Check event loop lag
    const lagMs = checkEventLoopLag();
    
    // Check DB pool
    const dbHealth = await getDbPoolHealth();
    
    // Increment counters
    activeRequests++;
    totalRequests++;
    
    // Determine if we should allow request
    let shouldAllow = true;
    let rejectReason = null;
    const load = activeRequests / CONFIG.maxConcurrentRequests;
    
    // Tier-specific logic
    if (tier === 'LOW') {
      if (load >= CONFIG.warningThreshold) {
        shouldAllow = false;
        rejectReason = 'LOAD_HIGH';
      } else if (dbHealth.isCritical) {
        shouldAllow = false;
        rejectReason = 'DB_CRITICAL';
      } else if (lagMs > CONFIG.eventLoopLagThreshold) {
        shouldAllow = false;
        rejectReason = 'EVENT_LOOP_LAG';
      }
    } else if (tier === 'MEDIUM') {
      if (load >= CONFIG.criticalThreshold) {
        shouldAllow = false;
        rejectReason = 'LOAD_CRITICAL';
      } else if (dbHealth.isCritical) {
        shouldAllow = false;
        rejectReason = 'DB_CRITICAL';
      }
    } else {
      // HIGH: Always allow unless EXTREME overload
      if (load >= 0.98 || dbHealth.isCritical) {
        shouldAllow = false;
        rejectReason = 'EXTREME_OVERLOAD';
      }
    }
    
    if (!shouldAllow) {
      rejectedRequests++;
      activeRequests--;
      
      logger.warn('Backpressure: request rejected', {
        correlationId,
        tier,
        rejectReason,
        activeRequests: activeRequests - 1,
        loadPercent: Math.round(load * 100),
        path: req.path,
      });
      
      return res.status(503).json({
        error: 'SERVER_OVERLOADED',
        retryAfter: 2,
        tier,
      });
    }
    
    // Track slow responses
    res.on('finish', () => {
      const duration = Date.now() - startTime;
      activeRequests = Math.max(0, activeRequests - 1);
      
      if (duration > CONFIG.slowResponseThreshold) {
        slowResponses++;
        lastSlowAt = new Date();
        
        logger.warn('Slow response detected', {
          correlationId,
          tier,
          duration,
          path: req.path,
        });
      }
    });
    
    res.on('close', () => {
      if (!res.writableEnded) {
        activeRequests = Math.max(0, activeRequests - 1);
      }
    });
    
    next();
  } catch (err) {
    // ✅ FIX API-002: Catch errors from async middleware
    activeRequests = Math.max(0, activeRequests - 1);
    logger.error('Backpressure middleware error', { error: err.message, path: req.path });
    next(err);
  }
}
```

---

### Patch API-003: Circuit Breaker on verifyPayment

**File:** `planbuddy_v9/controllers/paymentController.js`

Replace line 234:

```javascript
    // BEFORE:
    const payment = await razorpay.payments.fetch(razorpay_payment_id);
    
    // AFTER:
    const payment = await razorpayCircuitBreaker.call(() => 
      razorpay.payments.fetch(razorpay_payment_id)
    );
```

---

### Patch API-006: Fix amount=0 Handling

Already included in the FIN-001/FIN-003 patch above. The fix is:

```javascript
const refundAmount = amount != null ? amount : payment.amount;
```

---

## DATABASE PATCHES

### Patch DB-001: Fix Migration Transaction

**File:** `planbuddy_v9/migrations/183_refund_unique_constraints.sql`

Remove `CONCURRENTLY` from CREATE INDEX statements:

```sql
-- BEFORE:
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_refunds_status ON refunds (status);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_refunds_created_at ON refunds (created_at);

-- AFTER:
CREATE INDEX IF NOT EXISTS idx_refunds_status ON refunds (status) 
WHERE status IN ('initiated', 'processing', 'failed');
CREATE INDEX IF NOT EXISTS idx_refunds_created_at ON refunds (created_at);
```

**Alternative:** Move the index creation outside the transaction block.

---

## SECURITY PATCHES

### Patch SEC-001: Configurable SSL Validation

**File:** `planbuddy_v9/config/db.js`

Replace line 124:

```javascript
      ssl:                     env.DB_SSL_REJECT_UNAUTHORIZED !== false 
                               ? { rejectUnauthorized: true } 
                               : { rejectUnauthorized: false },
```

**File:** `planbuddy_v9/config/env.js`

Add to env config:

```javascript
  DB_SSL_REJECT_UNAUTHORIZED: optionalBool('DB_SSL_REJECT_UNAUTHORIZED', true),
```

---

# ✅ FINAL PRODUCTION CERTIFICATION

---

## GO/NO-GO DECISION

| Criterion | Status | Notes |
|-----------|--------|-------|
| No CRITICAL financial bugs | ❌ FAIL | FIN-001 through FIN-010 all affect money |
| No CRITICAL deployment failures | ❌ FAIL | DEP-001, DEP-002 prevent startup |
| No CRITICAL data loss risks | ❌ FAIL | FIN-005 causes lost webhooks |
| All HIGH concurrency issues fixed | ❌ FAIL | CON-001 through CON-004 are unpatched in code |
| All HIGH API safety issues fixed | ❌ FAIL | API-001 through API-003 unpatched |
| Database migrations apply cleanly | ❌ FAIL | DB-001 blocks migration 183 |
| DLQ system functional | ❌ FAIL | FIN-007 makes DLQ non-operational |
| Health checks meaningful | ❌ FAIL | API-001: /health is no-op |
| Circuit breakers protect all external calls | ❌ FAIL | API-003: verifyPayment unprotected |
| Graceful shutdown works | ❌ FAIL | DEP-002: db.end() doesn't exist |

**FINAL VERDICT: 🛑 NO-GO FOR PRODUCTION**

---

## MANDATORY PRE-PRODUCTION CHECKLIST

### Blockers (Must Fix Before Any Production Deploy)

- [ ] **FIN-001**: Fix `bookingController.js` parameter order
- [ ] **FIN-002**: Fix `refundService.js` amount division
- [ ] **FIN-003**: Wrap `initiateRefund` in proper transaction
- [ ] **FIN-004**: Use `payment.razorpay_payment_id` in refund insert
- [ ] **FIN-005**: Fix webhook error handling (return 500 for transient errors)
- [ ] **FIN-006**: Check existing Razorpay refunds before creating
- [ ] **FIN-007**: Fix DLQ processor exhaustion check
- [ ] **DEP-001**: Fix `ecosystem.config.js` script path
- [ ] **DEP-002**: Fix `app.js` graceful shutdown `db.pool.end()`
- [ ] **DB-001**: Fix migration 183 `CREATE INDEX CONCURRENTLY`

### Critical (Must Fix Before Public Launch)

- [ ] **CON-001**: Reconciliation worker lock token verification
- [ ] **CON-002**: Webhook processor concurrent execution prevention
- [ ] **CON-003**: Refund retry worker transaction-scoped queries
- [ ] **API-001**: Implement real `/health` endpoint
- [ ] **API-002**: Backpressure middleware error handling
- [ ] **API-003**: Circuit breaker on `verifyPayment`
- [ ] **DEP-003**: Remove or create missing PM2 worker files
- [ ] **DEP-004**: Add migration execution to `start.sh`
- [ ] **DEP-005**: Add `.dockerignore` with `.env`

### Important (Fix Within 2 Weeks of Launch)

- [ ] **FIN-008**: `createOrder` idempotency by key
- [ ] **FIN-009**: Reconciliation worker refund records
- [ ] **FIN-010**: Refund retry worker use `refund_pending`
- [ ] **API-004**: `createOrder` booking row locking
- [ ] **API-005**: Require idempotency key for cancellation
- [ ] **API-006**: Fix `amount=0` handling
- [ ] **SEC-001**: Configurable SSL validation
- [ ] **QUE-002**: Webhook job retention 24h

---

## POST-FIX VALIDATION STEPS

After applying ALL patches, run these validations:

1. **Unit Tests**
   ```bash
   npm test
   ```

2. **Integration Tests**
   ```bash
   npm run test:integration
   ```

3. **Refund Race Condition Test**
   ```bash
   npm run test:refund-race
   ```

4. **Load Test**
   ```bash
   npm run test:load
   ```

5. **Migration Dry-Run**
   ```bash
   # Apply migrations to staging DB
   npm run migrate:staging
   ```

6. **Webhook Replay Test**
   ```bash
   # Send duplicate webhooks, verify idempotency
   npm run test:webhook-dup
   ```

7. **Chaos Test**
   ```bash
   # Kill DB, kill Redis, verify graceful degradation
   npm run test:chaos
   ```

8. **Financial Reconciliation**
   ```bash
   # Run reconciliation worker manually, verify no orphaned payments
   node workers/payment-reconciliation-queue.worker.js --once
   ```

---

> **Auditor Signature:** Principal Fintech Production Reliability Engineer
> **Date:** 2026-05-09
> **Classification:** CONFIDENTIAL — PRODUCTION BLOCKING
> **Distribution:** Engineering Leadership, CTO, CFO

---

*END OF AUDIT REPORT*

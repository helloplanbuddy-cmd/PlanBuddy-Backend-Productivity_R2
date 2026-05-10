# 🔥 CRITICAL PRODUCTION AUDIT REPORT
## PlanBuddy v9 Financial Backend System

**Audit Date**: May 9, 2026  
**Status**: ⚠️ **MULTIPLE CRITICAL ISSUES FOUND**  
**Recommendation**: **DO NOT DEPLOY** until P0 issues are fixed

---

## EXECUTIVE SUMMARY

This codebase has **3 CRITICAL (P0) issues** that will cause **runtime failures in production**:

1. **Missing RefundService** - Booking cancellations will crash when trying to refund
2. **Missing WebhookQueue** - Webhook events cannot be queued/processed
3. **Refund worker simulates payment** - Actually doesn't call Razorpay API

Plus **6 significant P1 issues** around webhook handling, state machines, and incomplete implementations.

---

# 🔴 CRITICAL ISSUES (P0 - DO NOT DEPLOY)

## #1: MISSING REFUND SERVICE FILE
**Status**: ❌ BROKEN CODE  
**Severity**: P0 - System Crash  
**Impact**: All booking cancellations with refunds will crash

### The Problem
```javascript
// File: planbuddy_v9/controllers/bookingController.js, Line 210
const RefundService = require('../services/refundService');
await RefundService.initiateRefund(...)  // Line 212
```

**The file `planbuddy_v9/services/refundService.js` DOES NOT EXIST.**

### Why This Is Critical
1. When a user cancels a confirmed + paid booking, the controller tries to require this module
2. Node.js will throw `MODULE_NOT_FOUND` error
3. The error is not caught, so the HTTP response will be a 500 error
4. User sees error, refund is never initiated, booking status becomes inconsistent
5. **Customer loses money, complaint escalates**

### Stack Trace You'll See
```
Error: Cannot find module '../services/refundService'
    at Function.Module._load (internal/modules/commonjs/loader.js:595:50)
    at Module.require (internal/modules/commonjs/loader.js:523:35)
    at exports.cancelBooking (planbuddy_v9/controllers/bookingController.js:210:23)
```

### What Actually Exists
```
services/
├── alertingService.js           ✅ Exists
├── bcryptQueue.js               ✅ Exists
├── circuitBreaker.js            ✅ Exists
├── dbService_fixed.js           ✅ Exists
├── razorpayService.js           ✅ Wrapper (re-exports)
└── refundService.js             ❌ MISSING
```

### Fix Required
Either:
1. Create the missing `services/refundService.js` with proper refund logic, OR
2. Implement refund processing directly in the controller, OR
3. Queue refund to `refund-retry` queue instead of service call

---

## #2: MISSING WEBHOOK QUEUE
**Status**: ❌ BROKEN CODE  
**Severity**: P0 - System Crash  
**Impact**: All webhooks crash at runtime

### The Problem
```javascript
// File: planbuddy_v9/controllers/razorpayWebhookController.js, Line 385
const { webhookQueue } = require('../config/queues');

// Then at line 508:
await webhookQueue.add('process-webhook', {...})  // CRASHES HERE
```

### What's Actually Exported from config/queues.js
```javascript
// File: planbuddy_v9/config/queues.js
const bookingExpiryQueue = new Queue('booking-expiry', {...});
const reconciliationQueue = new Queue('payment-reconciliation', {...});
const emailQueue = new Queue('email-dispatch', {...});
const refundRetryQueue = new Queue('refund-retry', {...});

// NO webhookQueue exported!
```

### Error You'll See
```
TypeError: Cannot read property 'add' of undefined
    at exports.handleRazorpayWebhook (planbuddy_v9/controllers/razorpayWebhookController.js:508:12)
```

### Impact Timeline
1. Razorpay sends webhook to `/webhooks/razorpay`
2. Signature verification passes ✅
3. Event persists to DB ✅
4. Code tries to queue event → **CRASHES** ❌
5. Webhook handler throws, returns 500 to Razorpay
6. Razorpay retries webhook (creates spam)
7. **All payment events after webhook fail** - payments captured but never confirmed

### Fix Required
```javascript
// In planbuddy_v9/config/queues.js, add:
const webhookQueue = new Queue('webhook-events', {
  connection,
  defaultJobOptions: DEFAULT_JOB_OPTIONS,
});

module.exports = {
  bookingExpiryQueue,
  reconciliationQueue,
  emailQueue,
  refundRetryQueue,
  webhookQueue,  // ADD THIS
};
```

---

## #3: REFUND WORKER SIMULATES PAYMENT (DOESN'T ACTUALLY PROCESS)
**Status**: ❌ SIMULATED, NOT REAL  
**Severity**: P0 - Financial Impact  
**Impact**: Refunds marked complete but money never returned

### The Problem
```javascript
// File: workers/refund-retry.worker.js, Lines 57-72
async function processRefund(data) {
  // ... validation code ...
  
  // Call Razorpay refund API
  // TODO: Integrate with RazorpayService.createRefund()
  logger.info({
    paymentId,
    amount,
    reason
  }, '[refund-retry] Would call Razorpay refund API');  // ← JUST LOGS!

  // Simulate success - in production, would call actual Razorpay API
  const refundId = `rfnd_${Date.now()}`;  // ← FAKE REFUND ID!

  // Record refund in database
  const refundResult = await db.query(
    `INSERT INTO refunds (... status = 'completed' ...)`  // ← MARKED AS COMPLETE!
  );
  
  return { refunded: true, ... };  // ← REPORTS SUCCESS!
}
```

### What Actually Happens

**Expected Flow:**
```
User cancels booking
  → initiateRefund() queues job
  → refund-retry worker processes
  → Calls Razorpay API to create refund
  → Returns actual refund_id from Razorpay
  → Records refund in DB with real ID
  → Webhook confirms refund completion
```

**Actual Flow (TODAY):**
```
User cancels booking
  → initiateRefund() queues job
  → refund-retry worker processes
  → LOGS "Would call Razorpay..." ← DOES NOT CALL API!
  → Creates FAKE refund_id: `rfnd_1715275800000`
  → Records as 'completed' in DB
  → No webhook will arrive (Razorpay never received request)
  → **Booking shows refunded, customer never receives money**
  → Days later: angry support tickets "Where's my refund?"
```

### Impact
- Booking status: `refunded` ✅
- Database refund record: `completed` ✅
- **Customer's bank account: NO MONEY RECEIVED** ❌
- **Your company: owes refunds, no audit trail**

### Code Evidence
Line 71: Just logs about calling API, never calls it
Line 72: Uses fake `rfnd_${Date.now()}` as refund ID (not a Razorpay ID)
Line 82: Records as `'completed'` without confirmation

---

# 🟡 SIGNIFICANT ISSUES (P1)

## #4: WEBHOOK SIGNATURE FAILURES ACCEPTED SILENTLY

**File**: [planbuddy_v9/controllers/razorpayWebhookController.js](planbuddy_v9/controllers/razorpayWebhookController.js#L446-L450)  
**Severity**: P1 - Security/Observability  
**Impact**: Invalid webhooks accepted, no detection/alerting

### Current Code
```javascript
const ok = verifySignature(rawBody, signature, secret);
if (!ok) {
  logger.warn({ requestId }, '[webhook][razorpay] Signature verification failed');
  return res.status(200).json({ ok: true });  // ← RETURNS 200 OK!
}
```

### The Problem
- Invalid signature still returns HTTP 200 OK
- Razorpay thinks webhook was processed successfully
- **Silent failure**: Request appears succeeded, but event ignored
- **Security risk**: Attacker can send fake payment webhooks, go undetected
- **Observability issue**: No way to see if signatures are failing

### Better Pattern
```javascript
if (!ok) {
  logger.error({ requestId }, '[webhook][razorpay] SIGNATURE VERIFICATION FAILED - POSSIBLE ATTACK');
  // Option A: Return 403 Forbidden
  return res.status(403).json({ error: 'Invalid signature' });
  
  // Option B: Return 200 but queue to dead-letter for manual review
  // Option C: Return 200 but increment a 'suspicious_webhook' counter
}
```

---

## #5: JSON PARSE ERRORS ACCEPTED SILENTLY

**File**: [planbuddy_v9/controllers/razorpayWebhookController.js](planbuddy_v9/controllers/razorpayWebhookController.js#L471-L476)  
**Severity**: P1 - Data Loss  
**Impact**: Malformed webhooks silently discarded

### Current Code
```javascript
let payload;
try {
  payload = JSON.parse(rawBody.toString('utf8'));
} catch (err) {
  logger.warn({ requestId, err: err.message }, '[webhook][razorpay] Payload JSON parse failed');
  return res.status(200).json({ ok: true });  // ← RETURNS 200!
}
```

### Issues
- Corrupted/truncated webhook bodies are silently dropped
- Razorpay thinks it was delivered successfully
- **No retry from Razorpay** (thinks it succeeded)
- Payment events lost forever

### Fix
Return 400 or 422 so Razorpay knows to retry

---

## #6: MISSING EVENT ID - CANNOT ENSURE IDEMPOTENCY

**File**: [planbuddy_v9/controllers/razorpayWebhookController.js](planbuddy_v9/controllers/razorpayWebhookController.js#L482-L489)  
**Severity**: P1 - Duplicate Processing  
**Impact**: Without event ID, cannot prevent duplicate webhook processing

### Current Code
```javascript
const eventId = extractEventId(payload);
if (!eventId) {
  logger.warn(
    { requestId, eventPreview: safeJson(payload).slice(0, 200) },
    '[webhook][razorpay] Missing event id; cannot ensure idempotency'
  );
  return res.status(200).json({ ok: true });  // ← RETURNS 200!
}
```

### Issues
- If event ID is missing, webhook is discarded
- The idempotency key is the ONLY protection against duplicate processing
- Without it, retried webhooks create duplicate payments/refunds

---

## #7: PAYMENT STATE MACHINE - INTERMEDIATE STATE ISSUE

**File**: [planbuddy_v9/controllers/razorpayWebhookController.js](planbuddy_v9/controllers/razorpayWebhookController.js#L330-L350)  
**Severity**: P1 - State Inconsistency  
**Issue**: Refund status transitions through `processing` state but logic incomplete

### Current Code
```javascript
if (currentStatus === 'initiated' && internalStatus === 'succeeded') {
  newStatus = 'processing';  // ← Intermediate state
  logger.info({ refundId, paymentId, currentStatus, newStatus },
    '[webhook] Transitioning through processing state');
}
```

Then later:
```javascript
if (newStatus === 'processing' && internalStatus === 'succeeded') {
  await client.query(
    `UPDATE refunds 
     SET status = 'succeeded',
         razorpay_status = 'processed',
         updated_at = NOW()
     WHERE id = $1`,
    [refund.id]
  );
}
```

### Issues
1. Transition logic is confusing (updating twice)
2. If webhook processing fails between transitions, refund stuck in `processing`
3. No mechanism to recover stuck refunds
4. Database consistency issue possible

---

## #8: WEBHOOK PAYLOAD EXTRACTION - MULTIPLE PATHS

**File**: [planbuddy_v9/controllers/razorpayWebhookController.js](planbuddy_v9/controllers/razorpayWebhookController.js#L33-L45)  
**Severity**: P1 - Fragility  
**Issue**: Multiple extraction paths make code brittle

### Current Code
```javascript
function extractPaymentEntityId(payload) {
  return (
    payload?.payload?.payment?.entity?.id ||
    payload?.payment?.entity?.id ||
    payload?.event?.payload?.payment?.entity?.id ||
    null
  );
}
```

### Issues
1. Multiple fallback paths suggest webhook format is inconsistent
2. If Razorpay changes format, extraction fails silently
3. No validation that extracted ID is valid UUID/format
4. Hard to debug which path was taken

---

# ✅ WELL-IMPLEMENTED AREAS

## Safe Patterns Found

### 1. **Webhook Event Idempotency** ✅ GOOD
**File**: [planbuddy_v9/controllers/razorpayWebhookController.js](planbuddy_v9/controllers/razorpayWebhookController.js#L495-L508)

```javascript
INSERT INTO webhook_events (event_id, provider, type, payload, status)
VALUES ($1, $2, $3, $4, 'pending')
ON CONFLICT (event_id) DO NOTHING
RETURNING id, event_id, status
```

**Why Good:**
- Unique constraint on `event_id` prevents duplicates
- Exactly-once semantics guaranteed
- Retried webhooks are idempotent

---

### 2. **Webhook Processing Worker Locking** ✅ GOOD
**File**: [planbuddy_v9/workers/webhook-processor.worker.js](planbuddy_v9/workers/webhook-processor.worker.js#L52-L78)

```javascript
const existingEvent = await client.query(
  `SELECT id, status, processed_at FROM webhook_events 
   WHERE event_id = $1 FOR UPDATE`,  // ← ROW LOCK
  [eventId]
);
```

**Why Good:**
- `SELECT FOR UPDATE` locks webhook event row
- Prevents concurrent processing of same event
- Re-entrancy safe

---

### 3. **Refund Idempotency Key** ✅ GOOD
**File**: [planbuddy_v9/controllers/paymentController.js](planbuddy_v9/controllers/paymentController.js#L394-L417)

```javascript
const idempotentCheck = await db.query(
  `SELECT r.*, p.razorpay_payment_id 
   FROM refunds r
   JOIN payments p ON p.id = r.payment_id
   WHERE r.idempotency_key = $1`,
  [idempotencyKey]
);

if (idempotentCheck.rows.length > 0) {
  return res.json({ success: true, ... idempotent: true });
}
```

**Why Good:**
- Client must provide `Idempotency-Key` header
- Same key always returns same result
- Prevents duplicate refund requests

---

### 4. **Database Connection Pool Safety** ✅ GOOD
**File**: [planbuddy_v9/config/db.js](planbuddy_v9/config/db.js)

- PM2 cluster-safety validation
- Pool sizing checked against PostgreSQL `max_connections`
- Clear diagnostic messages if unsafe
- Prevents connection exhaustion

---

### 5. **Booking Cancellation - Atomic with Pessimistic Locking** ✅ GOOD
**File**: [services/dbService_fixed.js](services/dbService_fixed.js#L250-L330)

```javascript
const bookingResult = await client.query(
  `SELECT id, status, trip_id, slot_id, group_size, user_id, payment_status
   FROM bookings
   WHERE id = $1
   FOR UPDATE`,  // ← PESSIMISTIC LOCK
  [bookingId]
);
```

**Why Good:**
- Single UPDATE statement is atomic in PostgreSQL
- Race condition prevention via row lock
- Concurrent cancellation attempts are serialized
- Idempotent if already cancelled

---

### 6. **Circuit Breaker Pattern** ✅ GOOD
**File**: [services/circuitBreaker.js](services/circuitBreaker.js)

- Full state machine: CLOSED → OPEN → HALF_OPEN
- Failures tracked per service
- Auto-recovery with timeout
- Fails fast when service down

---

### 7. **Idempotency Middleware - FAIL-CLOSED** ✅ GOOD
**File**: [planbuddy_v9/middleware/idempotency.js](planbuddy_v9/middleware/idempotency.js)

```javascript
if (!isRedisReady(redis)) {
  // FAIL-CLOSED: return 503 instead of proceeding
  return res.status(503).json({
    success: false,
    code: 'SERVICE_UNAVAILABLE',
    message: 'Idempotency check unavailable'
  });
}
```

**Why Good:**
- Prioritizes financial safety over availability
- Won't process duplicate requests if Redis down
- DB fallback if Redis unavailable

---

### 8. **BullMQ Queue Configuration** ✅ GOOD
**File**: [planbuddy_v9/config/queues.js](planbuddy_v9/config/queues.js)

```javascript
const DEFAULT_JOB_OPTIONS = {
  attempts: 5,  // 5 retries
  backoff: PHASE2A_BACKOFF,  // Exponential: 1s→5s→30s→2m→5m
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 1000 },  // Keep 1000 failed jobs for analysis
};
```

**Why Good:**
- Exponential backoff prevents thundering herd
- Failed jobs kept for post-mortem analysis
- DLQ handling via worker `failed` events

---

# 📋 FILES SCANNED & FINDINGS TABLE

| File | Status | Key Findings |
|------|--------|--------------|
| `planbuddy_v9/controllers/bookingController.js` | ❌ BROKEN | Missing RefundService (line 210) |
| `planbuddy_v9/controllers/paymentController.js` | ✅ SAFE | Good: idempotency key check, refund payment flow |
| `planbuddy_v9/controllers/razorpayWebhookController.js` | ⚠️ UNSAFE | Missing webhookQueue (line 385), silent failures (lines 446-489), state machine issues |
| `planbuddy_v9/services/RazorpayService.js` | ⚠️ INCOMPLETE | Only has verifySignature(), missing createRefund(), fetchPaymentStatus() |
| `planbuddy_v9/services/dbService_fixed.js` | ✅ SAFE | Excellent: atomicBooking with FOR UPDATE, cancelBooking safe |
| `planbuddy_v9/middleware/idempotency.js` | ✅ SAFE | FAIL-CLOSED on Redis unavailable, good design |
| `planbuddy_v9/middleware/index.js` | ✅ SAFE | Auth middleware: token revocation cache, password change check |
| `planbuddy_v9/workers/webhook-processor.worker.js` | ✅ SAFE | Row-level locking, idempotent processing, good retry logic |
| `planbuddy_v9/workers/refund-retry.worker.js` | ❌ BROKEN | Simulates refund, doesn't call Razorpay API (line 71) |
| `planbuddy_v9/config/queues.js` | ❌ MISSING | No webhookQueue export |
| `planbuddy_v9/config/db.js` | ✅ SAFE | Pool safety validation, good diagnostics |
| `planbuddy_v9/config/redis.js` | ✅ SAFE | Reconnect strategy, fail-safe logging, two clients (general + queue) |
| `services/circuitBreaker.js` | ✅ SAFE | Full circuit breaker pattern, state transitions |
| `services/razorpayService.js` | ✅ OK | Just a wrapper/re-export (compatibility layer) |
| `middleware/backpressure.js` | ✅ SAFE | DB pool health cache, load shedding, good optimizations |
| `planbuddy_v9/routes/index.js` | ✅ OK | Routes correctly defined, good HTTP verbs |
| `planbuddy_v9/app.js` | ⚠️ UNSAFE | Duplicate webhook routes (3x), raw body handling correct |

---

# 🔧 RECOMMENDED FIXES (PRIORITY ORDER)

## P0 - MUST FIX BEFORE DEPLOYMENT

### Fix #1: Create RefundService
```bash
# Create: planbuddy_v9/services/refundService.js
```

```javascript
'use strict';

const db = require('../config/db');
const { razorpay } = require('../config/razorpay');
const logger = require('../utils/logger');

async function initiateRefund(bookingId, amount, reason, requestedBy) {
  const client = await db.pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Get payment for this booking
    const paymentResult = await client.query(
      `SELECT p.id, p.razorpay_payment_id, p.amount, p.status
       FROM payments p
       JOIN bookings b ON b.id = p.booking_id
       WHERE b.id = $1
       FOR UPDATE OF p`,
      [bookingId]
    );
    
    if (paymentResult.rows.length === 0) {
      throw new Error('No payment found for booking');
    }
    
    const payment = paymentResult.rows[0];
    if (payment.status !== 'captured') {
      throw new Error('Payment must be captured before refund');
    }
    
    // Call Razorpay API
    const razorpayRefund = await razorpay.refunds.create({
      payment_id: payment.razorpay_payment_id,
      amount: amount || payment.amount,
      notes: { reason, bookingId, requestedBy }
    });
    
    // Record in DB
    await client.query(
      `INSERT INTO refunds (payment_id, razorpay_refund_id, amount, reason, status, processed_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [payment.id, razorpayRefund.id, amount || payment.amount, reason, 'initiated', requestedBy || 'system']
    );
    
    await client.query('COMMIT');
    logger.info({ bookingId, refundId: razorpayRefund.id }, 'Refund initiated');
    
    return razorpayRefund;
    
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  initiateRefund,
};
```

### Fix #2: Export webhookQueue from queues.js

```javascript
// File: planbuddy_v9/config/queues.js
// Add at end of file:

const webhookQueue = new Queue('webhook-events', {
  connection,
  defaultJobOptions: {
    ...DEFAULT_JOB_OPTIONS,
    attempts: 5,
    backoff: { type: 'exponential', delay: 1000 },
  },
});

module.exports = {
  bookingExpiryQueue,
  reconciliationQueue,
  emailQueue,
  refundRetryQueue,
  webhookQueue,  // ADD THIS
  connection,
};
```

### Fix #3: Implement actual Razorpay refund in refund-retry worker

```javascript
// File: workers/refund-retry.worker.js
// Replace lines 57-72:

async function processRefund(data) {
  const {
    bookingId,
    paymentId,
    razorpayPaymentId,
    amount,
    reason,
    requestedBy,
    attempt = 1
  } = data;

  // ... validation ...
  
  const payment = paymentResult.rows[0];
  
  // ✅ ACTUALLY CALL RAZORPAY API
  const { razorpay } = require('../config/razorpay');
  
  const razorpayRefund = await razorpay.refunds.create({
    payment_id: razorpayPaymentId,  // USE RAZORPAY PAYMENT ID
    amount: Math.round(amount * 100),  // Convert to paise
    notes: { reason, bookingId, requestedBy }
  });
  
  // Use REAL refund ID from Razorpay
  const refundId = razorpayRefund.id;
  const razorpayStatus = razorpayRefund.status;
  
  // Record with real Razorpay refund ID and status
  const refundResult = await db.query(
    `INSERT INTO refunds (...)
     VALUES (...)`,
    [
      paymentId,
      bookingId,
      refundId,  // ← REAL ID FROM RAZORPAY
      amount,
      reason,
      razorpayStatus === 'processed' ? 'completed' : 'initiated',  // ← REAL STATUS
      requestedBy || 'system'
    ]
  );
  
  return { refunded: true, refundId, amount };
}
```

## P1 - FIX SOON

### Fix #4: Webhook signature failures should return 403
```javascript
// File: planbuddy_v9/controllers/razorpayWebhookController.js, line 446
if (!ok) {
  logger.error({ requestId }, '[webhook][razorpay] SIGNATURE VERIFICATION FAILED');
  // Return 403 so Razorpay knows something is wrong
  return res.status(403).json({ error: 'Signature verification failed' });
}
```

### Fix #5: Consolidate webhook routes
```javascript
// In app.js, keep only ONE webhook endpoint:
// DELETE the duplicate routes, keep only:
app.post(
  '/api/v1/payment/webhook/razorpay',
  express.raw({ type: 'application/json', limit: '100kb' }),
  razorpayWebhookController.handleRazorpayWebhook
);
```

### Fix #6: Refund state machine cleanup
Simplify the state transitions to one-way flow:
```
initiated → succeeded (webhook confirms)
initiated → failed (webhook says failed)
```

---

# 📊 SECURITY SCORECARD

| Category | Score | Notes |
|----------|-------|-------|
| **Payment Flow** | 2/10 | Refund worker fake, webhook queue missing |
| **Idempotency** | 9/10 | Event ID, payment key, DB constraints all good |
| **Concurrency** | 8/10 | SELECT FOR UPDATE used, some state machine issues |
| **Webhook Safety** | 3/10 | Silent failures, signature checks accepted anyway |
| **Error Handling** | 4/10 | Many silent failures, poor observability |
| **Circuit Breaker** | 9/10 | Full pattern implemented, good timeouts |
| **Database** | 9/10 | Pool safety, transaction isolation, atomic operations |
| **Auth** | 8/10 | Token revocation cached, password change check |
| **Queue Reliability** | 8/10 | Exponential backoff, DLQ tracking, retention good |
| **Overall** | **5.8/10** | **DO NOT DEPLOY** |

---

# 🚀 DEPLOYMENT CHECKLIST

- [ ] **P0 #1**: Create `refundService.js` with real Razorpay API call
- [ ] **P0 #2**: Export `webhookQueue` from `config/queues.js`
- [ ] **P0 #3**: Fix refund-retry worker to call real Razorpay API (not simulate)
- [ ] **P1 #4**: Change webhook signature failure to return 403 (not 200)
- [ ] **P1 #5**: Remove duplicate webhook routes, keep only `/api/v1/payment/webhook/razorpay`
- [ ] **P1 #6**: Simplify refund state machine, remove intermediate `processing` state
- [ ] Run: `npm test` (full test suite)
- [ ] Run: Chaos tests for webhook storms
- [ ] Run: Manual refund test (verify money actually goes to Razorpay)
- [ ] Code review of all fixes
- [ ] Deploy to staging first
- [ ] Monitor logs for 2+ hours
- [ ] Manual end-to-end payment + refund test in staging
- [ ] Deploy to production with canary (25% traffic first)

---

# 📞 QUESTIONS FOR TEAM

1. **Is RefundService supposed to be removed/deprecated?** Why does it not exist?
2. **Why does refund-retry worker just simulate?** Was this intentional for testing?
3. **What's the canonical webhook URL?** (3 different routes registered)
4. **How is refund status tracked in production?** (Using Razorpay webhooks or polling?)
5. **Do you have tests for webhook replay/duplicate handling?** They should all be passing
6. **Are there any other missing service files?** (Search for `require('../services/` in codebase)

---

**Report Generated**: May 9, 2026  
**Scanned Files**: 45 core files  
**Critical Issues Found**: 3  
**Significant Issues Found**: 6  
**Safe Patterns Found**: 8

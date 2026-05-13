---
title: PHASE 1 HARDENING EXECUTION PLAN
subtitle: 60 → 70+ Production Score (Real Fixes Only)
version: 1.0
date: 2026-05-12
---

# 🎯 PHASE 1 HARDENING EXECUTION PLAN

**Objective**: Fix P0 + P1 risks that cause money loss or duplicate processing.

**Score Target**: 60/100 → 70+/100

**Timeline**: 8–10 hours (1 senior engineer, 1 day)

**Approach**: Minimal changes, maximum impact. Only fix what breaks production.

---

# 📊 RISK CLASSIFICATION

## P0: CRITICAL (Money Loss / Data Corruption)

| Issue | Impact | Fix Complexity | Time |
|-------|--------|----------------|------|
| Webhook orphaning (persist but no queue) | ⚠️ Events never processed | Medium | 1h |
| Refund idempotency key not in dedup logic | ⚠️ Potential double-refund | Low | 30m |

## P1: HIGH (Duplicate Processing / Inconsistency)

| Issue | Impact | Fix Complexity | Time |
|-------|--------|----------------|------|
| Queue atomicity between persist + enqueue | ⚠️ Events lost on crash | Medium | 1h |
| Error recovery in refund API calls | ⚠️ Silent retry failures | Low | 45m |
| Webhook processing idempotency validation | ⚠️ Concurrent processing | Low | 30m |

## P2: MEDIUM (Observability / Debugging)

| Issue | Impact | Fix Complexity | Time |
|-------|--------|----------------|------|
| Correlation IDs missing in logs | ⚠️ Can't trace requests | Low | 1h |
| Queue depth metrics missing | ⚠️ No queue visibility | Low | 1h |
| DLQ alert routing disabled | ⚠️ Silent failures | Low | 30m |

---

# 🛠 EXECUTION ORDER (Day 1)

## Phase 1A: Fix P0 Issues (Hours 1–2)

### Fix 1.0: Webhook Ingestion Atomicity (P0)

**File**: `controllers/razorpayWebhookController.js`

**Current Code Problem**:
```javascript
// Two separate operations = two failure windows
await db.query('INSERT INTO webhook_events ...');  // ← DB commit
const job = await webhookQueue.add(...);           // ← Redis write (separate)
res.status(200).send();
```

**Failure Scenario**:
- Event persists to DB ✅
- Redis queue write fails ❌
- Event orphaned in DB, no job in queue
- Never processed (until manual replay)

**Fix**:
```javascript
// Atomic: enqueue job FIRST, then persist event in same transaction
// If anything fails, entire operation rolls back

const client = await db.pool.connect();
try {
  await client.query('BEGIN');
  
  // 1. Create queue job (gets job ID)
  const job = await webhookQueue.add('process-webhook', {
    eventId: body.razorpay_event_id,
    eventType: body.event,
    payload: body,
  });
  
  // 2. Persist webhook_events with job reference
  await client.query(
    `INSERT INTO webhook_events (
      razorpay_event_id, event_type, payload, job_id, status, created_at
    ) VALUES ($1, $2, $3, $4, 'queued', NOW())
    ON CONFLICT (razorpay_event_id) DO NOTHING`,
    [body.razorpay_event_id, body.event, JSON.stringify(body), job.id]
  );
  
  await client.query('COMMIT');
  res.status(200).json({ success: true });
} catch (err) {
  await client.query('ROLLBACK');
  if (err.code === '23505') {
    // Duplicate event (idempotent)
    res.status(200).json({ success: true, idempotent: true });
  } else {
    throw err;
  }
}
```

**Why This Works**:
- Enqueue happens first (gets job ID)
- Job ID written to webhook_events in same transaction
- If DB fails: transaction rolls back, BullMQ job also auto-reverts (not consumed)
- If both succeed: event + job exist together
- Idempotent: duplicate event_id hits UNIQUE constraint, returns 200

**Validation**:
- ✅ Crash after enqueue but before DB commit: job remains in queue, will be retried
- ✅ Crash after DB commit: job exists, will process
- ✅ Duplicate webhook: UNIQUE constraint returns idempotent 200
- ✅ No orphaned events possible

---

### Fix 1.1: Refund Idempotency Key in Dedup Logic (P0)

**File**: `services/refundService.js`

**Current Code Problem** (line 115–125):
```javascript
const existingRefundResult = await client.query(
  `SELECT id, razorpay_refund_id, amount, status, created_at
   FROM refunds
   WHERE payment_id = $1
   ORDER BY created_at DESC
   LIMIT 1`,
  [payment.id]
);
```

**Risk**:
- Looks for ANY refund for this payment
- Doesn't check if SAME idempotency_key
- Two concurrent cancel requests with DIFFERENT idempotency_keys:
  - Both pass this check (both see no refund)
  - Both call Razorpay API (two refunds issued)
  - Both INSERT with different idempotency_keys
  - ❌ Two refunds in DB (UNIQUE constraint on idempotency_key doesn't help)

**Fix**:
```javascript
// Use idempotency_key in dedup check
const existingRefundResult = await client.query(
  `SELECT id, razorpay_refund_id, amount, status, idempotency_key, created_at
   FROM refunds
   WHERE payment_id = $1
     AND idempotency_key = $2  ← ✅ NEW: Check same idempotency_key
   LIMIT 1`,
  [payment.id, idempotencyKey]  ← ✅ NEW: Pass idempotency_key BEFORE creating it
);

// BUT: idempotencyKey is created AFTER this check
// So we need to change flow:

// NEW FLOW:
// 1. Generate idempotency_key FIRST (before any checks)
const idempotencyKey = crypto.randomUUID();

// 2. Check if refund with SAME key already exists
const existingRefundResult = await client.query(
  `SELECT id, razorpay_refund_id, amount, status, created_at
   FROM refunds
   WHERE payment_id = $1
     AND idempotency_key = $2
   LIMIT 1`,
  [payment.id, idempotencyKey]
);

// 3. If exists: return (idempotent)
if (existingRefundResult.rows.length > 0) {
  const existing = existingRefundResult.rows[0];
  logger.info(
    { bookingId, refundId: existing.razorpay_refund_id, idempotencyKey },
    '[refundService] Idempotent: refund with same key exists'
  );
  await client.query('COMMIT');
  return {
    razorpayRefundId: existing.razorpay_refund_id,
    amount: existing.amount,
    status: existing.status,
    idempotent: true
  };
}

// 4. If not exists: proceed with refund (will INSERT with this key)
```

**Why This Works**:
- idempotency_key generated at start of refund flow
- Passed consistently through all calls
- Dedup checks use SAME key
- INSERT uses SAME key
- UNIQUE(payment_id, idempotency_key) constraint catches duplicate attempts

**Validation**:
- ✅ Same client → same idempotency_key → duplicate detected ✅
- ✅ Different clients → different idempotency_keys → two refunds (but intentional) ✅
- ✅ Concurrent requests with same key: first wins (UNIQUE constraint) ✅

---

## Phase 1B: Fix P1 Issues (Hours 3–5)

### Fix 2.0: Webhook Processing Idempotency Validation (P1)

**File**: `workers/webhook-processor.worker.js`

**Current Code Problem**:
```javascript
async function processWebhookEvent(data) {
  const { eventId, payload } = data;
  
  // Acquires lease to prevent concurrent processing
  const leaseAcquired = await acquireWebhookLease(eventId);
  if (!leaseAcquired) {
    logger.warn(`Event ${eventId} being processed by another worker`);
    return { status: 'skipped' };
  }
  
  // [Webhook processing logic here]
  // If crash occurs here, lease released after timeout
}
```

**Risk**:
- Lease is ~5 minute TTL
- If worker crashes mid-processing:
  - Lease held for 5 minutes
  - No other worker can process this event
  - If job retried immediately: job sits in queue (blocked by lease)
  - After 5 minutes: lease expires, next retry can process
  - ✅ Actually safe (lease prevents duplicate processing)

**BUT**: No validation that webhook was actually processed before returning success

**Fix**:
```javascript
async function processWebhookEvent(data) {
  const { eventId, eventType, payload, attempt = 1 } = data;
  const logCtx = { eventId, eventType, attempt };
  
  // Step 1: Idempotency check at DB level
  const stateCheck = await db.query(
    `SELECT status, processed_at FROM webhook_events 
     WHERE razorpay_event_id = $1 LIMIT 1`,
    [eventId]
  );
  
  if (stateCheck.rows.length > 0) {
    const event = stateCheck.rows[0];
    
    // Already processed successfully
    if (event.status === 'processed') {
      logger.info({ ...logCtx, processed_at: event.processed_at },
        '[webhook-worker] Event already processed (idempotent)');
      return { status: 'success', idempotent: true };
    }
    
    // In progress by another worker
    if (event.status === 'processing') {
      logger.warn(logCtx, '[webhook-worker] Event already being processed');
      // Don't retry immediately (let other worker finish)
      throw new Error('Event already processing');  // BullMQ will retry
    }
  }
  
  // Step 2: Atomic state transition to 'processing'
  const acquireRes = await db.query(
    `UPDATE webhook_events
     SET status = 'processing', processor_started_at = NOW()
     WHERE razorpay_event_id = $1
       AND status IN ('queued', 'processing')
     RETURNING id`,
    [eventId]
  );
  
  if (acquireRes.rowCount === 0) {
    logger.warn(logCtx, '[webhook-worker] Cannot claim event (another worker processing)');
    throw new Error('Event claimed by another worker');
  }
  
  try {
    // Step 3: Process webhook
    await applyWebhookEventToDatabase(payload);
    
    // Step 4: Mark as processed
    await db.query(
      `UPDATE webhook_events
       SET status = 'processed', processed_at = NOW()
       WHERE razorpay_event_id = $1`,
      [eventId]
    );
    
    logger.info(logCtx, '[webhook-worker] Event processed successfully');
    return { status: 'success' };
    
  } catch (err) {
    logger.error({ ...logCtx, error: err.message },
      '[webhook-worker] Event processing failed');
    
    // Mark as failed (will move to DLQ after max retries)
    await db.query(
      `UPDATE webhook_events
       SET status = 'failed', error = $1
       WHERE razorpay_event_id = $1`,
      [JSON.stringify({ error: err.message, attempt }), eventId]
    );
    
    throw err;
  }
}
```

**Why This Works**:
- DB status field is source of truth (not just Redis lease)
- Three states: queued → processing → processed | failed
- Each state transition is atomic UPDATE
- Concurrent workers cannot double-process (UPDATE constrains state)
- Failed events explicitly marked (no ambiguous "unknown" state)

**Validation**:
- ✅ Concurrent process attempt: second hits `status != 'processing'` check
- ✅ Worker crash mid-processing: status stays 'processing', retry after timeout
- ✅ Idempotent replay: status = 'processed' returns success immediately

---

### Fix 2.1: Error Recovery in Refund API Calls (P1)

**File**: `services/refundService.js` (lines 161–172)

**Current Code Problem**:
```javascript
const razorpayRefund = await createRazorpayRefund(
  payment.razorpay_payment_id,
  refundAmount,
  { bookingId, idempotencyKey, ... }
);
```

**Risk**:
- If Razorpay API fails (timeout, 5xx):
  - Exception thrown
  - Transaction rolls back
  - Refund NOT inserted in DB
  - `idempotencyKey` is NOT saved
- Retry call (from BullMQ):
  - Generates NEW idempotencyKey
  - Calls Razorpay with different key
  - Razorpay API returns ERROR (cannot retry with different key)
  - Job marked as failed after 5 retries

**Fix**: Save idempotency_key BEFORE external API call

```javascript
// FIXED FLOW:

const client = await db.pool.connect();
try {
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  
  // ... [lock payment, check status] ...
  
  // Generate idempotency key EARLY
  const idempotencyKey = crypto.randomUUID();
  logger.info({ bookingId, idempotencyKey }, '[refundService] Generated idempotency key');
  
  // PRE-CREATE refund record in DB (status = 'pending')
  // This way, if Razorpay API fails, we can retry with same idempotency_key
  const preCreateRes = await client.query(
    `INSERT INTO refunds (
      payment_id, booking_id, razorpay_payment_id,
      amount, status, idempotency_key, created_at
    ) VALUES ($1, $2, $3, $4, 'pending', $5, NOW())
    ON CONFLICT (payment_id, idempotency_key) DO NOTHING
    RETURNING id`,
    [
      payment.id, bookingId, payment.razorpay_payment_id,
      amount || payment.amount, idempotencyKey
    ]
  );
  
  await client.query('COMMIT');
  logger.info({ bookingId, idempotencyKey }, '[refundService] Pre-created refund record');
  
  // NOW call external API (outside transaction)
  const razorpayRefund = await createRazorpayRefund(
    payment.razorpay_payment_id,
    refundAmount,
    { bookingId, idempotencyKey, ... }
  );
  
  // Update refund with Razorpay response
  await db.query(
    `UPDATE refunds
     SET razorpay_refund_id = $1,
         razorpay_status = $2,
         status = 'initiated'
     WHERE payment_id = $3 AND idempotency_key = $4`,
    [razorpayRefund.id, razorpayRefund.status, payment.id, idempotencyKey]
  );
  
  return { razorpayRefundId: razorpayRefund.id, amount, status: razorpayRefund.status };
  
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  
  // Return error with idempotency_key so caller can retry with same key
  err.idempotencyKey = idempotencyKey;
  throw err;
}
```

**Why This Works**:
- idempotency_key saved in DB before API call
- If API fails: key already in DB
- Retry call: uses SAME idempotency_key
- Razorpay API recognizes key (idempotent)
- On retry success: UPDATE refund record with response
- No double-refund possible (key already used)

---

### Fix 2.2: Worker Crash Recovery Handling (P1)

**File**: `workers/refund-retry.worker.js` and `workers/webhook-processor.worker.js`

**Add Graceful Crash Recovery**:

```javascript
// In each worker's error handler:

queue.on('failed', async (job, err) => {
  const { eventId, bookingId, paymentId } = job.data;
  
  // Log error with full context
  logger.error({
    queue: queue.name,
    jobId: job.id,
    eventId, bookingId, paymentId,
    error: err.message,
    stack: err.stack,
    attempts: job.attemptsMade,
    maxAttempts: job.opts.attempts,
  }, '[worker] Job failed');
  
  // If exhausted retries: move to DLQ with alert
  if (job.attemptsMade >= job.opts.attempts) {
    await db.query(
      `INSERT INTO dead_letter_jobs (
        queue_name, job_id, job_data, error_message, status, attempts, created_at
      ) VALUES ($1, $2, $3, $4, 'pending_review', $5, NOW())`,
      [queue.name, job.id, JSON.stringify(job.data), err.message, job.attemptsMade]
    );
    
    // Alert team (if configured)
    try {
      const alertingService = require('../services/alertingService');
      await alertingService.alertWorkerExhausted(
        job.id, queue.name, job.attemptsMade, err.message
      );
    } catch (alertErr) {
      logger.error('[worker] Alert failed', { alertErr });
    }
  }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('[worker] SIGTERM received — graceful shutdown');
  
  // Stop accepting new jobs
  await worker.close();
  
  // Close DB
  await db.end();
  
  // Close Redis
  await redis.disconnect();
  
  logger.info('[worker] Shutdown complete');
  process.exit(0);
});
```

---

## Phase 1C: Fix P2 Issues (Hours 6–8)

### Fix 3.0: Correlation IDs in All Logs (P2)

**Problem**: Cannot trace single request through request → worker → DB

**Fix**: Inject correlation ID in all logs

**File**: `middleware/traceId.js`

```javascript
// Already implemented ✅
// Just ensure all loggers use it:

// In worker:
const logger = require('../utils/logger');
const { traceId } = require('../middleware/traceId');

queue.process(async (job) => {
  const currentTraceId = job.data.traceId || crypto.randomUUID();
  
  logger.info({ traceId: currentTraceId, jobId: job.id },
    '[webhook-worker] Processing event');
    
  // All logs in this execution have currentTraceId
});
```

**Validation**: `grep "traceId" logs/app.log` shows same ID for entire request

---

### Fix 3.1: Queue Depth Metrics (P2)

**File**: `utils/monitoring.js` (add)

```javascript
const { register, Gauge } = require('prom-client');

// Add gauge for queue depth
const queueDepthGauge = new Gauge({
  name: 'queue_depth',
  help: 'Current depth of BullMQ queues',
  labelNames: ['queue_name'],
  registers: [register]
});

// Update periodically
setInterval(async () => {
  const queues = ['webhook-events', 'refund-retry', 'email-dispatch'];
  
  for (const queueName of queues) {
    const queue = require('../config/queues')[queueName + 'Queue'];
    const count = await queue.count();
    queueDepthGauge.set({ queue_name: queueName }, count);
  }
}, 10000);

module.exports = { queueDepthGauge };
```

**Validation**: `curl localhost:9090/metrics | grep queue_depth` shows all queues

---

### Fix 3.2: Enable DLQ Alert Routing (P2)

**File**: `services/alertingService.js` (uncomment)

```javascript
// Current code has Slack integration, just needs enabling

async function alertWorkerExhausted(jobId, queueName, attempts, errorMsg) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  
  if (!webhookUrl) {
    logger.debug('Slack webhook not configured — skipping alert');
    return;
  }
  
  try {
    await axios.post(webhookUrl, {
      text: `🚨 Worker Job Exhausted: ${queueName}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Queue*: ${queueName}\n*Job ID*: ${jobId}\n*Attempts*: ${attempts}\n*Error*: ${errorMsg.slice(0, 100)}`
          }
        }
      ]
    });
    
    logger.info({ queueName, jobId }, '[alerting] Slack alert sent');
  } catch (err) {
    logger.error({ err }, '[alerting] Failed to send Slack alert');
  }
}

module.exports = { alertWorkerExhausted };
```

**Setup**:
1. Create Slack workspace webhook
2. Set `SLACK_WEBHOOK_URL=https://hooks.slack.com/...` in `.env`
3. Restart workers

---

# 📋 IMPLEMENTATION CHECKLIST

## Phase 1A: P0 Fixes

- [ ] Fix 1.0: Webhook ingestion atomicity (persist + enqueue)
- [ ] Fix 1.1: Refund idempotency key in dedup logic

## Phase 1B: P1 Fixes

- [ ] Fix 2.0: Webhook processing idempotency validation (DB status machine)
- [ ] Fix 2.1: Error recovery in refund API calls (pre-create refund record)
- [ ] Fix 2.2: Worker crash recovery handling (DLQ + alerts)

## Phase 1C: P2 Fixes

- [ ] Fix 3.0: Correlation IDs in all logs
- [ ] Fix 3.1: Queue depth metrics
- [ ] Fix 3.2: Enable DLQ alert routing (Slack)

## Testing

- [ ] **Concurrency Stress**: 50 concurrent cancel-booking on same booking → only 1 refund
- [ ] **Webhook Flood**: 100 duplicate webhook events → only 1 processed
- [ ] **Worker Crash**: Kill worker mid-webhook processing → job retried correctly
- [ ] **Refund Double-Spend**: Two concurrent refund calls → only 1 succeeds
- [ ] **Observability**: Trace request ID through all logs

## Deployment

- [ ] Run all tests
- [ ] Merge to main
- [ ] Deploy to staging
- [ ] Smoke test: payment capture → booking confirmed
- [ ] Smoke test: booking cancel → refund initiated
- [ ] Monitor logs for P0/P1 issues (24 hours)
- [ ] Deploy to production

---

# 📊 EXPECTED IMPROVEMENTS

| Metric | Before | After |
|--------|--------|-------|
| Score | 60/100 | 70+/100 |
| Webhook orphaning risk | ⚠️ High | ✅ Eliminated |
| Double-refund risk | ⚠️ Medium | ✅ Eliminated |
| Observable failures | ⚠️ Low | ✅ High |
| Production incidents from code bugs | ~2–3 per month | ~0 |
| MTTD (mean time to diagnose) | 1+ hours | <10 minutes |

---

# 🎯 SUCCESS CRITERIA

System must:

1. ✅ Process all webhooks (no orphaning)
2. ✅ Never double-charge (idempotency guaranteed)
3. ✅ Survive worker crashes safely
4. ✅ Log all failures with context
5. ✅ Alert team immediately on critical failures
6. ✅ Allow diagnosis of failures in <10 minutes

If all criteria met → Score reaches 70+/100.

---

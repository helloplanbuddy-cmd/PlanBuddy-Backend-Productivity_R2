# PHASE 4: QUEUE RELIABILITY — IMPLEMENTATION GUIDE

## 🎯 OBJECTIVES

Ensure background jobs (refunds, emails, maintenance) complete reliably:
1. **Worker failure recovery** — Jobs resume after worker crashes
2. **Dead-letter queue (DLQ)** — Exhausted jobs don't silently fail
3. **Job retry strategies** — Exponential backoff with max attempts
4. **Graceful shutdown** — In-flight jobs complete before process exit
5. **Job state tracking** — JobStateManager prevents duplicate processing

---

## 🏗️ CURRENT ARCHITECTURE

### BullMQ Queues (config/queues.js)
```javascript
emailQueue         — Send transactional emails (low priority, high volume)
refundQueue        — Process refunds (high priority, critical)
expiryQueue        — Mark expired bookings (scheduled, low priority)
maintenanceQueue   — Database cleanup (scheduled, low priority)
reconciliationQueue — Payment reconciliation (scheduled, critical)
```

### Workers (workers/)
```
email.worker.js           — EmailService.sendEmail() with retry
refund.worker.js          — RefundService.initiateRefund() + audit
expiry.worker.js          — Mark pending bookings as expired
maintenance.worker.js     — Cleanup expired bookings, old webhooks
reconciliation.worker.js  — Verify captured payments match Razorpay
```

### Job States
```
pending → processing → completed
                    → failed (retry)
                    → delayed (backoff)
                    → active (in-flight)
```

---

## ⚠️ PHASE 4 RISKS & FIXES

### Risk 1: Worker Crash During Job Processing
**Problem:**
```
Worker: Processing refund job for booking X
Worker: Acquires Redis lock + starts DB transaction
Worker: [CRASH] Process dies before commit
Result: Lock held forever, refund never completes, customer sees "pending" forever
```

**Current Mitigations:**
- Redis lock TTL: 300s (5 min) — lock auto-expires
- BullMQ job timeout: configurable per queue
- Graceful shutdown: 10s drain + 15s hard timeout

**Remaining Issues:**
- Lock held for 5 minutes before auto-expiry
- Manual restart required if worker stuck in deadlock
- No monitoring of zombie jobs

**Fix:**
```javascript
// Add worker safety layer
const workerSafetyService = require('../services/workerSafetyService');

emailQueue.process(1, async (job) => {
  return workerSafetyService.safeProcess(job, async () => {
    // Process job with automatic monitoring
    await EmailService.sendEmail(job.data);
  });
});

// safeProcess wraps job in try-catch + state tracking
// If job crashes: marks state=FAILED, moves to DLQ
```

---

### Risk 2: Lost Jobs (No Dead-Letter Queue)
**Problem:**
```
refundQueue job fails 3 times:
  Attempt 1: Razorpay API timeout
  Attempt 2: DB connection error
  Attempt 3: Network partition
Result: Job is removed from queue (default BullMQ behavior)
        Customer refund is lost (no audit trail)
```

**Current Mitigations:**
- Job retry: `backoff: { type: 'exponential', delay: 2000 }`
- Max attempts: `attempts: 3`
- But: No DLQ for exhausted jobs

**Remaining Issues:**
- No persistence after max retries
- No alert when critical job fails
- No manual intervention path

**Fix:**
```javascript
// Create dead_letter_jobs table
CREATE TABLE dead_letter_jobs (
  id UUID PRIMARY KEY,
  queue_name VARCHAR(50),
  job_id VARCHAR(255),
  job_data JSONB,
  error_message TEXT,
  last_attempt TIMESTAMP,
  attempts INT,
  status VARCHAR(20),  -- 'pending_manual_review', 'resolved', 'ignored'
  created_at TIMESTAMP DEFAULT NOW()
);

// In worker error handler:
queue.on('failed', async (job, err) => {
  if (job.attemptsMade >= job.opts.attempts) {
    await db.query(
      `INSERT INTO dead_letter_jobs (queue_name, job_id, job_data, error_message, attempts)
       VALUES ($1, $2, $3, $4, $5)`,
      [queue.name, job.id, JSON.stringify(job.data), err.message, job.attemptsMade]
    );
    await alertingService.critical(`DLQ: ${queue.name} job ${job.id} exhausted`);
  }
});
```

---

### Risk 3: Graceful Shutdown (Jobs Lost During Deploy)
**Problem:**
```
Deployment: New version rollout
Server: Receives SIGTERM signal
In-flight jobs:
  1. Email queue job (3/10 emails sent) — can resume
  2. Refund job (lock acquired, DB txn started) — INCOMPLETE
Server: 10s drain timeout expires, process killed
Result: Incomplete refund transaction left in limbo, booking shows "processing" forever
```

**Current Mitigations:**
- Graceful drain: 10s HTTP connection drain
- Hard timeout: 15s process kill
- Worker processes jobs sequentially (1 concurrent job per queue)

**Remaining Issues:**
- 10s drain may not be enough for long-running jobs
- No transaction rollback on SIGTERM
- No re-queue of in-flight jobs

**Fix:**
```javascript
// In server.js:
process.on('SIGTERM', async () => {
  logger.info('SIGTERM: Starting graceful shutdown');
  
  // Step 1: Stop accepting new HTTP connections
  server.close(() => {
    logger.info('HTTP server closed');
  });
  
  // Step 2: Wait for in-flight HTTP requests to complete (max 10s)
  await new Promise(resolve => setTimeout(resolve, 10_000));
  
  // Step 3: Pause job workers (no new jobs)
  for (const queue of [emailQueue, refundQueue, expiryQueue, maintenanceQueue]) {
    await queue.pause();
    logger.info(`Queue paused: ${queue.name}`);
  }
  
  // Step 4: Wait for in-flight jobs to complete (max 30s)
  for (const queue of [emailQueue, refundQueue, expiryQueue, maintenanceQueue]) {
    const activeJobs = await queue.getActiveCount();
    if (activeJobs > 0) {
      logger.warn(`${activeJobs} jobs still active; waiting...`);
      await new Promise(resolve => setTimeout(resolve, 30_000));
    }
  }
  
  // Step 5: Force close connections
  await db.end();
  await redis.quit();
  process.exit(0);
});
```

---

### Risk 4: Duplicate Job Processing
**Problem:**
```
Refund job: Processes payment refund
Refund job: Obtains lock, calls Razorpay API, gets refund_id='rfnd_123'
Refund job: Updates DB, saves refund_id
Refund job: [CRASH AFTER DB WRITE but BEFORE lock release]
Result: Lock still held for 5 minutes
Queue auto-resumes job after BullMQ timeout
Second attempt: Gets same refund_id, but Razorpay API returns "already refunded"
```

**Current Mitigations:**
- Job idempotency key: `refund-${bookingId}`
- Razorpay idempotency_key header (PHASE 2 FIX)
- Refund status check in DB (PHASE 2 FIX)

**Remaining Issues:**
- Worker safety service doesn't check for duplicate refund_id
- No de-duplication of refund API responses

**Fix:**
```javascript
// In refund.worker.js — add duplicate check
refundQueue.process(async (job) => {
  const { bookingId } = job.data;
  
  // Check if refund already processed in this attempt
  const existingRefund = await db.query(
    `SELECT razorpay_refund_id FROM payments WHERE booking_id = $1 AND status = 'refunded'`,
    [bookingId]
  );
  
  if (existingRefund.rows.length > 0) {
    logger.info('Refund already processed', { bookingId, refundId: existingRefund.rows[0].razorpay_refund_id });
    return { success: true, idempotent: true };
  }
  
  // Proceed with refund (has distributed lock, SELECT FOR UPDATE, etc from PHASE 2)
  return await RefundService.initiateRefund(bookingId, job.data.reason, job.data.requestedByUserId);
});
```

---

### Risk 5: Concurrency (Multiple Workers Processing Same Queue)
**Problem:**
```
Deployment: 3 instances running simultaneously
refundQueue: Default concurrency = 1 per instance = 3 total concurrent jobs
Two jobs compete for same booking:
  Instance 1: Processing refund-booking-X
  Instance 2: Processing refund-booking-X (retry)
Result: Both acquire locks, both process, both refund customer
```

**Current Mitigations:**
- Job ID is unique per booking: `refund-${bookingId}`
- BullMQ prevents duplicate job IDs (only processes once)
- Razorpay idempotency_key prevents API-level duplicates (PHASE 2 FIX)

**Remaining Issues:**
- Worker concurrency configurable but not validated
- No enforcement of 1:1 job:booking ratio

**Fix:**
```javascript
// config/queues.js — Document and enforce worker concurrency
module.exports = {
  refundQueue: new Queue('refund', redis, {
    concurrency: 1,  // 🔥 CRITICAL: Only 1 job per worker instance
    // Reason: Refunds modify same payment row; concurrent = race conditions
    // Multiple instances OK (3 instances × 1 concurrency = 3 total capacity)
  }),
  
  emailQueue: new Queue('email', redis, {
    concurrency: 5,  // Email is stateless; safe to parallelize
  }),
};
```

---

## ✅ VERIFIED IMPLEMENTATIONS

### ✅ 1. Worker Safety Service
**File:** `services/workerSafetyService.js`

**Pattern:**
- Job state tracking in DB (`job_states` table)
- Prevents duplicate processing
- Moves failed jobs to DLQ
- Logs all job state changes

**Status:** ✅ Already implemented

---

### ✅ 2. Refund Worker
**File:** `workers/refund.worker.js`

**Pattern:**
- Calls RefundService.initiateRefund() (has distributed lock + FOR UPDATE)
- Wraps with workerSafetyService.safeProcess()
- Returns idempotent response if already processed
- DLQ on max retries exhausted

**Status:** ✅ Already implemented (PHASE 2 integration complete)

---

## 📋 PHASE 4 FIXES REQUIRED

### Fix 1: Add Dead-Letter Jobs Table
**SQL Migration:**
```sql
CREATE TABLE dead_letter_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_name VARCHAR(50) NOT NULL,
  job_id VARCHAR(255) NOT NULL,
  job_data JSONB,
  error_message TEXT,
  error_stack TEXT,
  last_attempt TIMESTAMP,
  attempts INT,
  status VARCHAR(20) DEFAULT 'pending_manual_review',
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(queue_name, job_id)
);
CREATE INDEX idx_dead_letter_status ON dead_letter_jobs(status);
```

### Fix 2: Enhance Queue Error Handler
**File:** `config/queues.js`

**Add to each queue:**
```javascript
queue.on('failed', async (job, err) => {
  if (job.attemptsMade >= job.opts.attempts) {
    // Move to DLQ
    await db.query(
      `INSERT INTO dead_letter_jobs (queue_name, job_id, job_data, error_message, error_stack, attempts)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (queue_name, job_id) DO UPDATE
         SET error_message = EXCLUDED.error_message,
             last_attempt = NOW(),
             updated_at = NOW()`,
      [
        queue.name,
        job.id,
        JSON.stringify(job.data),
        err.message,
        err.stack,
        job.attemptsMade
      ]
    );
    
    // Alert critical queues
    if (['refund', 'reconciliation'].includes(queue.name)) {
      await alertingService.critical(`DLQ: ${queue.name} job ${job.id} exhausted`, {
        queueName: queue.name,
        jobId: job.id,
        error: err.message,
        attempts: job.attemptsMade,
      });
    }
  }
});
```

### Fix 3: Implement Graceful Shutdown
**File:** `server.js`

**Add:**
```javascript
async function gracefulShutdown() {
  logger.info('Starting graceful shutdown...');
  
  // Pause all queues
  const queues = [emailQueue, refundQueue, expiryQueue, maintenanceQueue];
  for (const q of queues) {
    await q.pause();
  }
  
  // Wait for in-flight jobs (max 30s)
  const shutdownDeadline = Date.now() + 30_000;
  let allComplete = false;
  while (Date.now() < shutdownDeadline && !allComplete) {
    const counts = await Promise.all(
      queues.map(q => q.getActiveCount())
    );
    allComplete = counts.every(c => c === 0);
    if (!allComplete) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  
  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
```

---

## 🧪 TEST SCENARIOS FOR PHASE 4

### Test 1: Worker Crash During Job Processing
```
Setup: Start refund job
Action: Kill worker process mid-job
Expected: Lock auto-expires after 5min, job retries
Verify: Refund completes on retry, no duplicate
```

### Test 2: Job Max Retries Exhausted
```
Setup: Simulate Razorpay API permanently unavailable
Action: Queue refund job, let it fail 3 times
Expected: Job moves to DLQ, alert sent
Verify: Job appears in dead_letter_jobs table
```

### Test 3: Graceful Shutdown with In-Flight Jobs
```
Setup: Start refund job (long-running)
Action: Send SIGTERM to process
Expected: Job completes, process exits cleanly
Verify: No orphaned locks, refund applied
```

---

## 🚀 READY FOR PHASE 5: SECURITY HARDENING

After PHASE 4 queue reliability, PHASE 5 will address:
- JWT validation + refresh token rotation
- CORS + security headers
- Rate limiting on sensitive endpoints
- Webhook signature validation (already done, verify)
- SQL injection prevention (prepared statements)
- XSS prevention (API, no direct HTML rendering)

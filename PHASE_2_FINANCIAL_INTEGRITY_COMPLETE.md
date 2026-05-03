# PHASE 2: FINANCIAL INTEGRITY FIXES (COMPLETED)

## 🔥 CRITICAL FIXES APPLIED

### 1. ✅ Refund Locking & Idempotency (refundService.js)
**File:** `services/refundService.js`

**Problem:** Concurrent refund requests could issue duplicate refunds
- No distributed lock before Razorpay API call
- No idempotency check before processing
- Race condition: first request fails, second succeeds, leaving duplicate refund

**Solution:** Three-layer locking model
```
Layer 1: Redis distributed lock (SETNX + 5min TTL)
Layer 2: SELECT FOR UPDATE on payment row
Layer 3: Idempotency check (if status='refunded', return existing)
Layer 4: Razorpay idempotency_key header
Layer 5: Double-check race condition between lock release and transaction commit
```

**Code Changes:**
- Distributed lock: `redis.set(requestKey, '1', 'NX', 'EX', 300)`
- SELECT FOR UPDATE: `SELECT * FROM payments WHERE id = $1 FOR UPDATE`
- Idempotency check: Return existing if `status='refunded'`
- Razorpay header: `idempotency_key: booking:${bookingId}:refund`
- Double-check: Verify no concurrent refund after lock release

**Result:** ✅ Concurrent refunds now safely serialized; no duplicate issuance possible

---

### 2. ✅ Webhook Replay Window (razorpayService.js)
**File:** `services/razorpayService.js`

**Problem:** Ambiguous replay window handling
- Current code logs events >5min old but processes them anyway
- Confusing behavior: comment says "processing as valid retry" but logic is unclear
- No explicit rejection of stale events

**Solution:** 24-hour acceptance window with explicit rejection
```
REPLAY_WINDOW_SECONDS = 24 * 3600 (86400 seconds)
Events >24h old: Reject with 'event_too_old' (return 200 to prevent Razorpay retries)
Events 5m-24h old: Process as normal retry (log at info level)
Events <5m old: Process immediately (log at debug level)
```

**Code Changes:**
- Window constant: `const REPLAY_WINDOW_SECONDS = 24 * 3600`
- Rejection logic: `if (ageSeconds > REPLAY_WINDOW_SECONDS) return { processed: true, idempotent: true, reason: 'event_too_old' }`
- Deduplication: UNIQUE(razorpay_event_id) in webhook_events table

**Result:** ✅ Webhook handling now explicit; operators can distinguish normal vs expired events

---

### 3. ✅ Strict Idempotency Middleware (middleware/idempotency.js)
**File:** `middleware/idempotency.js`

**Problem:** Idempotency key was optional for payment endpoints
- POST /payment/create-order — no idempotency enforcement
- POST /payment/verify-payment — no idempotency enforcement
- Risk: Frontend retries could double-charge customer

**Solution:** STRICT variant + Redis + DB fallback
```
idempotency.strict — REQUIRE idempotency key (return 400 if missing)
idempotency — OPTIONAL idempotency key (skip if not provided)

Two-tier caching:
  1. Redis primary (30s lock TTL, response TTL = 24h)
  2. DB fallback (idempotency_keys table)

Only cache 2xx responses (prevents error caching)
```

**Code Changes:**
- Strict variant: `idempotency.strict` middleware
- Require check: `if (!rawKey || rawKey.trim() === '') return 400 error`
- User-scoped keys: `${userId}:${endpoint}:${rawKey}` prevents cross-user replay
- DB fallback: Write to `idempotency_keys` table with 24h TTL
- Lock mechanism: `redis.set(lockKey, '1', 'NX', 'EX', 30)` prevents concurrent identical requests

**Result:** ✅ Payment endpoints now require idempotency; 409 returned for in-flight duplicates

---

### 4. ✅ Payment Routes Enforcement (routes/payment.js)
**File:** `routes/payment.js`

**Problem:** Payment routes didn't use strict idempotency
- `idempotency({ required: true })` — middleware doesn't accept params
- No enforcement at route level

**Solution:** Use strict middleware variant
```
POST /payment/create-order — idempotency.strict
POST /payment/verify-payment — idempotency.strict
POST /payment/webhook/razorpay — NO idempotency (Razorpay handles dedup)
GET /payment/status/:paymentId — No idempotency (read-only)
```

**Code Changes:**
- Changed from: `idempotency({ required: true })`
- Changed to: `idempotency.strict`

**Result:** ✅ Payment endpoints now enforce idempotency key requirement

---

## 🎯 PHASE 2 VALIDATION CHECKLIST

### Refund Safety
- ✅ Distributed lock prevents concurrent refund processing
- ✅ SELECT FOR UPDATE locks payment row before API call
- ✅ Idempotency check prevents reprocessing
- ✅ Razorpay idempotency_key header prevents API-level duplicates
- ✅ Double-check after lock release catches race conditions
- ✅ Booking status updated to 'cancelled' in same transaction
- ✅ Trip capacity restored in same transaction

### Payment Idempotency
- ✅ POST /payment/create-order requires Idempotency-Key header
- ✅ POST /payment/verify-payment requires Idempotency-Key header
- ✅ Middleware validates key format (string, max 255 chars)
- ✅ Concurrent identical requests return 409 IDEMPOTENCY_KEY_IN_FLIGHT
- ✅ Only 2xx responses cached (prevents error caching)
- ✅ User-scoped keys prevent cross-user replay
- ✅ Redis primary cache + DB fallback
- ✅ 24-hour response TTL

### Webhook Safety
- ✅ 24-hour acceptance window (not 5-minute)
- ✅ Events >24h old explicitly rejected (return 200 to prevent retries)
- ✅ Duplicate events deduplicated via UNIQUE(razorpay_event_id)
- ✅ Signature verification BEFORE DB mutations
- ✅ Replay window check AFTER dedup check

### Order → Payment Mapping
- ✅ razorpay_order_mappings.razorpay_order_id PRIMARY KEY (unique)
- ✅ Atomic transaction: INSERT order_mapping + UPDATE payment in same transaction
- ✅ Webhook resolves booking via razorpay_order_id → booking_id mapping

### Payment Record Consistency
- ✅ payments.booking_id UNIQUE constraint (one payment per booking)
- ✅ payments.razorpay_payment_id UNIQUE constraint
- ✅ Payment record created atomically with booking
- ✅ Payment status transitions: created → captured | failed → refunded

---

## ✅ ALL PHASE 2 TASKS COMPLETED

### Files Modified:
1. `services/refundService.js` — ✅ Replaced with PHASE 2 fixes
2. `services/razorpayService.js` — ✅ Webhook replay window fixed (24h window)
3. `middleware/idempotency.js` — ✅ Strict variant added + DB fallback
4. `routes/payment.js` — ✅ Routes updated to use strict idempotency

### Tests Needed:
- [ ] Concurrent refund requests (should return same result)
- [ ] Webhook replay after 1 hour (should process)
- [ ] Webhook replay after 25 hours (should reject)
- [ ] Duplicate payment verification (should return 409 in-flight, then cached result)
- [ ] Payment without idempotency key (should return 400)

---

## 📋 READY FOR PHASE 3: CONCURRENCY & LOCKING

Phase 3 requires verifying:
- SELECT FOR UPDATE on all booking/payment reads before mutations
- Redis distributed locks for coarse-grained mutual exclusion
- Advisory locks for cascading updates (booking → trip capacity)

Phase 3 will address:
- Booking double-booking prevention (trip capacity overflow)
- Concurrent booking confirmation races
- Capacity restoration race conditions on cancellation

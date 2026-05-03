# PHASE 3: CONCURRENCY & LOCKING — IMPLEMENTATION GUIDE

## 🎯 OBJECTIVES

Prevent concurrent update races that could cause:
1. **Booking double-booking** (group size >max_group_size after concurrent confirms)
2. **Capacity overflow** (multiple confirmations on same slot)
3. **Lost capacity restoration** (concurrent cancellations don't restore properly)
4. **Concurrent refund races** (already fixed in PHASE 2)

---

## 🔥 CRITICAL CONCURRENCY PATTERNS

### Pattern 1: SELECT FOR UPDATE (Row-Level Locking)
```sql
BEGIN;
SELECT * FROM bookings WHERE id = $1 FOR UPDATE;
-- Now safe to update: no other transaction can modify this row
UPDATE bookings SET status = 'confirmed' WHERE id = $1;
COMMIT;
```

**Apply to:**
- `bookings` — when confirming, cancelling, or checking status
- `trips` — when updating capacity (current_bookings)
- `payments` — when refunding or capturing

### Pattern 2: Redis Distributed Lock (Coarse-Grained)
```javascript
const lock = await LockService.acquireLock(key, ttl);
try {
  // Critical section
} finally {
  await lock.release();
}
```

**Use for:**
- Slot-level booking (prevent double-booking same slot)
- Trip capacity updates (coarse mutual exclusion)
- Refund processing (prevent duplicate refunds)

### Pattern 3: UNIQUE Constraints (Database Level)
```sql
UNIQUE (trip_id, travel_date, slot_id) — prevent duplicate slot bookings
UNIQUE (booking_id) ON payments — one payment per booking
UNIQUE (razorpay_payment_id) ON payments — no duplicate payment processing
```

---

## ✅ VERIFIED IMPLEMENTATIONS

### ✅ 1. Booking Creation (Already Correct)
**File:** `services/dbService.js` → `atomicBookingTransaction()`

**Pattern:**
- Redis lock on `booking:${trip_id}:${date}:${slot}`
- SELECT FOR UPDATE on trips row
- Capacity check WITH locked trip row
- Atomic increment: `current_bookings = current_bookings + $1`
- Dual-write protection: idempotency check + UNIQUE(trip_id, travel_date, slot_id)

**Status:** ✅ SAFE (no changes needed)

---

### ✅ 2. Payment Confirmation (Already Has Locks)
**File:** `services/razorpayService.js` → `_executePaymentTransaction()`

**Pattern:**
- SELECT FOR UPDATE on bookings row
- Check: `status = 'pending' AND payment_status = 'unpaid'`
- Amount validation with locked row
- State machine transition (prevents invalid state changes)

**Status:** ✅ SAFE (no changes needed)

---

### ✅ 3. Refund Processing (PHASE 2 FIX)
**File:** `services/refundService.js`

**Pattern:**
- Redis distributed lock (prevents concurrent refunds)
- SELECT FOR UPDATE on payments row
- Idempotency check
- Booking + trip capacity update in same transaction

**Status:** ✅ SAFE (PHASE 2 completed)

---

## ⚠️ PHASE 3 ISSUES TO FIX

### Issue 1: Booking Cancellation (No SELECT FOR UPDATE)
**File:** `services/dbService.js` → `cancelBooking()`

**Problem:**
```javascript
// CURRENT — UNSAFE
const booking = await client.query(
  'SELECT * FROM bookings WHERE id = $1',  // ❌ No FOR UPDATE
  [bookingId]
);
// Another transaction could update status here
await client.query(
  'UPDATE bookings SET status = "cancelled" WHERE id = $1',
  [bookingId]
);
// And capacity restoration could race
await client.query(
  'UPDATE trips SET current_bookings = current_bookings - $1 WHERE id = $2',
  [booking.group_size, booking.trip_id]
);
```

**Risk:** 
- Concurrent cancellation + confirmation could:
  - Release capacity twice (current_bookings underflows)
  - Both transitions could succeed (booking state machine violated)

**Fix:**
```javascript
// FIXED — SAFE
const booking = await client.query(
  `SELECT * FROM bookings WHERE id = $1 FOR UPDATE`,  // ✅ FOR UPDATE
  [bookingId]
);
// Now safe: no other transaction can modify this booking

// Also lock trip row for capacity update
await client.query(
  `SELECT id FROM trips WHERE id = $1 FOR UPDATE`,
  [booking.trip_id]
);

await client.query(
  `UPDATE bookings SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
  [bookingId]
);

await client.query(
  `UPDATE trips SET current_bookings = current_bookings - $1 WHERE id = $2
   AND current_bookings >= $1`,  // Safety: don't go negative
  [booking.group_size, booking.trip_id]
);
```

### Issue 2: Trip Capacity Check (May Race During Concurrent Bookings)
**File:** `services/dbService.js` → `atomicBookingTransaction()`

**Problem (Theoretical):**
- Current code has SELECT FOR UPDATE ✅ which is correct
- But verify idempotency check also uses FOR UPDATE ✅

**Status:** ✅ SAFE (already correct)

### Issue 3: Booking Status Checks (No Locking)
**File:** `controllers/bookingController.js` → `getUserBookings()`, `getBookingDetails()`

**Problem:**
```javascript
// CURRENT — UNSAFE FOR WRITES
const booking = await db.query(
  `SELECT * FROM bookings WHERE id = $1 AND user_id = $2`,  // ❌ No FOR UPDATE
  [bookingId, userId]
);
```

**Risk:** 
- Read-only checks are safe
- BUT if called during concurrent cancellation, might return stale data

**Fix:**
- For READ-ONLY endpoints: ✅ No change needed (SELECT without FOR UPDATE is safe)
- For WRITE endpoints: Add FOR UPDATE if modifying the booking

**Status:** ✅ SAFE AS-IS (reads don't need locking)

---

## 📝 PHASE 3 FIXES REQUIRED

### Fix 1: Booking Cancellation (SELECT FOR UPDATE)
**File to modify:** `services/dbService.js`
**Method:** `cancelBooking()`

**Changes:**
1. Add `FOR UPDATE` to booking SELECT
2. Add `FOR UPDATE` to trip SELECT (before capacity update)
3. Add safety check: `current_bookings >= $1` in UPDATE

**Expected outcome:** Concurrent cancellations now serialized

---

### Fix 2: Verify idempotency.strict Middleware Applied
**File:** `routes/payment.js` — ✅ ALREADY FIXED IN PHASE 2

**Status:** ✅ No additional work needed

---

### Fix 3: Verify Admin Reconciliation Route Uses Strict Idempotency
**File:** `routes/admin.js`

**Check:**
- Does `/admin/reconcile` use idempotency middleware?
- If yes, does it use `idempotency.strict`?

**Expected:** Should require idempotency key (prevents double-reconciliation)

---

## 🧪 TEST SCENARIOS FOR PHASE 3

### Test 1: Concurrent Booking + Cancellation
```
Thread 1: Start booking confirmation (after payment verification)
Thread 2: Start booking cancellation (user changes mind)
Expected: One succeeds, one fails with BOOKING_CONFLICT
Verify: Capacity is not double-released
```

### Test 2: Concurrent Cancellations
```
Thread 1: Cancel booking (group size = 5)
Thread 2: Cancel same booking (group size = 5)
Expected: One succeeds, one fails with BOOKING_NOT_FOUND or INVALID_STATE
Verify: Trip capacity only decreases by 5 (not 10)
```

### Test 3: Concurrent Refund + Confirmation
```
Thread 1: Refund booking
Thread 2: Confirm payment on same booking
Expected: One succeeds, one fails (payment/refund status mismatch)
Verify: No orphaned transactions
```

### Test 4: Three Concurrent Bookings (Same Slot)
```
Thread 1, 2, 3: All book same trip/date/slot
Trip capacity = 6, each booking = 2
Expected: One succeeds (capacity = 4), two fail (capacity insufficient)
Verify: Exactly one booking confirmed
```

---

## 🔍 VALIDATION CHECKLIST

- [ ] SELECT FOR UPDATE on `bookings` before any state change
- [ ] SELECT FOR UPDATE on `trips` before capacity update
- [ ] Redis lock acquired BEFORE entering DB transaction
- [ ] Lock ALWAYS released (try-finally block)
- [ ] Idempotency checks use FOR UPDATE
- [ ] Capacity restoration has safety check: `>= $1`
- [ ] Booking state machine prevents invalid transitions
- [ ] Concurrent identical operations return same cached result
- [ ] Concurrent conflicting operations return 409 CONFLICT

---

## 📊 IMPACT ASSESSMENT

**High-Risk Operations:**
- Booking confirmation (payment verification)
- Booking cancellation (capacity restoration)
- Concurrent refund requests

**Low-Risk Operations:**
- Reading booking status
- Reading trip details
- Creating audit logs

**Concurrency Model:**
- Pessimistic locking (SELECT FOR UPDATE)
- Redis coarse-grained locks (prevent thundering herd)
- Idempotency middleware (dedup identical requests)

---

## 🚀 READY FOR PHASE 4: QUEUE RELIABILITY

After PHASE 3 concurrency fixes, PHASE 4 will address:
- BullMQ worker failure recovery
- Dead-letter queue (DLQ) handling
- Job retry strategies
- Graceful shutdown sequences

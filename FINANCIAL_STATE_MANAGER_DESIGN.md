# PlanBuddy v9 — Financial State Manager Redesign (Money-Corruption Elimination Plan)

## Goal
Eliminate the possibility of **conflicting financial states** for the same payment/refund/webhook across:
- API paths
- webhook ingestion/processing
- BullMQ workers
- DLQ replay/retries
- reconciliation

This document applies your directive:
- **Only one component is allowed to mutate canonical financial state** (strict single-writer).

## Single-writer choice (confirmed)
**Option 1: Create a new `FinancialStateManager`** that becomes the **only writer** for canonical financial state.

- Webhooks: **MUST NOT** directly mutate payments/refunds/bookings final states.
- Workers: **MUST NOT** directly mutate payments/refunds/bookings final states.
- API: **MUST NOT** finalize/refund/booking financial end-states.
- Only `FinancialStateManager` performs final state writes.

Booking/payment “confirmed/cancelled” are included under the same single-writer rule (strict).

---

## Architecture — strict separation (3 layers)

### 1) Provider Event Ingestion (write provider records only)
**Writers allowed:**
- `webhook_ingest` layer only inserts into:
  - `webhook_events` (provider event_id unique)
  - `refund_intents` (if created by webhook/API; see below)
  - `refund_requests` / `refund_intent_requests` (immutable records)

**No mutation of:**
- `payments.status`
- `refunds.status`
- `bookings.payment_status/status`

### 2) Provider/Event Processing (propose transitions only)
**Writers allowed:**
- enqueue jobs that call `FinancialStateManager.proposeTransition(...)`

No direct DB mutations of financial end-states.

### 3) Financial State Manager (single writer)
**Writers allowed:**
- `payments`
- `refunds`
- `bookings`
- (optionally) derived audit tables

**All proposals are validated, deduped, and finalized here.**

---

## Final canonical state model (text diagram)

### payments (canonical)
States (recommended canonical set):
- `created` (order created, capture pending)
- `captured` (capture confirmed by webhook OR reconciliation)
- `failed` (terminal)
- `refunded_pending` (refund intent accepted; terminal depends on refund outcome)
- `refunded` (terminal)

Forbidden:
- `created -> refunded`
- `failed -> *` (any)
- `refunded -> *`

Allowed transitions:
- `created -> captured | failed`
- `captured -> refunded_pending`
- `refunded_pending -> refunded | failed` (failed meaning refund failure terminal if you model it; otherwise keep refunds terminal)

### refunds (canonical)
States:
- `refund_intent_created` (intent exists; no provider terminal confirmation yet)
- `processing` (provider refund created/processing)
- `succeeded` (terminal)
- `failed` (terminal)
- `cancelled` (terminal if you support pre-processing cancellation)

Allowed:
- `refund_intent_created -> processing`
- `processing -> succeeded | failed | cancelled`
Forbidden:
- any transition out of `succeeded/failed/cancelled`

### webhook_events (canonical dedupe only)
States:
- `pending`, `processed`, `failed`
**No financial writes inside processing.** Processing only results in transition proposals.

---

## Forbidden transitions list (money correctness hard guarantees)
1) `payments.refunded` cannot be set unless:
   - there exists a refund `refunds.status='succeeded'` for the same payment/refund linkage
2) `bookings.payment_status='refunded'` cannot be set unless:
   - `refunds.status='succeeded'`
3) `refunds.status='succeeded'` cannot be set unless:
   - provider refund terminal evidence exists for the corresponding `webhook_events.event_id` or reconciliation proof

If any of these checks cannot be made deterministically by DB constraints + single-writer logic:
- system is **NOT SAFE** until fixed.

---

## Deterministic idempotency — redesign requirements

### Requirement A: deterministic idempotency keys per business intent
Business intent inputs:
- refund intent: `{payment_id, amount, reason, user_id, client_idempotency_key}`

**Rule:**
- idempotency key for refund intent must be deterministic and **never generated using timestamps**.
- `refund-retry` must reuse the same idempotency scope as the original intent.

### Requirement B: one registry for every intent
Introduce a canonical `idempotency_registry` table as the cross-service source of truth.

Registry responsibilities:
- unique key on `(scope, business_intent_hash)`
- store status: `accepted | applied | rejected`
- store the final `transition_id` that was finalized

### Requirement C: DB-enforced uniqueness is the primary mechanism
Redis-only correctness is forbidden for money finalization.
Redis can be used for performance, never correctness.

---

## Proposed code changes (module-level plan)

### New: `planbuddy_v9/services/financialStateManager.js`
Responsibilities:
- expose methods:
  - `proposePaymentCapture(eventId, paymentId, providerEvidence)`
  - `proposeRefundIntentCreated(eventId, paymentId, refundIntentHash, providerEvidence?)`
  - `proposeRefundProviderTerminal(eventId, paymentId, razorpay_refund_id, providerTerminalStatus)`
- perform in a transaction:
  1) validate event dedupe
  2) validate current canonical state
  3) write state transitions (payments/refunds/bookings)
  4) mark event finalization/proposal applied

### New DB tables (minimum)
- `financial_transitions`:
  - `transition_id` (uuid)
  - `event_id` (uuid/string) unique OR unique on `(intent_hash, transition_type)`
  - `state_before_hash`, `state_after_hash` (optional but useful)
  - `applied_at`, `applied_by='financial_state_manager'`
- `idempotency_registry`:
  - `scope` (e.g. `refund_initiation`, `refund_terminal`, `payment_capture_terminal`)
  - `intent_hash` unique with `scope`
  - `status`, `transition_id`

### Adjust existing writers
- `controllers/razorpayWebhookController.js`
  - must only persist provider event + enqueue proposal job
  - must NOT update payments/refunds/bookings directly
- `workers/webhook-processor.worker.js`
  - must only call `FinancialStateManager.propose...`
  - must not write payments/refunds/bookings itself
- `controllers/paymentController.js` refund initiation endpoint
  - must only create refund intent record + enqueue proposal
  - must NOT set `payments.status='refund_pending'` and must NOT change booking/payment terminal state
- `workers/refund-retry.worker.js`
  - must propose transitions; must not finalize payment/refund canonical states

---

## Output required by you (per your rubric)

### 1) Final state machine diagram (text form)
Included above.

### 2) Allowed transitions
Included above.

### 3) Forbidden transitions list
Included above.

### 4) Fixed files list (exact paths)
Not safe to guess without implementing; final list will be produced once we make the first code changes.

### 5) Removed risk flows
Will remove the following money-corruption risk flows **by implementation**, not by assumption:
- Premature `payments.status='refunded'` / booking cancellation before refund terminal evidence
- Webhook worker mutating canonical state directly
- Worker retry creating distinct refund intents via timestamp-based idempotency keys

---

## Critical note (truth, not patching)
Based on the earlier code inspection evidence, the system is currently **NOT production safe** because:
- refund retry / initiation paths can mutate canonical end states before terminal confirmation is guaranteed
- webhook handling currently ACKs even on internal failures
- retry idempotency can be non-deterministic
- single-writer guarantee is not enforced globally

This redesign is the only correct path to achieve mathematical “no conflicting states” guarantees.

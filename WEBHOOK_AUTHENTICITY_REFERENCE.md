# Webhook Authenticity Model — Quick Reference

## Security Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      RAZORPAY (External)                        │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         │ POST /webhook (+ X-Razorpay-Signature header)
                         │
┌────────────────────────▼────────────────────────────────────────┐
│                    HTTP INGRESS LAYER                           │
│  • Extract raw payload bytes from req.body                      │
│  • Extract signature from X-Razorpay-Signature header           │
│  • Verify HMAC-SHA256(payloadBytes) == signature                │
│  • REJECT if verification fails (401 Unauthorized)              │
│  • FAIL FAST — no side effects before verification              │
└────────────────────────┬────────────────────────────────────────┘
                         │
                    ✅ PASSED
                         │
┌────────────────────────▼────────────────────────────────────────┐
│                    DATABASE PERSISTENCE                         │
│  INSERT INTO webhook_events (                                   │
│    provider='razorpay',                                         │
│    razorpay_event_id,                                           │
│    event_type,                                                  │
│    payload,                                                     │
│    payload_bytes,      ← IMMUTABLE raw bytes                   │
│    signature,          ← IMMUTABLE HMAC-SHA256                 │
│    verified_at=NOW(),  ← Audit timestamp                       │
│    verified_by_lease_version=1,  ← Ownership proof            │
│    status='received'                                            │
│  ) UNIQUE(provider, razorpay_event_id, signature)              │
│    ↓                                                            │
│  Handle duplicate (idempotent, return 200)                     │
└────────────────────────┬────────────────────────────────────────┘
                         │
                    Insert Success
                         │
┌────────────────────────▼────────────────────────────────────────┐
│                  MUTATION PROCESSING (Workers)                  │
│  1. Read webhook_events row from DB                             │
│  2. Extract payload_bytes and signature                         │
│  3. Re-verify: HMAC-SHA256(payload_bytes) == signature          │
│     ↓                                                            │
│     ✅ PASSED → Proceed to financial mutations                  │
│     ❌ FAILED → Log SECURITY event, STOP (no mutations)         │
│  4. Acquire advisory lock (payment_id)                          │
│  5. Apply refund/charge/etc. with lease fencing                 │
│  6. Update webhook_events: status='applied'                     │
└─────────────────────────────────────────────────────────────────┘
```

## Key Security Properties

| Property | Mechanism | Evidence |
|----------|-----------|----------|
| **Immutability** | payload_bytes + signature stored at ingress | UNIQUE constraint prevents overwrites |
| **Replay Safety** | Signature re-verified before mutation | Test: replay signature verification |
| **Tampering Detection** | HMAC mismatch fails atomically | Test: tampered payload detection |
| **Timing Attacks** | Constant-time comparison (crypto.timingSafeEqual) | No data-dependent branch timing |
| **Audit Trail** | verified_at timestamp + lease_version | Admin can trace decision path |
| **No Bypass** | All paths (ingress, replay, manual) verify | Tests prove no unsigned mutations |

## Test Coverage (18 tests)

### Valid Paths ✅
- Test 1: Valid signature verification (HMAC-SHA256 computed correctly)
- Test 2: Payload bytes extracted correctly

### Invalid Paths ❌
- Test 3: Reject invalid signature
- Test 4: Reject missing payload
- Test 5: Reject missing signature

### Tampering Attacks ❌
- Test 6: Fail if payload modified after signature
- Test 7: Detect whitespace changes in payload

### Replay Scenarios ✅
- Test 8: Verify replay signature matches stored data
- Test 9: Reject replay if stored payload corrupted
- Test 10: Reject replay if stored signature corrupted

### Authorization Enforcement ✅
- Test 11: Assert webhook is authenticated (has signature)
- Test 12: Reject webhook without signature
- Test 13: Reject webhook without verified_at
- Test 14: Reject webhook without lease ownership

### Payload Extraction ✅
- Test 15: Extract string payload as-is
- Test 16: Extract Buffer to string
- Test 17: Extract object by re-stringifying
- Test 18: Handle empty/null gracefully

## Attack Scenarios Mitigated

### Scenario 1: Forged Webhook Replay
```
Attack: Admin manually inserts fake webhook_events row with forged signature
Before: Applied without verification ❌
After:  verifyReplaySignature() fails, rejects ✅
```

### Scenario 2: Tampered Payload in Database
```
Attack: DB corruption or insider modifies payload_bytes value
Before: Applied with original signature (mismatch ignored) ❌
After:  HMAC-SHA256(corrupted_bytes) != stored_signature → REJECTED ✅
```

### Scenario 3: Signature Stripping
```
Attack: Attacker removes signature column from webhook_events
Before: Workers assume "if in DB, it's verified" ❌
After:  assertWebhookVerified() checks for signature, fails if missing ✅
```

### Scenario 4: Timing Attack on HMAC Comparison
```
Attack: Attacker tries to forge signature using timing information
Before: String comparison timing leaks signature bits ❌
After:  crypto.timingSafeEqual() provides constant-time comparison ✅
```

## Implementation Files

### Services
- **webhookAuthenticityService.js** (315 lines)
  - `computeSignature(payloadBytes)` — HMAC-SHA256 computation
  - `verifyIngressSignature(payloadBytes, signature, context)` — Ingress verification
  - `verifyReplaySignature(storedPayloadBytes, storedSignature, context)` — Replay verification
  - `assertWebhookVerified(webhookEvent, context)` — Authorization check
  - `extractPayloadBytes(body)` — Safe payload bytes extraction

### Controllers
- **paymentController.js** razorpayWebhook handler
  - Extract payload bytes from req.body
  - Verify signature immediately
  - Store webhook_events with signature + verified_at
  - Handle UNIQUE constraint violations (idempotency)

### Services
- **webhookReplayService.js** reprocessEvent()
  - Read stored payload_bytes + signature
  - Call verifyReplaySignature() BEFORE mutation
  - Log security events on mismatch
  - Proceed only if verification succeeds

### Database
- **migration 180_webhook_authenticity_convergence.sql**
  - ADD payload_bytes TEXT
  - ADD signature VARCHAR(256)
  - ADD verified_at TIMESTAMPTZ
  - ADD verified_by_lease_version BIGINT
  - ADD CONSTRAINT UNIQUE(provider, razorpay_event_id, signature)

## Running Tests

```bash
# All unit tests (27 total)
npm test

# Only webhook authenticity tests (18 total)
npm test -- __tests__/webhookAuthenticity.unit.test.js

# Only refund tests (9 total)
npm test -- __tests__/exactlyOnceRefund.unit.test.js
```

## Security Best Practices

1. **Always extract raw bytes** — Don't assume JSON parsing preserves HMAC validity
2. **Verify before mutating** — Fail-fast on signature mismatch
3. **Use constant-time comparison** — Prevent timing attacks
4. **Log failures** — Enable security audit trails
5. **Store signature immutably** — Enable re-verification without re-trusting source
6. **No bypass paths** — Every code path to mutation must verify
7. **Fenced ownership** — Combine signature with lease version for concurrent safety

## Future Enhancements

1. **Signature Key Rotation** — Support multiple key versions
2. **Replay Rate Limiting** — Prevent replay storms
3. **Signature Algorithm Versioning** — Support SHA256 → SHA512 migration
4. **Webhook Delivery SLA** — Alert on repeated signature failures
5. **Tamper Detection Metrics** — Count rejected replays by corruption type

---

**Document Status**: Reference for P0 security model  
**Confidence Level**: 18/18 tests passing  
**Audit Status**: Ready for production review

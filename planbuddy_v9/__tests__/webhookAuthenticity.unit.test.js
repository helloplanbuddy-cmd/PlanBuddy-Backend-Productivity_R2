'use strict';

/**
 * __tests__/webhookAuthenticity.unit.test.js — Webhook Authenticity Tests
 *
 * Tests for unified webhook verification model:
 *  1. Valid signatures pass verification
 *  2. Invalid signatures fail fast
 *  3. Tampered payloads fail
 *  4. Replay verification works
 *  5. Missing signatures are caught
 */

const webhookAuthService = require('../services/webhookAuthenticityService');
const crypto = require('crypto');

describe('Webhook Authenticity Model (Unit Tests)', () => {
  
  beforeAll(() => {
    // Ensure webhook secret is set (it should be from .env)
    if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
      throw new Error('RAZORPAY_WEBHOOK_SECRET not set in .env');
    }
  });

  // ─── Test 1: Valid Signature Verification ──────────────────────────────────
  describe('Valid Signature Verification', () => {

    test('should verify valid HMAC-SHA256 signature', () => {
      const payload = '{"event":"payment.captured","payment":{"id":"pay_123"}}';
      const expectedSig = crypto
        .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
        .update(payload)
        .digest('hex');

      const result = webhookAuthService.verifyIngressSignature(payload, expectedSig, {
        eventId: 'evt_123',
      });

      expect(result.verified).toBe(true);
      expect(result.signature).toBe(expectedSig);
      expect(result.payloadHash).toBeDefined();
    });

    test('should extract payload bytes correctly', () => {
      const json = { event: 'payment.captured', payment_id: 'pay_456' };
      const payload = JSON.stringify(json);

      const extracted = webhookAuthService.extractPayloadBytes(payload);

      expect(extracted).toBe(payload);
    });
  });

  // ─── Test 2: Invalid Signature Rejection ───────────────────────────────────
  describe('Invalid Signature Rejection', () => {

    test('should reject invalid signature', () => {
      const payload = '{"event":"payment.captured"}';
      const invalidSig = 'invalid_signature_not_matching_payload';

      expect(() => {
        webhookAuthService.verifyIngressSignature(payload, invalidSig, {
          eventId: 'evt_123',
        });
      }).toThrow();
    });

    test('should reject missing payload', () => {
      const validSig = crypto
        .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
        .update('test')
        .digest('hex');

      expect(() => {
        webhookAuthService.verifyIngressSignature('', validSig, { eventId: 'evt_123' });
      }).toThrow();
    });

    test('should reject missing signature', () => {
      const payload = '{"event":"payment.captured"}';

      expect(() => {
        webhookAuthService.verifyIngressSignature(payload, '', { eventId: 'evt_123' });
      }).toThrow();
    });
  });

  // ─── Test 3: Tampered Payload Detection ────────────────────────────────────
  describe('Tampered Payload Detection', () => {

    test('should fail if payload is modified after signature', () => {
      const originalPayload = '{"amount":10000,"currency":"INR"}';
      const sig = crypto
        .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
        .update(originalPayload)
        .digest('hex');

      // Tamper with payload (change amount)
      const tamperedPayload = '{"amount":99999,"currency":"INR"}';

      expect(() => {
        webhookAuthService.verifyIngressSignature(tamperedPayload, sig, {
          eventId: 'evt_tampered',
        });
      }).toThrow('Signature mismatch');
    });

    test('should detect whitespace changes in payload', () => {
      const payload1 = '{"event":"payment.captured"}';
      const sig1 = crypto
        .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
        .update(payload1)
        .digest('hex');

      // Same data, different whitespace
      const payload2 = '{ "event" : "payment.captured" }';

      expect(() => {
        webhookAuthService.verifyIngressSignature(payload2, sig1, { eventId: 'evt_123' });
      }).toThrow('Signature mismatch');
    });
  });

  // ─── Test 4: Replay Signature Verification ─────────────────────────────────
  describe('Replay Signature Verification', () => {

    test('should verify replay signature matches stored data', () => {
      const storedPayload = '{"event":"refund.processed","refund":{"id":"rfnd_123"}}';
      const storedSig = crypto
        .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
        .update(storedPayload)
        .digest('hex');

      const result = webhookAuthService.verifyReplaySignature(storedPayload, storedSig, {
        eventId: 'evt_replay',
      });

      expect(result.verified).toBe(true);
      expect(result.signature).toBe(storedSig);
    });

    test('should reject replay if stored payload is corrupted', () => {
      const storedPayload = '{"event":"refund.processed"}';
      const storedSig = crypto
        .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
        .update(storedPayload)
        .digest('hex');

      // Simulate corruption: stored data changed
      const corruptedPayload = '{"event":"refund.processed", "amount": 50000}';

      expect(() => {
        webhookAuthService.verifyReplaySignature(corruptedPayload, storedSig, {
          eventId: 'evt_corrupted',
        });
      }).toThrow();
    });

    test('should reject replay if stored signature is corrupted', () => {
      const storedPayload = '{"event":"payment.captured"}';
      const storedSig = crypto
        .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
        .update(storedPayload)
        .digest('hex');

      const corruptedSig = storedSig.substring(0, 32) + 'corrupted' + storedSig.substring(41);

      expect(() => {
        webhookAuthService.verifyReplaySignature(storedPayload, corruptedSig, {
          eventId: 'evt_sig_corrupted',
        });
      }).toThrow();
    });
  });

  // ─── Test 5: Webhook Verification Assertion ────────────────────────────────
  describe('Webhook Verification Assertion', () => {

    test('should assert webhook is authenticated', () => {
      const webhook = {
        id: 'evt_123',
        signature: 'some_signature_hash',
        verified_at: new Date(),
        verified_by_lease_version: 1,
      };

      // Should NOT throw
      expect(() => {
        webhookAuthService.assertWebhookVerified(webhook, { eventId: 'evt_123' });
      }).not.toThrow();
    });

    test('should reject webhook without signature', () => {
      const webhook = {
        id: 'evt_123',
        verified_at: new Date(),
        verified_by_lease_version: 1,
      };

      expect(() => {
        webhookAuthService.assertWebhookVerified(webhook, { eventId: 'evt_123' });
      }).toThrow();
    });

    test('should reject webhook without verified_at', () => {
      const webhook = {
        id: 'evt_123',
        signature: 'some_signature_hash',
        verified_by_lease_version: 1,
      };

      expect(() => {
        webhookAuthService.assertWebhookVerified(webhook, { eventId: 'evt_123' });
      }).toThrow();
    });

    test('should reject webhook without lease ownership', () => {
      const webhook = {
        id: 'evt_123',
        signature: 'some_signature_hash',
        verified_at: new Date(),
      };

      expect(() => {
        webhookAuthService.assertWebhookVerified(webhook, { eventId: 'evt_123' });
      }).toThrow();
    });
  });

  // ─── Test 6: Payload Bytes Extraction ──────────────────────────────────────
  describe('Payload Bytes Extraction', () => {

    test('should extract string payload as-is', () => {
      const payload = '{"event":"payment.captured"}';
      const extracted = webhookAuthService.extractPayloadBytes(payload);
      expect(extracted).toBe(payload);
    });

    test('should extract Buffer to string', () => {
      const buffer = Buffer.from('{"event":"payment.captured"}');
      const extracted = webhookAuthService.extractPayloadBytes(buffer);
      expect(extracted).toBe('{"event":"payment.captured"}');
    });

    test('should extract object by re-stringifying', () => {
      const obj = { event: 'payment.captured', amount: 10000 };
      const extracted = webhookAuthService.extractPayloadBytes(obj);
      expect(extracted).toBe(JSON.stringify(obj));
    });

    test('should handle empty/null gracefully', () => {
      const extracted1 = webhookAuthService.extractPayloadBytes(null);
      const extracted2 = webhookAuthService.extractPayloadBytes('');
      const extracted3 = webhookAuthService.extractPayloadBytes(undefined);

      expect(extracted1).toBe('');
      expect(extracted2).toBe('');
      expect(extracted3).toBe('');
    });
  });
});

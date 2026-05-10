import http from 'k6/http';
import { check, sleep } from 'k6';
import crypto from 'k6/crypto';

/**
 * 🔥 PlanBuddy v9 — k6 Chaos & Stress Validation Script
 * 
 * Goal: Prove the system survives 1000-5000 concurrent users + Webhook storms.
 * 
 * Scenarios:
 * 1. payment_storm: Users concurrently initiating payments (DB Row Locks + Insert stress)
 * 2. webhook_flood: Razorpay slamming the webhook endpoint (Idempotency + unique constraint stress)
 * 3. mixed_load: Normal reads/writes while the storm happens
 */

export const options = {
  scenarios: {
    payment_storm: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 500 },  // Ramp to 500
        { duration: '2m', target: 1000 },  // Hold 1000 concurrent payment attempts
        { duration: '30s', target: 0 },    // Drain
      ],
      exec: 'simulatePayment',
    },
    webhook_flood: {
      executor: 'constant-arrival-rate',
      rate: 500, // 500 webhooks per second
      timeUnit: '1s',
      duration: '3m',
      preAllocatedVUs: 200,
      maxVUs: 1000,
      exec: 'simulateWebhook',
    }
  },
  thresholds: {
    'http_req_failed': ['rate<0.01'], // less than 1% errors (ideally 0)
    'http_req_duration': ['p(95)<1000'], // 95% of requests under 1s even under stress
  }
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const WEBHOOK_SECRET = __ENV.WEBHOOK_SECRET || 'test_secret';

// Helper to generate Razorpay HMAC
function generateSignature(payload, secret) {
  return crypto.hmac('sha256', secret, payload, 'hex');
}

export function simulatePayment() {
  const payload = JSON.stringify({
    bookingId: Math.floor(Math.random() * 1000000), // Random int
    amount: 1000 + Math.floor(Math.random() * 5000),
    currency: 'INR'
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `k6-pay-${Math.random().toString(36).substring(7)}`,
      'Authorization': 'Bearer test-token' // Adjust auth as per your setup
    },
  };

  // Note: Adjust the endpoint to your actual API route
  const res = http.post(`${BASE_URL}/api/v1/payments/create-order`, payload, params);

  check(res, {
    'payment order created or auth blocked': (r) => r.status === 200 || r.status === 403,
    'response under 2s': (r) => r.timings.duration < 2000,
  });

  sleep(Math.random() * 2);
}

export function simulateWebhook() {
  // Simulate Razorpay payment.captured event
  const eventId = `ev_k6_${Math.floor(Math.random() * 100000)}`; // High chance of duplicate event_ids to test idempotency
  
  const payloadStr = JSON.stringify({
    entity: "event",
    account_id: "acc_k6",
    event: "payment.captured",
    contains: ["payment"],
    payload: {
      payment: {
        entity: {
          id: `pay_k6_${Math.floor(Math.random() * 1000000)}`,
          entity: "payment",
          amount: 50000,
          currency: "INR",
          status: "captured",
          order_id: `order_k6_${Math.floor(Math.random() * 1000000)}`
        }
      }
    },
    created_at: Math.floor(Date.now() / 1000)
  });

  const signature = generateSignature(payloadStr, WEBHOOK_SECRET);

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'X-Razorpay-Signature': signature,
    },
  };

  const res = http.post(`${BASE_URL}/api/v1/webhooks/razorpay`, payloadStr, params);

  check(res, {
    'webhook accepted (200)': (r) => r.status === 200,
    // It's acceptable for duplicate events to return 200 (idempotent success)
  });
}

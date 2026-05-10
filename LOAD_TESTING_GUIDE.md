# 🧪 LOAD TESTING GUIDE FOR planbuddy.in

This guide provides scripts and instructions for load testing your production system.

---

## 1. PRE-TESTING CHECKLIST

- [ ] Test environment mirrors production (same DB size, Redis, etc.)
- [ ] All monitoring is enabled (Prometheus, Grafana, logs)
- [ ] Database backups are current
- [ ] Team is aware of testing window
- [ ] Rollback plan is documented

---

## 2. INSTALL DEPENDENCIES

```bash
npm install -g artillery
npm install -g k6
```

---

## 3. LOAD TEST SCRIPTS

### Script 1: Basic API Load Test (Artillery)
```yaml
# load-tests/api-load-test.yml
config:
  target: "https://api.planbuddy.in"
  phases:
    - duration: 60
      arrivalRate: 10
    - duration: 120
      arrivalRate: 50
    - duration: 60
      arrivalRate: 100
    - duration: 60
      arrivalRate: 10
  defaults:
    headers:
      Authorization: "Bearer YOUR_TEST_TOKEN"
      Content-Type: "application/json"

scenarios:
  - name: "Health check"
    flow:
      - get:
          url: "/health"

  - name: "Get user profile"
    flow:
      - get:
          url: "/api/user/profile"

  - name: "Create booking"
    flow:
      - post:
          url: "/api/bookings"
          json:
            date: "2026-05-10"
            time: "10:00"
            duration: 60

  - name: "Initiate payment"
    flow:
      - post:
          url: "/api/payments/create-order"
          json:
            amount: 1000
            currency: "INR"
```

Run:
```bash
artillery run load-tests/api-load-test.yml --output load-test-results.json
```

### Script 2: Payment Flow Stress Test (k6)
```javascript
// load-tests/payment-stress-test.js
import http from 'k/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

// Custom metrics
const errorRate = new Rate('errors');

export const options = {
  scenarios: {
    contact_form: {
      executor: 'ramping-arrival-rate',
      preAllocatedVUs: 100,
      timeUnit: '1s',
      startArrivalRate: 10,
      targetArrivalRate: 200,
      stages: [
        { duration: '2m', target: 50 },   // Ramp up to 50 req/s
        { duration: '5m', target: 50 },   // Stay at 50 req/s
        { duration: '2m', target: 100 },  // Ramp up to 100 req/s
        { duration: '5m', target: 100 },  // Stay at 100 req/s
        { duration: '2m', target: 200 },  // Ramp up to 200 req/s
        { duration: '5m', target: 200 },  // Stay at 200 req/s
        { duration: '2m', target: 0 },    // Ramp down to 0
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'], // Error rate < 1%
    http_req_duration: ['p(95)<2000'], // 95% of requests < 2s
    errors: ['rate<0.1'], // Custom error rate < 10%
  },
};

export default function() {
  const baseUrl = 'https://api.planbuddy.in';
  const token = __ENV.TEST_TOKEN;
  
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  // Test payment creation
  const paymentRes = http.post(
    `${baseUrl}/api/payments/create-order`,
    JSON.stringify({ amount: 1000, currency: 'INR' }),
    { headers }
  );

  check(paymentRes, {
    'payment order created': (r) => r.status === 200,
    'has order_id': (r) => JSON.parse(r.body).order_id !== undefined,
  });

  errorRate.add(paymentRes.status !== 200);
  sleep(1);
}
```

Run:
```bash
k6 run load-tests/payment-stress-test.js
```

### Script 3: Webhook Storm Simulation
```javascript
// load-tests/webhook-storm.js
import http from 'k/http';
import { check } from 'k6';

export const options = {
  scenarios: {
    webhook_storm: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 50 },   // Ramp up to 50 concurrent webhooks
        { duration: '5m', target: 50 },   // Sustain
        { duration: '1m', target: 100 },  // Spike to 100
        { duration: '2m', target: 100 },  // Sustain
        { duration: '1m', target: 0 },    // Ramp down
      ],
    },
  },
};

export default function() {
  const webhookUrl = 'https://api.planbuddy.in/webhooks/razorpay';
  
  // Simulate Razorpay webhook payload
  const payload = {
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: "pay_" + Math.random().toString(36).substr(2, 9),
          amount: 1000,
          currency: "INR",
          status: "captured"
        }
      }
    }
  };

  const res = http.post(webhookUrl, JSON.stringify(payload), {
    headers: {
      'Content-Type': 'application/json',
      'X-Razorpay-Signature': 'test_signature' // You'll need valid signature
    }
  });

  check(res, {
    'webhook processed': (r) => r.status === 200,
  });
}
```

Run:
```bash
k6 run load-tests/webhook-storm.js
```

---

## 4. MONITORING DURING TESTS

### Key Metrics to Watch:

1. **Database**
   - Connection pool usage (should stay < 80%)
   - Query latency (p95 < 500ms)
   - Deadlock rate (should be 0)

2. **Redis**
   - Memory usage (should stay < 70%)
   - Connection count
   - Command latency

3. **Application**
   - CPU usage (should stay < 70%)
   - Memory usage (should stay < 80%)
   - Event loop lag (Node.js)
   - Active connections

4. **Queues**
   - Job processing rate
   - Queue depth
   - DLQ rate (should be < 1%)

### Grafana Dashboards:
- Node Exporter Full
- PostgreSQL Overview
- Redis Dashboard
- Custom App Metrics

---

## 5. CHAOS ENGINEERING TESTS

### Test 1: Database Failover
```bash
# If using AWS RDS:
aws rds reboot-db-instance --db-instance-identifier planbuddy-db --force-failover

# Monitor application behavior
```

### Test 2: Redis Failure
```bash
# Stop Redis temporarily
sudo systemctl stop redis

# Monitor application behavior (should degrade gracefully)
```

### Test 3: High Memory Pressure
```bash
# Use stress-ng to simulate memory pressure
sudo apt install stress-ng
stress-ng --vm 2 --vm-bytes 1G --timeout 300s
```

---

## 6. POST-TEST ANALYSIS

### Generate Report:
```bash
# For Artillery results
artillery report load-test-results.json

# For k6 results (if using cloud)
k6 convert --output-format=har load-test-results.json
```

### Analyze:
1. Check error rates by endpoint
2. Identify slowest endpoints
3. Review database slow query logs
4. Check for memory leaks
5. Review queue processing times

---

## 7. ACCEPTANCE CRITERIA

Your system passes load testing if:

- ✅ Error rate < 1% under normal load (50 req/s)
- ✅ Error rate < 5% under peak load (200 req/s)
- ✅ 95% of requests < 2 seconds
- ✅ No data corruption or duplicate payments
- ✅ System recovers automatically from failures
- ✅ DLQ rate < 1%
- ✅ No memory leaks (memory usage stable)
- ✅ Database connections stay within pool limits

---

## 8. TEST SCHEDULE

| Test Type | Duration | Frequency |
|-----------|----------|-----------|
| Basic API Load | 5 min | Weekly |
| Payment Stress | 15 min | Before major releases |
| Webhook Storm | 10 min | Monthly |
| Chaos Engineering | 30 min | Quarterly |
| Full System | 1 hour | Before major launches |

---

**Estimated Time:** 4-8 hours for complete testing cycle
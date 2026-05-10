# 🚀 DEPLOYMENT RUNBOOK FOR planbuddy.in

Step-by-step instructions for deploying to production.

---

## PRE-DEPLOYMENT CHECKLIST

- [ ] All code changes tested in staging
- [ ] Database migration scripts reviewed
- [ ] Rollback plan documented
- [ ] Team notified of deployment window
- [ ] Monitoring dashboards ready
- [ ] On-call engineer available

---

## DEPLOYMENT STEPS

### Step 1: Database Migration

```bash
# Connect to production database
psql $DATABASE_URL

# Run migration 184
\i planbuddy_v9/migrations/184_add_idempotency_key_to_refunds.sql

# Verify migration
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'refunds' AND column_name = 'idempotency_key';

# Expected output:
#  column_name    | data_type
# ----------------+------------------
#  idempotency_key | character varying
```

### Step 2: Deploy Application Code

```bash
# SSH to production server
ssh deploy@planbuddy.in

# Navigate to application directory
cd /var/www/planbuddy

# Pull latest code
git pull origin main

# Install dependencies
npm ci --only=production

# Build if needed
npm run build

# Restart application
pm2 restart planbuddy-api

# Check status
pm2 status
```

### Step 3: Verify Deployment

```bash
# Check health endpoint
curl https://api.planbuddy.in/health

# Expected response:
# {"status":"ok","timestamp":"2026-05-09T...","version":"1.0.0"}

# Check metrics endpoint
curl https://api.planbuddy.in/metrics

# Test payment flow
curl -X POST https://api.planbuddy.in/api/payments/create-order \
  -H "Authorization: Bearer YOUR_TEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"amount":1000,"currency":"INR"}'

# Verify logs
pm2 logs planbuddy-api --lines 50
```

### Step 4: Monitor Post-Deployment

1. **Check Grafana Dashboards**
   - Application metrics
   - Error rates
   - Response times
   - Database connections

2. **Check Logs**
   ```bash
   # Real-time logs
   pm2 logs planbuddy-api

   # Search for errors
   grep -i "error" $(pm2 status | grep planbuddy | awk '{print $6}' | sed 's/.*\///')/*.log
   ```

3. **Monitor Queue Processing**
   ```bash
   # Check queue depth
   redis-cli -u $REDIS_URL LLEN payment_queue
   redis-cli -u $REDIS_URL LLEN webhook_queue
   ```

---

## ROLLBACK PROCEDURE

If issues are detected:

### Quick Rollback:

```bash
# SSH to server
ssh deploy@planbuddy.in

# Revert to previous version
cd /var/www/planbuddy
git reset --hard HEAD~1

# Restart application
pm2 restart planbuddy-api

# Verify rollback
curl https://api.planbuddy.in/health
```

### Database Rollback (if needed):

```sql
-- Connect to database
psql $DATABASE_URL

-- Remove idempotency_key column
ALTER TABLE refunds DROP COLUMN IF EXISTS idempotency_key;

-- Verify
SELECT column_name FROM information_schema.columns WHERE table_name = 'refunds';
```

---

## POST-DEPLOYMENT VERIFICATION

### Automated Smoke Tests:

```bash
#!/bin/bash
# deploy/smoke-test.sh

BASE_URL="https://api.planbuddy.in"
TOKEN="YOUR_TEST_TOKEN"

echo "Running smoke tests..."

# Test 1: Health check
response=$(curl -s -o /dev/null -w "%{http_code}" $BASE_URL/health)
if [ "$response" -ne 200 ]; then
  echo "❌ Health check failed"
  exit 1
fi
echo "✅ Health check passed"

# Test 2: Create payment order
response=$(curl -s -w "\n%{http_code}" -X POST $BASE_URL/api/payments/create-order \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"amount":100,"currency":"INR"}')

http_code=$(echo "$response" | tail -n1)
if [ "$http_code" -ne 200 ]; then
  echo "❌ Payment order creation failed"
  exit 1
fi
echo "✅ Payment order creation passed"

# Test 3: Get user profile
response=$(curl -s -w "\n%{http_code}" -X GET $BASE_URL/api/user/profile \
  -H "Authorization: Bearer $TOKEN")

http_code=$(echo "$response" | tail -n1)
if [ "$http_code" -ne 200 ]; then
  echo "❌ User profile fetch failed"
  exit 1
fi
echo "✅ User profile fetch passed"

echo "✅ All smoke tests passed"
```

Run:
```bash
bash deploy/smoke-test.sh
```

---

## INCIDENT RESPONSE

### Critical Alerts:

1. **High Error Rate (>5%)**
   - Check application logs: `pm2 logs planbuddy-api`
   - Check database connections: `SELECT count(*) FROM pg_stat_activity;`
   - Check Redis: `redis-cli -u $REDIS_URL PING`
   - Consider rollback if not resolved in 5 minutes

2. **Database Connection Pool Exhaustion**
   - Check active connections: `SELECT count(*) FROM pg_stat_activity;`
   - Check max connections: `SHOW max_connections;`
   - Restart application: `pm2 restart planbuddy-api`
   - If persistent, increase pool size in config

3. **Queue Backlog**
   - Check queue depth: `redis-cli -u $REDIS_URL LLEN payment_queue`
   - Check worker status: `pm2 status`
   - Restart workers: `pm2 restart all`
   - Scale workers if needed

4. **Payment Failures**
   - Check Razorpay status page
   - Verify API keys are correct
   - Check webhook signature validation
   - Review recent payment logs

---

## MONITORING DASHBOARD URLS

- **Grafana**: http://grafana.planbuddy.in:3001
- **Prometheus**: http://prometheus.planbuddy.in:9090
- **Uptime Kuma**: http://uptime.planbuddy.in:3002
- **Application Logs**: `pm2 logs planbuddy-api`

---

## CONTACT INFORMATION

- **On-Call Engineer**: +91-XXX-XXX-XXXX
- **Slack #alerts**: https://planbuddy.slack.com/channels/alerts
- **PagerDuty**: https://planbuddy.pagerduty.com

---

## DEPLOYMENT SCHEDULE

| Environment | Schedule | Frequency |
|-------------|----------|-----------|
| Staging | Anytime | As needed |
| Production | Tue/Thu 2-4 AM IST | Bi-weekly |
| Emergency | Anytime | As needed |

---

**Last Updated:** 2026-05-09
**Next Review:** 2026-06-09
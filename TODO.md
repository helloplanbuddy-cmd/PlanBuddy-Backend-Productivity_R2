# Fintech Production Upgrade TODO
Status: [4/24] Phase 1 Observability ✅

## Phase 1: Observability Stack (4/4 ✅)
- [x] 1.1 docker-compose-grafana.yml (Prometheus + Grafana)
- [x] 1.2 planbuddy_v8/utils/monitoring.js (queue_depth_gauge, db_lock_wait_histogram, idempotency_conflict_counter + cron collector)
- [x] 1.3 grafana/provisioning/dashboards/ (api-perf.json, payment-health.json, db-queue.json)
- [x] 1.4 docker-compose.override.yml (dev/prod network bridge)

**Phase 1 Test:** `docker compose -f docker-compose.yml -f docker-compose-grafana.yml up`
- Prometheus: localhost:9090/targets (api UP)
- Grafana: localhost:3001 (admin/admin) → 3 dashboards auto-provisioned
- Hit api:3000/api/health → see metrics populate

## Phase 2: External Alerting (4/4 ✅)
- [x] 2.1 services/alertingService.js: Added sendSlackAlert() for CRITICAL → Slack webhook (.env SLACK_WEBHOOK_URL)
- [x] 2.2 workers/alert-poller.worker.js: Cron 5min poll unacked CRITICAL >5min → escalate Slack (hour throttle)
- [x] 2.3 planbuddy_v8/ecosystem.config.js: Added planbuddy-alert-poller process (logs/alert-poller-*.log)
- [x] 2.4 grafana/prometheus/rules/alert.rules.yml + prometheus.yml: 6 rules (error_rate>1%, latency>500ms, queue>100, locks>250ms, idempotency>10/min, alert_storm>20/h)

**Phase 2 Test:** Add SLACK_WEBHOOK_URL=.env → PM2 start ecosystem.config.js → trigger alertPaymentFailed → Slack immediate + poller escalate

## Phase 3: Auto-Recovery Mechanisms (4/5 ✅)
- [x] 3.1 workers/dlq-processor.worker.js + migration 150 + ecosystem dlq-processor
- [x] 3.2 queue depths in monitoring cron → queue_depth gauge (Grafana alert QueueBacklog)
- [x] 3.3 pg_stat_activity Lock waits → db_lock_wait_ms histogram (Grafana LockContention)
- [x] 3.4 paymentController.js webhook retry counter (redis incr >3/5min → alertSystemOverload)
- [x] 3.5 PM2 integrated

**Phase 3 Test:** 1. Concurrent SELECT FOR UPDATE → Grafana lock_wait p95
2. Razorpay webhook fail loop → redis retry count → storm alert/Slack
3. Job fail 5x → DLQ table/Slack

## Phase 4: Chaos Engineering (0/3)
- [ ] 4.1 chaos/chaos.js (DB latency, worker kill, webhook storm CLI)
- [ ] 4.2 /internal/chaos/* admin routes (auth guarded)
- [ ] 4.3 README.md chaos guide

Next: Chaos engineering module


**Phase 3 Test:** Force job fail 5 retries → dlq_jobs populated, Slack alert, PM2 dlq-processor running

## Phase 4: Chaos Engineering (0/3)
...

Next: 3.3 DB lock metrics query



## Phase 3: Auto-Recovery (0/5)
...

Next: Phase 2.1 - External Slack integration to alertingService.js (add to .env.example too)


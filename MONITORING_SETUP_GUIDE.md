# 📊 MONITORING & ALERTING SETUP GUIDE FOR planbuddy.in

This guide provides complete instructions for setting up production monitoring and alerting.

---

## 1. GRAFANA + PROMETHEUS SETUP

### Quick Setup with Docker Compose:

```yaml
# docker-compose.monitoring.yml
version: '3.8'

services:
  prometheus:
    image: prom/prometheus:latest
    container_name: prometheus
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
      - prometheus_data:/prometheus
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
      - '--web.console.libraries=/etc/prometheus/console_libraries'
      - '--web.console.templates=/etc/prometheus/consoles'
      - '--storage.tsdb.retention.time=200h'
      - '--web.enable-lifecycle'
    networks:
      - monitoring

  grafana:
    image: grafana/grafana:latest
    container_name: grafana
    ports:
      - "3001:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=your_secure_password
      - GF_USERS_ALLOW_SIGN_UP=false
    volumes:
      - grafana_data:/var/lib/grafana
      - ./grafana/provisioning:/etc/grafana/provisioning
    networks:
      - monitoring

  alertmanager:
    image: prom/alertmanager:latest
    container_name: alertmanager
    ports:
      - "9093:9093"
    volumes:
      - ./alertmanager.yml:/etc/alertmanager/alertmanager.yml
    networks:
      - monitoring

volumes:
  prometheus_data:
  grafana_data:

networks:
  monitoring:
    driver: bridge
```

### Prometheus Configuration:

```yaml
# prometheus.yml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

alerting:
  alertmanagers:
    - static_configs:
        - targets:
          - alertmanager:9093

rule_files:
  - "alert_rules.yml"

scrape_configs:
  # Application metrics
  - job_name: 'planbuddy-app'
    static_configs:
      - targets: ['host.docker.internal:3000']
    metrics_path: '/metrics'

  # Node exporter
  - job_name: 'node-exporter'
    static_configs:
      - targets: ['host.docker.internal:9100']

  # PostgreSQL exporter
  - job_name: 'postgres'
    static_configs:
      - targets: ['host.docker.internal:9187']

  # Redis exporter
  - job_name: 'redis'
    static_configs:
      - targets: ['host.docker.internal:9121']
```

### Alert Rules:

```yaml
# alert_rules.yml
groups:
  - name: planbuddy_alerts
    rules:
      # High error rate
      - alert: HighErrorRate
        expr: rate(http_requests_total{status=~"5.."}[5m]) > 0.05
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "High error rate detected"
          description: "Error rate is above 5% for the last 5 minutes"

      # High response time
      - alert: HighResponseTime
        expr: histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m])) > 2
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High response time detected"
          description: "95th percentile response time is above 2 seconds"

      # Database connection pool exhaustion
      - alert: DatabasePoolExhaustion
        expr: db_pool_active / db_pool_max > 0.9
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Database connection pool near exhaustion"
          description: "Database connection pool usage is above 90%"

      # Queue backlog
      - alert: QueueBacklog
        expr: queue_depth > 1000
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Queue backlog detected"
          description: "Queue depth has exceeded 1000 jobs for 10 minutes"

      # DLQ rate
      - alert: HighDLQRate
        expr: rate(dlq_jobs_total[5m]) > 0.1
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "High dead letter queue rate"
          description: "DLQ rate is above 10% for the last 5 minutes"

      # Payment failures
      - alert: PaymentFailures
        expr: rate(payment_failures_total[5m]) > 0.05
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "High payment failure rate"
          description: "Payment failure rate is above 5% for the last 2 minutes"

      # Memory usage
      - alert: HighMemoryUsage
        expr: (node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes) / node_memory_MemTotal_bytes > 0.85
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High memory usage detected"
          description: "Memory usage is above 85%"

      # Disk space
      - alert: LowDiskSpace
        expr: (node_filesystem_avail_bytes / node_filesystem_size_bytes) * 100 < 15
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Low disk space"
          description: "Disk space is below 15%"
```

### Alertmanager Configuration:

```yaml
# alertmanager.yml
global:
  smtp_smarthost: 'smtp.gmail.com:587'
  smtp_from: 'alerts@planbuddy.in'
  smtp_auth_username: 'your-email@gmail.com'
  smtp_auth_password: 'your-app-password'

route:
  group_by: ['alertname']
  group_wait: 10s
  group_interval: 10s
  repeat_interval: 1h
  receiver: 'email-notifications'
  routes:
    - match:
        severity: critical
      receiver: 'critical-alerts'

receivers:
  - name: 'email-notifications'
    email_configs:
      - to: 'team@planbuddy.in'
        send_resolved: true

  - name: 'critical-alerts'
    email_configs:
      - to: 'oncall@planbuddy.in'
        send_resolved: true
    webhook_configs:
      - url: 'https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK'
```

---

## 2. APPLICATION METRICS INSTRUMENTATION

### Add to your Express app:

```javascript
// Add to planbuddy_v9/app.js or create middleware/metrics.js

const client = require('prom-client');

// Create a Registry
const register = new client.Registry();
client.collectDefaultMetrics({ register });

// Custom metrics
const httpRequestDurationMicroseconds = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5, 7, 10]
});

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code']
});

const activeConnections = new client.Gauge({
  name: 'active_connections',
  help: 'Number of active connections'
});

const queueDepth = new client.Gauge({
  name: 'queue_depth',
  help: 'Current queue depth',
  labelNames: ['queue_name']
});

const paymentFailuresTotal = new client.Counter({
  name: 'payment_failures_total',
  help: 'Total number of payment failures',
  labelNames: ['reason']
});

const dlqJobsTotal = new client.Counter({
  name: 'dlq_jobs_total',
  help: 'Total number of jobs sent to DLQ',
  labelNames: ['queue_name', 'reason']
});

register.registerMetric(httpRequestDurationMicroseconds);
register.registerMetric(httpRequestsTotal);
register.registerMetric(activeConnections);
register.registerMetric(queueDepth);
register.registerMetric(paymentFailuresTotal);
register.registerMetric(dlqJobsTotal);

// Metrics middleware
app.use((req, res, next) => {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    const route = req.route ? req.route.path : req.path;
    
    httpRequestDurationMicroseconds
      .labels(req.method, route, res.statusCode)
      .observe(duration);
    
    httpRequestsTotal
      .labels(req.method, route, res.statusCode)
      .inc();
  });
  
  next();
});

// Metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// Export for use in other modules
module.exports = {
  activeConnections,
  queueDepth,
  paymentFailuresTotal,
  dlqJobsTotal
};
```

---

## 3. GRAFANA DASHBOARDS

### Import These Dashboards:

1. **Node Exporter Full** (ID: 1860)
   - System metrics, CPU, memory, disk, network

2. **PostgreSQL Overview** (ID: 9628)
   - Database performance, connections, queries

3. **Redis Dashboard** (ID: 763)
   - Redis metrics, memory, connections

4. **Custom App Dashboard** (create manually):
   - HTTP request rate
   - Error rate by endpoint
   - Response time percentiles
   - Active connections
   - Queue depth
   - Payment success/failure rate
   - DLQ rate

### Dashboard JSON Export:
Save your custom dashboard as `grafana/dashboards/planbuddy-app.json`

---

## 4. LOG AGGREGATION

### Option A: Loki + Promtail (Lightweight)

```yaml
# docker-compose.loki.yml
version: '3.8'

services:
  loki:
    image: grafana/loki:latest
    container_name: loki
    ports:
      - "3100:3100"
    command: -config.file=/etc/loki/local-config.yaml
    volumes:
      - loki_data:/loki
    networks:
      - monitoring

  promtail:
    image: grafana/promtail:latest
    container_name: promtail
    volumes:
      - /var/log:/var/log
      - ./promtail-config.yml:/etc/promtail/config.yml
    command: -config.file=/etc/promtail/config.yml
    networks:
      - monitoring

volumes:
  loki_data:

networks:
  monitoring:
    driver: bridge
```

### Option B: ELK Stack (More Features)

```yaml
# docker-compose.elk.yml
version: '3.8'

services:
  elasticsearch:
    image: docker.elastic.co/elasticsearch/elasticsearch:8.11.0
    container_name: elasticsearch
    environment:
      - discovery.type=single-node
      - xpack.security.enabled=false
    ports:
      - "9200:9200"
    volumes:
      - elasticsearch_data:/usr/share/elasticsearch/data

  logstash:
    image: docker.elastic.co/logstash/logstash:8.11.0
    container_name: logstash
    ports:
      - "5000:5000"
    volumes:
      - ./logstash.conf:/usr/share/logstash/pipeline/logstash.conf

  kibana:
    image: docker.elastic.co/kibana/kibana:8.11.0
    container_name: kibana
    ports:
      - "5601:5601"
    environment:
      - ELASTICSEARCH_URL=http://elasticsearch:9200

volumes:
  elasticsearch_data:
```

---

## 5. UPTIME MONITORING

### Uptime Kuma (Self-hosted):

```yaml
# docker-compose.uptime.yml
version: '3.8'

services:
  uptime-kuma:
    image: louislam/uptime-kuma:1
    container_name: uptime-kuma
    ports:
      - "3002:3001"
    volumes:
      - uptime_kuma_data:/app/data
    restart: always

volumes:
  uptime_kuma_data:
```

### Configure Monitors:
1. API Health: `https://api.planbuddy.in/health`
2. Website: `https://planbuddy.in`
3. Payment Endpoint: `https://api.planbuddy.in/api/payments/status`
4. Database: PostgreSQL connection check

---

## 6. INCIDENT RESPONSE SETUP

### PagerDuty Integration (Optional):

```yaml
# Add to alertmanager.yml
receivers:
  - name: 'pagerduty-critical'
    pagerduty_configs:
      - service_key: 'YOUR_PAGERDUTY_SERVICE_KEY'
        severity: 'critical'
```

### Slack Integration:

```yaml
# Add to alertmanager.yml
receivers:
  - name: 'slack-critical'
    slack_configs:
      - api_url: 'https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK'
        channel: '#alerts-critical'
        title: '{{ .Status | toUpper }}: {{ .CommonAnnotations.summary }}'
        text: '{{ .CommonAnnotations.description }}'
```

---

## 7. SYNTHETIC MONITORING

### Checkly (External Monitoring):

```javascript
// checkly/check-api.check.js
import { CheckBuilder, Frequency, Location } from '@checkly/cli'

const check = new CheckBuilder('api-health-check')
  .setName('API Health Check')
  .setFrequency(Frequency.EVERY_1M)
  .setLocations([Location.US_EAST_1])
  .setApiCheck({
    url: 'https://api.planbuddy.in/health',
    method: 'GET',
    assertions: [
      { source: 'STATUS_CODE', property: 'equals', target: '200' },
      { source: 'JSON_BODY', property: 'has_key', target: 'status' }
    ]
  })
  .build()
```

---

## 8. SETUP CHECKLIST

- [ ] Deploy Prometheus + Grafana
- [ ] Configure Prometheus scrape targets
- [ ] Import Grafana dashboards
- [ ] Set up alert rules
- [ ] Configure Alertmanager
- [ ] Add application metrics instrumentation
- [ ] Set up log aggregation (Loki or ELK)
- [ ] Configure uptime monitoring
- [ ] Set up Slack/email notifications
- [ ] Test alert delivery
- [ ] Create incident response runbooks
- [ ] Set up synthetic monitoring

---

## 9. MONITORING BEST PRACTICES

1. **Golden Signals**: Monitor latency, traffic, errors, saturation
2. **Red Lines**: Set clear thresholds for critical metrics
3. **Alert Fatigue**: Only alert on actionable items
4. **Runbooks**: Document response procedures for each alert
5. **Regular Reviews**: Weekly review of alerts and metrics
6. **Blameless Postmortems**: Learn from incidents without blame

---

**Estimated Time:** 4-6 hours for complete setup
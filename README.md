# PlanBuddy v8 Backend Productivity

Production-hardened Node.js backend for booking/payment system.

## Quick Start (Docker)
```bash
cd planbuddy_v8
docker-compose up -d
```

## Architecture
- PostgreSQL + advisory locks for concurrency safety
- Redis + BullMQ for queues/idempotency
- Razorpay payments with circuit breaker
- Risk detection + backpressure middleware

## Env Vars
Copy `.env.example` → `.env` and configure.

See `config/env.js` for required vars.

## Migrations
```bash
psql $DATABASE_URL -f migrations/*.sql  # Sequential order
```

**Phases Complete:**
- Phase 2: Financial Integrity
- Phase 3: Cancellation Fix + Concurrency
- Phase 4: Queue Reliability


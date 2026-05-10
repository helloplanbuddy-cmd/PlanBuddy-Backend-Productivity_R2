# PHASE 4: REMOVE WORKER RUNTIME AMBIGUITY

## Current State

```
planbuddy_v9_backend_productivity/
├── workers/  ← ROOT WORKERS (current canonical but confusing)
│   ├── email-dispatch.worker.js
│   ├── refund-retry.worker.js
│   ├── payment-reconciliation-queue.worker.js
│   ├── dlq-processor.worker.js
│   └── sessionCleanup.worker.js
│
└── planbuddy_v9/  ← APPLICATION DIRECTORY
    ├── workers/  ← BOOTSTRAP ONLY
    │   └── index.js  ← Loads workers from ../../workers/
    │
    ├── config/
    ├── controllers/
    ├── docker-compose.yml  ← Uses: node workers/index.js
    └── Dockerfile  ← WORKDIR /app
```

## Problem

- `planbuddy_v9/workers/index.js` is a loader that imports from `../../workers/`
- This creates ambiguity: which is the canonical location?
- New developers might put new workers in wrong place
- Docker mounting and PM2 processes might load from different paths
- When deployed, uncertainty about which workers are running

## Solution

### Move all workers into canonical location: `planbuddy_v9/workers/`

**New structure:**
```
planbuddy_v9/
├── workers/
│   ├── index.js  ← Bootstrap loader (stays)
│   ├── email-dispatch.worker.js  ← MOVED here
│   ├── refund-retry.worker.js  ← MOVED here
│   ├── payment-reconciliation-queue.worker.js  ← MOVED here
│   ├── dlq-processor.worker.js  ← MOVED here
│   └── sessionCleanup.worker.js  ← MOVED here
│
├── config/
├── controllers/
├── docker-compose.yml
└── Dockerfile
```

## Changes Required

### 1. Update `planbuddy_v9/workers/index.js`

Change worker module paths from `../../workers/xxx.js` to `./xxx.js`

```javascript
// BEFORE:
modulePath: '../../workers/email-dispatch.worker.js',

// AFTER:
modulePath: './email-dispatch.worker.js',
```

### 2. Copy worker files

Move all workers from root `workers/` to `planbuddy_v9/workers/`:
- email-dispatch.worker.js
- refund-retry.worker.js
- payment-reconciliation-queue.worker.js
- dlq-processor.worker.js
- sessionCleanup.worker.js

### 3. Clean up root

Delete `workers/` directory from root (no longer needed)

## Verification

After consolidation:

```bash
# Docker should work as-is
docker-compose up

# Workers should still load correctly
docker-compose logs workers | grep -E "worker_started|worker_ready"

# PM2 should still work
pm2 start ecosystem.config.js
pm2 logs | grep -E "worker_started|worker_ready"

# New developers know: "Workers are in planbuddy_v9/workers/"
ls -la planbuddy_v9/workers/
# Shows all actual worker files + index.js
```

## Why This Matters

✅ **Single source of truth** — One place for worker code
✅ **No path ambiguity** — Docker and PM2 use same location
✅ **Clearer git history** — All changes in one directory
✅ **Easier onboarding** — New developers know where to look
✅ **No import path confusion** — Relative paths simpler
✅ **Production safety** — No deployment surprises

## Status

Ready to implement consolidation.

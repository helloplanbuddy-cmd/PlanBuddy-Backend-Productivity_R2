'use strict';

/**
 * app.js — Express Application Assembly (v3.0)
 *
 * UPGRADES from v2.0:
 *  1. Trust proxy set for Render / Railway / nginx deployments (req.ip is correct).
 *  2. HTTPS enforcement in production (redirect HTTP → HTTPS).
 *  3. Request timing included in Prometheus histogram (not just counter).
 *  4. Pino logger used for request logging (replaced Winston in-line logger).
 *  5. Redis-backed idempotency middleware (replaces PG-backed).
 *  6. Redis-backed rate limiting (replaces PgRateLimitStore).
 *  7. CORS origins sourced from config/env.js (validated at startup).
 *  8. Raw webhook body path unchanged (correct in v2.0).
 *  9. asyncHandler imported — controllers use it via utils/asyncHandler.js.
 * 10. Global rate limiter applied to all /api/* routes.
 *
 * Module load order matters:
 *  config/env.js must be the first require (validates env, exits on failure).
 *  utils/logger.js depends on env.js.
 *  Everything else can be loaded in any order.
 */

// ── env MUST be first — validates all vars, exits on missing required ─────────
const env = require('./config/env');

const express    = require('express');
const cors       = require('cors');
const crypto     = require('crypto');

const routes      = require('./routes');
const errorHandler = require('./middleware/errorHandler');
const apiVersion   = require('./middleware/apiVersion');
const { globalLimiter } = require('./middleware/rateLimit');
const monitoring  = require('./utils/monitoring');
const logger      = require('./utils/logger');
// 🚀 PHASE 2B: Trace ID middleware for full request observability
const { traceIdMiddleware } = require('./middleware/traceId');
// 🚀 PHASE 2B: Internal observability endpoints
const internalRoutes = require('./routes/internal');

const app = express();

// ─── Trust proxy (Render / Railway / nginx — req.ip reflects real client IP) ──
// '1' = trust first proxy hop. Adjust to match your deployment topology.
app.set('trust proxy', 1);

// ─── HTTPS enforcement ────────────────────────────────────────────────────────
if (env.IS_PROD) {
  app.use((req, res, next) => {
    if (!req.secure && req.get('x-forwarded-proto') !== 'https') {
      return res.redirect(301, `https://${req.hostname}${req.originalUrl}`);
    }
    next();
  });
}

// ─── Security headers ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options',  'nosniff');
  res.setHeader('X-Frame-Options',         'DENY');
  res.setHeader('X-XSS-Protection',        '1; mode=block');
  res.setHeader('Referrer-Policy',         'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy',      'geolocation=(), camera=(), microphone=()');
  if (env.IS_PROD) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.removeHeader('X-Powered-By');
  next();
});

// ─── Request ID injection ─────────────────────────────────────────────────────
app.use((req, res, next) => {
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
});

// 🚀 PHASE 2B: Trace ID middleware — must come after requestId so it can inherit it.
// Wraps every request in AsyncLocalStorage with trace_id so ALL logger calls
// in this request automatically include { trace_id, service, user_id, booking_id }.
app.use(traceIdMiddleware);

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({
  origin(origin, callback) {
    if (!origin || env.CORS_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS: origin "${origin}" not allowed`));
    }
  },
  credentials:    true,
  methods:        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 'Authorization',
    'X-Correlation-Id', 'X-Request-Id', 'Idempotency-Key',
  ],
  exposedHeaders: ['X-Request-Id', 'X-API-Version'],
  maxAge:         600,
}));

// ─── Raw body for Razorpay webhook (MUST come before express.json) ────────────
// Path matches the ACTUAL registered route — both versioned and legacy
app.use('/api/v1/payment/webhook/razorpay', express.raw({ type: 'application/json', limit: '100kb' }));
app.use('/api/payment/webhook/razorpay',    express.raw({ type: 'application/json', limit: '100kb' }));

// ─── JSON / URL-encoded body parsers ─────────────────────────────────────────
app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: true, limit: '512kb' }));

// ─── Global rate limiter (all /api/* routes) ──────────────────────────────────
app.use('/api', globalLimiter);

// 🚀 PHASE 4: Backpressure middleware (request throttling)
const { backpressureMiddleware } = require('./middleware/backpressure');
app.use(backpressureMiddleware);

// ─── Prometheus /metrics endpoint (internal IPs only) ─────────────────────────
app.get('/metrics', async (req, res) => {
  const clientIp = req.ip || req.socket.remoteAddress;

  if (!env.METRICS_ALLOWED_IPS.includes(clientIp)) {
    logger.warn({ clientIp, requestId: req.requestId }, '[metrics] Access denied');
    return res.status(403).end('Forbidden');
  }

  res.set('Content-Type', monitoring.register.contentType);
  res.end(await monitoring.register.metrics());
});

// ─── Prometheus request counter + duration histogram ─────────────────────────
app.use((req, res, next) => {
  const start = Date.now();

  monitoring.request_total.inc({ method: req.method, path: req.path });

  res.on('finish', () => {
    const durationMs = Date.now() - start;
    monitoring.request_duration_ms.observe(
      { method: req.method, path: req.path, status: res.statusCode },
      durationMs
    );
  });

  next();
});

// ─── Structured Pino request logging ─────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const durationMs = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

    logger[level]({
      requestId:  req.requestId,
      method:     req.method,
      path:       req.path,
      status:     res.statusCode,
      durationMs,
      ip:         req.ip,
      userId:     req.user?.id,
      apiVersion: req.apiVersion,
    }, 'HTTP request');
  });

  next();
});

// ─── API Routes — versioned (canonical) ──────────────────────────────────────
app.use('/api/v1', apiVersion('v1'), routes);

// ─── API Routes — legacy (backward compat) ───────────────────────────────────
app.use('/api', apiVersion('legacy'), routes);

// 🚀 PHASE 2B: Internal observability routes (metrics + failed-jobs)
// NOT under /api/v1 — internal-only, IP-guarded or admin-JWT-guarded
app.use('/internal', internalRoutes);

// ─── Root ─────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    success:   true,
    message:   'PlanBuddy Backend API',
    version:   '6.0.0',
    apiUrl:    '/api/v1',
    timestamp: new Date().toISOString(),
  });
});

// ─── 404 handler ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found.',
    path:    req.path,
    code:    'NOT_FOUND',
  });
});

// ─── Centralised error handler (MUST be last middleware) ──────────────────────
app.use(errorHandler);

const port = process.env.PORT || 3000;
const server = app.listen(port, () => console.log(`Server running on port ${port}`));

// ─── Graceful shutdown (SIGTERM) ──────────────────────────────────────────────
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — starting graceful shutdown');

  // 1. Stop accepting new connections
  server.close(async () => {
    logger.info('HTTP server closed — no new connections');

    // 2. Close BullMQ queues
    try {
      const { closeQueues } = require('./config/queues');
      await closeQueues();
      logger.info('BullMQ queues closed');
    } catch (err) {
      logger.error({ err }, 'Error closing queues');
    }

    // 3. Close DB connections
    try {
      const db = require('./config/db');
      await db.end();
      logger.info('DB connections closed');
    } catch (err) {
      logger.error({ err }, 'Error closing DB');
    }

    logger.info('Graceful shutdown complete');
    process.exit(0);
  });

  // Timeout fallback (30s)
  setTimeout(() => {
    logger.error('Graceful shutdown timeout — forcing exit');
    process.exit(1);
  }, 30000);
});

module.exports = app;

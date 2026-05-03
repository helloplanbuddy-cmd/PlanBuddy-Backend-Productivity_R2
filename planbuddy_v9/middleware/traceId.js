'use strict';

/**
 * middleware/traceId.js — Trace ID Middleware (v6.0)
 *
 * 🚀 PHASE 2B — PlanBuddy v6.0 Full Observability
 *
 * PURPOSE:
 *  - Generates or inherits a trace_id for every inbound HTTP request
 *  - Stores trace_id in AsyncLocalStorage so ALL logger calls in the
 *    request lifecycle automatically include it (no manual threading required)
 *  - Attaches trace_id to res headers for client-side correlation
 *  - Populates req.traceId for use in controllers/services
 *
 * FORMAT of every log line produced during a request:
 *   { timestamp, level, trace_id, service, user_id, booking_id, message, ...metadata }
 *
 * USAGE (already wired in app.js — no changes needed in controllers):
 *   app.use(require('./middleware/traceId'));
 *
 * Middleware order in app.js:
 *   1. traceId  ← must come FIRST so all subsequent middleware has trace_id
 *   2. authenticate (populates req.user → updates trace context with user_id)
 *   3. routes / controllers
 */

const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * traceIdMiddleware
 *
 * Reads X-Trace-Id header (from upstream gateway / client) or generates a new UUID.
 * Runs the rest of the request inside AsyncLocalStorage with the trace context.
 */
function traceIdMiddleware(req, res, next) {
  // 🚀 PHASE 2B: Accept upstream trace ID or generate one
  const traceId =
    req.headers['x-trace-id'] ||
    req.headers['x-correlation-id'] ||
    req.requestId ||                  // may already be set by app.js requestId middleware
    crypto.randomUUID();

  // Attach to request object for controllers/services to read directly
  req.traceId = traceId;

  // Propagate to response headers for client-side / API-gateway correlation
  res.setHeader('X-Trace-Id', traceId);

  // 🚀 PHASE 2B: Run everything downstream inside a trace context.
  // logger.mixin() reads from traceStorage → auto-injects trace_id into every log line.
  const traceContext = {
    trace_id: traceId,
    service:  'planbuddy-api',
    // user_id and booking_id are NOT available yet here — they are added
    // by updateTraceContext() after authentication / booking resolution.
  };

  logger.runWithTrace(traceContext, () => {
    next();
  });
}

/**
 * updateTraceContext — call this after authentication to add user_id to the context.
 * Also call after resolving a booking to add booking_id.
 *
 * This mutates the current AsyncLocalStorage store in-place, so all subsequent
 * log calls in the same request will include the updated fields.
 *
 * @param {object} fields — { user_id?, booking_id?, service? }
 */
function updateTraceContext(fields) {
  const store = logger.traceStorage.getStore();
  if (store) {
    Object.assign(store, fields);
  }
}

module.exports = { traceIdMiddleware, updateTraceContext };

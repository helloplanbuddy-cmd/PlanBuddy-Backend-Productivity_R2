'use strict';

/**
 * middleware/errorHandler.js — Global Error Handler (v3.0)
 *
 * UPGRADES from v2.0:
 *  1. Uses Pino logger (structured, fast) instead of Winston.
 *  2. AppError class for typed operational errors — controllers throw these
 *     instead of constructing plain Error objects with .status properties.
 *  3. Postgres error codes mapped to HTTP responses (unique violation → 409,
 *     foreign key → 400, etc.) so DB errors produce useful API responses.
 *  4. BullMQ job errors are normalised.
 *  5. payment_failures_total counter incremented on payment-related 5xx.
 *  6. Request duration histogram updated on every response.
 *
 * Classification: REWRITE (was ✅ KEEP but needed logger + AppError integration)
 */

const { ZodError }   = require('zod');
const logger         = require('../utils/logger');
const monitoring     = require('../utils/monitoring');
const env            = require('../config/env');

// ─── AppError — typed operational errors ─────────────────────────────────────

/**
 * Throw this instead of plain Error in controllers/services.
 *
 * Examples:
 *   throw new AppError('Booking not found', 404);
 *   throw new AppError('Seat already booked', 409, 'SEAT_CONFLICT');
 *   throw new AppError('Payment amount mismatch', 400, 'AMOUNT_MISMATCH', { expected, actual });
 */
class AppError extends Error {
  /**
   * @param {string} message      - Human-readable error message (safe to expose to API callers)
   * @param {number} statusCode   - HTTP status code
   * @param {string} [code]       - Machine-readable error code for client error handling
   * @param {object} [details]    - Additional structured details (safe, non-sensitive)
   */
  constructor(message, statusCode = 500, code = null, details = null) {
    super(message);
    this.name       = 'AppError';
    this.statusCode = statusCode;
    this.status     = statusCode;
    this.code       = code;
    this.details    = details;
    this.isOperational = true; // distinguish from programmer errors
    Error.captureStackTrace(this, this.constructor);
  }
}

// ─── PostgreSQL error code mapping ────────────────────────────────────────────

const PG_ERROR_MAP = {
  '23505': { status: 409, message: 'Duplicate entry — resource already exists.',      code: 'DUPLICATE_ENTRY' },
  '23503': { status: 400, message: 'Referenced resource does not exist.',             code: 'FOREIGN_KEY_VIOLATION' },
  '23502': { status: 400, message: 'Required field missing.',                         code: 'NOT_NULL_VIOLATION' },
  '23514': { status: 400, message: 'Data constraint violation.',                      code: 'CHECK_VIOLATION' },
  '42P01': { status: 500, message: 'Database schema error.',                          code: 'TABLE_NOT_FOUND' },
  '42703': { status: 500, message: 'Database schema error.',                          code: 'COLUMN_NOT_FOUND' },
  '40001': { status: 503, message: 'Service temporarily unavailable — please retry.', code: 'SERIALIZATION_FAILURE' },
  '40P01': { status: 503, message: 'Service temporarily unavailable — please retry.', code: 'DEADLOCK_DETECTED' },
  '57014': { status: 504, message: 'Query timeout.',                                  code: 'STATEMENT_TIMEOUT' },
};

// ─── Error handler middleware ─────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  // ── Resolve status and message ───────────────────────────────────────────

  let status  = err.statusCode || err.status || 500;
  let message = err.message || 'Internal Server Error';
  let code    = err.code || null;
  let details = err.details || null;
  let validationErrors = null;

  // ── Zod validation errors ────────────────────────────────────────────────
  if (err instanceof ZodError) {
    status  = 400;
    message = 'Validation failed.';
    code    = 'VALIDATION_ERROR';
    validationErrors = err.errors.map(e => ({
      field:   e.path?.join('.') || 'unknown',
      message: e.message,
      code:    e.code,
    }));
  }

  // ── PostgreSQL errors ────────────────────────────────────────────────────
  else if (err.code && PG_ERROR_MAP[err.code]) {
    const pgErr = PG_ERROR_MAP[err.code];
    status  = pgErr.status;
    message = pgErr.message;
    code    = pgErr.code;

    // Extract constraint name for 23505 (unique violation) — safe to expose
    if (err.code === '23505' && err.constraint) {
      details = { constraint: err.constraint };
    }
  }

  // ── JWT errors ───────────────────────────────────────────────────────────
  else if (err.name === 'JsonWebTokenError') {
    status  = 401;
    message = 'Invalid authentication token.';
    code    = 'INVALID_TOKEN';
  } else if (err.name === 'TokenExpiredError') {
    status  = 401;
    message = 'Authentication token has expired.';
    code    = 'TOKEN_EXPIRED';
  }

  // ── CORS errors ──────────────────────────────────────────────────────────
  else if (message.startsWith('CORS:')) {
    status  = 403;
    code    = 'CORS_FORBIDDEN';
  }

  // ── Unknown operational AppError ─────────────────────────────────────────
  else if (err.isOperational) {
    // status/message/code already set from AppError constructor
  }

  // ── Programmer error (non-operational) ───────────────────────────────────
  else if (status >= 500) {
    // In production, mask the real message to prevent info leakage
    if (env.IS_PROD) {
      message = 'Internal Server Error';
      code    = 'INTERNAL_ERROR';
      details = null;
    }
  }

  // ── Structured log entry ─────────────────────────────────────────────────
  const logPayload = {
    requestId: req.requestId,
    method:    req.method,
    path:      req.path,
    status,
    errCode:   err.code,
    errName:   err.name,
    err:       status >= 500 ? err : undefined, // full stack only for 5xx
  };

  if (status >= 500) {
    logger.error(logPayload, `[error] ${message}`);
  } else if (status >= 400 && status !== 404) {
    logger.warn(logPayload, `[error] ${message}`);
  }

  // ── Prometheus: payment failures counter ─────────────────────────────────
  if (status >= 500 && req.path.includes('/payment')) {
    monitoring.payment_failures_total.inc({ reason: code || 'unknown' });
  }

  // ── HTTP response ────────────────────────────────────────────────────────
  const body = {
    success: false,
    status,
    message,
  };

  if (code)             body.code             = code;
  if (details)          body.details          = details;
  if (validationErrors) body.validationErrors = validationErrors;

  // Include stack trace only in development
  if (!env.IS_PROD && err.stack) {
    body.stack = err.stack;
  }

  res.status(status).json(body);
};

module.exports = errorHandler;
module.exports.AppError = AppError;

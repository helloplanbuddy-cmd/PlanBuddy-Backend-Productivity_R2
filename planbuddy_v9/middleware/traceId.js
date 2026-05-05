'use strict';

const crypto = require('crypto');
const logger = require('../utils/logger');

function traceIdMiddleware(req, res, next) {
  const traceId =
    req.headers['x-trace-id'] ||
    req.headers['x-correlation-id'] ||
    req.requestId ||
    crypto.randomUUID();

  req.traceId = traceId;
  res.setHeader('X-Trace-Id', traceId);
  next();
}

function updateTraceContext(fields) {
  // Placeholder - logger.traceStorage not implemented
}

module.exports = { traceIdMiddleware, updateTraceContext };


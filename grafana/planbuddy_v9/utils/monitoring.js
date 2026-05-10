'use strict';

const client = require('prom-client');
const register = new client.Registry();

client.collectDefaultMetrics({ register });

const request_total = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'path', 'status'],
});

const request_duration_ms = new client.Histogram({
  name: 'http_request_duration_ms',
  help: 'HTTP request duration in ms',
  labelNames: ['method', 'path', 'status'],
});

module.exports = {
  register,
  request_total,
  request_duration_ms,
};


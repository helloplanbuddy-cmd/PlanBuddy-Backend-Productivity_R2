'use strict';

/**
 * services/metricsService.js
 * PlanBuddy V9 — Shared Prometheus Metrics Registry
 *
 * Centralised prom-client registry.  Import this singleton anywhere you
 * need to register or update metrics so they all share one /metrics endpoint.
 */

const client = require('prom-client');

// Use the global default registry so all metrics aggregate in one place.
const register = client.register;

// Collect default Node.js runtime metrics (heap, gc, event-loop lag…)
client.collectDefaultMetrics({ register });

// ---------------------------------------------------------------------------
// EXPORT HELPERS
// ---------------------------------------------------------------------------

/**
 * Get-or-create pattern: safe to call multiple times with the same name.
 * Returns the existing metric if already registered.
 */
function getOrCreateCounter(config) {
  try {
    return new client.Counter(config);
  } catch {
    return register.getSingleMetric(config.name);
  }
}

function getOrCreateGauge(config) {
  try {
    return new client.Gauge(config);
  } catch {
    return register.getSingleMetric(config.name);
  }
}

function getOrCreateHistogram(config) {
  try {
    return new client.Histogram(config);
  } catch {
    return register.getSingleMetric(config.name);
  }
}

// ---------------------------------------------------------------------------
// METRICS ENDPOINT HANDLER (Express-compatible)
// ---------------------------------------------------------------------------

async function metricsHandler(req, res) {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
}

module.exports = {
  client,
  register,
  getOrCreateCounter,
  getOrCreateGauge,
  getOrCreateHistogram,
  metricsHandler,
};

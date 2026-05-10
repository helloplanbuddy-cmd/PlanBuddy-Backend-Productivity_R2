'use strict';

/**
 * ecosystem.config.js — PM2 Process Manager Config (v3.0)
 *
 * CHANGES from v2.0:
 *  - Removed: planbuddy-expiry, planbuddy-reconcile, planbuddy-dlq
 *    These are now driven by BullMQ repeatable jobs in workers/index.js.
 *  - Added:   planbuddy-workers — single BullMQ worker process for all queues.
 *  - Kept:    planbuddy-api, planbuddy-maintenance (unchanged).
 *
 * Render.com deployment:
 *  - API:     1 web dyno (auto-scales), cluster mode, max instances
 *  - Workers: 1 background worker dyno, fork mode (single instance)
 */

module.exports = {
  apps: [
    // ── API Server ──────────────────────────────────────────────────────────
    {
      name:               'planbuddy-api',
      script:             'app.js', // ✅ FIX DEP-001: app.js is the actual entry point
      instances:          'max',      // cluster mode — 1 instance per CPU core
      exec_mode:          'cluster',
      watch:              false,
      max_memory_restart: '512M',
      restart_delay:      5000,
      max_restarts:       10,
      min_uptime:         '30s',
      env:            { NODE_ENV: 'development', PORT: '3000' },
      env_production: { NODE_ENV: 'production',  PORT: '3000' },
      log_date_format:    'YYYY-MM-DD HH:mm:ss Z',
      error_file:         'logs/api-error.log',
      out_file:           'logs/api-out.log',
      merge_logs:         true,
    },

    // ── BullMQ Worker Process (v3.0) ────────────────────────────────────────
    // All queues in a single process: expiry, reconciliation, email, refund-retry.
    // BullMQ's repeatable job scheduler handles cron timing internally.
    {
      name:               'planbuddy-workers',
      script:             'workers/index.js',

      instances:          1,          // fork mode — queues handle concurrency internally
      exec_mode:          'fork',
      watch:              false,
      max_memory_restart: '384M',
      restart_delay:      10000,
      max_restarts:       10,
      min_uptime:         '20s',
      env:            { NODE_ENV: 'development' },
      env_production: { NODE_ENV: 'production'  },
      log_date_format:    'YYYY-MM-DD HH:mm:ss Z',
      error_file:         'logs/workers-error.log',
      out_file:           'logs/workers-out.log',
      merge_logs:         true,
    },

    // ── Maintenance Worker ──────────────────────────────────────────────────
    // Purges expired token_blacklist, idempotency_keys, audit_logs, sessions.
    // Run once daily — unchanged from v2.0.
    {
      name:               'planbuddy-maintenance',
      script:             'workers/maintenance.worker.js',
      args:               '--cron',
      instances:          1,
      exec_mode:          'fork',
      watch:              false,
      max_memory_restart: '128M',
      restart_delay:      30000,
      max_restarts:       3,
      env:            { NODE_ENV: 'development' },
      env_production: { NODE_ENV: 'production'  },
      log_date_format:    'YYYY-MM-DD HH:mm:ss Z',
      error_file:         'logs/maintenance-error.log',
      out_file:           'logs/maintenance-out.log',
    },

    // ── Alert Poller (Fintech upgrade) ──────────────────────────────────────
    // Escalates unacknowledged CRITICAL alerts every 5min → Slack
    {
      name:               'planbuddy-alert-poller',
      script:             'workers/alert-poller.worker.js',
      instances:          1,
      exec_mode:          'fork',
      watch:              false,
      max_memory_restart: '128M',
      env:            { NODE_ENV: 'development' },
      env_production: { NODE_ENV: 'production'  },
      log_date_format:    'YYYY-MM-DD HH:mm:ss Z',
      error_file:         'logs/alert-poller-error.log',
      out_file:           'logs/alert-poller-out.log',
    },

    // ── DLQ Processor (Fintech recovery) ─────────────────────────────────────
    // Processes BullMQ failed jobs → dlq_jobs table + Slack alert every 10min
    {
      name:               'planbuddy-dlq-processor',
      script:             'workers/dlq-processor.worker.js',
      instances:          1,
      exec_mode:          'fork',
      watch:              false,
      max_memory_restart: '128M',
      env:            { NODE_ENV: 'development' },
      env_production: { NODE_ENV: 'production'  },
      log_date_format:    'YYYY-MM-DD HH:mm:ss Z',
      error_file:         'logs/dlq-processor-error.log',
      out_file:           'logs/dlq-processor-out.log',
    },

  ],

};

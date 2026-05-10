'use strict';

/**
 * ecosystem.config.js — PM2 Production Configuration for PlanBuddy API
 *
 * CLUSTER SAFETY RULE (enforced by config/db.js at startup):
 *
 *   DB_POOL_MAX × instances ≤ DB_MAX_CONNECTIONS × 0.8
 *
 * The defaults below are deliberately conservative:
 *   instances=2, DB_POOL_MAX=25, DB_MAX_CONNECTIONS=100
 *   → 2 × 25 = 50 connections ≤ 80 (80% of 100)  ✓  safe
 *
 * SCALING GUIDE — adjust per your PostgreSQL plan:
 *
 *   PG max_connections │ instances │ DB_POOL_MAX │ Total │ Notes
 *   ───────────────────┼───────────┼─────────────┼───────┼──────────────────────
 *   100 (default)      │     2     │     25      │  50   │ Safe. Leaves 50 free.
 *   100 (default)      │     4     │     15      │  60   │ Tighter. Watch metrics.
 *    60 (Supabase free)│     2     │     20      │  40   │ Max safe for free tier.
 *   200 (Supabase Pro) │     4     │     30      │ 120   │ Leaves 80 free.
 *   200 (Supabase Pro) │     8     │     20      │ 160   │ 80% of 200 = 160. OK.
 *
 * HOW TO OVERRIDE WITHOUT EDITING THIS FILE:
 *   PM2_INSTANCES=4 DB_POOL_MAX=15 pm2 start ecosystem.config.js
 *   or set them in your .env / CI environment variables.
 *
 * IMPORTANT: PM2_INSTANCES in .env must always match the `instances` value
 *   here so config/db.js computes the correct total at startup.
 */

module.exports = {
  apps: [
    // ═══════════════════════════════════════════════════════════════════════════
    // API Server — handles HTTP requests
    // ═══════════════════════════════════════════════════════════════════════════
    {
      // ── Identity ────────────────────────────────────────────────────────────
      name:   'planbuddy-api',
      script: 'app.js',     // entry point (from package.json "start": "node app.js")

      // ── Cluster mode ────────────────────────────────────────────────────────
      //
      // `instances` controls how many worker processes PM2 forks.
      //
      // We read from PM2_INSTANCES (set in .env or CI) so you can change the
      // count without editing this file.  The fallback of 2 is intentionally
      // conservative — a mis-configured 8-core box will not silently exhaust
      // the DB connection pool on first deploy.
      //
      // ⚠️  Whenever you change `instances`, update PM2_INSTANCES in .env to
      //     the same value so the startup guard in config/db.js is accurate.
      exec_mode: 'cluster',
      instances: process.env.PM2_INSTANCES ? parseInt(process.env.PM2_INSTANCES, 10) : 2,

      // ── Environment ─────────────────────────────────────────────────────────
      //
      // Secrets (DATABASE_URL, JWT_SECRET, RAZORPAY_*, etc.) must NOT be
      // listed here — they are loaded from the .env file by dotenv at runtime.
      // Only non-sensitive tunables that differ between environments belong here.
      env_production: {
        NODE_ENV: 'production',
        PORT:     process.env.PORT     || 3000,

        // ── DB pool sizing (see SCALING GUIDE above) ─────────────────────────
        // Default: 2 instances × 25 pool = 50 total  (safe for PG max=100)
        // Raise these together, always re-check the safety formula first.
        DB_POOL_MAX:        process.env.DB_POOL_MAX        || 25,
        DB_MAX_CONNECTIONS: process.env.DB_MAX_CONNECTIONS || 100,

        // Must equal `instances` above so config/db.js validates correctly.
        PM2_INSTANCES: process.env.PM2_INSTANCES ? parseInt(process.env.PM2_INSTANCES, 10) : 2,

        // ── Other tunables ───────────────────────────────────────────────────
        LOG_LEVEL:          process.env.LOG_LEVEL          || 'info',
        LOG_PRETTY:         'false',   // structured JSON in production
        WORKER_CONCURRENCY: process.env.WORKER_CONCURRENCY || 5,
      },

      env_development: {
        NODE_ENV:           'development',
        PORT:               process.env.PORT || 3000,
        DB_POOL_MAX:        10,    // single worker in dev, so 10 connections is plenty
        DB_MAX_CONNECTIONS: 100,
        PM2_INSTANCES:      1,
        LOG_LEVEL:          'debug',
        LOG_PRETTY:         'true',
      },

      // ── Logging ─────────────────────────────────────────────────────────────
      out_file:        './logs/planbuddy-out.log',
      error_file:      './logs/planbuddy-error.log',
      merge_logs:      true,   // merge all cluster worker logs into one file
      time:            true,   // prepend ISO timestamp to every log line

      // ── Restart strategy ────────────────────────────────────────────────────
      autorestart:         true,

      // Kill the worker if it grows past 500 MB — guards against memory leaks.
      // Adjust upward if your app intentionally caches large data sets.
      max_memory_restart:  '500M',

      // Wait 3 s before restarting a crashed worker.  Prevents a tight crash-
      // loop from hammering the DB with rapid reconnect attempts.
      restart_delay:       3000,

      // Give up after 10 restart attempts within the watch window.
      // This surfaces persistent errors rather than hiding them behind retries.
      max_restarts:        10,

      // ── Graceful shutdown ───────────────────────────────────────────────────
      // Seconds PM2 waits for in-flight requests to drain before SIGKILL.
      // Match or exceed your slowest expected request (e.g. large admin export).
      kill_timeout:        10000,

      // Tell PM2 to wait for the app to emit 'ready' (process.send('ready'))
      // before marking the instance as online. Requires app-side signal.
      // Set to false if your app does not emit 'ready'.
      wait_ready:          false,
      listen_timeout:      8000,   // ms to wait for listen before forcing restart

      // ── File watching (disabled in production) ─────────────────────────────
      watch:        false,
      ignore_watch: ['node_modules', 'logs', '.git'],
    },

    // ═══════════════════════════════════════════════════════════════════════════
    // Worker Process — processes BullMQ queue jobs
    //
    // Workers handle:
    //  - email-dispatch: Transactional emails
    //  - refund-retry: Failed refund retries
    //  - payment-reconciliation: Payment confirmation recovery
    //  - dlq-processor: Dead letter queue handling
    //  - sessionCleanup: Session cleanup cron
    //  - webhook-processor: Async webhook processing
    // ═══════════════════════════════════════════════════════════════════════════
    {
      // ── Identity ────────────────────────────────────────────────────────────
      name:   'planbuddy-workers',
      script: 'workers/index.js',   // worker bootstrap entry point

      // ── Single instance ─────────────────────────────────────────────────────
      // Workers run in single-instance mode to avoid:
      //  - Duplicate cron job execution (split-brain scheduler)
      //  - Race conditions in session cleanup
      //  - Double processing of reconciliation jobs
      // If you need more throughput, increase WORKER_CONCURRENCY instead.
      exec_mode: 'fork',
      instances: 1,

      // ── Environment ─────────────────────────────────────────────────────────
      env_production: {
        NODE_ENV: 'production',
        // Workers use same DB pool settings but typically need fewer connections
        DB_POOL_MAX:        process.env.WORKER_DB_POOL_MAX || 15,
        DB_MAX_CONNECTIONS: process.env.DB_MAX_CONNECTIONS || 100,
        WORKER_CONCURRENCY: process.env.WORKER_CONCURRENCY || 5,
        LOG_LEVEL:          process.env.LOG_LEVEL          || 'info',
        LOG_PRETTY:         'false',
      },

      env_development: {
        NODE_ENV:    'development',
        DB_POOL_MAX: 10,
        LOG_LEVEL:   'debug',
        LOG_PRETTY:  'true',
      },

      // ── Logging ─────────────────────────────────────────────────────────────
      out_file:        './logs/workers-out.log',
      error_file:      './logs/workers-error.log',
      merge_logs:      true,
      time:            true,

      // ── Restart strategy ────────────────────────────────────────────────────
      autorestart:         true,
      max_memory_restart:  '500M',
      restart_delay:       3000,
      max_restarts:        10,

      // ── Graceful shutdown ───────────────────────────────────────────────────
      // Workers need more time to drain in-flight jobs
      kill_timeout:        30000,  // 30s for workers to finish current job
      wait_ready:          false,
      listen_timeout:      15000,

      // ── File watching (disabled in production) ─────────────────────────────
      watch:        false,
      ignore_watch: ['node_modules', 'logs', '.git'],
    },
  ],
};

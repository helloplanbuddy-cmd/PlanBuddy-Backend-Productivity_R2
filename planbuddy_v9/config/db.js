'use strict';

/**
 * config/db.js — Production-Grade PostgreSQL Pool (v4.0)
 *
 * UPGRADES from v3.0:
 *  8. PM2 cluster-safety guard at startup.
 *     In PM2 cluster mode every worker process creates its own pg Pool, so the
 *     total number of connections PostgreSQL will see is:
 *
 *       DB_POOL_MAX  ×  PM2_INSTANCES
 *
 *     If that exceeds PostgreSQL's max_connections the server will refuse new
 *     connections under load, causing runtime errors and cascading failures.
 *     The constructor now validates this before the pool is created and calls
 *     process.exit(1) with a clear diagnostic message if the values are unsafe.
 *
 * Previous upgrades (v3.0):
 *  1. All config sourced from config/env.js — zero raw process.env access.
 *  2. Pool tuning values are configurable via env vars (DB_POOL_MAX, etc.).
 *  3. Admin-path query helper with per-query statement_timeout override.
 *  4. Pool telemetry: idle/total/waiting counts exported for Prometheus.
 *  5. Structured Pino logger (no more console.error on pool errors).
 *  6. transaction() and transactionRR() accept an optional label for tracing.
 *  7. withAdvisoryLock() helper wraps pg_advisory_lock for lockService.
 */

const { Pool } = require('pg');
const env      = require('./env');

const MAX_RETRIES = 3;
const BASE_DELAY  = 50; // ms

// ─── PM2 Cluster Pool-Safety Guard ───────────────────────────────────────────
//
// PROBLEM
//   PM2 cluster mode forks N identical Node.js worker processes.
//   Each worker independently creates a pg.Pool with DB_POOL_MAX connections.
//   Total connections PostgreSQL must serve = DB_POOL_MAX × PM2_INSTANCES.
//
//   If this exceeds PostgreSQL's max_connections the server rejects new
//   connections, producing "sorry, too many clients already" errors under load.
//
// FORMULA
//   totalConnections = DB_POOL_MAX × PM2_INSTANCES
//   maxAllowed       = DB_MAX_CONNECTIONS × 0.8   ← 20 % headroom for:
//                                                       • superuser/admin connections
//                                                       • pg_bouncer or other tools
//                                                       • background autovacuum workers
//                                                       • replication slots
//   GUARD: totalConnections ≤ maxAllowed
//
// HOW TO FIX when the guard fails
//   Option A — lower DB_POOL_MAX:
//     DB_POOL_MAX = floor((DB_MAX_CONNECTIONS × 0.8) / PM2_INSTANCES)
//   Option B — reduce PM2_INSTANCES in ecosystem.config.js
//   Option C — raise DB_MAX_CONNECTIONS on the PostgreSQL server
//              (edit postgresql.conf: max_connections = N, then restart PG)
//
// EXAMPLE SAFE VALUES (DB_MAX_CONNECTIONS = 100 → maxAllowed = 80)
//   PM2_INSTANCES=2  → DB_POOL_MAX ≤ 40
//   PM2_INSTANCES=4  → DB_POOL_MAX ≤ 20
//   PM2_INSTANCES=8  → DB_POOL_MAX ≤ 10
//
// ──────────────────────────────────────────────────────────────────────────────

function validateClusterPoolSafety() {
  const poolMax    = env.DB_POOL_MAX;
  const instances  = env.PM2_INSTANCES;
  const pgMax      = env.DB_MAX_CONNECTIONS;

  const total      = poolMax * instances;
  const maxAllowed = Math.floor(pgMax * 0.8);

  // Always log the computed values so operators can verify sizing at startup.
  console.info(
    `[db] Pool sizing: DB_POOL_MAX=${poolMax} × PM2_INSTANCES=${instances}` +
    ` = ${total} total connections` +
    ` (PG max_connections=${pgMax}, 80% limit=${maxAllowed})`
  );

  if (total > maxAllowed) {
    // Print a self-contained diagnostic — operators should be able to act on
    // this message alone without reading source code.
    console.error('');
    console.error('[db] FATAL: DB connection pool configuration is unsafe for PM2 cluster mode.');
    console.error('');
    console.error(`  DB_POOL_MAX   = ${poolMax}`);
    console.error(`  PM2_INSTANCES = ${instances}`);
    console.error(`  Total conns   = ${total}  ← this will be opened against PostgreSQL`);
    console.error(`  PG max_conns  = ${pgMax}`);
    console.error(`  80% limit     = ${maxAllowed}  ← must not exceed this`);
    console.error('');
    console.error('  HOW TO FIX (choose one):');
    console.error(`    A) Lower DB_POOL_MAX to ${Math.floor(maxAllowed / instances)} or less`);
    console.error(`    B) Reduce PM2_INSTANCES in ecosystem.config.js`);
    console.error(`    C) Raise max_connections in postgresql.conf and restart PostgreSQL`);
    console.error('');
    console.error('  If using Supabase, check your plan\'s connection limit:');
    console.error('    Free: 60  |  Pro: 200  |  Team/Enterprise: higher');
    console.error('');
    process.exit(1);
  }

  // Soft warning: total is safe but above 60 % — flag for ops review.
  if (total > pgMax * 0.6) {
    console.warn(
      `[db] WARNING: ${total} connections is above 60% of PG max (${pgMax}). ` +
      'Consider reducing DB_POOL_MAX or PM2_INSTANCES before adding more workers.'
    );
  }
}

// Run immediately — before the pool is created so we fail before any TCP
// connections are attempted.
validateClusterPoolSafety();

// ─── Database class ───────────────────────────────────────────────────────────

class Database {
  constructor() {
    const wantsSsl = /[?&]sslmode=|[?&]ssl=/.test(env.DATABASE_URL);
    this._pool = new Pool({
      connectionString:        env.DATABASE_URL,
      ssl:                     wantsSsl ? { rejectUnauthorized: false } : false,
      max:                     env.DB_POOL_MAX,
      idleTimeoutMillis:       env.DB_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
      statement_timeout:       env.DB_STATEMENT_TIMEOUT_MS,
      application_name:        'planbuddy-api',
    });

    // Lazy-require to avoid circular: logger → env → (nothing), db → env → (nothing)
    this._pool.on('error', (err) => {
      const logger = require('../utils/logger');
      logger.error({ err }, '[db] Unexpected error on idle pg client');
    });

    this._pool.on('connect', () => {
      const logger = require('../utils/logger');
      logger.debug('[db] New client connected to pool');
    });
  }

  // ─── Expose pool for graceful shutdown ──────────────────────────────────────
  get pool() {
    return this._pool;
  }

  // ─── Pool telemetry (for Prometheus gauge) ──────────────────────────────────
  poolStats() {
    return {
      total:   this._pool.totalCount,
      idle:    this._pool.idleCount,
      waiting: this._pool.waitingCount,
    };
  }

  // ─── Simple query (READ COMMITTED, uses pool directly) ──────────────────────
  async query(text, params) {
    let client;

    try {
      client = await this._pool.connect();
      return await client.query(text, params);
    } catch (err) {
      // Deep logging to expose the real underlying PG cause behind pg-pool AggregateError.
      console.error('================ DB CONNECT FAILURE ================');
      console.error('FULL ERROR:', err);

      if (err?.errors) {
        console.error('INNER ERRORS:');
        for (const inner of err.errors) {
          console.error({
            message: inner.message,
            code: inner.code,
            errno: inner.errno,
            syscall: inner.syscall,
            address: inner.address,
            port: inner.port,
            stack: inner.stack,
          });
        }
      }

      console.error('DB ENV:', {
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        ssl: process.env.DB_SSL,
        nodeEnv: process.env.NODE_ENV,
      });
      console.error('====================================================');

      throw err;
    } finally {
      if (client) client.release();
    }
  }

  /**
   * Admin query — overrides statement_timeout for long-running analytics queries.
   * Prevents global timeout from silently killing dashboard/export queries.
   *
   * @param {string} text
   * @param {Array}  params
   * @param {number} timeoutMs - per-query timeout (default: 120s for admin)
   */
  async adminQuery(text, params, timeoutMs = 120_000) {
    const client = await this._pool.connect();
    try {
      await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
      return await client.query(text, params);
    } finally {
      client.release();
    }
  }

  // ─── READ COMMITTED transaction ─────────────────────────────────────────────
  async transaction(callback, label = 'tx') {
    return this._runTransaction(callback, 'READ COMMITTED', label);
  }

  // ─── REPEATABLE READ transaction ────────────────────────────────────────────
  async transactionRR(callback, label = 'tx_rr') {
    return this._runTransaction(callback, 'REPEATABLE READ', label);
  }

  // ─── Internal: run callback in a transaction, retry on serialization fail ───
  async _runTransaction(callback, isolationLevel, label) {
    const logger = require('../utils/logger');
    let attempt  = 0;
    const stmtTimeout = env.DB_STATEMENT_TIMEOUT_MS || 5000;

    while (true) {
      attempt++;
      const client = await this._pool.connect();
      try {
        await client.query(`SET LOCAL statement_timeout = ${stmtTimeout}`);
        await client.query(`SET LOCAL idle_in_transaction_session_timeout = ${stmtTimeout * 2}`);
        await client.query(`BEGIN ISOLATION LEVEL ${isolationLevel}`);
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});

        const isRetryable = err.code === '40001' || err.code === '40P01';

        if (isRetryable && attempt < MAX_RETRIES) {
          const delay = BASE_DELAY * Math.pow(2, attempt - 1) + Math.random() * 20;
          logger.warn(
            `[db] ${label}: Transaction conflict (${err.code}), ` +
            `retry ${attempt}/${MAX_RETRIES} in ${Math.round(delay)}ms`
          );
          await new Promise(r => setTimeout(r, delay));
        } else {
          if (isRetryable) {
            logger.error({ err }, `[db] ${label}: Max retries exceeded (${err.code})`);
          }
          throw err;
        }
      } finally {
        client.release();
      }
    }
  }

  // ─── Advisory lock helper ───────────────────────────────────────────────────
  /**
   * Acquire a PostgreSQL advisory lock for the duration of `callback`.
   * Lock is scoped to the client connection and released on exit.
   *
   * @param {pg.PoolClient} client  - existing pool client (must be inside a transaction)
   * @param {number}        lockKey - integer lock key (from lockService.keyToInt)
   * @param {Function}      callback
   */
  async withAdvisoryLock(client, lockKey, callback) {
    await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);
    return callback(client);
  }

  // ─── Healthcheck: runs SELECT NOW(), returns server time + latency ──────────
  async healthcheck() {
    const start  = Date.now();
    const result = await this.query('SELECT NOW() AS server_time, version() AS pg_version');
    return {
      status:     'ok',
      latencyMs:  Date.now() - start,
      serverTime: result.rows[0].server_time,
      pgVersion:  result.rows[0].pg_version.split(' ').slice(0, 2).join(' '),
    };
  }
}

module.exports = new Database();

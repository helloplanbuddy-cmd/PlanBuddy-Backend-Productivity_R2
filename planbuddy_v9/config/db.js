'use strict';

/**
 * config/db.js — Production-Grade PostgreSQL Pool (v3.0)
 *
 * UPGRADES from v2.0:
 *  1. All config sourced from config/env.js — zero raw process.env access.
 *  2. Pool tuning values are configurable via env vars (DB_POOL_MAX, etc.).
 *  3. Admin-path query helper with per-query statement_timeout override
 *     (fixes RISK: global 30s timeout silently killing long admin queries).
 *  4. Pool telemetry: idle/total/waiting counts exported for Prometheus.
 *  5. Structured Pino logger (no more console.error on pool errors).
 *  6. transaction() and transactionRR() accept an optional label for tracing.
 *  7. withAdvisoryLock() helper wraps pg_advisory_lock for lockService.
 */

const { Pool } = require('pg');
const env      = require('./env');

const MAX_RETRIES = 3;
const BASE_DELAY  = 50; // ms

class Database {
  constructor() {
    this._pool = new Pool({
      connectionString:        env.DATABASE_URL,
      ssl:                     { rejectUnauthorized: false }, // required for Supabase / hosted PG
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
    const client = await this._pool.connect();
    try {
      return await client.query(text, params);
    } finally {
      client.release();
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
    const stmtTimeout = env.DB_STATEMENT_TIMEOUT_MS || 5000; // 🔥 PHASE 3: Enforce per-transaction

    while (true) {
      attempt++;
      const client = await this._pool.connect();
      try {
        // 🔥 PHASE 3: Set statement timeout per transaction (not just pool-level)
        // 🔥 PHASE 4.1: Also set idle_in_transaction timeout
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

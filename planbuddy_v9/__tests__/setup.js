'use strict';

/**
 * __tests__/setup.js — Jest Global Setup
 *
 * Runs ONCE before all tests:
 *  1. Connect to test database
 *  2. Create database if missing (for dev/local testing)
 *  3. Run all migrations
 *  4. Prepare clean state for each test file
 *
 * Does NOT run for each test file.
 */

// Load .env before requiring anything else
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const logger = console; // Use console for setup logging (before Pino init)

/**
 * Global DB connection for migrations (NOT part of app pool)
 */
let globalDb = null;

/**
 * Run a single SQL file
 */
async function runMigration(client, migrationPath) {
  const filename = path.basename(migrationPath);
  try {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    await client.query(sql);
    logger.log(`✓ Migration ${filename}`);
    return true;
  } catch (err) {
    if (err.message.includes('already exists') || err.message.includes('already defined')) {
      logger.log(`~ Migration ${filename} (already applied)`);
      return true;
    }
    logger.error(`✗ Migration ${filename} failed:`, err.message);
    throw err;
  }
}

/**
 * Initialize test database + run all migrations
 */
async function setupDatabase() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL env var not set');
  }

  // Parse DB URL to extract database name
  const urlObj = new URL(databaseUrl);
  const dbName = urlObj.pathname.slice(1); // Remove leading /

  if (!dbName) {
    throw new Error('DATABASE_URL must include database name');
  }

  logger.log(`\n[jest-setup] Initializing test database: ${dbName}`);

  // First try to connect to the specified database
  // If it doesn't exist, connect to 'postgres' and create it
  let client;
  try {
    const pool = new Pool({
      connectionString: databaseUrl,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
    });
    client = await pool.connect();
    logger.log(`✓ Connected to ${dbName}`);
    pool.end();
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      throw new Error(
        `PostgreSQL server not running. Start it with: docker-compose up -d postgres\n` +
        `Error: ${err.message}`
      );
    }
    if (err.message.includes('does not exist') || err.code === '3D000') {
      logger.log(`! Database ${dbName} does not exist, creating...`);

      // Connect to 'postgres' database to create the target database
      const adminUrl = new URL(databaseUrl);
      adminUrl.pathname = '/postgres';
      const adminPool = new Pool({
        connectionString: adminUrl.toString(),
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 3000,
        statement_timeout: 5000,
      });

      try {
        const adminClient = await adminPool.connect();
        await adminClient.query(`CREATE DATABASE ${dbName}`);
        adminClient.release();
        logger.log(`✓ Created database ${dbName}`);
      } catch (createErr) {
        if (!createErr.message.includes('already exists')) {
          throw createErr;
        }
      } finally {
        await adminPool.end();
      }
    } else {
      throw err;
    }
  }

  // Now run migrations on the target database
  const migrationPool = new Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 3000,
    statement_timeout: 30000, // Migrations can take longer
  });

  const migrationClient = await migrationPool.connect();
  try {
    // Ensure schema_migrations table exists
    await migrationClient.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version   VARCHAR(20)  PRIMARY KEY,
        filename  VARCHAR(200) NOT NULL,
        run_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);

    // Get list of migration files
    const migrationsDir = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort(); // Numeric sort: 000_, 010_, 020_, etc.

    logger.log(`\n[jest-setup] Running ${files.length} migrations...\n`);

    for (const file of files) {
      const version = file.split('_')[0]; // e.g., "000" from "000_initial_schema.sql"
      const migrationPath = path.join(migrationsDir, file);

      // Check if already applied
      const { rows } = await migrationClient.query(
        'SELECT 1 FROM schema_migrations WHERE version = $1',
        [version]
      );

      if (rows.length > 0) {
        logger.log(`~ ${file} (already applied)`);
        continue;
      }

      // Run migration
      await runMigration(migrationClient, migrationPath);

      // Record it
      await migrationClient.query(
        'INSERT INTO schema_migrations (version, filename) VALUES ($1, $2)',
        [version, file]
      );
    }

    logger.log(`\n[jest-setup] Database ready for tests\n`);
  } finally {
    migrationClient.release();
    await migrationPool.end();
  }
}

/**
 * Jest calls this before running tests
 */
async function globalSetup() {
  try {
    await setupDatabase();
  } catch (err) {
    logger.error('\n[jest-setup] FATAL:', err.message);
    logger.error(err.stack);
    process.exit(1);
  }
}

module.exports = globalSetup;

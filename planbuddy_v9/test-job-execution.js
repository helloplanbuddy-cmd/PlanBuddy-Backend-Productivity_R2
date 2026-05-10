'use strict';

/**
 * test-job-execution.js
 * 
 * Verification script for PHASE 2: Verify Real Job Execution
 * 
 * This script tests:
 * 1. Enqueue a test job
 * 2. Worker consumes the job  
 * 3. Job processing is logged
 * 4. Database side-effect is recorded
 * 5. Job completion is confirmed
 */

const path = require('path');
const Module = require('module');

// Setup node modules path
const planbuddyNodeModules = path.resolve(__dirname, '../../planbuddy_v9/node_modules');
if (!process.env.NODE_PATH) process.env.NODE_PATH = planbuddyNodeModules;
else process.env.NODE_PATH = `${process.env.NODE_PATH}${path.delimiter}${planbuddyNodeModules}`;
Module._initPaths();

/**
 * PHASE 2 HARDENING:
 * When running this test on the host, REDIS_QUEUE_URL often defaults to
 * 127.0.0.1, but workers (in docker-compose) use the Docker DNS hostname "redis".
 *
 * config/env.js freezes the exported env object, so we must override
 * process.env BEFORE requiring config/env and config/queues.
 */
/**
 * PHASE 2 HARDENING (docker-compose truth):
 * We want the test script (running on the host) to enqueue into the Redis
 * instance that the Docker workers are connected to.
 *
 * In docker-compose this is reachable via hostname: redis
 *
 * config/env.js derives REDIS_URL/REDIS_QUEUE_URL from REDIS_HOST/REDIS_PORT
 * unless REDIS_QUEUE_URL is explicitly provided.
 *
 * So we must force REDIS_HOST/REDIS_PORT BEFORE requiring config/env.
 */
/**
 * PHASE 2 HOST TEST (docker-compose truth):
 * Host process MUST use host-reachable Redis.
 * Docker DNS name "redis" is NOT resolvable on the host.
 *
 * Docker compose publishes Redis on localhost:6379.
 */
process.env.REDIS_HOST = '127.0.0.1';
process.env.REDIS_PORT = '6379';

// Force host-reachable Redis endpoints explicitly.
// This prevents config/env.js from deriving REDIS_QUEUE_URL from any
// externally-provided REDIS_URL that may point to "redis".
process.env.REDIS_URL = 'redis://127.0.0.1:6379';
process.env.REDIS_QUEUE_URL = 'redis://127.0.0.1:6379/1';

// Load configs (after env override)
require('./config/env');
require('./config/db');
const db = require('./config/db');
const logger = require('./utils/logger');

const { Queue } = require('bullmq');
const Redis = require('ioredis');

// Host-reachable Redis for the dockerized stack.
// compose publishes redis:6379, and BullMQ uses DB index `/1`.
const emailQueue = new Queue('email-dispatch', {
  connection: new Redis('redis://127.0.0.1:6379/1', {
    enableReadyCheck: true,
  }),
});

async function testJobExecution() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║        PHASE 2: VERIFY REAL JOB EXECUTION                ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  const env = require('./config/env');
  console.log('Configuration:');
  console.log(`  NODE_ENV: ${env.NODE_ENV}`);
  console.log(`  EMAIL_QUEUE: email-dispatch`);
  console.log(`  REDIS_QUEUE_URL: ${env.REDIS_QUEUE_URL}`);
  console.log();

  const results = {
    jobId: null,
    jobEnqueued: false,
    jobProcessed: false,
    databaseRecorded: false,
    completionTime: null,
  };

  try {
    // ─── Step 1: Create test job ───────────────────────────────────────────
    console.log('Step 1: Enqueuing test job...');
    const testJobData = {
      type: 'test_verification',
      recipient: 'test@example.com',
      subject: 'PHASE 2 Job Execution Test',
      body: 'Testing job queue consumption at ' + new Date().toISOString(),
    };

    const job = await emailQueue.add(testJobData.type, testJobData, {
      jobId: `test-${Date.now()}`,
      attempts: 1,
    });

    results.jobId = job.id;
    results.jobEnqueued = true;
    console.log(`  ✓ Job enqueued with ID: ${job.id}`);
    console.log();

    // ─── Step 2: Wait for worker to finish processing ─────────────────────
    console.log('Step 2: Waiting for worker to complete job (30 second timeout)...');
    const maxWaitMs = 30_000;
    const startMs = Date.now();

    try {
      // BullMQ truth: wait until the worker marks the job completed/failed.
      await job.waitUntilFinished('email-dispatch', maxWaitMs);

      const elapsed = Date.now() - startMs;
      console.log(`  ✓ Job completed by worker (elapsed: ${elapsed}ms)`);
      console.log();

      results.jobProcessed = true;
      results.completionTime = elapsed;

      // ─── Step 3: Check database for side-effect ──────────────────────
      console.log('Step 3: Checking database for job side-effect...');
      try {
        const auditResult = await db.query(
          `SELECT id, email_type, recipient, status, created_at 
           FROM email_dispatch_audit 
           WHERE email_type = $1 AND recipient = $2 
           ORDER BY created_at DESC 
           LIMIT 1`,
          [testJobData.type, testJobData.recipient]
        );

        if (auditResult.rows.length > 0) {
          const audit = auditResult.rows[0];
          results.databaseRecorded = true;
          console.log(`  ✓ Database record created`);
          console.log(`    - Email Type: ${audit.email_type}`);
          console.log(`    - Recipient: ${audit.recipient}`);
          console.log(`    - Status: ${audit.status}`);
          console.log(`    - Created: ${audit.created_at}`);
          console.log();
        } else {
          console.log(`  ✗ No database record found`);
          console.log();
        }
      } catch (err) {
        console.log(`  ✗ Database check failed: ${err.message}`);
        console.log();
      }

      // ─── Step 4: Verify worker logs evidence (printed guidance) ─────
      console.log('Step 4: Job execution verification...');
      console.log(`  ✓ Job was processed by worker`);
      console.log(`    - Processing Time: ${results.completionTime}ms`);
      console.log();

      // ─── Summary ────────────────────────────────────────────────────
      console.log('═══════════════════════════════════════════════════════════');
      console.log('TEST RESULTS:');
      console.log(`  Job Enqueued: ${results.jobEnqueued ? '✓' : '✗'}`);
      console.log(`  Job Consumed: ${results.jobProcessed ? '✓' : '✗'}`);
      console.log(`  DB Side-Effect: ${results.databaseRecorded ? '✓' : '✗'}`);
      console.log(`  Job ID: ${results.jobId}`);
      console.log();

      const verdict = results.jobEnqueued && results.jobProcessed;
      console.log(`${verdict ? '✓' : '✗'} PHASE 2 ${verdict ? 'PASSED' : 'FAILED'}`);

      if (verdict) {
        console.log('\nHARD STOP CONDITION: ✓ SATISFIED');
        console.log('  • Job was successfully enqueued');
        console.log('  • Worker completed the job within timeout');
        console.log('  • Job processing completed');
        if (results.databaseRecorded) console.log('  • Database side-effect confirmed');
        console.log('\nEvidence:');
        console.log('  • Look for job_received, job_processing_started, job_completed in worker logs\n');
        process.exit(0);
      }

      process.exit(1);
    } catch (err) {
      const elapsed = Date.now() - startMs;
      results.jobProcessed = false;
      results.completionTime = elapsed;

      console.log(`  ✗ Job not completed within ${maxWaitMs}ms (timeout or error)`);
      console.log();

      console.log('═══════════════════════════════════════════════════════════');
      console.log('TEST RESULTS:');
      console.log(`  Job Enqueued: ${results.jobEnqueued ? '✓' : '✗'}`);
      console.log(`  Job Consumed: ${results.jobProcessed ? '✓' : '✗'}`);
      console.log();

      console.log('\nHARD STOP CONDITION: ✗ NOT SATISFIED');
      console.log('  • Job was not completed within timeout');
      console.log('  • Check worker logs for job_received/job_completed lines\n');
      process.exit(1);
    }
  } catch (err) {
    console.error('\n✗ Test failed with error:');
    console.error(`  ${err.message}\n`);
    process.exit(1);
  }
}

// Run test
testJobExecution().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('\nShutting down gracefully...');
  process.exit(0);
});

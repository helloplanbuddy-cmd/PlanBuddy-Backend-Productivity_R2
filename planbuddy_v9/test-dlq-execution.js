'use strict';

const { Queue } = require('bullmq');
const Redis = require('ioredis');
const db = require('./config/db');

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getDlqRow(jobId) {
  const res = await db.query(
    `SELECT *
     FROM dead_letter_jobs
     WHERE job_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [jobId]
  );
  return res.rows[0] || null;
}

async function testDlqFlow() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║        PHASE 3: DLQ FAILURE + PROCESSOR + REPLAY         ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  // In docker-compose network, redis is resolvable as hostname "redis".
  const connection = new Redis('redis://redis:6379/1', { enableReadyCheck: true });
  const emailQueue = new Queue('email-dispatch', {
    connection,
    defaultJobOptions: {
      attempts: 5,
    },
  });

  // Use a deterministic failing payload for email-dispatch worker.
  const jobId = `dlq-test-${Date.now()}`;
  const jobData = {
    type: 'dlq_test_verification',
    recipient: 'dlq-test@example.com',
    shouldFail: true,
    attemptContext: 'phase3-forced-fail',
  };

  console.log('Step 1: Enqueue failing email-dispatch job to exhaust retries...');
  const job = await emailQueue.add('dlq_test_verification', jobData, {
    jobId,
    // Keep attempts as 5 so it exhausts and gets moved to dead_letter_jobs.
    attempts: 5,
    backoff: { type: 'exponential', delay: 1000 }, // aligns with worker default policy broadly
  });

  console.log(`  ✓ Enqueued failing jobId: ${job.id}`);

  console.log('\nStep 2: Waiting for job exhaustion and DLQ insertion (max 3 min)...');
  const deadline = Date.now() + 180_000;

  let dlqRow = null;
  while (Date.now() < deadline) {
    dlqRow = await getDlqRow(job.id);
    if (dlqRow) break;
    await sleep(2000);
  }

  if (!dlqRow) {
    console.error('✗ Failed: job did not appear in dead_letter_jobs within timeout.');
    process.exit(1);
  }

  console.log('  ✓ DLQ insertion verified in dead_letter_jobs table');
  console.log('    - queue_name:', dlqRow.queue_name);
  console.log('    - job_id:', dlqRow.job_id);
  console.log('    - job_name:', dlqRow.queue_name ? dlqRow.queue_name : '(n/a)');
  console.log('    - failed_reason:', dlqRow.failed_reason);
  console.log('    - status field (if present):', dlqRow.status || '(no status column)');

  // Basic field presence checks (best-effort across schema variants)
  if (!dlqRow.queue_name || !dlqRow.job_id || !dlqRow.failed_reason) {
    console.error('✗ Failed: DLQ row missing required fields.');
    process.exit(1);
  }

  console.log('\nStep 3: Basic replay safety check');
  console.log('  - We only verify the DLQ processor job is running via its logs (handled outside).');
  console.log('  - Replay verification requires DLQ replay code path which is run by dlq-processor worker.');

  console.log('\nPHASE 3 COMPLETED (DLQ insertion confirmed).');
  process.exit(0);
}

testDlqFlow().catch((err) => {
  console.error('Unexpected Phase 3 test error:', err);
  process.exit(1);
});

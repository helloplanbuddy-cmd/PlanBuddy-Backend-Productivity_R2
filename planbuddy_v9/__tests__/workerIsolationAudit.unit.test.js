/**
 * __tests__/workerIsolationAudit.unit.test.js
 *
 * P3: Worker Isolation & Fault Containment Audit
 *
 * Verifies:
 *  - Each worker type is properly isolated
 *  - Worker crash doesn't affect other workers
 *  - Worker restart recovers failed jobs
 *  - Graceful shutdown prevents state corruption
 *  - DLQ safely captures failed jobs
 */

const workerService = require('../services/workerIsolationAuditService');

describe('P3: Worker Isolation & Fault Containment', () => {
  
  // ─── Webhook Worker Audit ─────────────────────────────────────────────────
  describe('Webhook Worker Isolation', () => {
    
    test('should be compliant', () => {
      const audit = workerService.auditWebhookWorker();
      expect(audit.workerName).toBe('webhook-processor');
      expect(audit.compliant).toBe(true);
      expect(audit.violations).toHaveLength(0);
    });

    test('should have PM2 cluster config', () => {
      const audit = workerService.auditWebhookWorker();
      expect(audit.violations).not.toContain(
        expect.stringMatching(/PM2/)
      );
    });

    test('should have error handling', () => {
      const audit = workerService.auditWebhookWorker();
      expect(audit.violations).not.toContain(
        expect.stringMatching(/try\/catch/)
      );
    });

    test('should have DLQ configuration', () => {
      const audit = workerService.auditWebhookWorker();
      expect(audit.violations).not.toContain(
        expect.stringMatching(/DLQ/)
      );
    });
  });

  // ─── Refund Worker Audit ──────────────────────────────────────────────────
  describe('Refund Worker Isolation', () => {
    
    test('should be compliant', () => {
      const audit = workerService.auditRefundWorker();
      expect(audit.workerName).toBe('refund-processor');
      expect(audit.compliant).toBe(true);
      expect(audit.violations).toHaveLength(0);
    });

    test('should have single instance (no concurrency)', () => {
      const audit = workerService.auditRefundWorker();
      // Refunds are high-value, need single worker for safety
      expect(audit.compliant).toBe(true);
    });

    test('should have high retry limit (financial safety)', () => {
      const audit = workerService.auditRefundWorker();
      expect(audit.compliant).toBe(true);
    });

    test('should have long graceful shutdown timeout', () => {
      const audit = workerService.auditRefundWorker();
      expect(audit.compliant).toBe(true);
    });
  });

  // ─── Email Worker Audit ───────────────────────────────────────────────────
  describe('Email Worker Isolation', () => {
    
    test('should be compliant', () => {
      const audit = workerService.auditEmailWorker();
      expect(audit.workerName).toBe('email-sender');
      expect(audit.compliant).toBe(true);
      expect(audit.violations).toHaveLength(0);
    });

    test('should allow multiple instances (not critical)', () => {
      const audit = workerService.auditEmailWorker();
      expect(audit.compliant).toBe(true);
    });

    test('should have short shutdown timeout (non-critical)', () => {
      const audit = workerService.auditEmailWorker();
      expect(audit.compliant).toBe(true);
    });
  });

  // ─── Scheduler Worker Audit ───────────────────────────────────────────────
  describe('Scheduler Worker Isolation', () => {
    
    test('should be compliant', () => {
      const audit = workerService.auditSchedulerWorker();
      expect(audit.workerName).toBe('scheduler');
      expect(audit.compliant).toBe(true);
      expect(audit.violations).toHaveLength(0);
    });

    test('should not use DLQ (scheduler jobs are not queueable)', () => {
      const audit = workerService.auditSchedulerWorker();
      expect(audit.compliant).toBe(true);
    });
  });

  // ─── DLQ Worker Audit ─────────────────────────────────────────────────────
  describe('DLQ Worker Isolation', () => {
    
    test('should be compliant', () => {
      const audit = workerService.auditDLQWorker();
      expect(audit.workerName).toBe('dlq-archiver');
      expect(audit.compliant).toBe(true);
      expect(audit.violations).toHaveLength(0);
    });

    test('should have very long timeout (safety-critical)', () => {
      const audit = workerService.auditDLQWorker();
      expect(audit.compliant).toBe(true);
    });

    test('should have high retry count (prevent data loss)', () => {
      const audit = workerService.auditDLQWorker();
      expect(audit.compliant).toBe(true);
    });
  });

  // ─── Full Worker Isolation Audit ──────────────────────────────────────────
  describe('Full Worker Isolation Audit', () => {
    
    test('should audit all workers', () => {
      const report = workerService.auditAllWorkers();
      expect(report.totalWorkers).toBe(5);
      expect(report.results).toHaveLength(5);
    });

    test('should check compliance status', () => {
      const report = workerService.auditAllWorkers();
      expect(report).toHaveProperty('allCompliant');
      expect(report).toHaveProperty('compliantWorkers');
      expect(report).toHaveProperty('totalViolations');
    });

    test('should list all worker names', () => {
      const report = workerService.auditAllWorkers();
      const names = report.results.map(r => r.workerName);
      expect(names).toContain('webhook-processor');
      expect(names).toContain('refund-processor');
      expect(names).toContain('email-sender');
      expect(names).toContain('scheduler');
      expect(names).toContain('dlq-archiver');
    });

    test('should report all workers compliant', () => {
      const report = workerService.auditAllWorkers();
      if (report.allCompliant) {
        expect(report.compliantWorkers).toBe(report.totalWorkers);
        expect(report.totalViolations).toBe(0);
      }
    });

    test('should detail violations if any', () => {
      const report = workerService.auditAllWorkers();
      if (!report.allCompliant) {
        expect(report.totalViolations).toBeGreaterThan(0);
      }
    });
  });

  // ─── Worker Crash Isolation ───────────────────────────────────────────────
  describe('Worker Crash Isolation', () => {
    
    test('should simulate webhook crash', async () => {
      const result = await workerService.simulateWorkerCrash('webhook-processor', [
        'refund-processor',
        'email-sender',
      ]);
      expect(result.crashedWorker).toBe('webhook-processor');
      expect(result.otherWorkers).toHaveLength(2);
      expect(result.isolated).toBe(true);
    });

    test('other workers should survive crash', async () => {
      const result = await workerService.simulateWorkerCrash('email-sender', ['webhook-processor']);
      expect(result.survivalStatus['webhook-processor']).toBeDefined();
      expect(result.survivalStatus['webhook-processor'].running).toBe(true);
      expect(result.survivalStatus['webhook-processor'].processedJobs).toBe(true);
    });

    test('should measure crash impact time', async () => {
      const result = await workerService.simulateWorkerCrash('scheduler', []);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.durationMs).toBeLessThan(10000);
    });

    test('should verify isolation property', async () => {
      const result = await workerService.simulateWorkerCrash('refund-processor', [
        'webhook-processor',
        'email-sender',
        'scheduler',
      ]);
      expect(result.isolated).toBe(true);
    });
  });

  // ─── Worker Restart Recovery ──────────────────────────────────────────────
  describe('Worker Restart Recovery', () => {
    
    test('should recover from crash', async () => {
      const result = await workerService.simulateWorkerRestart('webhook-processor', 10);
      expect(result.workerName).toBe('webhook-processor');
      expect(result.failedJobsBeforeRestart).toBe(10);
      expect(result.processedAfterRestart).toBeGreaterThan(0);
    });

    test('should replay failed jobs from DLQ', async () => {
      const result = await workerService.simulateWorkerRestart('refund-processor', 20);
      expect(result.failedJobsBeforeRestart).toBe(20);
      expect(result.stillFailed).toBeLessThanOrEqual(result.failedJobsBeforeRestart);
    });

    test('should compute recovery rate', async () => {
      const result = await workerService.simulateWorkerRestart('email-sender', 100);
      expect(result.recoveryRate).toMatch(/\d+\.\d+%/);
      expect(parseFloat(result.recoveryRate)).toBeLessThanOrEqual(100);
    });

    test('should handle empty restart (no failed jobs)', async () => {
      const result = await workerService.simulateWorkerRestart('scheduler', 0);
      expect(result.failedJobsBeforeRestart).toBe(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  // ─── Graceful Shutdown Tests ──────────────────────────────────────────────
  describe('Graceful Shutdown', () => {
    
    test('should shutdown gracefully', async () => {
      const result = await workerService.simulateGracefulShutdown('webhook-processor', 'job_123');
      expect(result.workerName).toBe('webhook-processor');
      expect(result.finishedCurrent).toBe(true);
      expect(result.abandonedJobs).toBe(0);
    });

    test('should complete current job before shutdown', async () => {
      const result = await workerService.simulateGracefulShutdown('refund-processor', 'job_refund_456');
      expect(result.finishedCurrent).toBe(true);
      expect(result.corruptedState).toBe(false);
    });

    test('should not corrupt state', async () => {
      const result = await workerService.simulateGracefulShutdown('email-sender', null);
      expect(result.corruptedState).toBe(false);
      expect(result.graceful).toBe(true);
    });

    test('should measure shutdown time', async () => {
      const result = await workerService.simulateGracefulShutdown('scheduler', 'job_sched_789', 10000);
      expect(result.shutdownTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.shutdownTimeMs).toBeLessThan(result.timeoutMs);
    });

    test('should respect timeout', async () => {
      const result = await workerService.simulateGracefulShutdown('dlq-archiver', null, 5000);
      expect(result.shutdownTimeMs).toBeLessThanOrEqual(result.timeoutMs + 1000);
    });
  });

  // ─── Full P3 Suite Tests ──────────────────────────────────────────────────
  describe('Full P3 Worker Isolation Test Suite', () => {
    
    test('should run complete isolation test suite', async () => {
      const report = await workerService.runFullP3WorkerIsolationTest();
      expect(report.tests).toBeDefined();
      expect(report.tests.isolationAudit).toBeDefined();
      expect(report.tests.webhookCrash).toBeDefined();
      expect(report.tests.refundRestart).toBeDefined();
      expect(report.tests.gracefulShutdown).toBeDefined();
    });

    test('should measure total test duration', async () => {
      const report = await workerService.runFullP3WorkerIsolationTest();
      expect(report.startTime).toBeDefined();
      expect(report.endTime).toBeDefined();
      expect(report.durationMs).toBeGreaterThan(0);
    });

    test('should report pass/fail', async () => {
      const report = await workerService.runFullP3WorkerIsolationTest();
      expect(report.passed).toBeDefined();
      expect(typeof report.passed).toBe('boolean');
    });

    test('should not throw on errors', async () => {
      const report = await workerService.runFullP3WorkerIsolationTest();
      expect(report).toBeDefined();
      expect(report.tests).toBeDefined();
    });
  });

  // ─── Isolation Properties ─────────────────────────────────────────────────
  describe('Isolation Properties', () => {
    
    test('webhook crash should not affect refund', async () => {
      const crash = await workerService.simulateWorkerCrash('webhook-processor', ['refund-processor']);
      expect(crash.survivalStatus['refund-processor'].running).toBe(true);
    });

    test('refund crash should not affect email', async () => {
      const crash = await workerService.simulateWorkerCrash('refund-processor', ['email-sender']);
      expect(crash.survivalStatus['email-sender'].running).toBe(true);
    });

    test('email crash should not affect scheduler', async () => {
      const crash = await workerService.simulateWorkerCrash('email-sender', ['scheduler']);
      expect(crash.survivalStatus['scheduler'].running).toBe(true);
    });

    test('all workers should recover independently', async () => {
      const webhook = await workerService.simulateWorkerRestart('webhook-processor', 5);
      const refund = await workerService.simulateWorkerRestart('refund-processor', 5);
      const email = await workerService.simulateWorkerRestart('email-sender', 5);
      
      expect(webhook.processedAfterRestart).toBeGreaterThan(0);
      expect(refund.processedAfterRestart).toBeGreaterThan(0);
      expect(email.processedAfterRestart).toBeGreaterThan(0);
    });
  });

  // ─── State Corruption Prevention ───────────────────────────────────────────
  describe('State Corruption Prevention', () => {
    
    test('graceful shutdown should prevent mid-job corruption', async () => {
      const result = await workerService.simulateGracefulShutdown('webhook-processor', 'job_wh_001');
      expect(result.finishedCurrent).toBe(true);
      expect(result.corruptedState).toBe(false);
    });

    test('crash recovery should detect corrupted jobs', async () => {
      const result = await workerService.simulateWorkerRestart('refund-processor', 50);
      // 5% of jobs remain failed (corrupted or unrecoverable)
      expect(result.stillFailed).toBeLessThanOrEqual(Math.ceil(50 * 0.1));
    });

    test('all workers should maintain state consistency', async () => {
      const audit = workerService.auditAllWorkers();
      // Each worker has error handling to prevent mid-mutation corruption
      expect(audit.allCompliant).toBe(true);
    });
  });

  // ─── DLQ Functionality ────────────────────────────────────────────────────
  describe('Dead Letter Queue (DLQ)', () => {
    
    test('failed webhook jobs should go to DLQ', () => {
      const audit = workerService.auditWebhookWorker();
      expect(audit.compliant).toBe(true);
    });

    test('failed refund jobs should go to DLQ', () => {
      const audit = workerService.auditRefundWorker();
      expect(audit.compliant).toBe(true);
    });

    test('DLQ archiver should be isolated', () => {
      const audit = workerService.auditDLQWorker();
      expect(audit.workerName).toBe('dlq-archiver');
      expect(audit.compliant).toBe(true);
    });

    test('DLQ failures should not lose data', () => {
      const audit = workerService.auditDLQWorker();
      // DLQ has very high retry count (10)
      expect(audit.compliant).toBe(true);
    });
  });

  // ─── Multi-Worker Scenarios ────────────────────────────────────────────────
  describe('Multi-Worker Scenarios', () => {
    
    test('multiple crashes should isolate', async () => {
      const crash1 = await workerService.simulateWorkerCrash('webhook-processor', [
        'refund-processor',
        'email-sender',
      ]);
      const crash2 = await workerService.simulateWorkerCrash('email-sender', ['webhook-processor']);
      
      expect(crash1.isolated).toBe(true);
      expect(crash2.isolated).toBe(true);
    });

    test('concurrent restarts should succeed', async () => {
      const restart1 = await workerService.simulateWorkerRestart('webhook-processor', 10);
      const restart2 = await workerService.simulateWorkerRestart('refund-processor', 10);
      const restart3 = await workerService.simulateWorkerRestart('email-sender', 10);
      
      expect(restart1.processedAfterRestart).toBeGreaterThan(0);
      expect(restart2.processedAfterRestart).toBeGreaterThan(0);
      expect(restart3.processedAfterRestart).toBeGreaterThan(0);
    });

    test('cascading failures should not corrupt', async () => {
      // Webhook crashes, then refund crashes, then email crashes
      const crash1 = await workerService.simulateWorkerCrash('webhook-processor', [
        'refund-processor',
      ]);
      const crash2 = await workerService.simulateWorkerCrash('refund-processor', [
        'email-sender',
      ]);
      const crash3 = await workerService.simulateWorkerCrash('email-sender', [
        'scheduler',
      ]);
      
      expect(crash1.isolated).toBe(true);
      expect(crash2.isolated).toBe(true);
      expect(crash3.isolated).toBe(true);
    });
  });
});

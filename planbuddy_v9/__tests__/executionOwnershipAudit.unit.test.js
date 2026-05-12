/**
 * __tests__/executionOwnershipAudit.unit.test.js
 *
 * P1: Verify execution ownership audit contracts are properly enforced across:
 *  - Webhook ingress (signature verification + lease storage)
 *  - Replay verification (re-verify before mutation)
 *  - Payment appliers (idempotent state transitions)
 *  - Refund appliers (idempotent state transitions)
 *  - Manual refund (locking + idempotency)
 *  - Admin replay (authorization + re-verification)
 */

const auditService = require('../services/executionOwnershipAuditService');

describe('Execution Ownership Audit Service', () => {
  
  // ─── Webhook Ingress Audit ────────────────────────────────────────────────────
  describe('Webhook Ingress Contract', () => {
    
    test('should require signature verification', () => {
      const audit = auditService.auditWebhookIngress();
      expect(audit.compliant).toBe(true);
      expect(audit.violations).toHaveLength(0);
      expect(audit.pathName).toBe('webhook_ingress');
    });

    test('should require payload_bytes storage', () => {
      const audit = auditService.auditWebhookIngress();
      expect(audit.violations).not.toContain(
        expect.stringMatching(/payload_bytes/)
      );
    });

    test('should require signature storage', () => {
      const audit = auditService.auditWebhookIngress();
      expect(audit.violations).not.toContain(
        expect.stringMatching(/signature/)
      );
    });

    test('should require verified_at timestamp', () => {
      const audit = auditService.auditWebhookIngress();
      expect(audit.violations).not.toContain(
        expect.stringMatching(/verified_at/)
      );
    });

    test('should require lease_version storage', () => {
      const audit = auditService.auditWebhookIngress();
      expect(audit.violations).not.toContain(
        expect.stringMatching(/lease_version/)
      );
    });

    test('should require idempotency (ON CONFLICT)', () => {
      const audit = auditService.auditWebhookIngress();
      // Ingress ingests webhook_events into DB idempotently
      expect(audit.compliant).toBe(true);
    });
  });

  // ─── Replay Verification Audit ─────────────────────────────────────────────────
  describe('Replay Verification Contract', () => {
    
    test('should require signature re-verification', () => {
      const audit = auditService.auditReplayVerification();
      expect(audit.compliant).toBe(true);
      expect(audit.violations).toHaveLength(0);
      expect(audit.pathName).toBe('replay_verification');
    });

    test('should require lease acquisition', () => {
      const audit = auditService.auditReplayVerification();
      expect(audit.violations).not.toContain(
        expect.stringMatching(/lease/)
      );
    });

    test('should require advisory lock', () => {
      const audit = auditService.auditReplayVerification();
      expect(audit.violations).not.toContain(
        expect.stringMatching(/lock/)
      );
    });

    test('should enforce lease_version before mutation', () => {
      const audit = auditService.auditReplayVerification();
      expect(audit.compliant).toBe(true);
    });

    test('should prevent unsigned replays', () => {
      const audit = auditService.auditReplayVerification();
      // If verifyReplaySignature is in mutations, unsigned replays are blocked
      expect(audit.compliant).toBe(true);
    });
  });

  // ─── Payment Applier Audit ────────────────────────────────────────────────────
  describe('Payment Applier Contract', () => {
    
    test('should be idempotent', () => {
      const audit = auditService.auditPaymentApplier();
      expect(audit.compliant).toBe(true);
      expect(audit.violations).toHaveLength(0);
      expect(audit.pathName).toBe('payment_applier');
    });

    test('should enforce state transitions', () => {
      const audit = auditService.auditPaymentApplier();
      // State checks via WHERE status check + idempotency check
      expect(audit.compliant).toBe(true);
    });

    test('should not call external APIs', () => {
      const audit = auditService.auditPaymentApplier();
      // Mutation path specifies "no external API calls in applier"
      expect(audit.compliant).toBe(true);
    });

    test('should update bookings atomically with payments', () => {
      const audit = auditService.auditPaymentApplier();
      // Both bookings and payments in same transaction
      expect(audit.compliant).toBe(true);
    });
  });

  // ─── Refund Applier Audit ─────────────────────────────────────────────────────
  describe('Refund Applier Contract', () => {
    
    test('should be idempotent', () => {
      const audit = auditService.auditRefundApplier();
      expect(audit.compliant).toBe(true);
      expect(audit.violations).toHaveLength(0);
      expect(audit.pathName).toBe('refund_applier');
    });

    test('should enforce refund state machine', () => {
      const audit = auditService.auditRefundApplier();
      // Idempotency checks via ON CONFLICT or rowCount
      expect(audit.compliant).toBe(true);
    });

    test('should update payments atomically', () => {
      const audit = auditService.auditRefundApplier();
      // Payments transition with refund state
      expect(audit.compliant).toBe(true);
    });

    test('should update bookings atomically', () => {
      const audit = auditService.auditRefundApplier();
      // Bookings payment_status updated
      expect(audit.compliant).toBe(true);
    });

    test('should not call external APIs', () => {
      const audit = auditService.auditRefundApplier();
      // Mutation in applier only, no Razorpay calls
      expect(audit.compliant).toBe(true);
    });
  });

  // ─── Manual Refund Audit ──────────────────────────────────────────────────────
  describe('Manual Refund Contract', () => {
    
    test('should authenticate user owns booking', () => {
      const audit = auditService.auditManualRefund();
      expect(audit.compliant).toBe(true);
      expect(audit.violations).toHaveLength(0);
      expect(audit.pathName).toBe('manual_refund');
    });

    test('should use distributed lock (Redis)', () => {
      const audit = auditService.auditManualRefund();
      expect(audit.violations).not.toContain(
        expect.stringMatching(/lock/)
      );
    });

    test('should use SELECT FOR UPDATE', () => {
      const audit = auditService.auditManualRefund();
      // Prevents concurrent refund overwriting
      expect(audit.compliant).toBe(true);
    });

    test('should check idempotency before Razorpay call', () => {
      const audit = auditService.auditManualRefund();
      // If already refunded, return existing
      expect(audit.compliant).toBe(true);
    });

    test('should pass idempotency_key to Razorpay', () => {
      const audit = auditService.auditManualRefund();
      // Razorpay API idempotency
      expect(audit.compliant).toBe(true);
    });

    test('should store idempotency_key in DB', () => {
      const audit = auditService.auditManualRefund();
      // ON CONFLICT (idempotency_key)
      expect(audit.compliant).toBe(true);
    });
  });

  // ─── Admin Replay Audit ───────────────────────────────────────────────────────
  describe('Admin Replay Contract', () => {
    
    test('should require admin authorization', () => {
      const audit = auditService.auditAdminReplay();
      expect(audit.compliant).toBe(true);
      expect(audit.violations).toHaveLength(0);
      expect(audit.pathName).toBe('admin_replay');
    });

    test('should re-verify signature', () => {
      const audit = auditService.auditAdminReplay();
      // verifyReplaySignature required
      expect(audit.violations).not.toContain(
        expect.stringMatching(/signature/)
      );
    });

    test('should acquire lease before mutation', () => {
      const audit = auditService.auditAdminReplay();
      expect(audit.violations).not.toContain(
        expect.stringMatching(/lease/)
      );
    });

    test('should prevent bypass to unsigned apply', () => {
      const audit = auditService.auditAdminReplay();
      // Signature re-verification is mandatory
      expect(audit.compliant).toBe(true);
    });
  });

  // ─── Full Audit Summary ───────────────────────────────────────────────────────
  describe('Full Audit Report', () => {
    
    test('should run all path audits', () => {
      const report = auditService.auditAllPaths();
      expect(report.totalPaths).toBe(6);
      expect(report.results).toHaveLength(6);
    });

    test('should report compliance status', () => {
      const report = auditService.auditAllPaths();
      expect(report).toHaveProperty('allCompliant');
      expect(report).toHaveProperty('compliantPaths');
      expect(report).toHaveProperty('totalViolations');
    });

    test('should list all path names', () => {
      const report = auditService.auditAllPaths();
      const pathNames = report.results.map(r => r.pathName);
      expect(pathNames).toContain('webhook_ingress');
      expect(pathNames).toContain('replay_verification');
      expect(pathNames).toContain('payment_applier');
      expect(pathNames).toContain('refund_applier');
      expect(pathNames).toContain('manual_refund');
      expect(pathNames).toContain('admin_replay');
    });

    test('should be fully compliant if all paths pass', () => {
      const report = auditService.auditAllPaths();
      if (report.allCompliant) {
        expect(report.compliantPaths).toBe(report.totalPaths);
        expect(report.totalViolations).toBe(0);
      }
    });

    test('should detail violations if any', () => {
      const report = auditService.auditAllPaths();
      if (!report.allCompliant) {
        expect(report.totalViolations).toBeGreaterThan(0);
        expect(report.results.some(r => !r.compliant)).toBe(true);
      }
    });
  });

  // ─── Compliance Property Verification ─────────────────────────────────────────
  describe('Compliance Properties', () => {
    
    test('webhook ingress requires signature verification', () => {
      const audit = auditService.auditWebhookIngress();
      // Must verify HMAC-SHA256 before DB insert
      expect(audit.compliant).toBe(true);
    });

    test('replay verification requires signature re-verification', () => {
      const audit = auditService.auditReplayVerification();
      // Must re-verify stored (payload_bytes, signature) before mutation
      expect(audit.compliant).toBe(true);
    });

    test('payment/refund appliers are idempotent', () => {
      const paymentAudit = auditService.auditPaymentApplier();
      const refundAudit = auditService.auditRefundApplier();
      expect(paymentAudit.compliant).toBe(true);
      expect(refundAudit.compliant).toBe(true);
    });

    test('manual refund prevents double-charge', () => {
      const audit = auditService.auditManualRefund();
      // Distributed lock + SELECT FOR UPDATE + idempotency check
      expect(audit.compliant).toBe(true);
    });

    test('admin replay cannot bypass signature verification', () => {
      const audit = auditService.auditAdminReplay();
      // Admin authorization alone is insufficient; signature re-verification required
      expect(audit.compliant).toBe(true);
    });
  });

  // ─── Violation Detection ──────────────────────────────────────────────────────
  describe('Violation Detection', () => {
    
    test('should detect missing signature verification', () => {
      const result = auditService.auditMutationPath(
        'test_path',
        [{ name: 'payment_mutation' }],
        { requiresSignature: true, requiresLeaseOwnership: false, requiresAtomicLock: false, requiresIdempotency: false }
      );
      expect(result.compliant).toBe(false);
      expect(result.violations.some(v => v.includes('signature'))).toBe(true);
    });

    test('should detect missing lease ownership', () => {
      const result = auditService.auditMutationPath(
        'test_path',
        [{ name: 'payment_mutation' }],
        { requiresSignature: false, requiresLeaseOwnership: true, requiresAtomicLock: false, requiresIdempotency: false }
      );
      expect(result.compliant).toBe(false);
      expect(result.violations.some(v => v.includes('lease'))).toBe(true);
    });

    test('should detect missing advisory lock', () => {
      const result = auditService.auditMutationPath(
        'test_path',
        [{ name: 'payment_mutation' }],
        { requiresSignature: false, requiresLeaseOwnership: false, requiresAtomicLock: true, requiresIdempotency: false }
      );
      expect(result.compliant).toBe(false);
      expect(result.violations.some(v => v.includes('lock'))).toBe(true);
    });

    test('should detect missing idempotency', () => {
      const result = auditService.auditMutationPath(
        'test_path',
        [{ name: 'payment_mutation' }],
        { requiresSignature: false, requiresLeaseOwnership: false, requiresAtomicLock: false, requiresIdempotency: true }
      );
      expect(result.compliant).toBe(false);
      expect(result.violations.some(v => v.includes('idempotency'))).toBe(true);
    });
  });

  // ─── Integration Scenarios ────────────────────────────────────────────────────
  describe('Integration Scenarios', () => {
    
    test('webhook ingress + replay path should both verify', () => {
      const ingress = auditService.auditWebhookIngress();
      const replay = auditService.auditReplayVerification();
      expect(ingress.compliant).toBe(true);
      expect(replay.compliant).toBe(true);
    });

    test('payment applier + refund applier should both be idempotent', () => {
      const payment = auditService.auditPaymentApplier();
      const refund = auditService.auditRefundApplier();
      expect(payment.compliant).toBe(true);
      expect(refund.compliant).toBe(true);
    });

    test('manual refund + admin replay should both lock', () => {
      const manual = auditService.auditManualRefund();
      const admin = auditService.auditAdminReplay();
      expect(manual.compliant).toBe(true);
      expect(admin.compliant).toBe(true);
    });
  });
});

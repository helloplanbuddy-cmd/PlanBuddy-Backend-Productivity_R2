'use strict';

const paymentController = require('../controllers/paymentController');

describe('ISSUE 1: Webhook → Queue → Worker → Financial Apply Guarantee (producer-side proof)', () => {
  test('webhook request is persisted and enqueues webhook-events job', async () => {
    // Arrange
    const enqueueWebhookEvent = jest.fn().mockResolvedValue({ id: 'job_1' });

    // Mock enqueue producer
    jest.doMock('../config/queues', () => ({
      enqueueWebhookEvent,
    }));

    // Mock DB transaction to capture that the webhook insert path ran
    const dbTransaction = jest.fn().mockImplementation(async (fn) => {
      const client = {
        query: jest.fn().mockResolvedValue({
          rowCount: 1,
          rows: [{ id: 99, status: 'received' }],
        }),
      };
      return fn(client);
    });

    jest.doMock('../config/db', () => ({
      transaction: dbTransaction,
      query: jest.fn(),
    }));

    // Mock webhook authenticity service
    const verifyIngressSignature = jest.fn().mockReturnValue({ signature: 'sig_ok' });
    const extractPayloadBytes = jest.fn((body) => (typeof body === 'string' ? body : JSON.stringify(body)));

    jest.doMock('../services/webhookAuthenticityService', () => ({
      extractPayloadBytes,
      verifyIngressSignature,
    }));

    // Mock config/redis and alertingService (best-effort paths)
    jest.doMock('../config/redis', () => ({
      redis: {
        incr: jest.fn().mockResolvedValue(1),
        expire: jest.fn().mockResolvedValue(1),
      },
    }));

    jest.doMock('../services/alertingService', () => ({
      alertSystemOverload: jest.fn().mockResolvedValue(undefined),
    }));

    // Re-require controller after mocks (isolated module loader)
    jest.resetModules();
    const controller = require('../controllers/paymentController');

    const req = {
      headers: { 'x-razorpay-signature': 'raz_sig' },
      requestId: 'corr_1',
      body: {
        razorpay_event_id: 'evt_test_1',
        event: 'payment.captured',
        razorpay_payment_id: 'pay_test_1',
        payment: { entity: { id: 'pay_test_1' } },
      },
      user: { id: 123 },
    };

    const res = {
      json: jest.fn().mockReturnThis(),
      status: jest.fn().mockReturnThis(),
    };

    const next = jest.fn();

    // Act
    await controller.razorpayWebhook(req, res, next);

    // Assert
    expect(dbTransaction).toHaveBeenCalledTimes(1);
    expect(enqueueWebhookEvent).toHaveBeenCalledTimes(1);

    const enqueuedArg = enqueueWebhookEvent.mock.calls[0][0];
    expect(enqueuedArg).toMatchObject({
      eventId: 'evt_test_1',
      provider: 'razorpay',
      eventType: 'payment.captured',
    });

    // Persistence response acknowledged
    expect(res.json).toHaveBeenCalledTimes(1);
    expect(res.json.mock.calls[0][0]).toEqual({ success: true });
  });
});

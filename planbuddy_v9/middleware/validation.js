'use strict';

/**
 * middleware/validation.js — Zod Request Validator (v3.0)
 *
 * Classification: ✅ KEEP — logic was correct in v2.0.
 * UPGRADE: Forwards ZodError directly to next(err) — the v3.0 errorHandler
 * now handles ZodError natively and produces the structured { validationErrors }
 * array, so we don't need to normalise here.
 *
 * Usage:
 *   const { validate } = require('../middleware/validation');
 *   const { z } = require('zod');
 *
 *   const CreateBookingSchema = z.object({
 *     tripId:    z.string().uuid(),
 *     startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
 *     groupSize: z.number().int().min(1).max(20),
 *   });
 *
 *   router.post('/', authenticate, validate(CreateBookingSchema), bookingCtrl.create);
 *
 * Validates req.body by default. Pass { query: Schema } or { params: Schema }
 * to validate other parts of the request.
 */

const { ZodError } = require('zod');

/**
 * Validate req.body (default), req.query, or req.params against a Zod schema.
 *
 * @param {import('zod').ZodSchema} schema
 * @param {'body'|'query'|'params'} [source='body']
 * @returns Express middleware
 */
function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      // Forward ZodError to the global error handler which normalises it
      return next(result.error);
    }

    // Replace the source with the parsed (and coerced) data
    req[source] = result.data;
    next();
  };
}

/**
 * Validate multiple sources in one middleware call.
 * Useful when a route needs both body and params validated.
 *
 * @param {{ body?: ZodSchema, query?: ZodSchema, params?: ZodSchema }} schemas
 * @returns Express middleware
 */
function validateAll(schemas) {
  return (req, res, next) => {
    for (const [source, schema] of Object.entries(schemas)) {
      const result = schema.safeParse(req[source]);
      if (!result.success) return next(result.error);
      req[source] = result.data;
    }
    next();
  };
}

const { z } = require('zod');

// ─── Validation Schemas ──────────────────────────────────────────────────────

// Booking schemas
const CreateBookingSchema = z.object({
  tripId:         z.string().uuid('Invalid trip ID'),
  travelDate:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format (YYYY-MM-DD)'),
  groupSize:      z.number().int().min(1, 'Group size must be at least 1').max(50, 'Group size cannot exceed 50'),
  slotId:         z.string().uuid().optional(),
  idempotencyKey: z.string().max(255).optional(),
});

const GetBookingsSchema = z.object({
  page:   z.string().regex(/^\d+$/).transform(Number).refine(n => n >= 1, 'Page must be >= 1').optional(),
  limit:  z.string().regex(/^\d+$/).transform(Number).refine(n => n >= 1 && n <= 50, 'Limit must be 1-50').optional(),
  status: z.enum(['pending', 'confirmed', 'cancelled', 'completed', 'expired', 'failed']).optional(),
});

const CancelBookingSchema = z.object({
  reason: z.string().max(500).optional(),
});

// Payment schemas
const CreateOrderSchema = z.object({
  bookingId: z.string().uuid('Invalid booking ID'),
});

const VerifyPaymentSchema = z.object({
  razorpay_order_id:    z.string().min(1).max(100),
  razorpay_payment_id:  z.string().min(1).max(100),
  razorpay_signature:   z.string().min(1).max(500),
  amount:               z.number().int().min(1),
  currency:             z.string().length(3).default('INR'),
});

// Admin schemas
const AdminBookingsSchema = z.object({
  page:   z.string().regex(/^\d+$/).transform(Number).refine(n => n >= 1).optional(),
  limit:  z.string().regex(/^\d+$/).transform(Number).refine(n => n >= 1 && n <= 50).optional(),
  status: z.enum(['pending', 'confirmed', 'cancelled', 'completed', 'expired', 'failed']).optional(),
});

module.exports = { validate, validateAll, CreateBookingSchema, GetBookingsSchema, CancelBookingSchema, CreateOrderSchema, VerifyPaymentSchema, AdminBookingsSchema };

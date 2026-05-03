'use strict';

/**
 * config/razorpay.js — Razorpay Client Config (v3.0)
 *
 * Classification: ✅ KEEP from v2.0 — logic is correct.
 * UPGRADE: Keys now read from config/env.js (validated at startup).
 * Hard failure on construction: if keys are missing the startup env check
 * already exits, so reaching this point guarantees keys exist.
 */

const Razorpay = require('razorpay');
const env      = require('./env');

// Keys are guaranteed to be set by config/env.js startup validation.
const keyId     = env.RAZORPAY_KEY_ID;
const keySecret = env.RAZORPAY_KEY_SECRET;

// Singleton client — instantiated once at module load.
const razorpayClient = new Razorpay({
  key_id:     keyId,
  key_secret: keySecret,
});

/**
 * Convert rupees (decimal) to paise (integer).
 * Razorpay amounts are always in the smallest currency unit.
 *
 * @param {number} rupees
 * @returns {number} paise (integer)
 */
function rupeesToPaise(rupees) {
  return Math.round(Number(rupees) * 100);
}

/**
 * Convert paise (integer) back to rupees.
 *
 * @param {number} paise
 * @returns {number} rupees (2 decimal places)
 */
function paiseToRupees(paise) {
  return Number((paise / 100).toFixed(2));
}

module.exports = {
  client:        razorpayClient,
  keyId,
  keySecret,
  webhookSecret: env.RAZORPAY_WEBHOOK_SECRET,
  rupeesToPaise,
  paiseToRupees,
};

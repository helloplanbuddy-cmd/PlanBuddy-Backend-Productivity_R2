'use strict';

/**
 * utils/money.js — Canonical Monetary Unit Helpers (v1.0)
 *
 * FINANCIAL INVARIANT: All internal representations use INTEGER PAISE.
 *
 *   DB columns  → BIGINT paise   (never FLOAT, DECIMAL, or rupee-denominated)
 *   Queue jobs  → paise (integer)
 *   Workers     → paise internally; rupees only at API boundaries
 *   Razorpay    → paise (Razorpay requires smallest-unit amounts)
 *
 * DO NOT scatter `amount * 100` or `amount / 100` across the codebase.
 * Import and use ONLY these functions everywhere money is converted.
 *
 * Single source of truth: this file.
 * Razorpay SDK config (config/razorpay.js) also exports these for backward
 * compatibility, but this file is the authoritative implementation.
 */

/**
 * Convert rupees (decimal input) → paise (safe integer).
 *
 * Rounds to the nearest paisa to avoid floating-point drift.
 * Validates input strictly — throws rather than silently returning NaN/0.
 *
 * @param {number|string} rupees  - Amount in rupees (e.g. 499.00)
 * @returns {number}              - Integer paise (e.g. 49900)
 * @throws {TypeError}            - If input is null, undefined, or non-numeric
 * @throws {RangeError}           - If input is negative
 *
 * @example
 *   rupeesToPaise(499)     // 49900
 *   rupeesToPaise(499.99)  // 49999
 *   rupeesToPaise('100')   // 10000
 */
function rupeesToPaise(rupees) {
  if (rupees === null || rupees === undefined) {
    throw new TypeError('rupeesToPaise: amount must not be null or undefined');
  }
  const n = Number(rupees);
  if (!Number.isFinite(n)) {
    throw new TypeError(`rupeesToPaise: invalid amount "${rupees}" — not a finite number`);
  }
  if (n < 0) {
    throw new RangeError(`rupeesToPaise: amount must be non-negative, got ${n}`);
  }
  return Math.round(n * 100);
}

/**
 * Convert paise (integer) → rupees (2 decimal places).
 *
 * Use ONLY for:
 *   - External API responses (display to end users)
 *   - Razorpay API response parsing (their amounts are in paise)
 *   - Storing to columns that are historically denominated in rupees
 *     (transitional — prefer migrating those columns to paise BIGINT)
 *
 * @param {number} paise  - Amount in paise (e.g. 49900)
 * @returns {number}      - Rupees rounded to 2 decimal places (e.g. 499.00)
 * @throws {TypeError}    - If input is null, undefined, or non-numeric
 *
 * @example
 *   paiseToRupees(49900)  // 499
 *   paiseToRupees(49999)  // 499.99
 */
function paiseToRupees(paise) {
  if (paise === null || paise === undefined) {
    throw new TypeError('paiseToRupees: amount must not be null or undefined');
  }
  const n = Number(paise);
  if (!Number.isFinite(n)) {
    throw new TypeError(`paiseToRupees: invalid amount "${paise}" — not a finite number`);
  }
  return Number((n / 100).toFixed(2));
}

/**
 * Assert that a value is a valid paise amount (non-negative integer).
 *
 * Use at DB write boundaries to catch unit bugs before they corrupt ledger state.
 *
 * @param {number} paise      - Value to validate
 * @param {string} [context]  - Caller context for error messages
 * @throws {RangeError}       - If value is not a non-negative integer
 *
 * @example
 *   assertPaise(49900, 'refund amount')  // OK
 *   assertPaise(499.00, 'refund amount') // throws — fractional rupees slipped through
 *   assertPaise(-100, 'refund amount')   // throws — negative amount
 */
function assertPaise(paise, context) {
  const tag = context ? ` [${context}]` : '';
  if (!Number.isInteger(paise)) {
    throw new RangeError(
      `assertPaise${tag}: expected integer paise, got ${paise} (fractional — raw rupees may have been passed)`
    );
  }
  if (paise < 0) {
    throw new RangeError(
      `assertPaise${tag}: expected non-negative paise, got ${paise}`
    );
  }
}

/**
 * Safely convert an amount to paise, accepting either unit.
 *
 * Use ONLY during the migration period where job data unit is uncertain.
 * After full paise enforcement this function should be removed.
 *
 * Heuristic: if value >= 100 AND not obviously a rupee amount, treat as paise.
 * IMPORTANT: This heuristic is ONLY safe for amounts > ₹1 (100 paise).
 * For amounts < ₹1 always use explicit rupeesToPaise / assertPaise.
 *
 * @param {number} amount   - Amount in either rupees or paise
 * @param {'rupees'|'paise'} unit - Explicit unit (preferred — never guess)
 * @returns {number}        - Integer paise
 */
function toCanonicalPaise(amount, unit) {
  if (unit === 'paise') {
    assertPaise(Math.round(amount), 'toCanonicalPaise');
    return Math.round(amount);
  }
  if (unit === 'rupees') {
    return rupeesToPaise(amount);
  }
  throw new TypeError(`toCanonicalPaise: unit must be "rupees" or "paise", got "${unit}"`);
}

module.exports = {
  rupeesToPaise,
  paiseToRupees,
  assertPaise,
  toCanonicalPaise,
};

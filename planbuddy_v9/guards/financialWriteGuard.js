'use strict';

/**
 * financialWriteGuard.js
 *
 * Purpose:
 *  - Block any attempt to directly mutate financial tables.
 *  - Only allow financial state changes to happen via FinancialStateManager.
 *
 * Usage:
 *  - Wrap/override db.query in db layer (Phase 3) to call guard before executing SQL.
 */

const FORBIDDEN_PATTERNS = [
  // Payments / Refunds / Bookings direct UPDATE
  { re: /^\s*update\s+payments\b/i, msg: 'FINANCIAL WRITE VIOLATION: direct mutation forbidden (payments)' },
  { re: /^\s*update\s+refunds\b/i, msg: 'FINANCIAL WRITE VIOLATION: direct mutation forbidden (refunds)' },
  { re: /^\s*update\s+bookings\b/i, msg: 'FINANCIAL WRITE VIOLATION: direct mutation forbidden (bookings)' },

  // Direct INSERT for refunds (only allowed via FinancialStateManager marker)
  { re: /^\s*insert\s+into\s+refunds\b/i, msg: 'FINANCIAL WRITE VIOLATION: direct mutation forbidden (refunds insert)' },

  // Also catch "UPDATE <alias>." forms used in code: UPDATE p SET ...
  { re: /^\s*update\s+p\s+/i, msg: 'FINANCIAL WRITE VIOLATION: direct mutation forbidden (payments alias)' },
  { re: /^\s*update\s+b\s+/i, msg: 'FINANCIAL WRITE VIOLATION: direct mutation forbidden (bookings alias)' },
  { re: /^\s*update\s+r\s+/i, msg: 'FINANCIAL WRITE VIOLATION: direct mutation forbidden (refunds alias)' },
];

function isFinancialUpdateSql(sql) {
  if (typeof sql !== 'string') return false;

  // Allow FinancialStateManager-owned writes via explicit marker.
  // FinancialStateManager must include `/*financialStateManager*/` in the SQL it emits.
  if (sql.includes('/*financialStateManager*/')) return false;

  return FORBIDDEN_PATTERNS.some(({ re }) => re.test(sql));
}

/**
 * Guard entrypoint called by db.query wrapper.
 * @param {string} sql
 * @param {object} context optional
 * @returns {void}
 * @throws Error
 */
function guardFinancialWrite(sql, context = {}) {
  // Allow guard to be bypassed explicitly only when the call originates
  // from FinancialStateManager itself (context token set by db wrapper).
  if (context && context.__fromFinancialStateManager === true) return;

  if (isFinancialUpdateSql(sql)) {
    const err = new Error(
      `FINANCIAL WRITE VIOLATION (BLOCKED): direct mutation forbidden. ${context?.entityType ? `(entity=${context.entityType})` : ''}`.trim()
    );

    // Crash immediately for money correctness (fail-fast).
    // This prevents “catch + continue” patterns from silently drifting state.
    // eslint-disable-next-line no-process-exit
    process.nextTick(() => process.exit(1));

    throw err;
  }
}

module.exports = {
  isFinancialUpdateSql,
  guardFinancialWrite,
};

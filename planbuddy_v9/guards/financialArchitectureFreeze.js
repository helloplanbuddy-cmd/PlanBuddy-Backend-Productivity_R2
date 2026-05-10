'use strict';

/**
 * financialArchitectureFreeze.js
 *
 * Production regression lock:
 *  - Blocks any execution of direct financial writes (UPDATE payments/refunds/bookings,
 *    INSERT INTO refunds) unless the call originates from FinancialStateManager.
 *  - Uses call-stack + module origin verification to prevent “guard bypass” regressions.
 */

const FINANCIAL_TABLES = ['payments', 'refunds', 'bookings'];
const forbiddenSqlStarts = [
  /^\s*update\s+payments\b/i,
  /^\s*update\s+refunds\b/i,
  /^\s*update\s+bookings\b/i,
  /^\s*insert\s+into\s+refunds\b/i,
];

// FinancialStateManager module origin (case-insensitive compare).
const FSM_PATH_PART = 'services/financialstatemanager.js';

function isForbiddenSql(sql) {
  if (typeof sql !== 'string') return false;
  return forbiddenSqlStarts.some((re) => re.test(sql));
}

function stackIncludesFinancialStateManager(err) {
  if (!err || !err.stack) return false;
  return err.stack.toLowerCase().includes(FSM_PATH_PART.toLowerCase());
}

function freezeFinancialArchitectureGuard(sql) {
  if (!isForbiddenSql(sql)) return;

  // Fail-fast with stack verification.
  const err = new Error('ARCHITECTURE VIOLATION: FINANCIAL WRITE OUTSIDE FSM');
  if (!stackIncludesFinancialStateManager(err)) {
    // Crash immediately for money correctness.
    // eslint-disable-next-line no-process-exit
    process.nextTick(() => process.exit(1));
    throw err;
  }
}

module.exports = {
  freezeFinancialArchitectureGuard,
};

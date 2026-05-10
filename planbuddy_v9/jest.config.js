module.exports = {
  testEnvironment: 'node',
  // Only run actual spec files. `__tests__/utils/financialTestHarness.js` is a helper, not a test suite.
  testMatch: ['**/__tests__/**/*.test.js'],
};

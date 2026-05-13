module.exports = {
  testEnvironment: 'node',
  maxWorkers: 1,
  testTimeout: 30000,
  // Jest v29: forceExit is root-level config
  forceExit: true,

  // Include both unit and integration tests in a single project so CLI path matching is deterministic.
  testMatch: [
    '**/__tests__/**/*.unit.test.js',
    '**/tests/integration/**/*.test.js',
  ],

  testPathIgnorePatterns: [
    '/node_modules/',
    '__tests__/setup.js',
    '__tests__/mocks/',
    '__tests__/refund-exactly-once.test.js', // DB integration test (skip)
    '__tests__/financial/', // DB integration tests (skip)
  ],
};




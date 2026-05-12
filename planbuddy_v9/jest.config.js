module.exports = {
  testEnvironment: 'node',
  testTimeout: 30000,
  maxWorkers: 1,
  forceExit: true,
  testMatch: [
    '**/__tests__/**/*.unit.test.js', // Only run unit tests
  ],
  testPathIgnorePatterns: [
    '/node_modules/',
    '__tests__/setup.js',
    '__tests__/mocks/',
    '__tests__/refund-exactly-once.test.js', // DB integration test (skip for now)
    '__tests__/financial/',  // DB integration tests
  ],
};


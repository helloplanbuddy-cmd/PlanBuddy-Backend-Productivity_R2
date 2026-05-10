"use strict";

const env = require('../config/env');

// Load configs early
require('../config/db');
require('../config/redis');
require('../config/queues');

// Start all workers (MUST be enabled in production)
require('./webhook-processor.worker');
require('./payment-reconciliation-queue.worker');
require('./refund-retry.worker');
require('./dlq-processor.worker');

console.log('All PlanBuddy workers started');

// Keep process alive
process.stdin.resume();

"use strict";

const env = require('../config/env');

// Load configs early
require('../config/db');
require('../config/redis');
require('../config/queues');

// Start all workers
// require('./paymentReconciliation.worker');\n// require('./dlq-processor.worker');\n// require('./sessionCleanup.worker');\n// require('./payment-audit-retention.worker');\n// require('./alert-poller.worker');\n// require('./expiry.worker');

console.log('All PlanBuddy workers started');

 // Keep process alive
process.stdin.resume();


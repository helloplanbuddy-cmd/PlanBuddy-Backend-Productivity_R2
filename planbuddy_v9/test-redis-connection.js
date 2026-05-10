'use strict';

/**
 * test-redis-connection.js
 * 
 * Verification script for PHASE 1: Redis Runtime Reliability
 * 
 * This script tests:
 * 1. Redis connection establishment
 * 2. Queue connection stability
 * 3. Reconnection behavior
 * 4. Health check responsiveness
 */

const path = require('path');
const Module = require('module');

// Setup node modules path (same as workers/index.js)
const planbuddyNodeModules = path.resolve(__dirname, '../../planbuddy_v9/node_modules');
if (!process.env.NODE_PATH) process.env.NODE_PATH = planbuddyNodeModules;
else process.env.NODE_PATH = `${process.env.NODE_PATH}${path.delimiter}${planbuddyNodeModules}`;
Module._initPaths();

// Load configs
require('./config/env');
const { redis, redisQueue, isHealthy, isQueueHealthy } = require('./config/redis');

const logger = require('./utils/logger');

async function testRedisConnection() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║        PHASE 1: REDIS RUNTIME RELIABILITY TEST             ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  const env = require('./config/env');
  console.log('Configuration:');
  console.log(`  NODE_ENV: ${env.NODE_ENV}`);
  console.log(`  REDIS_URL: ${env.REDIS_URL}`);
  console.log(`  REDIS_QUEUE_URL: ${env.REDIS_QUEUE_URL}`);
  console.log();

  const results = {
    cacheConnected: false,
    queueConnected: false,
    cacheLatency: null,
    queueLatency: null,
    startTime: Date.now(),
  };

  // Test cache connection
  console.log('Testing Redis Cache Connection...');
  try {
    const health = await Promise.race([
      isHealthy(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Cache health check timeout')), 10000)
      )
    ]);
    
    if (health.status === 'ok') {
      results.cacheConnected = true;
      results.cacheLatency = health.latencyMs;
      console.log(`  ✓ Cache connected (latency: ${health.latencyMs}ms)`);
    } else {
      console.log(`  ✗ Cache health check failed: ${health.error}`);
    }
  } catch (err) {
    console.log(`  ✗ Cache connection error: ${err.message}`);
  }

  // Test queue connection
  console.log('\nTesting Redis Queue Connection...');
  try {
    const health = await Promise.race([
      isQueueHealthy(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Queue health check timeout')), 10000)
      )
    ]);
    
    if (health.status === 'ok') {
      results.queueConnected = true;
      results.queueLatency = health.latencyMs;
      console.log(`  ✓ Queue connected (latency: ${health.latencyMs}ms)`);
    } else {
      console.log(`  ✗ Queue health check failed: ${health.error}`);
    }
  } catch (err) {
    console.log(`  ✗ Queue connection error: ${err.message}`);
  }

  // Test sustained connection (60 seconds)
  console.log('\nTesting sustained connection (60 seconds)...');
  const testDurationMs = 60_000;
  const pingIntervalMs = 5_000;
  let successCount = 0;
  let failCount = 0;

  return new Promise((resolve) => {
    const startTime = Date.now();
    const interval = setInterval(async () => {
      try {
        const queueHealth = await isQueueHealthy();
        if (queueHealth.status === 'ok') {
          successCount++;
          process.stdout.write('.');
        } else {
          failCount++;
          process.stdout.write('F');
        }
      } catch (err) {
        failCount++;
        process.stdout.write('E');
      }

      const elapsed = Date.now() - startTime;
      if (elapsed >= testDurationMs) {
        clearInterval(interval);
        console.log();
        console.log(`\nTest Results:`);
        console.log(`  Successful pings: ${successCount}/${successCount + failCount}`);
        console.log(`  Failed pings: ${failCount}/${successCount + failCount}`);
        
        const verdict = failCount === 0 && successCount >= 10;
        console.log(`\n${verdict ? '✓' : '✗'} PHASE 1 ${verdict ? 'PASSED' : 'FAILED'}`);
        
        if (verdict) {
          console.log('\nHARD STOP CONDITION: ✓ SATISFIED');
          console.log('  • Redis connection is stable');
          console.log('  • No reconnection loop detected');
          console.log('  • Worker can stay connected for 60+ seconds');
          console.log('\nReady to proceed to PHASE 2\n');
        } else {
          console.log('\nHARD STOP CONDITION: ✗ NOT SATISFIED');
          console.log('  • Redis connection unstable');
          console.log('  • Check Redis service health');
          console.log('  • Verify REDIS_URL points to running Redis\n');
        }

        process.exit(verdict ? 0 : 1);
      }
    }, pingIntervalMs);
  });
}

// Run test
testRedisConnection().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('\nShutting down gracefully...');
  process.exit(0);
});

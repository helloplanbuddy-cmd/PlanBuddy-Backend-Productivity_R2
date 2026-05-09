'use strict';

/**
 * workers/sessionCleanup.worker.js — Redis Session Cleanup Worker
 *
 * PHASE 3: Background cleanup for orphaned/stale sessions
 *
 * Runs every 5 minutes to:
 * 1. Clean expired refresh tokens (TTL already expired)
 * 2. Clean orphaned ZSET entries in user:sessions:* that have no valid token
 * 3. Report cleanup statistics
 *
 * This prevents:
 * - Memory leaks from expired keys
 * - Orphaned ZSET entries pointing to deleted tokens
 * - Session count drift causing MAX_SESSION_LIMIT issues
 */

const logger = require('../utils/logger');
const monitoring = require('../utils/monitoring');
const { redis } = require('../config/redis');

const REFRESH_SET_PREFIX = 'refresh:ids:';
const SESSION_SET_PREFIX = 'user:sessions:';
const REFRESH_PREFIX = 'refresh:';
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Clean up orphaned ZSET entries.
 * Sometimes ZSET contains tokenIds but the corresponding refresh:* key is gone.
 * This causes session count drift and incorrect MAX_SESSION_LIMIT enforcement.
 */
async function cleanupOrphanedSessionEntries() {
  if (!redis) {
    logger.warn('Redis unavailable — skipping cleanup');
    return { cleaned: 0 };
  }

  let totalCleaned = 0;
  let cursor = '0';

  do {
    // SCAN through all session sets
    const [nextCursor, keys] = await redis.scan(
      cursor,
      'MATCH',
      `${SESSION_SET_PREFIX}*`,
      'COUNT',
      100
    );
    cursor = nextCursor;

    for (const sessionKey of keys) {
      try {
        // Get all member-scores from ZSET
        const members = await redis.zrange(sessionKey, 0, -1, 'WITHSCORES');
        if (!members || members.length === 0) continue;

        const orphaned = [];
        // Check each tokenId - if the refresh key doesn't exist, it's orphaned
        for (let i = 0; i < members.length; i += 2) {
          const tokenId = members[i];
          const tokenKey = `${REFRESH_PREFIX}${tokenId.split(':')[1] || ''}`;
          
          // Try to parse the userId from session key
          const userId = sessionKey.replace(SESSION_SET_PREFIX, '');
          const fullRefreshKey = `${REFRESH_PREFIX}${userId}:${tokenId}`;
          
          const exists = await redis.exists(fullRefreshKey);
          if (!exists) {
            orphaned.push(tokenId);
          }
        }

        // Remove orphaned entries
        if (orphaned.length > 0) {
          await redis.zrem(sessionKey, ...orphaned);
          totalCleaned += orphaned.length;
          logger.debug('Cleaned orphaned session entries', {
            sessionKey,
            count: orphaned.length,
          });
        }
      } catch (err) {
        logger.error('Error cleaning session key', {
          sessionKey,
          error: err.message,
        });
      }
    }
  } while (cursor !== '0');

  return { cleaned: totalCleaned };
}

/**
 * Main cleanup function.
 * Also reports metrics for monitoring.
 */
async function runCleanup() {
  const correlationId = `session-cleanup-${Date.now()}`;
  logger.info('Session cleanup started', { correlationId });

  try {
    const startMemory = process.memoryUsage().heapUsed;

    // Run orphaned entry cleanup
    const result = await cleanupOrphanedSessionEntries();

    const endMemory = process.memoryUsage().heapUsed;
    const memoryFreed = startMemory - endMemory;

    // Report metrics
    if (monitoring.redis_session_cleanup_total) {
      monitoring.redis_session_cleanup_total.inc(result.cleaned);
    }

    logger.info({
      correlationId,
      cleaned: result.cleaned,
      memoryFreed,
    }, '[sessionCleanup] Cleanup complete');

    return result;
  } catch (err) {
    logger.error({
      correlationId,
      error: err.message,
      stack: err.stack,
    }, '[sessionCleanup] Cleanup failed');
    throw err;
  }
}

// Run immediately on start
runCleanup();

// Run every 5 minutes
let shuttingDown = false;

process.on('SIGTERM', () => {
  logger.info('Session cleanup worker: SIGTERM received — draining');
  shuttingDown = true;
});

const interval = setInterval(async () => {
  if (shuttingDown) {
    clearInterval(interval);
    logger.info('Session cleanup worker: shutting down');
    process.exit(0);
  }

  await runCleanup().catch((err) => {
    logger.error('Session cleanup worker: unhandled error', {
      error: err.message,
      stack: err.stack,
    });
  });
}, CLEANUP_INTERVAL_MS);

module.exports = { runCleanup };

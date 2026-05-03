'use strict';

/**
 * services/circuitBreaker.js — Circuit Breaker Pattern
 *
 * PHASE 4: External API Safety (Razorpay)
 *
 * Problem:
 *  - Razorpay downtime = cascading failure
 *  - Requests pile up waiting for timeout
 *  - Threadpool exhaustion
 *
 * Solution:
 *  - States: CLOSED → OPEN → HALF_OPEN
 *  - Fail fast when open
 *  - Auto-recovery after cooldown
 */

const db = require('../config/db');
const logger = require('../utils/logger');

const STATES = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
};

// Configuration per service
const CONFIG = {
  razorpay: {
    failureThreshold: 5,      // Open after 5 failures
    successThreshold: 2,      // Close after 2 successes
    timeout: 30 * 1000,       // 30s cooldown
  },
  redis: {
    failureThreshold: 3,
    successThreshold: 1,
    timeout: 10 * 1000,
  },
  default: {
    failureThreshold: 5,
    successThreshold: 2,
    timeout: 30 * 1000,
  },
};

/**
 * Get circuit breaker state from DB.
 */
async function getState(serviceName) {
  try {
    const result = await db.query(
      `SELECT * FROM circuit_breaker_state WHERE service_name = $1`,
      [serviceName]
    );

    if (result.rows.length > 0) {
      return result.rows[0];
    }

    // Create new state
    const newState = await db.query(
      `INSERT INTO circuit_breaker_state (service_name, state)
       VALUES ($1, 'CLOSED')
       RETURNING *`,
      [serviceName]
    );

    return newState.rows[0];
  } catch (err) {
    logger.warn('Circuit breaker getState failed', { serviceName, error: err.message });
    return { service_name: serviceName, state: STATES.CLOSED, failure_count: 0 };
  }
}

/**
 * Update circuit breaker state.
 */
async function updateState(serviceName, updates) {
  const fields = [];
  const values = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(updates)) {
    fields.push(`${key} = $${paramIndex}`);
    values.push(value);
    paramIndex++;
  }

  values.push(serviceName);

  try {
    await db.query(
      `UPDATE circuit_breaker_state
       SET ${fields.join(', ')}, updated_at = NOW()
       WHERE service_name = $${paramIndex}`,
      values
    );
  } catch (err) {
    logger.warn('Circuit breaker updateState failed', { serviceName, error: err.message });
  }
}

/**
 * Check if circuit is allowing requests.
 * Returns: { allowed: boolean, state: string, reason?: string }
 */
async function isAllowed(serviceName) {
  const config = CONFIG[serviceName] || CONFIG.default;
  const state = await getState(serviceName);

  // If CLOSED - allow
  if (state.state === STATES.CLOSED) {
    return { allowed: true, state: STATES.CLOSED };
  }

  // If OPEN - check timeout
  if (state.state === STATES.OPEN) {
    const openedAt = state.opened_at ? new Date(state.opened_at).getTime() : 0;
    const now = Date.now();

    // Timeout reached - move to HALF_OPEN
    if (now - openedAt > config.timeout) {
      await updateState(serviceName, { state: STATES.HALF_OPEN });
      return { allowed: true, state: STATES.HALF_OPEN };
    }

    // Still in timeout - reject
    return {
      allowed: false,
      state: STATES.OPEN,
      reason: `Circuit open for ${serviceName}. Failures: ${state.failure_count}`,
    };
  }

  // If HALF_OPEN - allow but monitor
  return { allowed: true, state: STATES.HALF_OPEN };
}

/**
 * Record a successful call.
 */
async function recordSuccess(serviceName) {
  const state = await getState(serviceName);
  const config = CONFIG[serviceName] || CONFIG.default;

  if (state.state === STATES.HALF_OPEN) {
    const newSuccessCount = (state.success_count || 0) + 1;

    if (newSuccessCount >= config.successThreshold) {
      // Enough successes - close the circuit
      await updateState(serviceName, {
        state: STATES.CLOSED,
        failure_count: 0,
        success_count: 0,
        closed_at: new Date(),
      });

      logger.info('Circuit breaker closed', { serviceName });
    } else {
      await updateState(serviceName, { success_count: newSuccessCount });
    }
  } else if (state.state === STATES.CLOSED) {
    // Reset failure count on success
    await updateState(serviceName, { failure_count: 0 });
  }
}

/**
 * Record a failed call.
 */
async function recordFailure(serviceName, error) {
  const state = await getState(serviceName);
  const config = CONFIG[serviceName] || CONFIG.default;
  const newFailureCount = (state.failure_count || 0) + 1;

  if (state.state === STATES.CLOSED) {
    // Check if we should open
    if (newFailureCount >= config.failureThreshold) {
      await updateState(serviceName, {
        state: STATES.OPEN,
        failure_count: newFailureCount,
        opened_at: new Date(),
      });

      logger.error('Circuit breaker opened', {
        serviceName,
        failureCount: newFailureCount,
        error: error?.message,
      });
    } else {
      await updateState(serviceName, { failure_count: newFailureCount });
    }
  } else if (state.state === STATES.HALF_OPEN) {
    // Any failure in HALF_OPEN - go back to OPEN
    await updateState(serviceName, {
      state: STATES.OPEN,
      failure_count: newFailureCount,
      opened_at: new Date(),
    });

    logger.warn('Circuit breaker reopened after HALF_OPEN failure', {
      serviceName,
      error: error?.message,
    });
  }
}

/**
 * Execute a function with circuit breaker protection.
 * Falls back if circuit is open.
 */
async function execute(serviceName, fn, fallback = null) {
  const check = await isAllowed(serviceName);

  if (!check.allowed) {
    if (fallback) {
      logger.warn('Circuit breaker fallback executed', { serviceName });
      return fallback();
    }

    const error = new Error(check.reason);
    error.code = 'CIRCUIT_OPEN';
    error.service = serviceName;
    throw error;
  }

  try {
    const result = await fn();
    await recordSuccess(serviceName);
    return result;
  } catch (err) {
    await recordFailure(serviceName, err);
    throw err;
  }
}

/**
 * Get all circuit breaker states (for health checks).
 */
async function getAllStates() {
  try {
    const result = await db.query(
      `SELECT service_name, state, failure_count, last_failure, opened_at, updated_at
       FROM circuit_breaker_state`
    );

    return result.rows;
  } catch (err) {
    logger.warn('Circuit breaker getAllStates failed', { error: err.message });
    return [];
  }
}

module.exports = {
  STATES,
  isAllowed,
  recordSuccess,
  recordFailure,
  execute,
  getAllStates,
  getState,
};

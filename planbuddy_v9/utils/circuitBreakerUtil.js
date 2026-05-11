'use strict';

/**
 * circuitBreakerUtil.js — Circuit Breaker for External API Calls
 * 
 * Prevents cascading failures when external APIs (Razorpay, etc.) degrade.
 * States: CLOSED (normal) → OPEN (failing fast) → HALF_OPEN (recovery test)
 */

const logger = require('./logger');

class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5;      // Fail after N errors
    this.successThreshold = options.successThreshold || 2;      // Recover after N successes
    this.timeout = options.timeout || 30000;                    // Time in OPEN state (ms)
    this.name = options.name || 'CircuitBreaker';

    this.state = 'CLOSED';
    this.failureCount = 0;
    this.successCount = 0;
    this.nextAttempt = Date.now();

    this.metrics = {
      totalRequests: 0,
      totalErrors: 0,
      totalSuccesses: 0,
      stateTransitions: 0,
    };
  }

  /**
   * Execute a function with circuit breaker protection
   * @param {Function} fn - Async function to execute
   * @param {string} operationName - Name for logging
   * @returns {Promise} Result from fn or circuit breaker error
   */
  async execute(fn, operationName = 'operation') {
    this.metrics.totalRequests++;

    // If OPEN and timeout not reached, fail fast
    if (this.state === 'OPEN' && Date.now() < this.nextAttempt) {
      const err = new Error(`Circuit breaker OPEN for ${this.name}`);
      err.code = 'CIRCUIT_BREAKER_OPEN';
      err.status = 503;
      logger.warn({
        circuitBreaker: this.name,
        state: this.state,
        operationName,
      }, '[circuit-breaker] Failing fast (OPEN)');
      throw err;
    }

    // If timeout reached in OPEN state, try recovery (HALF_OPEN)
    if (this.state === 'OPEN' && Date.now() >= this.nextAttempt) {
      this.state = 'HALF_OPEN';
      this.successCount = 0;
      this.metrics.stateTransitions++;
      logger.info({
        circuitBreaker: this.name,
        newState: 'HALF_OPEN',
      }, '[circuit-breaker] Attempting recovery');
    }

    try {
      const result = await fn();
      this._recordSuccess();
      return result;
    } catch (err) {
      this._recordFailure();
      throw err;
    }
  }

  _recordSuccess() {
    this.metrics.totalSuccesses++;

    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.state = 'CLOSED';
        this.failureCount = 0;
        this.metrics.stateTransitions++;
        logger.info({
          circuitBreaker: this.name,
          newState: 'CLOSED',
        }, '[circuit-breaker] Recovered to CLOSED');
      }
    } else if (this.state === 'CLOSED') {
      this.failureCount = 0;
    }
  }

  _recordFailure() {
    this.metrics.totalErrors++;

    if (this.state === 'HALF_OPEN') {
      // Recovery failed, back to OPEN
      this.state = 'OPEN';
      this.nextAttempt = Date.now() + this.timeout;
      this.failureCount = 0;
      this.metrics.stateTransitions++;
      logger.warn({
        circuitBreaker: this.name,
        newState: 'OPEN',
        timeout: this.timeout,
      }, '[circuit-breaker] Recovery failed, returning to OPEN');
    } else if (this.state === 'CLOSED') {
      this.failureCount++;
      if (this.failureCount >= this.failureThreshold) {
        this.state = 'OPEN';
        this.nextAttempt = Date.now() + this.timeout;
        this.metrics.stateTransitions++;
        logger.warn({
          circuitBreaker: this.name,
          newState: 'OPEN',
          failureCount: this.failureCount,
          timeout: this.timeout,
        }, '[circuit-breaker] Threshold exceeded, OPEN');
      }
    }
  }

  getState() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      metrics: this.metrics,
    };
  }

  reset() {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.successCount = 0;
    this.nextAttempt = Date.now();
    logger.info({ circuitBreaker: this.name }, '[circuit-breaker] Reset');
  }
}

module.exports = { CircuitBreaker };

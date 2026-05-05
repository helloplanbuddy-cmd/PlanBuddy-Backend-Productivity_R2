'use strict';

const pino = require('pino');
const env = require('../config/env');

const logger = pino({
  level: env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
    },
  },
});

module.exports = logger;

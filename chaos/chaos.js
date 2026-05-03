#!/usr/bin/env node
'use strict';

/**
 * chaos/chaos.js — Chaos Engineering CLI
 *
 * Validate fintech resilience:
 *  $ node chaos.js db-latency 500 --duration 30s
 *  $ node chaos.js worker-kill
 *  $ node chaos.js webhook-storm 100rps
 *
 * Stripe-level: test before prod sees failure
 */

const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const db = require('../planbuddy_v8/config/db');
const { redis } = require('../planbuddy_v8/config/redis');
const { exec } = require('child_process');
const http = require('http');
const logger = require('../planbuddy_v8/utils/logger');

const argv = yargs(hideBin(process.argv))
  .command('db-latency <ms> [duration]', 'Inject DB latency', {
    ms: { demandOption: true, type: 'number' },
    duration: { default: 30, type: 'number' }  // seconds
  })
  .command('worker-kill', 'Kill workers to test restart')
  .command('webhook-storm <rps>', 'Simulate webhook retry storm', {
    rps: { demandOption: true, type: 'number' },
  })
  .demandCommand(1)
  .argv;

async function injectDbLatency(ms, durationSec) {
  const start = Date.now();
  const sleepMs = ms;
  console.log(`💥 Chaos: Injecting ${sleepMs}ms DB latency for ${durationSec}s`);
  
  const originalQuery = db.query;
  db.query = async (...args) => {
    if (Date.now() - start > durationSec * 1000) return originalQuery.apply(db, args);
    await new Promise(r => setTimeout(r, sleepMs));
    return originalQuery.apply(db, args);
  };

  setTimeout(() => {
    db.query = originalQuery;
    console.log('✅ Chaos: DB latency injection ended');
  }, durationSec * 1000);
}

function killWorkers() {
  exec('pm2 stop planbuddy-workers planbuddy-dlq-processor planbuddy-alert-poller', (err, stdout) => {
    if (err) console.error('PM2 stop error', err);
    console.log('💀 Chaos: Workers killed, PM2 will restart');
    setTimeout(() => exec('pm2 restart ecosystem.config.js'), 2000);
  });
}

async function webhookStorm(rps) {
  console.log(`🌩️ Chaos: Webhook storm ${rps}rps to localhost:3000/api/payment/webhook/razorpay`);
  
  const interval = 1000 / rps;
  let count = 0;

  const iv = setInterval(async () => {
    count++;
    const req = http.request({
      hostname: 'localhost',
      port: 3000,
      path: '/api/payment/webhook/razorpay',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => res.on('data', () => {}));
    req.write(JSON.stringify({ fake: 'webhook' }));
    req.end();
  }, interval);

  setTimeout(() => {
    clearInterval(iv);
    console.log(`✅ Chaos: Webhook storm ended (${count} requests)`);
  }, 60 * 1000);
}

// ─── Run ──────────────────────────────────────────────────────────────────────
(async () => {
  switch (argv._[0]) {
    case 'db-latency':
      await injectDbLatency(argv.ms, argv.duration);
      break;
    case 'worker-kill':
      killWorkers();
      break;
    case 'webhook-storm':
      await webhookStorm(argv.rps);
      break;
  }
})();


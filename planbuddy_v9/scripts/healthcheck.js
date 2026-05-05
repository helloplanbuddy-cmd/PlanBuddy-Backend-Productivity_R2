'use strict';

const db = require('../config/db');
const { redis, isHealthy: redisHealthy } = require('../config/redis');

(async () => {
  try {
    await db.query("SELECT 1");
    const redisStatus = await redisHealthy();
    if (redisStatus.status !== "ok") {
      throw new Error(`Redis unhealthy: ${redisStatus.error}`);
    }
    console.log("DB + Redis healthy");
    process.exit(0);
  } catch (err) {
    console.error("Healthcheck failed:", err.message);
    process.exit(1);
  }
})();


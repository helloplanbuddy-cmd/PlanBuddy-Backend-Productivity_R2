'use strict';
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true },
});

async function check() {
  try {
    const tables = await pool.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);
    console.log('Tables:', tables.rows.map(r => r.table_name));
    
    const bookings = await pool.query('SELECT COUNT(*) as count FROM bookings;');
    console.log('Bookings count:', Number(bookings.rows[0].count));
    
    const health = await pool.query('SELECT NOW() as now;');
    console.log('DB healthy:', health.rows[0].now);
  } catch (err) {
    console.error('DB FAIL:', err.message);
  } finally {
    await pool.end();
  }
}

check();

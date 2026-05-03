const http = require('http');
const https = require('https');
const url = require('url');

const concurrencyLevels = [100, 500, 1000];
const target = 'http://localhost:3000/api/v1/bookings'; // Update to your endpoint

async function loadTest(concurrency, durationSec = 30) {
  const requests = [];
  const startTime = Date.now();
  
  console.log(`\n=== LOAD TEST: ${concurrency} concurrent | ${durationSec}s ===`);
  
  let success = 0, failed = 0, totalLatency = 0;
  const latencies = [];
  
  // Spawn concurrent requests
  for (let i = 0; i < concurrency; i++) {
    requests.push(new Promise((resolve) => {
      const req = http.request(target, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer dummy-token', // Replace with valid token
          'Idempotency-Key': `loadtest-${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`
        }
      }, (res) => {
        const latency = Date.now() - startTime - (i * 10); // Approximate
        latencies.push(latency);
        totalLatency += latency;
        
        if (res.statusCode < 500) success++;
        else failed++;
        
        resolve();
      });
      
      req.on('error', () => {
        failed++;
        resolve();
      });
      
      req.write(JSON.stringify({ tripId: 'test-trip-1', travelDate: '2024-01-01', groupSize: 2 }));
      req.end();
    }));
  }
  
  // Wait for all or timeout
  await Promise.race([
    Promise.all(requests),
    new Promise(r => setTimeout(r, durationSec * 1000))
  ]);
  
  const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
  const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;
  const avg = totalLatency / latencies.length || 0;
  const rps = latencies.length / durationSec;
  
  console.log(`Results (${concurrency} conc):`);
  console.log(`  RPS: ${rps.toFixed(0)}`);
  console.log(`  P50: ${p50}ms | P95: ${p95}ms | P99: ${p99}ms | Avg: ${avg.toFixed(0)}ms`);
  console.log(`  Success: ${success} | Failed: ${failed} | Error Rate: ${(failed/(success+failed)*100).toFixed(1)}%`);
  
  return { concurrency, rps, p50, p95, p99, success, failed, errorRate: failed/(success+failed) };
}

(async () => {
  const results = [];
  for (const conc of concurrencyLevels) {
    results.push(await loadTest(conc));
  }
  
  console.log('\n=== SUMMARY ===');
  results.forEach(r => {
    const pass = r.errorRate < 0.01 && r.p95 < 500;
    console.log(`${r.concurrency} conc: ${pass ? 'PASS' : 'FAIL'} (err ${r.errorRate*100}%, p95 ${r.p95}ms)`);
  });
})();


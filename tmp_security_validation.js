const http = require('http');

const requests = [
  { path: '/ping', label: 'ping' },
  { path: '/health', label: 'health' },
  { path: '/internal/health/ready', label: 'internal-ready' },
  { path: '/pid', label: 'pid' },
];

function get(path, label) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: 3000, path }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        resolve({
          label,
          path,
          statusCode: res.statusCode,
          bodyPreview: data.slice(0, 200),
        });
      });
    });
    req.on('error', (err) => {
      resolve({ label, path, statusCode: null, error: err.message });
    });
  });
}

(async () => {
  const out = [];
  for (const r of requests) out.push(await get(r.path, r.label));
  console.log(JSON.stringify(out, null, 2));
})();

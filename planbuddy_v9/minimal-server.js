const http = require('http');

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/test') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }
  res.writeHead(404);
  res.end();
});

server.listen(3001, () => {
  console.log('Minimal server running on port 3001');
});

const http = require('http');

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}).listen(3001, () => {
  console.log('Minimal server running on 3001');
});

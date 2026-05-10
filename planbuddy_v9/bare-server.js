const http = require('http');

http.createServer((req, res) => {
  res.writeHead(200);
  res.end('ok');
}).listen(3000, () => {
  console.log('Bare server running on 3000');
});

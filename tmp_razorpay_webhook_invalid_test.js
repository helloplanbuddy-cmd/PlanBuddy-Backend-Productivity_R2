const http = require('http');

const body = JSON.stringify({
  event: 'payment.failed',
  payload: {
    payment: { entity: { id: 'pay_invalid_1', status: 'failed' } },
    event: { id: 'evt_invalid_1' },
  },
});

const options = {
  method: 'POST',
  host: '127.0.0.1',
  port: 3000,
  path: '/webhooks/razorpay',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'x-razorpay-signature': 'invalid_signature',
  },
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (c) => (data += c));
  res.on('end', () => {
    console.log(JSON.stringify({ statusCode: res.statusCode, bodyPreview: data.slice(0, 200) }, null, 2));
  });
});

req.on('error', (e) => {
  console.error(JSON.stringify({ error: e.message }, null, 2));
  process.exitCode = 1;
});

req.write(body);
req.end();

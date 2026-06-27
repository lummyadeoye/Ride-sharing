const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { once } = require('node:events');
const { createServer } = require('node:http');

function ensureDbFile() {
  const dir = path.join(__dirname, 'data');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'ride-sharing-test.db');
}

const dbPath = ensureDbFile();
fs.rmSync(dbPath, { force: true });
process.env.DB_PATH = dbPath;
const { app } = require('../server');

async function startServer() {
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function requestJson(baseUrl, pathName, options = {}) {
  const res = await fetch(`${baseUrl}${pathName}`, options);
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  return { res, body };
}

function getCookie(res) {
  const setCookie = res.headers.get('set-cookie');
  return setCookie ? setCookie.split(';')[0] : '';
}

test('users can rate a booked ride and view ratings', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const driverRes = await requestJson(baseUrl, '/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'driver', password: 'driver123' })
    });
    assert.equal(driverRes.res.status, 201);

    const customerRes = await requestJson(baseUrl, '/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'customer', password: 'customer123' })
    });
    assert.equal(customerRes.res.status, 201);

    const driverCookie = getCookie(driverRes.res);
    const customerCookie = getCookie(customerRes.res);

    const createRideRes = await requestJson(baseUrl, '/api/rides', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: driverCookie
      },
      body: JSON.stringify({ from: 'Downtown', to: 'Airport', seats: 3 })
    });
    assert.equal(createRideRes.res.status, 201);
    const rideId = createRideRes.body.ride.id;

    const bookRes = await requestJson(baseUrl, `/api/rides/${rideId}/book`, {
      method: 'POST',
      headers: { cookie: customerCookie }
    });
    assert.equal(bookRes.res.status, 201);

    const rateRes = await requestJson(baseUrl, `/api/rides/${rideId}/rate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: customerCookie
      },
      body: JSON.stringify({ score: 5, comment: 'Great ride' })
    });
    assert.equal(rateRes.res.status, 201);
    assert.equal(rateRes.body.rating.score, 5);

    const ratingsRes = await requestJson(baseUrl, `/api/rides/${rideId}/ratings`);
    assert.equal(ratingsRes.res.status, 200);
    assert.equal(ratingsRes.body.ratings.length, 1);
    assert.equal(ratingsRes.body.averageScore, 5);
  } finally {
    server.close();
  }
});

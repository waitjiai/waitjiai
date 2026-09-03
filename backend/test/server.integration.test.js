// Boots the real server.js as a child process (local-disk storage, no
// Postgres needed) and hits it over real HTTP. This exists specifically to
// catch the bug class that unit tests on lib/*.js can't: routes reading
// query-string params from the wrong variable.
//
// server.js does `const url = req.url.split('?')[0]` once, at the top of the
// request handler, and matches routes against that PATH-ONLY value. Four
// routes used to then build `new URL('http://x'+url)` to read a query param
// out of that already-stripped value — so `?type=stream`, `?country=US`,
// `?status=pending` etc. were silently always empty. In production this
// meant GET /v1/ads/active?type=stream always fell back to the 'spotlight'
// default: Stream-placement ads never actually served as Stream. Nothing
// caught this because no test exercised a real HTTP request with a query
// string. These tests do exactly that, against the exact routes that broke.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const PORT = 41730 + (process.pid % 1000); // avoid colliding with a real dev server
const BASE = `http://127.0.0.1:${PORT}`;
const DB_FILE = path.join(require('node:os').tmpdir(), `waitji-test-db-${process.pid}.json`);

let child;

function get(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(BASE + urlPath, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(body) }); }
        catch (e) { reject(new Error(`Non-JSON response from ${urlPath}: ${body.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

function waitForServer(retriesLeft) {
  return get('/health').catch(err => {
    if (retriesLeft <= 0) throw err;
    return new Promise(r => setTimeout(r, 200)).then(() => waitForServer(retriesLeft - 1));
  });
}

before(async () => {
  fs.rmSync(DB_FILE, { force: true });
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_FILE,
      DATABASE_URL: '', // force local-disk storage, no Postgres needed for this test
      JWT_SECRET: 'integration-test-jwt-secret',
      ENCRYPT_KEY: 'integration-test-encrypt-key',
      ADMIN_PASSWORD: 'IntegrationTestAdminPass123',
    },
    stdio: 'ignore',
  });
  await waitForServer(25); // up to ~5s for boot
});

after(() => {
  if (child) child.kill();
  fs.rmSync(DB_FILE, { force: true });
});

test('GET /health responds ok', async () => {
  const { status, json } = await get('/health');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
});

test('GET /v1/public/pricing?country=US returns USD pricing, not the IN default', async () => {
  const { json } = await get('/v1/public/pricing?country=US');
  assert.equal(json.currency, 'USD');
  assert.equal(json.symbol, '$');
  assert.equal(json.spotlight.minDisplay, '12');
});

test('GET /v1/public/pricing?country=JP returns JPY pricing', async () => {
  const { json } = await get('/v1/public/pricing?country=JP');
  assert.equal(json.currency, 'JPY');
  assert.equal(json.spotlight.minDisplay, '1800');
});

test('GET /v1/public/pricing with no country param defaults to India', async () => {
  const { json } = await get('/v1/public/pricing');
  assert.equal(json.currency, 'INR');
  assert.equal(json.spotlight.minDisplay, '800');
});

test('GET /v1/ads/active?type=stream actually returns a stream ad, not the spotlight default', async () => {
  const { json } = await get('/v1/ads/active?type=stream');
  assert.ok(Array.isArray(json.ads) && json.ads.length > 0, 'expected at least the seeded house ad');
  for (const ad of json.ads) {
    assert.equal(ad.adType, 'stream', `expected a stream ad, got adType=${ad.adType}`);
  }
});

test('GET /v1/ads/active?type=spotlight returns a spotlight ad', async () => {
  const { json } = await get('/v1/ads/active?type=spotlight');
  assert.ok(Array.isArray(json.ads) && json.ads.length > 0);
  for (const ad of json.ads) {
    assert.equal(ad.adType, 'spotlight');
  }
});

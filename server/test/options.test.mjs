import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.PORT = '0';
const { server, store } = await import('../dist/index.js');

await new Promise((resolve) => server.listening ? resolve() : server.once('listening', resolve));
const port = server.address().port;

function rawRequest({ method = 'GET', path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const preflightHeaders = {
  Origin: 'https://app.example.com',
  'Access-Control-Request-Method': 'POST'
};

test.after(() => {
  server.close();
});

test('OPTIONS /mock with a configured Mock replays its full response even for preflight-looking requests', async () => {
  const route = store.create({
    name: '能力发现',
    method: 'OPTIONS',
    path: '/capabilities',
    statusCode: 200,
    responseHeaders: { 'content-type': 'application/json; charset=utf-8' },
    responseBody: JSON.stringify({ methods: ['GET', 'POST'] }),
    description: '用户配置的 OPTIONS Mock'
  });

  try {
    const res = await rawRequest({
      method: 'OPTIONS',
      path: '/mock/capabilities',
      headers: preflightHeaders
    });

    assert.equal(res.status, 200, '必须返回 Mock 配置的状态码，而不是通用 204');
    assert.deepEqual(JSON.parse(res.body), { methods: ['GET', 'POST'] }, '必须返回 Mock 配置的 body');
    assert.match(res.headers['content-type'] || '', /application\/json/, '必须保留 Mock 配置的响应头');
  } finally {
    store.delete(route.id);
  }
});

test('OPTIONS /mock without a matching Mock stays a real CORS preflight (204 + CORS headers)', async () => {
  const res = await rawRequest({
    method: 'OPTIONS',
    path: '/mock/orders',
    headers: preflightHeaders
  });

  assert.equal(res.status, 204);
  assert.equal(res.body, '');
  assert.ok(res.headers['access-control-allow-methods']?.includes('POST'));
  assert.equal(res.headers['access-control-allow-origin'], '*');
});

test('OPTIONS /mock without preflight headers and without a Mock returns 404', async () => {
  const res = await rawRequest({ method: 'OPTIONS', path: '/mock/orders' });
  assert.equal(res.status, 404);
});

test('plain OPTIONS /mock (no Origin/ACRM) still replays a configured Mock', async () => {
  const route = store.create({
    name: '纯 OPTIONS Mock',
    method: 'OPTIONS',
    path: '/capabilities',
    statusCode: 200,
    responseHeaders: { 'content-type': 'text/plain' },
    responseBody: 'capabilities-body'
  });

  try {
    const res = await rawRequest({ method: 'OPTIONS', path: '/mock/capabilities' });
    assert.equal(res.status, 200);
    assert.equal(res.body, 'capabilities-body');
    assert.match(res.headers['content-type'] || '', /text\/plain/);
  } finally {
    store.delete(route.id);
  }
});

test('preflight behavior for /api paths is unchanged', async () => {
  const res = await rawRequest({
    method: 'OPTIONS',
    path: '/api/mocks',
    headers: preflightHeaders
  });
  assert.equal(res.status, 204);
  assert.ok(res.headers['access-control-allow-methods']);
});

test('other HTTP methods on /mock are unaffected by the change', async () => {
  const get = await rawRequest({ method: 'GET', path: '/mock/health' });
  assert.equal(get.status, 200);
  assert.deepEqual(JSON.parse(get.body), { ok: true, service: 'api-mock' });

  const missing = await rawRequest({
    method: 'POST',
    path: '/mock/capabilities',
    headers: preflightHeaders
  });
  assert.equal(missing.status, 404);
});

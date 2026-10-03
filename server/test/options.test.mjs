import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// 让服务端监听随机端口，避免与开发环境冲突；必须在 import 前设置。
process.env.PORT = '0';
const { server } = await import('../dist/index.js');
if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
const port = server.address().port;

test.after(() => {
  server.close();
});

function request(method, path, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const preflightHeaders = {
  Origin: 'https://example.com',
  'Access-Control-Request-Method': 'POST'
};

test('OPTIONS Mock 命中时返回用户配置的完整响应（即使带预检头）', async () => {
  const created = await request(
    'POST',
    '/api/mocks',
    { 'content-type': 'application/json' },
    JSON.stringify({
      name: 'capabilities OPTIONS',
      method: 'OPTIONS',
      path: '/capabilities',
      statusCode: 200,
      responseHeaders: {
        'content-type': 'application/json',
        'access-control-allow-origin': 'https://example.com',
        'x-custom-mock': 'yes'
      },
      responseBody: '{"capabilities":["read","write"]}'
    })
  );
  assert.equal(created.status, 201);

  const res = await request('OPTIONS', '/mock/capabilities', preflightHeaders);
  assert.equal(res.status, 200, '不应返回通用 204，而应返回 Mock 配置的状态码');
  assert.equal(res.body, '{"capabilities":["read","write"]}', '应返回 Mock 配置的 body');
  assert.equal(res.headers['x-custom-mock'], 'yes', '应返回 Mock 配置的自定义响应头');
  assert.equal(
    res.headers['access-control-allow-origin'],
    'https://example.com',
    'Mock 配置的 CORS 头优先于通用 *'
  );
});

test('未配置 OPTIONS Mock 时，真实预检仍返回 204', async () => {
  const res = await request('OPTIONS', '/mock/no-such-options-route', preflightHeaders);
  assert.equal(res.status, 204);
  assert.equal(res.headers['access-control-allow-methods'], 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD');
  assert.equal(res.body, '');
});

test('未配置 Mock 且不是预检（缺少 Origin / ACRM）时返回 404', async () => {
  const res = await request('OPTIONS', '/mock/no-such-options-route');
  assert.equal(res.status, 404);
  const payload = JSON.parse(res.body);
  assert.match(payload.error, /OPTIONS/);
});

test('/api 管理接口的 CORS 预检行为保持不变（204）', async () => {
  const res = await request('OPTIONS', '/api/mocks', preflightHeaders);
  assert.equal(res.status, 204);
  assert.equal(res.headers['access-control-allow-methods'], 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD');
});

test('其他 HTTP 方法的 Mock 匹配不受影响', async () => {
  const res = await request('GET', '/mock/users/42', { Origin: 'https://example.com' });
  assert.equal(res.status, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.id, 'demo');
});

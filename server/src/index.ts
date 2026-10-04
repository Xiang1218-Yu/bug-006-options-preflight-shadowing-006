import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { findMatchingRoute } from './matcher.js';
import { HttpError, methodFromRequest, readJson, sendJson, sendText } from './http.js';
import { MockStore, normalizePath } from './store.js';
import type { HttpMethod, MockRoute, MockRouteInput, ReplayRequest } from './types.js';

const port = Number(process.env.PORT || 4000);
const store = new MockStore();
const allowedMethods = new Set<HttpMethod>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']);

const server = createServer(async (request, response) => {
  try {
    await handleRequest(request, response);
  } catch (error) {
    const statusCode = error instanceof HttpError ? error.statusCode : 500;
    const message = error instanceof Error ? error.message : '服务器内部错误';
    sendJson(response, statusCode, { error: message });
  }
});

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const method = methodFromRequest(request);

  // For /mock OPTIONS requests, a user-configured OPTIONS Mock takes precedence
  // over CORS preflight handling: only fall back to the generic 204 preflight
  // response (or 404 for non-preflight requests) when no Mock matches.
  let mockOptionsRoute: MockRoute | undefined;
  if (method === 'OPTIONS' && url.pathname.startsWith('/mock')) {
    const mockPath = url.pathname.slice('/mock'.length) || '/';
    mockOptionsRoute = findMatchingRoute(store.list(), 'OPTIONS', mockPath);
  }
  if (shouldTreatAsCorsPreflight(request, url, mockOptionsRoute)) {
    response.writeHead(204, corsHeaders());
    response.end();
    return;
  }
  applyCors(response);

  if (url.pathname === '/api/health' && request.method === 'GET') {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (url.pathname === '/api/mocks' && request.method === 'GET') {
    sendJson(response, 200, { data: store.list() });
    return;
  }

  if (url.pathname === '/api/mocks' && request.method === 'POST') {
    const input = validateRouteInput(await readJson<MockRouteInput>(request));
    sendJson(response, 201, { data: store.create(input) });
    return;
  }

  const mockIdMatch = url.pathname.match(/^\/api\/mocks\/([^/]+)$/);
  if (mockIdMatch && request.method === 'GET') {
    const route = store.get(decodeURIComponent(mockIdMatch[1]));
    if (!route) throw new HttpError(404, 'Mock 路由不存在');
    sendJson(response, 200, { data: route });
    return;
  }
  if (mockIdMatch && request.method === 'PUT') {
    const input = validateRouteInput(await readJson<MockRouteInput>(request));
    const route = store.update(decodeURIComponent(mockIdMatch[1]), input);
    if (!route) throw new HttpError(404, 'Mock 路由不存在');
    sendJson(response, 200, { data: route });
    return;
  }
  if (mockIdMatch && request.method === 'DELETE') {
    const deleted = store.delete(decodeURIComponent(mockIdMatch[1]));
    if (!deleted) throw new HttpError(404, 'Mock 路由不存在');
    response.statusCode = 204;
    response.end();
    return;
  }

  if (url.pathname === '/api/recordings' && request.method === 'POST') {
    const input = await readJson<{
      name?: string;
      request: { method: HttpMethod; path: string };
      response: { statusCode: number; headers?: Record<string, string>; body?: string };
    }>(request);
    if (!input.request?.method || !input.request?.path || !input.response?.statusCode) {
      throw new HttpError(400, '录制请求需要 request.method、request.path 和 response.statusCode');
    }
    sendJson(response, 201, { data: store.record(input) });
    return;
  }

  if (url.pathname === '/api/replay' && request.method === 'POST') {
    const replayRequest = await readJson<ReplayRequest>(request);
    const method = normalizeMethod(replayRequest.method);
    const route = findMatchingRoute(store.list(), method, replayRequest.path || '/');
    if (!route) {
      sendJson(response, 404, {
        matched: false,
        request: replayRequest,
        response: { statusCode: 404, headers: {}, body: '没有找到匹配的 Mock 路由' }
      });
      return;
    }
    sendJson(response, 200, {
      matched: true,
      route,
      request: replayRequest,
      response: buildMockResponse(route)
    });
    return;
  }

  if (url.pathname === '/api/mocks' || url.pathname.startsWith('/api/')) {
    throw new HttpError(404, 'API 路径不存在');
  }

  if (url.pathname.startsWith('/mock')) {
    const mockPath = url.pathname.slice('/mock'.length) || '/';
    const route = method === 'OPTIONS'
      ? mockOptionsRoute
      : findMatchingRoute(store.list(), normalizeMethod(method), mockPath);
    if (!route) {
      sendJson(response, 404, { error: `没有找到 ${method} ${mockPath} 的 Mock 路由` });
      return;
    }
    const mockResponse = buildMockResponse(route);
    sendText(response, mockResponse.statusCode, mockResponse.body, mockResponse.headers);
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
}

function normalizeMethod(method: string): HttpMethod {
  const normalized = (method || 'GET').toUpperCase() as HttpMethod;
  if (!allowedMethods.has(normalized)) throw new HttpError(400, `不支持的 HTTP 方法: ${method}`);
  return normalized;
}

function validateRouteInput(input: MockRouteInput): MockRouteInput {
  if (!input || !input.name?.trim()) throw new HttpError(400, 'name 不能为空');
  const method = normalizeMethod(input.method);
  const path = normalizePath(input.path);
  if (!path.startsWith('/')) throw new HttpError(400, 'path 必须以 / 开头');
  const statusCode = Number(input.statusCode);
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
    throw new HttpError(400, 'statusCode 必须是 100-599 的整数');
  }
  return {
    ...input,
    name: input.name.trim(),
    method,
    path,
    statusCode,
    responseHeaders: input.responseHeaders || {},
    responseBody: input.responseBody || '',
    description: input.description || ''
  };
}

function buildMockResponse(route: { statusCode: number; responseHeaders: Record<string, string>; responseBody: string }) {
  return {
    statusCode: route.statusCode,
    headers: route.responseHeaders,
    body: route.responseBody
  };
}

function shouldTreatAsCorsPreflight(
  request: IncomingMessage,
  url: URL,
  mockOptionsRoute?: MockRoute
): boolean {
  const method = (request.method || '').toUpperCase();
  const origin = request.headers.origin;
  const requestedMethod = request.headers['access-control-request-method'];
  if (method !== 'OPTIONS') return false;
  if (!origin || !requestedMethod) return false;
  // A configured OPTIONS Mock on /mock wins over preflight handling, so its
  // full user-defined response is replayed instead of the generic 204.
  if (url.pathname.startsWith('/mock') && mockOptionsRoute) return false;
  return url.pathname.startsWith('/api/') || url.pathname.startsWith('/mock');
}

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD',
    'access-control-allow-headers': 'content-type, x-requested-with'
  };
}

function applyCors(response: ServerResponse): void {
  for (const [key, value] of Object.entries(corsHeaders())) response.setHeader(key, value);
}

server.listen(port, () => {
  console.log(`API Mock server listening on http://localhost:${port}`);
});

export { server, store, handleRequest };

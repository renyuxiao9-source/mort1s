import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileConfig, HttpError, openStore, providers } from './config.mjs';
import { createRouter } from './router.mjs';

const publicAssets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.mjs', ['app.mjs', 'text/javascript']],
  ['/sse.mjs', ['sse.mjs', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']],
]);

function authorized(req, key) {
  const supplied = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${key}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function authenticate(req, key) {
  if (!authorized(req, key)) throw new HttpError(401, '请提供有效的 Bearer Key。', 'invalid_api_key');
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function readJson(req, maxBytes) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'Content-Type 须为 application/json。', 'unsupported_media_type');
  }
  if (Number(req.headers['content-length']) > maxBytes) {
    throw new HttpError(413, '请求体过大。', 'request_too_large');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, '请求体过大。', 'request_too_large');
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new HttpError(400, '请求体须为有效的 JSON 对象。', 'invalid_json');
  }
}

export function createGateway(dir) {
  const store = openStore(dir);
  const router = createRouter(store);
  const assets = new Map([...publicAssets].map(([path, [name, type]]) =>
    [path, { type, body: readFileSync(new URL(`./public/${name}`, import.meta.url)) }]));
  let config = compileConfig(store.state);
  let active = 0;

  const server = createServer({
    requestTimeout: 30_000,
    headersTimeout: 15_000,
    connectionsCheckingInterval: 5000,
  }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (!/^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/i.test(req.headers.host ?? '')) {
        throw new HttpError(403, '请通过 127.0.0.1 或 localhost 访问。', 'invalid_host');
      }
      const path = req.url.split('?')[0];
      if (req.method === 'GET' && assets.has(path)) {
        const { type, body } = assets.get(path);
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        res.end(body);
        return;
      }
      if (req.method === 'GET' && path === '/healthz') {
        json(res, 200, { status: 'ok' });
        return;
      }
      if (path === '/admin/state' && ['GET', 'PUT'].includes(req.method)) {
        authenticate(req, store.state.adminKey);
        if (req.method === 'PUT') {
          const input = await readJson(req, 512 * 1024);
          store.saveConfig(input);
          config = compileConfig(store.state);
          router.resetHealth();
        }
        const { gatewayKey, channels, routes, revision } = store.state;
        json(res, 200, {
          gatewayKey, revision, routes, providers,
          channels: channels.map(({ key, ...channel }) => ({ ...channel, hasKey: Boolean(key) })),
          status: router.status(config),
        });
        return;
      }
      if (req.method === 'GET' && path === '/v1/models') {
        authenticate(req, store.state.gatewayKey);
        json(res, 200, {
          object: 'list',
          data: [...config.routes.keys()].map((id) => ({ id, object: 'model', created: 0, owned_by: 'termux-api-hub' })),
        });
        return;
      }
      if (req.method === 'POST' && path === '/v1/chat/completions') {
        authenticate(req, store.state.gatewayKey);
        if (active >= 16) throw new HttpError(503, '网关当前繁忙，请稍后重试。', 'gateway_busy', 2);
        const client = new AbortController();
        res.once('close', () => client.abort());
        active += 1;
        try {
          const request = await readJson(req, 4 * 1024 * 1024);
          if (typeof request.model !== 'string' || !Array.isArray(request.messages) || !request.messages.length) {
            throw new HttpError(400, '请提供模型别名和非空的 messages 数组。', 'invalid_request');
          }
          if (request.stream !== undefined && typeof request.stream !== 'boolean') {
            throw new HttpError(400, 'stream 须为布尔值。', 'invalid_request');
          }
          await router.run(config, request, res, client.signal);
        } finally {
          active -= 1;
        }
        return;
      }
      throw new HttpError(404, '接口不存在。', 'not_found');
    } catch (error) {
      if (res.destroyed) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (!req.complete) {
        res.setHeader('Connection', 'close');
        req.resume();
      }
      const known = error instanceof HttpError;
      if (!known) console.error('网关内部错误：', error.code ?? error.name);
      if (error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
      if (error.status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
      json(res, known ? error.status : 500, {
        error: {
          message: known ? error.message : '网关内部错误。请检查 Termux 终端。',
          type: known ? error.code : 'internal_error',
          code: known ? error.code : 'internal_error',
        },
      });
    }
  });
  server.maxConnections = 64;
  return { server, store };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.HUB_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('HUB_PORT 须在 1024–65535 之间。');
  const dir = process.env.HUB_DATA_DIR ? resolve(process.env.HUB_DATA_DIR) : fileURLToPath(new URL('./data/', import.meta.url));
  const { server, store } = createGateway(dir);
  server.listen(port, '127.0.0.1', () => {
    console.log(`管理页面  http://127.0.0.1:${port}/`);
    console.log(`API 入口  http://127.0.0.1:${port}/v1`);
    console.log(`数据文件  ${store.file}`);
    if (store.created) console.log(`首次启动的管理 Key  ${store.state.adminKey}`);
  });
}

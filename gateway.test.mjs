import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createGateway } from './server.mjs';
import { createUpdateChecker } from './updates.mjs';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

function stop(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

const complete = (res, model) => res.end(JSON.stringify({
  id: 'chatcmpl-test',
  model,
  choices: [{ index: 0, message: { role: 'assistant', content: '正常回答' }, finish_reason: 'stop' }],
}));

async function fixture(t, handle, options) {
  const calls = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    calls.push({ model: data.model, key: req.headers.authorization, path: req.url });
    await handle(req, res, data);
  });
  const base = await listen(upstream);
  const dataDir = await mkdtemp(join(tmpdir(), 'api-hub-test-'));
  let gateway;
  let url;
  const start = async () => {
    gateway = createGateway(dataDir, options);
    url = await listen(gateway.server);
  };
  await start();
  t.after(async () => {
    await Promise.all([stop(gateway.server), stop(upstream)]);
    const { unlink, rmdir } = await import('node:fs/promises');
    await unlink(gateway.store.file);
    await rmdir(dataDir);
  });
  const send = (path, key, method = 'GET', body) => fetch(url + path, {
    method,
    headers: {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body && JSON.stringify(body),
  });
  return {
    base, calls, send,
    get keys() { return gateway.store.state; },
    async restart() { await stop(gateway.server); await start(); },
    channel(id, group = '') {
      return { id, name: id, provider: 'custom', baseUrl: base + '/v1', key: `key-${id}`, group, enabled: true };
    },
    async config(channels, routes) {
      const { adminKey, revision } = gateway.store.state;
      const response = await send('/admin/state', adminKey, 'PUT', { revision, channels, routes });
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      return body;
    },
    chat(model = 'auto', stream = false) {
      return send('/v1/chat/completions', gateway.store.state.gatewayKey, 'POST', {
        model, stream, messages: [{ role: 'user', content: '你好' }],
      });
    },
  };
}

const candidate = (channel, model, { rpm = 0, rpd = 0 } = {}) => ({ channel, model, rpm, rpd });
const route = (...targets) => [{ id: 'auto', targets }];

test('update checks require the admin key and report the running and remote revisions', async (t) => {
  const installed = 'a'.repeat(40);
  const nativeFetch = globalThis.fetch;
  let latest = 'b'.repeat(40);
  let checks = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url !== 'https://api.github.com/repos/renyuxiao9-source/mort1s/git/ref/heads/main') {
      return nativeFetch(url, options);
    }
    assert.equal(new Headers(options.headers).has('Authorization'), false);
    checks += 1;
    return latest ? Response.json({ object: { sha: latest } }) : new Response(null, { status: 503 });
  });
  const f = await fixture(t, () => {}, { checkUpdates: createUpdateChecker(installed) });
  assert.equal((await f.send('/admin/updates', f.keys.gatewayKey)).status, 401);
  assert.equal(checks, 0);

  const check = async () => {
    const response = await f.send('/admin/updates', f.keys.adminKey);
    assert.equal(response.status, 200);
    return response.json();
  };
  const different = await check();
  assert.equal(different.status, 'different');
  assert.equal(different.local, installed);
  assert.equal(different.latest, latest);
  latest = installed;
  assert.equal((await check()).status, 'current');
  latest = null;
  assert.equal((await check()).status, 'unavailable');
  assert.equal(checks, 3);
});

test('separates API and admin credentials, redacts upstream keys and rejects stale changes', async (t) => {
  const f = await fixture(t, (_, res, data) => complete(res, data.model));
  const { gatewayKey, adminKey } = f.keys;
  assert.equal((await f.send('/v1/models')).status, 401);
  assert.equal((await f.send('/v1/models', adminKey)).status, 401);
  assert.equal((await f.send('/admin/state', gatewayKey)).status, 401);
  assert.equal((await f.send('/', '')).status, 200);
  const body = await f.config([f.channel('primary')], route(candidate('primary', 'model-a')));
  assert.equal(body.channels[0].key, undefined);
  assert.equal(body.channels[0].hasKey, true);
  const stale = await f.send('/admin/state', adminKey, 'PUT', { revision: 0, channels: [], routes: [] });
  assert.equal(stale.status, 409);
  const data = await (await f.send('/v1/models', gatewayKey)).json();
  assert.deepEqual(data.data.map((model) => model.id), ['auto']);
  const response = await f.chat();
  assert.equal(response.headers.get('X-Gateway-Model'), 'model-a');
  assert.equal((await response.json()).choices[0].message.content, '正常回答');
  assert.deepEqual(f.calls, [{ model: 'model-a', key: 'Bearer key-primary', path: '/v1/chat/completions' }]);
});

test('on 429 skips other keys in the quota group, then routes across projects and models', async (t) => {
  const f = await fixture(t, (req, res, data) => {
    if (data.model === 'primary') {
      res.writeHead(429, { 'Retry-After': '120', 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"secret upstream error"}}');
    } else {
      complete(res, data.model);
    }
  });
  const targets = route(candidate('one', 'primary'), candidate('same-project', 'primary'),
    candidate('another', 'primary'), candidate('one', 'lighter'));
  const channels = [f.channel('one', 'project-a'), f.channel('same-project', 'project-a'), f.channel('another', 'project-b')];
  await f.config(channels, targets);
  const response = await f.chat();
  assert.equal(response.headers.get('X-Gateway-Model'), 'lighter');
  assert.deepEqual(f.calls.map(({ key, model }) => [key, model]), [
    ['Bearer key-one', 'primary'], ['Bearer key-another', 'primary'], ['Bearer key-one', 'lighter'],
  ]);
  await f.restart();
  const status = await (await f.send('/admin/state', f.keys.adminKey)).json();
  assert.equal(status.status[0].targets[1].reason, 'rate_limit');
  assert.ok(status.status[0].targets[1].until > Date.now() + 100_000);
  await f.config(status.channels, route(...targets[0].targets.slice(0, 3)));
  const exhausted = await f.chat();
  assert.equal(exhausted.status, 429);
  assert.ok(Number(exhausted.headers.get('Retry-After')) > 100);
  assert.doesNotMatch(await exhausted.text(), /secret upstream error/);
  assert.equal(f.calls.length, 3);
});

test('reserves a shared daily slot before awaiting upstream and retains it after restart', async (t) => {
  const f = await fixture(t, async (_, res, data) => {
    await delay(30);
    complete(res, data.model);
  });
  const fallback = candidate('primary', 'lighter');
  await f.config([f.channel('primary')], [
    { id: 'auto', targets: [candidate('primary', 'main', { rpd: 1 }), fallback] },
    { id: 'other', targets: [candidate('primary', 'main'), fallback] },
  ]);
  const results = await Promise.all([f.chat(), f.chat('other')]);
  assert.deepEqual(results.map((res) => res.headers.get('X-Gateway-Model')).sort(), ['lighter', 'main']);
  await f.restart();
  const response = await f.chat();
  assert.equal(response.headers.get('X-Gateway-Model'), 'lighter');
  assert.equal(f.calls.filter(({ model }) => model === 'main').length, 1);
});

test('rotates same-tier accounts and degrades only after the entire tier is unavailable', async (t) => {
  const tried = new Set();
  const f = await fixture(t, (req, res, data) => {
    const key = req.headers.authorization;
    if (data.model === 'main' && tried.has(key)) {
      res.writeHead(429, { 'Retry-After': '60' });
      res.end();
      return;
    }
    tried.add(key);
    complete(res, data.model);
  });
  const saved = await f.config([f.channel('account-a'), f.channel('account-b'), f.channel('fallback')], route(
    candidate('account-a', 'main'),
    { ...candidate('account-b', 'main'), joinPrevious: true },
    candidate('fallback', 'lighter'),
  ));
  assert.equal(saved.routes[0].targets[1].joinPrevious, true);
  for (const account of ['account-a', 'account-b', 'fallback']) {
    const response = await f.chat();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('X-Gateway-Channel'), account);
    await response.json();
  }
  assert.deepEqual(f.calls.map(({ key }) => key), [
    'Bearer key-account-a', 'Bearer key-account-b', 'Bearer key-account-a', 'Bearer key-account-b', 'Bearer key-fallback',
  ]);
  const status = await (await f.send('/admin/state', f.keys.adminKey)).json();
  assert.deepEqual(status.status[0].targets.map(({ reason }) => reason), ['rate_limit', 'rate_limit', 'ready']);
});

test('enforces rolling RPM without calling upstream again', async (t) => {
  const f = await fixture(t, (_, res, data) => complete(res, data.model));
  await f.config([f.channel('primary')], route(candidate('primary', 'main', { rpm: 1 })));
  assert.equal((await f.chat()).status, 200);
  const limited = await f.chat();
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('Retry-After')) >= 59);
  assert.equal(f.calls.length, 1);
});

test('SSE switches before content on an embedded rate error and keeps the selected stream after content', async (t) => {
  const f = await fixture(t, async (_, res, data) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"role":"assistant"}}]}\r\n\r\n');
    if (data.model === 'first') {
      res.end('data: {"error":{"code":429}}\r\n\r\n');
      return;
    }
    const bytes = Buffer.from('data: {"choices":[{"delta":{"content":"回退成功"}}]}\r\n\r\n');
    const split = bytes.indexOf(Buffer.from('回')) + 1;
    res.write(bytes.subarray(0, split));
    await delay(20);
    res.write(bytes.subarray(split));
    await delay(20);
    res.end('data: {"error":{"code":503}}\r\n\r\n');
  });
  await f.config([f.channel('upstream')], route(candidate('upstream', 'first'), candidate('upstream', 'second'),
    candidate('upstream', 'never')));
  const response = await f.chat('auto', true);
  assert.equal(response.headers.get('X-Gateway-Model'), 'second');
  const stream = await response.text();
  assert.match(stream, /回退成功/);
  assert.match(stream, /"code":503/);
  assert.doesNotMatch(stream, /"code":429/);
  assert.deepEqual(f.calls.map(({ model }) => model), ['first', 'second']);
});

test('does not fall through on a rejected request', async (t) => {
  const f = await fixture(t, (_, res) => {
    res.writeHead(400);
    res.end('{"error":{"message":"do not leak"}}');
  });
  await f.config([f.channel('upstream')], route(candidate('upstream', 'first'), candidate('upstream', 'never')));
  const response = await f.chat();
  assert.equal(response.status, 400);
  assert.doesNotMatch(await response.text(), /do not leak/);
  assert.equal(f.calls.length, 1);
});

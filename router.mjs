import { once } from 'node:events';
import { HttpError } from './config.mjs';
import { sseParser } from './public/sse.mjs';

const minute = 60_000;
const pacificDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Los_Angeles' });
const utcDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'UTC' });
const quotaDate = (channel) => channel.provider === 'gemini' ? pacificDate : utcDate;
const secondsLeft = (until) => Math.max(1, Math.ceil((until - Date.now()) / 1000));

function nextDay(calendar, now) {
  const day = calendar.format(now);
  let lower = Math.floor(now / 1000);
  let upper = lower + 26 * 3600;
  while (upper - lower > 1) {
    const middle = Math.floor((lower + upper) / 2);
    if (calendar.format(middle * 1000) === day) lower = middle;
    else upper = middle;
  }
  return upper * 1000;
}

const parseJson = (text) => {
  try { return JSON.parse(text); } catch { return undefined; }
};

async function boundedJson(response, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > maxBytes) return undefined;
    chunks.push(chunk);
  }
  return parseJson(Buffer.concat(chunks, size).toString('utf8'));
}

function retryTime(value, now) {
  if (!value) return 0;
  if (/^\d+(\.\d+)?s?$/.test(value)) return now + parseFloat(value) * 1000;
  return Date.parse(value) || 0;
}

class UpstreamFailure extends Error {
  constructor(status, body, headers) {
    super('Upstream request failed');
    this.status = status;
    this.info = (Array.isArray(body) ? body[0] : body)?.error;
    this.headers = headers;
  }
}

function embeddedFailure(body, headers) {
  const error = (Array.isArray(body) ? body[0] : body)?.error;
  if (!error) return;
  const code = [error.status, error.type, error.code].find((item) =>
    ['RESOURCE_EXHAUSTED', 'rate_limit_error', 'rate_limit_exceeded', 'quota_exceeded', 'insufficient_quota'].includes(item));
  const status = Number(error.code);
  if (code) throw new UpstreamFailure(429, body, headers);
  throw new UpstreamFailure(status >= 400 && status <= 599 ? status : 502, body, headers);
}

function cooldown(error, channel, now) {
  const { status, info, headers } = error;
  const details = Array.isArray(info?.details) ? info.details : [];
  const googleDelay = details.find((detail) => typeof detail?.retryDelay === 'string')?.retryDelay;
  const retry = Math.max(retryTime(headers?.get('retry-after'), now), retryTime(googleDelay, now));
  const daily = channel.provider === 'gemini' && details.some((detail) =>
    Array.isArray(detail?.violations) && detail.violations.some((entry) =>
      /per[_ -]?day|daily/i.test(`${entry?.quotaId ?? ''} ${entry?.quotaMetric ?? ''}`)));
  if (status === 429) {
    const suggested = daily ? nextDay(pacificDate, now) : now + minute;
    const until = Math.min(now + 7 * 86400000, Math.max(daily ? suggested : now + 1000, retry || suggested));
    return { reason: 'rate_limit', until };
  }
  if (status === 402) return { reason: 'billing', until: now + 15 * minute };
  if ([401, 403, 404].includes(status)) return { reason: 'upstream_config', until: now + minute };
  return { reason: 'upstream_error', until: Math.min(now + minute, Math.max(now + 5000, retry)) };
}

function usefulChunk(data) {
  return Array.isArray(data?.choices) && data.choices.some((choice) =>
    choice?.finish_reason != null ||
    (choice?.delta && Object.entries(choice.delta).some(([name, value]) => name !== 'role' && value != null && value !== '')));
}

async function pipeSse(response, res, signal, armIdle, clearIdle, markRoute) {
  const reader = response.body?.getReader();
  if (!reader) throw new UpstreamFailure(502);
  const parser = sseParser();
  const pending = [];
  let size = 0;
  let started = false;
  try {
    for (;;) {
      if (started) armIdle();
      const { value, done } = await reader.read();
      if (started) clearIdle();
      if (done) break;
      if (started) {
        if (!res.write(value)) await once(res, 'drain', { signal });
        continue;
      }
      size += value.byteLength;
      pending.push(value);
      for (const frame of parser.push(value)) {
        if (frame === '[DONE]') throw new UpstreamFailure(502);
        const data = parseJson(frame);
        embeddedFailure(data, response.headers);
        if (usefulChunk(data)) {
          started = true;
          break;
        }
      }
      if (!started) {
        if (size > 256 * 1024) throw new UpstreamFailure(502);
        continue;
      }
      clearIdle();
      markRoute();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'X-Accel-Buffering': 'no',
      });
      for (const part of pending) {
        if (!res.write(part)) await once(res, 'drain', { signal });
      }
      pending.length = 0;
    }
    if (!started) throw new UpstreamFailure(502);
    res.end();
  } finally {
    void reader.cancel().catch(() => {});
  }
}

async function forward(target, request, res, clientSignal, firstTimeout) {
  const { channel, model } = target;
  const upstream = new AbortController();
  const signal = AbortSignal.any([upstream.signal, clientSignal]);
  let timer = setTimeout(() => upstream.abort(), firstTimeout);
  const clearIdle = () => clearTimeout(timer);
  const armIdle = () => { timer = setTimeout(() => upstream.abort(), 60_000); };
  const markRoute = () => {
    res.setHeader('X-Gateway-Channel', channel.id);
    res.setHeader('X-Gateway-Model', model);
  };
  try {
    const headers = {
      'Content-Type': 'application/json',
      Accept: request.stream ? 'text/event-stream' : 'application/json',
    };
    if (channel.key) headers.Authorization = `Bearer ${channel.key}`;
    if (channel.workspace) headers['anthropic-workspace-id'] = channel.workspace;
    if (channel.provider === 'gemini') headers['x-goog-api-client'] = 'termux-api-hub-oai/1.0.0';
    const response = await fetch(`${channel.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...request, model }),
      signal,
      redirect: 'error',
    });
    if (!response.ok) {
      const payload = await boundedJson(response, 64 * 1024).catch(() => undefined);
      throw new UpstreamFailure(response.status, payload, response.headers);
    }
    if (request.stream && /^text\/event-stream\b/i.test(response.headers.get('content-type') ?? '')) {
      await pipeSse(response, res, signal, armIdle, clearIdle, markRoute);
      return;
    }
    const data = await boundedJson(response, 8 * 1024 * 1024);
    embeddedFailure(data, response.headers);
    if (request.stream || !Array.isArray(data?.choices) || !data.choices.length) throw new UpstreamFailure(502);
    markRoute();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  } finally {
    clearIdle();
    upstream.abort();
  }
}

export function createRouter(store) {
  const health = new Map();
  const targetId = (target) => `${target.channel.id}:${target.model}`;

  function availability(target, limits, now) {
    const { channel, bucket } = target;
    if (!channel.enabled) return { reason: 'disabled' };
    const { rpm, rpd } = limits.get(bucket);
    const entry = store.state.usage[bucket] ?? {};
    const calendar = quotaDate(channel);
    const day = calendar.format(now);
    const count = entry.day === day ? entry.count : 0;
    const recent = (entry.recent ?? []).filter((time) => time > now - minute);
    const stats = { count, rpm, rpd, minuteCount: recent.length };
    if (rpd && count >= rpd) return { ...stats, reason: 'rpd', until: nextDay(calendar, now) };
    if (entry.until > now) return { ...stats, reason: entry.reason, until: entry.until, upstreamStatus: entry.upstreamStatus };
    const issue = health.get(targetId(target));
    if (issue?.until > now) return { ...stats, ...issue };
    if (rpm && recent.length >= rpm) return { ...stats, reason: 'rpm', until: recent[recent.length - rpm] + minute };
    return { ...stats, day, recent, reason: 'ready' };
  }

  return {
    resetHealth() { health.clear(); },
    status(config) {
      const now = Date.now();
      return [...config.routes].map(([id, targets]) => ({
        id,
        targets: targets.map((target) => {
          const { day, recent, ...status } = availability(target, config.limits, now);
          return status;
        }),
      }));
    },
    async run(config, request, res, signal) {
      const targets = config.routes.get(request.model);
      if (!targets) throw new HttpError(404, '模型别名不存在，请查看 /v1/models。', 'model_not_found');
      const deadline = Date.now() + 90_000;
      const skipped = [];
      const failedBuckets = new Set();
      for (const target of targets) {
        if (signal.aborted) return;
        const now = Date.now();
        if (now >= deadline) break;
        if (!target.channel.enabled || failedBuckets.has(target.bucket)) continue;
        const state = availability(target, config.limits, now);
        if (state.reason !== 'ready') {
          skipped.push(state);
          continue;
        }
        const { bucket, channel } = target;
        store.saveUsage(bucket, {
          day: state.day,
          count: state.count + 1,
          recent: state.rpm ? [...state.recent, now] : [],
          updated: now,
        });
        try {
          await forward(target, request, res, signal, Math.min(45_000, deadline - now));
          return;
        } catch (error) {
          if (signal.aborted) return;
          if (res.headersSent) {
            res.destroy();
            return;
          }
          const failure = error instanceof UpstreamFailure ? error : new UpstreamFailure(502);
          const { status } = failure;
          if (status < 500 && ![401, 402, 403, 404, 408, 429].includes(status)) {
            throw new HttpError(status, `上游拒绝请求（HTTP ${status}），请检查参数与模型能力。`, 'upstream_rejected');
          }
          const issue = { ...cooldown(failure, channel, Date.now()), upstreamStatus: status };
          skipped.push(issue);
          if (status === 429) {
            const previous = store.state.usage[bucket];
            store.saveUsage(bucket, { ...previous, ...issue, until: Math.max(previous.until ?? 0, issue.until), updated: Date.now() });
            failedBuckets.add(bucket);
          } else {
            health.set(targetId(target), issue);
          }
        }
      }
      const retry = skipped.length ? secondsLeft(Math.min(...skipped.map((item) => item.until))) : undefined;
      const limited = skipped.length > 0 && skipped.every(({ reason }) => ['rpm', 'rpd', 'rate_limit'].includes(reason));
      throw new HttpError(limited ? 429 : 503, limited ? '所有可用候选的额度暂时用完。' : '当前没有可用的上游候选。', limited ? 'rate_limit_exceeded' : 'upstream_unavailable', retry);
    },
  };
}

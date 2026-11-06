import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const providers = {
  gemini: { label: 'Google AI Studio · Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  openai: { label: 'OpenAI', url: 'https://api.openai.com/v1' },
  deepseek: { label: 'DeepSeek', url: 'https://api.deepseek.com' },
  openrouter: { label: 'OpenRouter', url: 'https://openrouter.ai/api/v1' },
  anthropic: { label: 'Anthropic · 兼容接口', url: 'https://api.anthropic.com/v1' },
  custom: { label: '自定义 OpenAI 兼容渠道' },
};

export class HttpError extends Error {
  constructor(status, message, code, retryAfter) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

function requireConfig(condition, message) {
  if (!condition) throw new HttpError(400, message, 'invalid_config');
}

const slug = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const modelName = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@+~-]{0,159}$/;
const keyFormat = /^[!-~]{1,2048}$/;
const isSlug = (value) => typeof value === 'string' && slug.test(value);
const isModel = (value) => typeof value === 'string' && modelName.test(value);
const isArray = (value, min, max) => Array.isArray(value) && value.length >= min && value.length <= max;
const isLimit = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;

function compatibleUrl(value) {
  requireConfig(typeof value === 'string' && value.length <= 500, '请输入有效的 Base URL。');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, '请输入有效的 Base URL。', 'invalid_config');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  requireConfig(url.protocol === 'https:' || (url.protocol === 'http:' && local), '外部渠道须使用 HTTPS。本机渠道可使用 HTTP。');
  requireConfig(!url.username && !url.password && !/[?#]/.test(value), 'Base URL 不能包含凭据、查询参数或片段。');
  const baseUrl = url.href.replace(/\/+$/, '');
  requireConfig(!baseUrl.endsWith('/chat/completions'), 'Base URL 填接口前缀，末尾去掉 /chat/completions。');
  return { baseUrl, local };
}

export function validateConfig(input, previous) {
  requireConfig(isArray(input?.channels, 0, 32) && isArray(input?.routes, 0, 32), '最多保存 32 个渠道和 32 条路由。');
  const oldChannels = new Map(previous.channels.map((item) => [item.id, item]));
  const channelIds = new Set();
  const channels = input.channels.map((item) => {
    requireConfig(isSlug(item?.id) && !channelIds.has(item.id), '渠道 ID 无效或重复。');
    requireConfig(typeof item.provider === 'string' && Object.hasOwn(providers, item.provider), '未知渠道类型。');
    requireConfig(typeof item.name === 'string' && item.name.trim().length > 0 && item.name.length <= 64, '渠道名称长度须为 1–64 个字符。');
    requireConfig(item.group === '' || isSlug(item.group), '配额组只能使用字母、数字、点、连字符和下划线。');
    requireConfig(item.provider !== 'gemini' || item.group, 'Gemini 渠道须填写 Google Cloud 项目 ID，同项目请填写相同值。');
    requireConfig(typeof item.enabled === 'boolean', '渠道启用状态无效。');
    const preset = providers[item.provider].url;
    const { baseUrl, local } = compatibleUrl(preset ?? item.baseUrl);
    const old = oldChannels.get(item.id);
    const sameEndpoint = old?.provider === item.provider && old.baseUrl === baseUrl;
    const key = item.key || (sameEndpoint ? old.key : '');
    requireConfig(typeof key === 'string' && (key === '' ? local : keyFormat.test(key)), '请为该渠道填写有效的 API Key。');
    const workspace = item.provider === 'anthropic' ? (item.workspace ?? '') : '';
    requireConfig(workspace === '' || isSlug(workspace), 'Anthropic 工作区 ID 格式无效。');
    channelIds.add(item.id);
    return { id: item.id, name: item.name.trim(), provider: item.provider, baseUrl, key, group: item.group, workspace, enabled: item.enabled };
  });
  const routeIds = new Set();
  const routes = input.routes.map((item) => {
    requireConfig(isSlug(item?.id) && !routeIds.has(item.id), '模型别名无效或重复。');
    requireConfig(isArray(item.targets, 1, 12), '每条路由须有 1–12 个候选。');
    routeIds.add(item.id);
    const targets = item.targets.map((target) => {
      requireConfig(channelIds.has(target?.channel), '候选渠道不存在。请先移除路由中的引用。');
      requireConfig(isModel(target.model), '请填写上游模型 ID。');
      requireConfig(isLimit(target.rpm, 10000) && isLimit(target.rpd, 10000000), 'RPM 或 RPD 超出有效范围。');
      return { channel: target.channel, model: target.model, rpm: target.rpm, rpd: target.rpd };
    });
    requireConfig(new Set(targets.map(({ channel, model }) => `${channel}:${model}`)).size === targets.length, '同一条路由不能重复添加同一渠道和模型。');
    return { id: item.id, targets };
  });
  return { channels, routes };
}

export function quotaBucket(channel, model) {
  const identity = channel.group
    ? [channel.provider, channel.group]
    : [channel.baseUrl, channel.workspace, channel.key];
  return createHash('sha256').update(JSON.stringify([identity, model])).digest('hex');
}

const stricterLimit = (first, second) => first && second ? Math.min(first, second) : first || second;

export function compileConfig(config) {
  const channels = new Map(config.channels.map((channel) => [channel.id, channel]));
  const limits = new Map();
  const routes = new Map(config.routes.map((route) => {
    const targets = route.targets.map(({ channel: id, model, rpm, rpd }) => {
      const channel = channels.get(id);
      const bucket = quotaBucket(channel, model);
      if (channel.enabled) {
        const current = limits.get(bucket) ?? { rpm: 0, rpd: 0 };
        limits.set(bucket, { rpm: stricterLimit(current.rpm, rpm), rpd: stricterLimit(current.rpd, rpd) });
      }
      return { channel, model, bucket };
    });
    return [route.id, targets];
  }));
  return { routes, limits };
}

const secret = (prefix) => `${prefix}_${randomBytes(24).toString('base64url')}`;
const retention = 7 * 86400000;

export function openStore(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'state.json');
  const temp = join(dir, 'state.tmp');
  let state;
  let created = false;

  function save(next) {
    const now = Date.now();
    const usage = Object.fromEntries(Object.entries(next.usage).filter(([, entry]) =>
      (entry.updated ?? 0) > now - retention || (entry.until ?? 0) > now));
    writeFileSync(temp, JSON.stringify({ ...next, usage }), { mode: 0o600 });
    renameSync(temp, file);
    state = { ...next, usage };
  }

  try {
    state = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    save({ adminKey: secret('admin'), gatewayKey: secret('hub'), revision: 0, channels: [], routes: [], usage: {} });
    created = true;
  }

  return {
    file,
    created,
    get state() { return state; },
    saveConfig(input) {
      if (input?.revision !== state.revision) {
        throw new HttpError(409, '配置已在其他页面修改。请刷新后再保存。', 'stale_config');
      }
      save({ ...state, ...validateConfig(input, state), revision: state.revision + 1 });
    },
    saveUsage(bucket, entry) {
      save({ ...state, usage: { ...state.usage, [bucket]: entry } });
    },
  };
}

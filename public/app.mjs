import { sseParser } from './sse.mjs';

const $ = (selector) => document.querySelector(selector);
const fields = (form) => form.elements;
const loginForm = $('#login-form');
const channelForm = $('#channel-form');
const routeForm = $('#route-form');
const channelDialog = $('#channel-dialog');
const routeDialog = $('#route-dialog');
const targetList = $('#targets');
const labels = {
  ready: '可用', disabled: '已停用', rpd: '日额度已满', rpm: '分钟限流',
  rate_limit: '上游限流', billing: '余额异常', upstream_config: '凭据 / 模型异常', upstream_error: '上游异常',
};
let adminKey = '';
let state;
let editingChannel;
let editingRoute;
let testController;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, action, className) {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

function message(node, text = '') {
  node.textContent = text;
  node.hidden = !text;
}

const notice = (text) => message($('#notice'), text);

async function request(path, key, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error?.message ?? `请求失败（HTTP ${response.status}）。`);
  }
  return response;
}

async function load(key = adminKey, update) {
  const response = await request('/admin/state', key, update && {
    method: 'PUT', body: JSON.stringify({ revision: state.revision, ...update }),
  });
  const next = await response.json();
  if (key !== adminKey || (state && next.revision < state.revision)) return;
  state = next;
  render();
}

function showTab(id) {
  for (const tab of document.querySelectorAll('[data-tab]')) {
    const selected = tab.dataset.tab === id;
    tab.setAttribute('aria-pressed', String(selected));
    document.getElementById(tab.dataset.tab).hidden = !selected;
  }
  notice();
}

for (const tab of document.querySelectorAll('[data-tab]')) {
  tab.addEventListener('click', () => showTab(tab.dataset.tab));
}

function empty(title, help, actionText, action) {
  const card = element('div', 'card empty');
  card.append(element('h3', '', title), element('p', 'muted', help), button(actionText, action, 'primary'));
  return card;
}

function cardTitle(title, detail, controls) {
  const head = element('div', 'section-head');
  const group = element('div');
  group.append(element('h3', '', title));
  if (detail) group.append(element('p', 'muted', detail));
  const actions = element('div', 'actions');
  actions.append(...controls);
  head.append(group, actions);
  return head;
}

function render() {
  $('#api-base').value = `${location.origin}/v1`;
  $('#gateway-key').value = state.gatewayKey;
  const channels = new Map(state.channels.map((channel) => [channel.id, channel]));
  const channelCards = state.channels.map((channel) => {
    const card = element('article', 'card');
    card.append(
      cardTitle(channel.name, state.providers[channel.provider].label, [
        button('编辑', () => editChannel(channel)),
        button('删除', () => removeChannel(channel)),
      ]),
      element('p', 'muted', channel.baseUrl),
      element('p', 'muted', [channel.enabled ? '已启用' : '已停用', channel.group, channel.hasKey ? 'Key 已保存' : '本机免密'].filter(Boolean).join(' · ')),
    );
    return card;
  });
  if (!channelCards.length) channelCards.push(empty('还没有渠道', '添加 AI Studio 或其他兼容服务的凭据。', '添加渠道', () => editChannel()));
  $('#channel-list').replaceChildren(...channelCards);

  const routeCards = state.routes.map((route, index) => {
    const card = element('article', 'card');
    card.append(cardTitle(route.id, `${route.targets.length} 个候选`, [
      button('编辑', () => editRoute(route)),
      button('删除', () => removeRoute(route)),
    ]));
    const list = element('ol', 'route-list');
    route.targets.forEach((target, position) => {
      const channel = channels.get(target.channel);
      const status = state.status[index].targets[position];
      const row = element('li', 'route-item');
      const main = element('div');
      const title = element('p');
      title.append(element('code', '', target.model));
      const usage = [channel.name];
      if (status.reason !== 'disabled') {
        usage.push(`今日 ${status.count}${status.rpd ? '/' + status.rpd : ''}`);
        if (status.rpm) usage.push(`近 60 秒 ${status.minuteCount}/${status.rpm}`);
      }
      if (status.upstreamStatus) usage.push(`HTTP ${status.upstreamStatus}`);
      if (status.until) usage.push(`恢复 ${new Date(status.until).toLocaleString()}`);
      main.append(title, element('p', 'muted small', usage.join(' · ')));
      const statusClass = status.reason === 'ready' ? ' good' : status.reason === 'disabled' ? '' : ' warn';
      row.append(element('span', 'position', String(position + 1).padStart(2, '0')), main,
        element('span', `badge${statusClass}`, labels[status.reason]));
      list.append(row);
    });
    card.append(list);
    return card;
  });
  if (!routeCards.length) {
    routeCards.push(channels.size
      ? empty('还没有模型路由', '给客户端创建一个别名，例如 auto。', '创建路由', () => editRoute())
      : empty('先添加你的第一个渠道', '保存上游 Key 后，就可以安排模型的降级顺序。', '添加渠道', () => editChannel()));
  }
  $('#route-list').replaceChildren(...routeCards);
  $('#add-route').disabled = !channels.size;
  const select = $('#test-model');
  const selected = select.value;
  select.replaceChildren(...state.routes.map(({ id }) => new Option(id, id)));
  if (state.routes.some(({ id }) => id === selected)) select.value = selected;
  $('#test-send').disabled = !state.routes.length || Boolean(testController);
}

async function signIn(key) {
  const submit = loginForm.querySelector('[type="submit"]');
  submit.disabled = true;
  message($('#login-error'));
  adminKey = key;
  try {
    await load();
    sessionStorage.setItem('hub-admin', key);
    $('#admin-key').value = '';
    $('#login-panel').hidden = true;
    $('#dashboard').hidden = false;
    $('#logout').hidden = false;
    showTab('routes');
  } catch (error) {
    adminKey = '';
    sessionStorage.removeItem('hub-admin');
    message($('#login-error'), error.message);
  } finally {
    submit.disabled = false;
  }
}

loginForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void signIn($('#admin-key').value.trim());
});

$('#logout').addEventListener('click', () => {
  testController?.abort();
  testController = undefined;
  adminKey = '';
  state = undefined;
  sessionStorage.removeItem('hub-admin');
  $('#gateway-key').value = '';
  message($('#test-hit'));
  message($('#test-result'));
  $('#test-stop').hidden = true;
  $('#login-panel').hidden = false;
  $('#dashboard').hidden = true;
  $('#logout').hidden = true;
  $('#admin-key').focus();
});

async function copy(value) {
  try {
    await navigator.clipboard.writeText(value);
    notice('已复制。');
  } catch {
    window.prompt('请手动复制', value);
  }
}

$('#copy-base').addEventListener('click', () => copy($('#api-base').value));
$('#copy-key').addEventListener('click', () => copy(state.gatewayKey));
$('#refresh').addEventListener('click', async () => {
  try {
    await load();
    if (state) notice('已刷新额度和渠道状态。');
  } catch (error) {
    if (state) notice(error.message);
  }
});

function setupChannelFields() {
  const f = fields(channelForm);
  const provider = f.provider.value;
  const preset = state.providers[provider].url;
  f.baseUrl.value = preset ?? (editingChannel?.provider === provider ? editingChannel.baseUrl : '');
  f.baseUrl.readOnly = Boolean(preset);
  f.baseUrl.placeholder = 'https://example.com/v1';
  const gemini = provider === 'gemini';
  $('#group-label').textContent = gemini ? 'Google Cloud 项目 ID' : '配额组（可选）';
  $('#group-hint').textContent = gemini
    ? '同一项目的 Key 请填写同一项目 ID。'
    : '共享额度的凭据可填写同一个配额组。';
  f.group.required = gemini;
  $('#workspace-field').hidden = provider !== 'anthropic';
  f.key.placeholder = editingChannel?.provider === provider && editingChannel.hasKey ? '留空保留已保存的 Key' : '本机免密渠道可留空';
}

function editChannel(channel) {
  editingChannel = channel;
  const f = fields(channelForm);
  channelForm.reset();
  $('#channel-title').textContent = channel ? '编辑渠道' : '添加渠道';
  f.provider.replaceChildren(...Object.entries(state.providers).map(([id, item]) => new Option(item.label, id)));
  f.provider.value = channel?.provider ?? 'gemini';
  f.label.value = channel?.name ?? '';
  f.group.value = channel?.group ?? '';
  f.workspace.value = channel?.workspace ?? '';
  f.enabled.checked = channel?.enabled ?? true;
  setupChannelFields();
  message(channelForm.querySelector('.form-error'));
  channelDialog.showModal();
}

fields(channelForm).provider.addEventListener('change', () => {
  fields(channelForm).key.value = '';
  fields(channelForm).group.value = '';
  setupChannelFields();
});

function renumberTargets() {
  const rows = [...targetList.children];
  rows.forEach((row, index) => {
    row.querySelector('legend').textContent = `候选 ${index + 1}`;
    row.querySelector('[data-move="-1"]').disabled = index === 0;
    row.querySelector('[data-move="1"]').disabled = index === rows.length - 1;
    row.querySelector('[data-remove]').disabled = rows.length === 1;
  });
  $('#add-target').disabled = rows.length >= 12;
}

function addTarget(target) {
  const row = $('#target-template').content.firstElementChild.cloneNode(true);
  const channel = row.querySelector('[name="channel"]');
  channel.replaceChildren(...state.channels.map((item) => new Option(item.name, item.id)));
  channel.value = target?.channel ?? state.channels[0].id;
  for (const [name, fallback] of [['model', ''], ['rpm', 0], ['rpd', 0]]) {
    row.querySelector(`[name="${name}"]`).value = target?.[name] ?? fallback;
  }
  targetList.append(row);
  renumberTargets();
}

function editRoute(route) {
  editingRoute = route;
  routeForm.reset();
  $('#route-title').textContent = route ? '编辑路由' : '添加路由';
  fields(routeForm).alias.value = route?.id ?? (state.routes.length ? '' : 'auto');
  targetList.replaceChildren();
  for (const target of route?.targets ?? [undefined]) addTarget(target);
  message(routeForm.querySelector('.form-error'));
  routeDialog.showModal();
}

targetList.addEventListener('click', (event) => {
  const node = event.target.closest('button');
  if (!node) return;
  const row = node.closest('fieldset');
  if (node.hasAttribute('data-remove')) row.remove();
  if (node.dataset.move === '-1' && row.previousElementSibling) row.previousElementSibling.before(row);
  if (node.dataset.move === '1' && row.nextElementSibling) row.nextElementSibling.after(row);
  renumberTargets();
});

async function saveForm(form, dialog, update, tab) {
  const submit = form.querySelector('[type="submit"]');
  const errorField = form.querySelector('.form-error');
  submit.disabled = true;
  message(errorField);
  try {
    await load(adminKey, update);
    dialog.close();
    showTab(tab);
    notice('配置已保存并生效。');
  } catch (error) {
    message(errorField, error.message);
    errorField.scrollIntoView({ block: 'nearest' });
  } finally {
    submit.disabled = false;
  }
}

for (const dialog of [channelDialog, routeDialog]) {
  const busy = () => dialog.querySelector('[type="submit"]').disabled;
  dialog.querySelector('[data-cancel]').addEventListener('click', () => { if (!busy()) dialog.close(); });
  dialog.addEventListener('cancel', (event) => { if (busy()) event.preventDefault(); });
}

channelForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const f = fields(channelForm);
  const item = {
    id: editingChannel?.id ?? `ch-${crypto.randomUUID()}`,
    name: f.label.value.trim(), provider: f.provider.value, baseUrl: f.baseUrl.value.trim(),
    key: f.key.value.trim(), group: f.group.value.trim(), workspace: f.workspace.value.trim(),
    enabled: f.enabled.checked,
  };
  const channels = editingChannel ? state.channels.map((channel) => channel.id === item.id ? item : channel) : [...state.channels, item];
  void saveForm(channelForm, channelDialog, { channels, routes: state.routes }, 'channels');
});

routeForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const route = {
    id: fields(routeForm).alias.value.trim(),
    targets: [...targetList.children].map((row) => ({
      channel: row.querySelector('[name="channel"]').value,
      model: row.querySelector('[name="model"]').value.trim(),
      rpm: row.querySelector('[name="rpm"]').valueAsNumber,
      rpd: row.querySelector('[name="rpd"]').valueAsNumber,
    })),
  };
  const routes = editingRoute ? state.routes.map((item) => item.id === editingRoute.id ? route : item) : [...state.routes, route];
  void saveForm(routeForm, routeDialog, { routes, channels: state.channels }, 'routes');
});

async function removeChannel(channel) {
  if (state.routes.some((route) => route.targets.some((target) => target.channel === channel.id))) {
    notice('该渠道仍被路由引用。请先编辑对应路由。');
    return;
  }
  if (!window.confirm(`删除渠道「${channel.name}」？`)) return;
  try {
    await load(adminKey, { channels: state.channels.filter(({ id }) => id !== channel.id), routes: state.routes });
    notice('渠道已删除。');
  } catch (error) {
    notice(error.message);
  }
}

async function removeRoute(route) {
  if (!window.confirm(`删除模型路由「${route.id}」？`)) return;
  try {
    await load(adminKey, { channels: state.channels, routes: state.routes.filter(({ id }) => id !== route.id) });
    notice('路由已删除。');
  } catch (error) {
    notice(error.message);
  }
}

$('#add-channel').addEventListener('click', () => editChannel());
$('#add-route').addEventListener('click', () => editRoute());
$('#add-target').addEventListener('click', () => addTarget());

async function showStream(response, result) {
  const parser = sseParser();
  const output = document.createTextNode('');
  result.replaceChildren(output);
  let finished = false;
  for await (const bytes of response.body) {
    for (const frame of parser.push(bytes)) {
      if (frame === '[DONE]') {
        finished = true;
        continue;
      }
      const data = JSON.parse(frame);
      if (data.error) throw new Error('上游在流式输出期间报告错误。');
      const choice = data.choices?.[0];
      const text = choice?.delta?.content;
      if (typeof text === 'string' && output.length < 65_536) output.appendData(text.slice(0, 65_536 - output.length));
      if (choice?.finish_reason) finished = true;
    }
    if (parser.buffered > 1024 * 1024) throw new Error('流式响应分帧过大。');
  }
  if (!finished) throw new Error('流式连接提前结束。');
  if (!output.length) output.appendData('已收到响应，模型未返回文本。');
}

$('#test-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const controller = new AbortController();
  testController = controller;
  const result = $('#test-result');
  const hit = $('#test-hit');
  const stream = $('#test-stream').checked;
  $('#test-send').disabled = true;
  $('#test-stop').hidden = false;
  message(hit);
  message(result, '等待上游响应…');
  try {
    const response = await request('/v1/chat/completions', state.gatewayKey, {
      method: 'POST', signal: controller.signal, body: JSON.stringify({
        model: $('#test-model').value,
        messages: [{ role: 'user', content: $('#prompt').value }],
        stream,
      }),
    });
    const channel = state.channels.find(({ id }) => id === response.headers.get('X-Gateway-Channel'));
    message(hit, `命中 ${channel?.name ?? '上游'} · ${response.headers.get('X-Gateway-Model')}`);
    if (stream) {
      await showStream(response, result);
    } else {
      const data = await response.json();
      message(result, data.choices?.[0]?.message?.content || '已收到响应，模型未返回文本。');
    }
  } catch (error) {
    if (testController === controller) {
      result.append(`\n${controller.signal.aborted ? '已停止。' : error.message}`);
    }
  } finally {
    if (testController === controller) {
      testController = undefined;
      $('#test-send').disabled = !state.routes.length;
      $('#test-stop').hidden = true;
      void load().catch(() => {});
    }
  }
});

$('#test-stop').addEventListener('click', () => testController?.abort());
const savedKey = sessionStorage.getItem('hub-admin');
if (savedKey) void signIn(savedKey);

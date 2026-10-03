import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../adapters/minecraft/public/app.js', import.meta.url), 'utf8');
const markup = await readFile(new URL('../adapters/minecraft/public/index.html', import.meta.url), 'utf8');
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };
function deferred() {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>(done => { resolve = done; }); return { promise, resolve };
}
class Element {
  tag: string; id = ''; value = ''; textContent = ''; title = ''; disabled = false; hidden = false;
  children: Element[] = []; dataset: Record<string, string> = {}; attributes: Record<string, string> = {};
  onclick?: (event?: any) => any; onchange?: () => any; onkeydown?: (event: any) => any;
  constructor(tag = 'div') { this.tag = tag; }
  get options() { return this.children; }
  append(...nodes: Element[]) { this.children.push(...nodes); }
  prepend(...nodes: Element[]) { this.children.unshift(...nodes); }
  replaceChildren(...nodes: Element[]) {
    this.children = nodes;
    if (this.tag === 'select' && !nodes.some(node => node.value === this.value)) this.value = nodes[0]?.value || '';
  }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  click() { if (!this.disabled) return this.onclick?.({}); }
}
const actor = (name = 'Sheldon', fields: any = {}) => ({ name, ready: true, persona: name, busy: false,
  brainBusy: false, bodyBusy: false, position: { x: 0, y: 64, z: 0 }, health: 20, food: 20,
  control: { version: 7, stopped: false }, inventory: [], ...fields });
type Reply = { status?: number; data: any };
type Request = { path: string; method: string; input?: any };

/** Executes the actual browser entry point and its assigned click handlers.
 * Only DOM/camera/HTTP are replaced; no helper or button implementation is copied. */
async function fixture(options: { bots?: any[]; experiment?: any;
  post?: (request: Request, state: any) => Promise<Reply | undefined> | Reply | undefined } = {}) {
  const nodes = new Map<string, Element>();
  for (const match of markup.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"[^>]*>/gu)) {
    const node = new Element(match[1]); node.id = match[2]; node.disabled = /\bdisabled\b/u.test(match[0]); nodes.set(node.id, node);
  }
  const el = (id: string) => { const node = nodes.get(id); assert.ok(node, `real markup includes ${id}`); return node; };
  const state = { bots: options.bots || [actor()], experiment: options.experiment || {}, experience: {} };
  const calls: Request[] = [], intervals: (() => any)[] = [];
  const response = ({ status = 200, data }: Reply) => {
    const saved = structuredClone(data); return { ok: status >= 200 && status < 300, status, json: async () => structuredClone(saved) };
  };
  const fetch = async (url: string, init: any = {}) => {
    assert.ok(url.startsWith('/api/'), 'all HTTP is handled by the fixture');
    const request: Request = { path: url.slice(5), method: init.method || 'GET',
      ...(init.body ? { input: JSON.parse(init.body) } : {}) };
    calls.push(request);
    if (request.path === 'session') return response({ data: { token: 'offline-test-session' } });
    if (request.path === 'bots') return response({ data: { bots: state.bots } });
    if (request.path === 'experiment') return response({ data: state.experiment });
    if (request.path === 'experience') return response({ data: state.experience });
    const match = /^bots\/([^/]+)\/(observe|tasks|actions|intent|stop)$/u.exec(request.path);
    assert.ok(match, `unexpected HTTP: ${request.method} ${request.path}`);
    const bot = state.bots.find(bot => bot.name === match[1]); assert.ok(bot);
    if (match[2] === 'observe') return response({ data: { ...bot, recentEvents: [] } });
    assert.equal(request.method, 'POST');
    const custom = await options.post?.(request, state);
    if (custom) return response(custom);
    if (match[2] === 'stop') {
      bot.busy = bot.brainBusy = bot.bodyBusy = false; delete bot.taskId;
      if (bot.control) bot.control = { version: bot.control.version + 1, stopped: true };
      return response({ data: { stopped: true } });
    }
    if (match[2] === 'intent') {
      if (request.input.expectedVersion !== bot.control?.version) return response({ status: 409, data: { accepted: false, reason: 'stale_version' } });
      bot.control = { version: bot.control.version + 1, stopped: false, intent: { version: bot.control.version + 1, goal: { steps: request.input.steps } } };
      bot.busy = bot.bodyBusy = true;
      return response({ status: 202, data: { accepted: true, version: bot.control.version, intentId: 'manual-intent' } });
    }
    return response({ data: match[2] === 'tasks' ? { status: 'completed', reply: '完成了新的思考。', actions: [] }
      : { status: 'completed', action: request.input } });
  };
  vm.runInNewContext(source.replace(/^import \{ CameraSession \} from '\.\/camera-session\.js';/u, ''), {
    document: { getElementById: (id: string) => el(id), createElement: (tag: string) => new Element(tag),
      visibilityState: 'visible', addEventListener() {} },
    window: { addEventListener() {} }, location: { origin: 'http://127.0.0.1:18791' },
    navigator: {}, URL, console, fetch, AbortSignal: { timeout() {} },
    setInterval: (callback: () => any) => { intervals.push(callback); return intervals.length; },
    IntersectionObserver: class { observe() {} },
    CameraSession: class { select() {} receive() {} setVisible() {} release() {} },
  }, { filename: 'public/app.js' });
  await flush();
  assert.equal(intervals.length, 1, 'real app boot installed refresh');
  assert.equal(el('bot').value, state.bots[0].name);
  el('instruction').value = '继续观察并规划'; el('message').value = '你好';
  el('x').value = '3'; el('y').value = '64'; el('z').value = '0';
  return { state, calls, el, click: (id: string) => el(id).click(), posts: () => calls.filter(call => call.method === 'POST'),
    async refresh() { await intervals[0](); await flush(); },
    select(name: string) { el('bot').value = name; el('bot').onchange?.(); } };
}

test('dual moving body permits new planning and chat; movement remains blocked by the brain lock', async () => {
  const f = await fixture({ bots: [actor('Sheldon', { busy: true, bodyBusy: true })] });
  for (const id of ['task', 'say', 'move', 'stop']) assert.equal(f.el(id).disabled, false, id);
  await f.click('say'); await f.click('task');
  assert.deepEqual(f.posts().map(call => call.path), ['bots/Sheldon/actions', 'bots/Sheldon/tasks']);
  f.state.bots[0].brainBusy = true; f.state.bots[0].taskId = 'real-brain'; await f.refresh();
  assert.equal(f.el('move').disabled, true); assert.equal(f.el('task').disabled, true);
  assert.equal(f.el('say').disabled, false); assert.equal(f.el('stop').disabled, false);
  await f.click('move'); assert.equal(f.posts().length, 2);
});

test('long task locks only its actor planning; chat, another actor and stop stay usable', async () => {
  const pending = deferred();
  const f = await fixture({ bots: [actor(), actor('Sherlock')], post: request => {
    if (request.path === 'bots/Sheldon/tasks') return pending.promise;
  } });
  const task = f.click('task'); await flush();
  assert.equal(f.el('task').disabled, true); assert.equal(f.el('move').disabled, true);
  assert.equal(f.el('say').disabled, false); assert.equal(f.el('stop').disabled, false);
  await f.click('say');
  f.select('Sherlock'); assert.equal(f.el('task').disabled, false); await f.click('task');
  const sherlockResult = f.el('result').textContent;
  f.select('Sheldon'); await f.click('stop'); assert.match(f.el('result').textContent, /身体目标与自保授权已撤销/u);
  f.select('Sherlock'); pending.resolve({ data: { status: 'cancelled', reply: '迟到的旧回复', actions: [] } }); await task;
  assert.equal(f.el('result').textContent, sherlockResult, 'late A response cannot relabel B');
  f.select('Sheldon'); assert.doesNotMatch(f.el('result').textContent, /迟到/u);
  assert.match(f.el('result').textContent, /已撤销/u, 'late task cannot overwrite newer stop');
  assert.deepEqual(f.posts().map(call => call.path), ['bots/Sheldon/tasks', 'bots/Sheldon/actions', 'bots/Sherlock/tasks', 'bots/Sheldon/stop']);
});

test('idle reaction lease can always be explicitly stopped even with busy=false', async () => {
  const f = await fixture({ bots: [actor('Sheldon', { control: { version: 9, stopped: false,
    intent: { version: 9, allowedReactions: ['surface', 'eat'], goal: { steps: [] } } } })] });
  assert.equal(f.el('stop').disabled, false); assert.equal(f.el('stop').textContent, '停止角色');
  await f.click('stop'); assert.deepEqual(f.posts(), [{ method: 'POST', path: 'bots/Sheldon/stop', input: {} }]);
  assert.equal(f.el('move').textContent, '恢复并走到坐标');
});

test('dual move submits displayed version once; accepted is not displayed as arrival', async () => {
  const pending = deferred();
  const f = await fixture({ post: request => request.path.endsWith('/intent') ? pending.promise : undefined });
  const movement = f.click('move'); await flush();
  assert.equal(f.el('move').disabled, true); assert.equal(f.el('task').disabled, true);
  assert.equal(f.el('say').disabled, false); assert.equal(f.el('stop').disabled, false);
  await f.click('move'); assert.equal(f.posts().length, 1, 'double click cannot submit twice');
  assert.deepEqual(f.posts()[0], { method: 'POST', path: 'bots/Sheldon/intent', input: {
    expectedVersion: 7, label: '手动移动', steps: [{ type: 'goto', x: 3, y: 64, z: 0 }], reactions: [], ttlMs: 30000 } });
  pending.resolve({ status: 202, data: { accepted: true, version: 8 } }); await movement;
  assert.match(f.el('result').textContent, /已接收移动目标/u); assert.match(f.el('result').textContent, /是否到达请查看/u);
});

test('409 refreshes state without replay; only a new click may use the new version', async () => {
  const f = await fixture(); f.state.bots[0].control.version = 12;
  await f.click('move');
  assert.equal(f.posts().length, 1); assert.equal(f.posts()[0].input.expectedVersion, 7);
  assert.match(f.el('result').textContent, /再次点击确认/u);
  await f.click('move');
  assert.equal(f.posts().length, 2); assert.equal(f.posts()[1].input.expectedVersion, 12);
});

test('stopped body explicitly resumes only the newly clicked move, never previous work or reactions', async () => {
  const f = await fixture({ bots: [actor('Sheldon', { control: { version: 11, stopped: true } })] });
  assert.equal(f.el('move').textContent, '恢复并走到坐标'); await f.click('move');
  const input = f.posts()[0].input;
  assert.equal(input.expectedVersion, 11); assert.equal(input.resume, true);
  assert.deepEqual(input.steps, [{ type: 'goto', x: 3, y: 64, z: 0 }]); assert.deepEqual(input.reactions, []);
  assert.equal(f.el('move').textContent, '走到坐标');
});

test('auto scheduling blocks manual takeover but dual chat and stop remain available', async () => {
  const f = await fixture({ bots: [actor('Sheldon', { busy: true, brainBusy: true })],
    experiment: { scheduler: { phase: 'running', activeTasks: 1, maxConcurrent: 4, actors: [] } } });
  assert.equal(f.el('task').disabled, true); assert.equal(f.el('move').disabled, true);
  assert.equal(f.el('say').disabled, false); assert.equal(f.el('stop').disabled, false);
  await f.click('task'); await f.click('move'); await f.click('say');
  assert.deepEqual(f.posts().map(call => call.path), ['bots/Sheldon/actions']);
});

test('legacy body keeps serialized actions and direct /actions goto compatibility', async () => {
  const pending = deferred();
  const f = await fixture({ bots: [actor('Sheldon', { control: undefined, busy: true })],
    post: request => request.path.endsWith('/tasks') ? pending.promise : undefined });
  for (const id of ['task', 'say', 'move']) assert.equal(f.el(id).disabled, true);
  assert.equal(f.el('stop').disabled, false);
  f.state.bots[0].busy = false; await f.refresh(); await f.click('move');
  assert.deepEqual(f.posts()[0], { path: 'bots/Sheldon/actions', method: 'POST', input: { type: 'goto', x: 3, y: 64, z: 0 } });
  const task = f.click('task'); await flush();
  assert.equal(f.el('say').disabled, true); assert.equal(f.el('stop').disabled, false);
  pending.resolve({ data: { status: 'completed', actions: [] } }); await task;
});

test('versioned move is not replayed after a changed session; missing versions disable move', async () => {
  const f = await fixture({ post: request => request.path.endsWith('/intent') ? { status: 401, data: { error: 'expired session' } } : undefined });
  await f.click('move'); assert.equal(f.posts().length, 1);
  assert.match(f.el('result').textContent, /服务会话已变化/u);
  f.state.bots[0].control = { stopped: false }; await f.refresh();
  assert.equal(f.el('move').disabled, true); await f.click('move'); assert.equal(f.posts().length, 1);
});

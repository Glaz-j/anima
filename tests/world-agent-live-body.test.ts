import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { BodyController } from '../packages/bridge/src/body-controller.ts';
import { WorldMemory } from '../packages/npc-core/src/world-memory.ts';
import { loadWorldPersona } from '../packages/npc-core/src/world-persona.ts';
import { compactBodyControl, runWorldAgent, WORLD_TURN_LIMITS, type WorldAgentPort } from '../packages/pi-runtime/src/world-agent.ts';

const call = (name: string, args: any) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
const done = () => fauxAssistantMessage(fauxText('继续工作。'), { stopReason: 'stop' });
const remember = () => call('remember', { text: '根据执行结果重新判断。', category: 'note' });
const plan = (expectedVersion: number) => ({ expectedVersion, label: '继续观察后的行动',
  steps: [{ type: 'wait', ms: 100 }], ttlMs: 30000, reactions: [] });
function runtime(responses: any[]) {
  const models = createModels(), faux = fauxProvider(); models.setProvider(faux.provider); faux.setResponses(responses);
  return { models, model: faux.getModel(), apiKey: undefined as any, source: 'test' };
}
function requestState(context: any) {
  const blocks = context.systemPrompt.match(/<本次请求身体状态>\n[\s\S]*?\n<\/本次请求身体状态>/g);
  assert.equal(blocks?.length, 1, 'Each request receives one fresh block, without accumulating old blocks.');
  const block = blocks[0];
  assert.ok(block.length <= 4500);
  assert.ok(context.systemPrompt.length <= WORLD_TURN_LIMITS.systemChars);
  return JSON.parse(block.split('\n').find((line: string) => line.startsWith('{'))!);
}
async function fixture(t: any, initial: any = { version: 1, phase: 'running', stopped: false }) {
  const root = await mkdtemp(join(tmpdir(), 'anima-body-live-'));
  t.after(async () => { assert.ok(root.startsWith(join(tmpdir(), 'anima-body-live-'))); await rm(root, { recursive: true, force: true }); });
  const memory = await WorldMemory.open(root, 'Sheldon', 'sheldon'), persona = await loadWorldPersona(root, 'sheldon');
  let live = structuredClone(initial), reads = 0;
  let readStatus = () => structuredClone(live);
  const submitted: any[] = [], cancelled: number[] = [], executed: any[] = [];
  const port: WorldAgentPort = { name: 'Sheldon', persona: 'test', roleId: 'sheldon',
    // Deliberately stale: a successful refresh must supersede this initial observation.
    observe: () => ({ position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, inventory: [],
      recentEvents: [], control: structuredClone(initial) }),
    execute: async action => { executed.push(action); return { id: `direct-${executed.length}`, status: 'completed', action }; },
    body: {
      status: () => { reads++; return readStatus(); },
      submit: request => {
        submitted.push(structuredClone(request));
        if (request.expectedVersion !== live.version) return { accepted: false, version: live.version, reason: 'stale_version' };
        if (live.stopped && !request.resume) return { accepted: false, version: live.version, reason: 'stopped' };
        live = { version: live.version + 1, phase: 'ready', stopped: false, recentReceipts: live.recentReceipts ?? [],
          intent: { version: live.version + 1, expiresAt: 30000, goal: { steps: request.steps }, allowedReactions: request.reactions } };
        return { accepted: true, version: live.version, control: structuredClone(live) };
      },
      cancel: version => {
        cancelled.push(version);
        if (version !== live.version) return { accepted: false, version: live.version, reason: 'stale_version' };
        live = { version: live.version + 1, stopped: live.stopped, phase: 'idle' };
        return { accepted: true, version: live.version, control: structuredClone(live) };
      },
    },
  };
  return { root, memory, persona, port, goalReview: false, instruction: '结合当前身体状态行动。', submitted, cancelled, executed,
    setControl: (control: any) => { live = structuredClone(control); }, control: () => live,
    setStatus: (read: () => any) => { readStatus = read; }, reads: () => reads };
}

for (const asynchronous of [false, true]) test(`each execution request refreshes ${asynchronous ? 'async' : 'sync'} body status without an explicit tool`, async t => {
  const f = await fixture(t);
  f.setControl({ version: 2, phase: 'watching', workCompleted: true, goalStatus: 'completed' });
  if (asynchronous) f.setStatus(async () => structuredClone(f.control()));
  let requests = 0;
  const result = await runWorldAgent({ ...f, runtime: runtime([
    (context: any) => {
      requests++; assert.equal(requestState(context).control.version, 2);
      assert.equal(requestState(context).control.workCompleted, true);
      f.setControl({ version: 3, phase: 'idle', goalStatus: 'expired' }); return remember();
    },
    (context: any) => {
      requests++; assert.equal(requestState(context).control.version, 3);
      assert.equal(requestState(context).control.goalStatus, 'expired'); return call('body_plan', plan(3));
    },
    (context: any) => { requests++; assert.equal(requestState(context).control.version, 4); return done(); },
  ]) });
  assert.equal(result.status, 'completed'); assert.equal(f.reads(), requests);
  assert.deepEqual(f.submitted.map(request => request.expectedVersion), [3]);
  assert.deepEqual(result.toolTrace.map(row => row.status), ['completed', 'accepted']);
});

for (const transition of ['completed', 'expired']) test(`a real body ${transition} transition between requests updates authorization without polling`, async t => {
  let now = 1000, completed = false, finish: (result: any) => void = () => {};
  const body = new BodyController<any, any, any>({ now: () => now, readState: () => ({}), switchDelayMs: 0, minRunMs: 0,
    select: () => completed ? { kind: 'complete' } : transition === 'completed'
      ? { kind: 'run', key: 'gather-step', action: { type: 'gather' }, priority: 1 } : { kind: 'wait' },
    execute: () => new Promise(resolve => { finish = resolve; }), halt: () => {},
  });
  body.submit({ id: 'original', version: 1, expiresAt: 1100, goal: { steps: [{ type: 'gather' }] }, allowedReactions: [] });
  body.tick(); await Promise.resolve();
  t.after(() => body.dispose());
  const f = await fixture(t, body.snapshot());
  const result = await runWorldAgent({ ...f, runtime: runtime([
    async (context: any) => {
      assert.equal(requestState(context).control.version, 1);
      if (transition === 'completed') {
        finish({ id: 'gather-finished', status: 'completed', action: { type: 'gather' },
          details: { minedBlocks: 1, inventoryConfirmed: true, inventoryDelta: [{ item: 'oak_log', change: 1 }] } });
        await body.whenIdle(); completed = true;
      } else now = 1200;
      body.tick(); f.setControl(body.snapshot()); return remember();
    },
    (context: any) => {
      const current = requestState(context);
      assert.equal(current.control.version, 2); assert.equal(current.execution.intent, undefined);
      if (transition === 'completed') {
        assert.match(context.systemPrompt, /gather-finished/);
        assert.match(context.systemPrompt, /"blockChanges":1/);
      }
      return call('body_plan', plan(2));
    }, done(),
  ]) });
  assert.equal(result.status, 'completed'); assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].expectedVersion, 2); assert.equal(f.reads(), 3);
  if (transition === 'completed') assert.equal(f.memory.recentProgress(1)[0].actionReceipts![0].intentVersion, 1);
});

for (const expectedVersion of [1, 2]) test(`a version change during generation still rejects ${expectedVersion === 1 ? 'the old' : 'a guessed new'} authorization`, async t => {
  const f = await fixture(t);
  const result = await runWorldAgent({ ...f, runtime: runtime([
    (context: any) => {
      assert.equal(requestState(context).control.version, 1);
      f.setControl({ version: 2, stopped: true, phase: 'stopped' });
      return call('body_plan', { ...plan(expectedVersion), resume: true });
    }, done(),
  ]) });
  assert.equal(result.toolTrace[0].status, 'rejected'); assert.equal(f.control().stopped, true);
  assert.deepEqual(f.submitted.map(request => request.expectedVersion), expectedVersion === 1 ? [1] : []);
  assert.deepEqual(f.cancelled, []);
});

test('a body_status call cannot authorize a later call in the same model response', async t => {
  const f = await fixture(t);
  const result = await runWorldAgent({ ...f, runtime: runtime([
    () => {
      f.setControl({ version: 2, stopped: true, phase: 'stopped' });
      return fauxAssistantMessage([fauxToolCall('body_status', {}),
        fauxToolCall('body_plan', { ...plan(2), resume: true })], { stopReason: 'toolUse' });
    }, done(),
  ]) });
  assert.equal(result.toolTrace[1].status, 'rejected'); assert.equal(f.submitted.length, 0);
  assert.equal(f.reads(), 3, 'Two logical requests plus the explicitly requested body_status tool.');
});

test('refreshing a stopped body is read-only and does not renew or resume it', async t => {
  const control = { version: 9, stopped: true, disposed: false, phase: 'stopped',
    intent: { version: 8, expiresAt: 12345, goal: { steps: [] }, allowedReactions: [] } };
  const f = await fixture(t, control);
  const result = await runWorldAgent({ ...f, runtime: runtime([
    (context: any) => { assert.equal(requestState(context).control.stopped, true); return remember(); }, done(),
  ]) });
  assert.equal(result.status, 'completed'); assert.deepEqual(f.control(), control);
  assert.equal(f.reads(), 2); assert.deepEqual(f.submitted, []); assert.deepEqual(f.cancelled, []);
});

for (const failure of ['throw', 'invalid']) test(`a ${failure} status refresh never presents a stale version as current authorization`, async t => {
  const f = await fixture(t);
  f.setStatus(() => {
    if (f.reads() === 2) {
      if (failure === 'throw') throw new Error('status temporarily unavailable');
      return { version: '2', phase: 'unknown' };
    }
    return structuredClone(f.control());
  });
  const result = await runWorldAgent({ ...f, runtime: runtime([
    () => { f.setControl({ version: 2, phase: 'idle' }); return remember(); },
    (context: any) => {
      const snapshot = requestState(context); assert.equal(snapshot.available, false); assert.equal(snapshot.control, undefined);
      return call('body_plan', plan(1));
    },
    (context: any) => {
      assert.equal(requestState(context).control.version, 2); return call('body_plan', plan(2));
    }, done(),
  ]) });
  assert.equal(result.toolTrace[1].status, 'rejected'); assert.equal(result.toolTrace[2].status, 'accepted');
  assert.deepEqual(f.submitted.map(request => request.expectedVersion), [2]);
  assert.equal(result.perceptionErrors.length, 1); assert.match(result.perceptionErrors[0], /Request body status unavailable/);
});

test('live blocked control preserves old cancelled and failed partial outcomes under their original version', async t => {
  const f = await fixture(t);
  const receipts = [
    { id: 6, intentId: 'old', intentVersion: 1, status: 'cancelled', startedAt: 1, finishedAt: 2,
      result: { id: 'cancelled-bridge', status: 'cancelled', action: { type: 'bridge' },
        details: { reached: false, spent: 2, placed: 2, inventoryConfirmed: false } } },
    { id: 7, intentId: 'old', intentVersion: 1, status: 'failed', startedAt: 2, finishedAt: 3,
      result: { id: 'failed-gather', status: 'failed', action: { type: 'gather' }, error: 'local obstruction',
        details: { minedBlocks: 1, inventoryConfirmed: true, inventoryDelta: [{ item: 'oak_log', change: 1 }] } } },
  ];
  const replanRequired = { intentVersion: 2, stepIndex: 1, receiptId: 8, code: 'jump_path_obstructed', reason: '本次跳跃路径被挡。' };
  const result = await runWorldAgent({ ...f, runtime: runtime([
    () => { f.setControl({ version: 2, phase: 'waiting', workCompleted: false, goalStatus: 'blocked',
      completedSteps: [], recentReceipts: receipts, replanRequired }); return remember(); },
    (context: any) => {
      const snapshot = requestState(context);
      assert.deepEqual(snapshot.control.replanRequired, replanRequired); assert.equal(snapshot.control.workCompleted, false);
      assert.match(context.systemPrompt, /"blockChanges":3/); assert.match(context.systemPrompt, /cancelled-bridge/);
      assert.match(context.systemPrompt, /failed-gather/);
      assert.match(context.tools.find((tool: any) => tool.name === 'body_plan').description, /续租不能清除/);
      return remember();
    }, done(),
  ]) });
  assert.equal(result.status, 'completed'); assert.equal(result.actions.length, 2);
  const progress = f.memory.recentProgress(1)[0];
  assert.equal(progress.blockChanges, 3); assert.deepEqual(progress.inventoryChanges, [{ item: 'oak_log', change: 1 }]);
  assert.deepEqual(progress.actionReceipts!.map(row => [row.intentVersion, row.status]), [[1, 'cancelled'], [1, 'failed']]);
  assert.deepEqual(f.control().completedSteps, []); assert.deepEqual(f.submitted, []); assert.deepEqual(f.cancelled, []);
});

test('large control details remain bounded while exact ownership and replan fields stay visible', async t => {
  const f = await fixture(t);
  const huge = '\u0000'.repeat(10000), control = { version: 123, stopped: false, disposed: true, phase: huge,
    blocked: huge, goalStatus: huge, replanRequired: { intentVersion: 123, stepIndex: 11, receiptId: 55, code: huge, reason: huge },
    current: { id: huge, phase: huge }, bridgeProgress: Array.from({ length: 12 }, () => ({ step: huge, spent: huge })),
    intent: { id: huge, version: 123, goal: { label: huge, steps: Array.from({ length: 12 }, () => ({ type: 'wait', debug: huge })) } } };
  f.setControl(control);
  const result = await runWorldAgent({ ...f, runtime: runtime([(context: any) => {
    const snapshot = requestState(context);
    assert.equal(snapshot.control.version, 123); assert.equal(snapshot.control.disposed, true);
    assert.equal(snapshot.control.replanRequired.receiptId, 55);
    assert.ok(snapshot.control.replanRequired.code.length <= 80); assert.ok(snapshot.control.replanRequired.reason.length <= 180);
    assert.equal(snapshot.execution.truncated, true); return done();
  }]) });
  assert.equal(result.status, 'completed');
  const compact = compactBodyControl(control);
  assert.deepEqual(compactBodyControl(compact).replanRequired, compact.replanRequired);
  assert.equal(compactBodyControl({ ...control, replanRequired: { ...control.replanRequired, intentVersion: '123' } }).replanRequired, undefined);
});

test('an abort during an async refresh cannot start a late model request', async t => {
  const f = await fixture(t), controller = new AbortController();
  f.setStatus(async () => { controller.abort(); return f.control(); });
  let modelCalls = 0;
  const result = await runWorldAgent({ ...f, signal: controller.signal,
    runtime: runtime([() => { modelCalls++; return done(); }]) });
  assert.equal(result.status, 'cancelled'); assert.equal(modelCalls, 0);
  assert.deepEqual(f.submitted, []); assert.deepEqual(f.cancelled, []);
});

test('cancellation drains the reasoning turn without waiting for a pending status read', async t => {
  const f = await fixture(t), controller = new AbortController();
  let entered!: () => void, release!: (value: any) => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  f.setStatus(() => new Promise(resolve => { release = resolve; entered(); }));
  let modelCalls = 0;
  const running = runWorldAgent({ ...f, signal: controller.signal,
    runtime: runtime([() => { modelCalls++; return done(); }]) });
  await reading; controller.abort();
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([running, new Promise<never>((_resolve, reject) => {
      guard = setTimeout(() => reject(new Error('Cancellation waited for body.status to settle.')), 1000);
    })]);
    assert.equal(result.status, 'cancelled'); assert.equal(modelCalls, 0);
  } finally {
    clearTimeout(guard); release({ version: 99, stopped: false, phase: 'ready' }); await running;
  }
  assert.equal(modelCalls, 0); assert.deepEqual(f.submitted, []); assert.deepEqual(f.cancelled, []);
});

test('worlds without a body controller keep the existing direct-action path', async t => {
  const f = await fixture(t); delete f.port.body;
  f.port.observe = () => ({ position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, recentEvents: [] });
  const result = await runWorldAgent({ ...f, runtime: runtime([
    (context: any) => {
      assert.doesNotMatch(context.systemPrompt, /<本次请求身体状态>/);
      return call('action', { type: 'move', controls: ['forward'], ms: 100 });
    }, done(),
  ]) });
  assert.equal(result.status, 'completed'); assert.equal(f.reads(), 0);
  assert.deepEqual(f.executed.map(action => action.type), ['move']); assert.deepEqual(f.submitted, []);
});

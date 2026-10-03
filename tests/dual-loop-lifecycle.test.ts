import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Vec3 } from 'vec3';
import { MinecraftWorld, type BotRecord } from '../adapters/minecraft/src/world.ts';
import { MinecraftBody } from '../adapters/minecraft/src/minecraft-body.ts';
import { runTask } from '../adapters/minecraft/src/llm.ts';
import { NpcScheduler } from '../packages/bridge/src/npc-scheduler.ts';

async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 2500;
  while (!check() && Date.now() < deadline) await delay(5);
  assert.ok(check(), message);
}

async function fixture(t: any) {
  const prefix = join(tmpdir(), 'anima-dual-loop-'), root = await mkdtemp(prefix);
  const controls: Record<string, boolean> = {}, messages: string[] = [];
  const bot: any = Object.assign(new EventEmitter(), {
    version: '1.21.4', health: 20, food: 20, entities: {}, players: {},
    entity: { id: 1, position: new Vec3(.5, 64, .5), velocity: new Vec3(0, 0, 0),
      height: 1.8, width: .6, eyeHeight: 1.62, onGround: true, isInWater: false, isInLava: false },
    game: { dimension: 'overworld', gameMode: 'survival' },
    registry: { itemsByName: {}, foodsByName: {} },
    inventory: Object.assign(new EventEmitter(), { slots: [], items: () => [] }),
    _client: Object.assign(new EventEmitter(), { write() {} }),
    world: { raycast: () => null },
    blockAt: (p: Vec3) => ({ name: p.y < 64 ? 'stone' : 'air', position: p.floored(),
      boundingBox: p.y < 64 ? 'block' : 'empty' }),
    findBlocks: () => [], canSeeBlock: () => true, lookAt: async () => {},
    stopDigging() {}, deactivateItem() {},
    setControlState: (key: string, value: boolean) => { controls[key] = value; },
    getControlState: (key: string) => controls[key] ?? false,
    clearControlStates: () => { for (const key of Object.keys(controls)) controls[key] = false; },
    chat: (message: string) => messages.push(message),
  });
  const world = new MinecraftWorld({ host: 'fixture.invalid', port: 1, version: '1.21.4',
    logDirectory: join(root, 'events'), dualLoop: true });
  world.memoryNamespace = 'dual-loop-fixture';
  const record: BotRecord = { name: 'Sheldon', roleId: 'sheldon', persona: '测试人物', bot,
    ready: true, inventorySynced: true, events: [] };
  world.bots.set(record.name, record);
  const body = new MinecraftBody(world, record); record.body = body;
  t.after(async () => {
    await world.stop(record); await body.dispose();
    // World telemetry append is intentionally asynchronous.
    await delay(30); assert.ok(root.startsWith(prefix)); await rm(root, { recursive: true, force: true });
  });
  return { root, world, record, body, bot, controls, messages,
    plan(steps: any[], extra: any = {}) { return body.submit({ expectedVersion: body.snapshot().version,
      label: 'fixture goal', ttlMs: 10000, steps, ...extra }); } };
}

function fakeModel(t: any, reply?: (request: any, index: number, signal: AbortSignal) => Promise<any> | any) {
  const values = { ANIMA_API_KEY: 'fixture-only-not-a-credential', ANIMA_PROVIDER: 'fixture-proxy',
    ANIMA_API: 'openai-completions', ANIMA_BASE_URL: 'http://fixture.invalid/v1',
    ANIMA_MODEL: 'gpt-6-luna', ANIMA_MC_MODEL_SHELDON: undefined };
  const old = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(() => { for (const [key, value] of old) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const requests: any[] = [];
  t.mock.method(globalThis, 'fetch', async (input: any, init: any) => {
    assert.equal(String(input), 'http://fixture.invalid/v1/chat/completions');
    const request = JSON.parse(init.body); requests.push(request);
    const answer = await reply?.(request, requests.length - 1, init.signal);
    const delta = answer?.tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `fixture-${requests.length}`,
      type: 'function', function: { name: answer.tool, arguments: JSON.stringify(answer.args) } }] }
      : { role: 'assistant', content: '保留身体当前任务，结束本轮思考。' };
    const chunks = [{ id: 'fixture', object: 'chat.completion.chunk', model: request.model,
      choices: [{ index: 0, delta, finish_reason: null }] },
    { id: 'fixture', object: 'chat.completion.chunk', model: request.model,
      choices: [{ index: 0, delta: {}, finish_reason: answer?.tool ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }];
    return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } });
  });
  return requests;
}

test('real world/LLM wiring keeps one body owner across brain turns and read-only speech', async t => {
  const f = await fixture(t);
  fakeModel(t, (_request, index) => index === 0 ? { tool: 'action', args: { type: 'say', message: '继续走。' } } : undefined);
  assert.equal(f.plan([{ type: 'move', controls: ['forward'], ms: 4000 }]).accepted, true);
  await until(() => !!f.record.actionController && f.controls.forward, 'body has acquired and actuated its lease');
  const version = f.body.snapshot().version, owner = f.record.actionController;
  for (let i = 0; i < 2; i++) {
    const result = await runTask(f.world, f.record.name, '检查后保留当前身体目标。', f.root);
    assert.equal(result.status, 'completed'); assert.equal(f.record.task, undefined);
    assert.equal(f.record.actionController, owner); assert.equal(owner.signal.aborted, false);
    assert.equal(f.body.snapshot().version, version); assert.equal(f.controls.forward, true);
  }
  assert.ok(f.messages.some(message => message.includes('继续走')));
  assert.equal(f.world.summary(f.record).brainBusy, false);
  assert.equal(f.world.summary(f.record).bodyBusy, true);
});

test('cancelling the real model request and hurt perception do not cancel the independent body', async t => {
  const f = await fixture(t); let requested = false;
  fakeModel(t, async (_request, _index, signal) => {
    requested = true;
    await delay(5000, undefined, { signal });
  });
  f.plan([{ type: 'move', controls: ['forward'], ms: 4000 }]);
  await until(() => !!f.record.actionController, 'physical owner starts');
  const owner = f.record.actionController!, abort = new AbortController();
  const task = runTask(f.world, f.record.name, '观察。', f.root, { signal: abort.signal });
  await until(() => requested, 'fake model request starts');
  f.world.event(f.record, 'hurt', { healthBefore: 20, health: 18, food: 20, loss: 2 });
  await delay(30); assert.equal(owner.signal.aborted, false);
  abort.abort(); const result = await task;
  assert.equal(result.status, 'cancelled'); assert.equal(f.record.task, undefined);
  assert.equal(f.record.actionController, owner); assert.equal(owner.signal.aborted, false);
  assert.equal(f.controls.forward, true);
});

test('versioned cancellation remains cancelled during later brain startup; operator stop blocks new brains', async t => {
  const f = await fixture(t), requests = fakeModel(t);
  f.plan([{ type: 'move', controls: ['forward'], ms: 4000 }]);
  await until(() => !!f.record.actionController, 'physical owner starts');
  assert.equal(f.body.cancel(f.body.snapshot().version).accepted, true);
  await until(() => !f.record.actionController, 'cancel drains native move');
  const version = f.body.snapshot().version;
  assert.equal((await runTask(f.world, f.record.name, '观察。', f.root)).status, 'completed');
  assert.equal(f.body.snapshot().version, version); assert.equal(f.body.snapshot().intent, undefined);
  assert.equal(f.controls.forward, false);
  await f.world.stop(f.record);
  const requestCount = requests.length;
  await assert.rejects(runTask(f.world, f.record.name, '继续。', f.root), /操作者停止/);
  assert.equal(requests.length, requestCount);
  assert.equal(f.body.submit({ expectedVersion: version, steps: [], resume: true }, true).accepted, false);
  await assert.rejects(f.world.execute(f.record.name, { type: 'stop' }, 'stale-brain-task'), /expectedVersion/);
});

test('a malformed later step cannot partially replace or interrupt the current world body goal', async t => {
  const f = await fixture(t);
  f.plan([{ type: 'move', controls: ['forward'], ms: 4000 }]);
  await until(() => !!f.record.actionController, 'physical owner starts');
  const before = f.body.snapshot(), owner = f.record.actionController!;
  assert.throws(() => f.plan([{ type: 'wait', ms: 100 }, { type: 'jump_to', x: 0, y: 64, z: 0, durationMs: 6000 }]));
  assert.equal(f.body.snapshot().version, before.version);
  assert.equal(f.body.snapshot().intent?.id, before.intent?.id);
  assert.equal(f.record.actionController, owner); assert.equal(owner.signal.aborted, false);
});

test('actual intent completion reaches the scheduler, wakes a new brain, and full stop drains an idle brain body', async t => {
  const f = await fixture(t); let now = 0; const instructions: string[] = [];
  const scheduler = new NpcScheduler({ getActors: () => [{ name: f.record.name, ready: f.record.ready,
    busy: !!f.record.task }], run: async (_name, instruction) => { instructions.push(instruction); return { status: 'completed' }; },
    cancel: () => f.world.stop(f.record), scenarioStatus: () => ({ complete: false }),
    intervalMs: 10000, pollMs: 10000, eventCooldownMs: 20, mergeWindowMs: 0, now: () => now });
  t.after(() => scheduler.stop());
  f.world.onEvent = (record, event) => scheduler.wake(record.name, event);
  scheduler.start(); await until(() => instructions.length === 1, 'first scheduled turn'); await delay(10);
  f.plan([{ type: 'wait', ms: 30 }]);
  await until(() => f.record.events.some(event => event.type === 'intent-finished'), 'actual body completion event');
  now = 100; scheduler.tick(); await until(() => instructions.length === 2, 'terminal event wakes planner before heartbeat');
  assert.match(instructions[1], /intent-finished/);
  f.plan([{ type: 'move', controls: ['forward'], ms: 4000 }]);
  await until(() => !!f.record.actionController, 'body starts without an active brain');
  await scheduler.stop();
  assert.equal(f.body.snapshot().stopped, true); assert.equal(f.record.actionController, undefined);
  assert.equal(f.controls.forward, false); assert.equal(f.record.operatorStopped, true);
});

test('completed work retains authorized reactions across the next brain turn without resubmitting its steps', async t => {
  const f = await fixture(t); fakeModel(t);
  f.plan([{ type: 'wait', ms: 30 }], { reactions: ['surface'] });
  await until(() => f.body.snapshot().workCompleted, 'real step completion is reported separately from policy lifetime');
  const version = f.body.snapshot().version, id = f.body.snapshot().intent?.id;
  assert.ok(id); assert.equal(f.body.snapshot().goalStatus, 'completed');
  assert.equal(f.record.events.filter(event => event.type === 'goal-finished').length, 1);
  const result = await runTask(f.world, f.record.name, '当前工作已完成，保留应急授权。', f.root);
  assert.equal(result.status, 'completed'); assert.equal(f.body.snapshot().version, version);
  assert.equal(f.body.snapshot().intent?.id, id); assert.equal(f.body.snapshot().workCompleted, true);
  assert.deepEqual(f.body.snapshot().intent?.allowedReactions, ['surface']);
  assert.equal(f.body.cancel(version).accepted, true); assert.equal(f.body.snapshot().intent, undefined);
});

for (const mode of ['serial', 'parallel', 'dual'] as const) {
  test(`${mode} experiment uses its declared body waiting and reaction rules through real LLM wiring`, async t => {
    const f = await fixture(t); let stateAtSecondRequest: any;
    const requests = fakeModel(t, (_request, index) => {
      if (index === 0) return { tool: 'body_plan', args: { expectedVersion: 1, label: '等一小会',
        steps: [{ type: 'wait', ms: 300 }], reactions: ['surface'], ttlMs: 10000 } };
      stateAtSecondRequest = f.body.snapshot();
    });
    const result = await runTask(f.world, f.record.name, '观察后等待。', f.root, { bodyExecution: mode });
    assert.equal(result.status, 'completed'); assert.equal(result.toolTrace[0].status, 'accepted');
    const prompt = JSON.stringify(requests[0].messages);
    if (mode === 'serial') {
      assert.equal(stateAtSecondRequest.workCompleted, true); assert.equal(stateAtSecondRequest.current, undefined);
      assert.match(prompt, /串行对照实验/);
    } else {
      assert.equal(stateAtSecondRequest.workCompleted, false); assert.ok(stateAtSecondRequest.current);
      assert.deepEqual(stateAtSecondRequest.intent.allowedReactions, mode === 'dual' ? ['surface'] : []);
      assert.match(prompt, mode === 'parallel' ? /无自动反应的并行对照实验/ : /独立双循环/);
    }
  });
}

test('explicit new task grants bounded survival before delayed model IO without replaying stopped work', async t => {
  const f = await fixture(t); let requested = false;
  fakeModel(t, async (_request, _index, signal) => { requested = true; await delay(5000, undefined, { signal }); });
  f.plan([{ type: 'move', controls: ['forward'], ms: 4000 }]);
  await until(() => f.controls.forward, 'old work starts');
  await f.world.stop(f.record);
  const abort = new AbortController(), stoppedVersion = f.body.snapshot().version;
  const task = runTask(f.world, f.record.name, '重新观察周围。', f.root,
    { newTask: f.world.captureActivation(f.record), signal: abort.signal });
  const granted = f.body.snapshot();
  assert.equal(f.record.operatorStopped, false); assert.equal(granted.stopped, false);
  assert.ok(granted.version > stoppedVersion); assert.deepEqual(granted.intent?.goal.steps, []);
  assert.deepEqual(granted.intent?.allowedReactions, ['surface', 'eat', 'defend', 'flee']);
  assert.ok(granted.intent!.expiresAt - Date.now() <= 120000); assert.equal(f.controls.forward, false);
  await until(() => requested, 'model is waiting while independently authorized body remains live');
  assert.equal(f.body.snapshot().intent?.id, granted.intent?.id);
  abort.abort(); await task;
  assert.equal(f.body.snapshot().intent?.id, granted.intent?.id, 'model cancellation does not withdraw host lease');
});

test('task admission validates text, readiness, pending drain and old request ticket before clearing stop', async t => {
  const f = await fixture(t), requests = fakeModel(t);
  await f.world.stop(f.record);
  const ticket = f.world.captureActivation(f.record), version = f.body.snapshot().version;
  await assert.rejects(runTask(f.world, f.record.name, '  ', f.root, { newTask: ticket }), /instruction/);
  f.record.ready = false;
  await assert.rejects(runTask(f.world, f.record.name, '恢复。', f.root, { newTask: ticket }), /尚未进入/);
  f.record.ready = true;
  f.record.task = { id: 'already-running', controller: new AbortController() };
  await assert.rejects(runTask(f.world, f.record.name, '恢复。', f.root, { newTask: ticket }), /其他任务/);
  f.record.task = undefined;
  f.record.actionController = new AbortController();
  await assert.rejects(runTask(f.world, f.record.name, '恢复。', f.root, { newTask: ticket }), /收尾/);
  f.record.actionController = undefined;
  assert.equal(f.record.operatorStopped, true); assert.equal(f.body.snapshot().version, version);
  await f.world.stop(f.record); // A request parsed before this stop must not undo it.
  await assert.rejects(runTask(f.world, f.record.name, '恢复。', f.root, { newTask: ticket }), /已失效/);
  assert.equal(f.record.operatorStopped, true); assert.equal(requests.length, 0);
});

test('new task preserves a valid working intent and rejects a failed grant CAS without retry', async t => {
  const f = await fixture(t); fakeModel(t);
  f.plan([{ type: 'move', controls: ['forward'], ms: 4000 }], { reactions: ['surface'] });
  await until(() => f.controls.forward, 'existing valid goal runs');
  const intent = f.body.snapshot().intent, owner = f.record.actionController;
  await runTask(f.world, f.record.name, '检查工作。', f.root, { newTask: f.world.captureActivation(f.record) });
  assert.equal(f.body.snapshot().intent?.id, intent?.id); assert.equal(f.record.actionController, owner);
  await f.world.stop(f.record);
  const submit = t.mock.method(f.body, 'submit', () => ({ accepted: false, reason: 'stale_version', version: 999 }));
  await assert.rejects(runTask(f.world, f.record.name, '恢复工作。', f.root,
    { newTask: f.world.captureActivation(f.record) }), /授权已变化/);
  assert.equal(submit.mock.callCount(), 1); assert.equal(f.record.operatorStopped, true);
});

test('autonomous respawn restores only empty survival work before the next brain response', async t => {
  const f = await fixture(t); let requested = false;
  fakeModel(t, async (_request, _index, signal) => { requested = true; await delay(5000, undefined, { signal }); });
  f.world.startAutonomy(() => {});
  f.plan([{ type: 'move', controls: ['forward'], ms: 4000 }]);
  await until(() => f.controls.forward, 'pre-death work starts');
  const brain = runTask(f.world, f.record.name, '观察。', f.root);
  await until(() => requested, 'old brain is in flight');
  f.record.ready = false; f.bot.health = 0;
  const drained = f.world.stop(f.record, 'death');
  f.bot.health = 20; f.world.spawned(f.record);
  await drained;
  await until(() => !f.body.snapshot().stopped, 'spawn consumes session survival grant after body drains');
  assert.deepEqual(f.body.snapshot().intent?.goal.steps, []);
  assert.deepEqual(f.body.snapshot().intent?.allowedReactions, ['surface', 'eat', 'defend', 'flee']);
  assert.equal(f.controls.forward, false);
  const version = f.body.snapshot().version;
  f.world.spawned(f.record); await delay(20);
  assert.equal(f.body.snapshot().version, version, 'duplicate spawn cannot renew or replay the one-shot grant');
  await brain;
  f.body.cancel(version);
  await runTask(f.world, f.record.name, '这次只观察。', f.root, { signal: AbortSignal.abort() });
  assert.equal(f.body.snapshot().intent, undefined, 'ordinary turn after cancellation cannot manufacture a grant');
});

for (const boundary of ['operator-stop', 'global-stop', 'new-plan'] as const) {
  test(`${boundary} invalidates a pending respawn grant even when physical drain finishes later`, async t => {
    const f = await fixture(t); f.world.startAutonomy(() => {});
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), originalStop = f.body.stop.bind(f.body);
    t.mock.method(f.body, 'stop', (reason?: string) => {
      const drained = originalStop(reason);
      return reason === 'death' ? Promise.all([drained, gate]).then(() => {}) : drained;
    });
    f.record.ready = false;
    const draining = f.world.stop(f.record, 'death'); f.world.spawned(f.record);
    if (boundary === 'operator-stop') await f.world.stop(f.record);
    else if (boundary === 'global-stop') f.world.endAutonomy();
    else assert.equal(f.body.submit({ expectedVersion: f.body.snapshot().version, steps: [],
      label: 'new independent authorization', reactions: ['eat'], ttlMs: 10000 }, true).accepted, true);
    const version = f.body.snapshot().version, intent = f.body.snapshot().intent?.id;
    release(); await draining; await delay(20);
    assert.equal(f.body.snapshot().version, version); assert.equal(f.body.snapshot().intent?.id, intent);
    if (boundary === 'operator-stop') {
      f.world.startAutonomy(() => {}); f.world.spawned(f.record); await delay(20);
      assert.equal(f.record.operatorStopped, true, 'still-running global session cannot undo an individual stop');
      assert.equal(f.body.snapshot().stopped, true);
    }
  });
}

test('internal halt failure revokes autonomous respawn authority and is never automatically resumed', async t => {
  const f = await fixture(t); f.world.startAutonomy(() => {});
  f.plan([{ type: 'move', controls: ['forward'], ms: 4000 }]);
  await until(() => f.controls.forward, 'native work starts');
  // Inject at the control port: Mineflayer's best-effort disconnect cleanup
  // deliberately swallows native packet exceptions, so it is not this fault path.
  const halt = t.mock.method((f.body as any).controller.options, 'halt', () => { throw new Error('fixture halt failure'); });
  f.body.cancel(f.body.snapshot().version);
  halt.mock.restore();
  await until(() => !f.record.actionController, 'native cancellation drains');
  assert.ok(f.record.events.some(event => event.type === 'control-error'));
  assert.equal(f.record.operatorStopped, true);
  f.record.ready = false; await f.world.stop(f.record, 'death'); f.world.spawned(f.record); await delay(20);
  assert.equal(f.body.snapshot().stopped, true); assert.equal(f.body.snapshot().intent, undefined);
  assert.throws(() => f.world.authorizeTask(f.world.captureActivation(f.record)), /停止失败/);
});

for (const mode of ['serial', 'parallel'] as const) {
  test(`${mode} explicit task and autonomous respawn do not acquire reaction permissions`, async t => {
    const f = await fixture(t); fakeModel(t);
    await f.world.stop(f.record);
    await runTask(f.world, f.record.name, '恢复后观察。', f.root,
      { bodyExecution: mode, newTask: f.world.captureActivation(f.record) });
    assert.ok(!f.body.snapshot().intent?.allowedReactions.length);
    f.world.startAutonomy(() => {}, mode);
    f.record.ready = false; await f.world.stop(f.record, 'death'); f.world.spawned(f.record); await delay(20);
    assert.equal(f.body.snapshot().stopped, false);
    assert.ok(!f.body.snapshot().intent?.allowedReactions.length);
  });
}

test('rejected autonomous scheduler admission leaves the body stop latch and version intact', async t => {
  const f = await fixture(t); await f.world.stop(f.record);
  const version = f.body.snapshot().version;
  assert.throws(() => f.world.startAutonomy(() => { throw new Error('previous task is draining'); }), /draining/);
  assert.equal(f.record.operatorStopped, true); assert.equal(f.body.snapshot().version, version);
  f.world.spawned(f.record); await delay(20);
  assert.equal(f.body.snapshot().stopped, true);
});

test('an expired survival lease is not regenerated by a routine autonomous reasoning turn', async t => {
  const f = await fixture(t); fakeModel(t);
  f.world.startAutonomy(() => {});
  f.plan([], { reactions: ['surface'], ttlMs: 1000 });
  await until(() => !f.body.snapshot().intent, 'bounded lease actually expires');
  const version = f.body.snapshot().version;
  await runTask(f.world, f.record.name, '观察，不提交新计划。', f.root);
  assert.equal(f.body.snapshot().version, version); assert.equal(f.body.snapshot().intent, undefined);
  f.world.spawned(f.record); await delay(20);
  assert.equal(f.body.snapshot().intent, undefined, 'unpaired spawn is not a recovery authorization');
});

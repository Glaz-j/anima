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

async function until(check: () => boolean, message: string, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await delay(5);
  assert.ok(check(), message);
}

async function fixture(t: any) {
  const prefix = join(tmpdir(), 'anima-dual-baseline-'), root = await mkdtemp(prefix);
  const controls: Record<string, boolean> = {};
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
    clearControlStates: () => { for (const key of Object.keys(controls)) bot.setControlState(key, false); },
    chat() {},
  });
  const world = new MinecraftWorld({ host: 'fixture.invalid', port: 1, version: '1.21.4',
    logDirectory: join(root, 'events'), dualLoop: true });
  world.memoryNamespace = 'baseline-fixture';
  const record: BotRecord = { name: 'Sheldon', roleId: 'sheldon', persona: '测试人物', bot,
    ready: true, inventorySynced: true, events: [] };
  world.bots.set(record.name, record);
  const body = new MinecraftBody(world, record); record.body = body;
  t.after(async () => {
    await world.stop(record); await body.dispose(); await delay(30);
    assert.ok(root.startsWith(prefix)); await rm(root, { recursive: true, force: true });
  });
  return { root, world, record, body, bot, controls,
    plan(steps: any[], extra: any = {}) { return body.submit({ expectedVersion: body.snapshot().version,
      label: 'fixture goal', ttlMs: 10000, steps, ...extra }); } };
}

function fakeModel(t: any, reply: (request: any, index: number) => any = () => undefined) {
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
  const requests: { at: number; request: any }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: any, init: any) => {
    assert.equal(String(input), 'http://fixture.invalid/v1/chat/completions');
    const request = JSON.parse(init.body); requests.push({ at: Date.now(), request });
    const answer = reply(request, requests.length - 1);
    const delta = answer?.tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `fixture-${requests.length}`,
      type: 'function', function: { name: answer.tool, arguments: JSON.stringify(answer.args) } }] }
      : { role: 'assistant', content: '保持现有身体目标，结束本轮。' };
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

for (const mode of ['serial', 'parallel', 'dual'] as const) {
  test(`${mode} applies declared reaction permissions and waits only in the serial baseline`, async t => {
    const f = await fixture(t);
    let initial: any, next: any;
    const requests = fakeModel(t, (_request, index) => {
      if (index === 0) {
        initial = f.body.snapshot();
        return { tool: 'body_plan', args: { expectedVersion: initial.version, label: '相同原生移动',
          steps: [{ type: 'move', controls: ['forward'], ms: 500 }], reactions: ['surface', 'eat', 'defend', 'flee'], ttlMs: 10000 } };
      }
      next = { control: f.body.snapshot(), forward: f.controls.forward };
    });
    const task = runTask(f.world, f.record.name, '走一小段，然后报告实际状态。', f.root, { bodyExecution: mode });
    await until(() => !!f.body.snapshot().current, 'the identical native move starts');
    assert.deepEqual(initial.intent.allowedReactions, mode === 'dual' ? ['surface', 'eat', 'defend', 'flee'] : []);
    assert.deepEqual(f.body.snapshot().intent?.allowedReactions, mode === 'dual' ? ['surface', 'eat', 'defend', 'flee'] : []);
    assert.equal(f.controls.forward, true);
    if (mode === 'serial') {
      await delay(80); assert.equal(requests.length, 1, 'serial cannot resume reasoning while its submitted goal is still running');
    }
    const result = await task;
    assert.equal(result.status, 'completed'); assert.equal(requests.length, 2);
    assert.equal(result.toolTrace[0].status, 'accepted');
    if (mode === 'serial') {
      assert.equal(next.control.workCompleted, true); assert.equal(next.control.current, undefined);
      assert.equal(next.control.intent, undefined); assert.equal(next.forward, false);
      assert.ok(requests[1].at - requests[0].at >= 450, 'serial waits for actual native move completion');
    } else {
      assert.equal(next.control.workCompleted, false); assert.ok(next.control.current);
      assert.equal(next.forward, true, 'parallel reasoning sees the same native move still actuating');
      assert.equal(f.record.actionController?.signal.aborted, false);
    }
  });
}

test('serial cancellation revokes its own awaited body version and drains native input', async t => {
  const f = await fixture(t), abort = new AbortController();
  const requests = fakeModel(t, (_request, index) => index === 0 ? { tool: 'body_plan',
    args: { expectedVersion: f.body.snapshot().version, label: '长移动', steps: [{ type: 'move', controls: ['forward'], ms: 4000 }] } } : undefined);
  const task = runTask(f.world, f.record.name, '移动。', f.root, { bodyExecution: 'serial', signal: abort.signal });
  await until(() => !!f.record.actionController && f.controls.forward, 'serial owns a native body action');
  const owner = f.record.actionController!, version = f.body.snapshot().version;
  abort.abort(); const result = await task;
  assert.equal(result.status, 'cancelled'); assert.equal(owner.signal.aborted, true);
  assert.equal(f.body.snapshot().version, version + 1); assert.equal(f.body.snapshot().intent, undefined);
  assert.equal(f.record.actionController, undefined); assert.equal(f.controls.forward, false);
  assert.equal(requests.length, 1);
});

test('serial gives a real skill failure back to the brain and permits a corrected plan', async t => {
  const f = await fixture(t);
  let failed: any;
  const requests = fakeModel(t, (request, index) => {
    if (index === 0) return { tool: 'body_plan', args: {
      expectedVersion: f.body.snapshot().version, label: '不可达跳跃及后续移动',
      steps: [{ type: 'jump_to', x: .5, y: 66, z: .5 }, { type: 'move', controls: ['forward'], ms: 4000 }],
      ttlMs: 10000,
    } };
    if (index === 1) {
      failed = f.body.snapshot();
      assert.equal(failed.intent, undefined, 'failed serial work is revoked before reasoning resumes');
      assert.equal(failed.current, undefined, 'failed native work has drained');
      assert.equal(f.controls.forward ?? false, false, 'later plan steps must not run after failure');
      assert.match(JSON.stringify(request.messages), /jump_out_of_range/u, 'the actual failure reaches the model');
      return { tool: 'body_plan', args: { expectedVersion: failed.version, label: '改为短移动',
        steps: [{ type: 'move', controls: ['left'], ms: 100 }], ttlMs: 10000 } };
    }
  });
  let done = false;
  const task = runTask(f.world, f.record.name, '遇到不可达动作后改变计划。', f.root,
    { bodyExecution: 'serial' }).then(result => { done = true; return result; });
  try {
    await until(() => done, 'failure returns for replanning rather than waiting for the ten second lease', 4000);
    assert.equal((await task).status, 'completed'); assert.equal(requests.length, 3);
    assert.equal(failed.recentReceipts.at(-1).status, 'failed');
    assert.equal(f.body.snapshot().workCompleted, true);
    assert.equal(f.body.snapshot().recentReceipts.at(-1)?.result.action.type, 'move');
    assert.equal(f.controls.left, false);
  } finally { await f.world.stop(f.record); await task; }
});

test('serial ignores a failed receipt from an older body intent', async t => {
  const f = await fixture(t);
  f.plan([{ type: 'jump_to', x: .5, y: 66, z: .5 }]);
  await until(() => f.body.snapshot().recentReceipts.some(row => row.status === 'failed'), 'old failure is recorded');
  const oldVersion = f.body.snapshot().version;
  const requests = fakeModel(t, (_request, index) => index === 0 ? { tool: 'body_plan', args: {
    expectedVersion: f.body.snapshot().version, label: '新的合法移动',
    steps: [{ type: 'move', controls: ['forward'], ms: 200 }], ttlMs: 10000,
  } } : undefined);
  const result = await runTask(f.world, f.record.name, '执行新的合法移动。', f.root, { bodyExecution: 'serial' });
  assert.equal(result.status, 'completed'); assert.equal(requests.length, 2);
  assert.ok(requests[1].at - requests[0].at >= 180, 'old failure cannot prematurely finish the new wait');
  assert.equal(f.body.snapshot().workCompleted, true);
  assert.equal(f.body.snapshot().recentReceipts.at(-1)?.intentVersion, oldVersion + 1);
});

test('cancelling an obsolete serial wait does not revoke or wait for an external newer body plan', async t => {
  const f = await fixture(t), abort = new AbortController();
  fakeModel(t, (_request, index) => index === 0 ? { tool: 'body_plan',
    args: { expectedVersion: f.body.snapshot().version, label: '旧长移动', steps: [{ type: 'move', controls: ['forward'], ms: 4000 }] } } : undefined);
  let settled = false;
  const task = runTask(f.world, f.record.name, '移动。', f.root, { bodyExecution: 'serial', signal: abort.signal })
    .then(result => { settled = true; return result; });
  await until(() => !!f.record.actionController && f.controls.forward, 'serial owns its original native action');
  const oldOwner = f.record.actionController;
  const oldDrained = f.body.controller.whenIdle();
  f.plan([{ type: 'move', controls: ['left'], ms: 4000 }]);
  await oldDrained; f.body.controller.tick();
  // Resolve native ownership before the serial wait's next 50 ms poll. This
  // controls the race without replacing the real skill executor or LLM port.
  for (let i = 0; i < 16; i += 1) await Promise.resolve();
  assert.ok(f.record.actionController && f.record.actionController !== oldOwner && f.controls.left,
    'external replacement has acquired the body before the old serial wait resumes');
  const newOwner = f.record.actionController!, newVersion = f.body.snapshot().version;
  abort.abort();
  try {
    await until(() => settled, 'cancelled serial brain must not wait for unrelated newer work to finish', 500);
    assert.equal((await task).status, 'cancelled');
    assert.equal(f.body.snapshot().version, newVersion); assert.equal(newOwner.signal.aborted, false);
    assert.equal(f.record.actionController, newOwner); assert.equal(f.controls.left, true);
  } finally {
    // Also unwind a failed regression without retaining an asynchronous turn.
    f.body.cancel(f.body.snapshot().version); await task;
  }
});

for (const mode of ['parallel', 'dual'] as const) {
  test(`${mode} delays every model request while the same body continues, and reports each real model call`, async t => {
    const f = await fixture(t);
    f.plan([{ type: 'move', controls: ['forward'], ms: 4000 }]);
    await until(() => !!f.record.actionController && f.controls.forward, 'independent native body starts first');
    const owner = f.record.actionController!, starts: any[] = [], ends: any[] = [];
    const requestSnapshots: any[] = [];
    const requests = fakeModel(t, (_request, index) => {
      requestSnapshots.push({ owner: f.record.actionController, forward: f.controls.forward, control: f.body.snapshot() });
      return index === 0 ? { tool: 'body_status', args: {} } : undefined;
    });
    const tickCount = f.body.snapshot().metrics.ticks, delayMs = 100;
    const result = await runTask(f.world, f.record.name, '检查身体状态后结束思考。', f.root, {
      bodyExecution: mode, modelDelayMs: delayMs,
      onModelCall: event => (event.type === 'model-start' ? starts : ends).push(event),
    });
    assert.equal(result.status, 'completed'); assert.equal(requests.length, 2);
    assert.equal(starts.length, requests.length); assert.equal(ends.length, requests.length);
    assert.equal(new Set(starts.map(event => event.channel)).size, 2);
    for (const [index, request] of requests.entries()) {
      assert.ok(request.at - starts[index].at >= delayMs - 10, `request ${index + 1} receives its own injected delay`);
      const end = ends.find(event => event.channel === starts[index].channel);
      assert.ok(end); assert.ok(end.at >= request.at);
      assert.equal(requestSnapshots[index].owner, owner); assert.equal(requestSnapshots[index].forward, true);
      assert.equal(requestSnapshots[index].control.current?.phase, 'running');
    }
    assert.ok(f.body.snapshot().metrics.ticks - tickCount >= 3, 'local control ticks continue during both model delays');
    assert.equal(owner.signal.aborted, false); assert.equal(f.controls.forward, true);
  });
}

test('model callbacks count both tool and final requests even without latency injection', async t => {
  const f = await fixture(t), events: any[] = [];
  const requests = fakeModel(t, (_request, index) => index === 0 ? { tool: 'body_status', args: {} } : undefined);
  const result = await runTask(f.world, f.record.name, '检查身体状态。', f.root,
    { onModelCall: event => events.push(event), bodyExecution: 'dual' });
  assert.equal(result.status, 'completed'); assert.equal(requests.length, 2);
  const starts = events.filter(event => event.type === 'model-start');
  const ends = events.filter(event => event.type === 'model-end');
  assert.equal(starts.length, 2); assert.equal(ends.length, 2);
  assert.deepEqual(ends.map(event => event.channel).sort(), starts.map(event => event.channel).sort());
});

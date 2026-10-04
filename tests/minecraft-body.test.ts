import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { MinecraftBody, validateBodyAction, bodyActionTimeoutMs } from '../adapters/minecraft/src/minecraft-body.ts';
import { MinecraftWorld, type BotRecord } from '../adapters/minecraft/src/world.ts';
import type { BodyExecutionResult } from '../packages/bridge/src/body-controller.ts';
import { CONTINUOUS_SKILL_LIMITS } from '../adapters/minecraft/src/continuous-skills.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 16; i += 1) await Promise.resolve(); }
function fixture() {
  const bot: any = new EventEmitter(), metrics: any[] = [], events: any[] = [], messages: string[] = [];
  const controls: Record<string, boolean> = {};
  let inventory: any[] = [];
  bot.entity = { id: 1, position: new Vec3(0, 64, 0), eyeHeight: 1.62, width: .6, height: 1.8,
    onGround: true, isInWater: false, isInLava: false, velocity: new Vec3(0, 0, 0) };
  bot._client = new EventEmitter(); bot._client.write = () => {};
  bot.entities = {}; bot.players = {}; bot.health = 20; bot.food = 20; bot.version = '1.21.4';
  bot.game = { dimension: 'overworld', gameMode: 'survival' };
  bot.registry = { itemsByName: { oak_log: { id: 1, name: 'oak_log' } }, foodsByName: { bread: { foodPoints: 5 }, golden_apple: { foodPoints: 4 } } };
  bot.inventory = { slots: [], items: () => inventory };
  bot.world = { raycast: () => null };
  bot.blockAt = (position: Vec3) => ({ name: position.y < 64 ? 'stone' : 'air', boundingBox: position.y < 64 ? 'block' : 'empty', position });
  bot.setControlState = (key: string, value: boolean) => { controls[key] = value; };
  bot.getControlState = (key: string) => controls[key] ?? false;
  bot.clearControlStates = () => { for (const key of Object.keys(controls)) bot.setControlState(key, false); };
  bot.stopDigging = () => {}; bot.deactivateItem = () => {}; bot.findBlocks = () => [];
  bot.chat = (message: string) => messages.push(message); bot.recipesAll = () => [];
  bot.canSeeBlock = () => true;
  const world = new MinecraftWorld({ host: '127.0.0.1', port: 25565, version: '1.21.4', logDirectory: '', dualLoop: true });
  world.event = (_record, type, data) => { const event = { type, ...data }; events.push(event); return event; };
  const calls: { action: any; signal: AbortSignal; pending: ReturnType<typeof deferred<BodyExecutionResult>> }[] = [];
  world.executeOwned = (_name, action, signal) => { const pending = deferred<BodyExecutionResult>(); calls.push({ action, signal, pending }); return pending.promise as any; };
  const record: BotRecord = { name: 'Tester', persona: '', bot, ready: true, events: [] };
  world.bots.set(record.name, record);
  const body = new MinecraftBody(world, record, event => metrics.push(event)); record.body = body;
  const finish = async (index: number, details: any, status = 'completed') => {
    const call = calls[index];
    call.pending.resolve({ status: status as BodyExecutionResult['status'], action: call.action, details });
    await flush();
  };
  return { bot, body, record, world, calls, controls, metrics, events, messages, finish,
    inventory(items: any[]) { inventory = items; bot.inventory.slots = items; },
    enemy(name = 'zombie', id = 9) { const enemy = { id, name, position: new Vec3(2, 64, 0), width: .6, height: 1.8, health: 20 }; bot.entities[id] = enemy; return enemy; },
    async submit(steps: any[], extra: any = {}, resume = false) {
      const result = body.submit({ expectedVersion: body.snapshot().version, steps, ...extra }, resume);
      await flush(); return result;
    },
    async clean() {
      const done = body.dispose(); for (const call of calls) call.pending.resolve({ status: 'cancelled', action: call.action });
      await done;
    },
  };
}

test('injury feeding uses safe food at hunger 17 without inventing consumption', async t => {
  const f = fixture(); t.after(() => f.clean());
  f.bot.health = 8; f.bot.food = 17; f.inventory([{ name: 'bread', count: 2 }]);
  await f.submit([], { reactions: ['eat'] });
  assert.equal(f.calls[0]?.action.type, 'eat');
  assert.equal(f.bot.food, 17); assert.equal(f.bot.health, 8);
});

test('injury feeding respects disabled policy, full hunger and unsafe food', async t => {
  for (const [health, food, item, policy] of [[20, 17, 'bread', {}], [8, 20, 'bread', {}],
    [8, 17, 'rotten_flesh', {}], [8, 17, 'bread', { healBelow: 0 }]] as const) {
    const f = fixture(); t.after(() => f.clean());
    f.bot.health = health; f.bot.food = food; f.inventory([{ name: item, count: 2 }]);
    await f.submit([], { reactions: ['eat'], policy });
    assert.equal(f.calls.length, 0);
  }
});

test('defense keeps a valid target when a second enemy becomes closer', async t => {
  const f = fixture(); t.after(() => f.clean());
  f.enemy(); await f.submit([], { reactions: ['defend', 'flee'] });
  const second = f.enemy('zombie', 10); second.position = new Vec3(1, 64, 0);
  const now = Date.now() + 300; t.mock.method(Date, 'now', () => now);
  f.body.controller.tick(); await flush();
  assert.equal(f.calls[0].signal.aborted, false); assert.equal(f.calls.length, 1);
});

for (const code of ['retreat_blocked', 'no_retreat_direction']) test(`blocked retreat ${code} immediately permits bounded hold defense`, async t => {
  const f = fixture(); t.after(() => f.clean());
  f.bot.health = 4; f.enemy(); await f.submit([], { reactions: ['flee', 'defend'] });
  assert.equal(f.calls[0].action.type, 'retreat');
  const origin = f.calls[0].action.origin;
  await f.finish(0, { stoppedReason: code }, 'failed');
  f.body.controller.tick(); await flush();
  assert.equal(f.calls[1]?.action.type, 'combat'); assert.equal(f.calls[1].action.stance, 'hold');
  assert.deepEqual(f.calls[1].action.origin, origin);
  assert.equal(f.events.filter(e => e.type === 'goal-blocked').length, 1);
});

test('blocked retreat cannot create an unauthorized defense', async t => {
  const f = fixture(); t.after(() => f.clean());
  f.bot.health = 4; f.enemy(); await f.submit([], { reactions: ['flee'] });
  await f.finish(0, { stoppedReason: 'retreat_blocked' }, 'failed');
  f.body.controller.tick(); await flush();
  assert.equal(f.calls.length, 1);
});

test('injury meal does not interrupt an authorized nearby fight', async t => {
  const f = fixture(); t.after(() => f.clean()); f.bot.health = 8; f.bot.food = 17;
  f.inventory([{ name: 'bread', count: 2 }]); f.enemy();
  await f.submit([], { reactions: ['eat', 'defend'] });
  assert.equal(f.calls[0].action.type, 'combat');
});

test('a new creeper overrides retained zombie defense and cancellation drains first', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = fixture(); t.after(() => f.clean()); f.enemy();
  await f.submit([], { reactions: ['defend', 'flee'] });
  f.enemy('creeper', 10).position = new Vec3(4, 64, 0); now += 300;
  f.body.controller.tick(); await flush();
  assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.calls.length, 1);
  await f.finish(0, {}, 'cancelled'); f.body.controller.tick(); await flush();
  assert.equal(f.calls[1].action.type, 'retreat'); assert.equal(f.calls[1].action.entityId, 10);
});

test('combat stance validates and preserves explicit hold authorization', () => {
  assert.equal(validateBodyAction({ type: 'combat', entityId: 9, stance: 'hold' }).stance, 'hold');
  assert.throws(() => validateBodyAction({ type: 'combat', entityId: 9, stance: 'teleport' }), /姿态/u);
});

test('a rejected work route waits for a new decision across backoff and identical renewal', async t => {
  const f = fixture(); t.after(() => f.clean());
  const steps = [{ type: 'look', x: 1, y: 65, z: 0 }, { type: 'jump_to', x: 2, y: 65, z: 0 }, { type: 'wait', ms: 100 }];
  await f.submit(steps, { reactions: ['surface'] });
  await f.finish(0, {}); f.body.controller.tick(); await flush();
  await f.finish(1, { stoppedReason: 'jump_arc_blocked' }, 'failed');
  const blocked = f.body.snapshot();
  assert.equal(blocked.goalStatus, 'blocked'); assert.equal(blocked.workCompleted, false);
  assert.deepEqual(blocked.completedSteps, [0]); assert.equal(blocked.replanRequired?.stepIndex, 1);
  assert.equal(blocked.replanRequired?.code, 'jump_arc_blocked');
  assert.equal(f.events.filter(e => e.type === 'goal-blocked').length, 1);
  let now = Date.now(); (f.body.controller as any).now = () => now;
  for (let i = 0; i < 20; i++) { now += 1000; f.body.controller.tick(); await flush(); }
  assert.equal(f.calls.length, 2, 'Neither the rejected step nor later steps run without correction.');
  const renewed = await f.submit(steps, { reactions: ['surface'] });
  assert.equal(renewed.unchanged, true); assert.deepEqual(f.body.snapshot().replanRequired, blocked.replanRequired);
  assert.deepEqual(f.body.snapshot().completedSteps, [0]); assert.equal(f.calls.length, 2);
  assert.equal(f.events.filter(e => e.type === 'goal-blocked').length, 1);
});

test('a suspended work step retains authorized reflexes and is not cleared by their receipts', async t => {
  const f = fixture(); t.after(() => f.clean());
  await f.submit([{ type: 'jump_to', x: 2, y: 65, z: 0 }], { reactions: ['surface'] });
  await f.finish(0, { stoppedReason: 'jump_arc_blocked' }, 'failed');
  const suspended = f.body.snapshot().replanRequired;
  f.bot.entity.isInWater = true; f.body.controller.tick(); await flush();
  assert.equal(f.calls[1].action.type, 'surface');
  await f.finish(1, { surfaceReached: true });
  f.bot.entity.isInWater = false; f.body.controller.tick(); await flush();
  assert.deepEqual(f.body.snapshot().replanRequired, suspended);
  assert.equal(f.body.snapshot().goalStatus, 'blocked'); assert.equal(f.calls.length, 2);
  assert.deepEqual(f.body.snapshot().completedSteps, []);
});

test('new explicit work clears the suspension, while an old version cannot clear it', async t => {
  const f = fixture(); t.after(() => f.clean());
  const steps = [{ type: 'jump_to', x: 2, y: 65, z: 0 }];
  await f.submit(steps); const oldVersion = f.body.snapshot().version;
  await f.finish(0, { stoppedReason: 'landing_unavailable' }, 'failed');
  const rejected = f.body.submit({ expectedVersion: oldVersion - 1, steps, restart: true });
  assert.equal(rejected.accepted, false); assert.ok(f.body.snapshot().replanRequired);
  const restarted = await f.submit(steps, { restart: true });
  assert.equal(restarted.accepted, true); assert.ok(f.body.snapshot().version > oldVersion);
  assert.equal(f.body.snapshot().replanRequired, undefined); assert.equal(f.calls.length, 2);
  assert.equal(f.body.snapshot().goalStatus, 'working');
});

test('superseded or cancelled work cannot suspend the replacement plan', async t => {
  const f = fixture(); t.after(() => f.clean());
  await f.submit([{ type: 'jump_to', x: 2, y: 65, z: 0 }]);
  await f.submit([{ type: 'wait', ms: 100 }]);
  await f.finish(0, { stoppedReason: 'jump_arc_blocked' }, 'failed');
  f.body.controller.tick(); await flush();
  assert.equal(f.body.snapshot().replanRequired, undefined);
  assert.equal(f.calls[1].action.type, 'wait');
  assert.equal(f.events.filter(e => e.type === 'goal-blocked').length, 0);
});

for (const [label, details, expected] of [
  ['visible target overlap', { movement: { reasonCode: 'target_blocked' } }, 'target_blocked'],
  ['bounded navigation search', { navigation: { stoppedReason: 'no_visible_route' } }, 'no_visible_route'],
  ['approach exhausted', { approach: { stoppedReason: 'no_path' } }, 'no_path'],
  ['travel exhausted', { travel: { stoppedReason: 'movement_budget' } }, 'movement_budget'],
  ['temporary landing after earlier obstruction', { navigation: { stoppedReason: 'not_grounded' }, movement: { reasonCode: 'step_blocked' } }, undefined],
  ['cancelled after earlier obstruction', { navigation: { stoppedReason: 'cancelled' }, movement: { reasonCode: 'step_blocked' } }, undefined],
  ['unknown failure', { stoppedReason: 'future_transient_error' }, undefined],
  ['wrapped unknown terrain', { navigation: { stoppedReason: 'native_rejected' }, movement: { reasonCode: 'unknown_cell' } }, undefined],
  ['wrapped unsettled landing with historical obstacle', { navigation: { stoppedReason: 'native_rejected', lastLegFailure: { movement: { reasonCode: 'landing_unsettled' } } }, movement: { reasonCode: 'step_blocked' } }, undefined],
] as const) test(`work recovery classifies the current stop reason: ${label}`, async t => {
  const f = fixture(); t.after(() => f.clean());
  await f.submit([{ type: 'goto', x: 2, y: 65, z: 0 }]);
  await f.finish(0, details, 'failed');
  assert.equal(f.body.snapshot().replanRequired?.code, expected);
  let now = Date.now() + 2000; (f.body.controller as any).now = () => now;
  f.body.controller.tick(); await flush();
  assert.equal(f.calls.length, expected ? 1 : 2);
});

test('planner compare-and-swap versions reject old replacement, cancellation and pre-stop resume', async t => {
  const f = fixture(); t.after(() => f.clean());
  assert.equal((await f.submit([{ type: 'wait', ms: 500 }])).accepted, true);
  const beforeStop = f.body.snapshot().version;
  const stopping = f.body.stop();
  assert.equal(f.body.submit({ expectedVersion: beforeStop, steps: [] }, true).accepted, false);
  assert.equal(f.body.cancel(beforeStop).accepted, false);
  await f.finish(0, {}, 'cancelled'); await stopping;
  assert.equal(f.body.submit({ expectedVersion: f.body.snapshot().version, steps: [] }).accepted, false);
  assert.equal((await f.submit([], {}, true)).accepted, true);
});

test('replacement waits for original body to drain and stale step results do not finish the new plan', async t => {
  const f = fixture(); t.after(() => f.clean());
  await f.submit([{ type: 'wait', ms: 500 }]);
  await f.submit([{ type: 'wait', ms: 700 }]);
  assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.calls.length, 1);
  await f.finish(0, {});
  assert.deepEqual(f.body.snapshot().completedSteps, []);
  f.body.controller.tick(); await flush();
  assert.equal(f.calls[1].action.ms, 700);
});

test('reactive skills require brain authorization even when a hazard is locally visible', async t => {
  const f = fixture(); t.after(() => f.clean()); f.enemy(); f.bot.entity.isInWater = true;
  await f.submit([{ type: 'wait', ms: 500 }]);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].action.type, 'wait');
});

test('a waiting authorized policy can surface while no model turn is running', async t => {
  const f = fixture(); t.after(() => f.clean()); f.bot.entity.isInWater = true;
  await f.submit([], { reactions: ['surface'] });
  assert.equal(f.record.task, undefined); assert.equal(f.calls[0].action.type, 'surface');
  assert.equal(f.body.snapshot().current?.skill.reaction, 'surface');
});

test('combat time slices are progress, not proof that the target was defeated', async t => {
  const f = fixture(); t.after(() => f.clean()); f.enemy();
  await f.submit([{ type: 'combat', entityId: 9, durationMs: 1000 }]);
  await f.finish(0, { stoppedReason: 'duration_elapsed', healthAfter: 12, targetLoaded: true });
  f.body.controller.tick(); await flush();
  assert.deepEqual(f.body.snapshot().completedSteps, []);
  assert.ok(f.body.snapshot().intent); assert.equal(f.calls.length, 2);
});

test('entity unload is not a confirmed combat victory', async t => {
  const f = fixture(); t.after(() => f.clean()); f.enemy();
  await f.submit([{ type: 'combat', entityId: 9 }]);
  delete f.bot.entities[9];
  await f.finish(0, { stoppedReason: 'target_unavailable', targetLoaded: false });
  f.body.controller.tick(); await flush();
  assert.deepEqual(f.body.snapshot().completedSteps, []); assert.ok(f.body.snapshot().intent);
});

test('observed target death completes a planned combat step', async t => {
  const f = fixture(); t.after(() => f.clean()); const enemy = f.enemy();
  await f.submit([{ type: 'combat', entityId: enemy.id }]); enemy.health = 0;
  await f.finish(0, { stoppedReason: 'target_dead_observed', healthAfter: 0 });
  f.body.controller.tick(); await flush();
  assert.deepEqual(f.body.snapshot().completedSteps, [0]); assert.equal(f.body.snapshot().intent, undefined);
});

test('a shore goal needs confirmed arrival, not merely elapsed swimming time or breathing', async t => {
  const f = fixture(); t.after(() => f.clean());
  await f.submit([{ type: 'surface', durationMs: 1000, target: { x: 3, y: 64, z: 0 } }]);
  await f.finish(0, { stoppedReason: 'duration_elapsed', shoreReached: false, dryGround: false, surfaceReached: true });
  f.body.controller.tick(); await flush();
  assert.deepEqual(f.body.snapshot().completedSteps, []); assert.equal(f.calls.length, 2);
  await f.finish(1, { stoppedReason: 'dry_ground', shoreReached: true, dryGround: true });
  f.body.controller.tick(); await flush();
  assert.equal(f.body.snapshot().intent, undefined);
});

test('brain pursuit bounds reach both planned and reactive combat executors', async t => {
  const f = fixture(); t.after(() => f.clean()); f.enemy();
  await f.submit([{ type: 'combat', entityId: 9 }], { policy: { chaseRange: 4 } });
  assert.equal(f.calls[0].action.maxDistance, 4);
  await f.submit([], { policy: { chaseRange: 5 }, reactions: ['defend'] });
  await f.finish(0, {}, 'cancelled'); f.body.controller.tick(); await flush();
  assert.equal(f.calls[1].action.maxDistance, 5);
});

for (const reaction of ['surface', 'defend', 'flee']) {
  test(`${reaction} response latency uses a real control input, not skill dispatch`, async t => {
    const f = fixture(); t.after(() => f.clean());
    if (reaction === 'surface') f.bot.entity.isInWater = true;
    else { f.enemy(reaction === 'flee' ? 'creeper' : 'zombie'); }
    await f.submit([], { reactions: [reaction] });
    assert.equal(f.metrics.filter(event => event.type === 'hazard-observed').length, 1);
    assert.equal(f.metrics.filter(event => event.type === 'reaction').length, 0);
    // A chat packet or cleanup release is not a response to a danger.
    f.bot._client.write('chat_command', {}); f.bot.setControlState('forward', false);
    assert.equal(f.metrics.filter(event => event.type === 'reaction').length, 0);
    if (reaction === 'defend') f.bot._client.write('use_entity', { target: 9, mouse: 1 });
    else f.bot.setControlState(reaction === 'surface' ? 'jump' : 'forward', true);
    assert.equal(f.metrics.filter(event => event.type === 'reaction').length, 1);
    f.bot.setControlState('forward', true);
    assert.equal(f.metrics.filter(event => event.type === 'reaction').length, 1, 'One hazard occurrence yields one reaction sample.');
  });
}

test('safe registry foods trigger eating even when outside a short hand-written whitelist', async t => {
  const f = fixture(); t.after(() => f.clean()); f.bot.food = 8;
  f.inventory([{ name: 'golden_apple', count: 1 }]);
  await f.submit([], { reactions: ['eat'] });
  assert.equal(f.calls[0]?.action.type, 'eat');
});

test('gathering cannot finish solely because the target block broke without entering inventory', async t => {
  const f = fixture(); t.after(() => f.clean());
  await f.submit([{ type: 'gather', block: 'oak_log', count: 1 }]);
  await f.finish(0, { minedBlocks: 1, inventoryDelta: [], pickupConfirmed: false });
  f.body.controller.tick(); await flush();
  assert.deepEqual(f.body.snapshot().completedSteps, []); assert.ok(f.body.snapshot().intent);
  assert.equal(f.calls.filter(call => call.action.type === 'gather').length, 1, 'Do not mine a second block to hide an uncollected first block.');
});

test('gather completion uses newly obtained inventory rather than preexisting stock', async t => {
  const f = fixture(); t.after(() => f.clean()); f.inventory([{ name: 'oak_log', count: 10 }]);
  await f.submit([{ type: 'gather', block: 'oak_log', count: 1 }]);
  await f.finish(0, { minedBlocks: 1, inventoryDelta: [], pickupConfirmed: false });
  f.body.controller.tick(); await flush();
  assert.deepEqual(f.body.snapshot().completedSteps, []);
  f.inventory([{ name: 'oak_log', count: 11 }]); f.body.controller.tick(); await flush();
  assert.deepEqual(f.body.snapshot().completedSteps, [0]);
});

test('chat and read-only queries run alongside body work without cancelling it or clearing input', async t => {
  const f = fixture(); t.after(() => f.clean());
  await f.submit([{ type: 'wait', ms: 1000 }]);
  const owned = new AbortController(); f.record.actionController = owned;
  f.bot.setControlState('forward', true);
  for (const request of [{ type: 'say', message: '我在采集。' }, { type: 'broadcast', message: '继续工作。' },
    { type: 'scan', kind: 'entities' }, { type: 'recipes', item: 'oak_log' }]) {
    const result = await f.world.execute(f.record.name, request);
    assert.equal(result.status, 'completed'); assert.equal(owned.signal.aborted, false);
    assert.equal(f.controls.forward, true); assert.equal(f.calls[0].signal.aborted, false);
  }
  assert.equal(f.messages.length, 2);
});

test('ordinary action entry cannot bypass the body owner for direct movement', async t => {
  const f = fixture(); t.after(() => f.clean());
  await f.submit([{ type: 'wait', ms: 1000 }]);
  await assert.rejects(f.world.execute(f.record.name, { type: 'move', controls: ['forward'], ms: 100 }), /body_plan/);
  assert.equal(f.calls[0].signal.aborted, false);
});

test('an old task-scoped stop action cannot bypass versioned brain cancellation', async t => {
  const f = fixture(); t.after(() => f.clean());
  await f.submit([{ type: 'wait', ms: 1000 }]);
  const task = { id: 'old-brain', controller: new AbortController() }; f.record.task = task;
  await assert.rejects(f.world.execute(f.record.name, { type: 'stop' }, task.id), /cancel_body/);
  assert.equal(f.calls[0].signal.aborted, false);
  assert.ok(f.body.snapshot().intent);
});

test('operator stop revokes independent body and brain together and waits for actual body drain', async t => {
  const f = fixture(); t.after(() => f.clean());
  await f.submit([{ type: 'wait', ms: 1000 }]);
  const task = { id: 'current-brain', controller: new AbortController() }; f.record.task = task;
  let returned = false;
  const stopping = f.world.execute(f.record.name, { type: 'stop' }).then(result => { returned = true; return result; });
  await flush();
  assert.equal(f.calls[0].signal.aborted, true); assert.equal(task.controller.signal.aborted, true);
  assert.equal(f.record.operatorStopped, true); assert.equal(f.body.snapshot().stopped, true);
  assert.equal(returned, false);
  await f.finish(0, {}, 'cancelled'); await stopping;
  assert.equal(returned, true);
});

test('invalid pursuit limits never silently widen into executor defaults', () => {
  for (const maxDistance of [-1, Infinity, '4']) assert.throws(() => validateBodyAction({ type: 'combat', entityId: 9, maxDistance }));
  assert.equal(validateBodyAction({ type: 'combat', entityId: 9, maxDistance: 4 }).maxDistance, 4);
});

test('pickup range accepts the gather maximum without widening combat or retreat', () => {
  const origin = { x: 20, y: 64, z: 0 };
  const pickup = validateBodyAction({ type: 'pickup', entityId: 50, origin, maxDistance: 32 });
  assert.equal(pickup.maxDistance, 32); assert.deepEqual(pickup.origin, origin);
  assert.equal(pickup.durationMs, 8000);
  for (const maxDistance of [-1, 32.01, Infinity, '32'])
    assert.throws(() => validateBodyAction({ type: 'pickup', entityId: 50, maxDistance }));
  for (const type of ['pickup', 'combat', 'retreat']) {
    assert.equal(validateBodyAction({ type, entityId: 50 }).maxDistance, 12);
    assert.equal(validateBodyAction({ type, entityId: 50, maxDistance: 0 }).maxDistance, 0);
  }
  for (const type of ['combat', 'retreat']) {
    assert.equal(validateBodyAction({ type, entityId: 50, maxDistance: 24 }).maxDistance, 24);
    assert.throws(() => validateBodyAction({ type, entityId: 50, maxDistance: 25 }));
  }
});

test('accepted retreat and jump durations match the actual continuous executor limits', () => {
  const retreat = validateBodyAction({ type: 'retreat', entityId: 9 });
  const jump = validateBodyAction({ type: 'jump_to', x: 2, y: 64, z: 0 });
  assert.ok(retreat.durationMs <= CONTINUOUS_SKILL_LIMITS.retreatMs);
  assert.ok(jump.durationMs <= CONTINUOUS_SKILL_LIMITS.jumpMs);
  assert.throws(() => validateBodyAction({ ...retreat, durationMs: CONTINUOUS_SKILL_LIMITS.retreatMs + 1 }));
  assert.throws(() => validateBodyAction({ ...jump, durationMs: CONTINUOUS_SKILL_LIMITS.jumpMs + 1 }));
  assert.equal(validateBodyAction({ ...retreat, durationMs: CONTINUOUS_SKILL_LIMITS.retreatMs }).durationMs, CONTINUOUS_SKILL_LIMITS.retreatMs);
});

test('continuous combat slices keep the step anchor instead of renewing pursuit distance from current position', async t => {
  const f = fixture(); t.after(() => f.clean()); f.enemy();
  await f.submit([{ type: 'combat', entityId: 9 }], { policy: { chaseRange: 4 } });
  assert.deepEqual({ ...f.calls[0].action.origin }, { x: 0, y: 64, z: 0 });
  f.bot.entity.position = new Vec3(3, 64, 0);
  await f.finish(0, { stoppedReason: 'duration_elapsed', healthAfter: 12 });
  f.body.controller.tick(); await flush();
  assert.deepEqual({ ...f.calls[1].action.origin }, { x: 0, y: 64, z: 0 });
  assert.equal(f.calls[1].action.maxDistance, 4);
  // A newly authorized plan may deliberately select a new local movement origin.
  await f.submit([{ type: 'combat', entityId: 9 }], { policy: { chaseRange: 4 }, restart: true });
  await f.finish(1, {}, 'cancelled'); f.body.controller.tick(); await flush();
  assert.deepEqual({ ...f.calls[2].action.origin }, { x: 3, y: 64, z: 0 });
});

for (const type of ['combat', 'retreat']) {
  test(`planned ${type} anchors at its own first start after earlier travel`, async t => {
    const f = fixture(); t.after(() => f.clean()); const enemy = f.enemy();
    await f.submit([{ type: 'travel', x: 20, z: 0 }, { type, entityId: 9, maxDistance: 8 }], { policy: { chaseRange: 4 } });
    f.bot.entity.position = new Vec3(20, 64, 0); enemy.position = new Vec3(22, 64, 0);
    await f.finish(0, { reached: true }); f.body.controller.tick(); await flush();
    assert.equal(f.calls[1].action.type, type); assert.equal(f.calls[1].action.maxDistance, 4);
    assert.deepEqual(f.calls[1].action.origin, { x: 20, y: 64, z: 0 });
  });
}

for (const reaction of ['defend', 'flee']) {
  test(`${reaction} establishes a local encounter after travelling beyond the original plan radius`, async t => {
    let now = 1000; t.mock.method(Date, 'now', () => now);
    const f = fixture(); t.after(() => f.clean());
    await f.submit([{ type: 'travel', x: 20, z: 0 }], { reactions: [reaction], policy: { chaseRange: 4 } });
    f.bot.entity.position = new Vec3(20, 64, 0);
    await f.finish(0, { reached: true });
    const enemy = f.enemy(reaction === 'flee' ? 'creeper' : 'zombie'); enemy.position = new Vec3(22, 64, 0);
    now += 250; f.body.controller.tick(); await flush();
    assert.equal(f.calls[1].action.type, reaction === 'flee' ? 'retreat' : 'combat');
    assert.deepEqual(f.calls[1].action.origin, { x: 20, y: 64, z: 0 });
    assert.equal(f.calls[1].action.maxDistance, 4);
  });
}

test('a planned combat origin is committed after prior reactive movement actually drains', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const f = fixture(); t.after(() => f.clean()); f.enemy('creeper', 9);
  f.enemy('zombie', 10).position = new Vec3(22, 64, 0);
  await f.submit([{ type: 'combat', entityId: 10 }], { reactions: ['flee'], policy: { chaseRange: 4 } });
  assert.equal(f.calls[0].action.type, 'retreat');
  delete f.bot.entities[9]; now += 600; f.body.controller.tick(); await flush();
  f.bot.entity.position = new Vec3(10, 64, 0); now += 200; f.body.controller.tick(); await flush();
  assert.equal(f.calls[0].signal.aborted, true, 'Movement must not keep resetting candidate hysteresis.');
  assert.equal(f.calls.length, 1, 'The old reaction still owns the body while draining.');
  f.bot.entity.position = new Vec3(20, 64, 0);
  await f.finish(0, {}, 'cancelled'); f.body.controller.tick(); await flush();
  assert.equal(f.calls[1].action.type, 'combat'); assert.equal(f.calls[1].action.entityId, 10);
  assert.deepEqual(f.calls[1].action.origin, { x: 20, y: 64, z: 0 });
});

test('one encounter keeps its range across targets, reaction switches, slices, renewal, replacement and stop/resume', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const f = fixture(); t.after(() => f.clean()); f.enemy();
  const policy = { reactions: ['defend', 'flee'], policy: { chaseRange: 4 } };
  await f.submit([], policy);
  f.bot.entity.position = new Vec3(3, 64, 0); delete f.bot.entities[9];
  f.enemy('zombie', 10).position = new Vec3(5, 64, 0);
  now += 300; f.body.controller.tick(); now += 200; f.body.controller.tick(); await flush();
  assert.equal(f.calls[0].signal.aborted, true);
  await f.finish(0, {}, 'cancelled'); f.body.controller.tick(); await flush();
  assert.equal(f.calls[1].action.entityId, 10);
  f.bot.health = 4; now += 300; f.body.controller.tick(); await flush();
  await f.finish(1, {}, 'cancelled'); f.body.controller.tick(); await flush();
  assert.equal(f.calls[2].action.type, 'retreat');
  assert.equal((await f.submit([], policy)).unchanged, true);
  assert.equal(f.calls[2].signal.aborted, false);
  f.bot.health = 20; await f.finish(2, { stoppedReason: 'duration_elapsed' }); f.body.controller.tick(); await flush();
  assert.equal(f.calls[3].action.type, 'combat');
  await f.submit([], { ...policy, restart: true });
  await f.finish(3, {}, 'cancelled'); f.body.controller.tick(); await flush();
  const stopped = f.body.stop(); await f.finish(4, {}, 'cancelled'); await stopped;
  f.bot.entity.position = new Vec3(6, 64, 0); f.bot.entities[10].position = new Vec3(8, 64, 0); now += 300;
  await f.submit([], policy, true);
  assert.equal(f.calls.length, 6);
  for (const call of f.calls) {
    assert.deepEqual(call.action.origin, { x: 0, y: 64, z: 0 }); assert.equal(call.action.maxDistance, 4);
  }
});

test('encounter reset needs a fully drained reaction and two seconds of observed safety', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const f = fixture(); t.after(() => f.clean()); f.enemy();
  await f.submit([], { reactions: ['defend'], policy: { chaseRange: 4 } });
  delete f.bot.entities[9]; now += 600; f.body.controller.tick();
  assert.equal(f.calls[0].signal.aborted, true);
  now += 5000; f.body.controller.tick(); await f.finish(0, {}, 'cancelled');
  f.body.controller.tick(); await flush();
  f.bot.entity.position = new Vec3(20, 64, 0);
  now += 1999; f.body.controller.tick();
  f.enemy().position = new Vec3(22, 64, 0); now += 250; f.body.controller.tick(); await flush();
  assert.deepEqual(f.calls[1].action.origin, { x: 0, y: 64, z: 0 }, 'Long drain time is not observed safety.');
  delete f.bot.entities[9]; now += 600; f.body.controller.tick(); await f.finish(1, {}, 'cancelled');
  f.body.controller.tick(); now += 2000; f.body.controller.tick();
  f.bot.entity.position = new Vec3(40, 64, 0); f.enemy().position = new Vec3(42, 64, 0);
  now += 250; f.body.controller.tick(); await flush();
  assert.deepEqual(f.calls[2].action.origin, { x: 40, y: 64, z: 0 });
});

test('a nearby threat just outside the entry radius does not refresh encounter bounds', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const f = fixture(); t.after(() => f.clean()); const enemy = f.enemy();
  await f.submit([], { reactions: ['defend'], policy: { threatRange: 7, chaseRange: 4 } });
  f.bot.entity.position = new Vec3(3, 64, 0); enemy.position = new Vec3(11, 64, 0);
  now += 600; f.body.controller.tick(); await f.finish(0, {}, 'cancelled');
  f.body.controller.tick(); now += 3000; f.body.controller.tick();
  enemy.position = new Vec3(5, 64, 0); now += 250; f.body.controller.tick(); await flush();
  assert.deepEqual(f.calls[1].action.origin, { x: 0, y: 64, z: 0 });
});

for (const lifecycle of ['death', 'respawn', 'spawn', 'dimension', 'zero-health']) {
  test(`${lifecycle} invalidates the old encounter without independently resuming a stopped body`, async t => {
    let now = 1000; t.mock.method(Date, 'now', () => now);
    const f = fixture(); t.after(() => f.clean()); const enemy = f.enemy();
    await f.submit([], { reactions: ['defend'], policy: { chaseRange: 4 } });
    const stopped = f.body.stop(); await f.finish(0, {}, 'cancelled'); await stopped;
    if (lifecycle === 'dimension') { f.bot.game.dimension = 'the_nether'; f.bot.emit('game'); }
    else if (lifecycle === 'zero-health') { f.bot.health = 0; f.bot.emit('health'); }
    else f.bot.emit(lifecycle);
    assert.equal(f.body.snapshot().stopped, true); assert.equal(f.calls.length, 1);
    f.bot.health = 20; f.bot.entity.position = new Vec3(20, 64, 0); enemy.position = new Vec3(22, 64, 0);
    now += 250; await f.submit([], { reactions: ['defend'], policy: { chaseRange: 4 } }, true);
    assert.deepEqual(f.calls[1].action.origin, { x: 20, y: 64, z: 0 });
    await f.clean();
    for (const event of ['death', 'respawn', 'spawn', 'game', 'health']) assert.equal(f.bot.listenerCount(event), 0);
  });
}

test('completed work retains authorized reactions during the same lease and reports completion once', async t => {
  const f = fixture(); t.after(() => f.clean());
  await f.submit([{ type: 'wait', ms: 500 }], { reactions: ['surface'] });
  const version = f.body.snapshot().version, expiresAt = f.body.snapshot().intent!.expiresAt;
  await f.finish(0, {});
  for (let i = 0; i < 20; i++) f.body.controller.tick();
  assert.equal(f.body.snapshot().goalStatus, 'completed'); assert.equal(f.body.snapshot().workCompleted, true);
  assert.equal(f.body.snapshot().intent?.version, version);
  assert.equal(f.body.snapshot().intent?.expiresAt, expiresAt);
  assert.deepEqual(f.body.snapshot().intent?.allowedReactions, ['surface']);
  assert.equal(f.events.filter(event => event.type === 'goal-finished').length, 1);
  assert.equal(f.events.some(event => event.type === 'intent-blocked'), false, 'Authorized watch is not failed work.');
  f.bot.entity.isInWater = true; f.body.controller.tick(); await flush();
  assert.equal(f.calls[1].action.type, 'surface');
  assert.equal(f.body.snapshot().goalStatus, 'completed', 'A reaction does not restart the finished work list.');
  assert.equal(f.events.filter(event => event.type === 'goal-finished').length, 1);
});

test('an empty policy is watching, not a fabricated completed work goal', async t => {
  const f = fixture(); t.after(() => f.clean()); await f.submit([], { reactions: ['surface'] });
  for (let i = 0; i < 10; i++) f.body.controller.tick();
  assert.equal(f.body.snapshot().goalStatus, 'watching'); assert.equal(f.body.snapshot().workCompleted, false);
  assert.equal(f.events.some(event => event.type === 'goal-finished'), false);
});

test('work without reaction authorization completes and clears the intent as before', async t => {
  const f = fixture(); t.after(() => f.clean()); await f.submit([{ type: 'wait', ms: 500 }]);
  await f.finish(0, {}); f.body.controller.tick();
  assert.equal(f.body.snapshot().intent, undefined);
  assert.equal(f.body.snapshot().goalStatus, 'completed'); assert.equal(f.body.snapshot().workCompleted, true);
  assert.equal(f.events.filter(event => event.type === 'goal-finished').length, 1);
  f.bot.entity.isInWater = true; f.body.controller.tick(); await flush();
  assert.equal(f.calls.length, 1);
});

for (const revoke of ['cancel', 'stop', 'expire'] as const) {
  test(`${revoke} removes post-completion reaction authorization without restarting it`, async t => {
    let now = 1000; t.mock.method(Date, 'now', () => now);
    const f = fixture(); t.after(() => f.clean());
    await f.submit([{ type: 'wait', ms: 500 }], { reactions: ['surface'], ttlMs: 1000 });
    await f.finish(0, {}); f.body.controller.tick();
    assert.equal(f.body.snapshot().workCompleted, true);
    if (revoke === 'cancel') f.body.cancel(f.body.snapshot().version);
    else if (revoke === 'stop') await f.body.stop();
    else { now = 2000; f.body.controller.tick(); }
    f.bot.entity.isInWater = true;
    for (let i = 0; i < 10; i++) f.body.controller.tick(); await flush();
    assert.equal(f.body.snapshot().intent, undefined);
    assert.equal(f.body.snapshot().goalStatus, revoke === 'cancel' ? 'cancelled' : revoke === 'stop' ? 'stopped' : 'expired');
    assert.equal(f.body.snapshot().workCompleted, false);
    assert.equal(f.calls.length, 1); assert.equal(f.events.filter(event => event.type === 'goal-finished').length, 1);
  });
}

test('a genuinely new work plan resets completion notification state', async t => {
  const f = fixture(); t.after(() => f.clean());
  await f.submit([{ type: 'wait', ms: 500 }], { reactions: ['surface'] });
  await f.finish(0, {}); f.body.controller.tick();
  await f.submit([{ type: 'wait', ms: 700 }], { reactions: ['surface'] });
  assert.equal(f.body.snapshot().goalStatus, 'working'); assert.equal(f.body.snapshot().workCompleted, false);
  await f.finish(1, {}); f.body.controller.tick();
  assert.equal(f.events.filter(event => event.type === 'goal-finished').length, 2);
});

test('equivalent planning renews the lease without aborting current work, progress or its pursuit anchor', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const f = fixture(); t.after(() => f.clean()); f.enemy();
  const steps = [{ type: 'wait', ms: 500 }, { type: 'combat', entityId: 9 }];
  await f.submit(steps, { reactions: ['eat', 'surface'], policy: { chaseRange: 4 }, ttlMs: 10000 });
  await f.finish(0, {}); f.body.controller.tick(); await flush();
  const before = f.body.snapshot();
  assert.deepEqual(before.completedSteps, [0]); assert.equal(f.calls[1].action.type, 'combat');
  now = 2000; f.bot.entity.position = new Vec3(3, 64, 0);
  const result = await f.submit(steps, { reactions: ['surface', 'eat'], policy: { chaseRange: 4 }, ttlMs: 10000 });
  const after = f.body.snapshot();
  assert.equal(result.accepted, true); assert.equal(result.unchanged, true);
  assert.equal(after.version, before.version); assert.equal(after.intent?.id, before.intent?.id);
  assert.equal(after.intent?.expiresAt, 12000); assert.equal(after.current?.id, before.current?.id);
  assert.deepEqual(after.completedSteps, [0]); assert.deepEqual(after.intent?.goal.anchor, { x: 0, y: 64, z: 0 });
  assert.equal(f.calls[1].signal.aborted, false); assert.equal(f.calls.length, 2);
  assert.equal(after.goalStatus, 'working');
  await f.finish(1, { stoppedReason: 'duration_elapsed', healthAfter: 12 });
  f.body.controller.tick(); await flush();
  assert.deepEqual(f.calls[2].action.origin, { x: 0, y: 64, z: 0 }, 'Renewal cannot extend the pursuit boundary by moving its origin.');
});

test('renewing equivalent completed work preserves completion and only extends the authorized policy watch', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const f = fixture(); t.after(() => f.clean());
  const steps = [{ type: 'wait', ms: 500 }];
  await f.submit(steps, { reactions: ['surface'], ttlMs: 1000 });
  await f.finish(0, {}); f.body.controller.tick();
  const before = f.body.snapshot(); now = 1500;
  const result = await f.submit(steps, { reactions: ['surface'], ttlMs: 2000 });
  assert.equal(result.unchanged, true); assert.equal(f.body.snapshot().version, before.version);
  assert.equal(f.body.snapshot().workCompleted, true); assert.equal(f.body.snapshot().goalStatus, 'completed');
  assert.deepEqual(f.body.snapshot().completedSteps, [0]); assert.equal(f.body.snapshot().intent?.expiresAt, 3500);
  assert.equal(f.calls.length, 1); assert.equal(f.events.filter(event => event.type === 'goal-finished').length, 1);
  now = 2200; f.bot.entity.isInWater = true; f.body.controller.tick(); await flush();
  assert.equal(f.calls[1].action.type, 'surface', 'The renewed watch works after the original lease would have ended.');
  assert.equal(f.calls.filter(call => call.action.type === 'wait').length, 1);
  assert.equal(f.events.filter(event => event.type === 'goal-finished').length, 1);
});

test('explicit restart redoes identical completed work with a new version and completion event', async t => {
  const f = fixture(); t.after(() => f.clean());
  const steps = [{ type: 'wait', ms: 500 }];
  await f.submit(steps, { reactions: ['surface'] }); await f.finish(0, {}); f.body.controller.tick();
  const version = f.body.snapshot().version;
  const result = await f.submit(steps, { reactions: ['surface'], restart: true });
  assert.equal(result.accepted, true); assert.equal(f.body.snapshot().version, version + 1);
  assert.equal(f.body.snapshot().workCompleted, false); assert.equal(f.body.snapshot().goalStatus, 'working');
  assert.deepEqual(f.body.snapshot().completedSteps, []); assert.equal(f.calls.length, 2);
  assert.equal(f.events.filter(event => event.type === 'goal-finished').length, 1);
  await f.finish(1, {}); f.body.controller.tick();
  assert.equal(f.body.snapshot().workCompleted, true);
  assert.equal(f.events.filter(event => event.type === 'goal-finished').length, 2);
});

test('bridge validation bounds material authority and its world deadline includes receipt draining', () => {
  assert.deepEqual(validateBodyAction({ type: 'bridge', x: 2, z: 0 }), { type: 'bridge', x: 2, z: 0, item: 'cobblestone', maxBlocks: 8 });
  for (const changed of [{ maxBlocks: 13 }, { maxBlocks: -1 }, { maxBlocks: 1.5 }, { maxBlocks: '8' }, { item: 'sand' }, { x: Infinity }])
    assert.throws(() => validateBodyAction({ type: 'bridge', x: 2, z: 0, ...changed }));
  assert.equal(validateBodyAction({ type: 'bridge', x: 2, z: 0, maxBlocks: 0 }).maxBlocks, 0);
  assert.equal(bodyActionTimeoutMs({ type: 'bridge' }), 48000);
});

test('bridge receipts preserve cumulative budget across partial cancellation and equivalent lease renewal', async t => {
  const f = fixture(); t.after(() => f.clean());
  const steps = [{ type: 'bridge', x: 4, z: 0, maxBlocks: 2 }];
  await f.submit(steps); assert.equal(f.calls[0].action.maxBlocks, 2);
  await f.finish(0, { reached: false, spent: 1, placed: 1, inventoryConfirmed: true, partial: true }, 'cancelled');
  f.bot.entity.position = new Vec3(1, 64, 0); f.body.controller.tick(); await flush();
  assert.equal(f.calls[1].action.maxBlocks, 1); assert.deepEqual(f.calls[1].action.origin, { x: 0, y: 64, z: 0 });
  const version = f.body.snapshot().version;
  const renewed = await f.submit(steps);
  assert.equal(renewed.unchanged, true); assert.equal(f.body.snapshot().version, version);
  assert.equal(f.calls[1].signal.aborted, false); assert.equal(f.body.snapshot().bridgeProgress[0].spent, 1);
  await f.finish(1, { reached: false, spent: 1, placed: 1, inventoryConfirmed: true });
  f.body.controller.tick(); await flush();
  assert.equal(f.calls[2].action.maxBlocks, 0, 'Already placed support may still be traversed after the final block was spent.');
  assert.deepEqual(f.body.snapshot().completedSteps, []);
  await f.finish(2, { reached: false, spent: 0, placed: 0, inventoryConfirmed: true, stoppedReason: 'budget_exhausted' }, 'failed');
  f.body.controller.tick(); await flush();
  assert.equal(f.calls.length, 3); assert.equal(f.body.snapshot().blocked, 'bridge_budget_exhausted');
  assert.equal(f.body.snapshot().bridgeProgress[0].spent, 2);
  await f.submit(steps); f.body.controller.tick(); await flush();
  assert.equal(f.calls.length, 3, 'Renewing the same exhausted plan cannot replenish material authority.');
});

test('bridge can finish walking confirmed support with zero remaining material budget', async t => {
  const f = fixture(); t.after(() => f.clean());
  await f.submit([{ type: 'bridge', x: 2, z: 0, maxBlocks: 1 }]);
  await f.finish(0, { reached: false, spent: 1, inventoryConfirmed: true }, 'cancelled');
  f.body.controller.tick(); await flush(); assert.equal(f.calls[1].action.maxBlocks, 0);
  await f.finish(1, { reached: true, spent: 0, inventoryConfirmed: true });
  f.body.controller.tick(); await flush();
  assert.deepEqual(f.body.snapshot().completedSteps, [0]); assert.equal(f.body.snapshot().workCompleted, true);
});

test('unknown bridge spending blocks automatic retries and cannot fabricate completed work', async t => {
  const f = fixture(); t.after(() => f.clean());
  await f.submit([{ type: 'bridge', x: 2, z: 0, maxBlocks: 2 }]);
  await f.finish(0, { reached: true, placed: 1, spent: 0, inventoryConfirmed: false });
  f.body.controller.tick(); await flush();
  assert.deepEqual(f.body.snapshot().completedSteps, []); assert.equal(f.calls.length, 1);
  assert.equal(f.body.snapshot().blocked, 'bridge_inventory_unconfirmed');
  assert.equal(f.body.snapshot().bridgeProgress[0].inventoryConfirmed, false);
});

test('authorized emergency preempts bridging, drains its partial receipt, then resumes with the remaining budget', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const f = fixture(); t.after(() => f.clean());
  await f.submit([{ type: 'bridge', x: 2, z: 0, maxBlocks: 2 }], { reactions: ['surface'] });
  f.bot.entity.isInWater = true; f.body.controller.tick(); await flush();
  assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.calls.length, 1);
  await f.finish(0, { reached: false, spent: 1, inventoryConfirmed: true }, 'cancelled');
  f.body.controller.tick(); await flush(); assert.equal(f.calls[1].action.type, 'surface');
  f.bot.entity.isInWater = false; now += 1000;
  await f.finish(1, { dryGround: true, surfaceReached: true });
  f.body.controller.tick(); await flush();
  assert.equal(f.calls[2].action.type, 'bridge'); assert.equal(f.calls[2].action.maxBlocks, 1);
});

test('brain cancellation revokes bridge authority, and a later explicit new plan receives a new budget', async t => {
  const f = fixture(); t.after(() => f.clean());
  const steps = [{ type: 'bridge', x: 2, z: 0, maxBlocks: 2 }];
  await f.submit(steps); const version = f.body.snapshot().version;
  assert.equal(f.body.cancel(version).accepted, true); assert.equal(f.calls[0].signal.aborted, true);
  await f.finish(0, { reached: true, spent: 1, inventoryConfirmed: true }, 'cancelled');
  f.body.controller.tick(); await flush();
  assert.equal(f.body.snapshot().intent, undefined); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.body.snapshot().completedSteps, []);
  await f.submit(steps); assert.equal(f.calls[1].action.maxBlocks, 2);
  assert.equal(f.body.snapshot().bridgeProgress[0].spent, 0);
});

test('append preserves running work and accepts its original-version receipt before moving into appended steps', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const f = fixture(); t.after(() => f.clean());
  await f.submit([{ type: 'wait', ms: 500 }], { reactions: ['surface'], policy: { chaseRange: 4 }, ttlMs: 10000 });
  const before = f.body.snapshot(); now = 1500;
  const append = { expectedVersion: before.version, steps: [{ type: 'wait', ms: 700 }] };
  const result = f.body.append(append); await flush();
  const after = f.body.snapshot();
  assert.equal(result.accepted, true); assert.equal(after.version, before.version + 1);
  assert.equal(after.intent?.id, before.intent?.id); assert.equal(after.intent?.expiresAt, before.intent?.expiresAt);
  assert.deepEqual(after.intent?.allowedReactions, before.intent?.allowedReactions);
  assert.deepEqual(after.intent?.goal.policy, before.intent?.goal.policy);
  assert.deepEqual(after.current, before.current); assert.equal(f.calls[0].signal.aborted, false); assert.equal(f.calls.length, 1);
  assert.equal(f.body.append(append).accepted, false);
  assert.equal(f.body.submit({ expectedVersion: before.version, steps: [] }).accepted, false);
  assert.equal(f.body.cancel(before.version).accepted, false);
  await f.finish(0, {}); f.body.controller.tick(); await flush();
  assert.deepEqual(f.body.snapshot().completedSteps, [0]); assert.equal(f.calls[1].action.ms, 700);
  assert.equal(f.body.snapshot().recentReceipts[0].intentVersion, before.version);
  assert.equal(f.events.filter(event => event.type === 'intent-extended').length, 1);
});

test('append preserves completed work, gathering accounting and the original inventory baseline', async t => {
  const f = fixture(); t.after(() => f.clean()); f.inventory([{ name: 'oak_log', count: 10 }]);
  await f.submit([{ type: 'wait', ms: 100 }, { type: 'gather', block: 'oak_log', count: 2 }]);
  await f.finish(0, {}); f.body.controller.tick(); await flush();
  f.inventory([{ name: 'oak_log', count: 11 }]); await f.finish(1, { minedBlocks: 1 });
  f.body.controller.tick(); await flush();
  assert.equal(f.body.append({ expectedVersion: f.body.snapshot().version, steps: [{ type: 'wait', ms: 700 }] }).accepted, true);
  assert.equal(f.calls[2].signal.aborted, false); assert.deepEqual(f.body.snapshot().completedSteps, [0]);
  f.inventory([{ name: 'oak_log', count: 12 }]); await f.finish(2, { minedBlocks: 1 });
  f.body.controller.tick(); await flush();
  assert.deepEqual(f.body.snapshot().completedSteps, [0, 1]); assert.equal(f.calls[3].action.ms, 700);
  assert.equal(f.calls.filter(call => call.action.type === 'gather').length, 2);
});

test('append preserves spent bridge material, origins and accounting from a running old-version receipt', async t => {
  const f = fixture(); t.after(() => f.clean());
  await f.submit([{ type: 'bridge', x: 3, z: 0, maxBlocks: 2 }], { reactions: ['surface'] });
  await f.finish(0, { reached: false, spent: 1, inventoryConfirmed: true }, 'cancelled');
  f.bot.entity.position = new Vec3(1, 64, 0); f.body.controller.tick(); await flush();
  const before = f.body.snapshot();
  assert.equal(f.body.append({ expectedVersion: before.version, steps: [{ type: 'wait', ms: 100 }] }).accepted, true);
  assert.equal(f.calls[1].signal.aborted, false); assert.equal(f.calls[1].action.maxBlocks, 1);
  assert.deepEqual(f.body.snapshot().bridgeProgress, before.bridgeProgress);
  assert.deepEqual(f.body.snapshot().intent?.goal.anchor, before.intent?.goal.anchor);
  await f.finish(1, { reached: false, spent: 1, inventoryConfirmed: true }, 'cancelled');
  f.body.controller.tick(); await flush();
  assert.equal(f.calls[2].action.maxBlocks, 0); assert.deepEqual(f.calls[2].action.origin, { x: 0, y: 64, z: 0 });
  assert.equal(f.body.snapshot().bridgeProgress[0].spent, 2);
});

test('append keeps a running combat step anchored after movement and extension', async t => {
  const f = fixture(); t.after(() => f.clean()); f.enemy();
  await f.submit([{ type: 'combat', entityId: 9 }], { policy: { chaseRange: 4 } });
  f.bot.entity.position = new Vec3(3, 64, 0);
  assert.equal(f.body.append({ expectedVersion: f.body.snapshot().version, steps: [{ type: 'wait', ms: 100 }] }).accepted, true);
  assert.equal(f.calls[0].signal.aborted, false);
  await f.finish(0, { stoppedReason: 'duration_elapsed', healthAfter: 12 }); f.body.controller.tick(); await flush();
  assert.deepEqual(f.calls[1].action.origin, { x: 0, y: 64, z: 0 });
  assert.equal(f.calls[1].action.maxDistance, 4);
});

test('appending a shore step does not retarget an already running surface reaction', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const f = fixture(); t.after(() => f.clean()); f.bot.entity.isInWater = true;
  await f.submit([{ type: 'wait', ms: 100 }], { reactions: ['surface'] });
  const current = f.body.snapshot().current;
  assert.equal(f.body.append({ expectedVersion: f.body.snapshot().version,
    steps: [{ type: 'surface', target: { x: 5, y: 64, z: 0 } }] }).accepted, true);
  now += 500; f.body.controller.tick(); await flush();
  assert.deepEqual(f.body.snapshot().current, current); assert.equal(f.calls[0].signal.aborted, false);
  assert.equal(f.calls[0].action.target, undefined);
});

test('append cannot extend bridge work with unconfirmed material accounting before another control tick', async t => {
  const f = fixture(); t.after(() => f.clean());
  await f.submit([{ type: 'bridge', x: 2, z: 0, maxBlocks: 2 }]);
  await f.finish(0, { reached: false, spent: 1, inventoryConfirmed: false });
  assert.equal(f.body.append({ expectedVersion: f.body.snapshot().version, steps: [{ type: 'wait', ms: 100 }] }).accepted, false);
  assert.equal(f.body.snapshot().planningNeeded, false);
});

test('invalid appended skills and TTL leave the running authorization intact', async t => {
  const f = fixture(); t.after(() => f.clean()); await f.submit([{ type: 'wait', ms: 100 }]);
  const before = f.body.snapshot();
  assert.throws(() => f.body.append({ expectedVersion: before.version, steps: [{ type: 'unknown' }] }));
  assert.throws(() => f.body.append({ expectedVersion: before.version, steps: [{ type: 'wait', ms: 100 }], ttlMs: 0 }));
  assert.equal(f.body.snapshot().version, before.version); assert.equal(f.calls[0].signal.aborted, false);
});

test('replacement isolates late extended-lineage receipts and has a distinct intent identity', async t => {
  const f = fixture(); t.after(() => f.clean());
  await f.submit([{ type: 'bridge', x: 2, z: 0, maxBlocks: 2 }]);
  const oldId = f.body.snapshot().intent?.id;
  f.body.append({ expectedVersion: f.body.snapshot().version, steps: [{ type: 'wait', ms: 100 }] });
  await f.submit([{ type: 'bridge', x: 4, z: 0, maxBlocks: 2 }]);
  assert.notEqual(f.body.snapshot().intent?.id, oldId);
  await f.finish(0, { reached: true, spent: 2, inventoryConfirmed: true });
  f.body.controller.tick(); await flush();
  assert.deepEqual(f.body.snapshot().completedSteps, []); assert.equal(f.body.snapshot().bridgeProgress[0].spent, 0);
  assert.equal(f.calls[1].action.maxBlocks, 2);
});

for (const revoke of ['stop', 'expire', 'cancel', 'blocked'] as const) {
  test(`append rejects ${revoke} even with a freshly read version`, async t => {
    let now = 1000; t.mock.method(Date, 'now', () => now);
    const f = fixture(); t.after(() => f.clean());
    await f.submit([{ type: 'jump_to', x: 2, y: 65, z: 0 }], { reactions: ['surface'], ttlMs: 1000 });
    if (revoke === 'stop') void f.body.stop();
    if (revoke === 'expire') now = 2000;
    if (revoke === 'cancel') f.body.cancel(f.body.snapshot().version);
    if (revoke === 'blocked') await f.finish(0, { stoppedReason: 'jump_arc_blocked' }, 'failed');
    assert.equal(f.body.append({ expectedVersion: f.body.snapshot().version, steps: [{ type: 'wait', ms: 100 }], ttlMs: 5000 }).accepted, false);
    if (revoke !== 'blocked') assert.equal(f.body.snapshot().intent, undefined);
    assert.equal(f.events.some(event => event.type === 'intent-extended'), false);
  });
}

test('append validates steps and counts completed prefixes toward its finite plan limit', async t => {
  const f = fixture(); t.after(() => f.clean());
  await f.submit(Array.from({ length: 12 }, () => ({ type: 'wait', ms: 100 })), { reactions: ['surface'] });
  await f.finish(0, {}); f.body.controller.tick(); await flush(); const before = f.body.snapshot();
  for (const steps of [[], [{ type: 'wait', ms: 100 }], [{ type: 'unknown' }]])
    assert.throws(() => f.body.append({ expectedVersion: before.version, steps }));
  assert.equal(f.body.snapshot().version, before.version); assert.equal(f.calls[1].signal.aborted, false);
  assert.deepEqual(f.body.snapshot().completedSteps, [0]);
});

test('append can extend a retained completed policy, and an explicit TTL only lengthens its lease', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const f = fixture(); t.after(() => f.clean());
  await f.submit([{ type: 'wait', ms: 100 }], { reactions: ['surface'], ttlMs: 10000 });
  await f.finish(0, {}); f.body.controller.tick(); now = 2000;
  assert.equal(f.body.append({ expectedVersion: f.body.snapshot().version, steps: [{ type: 'wait', ms: 200 }], ttlMs: 1000 }).accepted, true);
  await flush(); assert.equal(f.body.snapshot().intent?.expiresAt, 11000);
  assert.equal(f.body.snapshot().workCompleted, false); assert.deepEqual(f.body.snapshot().completedSteps, [0]);
  assert.equal(f.calls[1].action.ms, 200);
  assert.equal(f.body.append({ expectedVersion: f.body.snapshot().version, steps: [{ type: 'wait', ms: 300 }], ttlMs: 20000 }).accepted, true);
  assert.equal(f.body.snapshot().intent?.expiresAt, 22000); assert.equal(f.calls[1].signal.aborted, false);
});

test('planning-needed is bounded per version and progress, with remaining work exposed in snapshots', async t => {
  const f = fixture(); t.after(() => f.clean());
  f.body.setThroughputOptimizations(false);
  await f.submit([{ type: 'wait', ms: 100 }, { type: 'wait', ms: 200 }, { type: 'wait', ms: 300 }], { reactions: ['surface'] });
  assert.equal(f.body.snapshot().remainingSteps, 3); assert.equal(f.body.snapshot().planningNeeded, false);
  assert.equal(f.events.filter(event => event.type === 'planning-needed').length, 0);
  await f.finish(0, {}); f.body.controller.tick(); await flush();
  assert.equal(f.body.snapshot().remainingSteps, 2); assert.equal(f.body.snapshot().planningNeeded, true);
  for (let i = 0; i < 30; i++) { f.body.controller.tick(); await flush(); }
  assert.equal(f.events.filter(event => event.type === 'planning-needed').length, 1);
  assert.equal(f.events.find(event => event.type === 'planning-needed')?.reason, 'steps-low');
  await f.finish(1, {}); f.body.controller.tick(); await flush();
  assert.equal(f.events.filter(event => event.type === 'planning-needed').length, 2);
  await f.finish(2, {}); f.body.controller.tick(); await flush();
  assert.equal(f.body.snapshot().remainingSteps, 0); assert.equal(f.body.snapshot().planningNeeded, false);
  assert.equal(f.events.filter(event => event.type === 'planning-needed').length, 2);
});

test('planning-needed signals a short lease without renewing it and stays quiet for empty or blocked work', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const f = fixture(); t.after(() => f.clean());
  f.body.setThroughputOptimizations(false);
  await f.submit(Array.from({ length: 3 }, () => ({ type: 'wait', ms: 100 })), { ttlMs: 20000 });
  const expiry = f.body.snapshot().intent?.expiresAt;
  now = 6000; f.body.controller.tick(); await flush();
  assert.equal(f.body.snapshot().planningNeeded, true); assert.equal(f.events.filter(event => event.type === 'planning-needed').length, 1);
  assert.equal(f.events.find(event => event.type === 'planning-needed')?.reason, 'lease-low');
  for (let i = 0; i < 20; i++) { now += 100; f.body.controller.tick(); await flush(); }
  assert.equal(f.events.filter(event => event.type === 'planning-needed').length, 1);
  assert.equal(f.body.snapshot().intent?.expiresAt, expiry);
  const stopped = f.body.stop(); await f.finish(0, {}, 'cancelled'); await stopped;
  await f.submit([], { reactions: ['surface'], ttlMs: 1000 }, true);
  for (let i = 0; i < 20; i++) { f.body.controller.tick(); await flush(); }
  assert.equal(f.body.snapshot().planningNeeded, false); assert.equal(f.events.filter(event => event.type === 'planning-needed').length, 1);
  await f.submit([{ type: 'jump_to', x: 2, y: 65, z: 0 }]);
  await f.finish(1, { stoppedReason: 'jump_arc_blocked' }, 'failed'); const count = f.events.filter(event => event.type === 'planning-needed').length;
  for (let i = 0; i < 20; i++) { f.body.controller.tick(); await flush(); }
  assert.equal(f.body.snapshot().planningNeeded, false); assert.equal(f.events.filter(event => event.type === 'planning-needed').length, count);
});

test('planning lead uses measured brain latency and short work duration rather than a two-step count', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const f = fixture(); t.after(() => f.clean()); f.body.recordPlanningLatency(18000);
  await f.submit(Array.from({ length: 4 }, () => ({ type: 'wait', ms: 1000 })));
  const snapshot = f.body.snapshot();
  assert.equal(snapshot.remainingSteps, 4); assert.equal(snapshot.remainingWorkMs, 4000);
  assert.equal(snapshot.planningHorizonMs, 19500); assert.equal(snapshot.planningNeeded, true);
  assert.equal(f.events.find(event => event.type === 'planning-needed').reason, 'work-time-low');
  for (let i = 0; i < 20; i++) { f.body.controller.tick(); await flush(); }
  assert.equal(f.events.filter(event => event.type === 'planning-needed').length, 1);
  assert.equal(f.calls[0].signal.aborted, false);
});

test('a long current skill triggers top-up when remaining duration enters the horizon', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const f = fixture(); t.after(() => f.clean()); f.body.recordPlanningLatency(500);
  await f.submit([{ type: 'wait', ms: 5000 }, { type: 'wait', ms: 5000 }]);
  assert.equal(f.body.snapshot().planningNeeded, false);
  await f.finish(0, {}); f.body.controller.tick(); await flush();
  assert.equal(f.body.snapshot().planningNeeded, false);
  now += 3100; f.body.controller.tick(); await flush();
  assert.equal(f.body.snapshot().remainingWorkMs, 1900); assert.equal(f.body.snapshot().planningNeeded, true);
  assert.equal(f.events.filter(event => event.type === 'planning-needed').length, 1);
});

test('planning estimate is bounded, rolls old measurements out and ignores invalid measurements', async t => {
  const f = fixture(); t.after(() => f.clean());
  for (const invalid of [0, -1, Infinity, NaN]) f.body.recordPlanningLatency(invalid);
  assert.equal(f.body.snapshot().planningHorizonMs, 13500);
  for (let i = 0; i < 16; i++) f.body.recordPlanningLatency(100000);
  assert.equal(f.body.snapshot().planningHorizonMs, 60000);
  for (let i = 0; i < 16; i++) f.body.recordPlanningLatency(1000);
  assert.equal(f.body.snapshot().planningHorizonMs, 2500);
});

test('terminal work suppresses top-up, retains completion and reflex events, and still warns for expiry', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const f = fixture(); t.after(() => f.clean());
  await f.submit([{ type: 'wait', ms: 500 }], { terminal: true, reactions: ['surface'], ttlMs: 20000 });
  assert.equal(f.body.snapshot().planningNeeded, false);
  now = 8000; f.body.controller.tick(); await flush();
  assert.equal(f.body.snapshot().planningNeeded, true);
  assert.equal(f.events.find(event => event.type === 'planning-needed').reason, 'lease-low');
  await f.finish(0, {}); f.body.controller.tick(); await flush();
  assert.equal(f.events.find(event => event.type === 'goal-finished').terminal, true);
  f.bot.entity.isInWater = true; f.body.controller.tick(); await flush();
  assert.equal(f.calls[1].action.type, 'surface');
  assert.equal(f.body.snapshot().intent!.expiresAt, 21000);
});

test('append explicitly changes terminal status while retaining active lineage and prior completion', async t => {
  const f = fixture(); t.after(() => f.clean());
  await f.submit([{ type: 'wait', ms: 500 }], { terminal: true });
  const id = f.body.snapshot().intent!.id;
  f.body.append({ expectedVersion: f.body.snapshot().version, steps: [{ type: 'wait', ms: 500 }] });
  assert.equal(f.body.snapshot().intent!.goal.terminal, true);
  f.body.append({ expectedVersion: f.body.snapshot().version, steps: [{ type: 'wait', ms: 500 }], terminal: false });
  await flush();
  assert.equal(f.body.snapshot().intent!.goal.terminal, false); assert.equal(f.body.snapshot().planningNeeded, true);
  assert.equal(f.body.snapshot().intent!.id, id); assert.equal(f.calls[0].signal.aborted, false);
  await f.finish(0, {}); f.body.controller.tick(); await flush();
  assert.deepEqual(f.body.snapshot().completedSteps, [0]);
  assert.throws(() => f.body.append({ expectedVersion: f.body.snapshot().version, steps: [{ type: 'wait', ms: 500 }], terminal: 'yes' as any }));
});

test('throughput ablation cannot change a live grant and same-value configuration is harmless', async t => {
  const f = fixture(); t.after(() => f.clean()); await f.submit([{ type: 'wait', ms: 500 }]);
  const before = f.body.snapshot();
  f.body.setThroughputOptimizations(true);
  assert.throws(() => f.body.setThroughputOptimizations(false), /空闲/);
  assert.equal(f.body.snapshot().version, before.version); assert.equal(f.calls[0].signal.aborted, false);
});

for (const code of ['missing_tool', 'no_visible_resource', 'candidates_exhausted', 'missing_prerequisites', 'invalid_item']) {
  test(`${code} requests one immediate replan and preserves existing completed steps and reflexes`, async t => {
    const f = fixture(); t.after(() => f.clean());
    await f.submit([{ type: 'wait', ms: 500 }, { type: 'craft', item: 'oak_planks', count: 1 }], { terminal: true, reactions: ['surface'] });
    await f.finish(0, {}); f.body.controller.tick(); await flush();
    await f.finish(1, { stoppedReason: code }, 'failed');
    for (let i = 0; i < 20; i++) { f.body.controller.tick(); await flush(); }
    assert.deepEqual(f.body.snapshot().completedSteps, [0]); assert.equal(f.body.snapshot().replanRequired!.code, code);
    assert.equal(f.events.filter(event => event.type === 'goal-blocked').length, 1);
    assert.equal(f.calls.length, 2);
    f.bot.entity.isInWater = true; f.body.controller.tick(); await flush();
    assert.equal(f.calls[2].action.type, 'surface');
  });
}

test('unknown repeated failures are bounded even after core retry delays', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const f = fixture(); t.after(() => f.clean()); await f.submit([{ type: 'goto', x: 3, y: 64, z: 0 }]);
  for (let i = 0; i < 3; i++) {
    await f.finish(i, { stoppedReason: 'future_transient_error' }, 'failed');
    now += 5000; f.body.controller.tick(); await flush();
  }
  assert.equal(f.calls.length, 3); assert.equal(f.body.snapshot().replanRequired!.code, 'repeated_no_progress');
  assert.equal(f.events.filter(event => event.type === 'goal-blocked').length, 1);
});

test('completed combat slices with no actual progress cannot spin forever, but damage resets the count', async t => {
  const f = fixture(); t.after(() => f.clean()); const enemy = f.enemy();
  await f.submit([{ type: 'combat', entityId: enemy.id }]);
  for (let i = 0; i < 2; i++) { await f.finish(i, { healthBefore: 20, healthAfter: 20 }); f.body.controller.tick(); await flush(); }
  enemy.health = 12; await f.finish(2, { healthBefore: 20, healthAfter: 12 }); f.body.controller.tick(); await flush();
  assert.equal(f.body.snapshot().replanRequired, undefined);
  for (let i = 3; i < 6; i++) { await f.finish(i, { healthBefore: 12, healthAfter: 12 }); f.body.controller.tick(); await flush(); }
  assert.equal(f.calls.length, 6); assert.equal(f.body.snapshot().replanRequired!.code, 'repeated_no_progress');
  assert.deepEqual(f.body.snapshot().completedSteps, []);
});

test('mined but unconfirmed inventory waits for packets only for a bounded interval without mining extra blocks', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const f = fixture(); t.after(() => f.clean());
  await f.submit([{ type: 'gather', block: 'oak_log', count: 1 }], { reactions: ['surface'] });
  await f.finish(0, { minedBlocks: 1, pickupConfirmed: false }); f.body.controller.tick(); await flush();
  now += 4999; f.body.controller.tick(); await flush(); assert.equal(f.body.snapshot().replanRequired, undefined);
  now += 1; f.body.controller.tick(); await flush();
  assert.equal(f.body.snapshot().replanRequired!.code, 'mined_but_pickup_unconfirmed');
  assert.equal(f.calls.length, 1); assert.deepEqual(f.body.snapshot().completedSteps, []);
  assert.equal(f.events.filter(event => event.type === 'goal-blocked').length, 1);
});

test('gather receipts carry a bounded shared area and candidate budget through append and cancellation', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const f = fixture(); t.after(() => f.clean());
  await f.submit([{ type: 'gather', block: 'oak_log', count: 3 }]);
  const gatherState = { origin: { x: 0, y: 64, z: 0 }, attemptedTargets: ['(1, 64, 0)'], movementAttempts: 2 };
  f.inventory([{ name: 'oak_log', count: 1 }]);
  await f.finish(0, { minedBlocks: 1, gatherState }, 'cancelled');
  f.bot.entity.position = new Vec3(5, 64, 0); now += 1000; f.body.controller.tick(); await flush();
  assert.deepEqual(f.calls[1].action.gatherState, gatherState);
  f.body.append({ expectedVersion: f.body.snapshot().version, steps: [{ type: 'wait', ms: 100 }] });
  assert.equal(f.calls[1].signal.aborted, false);
  await f.finish(1, { minedBlocks: 0, gatherState: { ...gatherState, movementAttempts: 3 } }, 'cancelled');
  now += 2000; f.body.controller.tick(); await flush(); assert.equal(f.calls[2].action.gatherState.movementAttempts, 3);
  assert.deepEqual(f.calls[2].action.gatherState.origin, { x: 0, y: 64, z: 0 });
});

test('retreat exhausted in an encounter reports once and preserves other authorized reflexes and fixed bounds', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const f = fixture(); t.after(() => f.clean()); f.enemy('creeper');
  await f.submit([], { reactions: ['flee', 'eat', 'surface'], policy: { chaseRange: 4 } });
  const origin = f.calls[0].action.origin;
  f.bot.entity.position = new Vec3(4, 64, 0); f.bot.entities[9].position = new Vec3(6, 64, 0);
  await f.finish(0, { stoppedReason: 'distance_limit', authorizationExhausted: true }, 'failed');
  for (let i = 0; i < 50; i++) { now += 50; f.body.controller.tick(); await flush(); }
  assert.equal(f.calls.length, 1); assert.equal(f.body.snapshot().reactionBlocked[0].code, 'distance_limit');
  assert.equal(f.events.filter(event => event.type === 'goal-blocked').length, 1);
  await f.submit([], { reactions: ['flee', 'eat', 'surface'], policy: { chaseRange: 4 }, restart: true });
  assert.equal(f.calls.length, 1, 'Replacing work must not manufacture fresh range in the same encounter.');
  f.bot.food = 8; f.inventory([{ name: 'bread', count: 1 }]); f.body.controller.tick(); await flush();
  assert.equal(f.calls[1].action.type, 'eat');
  await f.finish(1, { consumptionConfirmed: true }); f.bot.food = 20;
  f.bot.entity.isInWater = true; f.body.controller.tick(); await flush();
  assert.equal(f.calls[2].action.type, 'surface');
  assert.deepEqual(origin, { x: 0, y: 64, z: 0 }); assert.equal(f.body.snapshot().replanRequired, undefined);
});

test('reaction exhaustion clears only after observed encounter safety, never a stop/resume alone', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const f = fixture(); t.after(() => f.clean()); f.enemy('creeper');
  const policy = { reactions: ['flee'], policy: { chaseRange: 4 } };
  await f.submit([], policy); await f.finish(0, { stoppedReason: 'distance_limit' }, 'failed');
  await f.body.stop(); await f.submit([], policy, true);
  assert.equal(f.calls.length, 1); assert.equal(f.body.snapshot().reactionBlocked.length, 1);
  delete f.bot.entities[9]; now += 250; f.body.controller.tick(); await flush();
  now += 2000; f.body.controller.tick(); await flush();
  assert.equal(f.body.snapshot().reactionBlocked.length, 0);
  f.bot.entity.position = new Vec3(20, 64, 0); f.enemy('creeper').position = new Vec3(22, 64, 0);
  now += 250; f.body.controller.tick(); await flush();
  assert.equal(f.calls.length, 2); assert.deepEqual(f.calls[1].action.origin, { x: 20, y: 64, z: 0 });
});

test('a compound gather failure takes precedence over its earlier successful approach receipt', async t => {
  const f = fixture(); t.after(() => f.clean()); await f.submit([{ type: 'gather', block: 'oak_log', count: 2 }]);
  await f.finish(0, { stoppedReason: 'missing_tool', approach: { stoppedReason: 'reached' } }, 'failed');
  assert.equal(f.body.snapshot().replanRequired?.code, 'missing_tool');
  assert.equal(f.events.filter(event => event.type === 'goal-blocked').length, 1);
});

test('gather establishes its area when its own step starts, then fallback pickup retains that area', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const f = fixture(); t.after(() => f.clean());
  await f.submit([{ type: 'goto', x: 20, y: 64, z: 0 }, { type: 'gather', block: 'oak_log', count: 1, maxDistance: 4 }]);
  f.bot.entity.position = new Vec3(20, 64, 0); await f.finish(0, { reached: true }); f.body.controller.tick(); await flush();
  assert.deepEqual(f.calls[1].action.gatherState.origin, { x: 20, y: 64, z: 0 });
  f.body.controller.tick(); await flush(); assert.equal(f.calls[1].signal.aborted, false, 'Committing the area cannot restart its own running slice.');
  f.bot.entity.position = new Vec3(23, 64, 0);
  f.bot.entities[50] = { id: 50, name: 'item', position: new Vec3(26, 64, 0), getDroppedItem: () => ({ name: 'oak_log', count: 1 }) };
  await f.finish(1, { minedBlocks: 1, pickupConfirmed: false }); f.body.controller.tick(); await flush();
  assert.equal(f.calls.length, 2, 'A drop near the moved bot but outside the original area must not expand collection.');
  f.bot.entities[50].position = new Vec3(22, 64, 0); now += 200; f.body.controller.tick(); await flush();
  assert.equal(f.calls[2].action.type, 'pickup'); assert.deepEqual(f.calls[2].action.origin, { x: 20, y: 64, z: 0 });
  assert.equal(f.calls[2].action.maxDistance, 4);
});

test('maximum-range gather fallback pickup passes production action validation with its original area', async t => {
  const f = fixture(); t.after(() => f.clean());
  const executeOwned = f.world.executeOwned.bind(f.world);
  f.world.executeOwned = (name, raw, signal) => {
    validateBodyAction(raw);
    return executeOwned(name, raw, signal);
  };
  await f.submit([{ type: 'gather', block: 'oak_log', count: 1, maxDistance: 32 }], { policy: { chaseRange: 4 } });
  assert.equal(f.calls.length, 1);
  const origin = { x: 0, y: 64, z: 0 };
  assert.deepEqual(f.calls[0].action.gatherState.origin, origin);
  f.bot.entity.position = new Vec3(27, 64, 0);
  f.bot.entities[50] = { id: 50, name: 'item', position: new Vec3(28, 64, 0), getDroppedItem: () => ({ name: 'oak_log', count: 1 }) };
  await f.finish(0, { minedBlocks: 1, pickupConfirmed: false, inventoryDelta: [] });
  f.body.controller.tick(); await flush();
  assert.equal(f.calls.length, 2, 'A valid gather radius must not fail validation when translated into pickup.');
  assert.equal(f.calls[1].action.type, 'pickup'); assert.equal(f.calls[1].action.entityId, 50);
  assert.equal(f.calls[1].action.maxDistance, 32); assert.deepEqual(f.calls[1].action.origin, origin);
  assert.deepEqual(f.body.snapshot().completedSteps, [], 'Starting pickup does not confirm inventory gain.');
  f.inventory([{ name: 'oak_log', count: 1 }]);
  await f.finish(1, { inventoryIncreased: true, inventoryDelta: [{ item: 'oak_log', change: 1 }] });
  f.body.controller.tick(); await flush();
  assert.deepEqual(f.body.snapshot().completedSteps, [0]);
});

test('construction continues partial slices under one grant and plans against remaining blocks, not a two-second default',async t=>{
  const f=fixture();t.after(()=>f.clean());
  const step={type:'build',blueprint:'railed-bridge',origin:{x:0,y:64,z:0}};
  await f.submit([step],{ttlMs:120000,reactions:[]});
  const intent=f.body.snapshot().intent!.id;
  assert.equal(f.calls[0].action.type,'build');
  assert.ok(f.body.snapshot().remainingWorkMs>=48000);assert.equal(f.body.snapshot().planningNeeded,false);
  await f.finish(0,{placed:12,matched:12,total:49,reached:false,inventoryConfirmed:true,stoppedReason:'build_slice_complete'});
  f.body.controller.tick();await flush();
  assert.deepEqual(f.body.snapshot().completedSteps,[]);assert.equal(f.body.snapshot().workCompleted,false);
  assert.equal(f.body.snapshot().intent!.id,intent);assert.equal(f.calls[1].action.type,'build');
  for(let i=1;i<4;i++){
    await f.finish(i,{placed:12,matched:(i+1)*12,total:49,reached:false,inventoryConfirmed:true,stoppedReason:'build_slice_complete'});
    f.body.controller.tick();await flush();assert.equal(f.body.snapshot().workCompleted,false);
  }
  await f.finish(4,{placed:1,matched:49,total:49,reached:true,inventoryConfirmed:true,stoppedReason:'build_complete'});
  f.body.controller.tick();await flush();assert.equal(f.body.snapshot().workCompleted,true);assert.deepEqual(f.body.snapshot().completedSteps,[0]);
});

/** Deterministic production-body mechanism checks, not real Minecraft or Agent scores. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { MinecraftBody } from '../adapters/minecraft/src/minecraft-body.ts';
import { MinecraftWorld, type BotRecord } from '../adapters/minecraft/src/world.ts';
import { runContinuousSkill } from '../adapters/minecraft/src/continuous-skills.ts';
import { runNativeAction } from '../adapters/minecraft/src/native-actions.ts';
import { trackBodyEnvironment } from '../adapters/minecraft/src/body-observation.ts';

async function flush() { for (let index = 0; index < 16; index++) await Promise.resolve(); }
function fixture(optimized: boolean) {
  const bot: any = new EventEmitter(), events: any[] = [], controls: Record<string, boolean> = {};
  bot.entity = { id: 1, position: new Vec3(0, 64, 0), eyeHeight: 1.62, width: .6, height: 1.8,
    onGround: true, isInWater: false, isInLava: false, velocity: new Vec3(0, 0, 0) };
  bot._client = new EventEmitter(); bot._client.write = () => {};
  bot.entities = {}; bot.players = {}; bot.health = 20; bot.food = 20; bot.version = '1.21.4';
  bot.game = { dimension: 'overworld', gameMode: 'survival' };
  bot.registry = { itemsByName: { oak_log: { id: 1, name: 'oak_log' } }, foodsByName: {} };
  bot.inventory = { slots: [], items: () => [] }; bot.world = { raycast: () => null };
  bot.blockAt = (position: Vec3) => ({ name: position.y < 64 ? 'stone' : 'air', boundingBox: position.y < 64 ? 'block' : 'empty', position });
  bot.setControlState = (key: string, value: boolean) => { controls[key] = value; };
  bot.getControlState = (key: string) => controls[key] ?? false;
  bot.clearControlStates = () => { for (const key of Object.keys(controls)) bot.setControlState(key, false); };
  bot.stopDigging = () => {}; bot.deactivateItem = () => {}; bot.findBlocks = () => [];
  bot.chat = () => {}; bot.recipesAll = () => []; bot.canSeeBlock = () => true;
  const world = new MinecraftWorld({ host: '127.0.0.1', port: 25565, version: '1.21.4', logDirectory: '', dualLoop: true });
  world.event = (_record, type, data) => { const event = { type, ...data }; events.push(event); return event; };
  const calls: { action: any; signal: AbortSignal; finish: (result: any) => void }[] = [];
  world.executeOwned = (_name, action, signal) => new Promise(resolve => { calls.push({ action, signal, finish: resolve }); }) as any;
  const record: BotRecord = { name: 'Mechanism', persona: '', bot, ready: true, events: [] }; world.bots.set(record.name, record);
  const body = new MinecraftBody(world, record); record.body = body; body.setThroughputOptimizations(optimized);
  let now = Date.now(); (body.controller as any).now = () => now;
  return { bot, body, events, calls,
    async tick(ms = 10000) { now += ms; body.controller.tick(); await flush(); },
    async finish(index: number, details: any, status = 'failed') {
      calls[index].finish({ status, action: calls[index].action, details }); await flush();
    },
    async submit(steps: any[], extra: any = {}) {
      const result = body.submit({ expectedVersion: body.snapshot().version, steps, reactions: [], ttlMs: 120000, ...extra }); await flush(); return result;
    },
    async clean() { const done = body.dispose(); for (const call of calls) call.finish({ status: 'cancelled', action: call.action }); await done; },
  };
}

for (const [title, step, code] of [
  ['empty material craft', { type: 'craft', item: 'oak_planks', count: 1 }, 'missing_prerequisites'],
  ['no visible resource', { type: 'gather', block: 'oak_log', count: 2, maxDistance: 8 }, 'no_visible_resource'],
  ['exhausted resource candidates', { type: 'gather', block: 'oak_log', count: 2, maxDistance: 8 }, 'candidates_exhausted'],
  ['no remaining hunger', { type: 'eat' }, 'not_hungry'],
] as const) test(`mechanism ablation: ${title} yields once rather than retrying unchanged work`, async t => {
  for (const optimized of [false, true]) {
    const f = fixture(optimized); t.after(() => f.clean());
    await f.submit([step]); assert.equal(f.calls.length, 1);
    await f.finish(0, { stoppedReason: code });
    for (let index = 0; index < 3; index++) {
      await f.tick();
      if (f.calls.length > index + 1) await f.finish(index + 1, { stoppedReason: code });
    }
    assert.equal(f.calls.length, optimized ? 1 : 4);
    assert.equal(f.body.snapshot().replanRequired?.code, optimized ? code : undefined);
    assert.equal(f.events.filter(event => event.type === 'goal-blocked').length, optimized ? 1 : 0);
  }
});

test('a confirmed eat reaction leaves a stale queued meal for one real failure and fresh planning', async t => {
  const f = fixture(true); t.after(() => f.clean());
  const bread = { name: 'bread', count: 1, type: 2 };
  f.bot.food = 17; f.bot.registry.foodsByName.bread = { foodPoints: 5 };
  f.bot.inventory = { slots: [bread], items: () => [bread] };
  const steps = [{ type: 'eat' }, { type: 'wait', ms: 100 }];
  const policy = { reactions: ['eat', 'surface'], policy: { eatBelow: 18 } };
  await f.submit(steps, policy);
  assert.equal(f.calls.length, 1); assert.equal(f.body.snapshot().current?.skill.reaction, 'eat');
  f.bot.food = 20; f.bot.inventory = { slots: [], items: () => [] };
  await f.finish(0, { consumptionConfirmed: true, inventoryConfirmed: true, foodBefore: 17, food: 20,
    inventoryDelta: [{ item: 'bread', change: -1 }] }, 'completed');
  assert.deepEqual(f.body.snapshot().completedSteps, [], 'A reaction receipt cannot complete the separately queued meal.');
  await f.tick();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].action.type, 'eat');
  assert.equal(f.body.snapshot().current?.skill.reaction, undefined);
  let rejection: any;
  await assert.rejects(runContinuousSkill(f.bot, f.calls[1].action, f.calls[1].signal), (error: any) => {
    rejection = error.details; assert.equal(rejection.stoppedReason, 'not_hungry'); return true;
  });
  await f.finish(1, rejection);
  const blocked = f.body.snapshot();
  assert.equal(blocked.replanRequired?.code, 'not_hungry'); assert.equal(blocked.replanRequired?.stepIndex, 0);
  assert.equal(blocked.goalStatus, 'blocked'); assert.equal(blocked.workCompleted, false);
  assert.deepEqual(blocked.completedSteps, []);
  const receipt = f.events.filter(event => event.type === 'skill-finished').at(-1)?.controlEvent.receipt;
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.result.details.consumptionConfirmed, undefined);
  for (let i = 0; i < 3; i++) await f.tick();
  assert.equal(f.calls.length, 2, 'The rejected meal and the following work both remain suspended.');
  const renewed = await f.submit(steps, policy);
  assert.equal(renewed.unchanged, true); assert.deepEqual(f.body.snapshot().replanRequired, blocked.replanRequired);
  await f.tick(); assert.equal(f.calls.length, 2);
  f.bot.entity.isInWater = true; await f.tick();
  assert.equal(f.calls.length, 3); assert.equal(f.calls[2].action.type, 'surface');
  await f.finish(2, { surfaceReached: true }, 'completed');
  f.bot.entity.isInWater = false; await f.tick();
  assert.equal(f.calls.length, 3); assert.deepEqual(f.body.snapshot().completedSteps, []);
  assert.deepEqual(f.body.snapshot().replanRequired, blocked.replanRequired);
  assert.equal(f.events.filter(event => event.type === 'goal-blocked').length, 1);
});

async function blockedWorkSurfaceFixture(t: any) {
  const f = fixture(true); t.after(() => f.clean());
  f.bot.entity.name = 'player';
  f.bot.registry.entitiesByName = { player: { metadataKeys: ['air_supply'] } };
  t.after(trackBodyEnvironment(f.bot));
  const oxygen = (level: number) => f.bot._client.emit('entity_metadata', {
    entityId: f.bot.entity.id, metadata: [{ key: 0, value: level * 15 }],
  });
  await f.submit([{ type: 'jump_to', x: 3, y: 64, z: 0 }], { reactions: ['surface'] });
  await f.finish(0, { stoppedReason: 'landing_unavailable' });
  assert.equal(f.body.snapshot().replanRequired?.code, 'landing_unavailable');
  f.bot.entity.isInWater = true; f.bot.entity.onGround = false;
  oxygen(16); await f.tick(50);
  assert.equal(f.body.snapshot().current?.skill.reaction, 'surface');
  return { ...f, oxygen };
}

test('recovering oxygen does not let blocked work cancel its authorized floating slice', async t => {
  const f = await blockedWorkSurfaceFixture(t);
  const blocked = f.body.snapshot().replanRequired;
  const id = f.body.snapshot().current?.id;
  for (const oxygen of [18, 20, 17, 20]) {
    f.oxygen(oxygen); await f.tick(100);
    assert.equal(f.calls[1].signal.aborted, false);
    assert.equal(f.body.snapshot().current?.id, id);
  }
  await f.finish(1, { surfaceReached: true, dryGround: false, breathingConfirmed: false }, 'completed');
  await f.tick(100);
  assert.equal(f.calls.length, 2, 'Recovered oxygen does not authorize a new surface slice.');
  assert.deepEqual(f.body.snapshot().replanRequired, blocked);
  assert.deepEqual(f.body.snapshot().completedSteps, []);
  assert.equal(f.body.snapshot().workCompleted, false);
});

test('retained floating slice still releases in air, resumes submerged input and drains on cancel', async t => {
  const f = await blockedWorkSurfaceFixture(t);
  let eyesAir = false;
  f.bot.blockAt = (p: Vec3) => ({ name: eyesAir && p.y >= 65 ? 'air' : 'water', boundingBox: 'empty', position: p });
  const native = runContinuousSkill(f.bot, f.calls[1].action, f.calls[1].signal);
  const drained = assert.rejects(native);
  assert.equal(f.bot.getControlState('jump'), true);
  eyesAir = true; f.oxygen(20); await f.tick(100);
  assert.equal(f.calls[1].signal.aborted, false);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(f.bot.getControlState('jump'), false, 'Air geometry releases upward input without losing the owner.');
  eyesAir = false; f.oxygen(16);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(f.bot.getControlState('jump'), true, 'Submersion resumes real input without a model call or new skill.');
  assert.equal(f.body.cancel(f.body.snapshot().version).accepted, true);
  await drained; await f.finish(1, {}, 'cancelled');
  assert.equal(f.bot.getControlState('jump'), false);
  assert.equal(f.bot.jumpQueued, false);
});

for (const transition of ['cancel', 'stop', 'replace', 'expiry', 'deadline', 'lava', 'dry', 'death']) {
  test(`retained surface authorization yields to ${transition}`, async t => {
    const f = await blockedWorkSurfaceFixture(t);
    f.oxygen(20); await f.tick(50);
    assert.equal(f.calls[1].signal.aborted, false);
    let stopping: Promise<void> | undefined;
    if (transition === 'cancel') f.body.cancel(f.body.snapshot().version);
    else if (transition === 'stop') stopping = f.body.stop('test stop');
    else if (transition === 'replace') await f.submit([{ type: 'wait', ms: 100 }]);
    else if (transition === 'expiry') await f.tick(120000);
    else if (transition === 'deadline') await f.tick(19000);
    else {
      if (transition === 'lava') f.bot.entity.isInLava = true;
      if (transition === 'dry') { f.bot.entity.isInWater = false; f.bot.entity.onGround = true; }
      if (transition === 'death') f.bot.health = 0;
      await f.tick(50);
    }
    assert.equal(f.calls[1].signal.aborted, true);
    assert.equal(f.calls.length, 2, 'No new owner may start before the retained slice drains.');
    await f.finish(1, {}, 'cancelled'); await stopping;
  });
}

test('an actually occluded dig target requests fresh planning once without disclosing or completing the target', async t => {
  const f = fixture(true); t.after(() => f.clean());
  const cell = new Vec3(1, 64, 0), blockAt = f.bot.blockAt;
  f.bot.blockAt = (p: Vec3) => p.equals(cell) ? { ...blockAt(p), name: 'diamond_ore', boundingBox: 'block' } : blockAt(p);
  f.bot.canSeeBlock = () => false;
  f.bot.canDigBlock = () => assert.fail('The hidden block must not be inspected for diggability.');
  f.bot.dig = () => assert.fail('An occluded target must not receive a dig action.');
  const steps = [{ type: 'dig', x: 1, y: 64, z: 0 }, { type: 'wait', ms: 100 }];
  await f.submit(steps);
  let rejection: any;
  await assert.rejects(runNativeAction(f.bot, f.calls[0].action, f.calls[0].signal), (error: any) => {
    rejection = error.details; assert.equal(rejection.dig.reasonCode, 'target_occluded');
    assert.doesNotMatch(JSON.stringify(rejection), /diamond_ore/); return true;
  });
  await f.finish(0, rejection);
  const blocked = f.body.snapshot();
  assert.equal(blocked.replanRequired?.code, 'target_occluded'); assert.equal(blocked.replanRequired?.stepIndex, 0);
  assert.equal(blocked.goalStatus, 'blocked'); assert.equal(blocked.workCompleted, false);
  assert.deepEqual(blocked.completedSteps, []);
  const receipt = f.events.filter(event => event.type === 'skill-finished').at(-1)?.controlEvent.receipt;
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.result.details.destroyedBlock, undefined);
  for (let i = 0; i < 3; i++) await f.tick();
  const renewed = await f.submit(steps);
  assert.equal(renewed.unchanged, true); await f.tick();
  assert.equal(f.calls.length, 1, 'Neither unchanged renewal nor backoff may retry the target or skip to later work.');
  assert.deepEqual(f.body.snapshot().completedSteps, []);
  assert.deepEqual(f.body.snapshot().replanRequired, blocked.replanRequired);
  assert.equal(f.events.filter(event => event.type === 'goal-blocked').length, 1);
});

for (const invalid of ['unloaded', 'unsupported', 'out_of_range'] as const)
test(`an ${invalid} planned shore cannot prevent authorized upward input or survive cancellation`, async t => {
  const f = fixture(true); t.after(() => f.clean());
  f.bot.entity.isInWater = true; f.bot.entity.onGround = false;
  const blockAt = f.bot.blockAt;
  f.bot.blockAt = (p: Vec3) => p.x < 2
    ? { name: 'water', boundingBox: 'empty', position: p }
    : invalid === 'unloaded' ? null : invalid === 'unsupported'
      ? { name: 'air', boundingBox: 'empty', position: p } : blockAt(p);
  const step = { type: 'surface', durationMs: 1000, target: { x: invalid === 'out_of_range' ? 13 : 3, y: 64, z: 0 } };
  await assert.rejects(runContinuousSkill(f.bot, step, new AbortController().signal),
    (error: any) => error.details.stoppedReason === 'shore_unavailable');
  assert.equal(f.bot.getControlState('jump'), false, 'Explicit shore work still rejects the unavailable destination.');
  await f.submit([step], { reactions: ['surface'] });
  assert.equal(f.body.snapshot().current?.skill.reaction, 'surface');
  assert.equal(f.calls[0].action.target, undefined);
  const pending = runContinuousSkill(f.bot, f.calls[0].action, f.calls[0].signal);
  const rejected = assert.rejects(pending);
  assert.equal(f.bot.getControlState('jump'), true, 'Emergency ascent writes real upward input before its next tick.');
  assert.equal(f.bot.getControlState('forward'), false);
  assert.equal(f.body.cancel(f.body.snapshot().version).accepted, true);
  assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.bot.getControlState('jump'), false);
  await rejected; await f.finish(0, {}, 'cancelled'); await f.tick();
  assert.equal(f.calls.length, 1); assert.equal(f.bot.jumpQueued, false);
  assert.deepEqual(f.body.snapshot().completedSteps, []); assert.equal(f.body.snapshot().workCompleted, false);
});

test('emergency ascent preserves blocked shore work and renewal without claiming shore arrival', async t => {
  const f = fixture(true); t.after(() => f.clean());
  const steps = [{ type: 'surface', durationMs: 1000, target: { x: 3, y: 64, z: 0 } }, { type: 'wait', ms: 100 }];
  const extra = { reactions: ['surface'] };
  f.bot.blockAt = (p: Vec3) => ({ name: 'water', boundingBox: 'empty', position: p });
  await f.submit(steps, extra);
  for (let i = 0; i < 3; i++) {
    let details: any;
    await assert.rejects(runContinuousSkill(f.bot, f.calls[i].action, f.calls[i].signal), (error: any) => {
      details = error.details; return details.stoppedReason === 'shore_unavailable';
    });
    await f.finish(i, details); await f.tick();
  }
  const blocked = f.body.snapshot().replanRequired;
  assert.equal(blocked?.code, 'repeated_no_progress'); assert.equal(f.calls.length, 3);
  assert.equal((await f.submit(steps, extra)).unchanged, true);
  f.bot.entity.isInWater = true; f.bot.entity.onGround = false; await f.tick();
  assert.equal(f.calls.length, 4); assert.equal(f.calls[3].action.target, undefined);
  let eyesInAir = false;
  f.bot.blockAt = (p: Vec3) => ({ name: eyesInAir && p.y >= 65 ? 'air' : 'water', boundingBox: 'empty', position: p });
  const write = f.bot.setControlState;
  f.bot.setControlState = (key: string, value: boolean) => { write.call(f.bot, key, value); if (key === 'jump' && value) eyesInAir = true; };
  const details = await runContinuousSkill(f.bot, f.calls[3].action, f.calls[3].signal);
  assert.equal(details.surfaceReached, true); assert.equal(details.shoreReached, false);
  assert.equal(details.breathingConfirmed, false); assert.equal(f.bot.getControlState('jump'), false);
  await f.finish(3, details, 'completed'); f.bot.entity.isInWater = false; await f.tick();
  assert.equal(f.calls.length, 4); assert.deepEqual(f.body.snapshot().replanRequired, blocked);
  assert.deepEqual(f.body.snapshot().completedSteps, []); assert.equal(f.body.snapshot().workCompleted, false);
});

test('a valid shore remains selected and loss of support drains it before vertical fallback', async t => {
  const f = fixture(true); t.after(() => f.clean()); f.bot.entity.isInWater = true;
  const target = { x: 3, y: 64, z: 0 };
  await f.submit([{ type: 'surface', target }], { reactions: ['surface'] });
  assert.deepEqual(f.calls[0].action.target, target);
  f.bot.blockAt = () => null;
  await f.tick(100); await f.tick(300);
  assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.calls.length, 1, 'Single ownership waits for the old receipt.');
  assert.match(String(f.calls[0].signal.reason), /Preempted/);
  await f.finish(0, {}, 'cancelled'); await f.tick();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].action.target, undefined);
  assert.deepEqual(f.body.snapshot().completedSteps, []);
});

test('blocked shore work requests replanning despite vertical bobbing and retains incomplete work', async t => {
  const f = fixture(true); t.after(() => f.clean());
  const steps = [{ type: 'surface', target: { x: 3, y: 64, z: 0 } }, { type: 'wait', ms: 100 }];
  await f.submit(steps);
  f.bot.entity.position.y += .2056237955;
  await f.finish(0, { stoppedReason: 'shore_route_blocked', shoreReached: false, dryGround: false });
  assert.equal(f.body.snapshot().replanRequired?.code, 'shore_route_blocked');
  for (let index = 0; index < 4; index++) await f.tick();
  assert.equal(f.calls.length, 1, 'Neither bobbing nor backoff permits replaying the rejected shore route.');
  assert.deepEqual(f.body.snapshot().completedSteps, []);
  assert.equal(f.body.snapshot().workCompleted, false);
});

test('blocked shore reaction falls back to real authorized ascent and drains on cancellation', async t => {
  const f = fixture(true); t.after(() => f.clean());
  f.bot.entity.isInWater = true; f.bot.entity.onGround = false;
  const blockAt = f.bot.blockAt;
  f.bot.blockAt = (p: Vec3) => p.x < 2 ? { name: 'water', boundingBox: 'empty', position: p } : blockAt(p);
  const target = { x: 3, y: 64, z: 0 };
  await f.submit([{ type: 'surface', target }], { reactions: ['surface'] });
  assert.deepEqual(f.calls[0].action.target, target);
  await f.finish(0, { stoppedReason: 'shore_route_blocked', shoreReached: false });
  await f.tick();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].action.target, undefined, 'A valid destination cannot revive its failed route in the reflex.');
  assert.equal(f.body.snapshot().replanRequired?.code, 'shore_route_blocked');
  const pending = runContinuousSkill(f.bot, f.calls[1].action, f.calls[1].signal);
  const cancelled = assert.rejects(pending);
  assert.equal(f.bot.getControlState('jump'), true, 'Fallback must issue real upward input while submerged.');
  assert.equal(f.body.cancel(f.body.snapshot().version).accepted, true);
  assert.equal(f.calls[1].signal.aborted, true);
  assert.equal(f.bot.getControlState('jump'), false);
  await cancelled; await f.finish(1, {}, 'cancelled'); await f.tick();
  assert.equal(f.calls.length, 2); assert.deepEqual(f.body.snapshot().completedSteps, []);
});

test('blocked shore failure after an append still belongs to the current intent lineage', async t => {
  const f = fixture(true); t.after(() => f.clean()); f.bot.entity.isInWater = true;
  const target = { x: 3, y: 64, z: 0 };
  await f.submit([{ type: 'surface', target }], { reactions: ['surface'] });
  const original = f.body.snapshot(), oldSignal = f.calls[0].signal;
  assert.equal(f.body.append({ expectedVersion: original.version, steps: [{ type: 'wait', ms: 100 }] }).accepted, true);
  assert.equal(oldSignal.aborted, false);
  assert.equal(f.body.snapshot().intent?.id, original.intent?.id);
  assert.ok(f.body.snapshot().version > original.version);
  await f.finish(0, { stoppedReason: 'shore_route_blocked', shoreReached: false });
  await f.tick();
  assert.equal(f.calls[1].action.target, undefined, 'Appending work does not forgive an in-flight failure from the same intent.');
  assert.equal(f.body.snapshot().replanRequired?.code, 'shore_route_blocked');
  assert.deepEqual(f.body.snapshot().completedSteps, []);
});

test('blocked shore stays rejected across unchanged renewal and a refused append', async t => {
  const f = fixture(true); t.after(() => f.clean());
  const steps = [{ type: 'surface', target: { x: 3, y: 64, z: 0 } }], extra = { reactions: ['surface'] };
  await f.submit(steps, extra);
  await f.finish(0, { stoppedReason: 'shore_route_blocked', shoreReached: false });
  assert.equal((await f.submit(steps, extra)).unchanged, true);
  const appended = f.body.append({ expectedVersion: f.body.snapshot().version, steps: [{ type: 'wait', ms: 100 }] });
  assert.equal(appended.accepted, false); assert.equal(appended.reason, 'append_unavailable');
  f.bot.entity.isInWater = true; await f.tick();
  assert.equal(f.calls[1].action.target, undefined);
  assert.equal(f.body.snapshot().replanRequired?.code, 'shore_route_blocked');
  assert.deepEqual(f.body.snapshot().completedSteps, []);
});

test('blocked shore records cannot be created by an old intent late cancelled failure', async t => {
  const f = fixture(true); t.after(() => f.clean()); f.bot.entity.isInWater = true;
  const target = { x: 3, y: 64, z: 0 }, extra = { reactions: ['surface'] };
  await f.submit([{ type: 'surface', target }], extra);
  const previousId = f.body.snapshot().intent?.id;
  await f.submit([{ type: 'surface', target }, { type: 'wait', ms: 100 }], extra);
  assert.notEqual(f.body.snapshot().intent?.id, previousId);
  assert.equal(f.calls[0].signal.aborted, true);
  await f.finish(0, { stoppedReason: 'shore_route_blocked', shoreReached: false }, 'failed');
  await f.tick();
  assert.deepEqual(f.calls[1].action.target, target, 'Cancelled old results must not poison an explicitly new authorization.');
  assert.equal(f.body.snapshot().replanRequired, undefined);
  const receipt = f.events.filter(event => event.type === 'skill-finished').at(-1)?.controlEvent.receipt;
  assert.equal(receipt.status, 'cancelled');
});

test('blocked shore is retried only after an explicitly new intent', async t => {
  const f = fixture(true); t.after(() => f.clean()); f.bot.entity.isInWater = true;
  const steps = [{ type: 'surface', target: { x: 3, y: 64, z: 0 } }], extra = { reactions: ['surface'] };
  await f.submit(steps, extra); const originalId = f.body.snapshot().intent?.id;
  await f.finish(0, { stoppedReason: 'shore_route_blocked', shoreReached: false });
  await f.submit(steps, { ...extra, restart: true });
  await f.tick();
  assert.notEqual(f.body.snapshot().intent?.id, originalId);
  assert.deepEqual(f.calls[1].action.target, steps[0].target);
  assert.equal(f.body.snapshot().replanRequired, undefined);
});

test('blocked shore work cannot create an unauthorized ascent', async t => {
  const f = fixture(true); t.after(() => f.clean());
  await f.submit([{ type: 'surface', target: { x: 3, y: 64, z: 0 } }]);
  await f.finish(0, { stoppedReason: 'shore_route_blocked', shoreReached: false });
  f.bot.entity.isInWater = true;
  for (let index = 0; index < 3; index++) await f.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.body.snapshot().replanRequired?.code, 'shore_route_blocked');
});

test('water and an invalid planned shore do not grant an unauthorized surface reaction', async t => {
  const f = fixture(true); t.after(() => f.clean()); f.bot.entity.isInWater = true;
  const steps = [{ type: 'wait', ms: 100 }, { type: 'surface', target: { x: 13, y: 64, z: 0 } }];
  await f.submit(steps);
  assert.equal(f.calls[0].action.type, 'wait'); assert.equal(f.body.snapshot().current?.skill.reaction, undefined);
});

test('unstarted travel cannot renew its progress allowance through passive vertical water drift', async t => {
  const f = fixture(true); t.after(() => f.clean()); f.bot.entity.onGround = false;
  const steps = [{ type: 'travel', x: 4, z: 0 }, { type: 'wait', ms: 100 }], extra = { reactions: ['surface'] };
  await f.submit(steps, extra);
  for (let i = 0; i < 3; i++) {
    const pending = runNativeAction(f.bot, f.calls[i].action, f.calls[i].signal);
    f.bot.entity.position.y += .4;
    let details: any;
    await assert.rejects(pending, (error: any) => {
      details = error.details;
      assert.equal(details.travel.stoppedReason, 'not_grounded');
      for (const key of ['plans', 'nodes', 'legs']) assert.equal(details.travel.planning[key], 0);
      assert.equal(details.travel.partial, true, 'The truthful physical displacement remains in the receipt.');
      return true;
    });
    await f.finish(i, details); await f.tick();
  }
  const blocked = f.body.snapshot().replanRequired;
  assert.equal(blocked?.code, 'repeated_no_progress'); assert.equal(f.calls.length, 3);
  assert.equal(f.bot.entity.position.x, 0); assert.equal(f.bot.entity.position.z, 0);
  assert.deepEqual(f.body.snapshot().completedSteps, []); assert.equal(f.body.snapshot().workCompleted, false);
  assert.equal((await f.submit(steps, extra)).unchanged, true); await f.tick();
  assert.equal(f.calls.length, 3); assert.deepEqual(f.body.snapshot().replanRequired, blocked);
  f.bot.entity.isInWater = true; await f.tick();
  assert.equal(f.calls[3].action.type, 'surface', 'Suspending failed travel must retain authorized self-preservation.');
});

for (const [label, displacement, planning, outer] of [
  ['horizontal movement', new Vec3(.2, .4, 0), { plans: 0, nodes: 0, legs: 0 }, undefined],
  ['an executed navigation leg', new Vec3(0, .4, 0), { plans: 1, nodes: 2, legs: 1 }, undefined],
  ['missing execution evidence', new Vec3(0, .4, 0), undefined, undefined],
  ['a different current typed result', new Vec3(0, .4, 0), { plans: 0, nodes: 0, legs: 0 }, 'server_unconfirmed'],
] as const) test(`water progress correction preserves ${label}`, async t => {
  const f = fixture(true); t.after(() => f.clean());
  await f.submit([{ type: 'travel', x: 4, z: 0 }]);
  for (let i = 0; i < 3; i++) {
    f.bot.entity.position = f.bot.entity.position.plus(displacement);
    await f.finish(i, { ...(outer ? { stoppedReason: outer } : {}), travel: { stoppedReason: 'not_grounded', planning } });
    await f.tick();
  }
  assert.equal(f.body.snapshot().replanRequired, undefined); assert.equal(f.calls.length, 4);
});

for (const [label, current, expected] of [
  ['outer cancellation', { stoppedReason: 'cancelled' }, undefined],
  ['outer current prerequisite', { stoppedReason: 'missing_prerequisites' }, 'missing_prerequisites'],
  ['outer current transient failure', { stoppedReason: 'server_unconfirmed' }, undefined],
  ['navigation current transient failure', { navigation: { stoppedReason: 'not_grounded' } }, undefined],
] as const) test(`historical dig evidence cannot override ${label}`, async t => {
  const f = fixture(true); t.after(() => f.clean());
  await f.submit([{ type: 'dig', x: 1, y: 64, z: 0 }]);
  await f.finish(0, { ...current, dig: { reasonCode: 'target_occluded' } });
  assert.equal(f.body.snapshot().replanRequired?.code, expected);
  assert.deepEqual(f.body.snapshot().completedSteps, []);
});

test('mechanism ablation: an exhausted flee authorization cannot spin at the same limit', async t => {
  for (const optimized of [false, true]) {
    const f = fixture(optimized); t.after(() => f.clean());
    f.bot.health = 4; f.bot.entities[9] = { id: 9, name: 'zombie', health: 20, width: .6, height: 1.8, position: new Vec3(2, 64, 0) };
    await f.submit([], { reactions: ['flee', 'surface'], policy: { retreatHealth: 6, threatRange: 7, chaseRange: 1 } });
    assert.equal(f.calls[0]?.action.type, 'retreat'); await f.finish(0, { stoppedReason: 'distance_limit', distance: 1 });
    for (let index = 0; index < 3; index++) {
      await f.tick(); if (f.calls.length > index + 1) await f.finish(index + 1, { stoppedReason: 'distance_limit', distance: 1 });
    }
    assert.equal(f.calls.length, optimized ? 1 : 4);
    assert.equal(f.body.snapshot().reactionBlocked?.length ?? 0, optimized ? 1 : 0);
    if (optimized) {
      f.bot.entity.isInWater = true; await f.tick();
      assert.equal(f.calls.at(-1)?.action.type, 'surface', 'A bounded flee failure must retain independent authorized lifesaving reactions.');
    }
  }
});

for (const mode of ['work', 'reaction'] as const) test(`blocked retreat ${mode} cannot reset retry limits through vertical bouncing`, async t => {
  const f = fixture(true); t.after(() => f.clean());
  f.bot.health = 4;
  f.bot.entities[9] = { id: 9, name: 'zombie', health: 20, width: .6, height: 1.8, position: new Vec3(2, 64, 0) };
  const steps = mode === 'work' ? [{ type: 'retreat', entityId: 9, maxDistance: 8 }] : [];
  const extra = { reactions: mode === 'work' ? ['surface'] : ['flee', 'defend', 'surface'], policy: { retreatHealth: 6, threatRange: 7, chaseRange: 8 } };
  await f.submit(steps, extra);
  for (let i = 0; i < 3; i++) {
    assert.equal(f.calls[i]?.action.type, 'retreat');
    f.bot.entity.position.y = i % 2 === 0 ? 64.42 : 64;
    await f.finish(i, { stoppedReason: 'retreat_blocked' }); await f.tick();
  }
  if (mode === 'work') {
    assert.equal(f.body.snapshot().replanRequired?.code, 'repeated_no_progress');
    assert.deepEqual(f.body.snapshot().completedSteps, []);
    assert.equal(f.calls.length, 3);
    assert.equal((await f.submit(steps, extra)).unchanged, true);
    await f.tick(); assert.equal(f.calls.length, 3);
  } else {
    assert.equal(f.body.snapshot().reactionBlocked?.find(r => r.reaction === 'flee')?.code, 'repeated_no_progress');
    assert.equal(f.calls[3]?.action.type, 'combat', 'Independent authorized defense remains available.');
    await f.finish(3, { attempts: 1 }, 'completed');
  }
  f.bot.entity.isInWater = true; await f.tick();
  assert.equal(f.calls.at(-1)?.action.type, 'surface', 'Blocking repeated retreat must not revoke independent emergency ascent.');
});

for (const [label, type, status, code, displacement] of [
  ['lateral retreat progress', 'retreat', 'failed', 'retreat_blocked', new Vec3(.2, 0, 0)],
  ['successful vertical retreat', 'retreat', 'completed', 'time_limit', new Vec3(0, .3, 0)],
  ['another retreat outcome', 'retreat', 'failed', 'time_limit', new Vec3(0, .3, 0)],
  ['vertical combat movement', 'combat', 'failed', 'retreat_blocked', new Vec3(0, .3, 0)],
] as const) test(`blocked retreat correction preserves ${label}`, async t => {
  const f = fixture(true); t.after(() => f.clean());
  f.bot.health = type === 'retreat' ? 4 : 20;
  f.bot.entities[9] = { id: 9, name: 'zombie', health: 20, width: .6, height: 1.8, position: new Vec3(2, 64, 0) };
  await f.submit([], { reactions: type === 'retreat' ? ['flee'] : ['defend'], policy: { retreatHealth: 6, threatRange: 7, chaseRange: 8 } });
  for (let i = 0; i < 3; i++) {
    assert.equal(f.calls[i]?.action.type, type);
    f.bot.entity.position = f.bot.entity.position.plus(displacement);
    await f.finish(i, { stoppedReason: code }, status); await f.tick();
  }
  assert.equal(f.body.snapshot().reactionBlocked?.length ?? 0, 0);
  assert.equal(f.calls.length, 4);
});

test('terminal full-task plan suppresses unnecessary top-up but append preserves a running skill', async t => {
  const f = fixture(true); t.after(() => f.clean());
  await f.submit([{ type: 'wait', ms: 1000 }], { terminal: true });
  assert.equal(f.body.snapshot().planningNeeded, false);
  assert.equal(f.events.filter(event => event.type === 'planning-needed').length, 0);
  const started = f.calls[0], state = f.body.snapshot();
  const accepted = f.body.append({ expectedVersion: state.version, steps: [{ type: 'wait', ms: 500 }], terminal: true });
  assert.equal(accepted.accepted, true); assert.equal(started.signal.aborted, false);
  assert.equal(f.calls.length, 1); assert.equal(f.body.snapshot().intent?.id, state.intent?.id);
  await f.finish(0, {}, 'completed'); await f.tick();
  assert.equal(f.calls.length, 2); assert.deepEqual(f.body.snapshot().completedSteps, [0]);
});

test('measured slow planning can request top-up before a fixed two-step threshold', async t => {
  const f = fixture(true); t.after(() => f.clean()); f.body.recordPlanningLatency(18000);
  await f.submit([{ type: 'wait', ms: 500 }, { type: 'wait', ms: 500 }, { type: 'wait', ms: 500 }]);
  const snapshot = f.body.snapshot();
  assert.equal(snapshot.remainingSteps, 3); assert.equal(snapshot.planningNeeded, true);
  assert.ok(snapshot.planningHorizonMs >= 18000); assert.ok(snapshot.remainingWorkMs! < snapshot.planningHorizonMs);
  assert.equal(f.events.filter(event => event.type === 'planning-needed').length, 1);
});

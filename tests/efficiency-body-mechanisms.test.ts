/** Deterministic production-body mechanism checks, not real Minecraft or Agent scores. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { MinecraftBody } from '../adapters/minecraft/src/minecraft-body.ts';
import { MinecraftWorld, type BotRecord } from '../adapters/minecraft/src/world.ts';
import { runContinuousSkill } from '../adapters/minecraft/src/continuous-skills.ts';
import { runNativeAction } from '../adapters/minecraft/src/native-actions.ts';

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
    async tick() { now += 10000; body.controller.tick(); await flush(); },
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import registryFactory from 'prismarine-registry';
import blockFactory from 'prismarine-block';
import { PlayerState } from 'prismarine-physics';
import installPhysics from '../node_modules/mineflayer/lib/plugins/physics.js';
import { IdleWaterPosture, WATER_POSTURE_MAX_MS } from '../adapters/minecraft/src/idle-water-posture.ts';
import mineflayer from 'mineflayer';
import { MinecraftWorld } from '../adapters/minecraft/src/world.ts';
import { action } from '../adapters/minecraft/src/validation.ts';
import { setTimeout as delay } from 'node:timers/promises';

function fixture(t: any) {
  const registry = registryFactory('1.21.4'), Block = blockFactory(registry), bot: any = new EventEmitter();
  let wet = true, unloaded = false;
  bot.version = '1.21.4'; bot.registry = registry; bot.supportFeature = registry.supportFeature;
  bot._client = Object.assign(new EventEmitter(), { state: 'play', write: () => {} });
  bot.game = { gameMode: 'survival' }; bot.health = 20; bot.oxygenLevel = 17;
  bot.inventory = { slots: [] };
  bot.entity = { position: new Vec3(.5, 64, .5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0,
    onGround: false, isInWater: true, isInLava: false, effects: {}, attributes: {} };
  bot.blockAt = (p: Vec3) => {
    if (unloaded) return null;
    const name = p.y < 64 ? 'stone' : wet && p.y < 67 ? 'water' : 'air';
    const block = Block.fromStateId(registry.blocksByName[name].defaultState, 0);
    block.position = p.floored(); return block;
  };
  // Install the actual control implementation, but do not login or start any
  // network/physics interval. Tests explicitly advance the native physics.
  installPhysics(bot, { physicsEnabled: true });
  const priorListeners = Object.fromEntries(['physicsTick', 'forcedMove', 'death', 'respawn', 'end', 'kicked']
    .map(event => [event, bot.listenerCount(event)]));
  const posture = new IdleWaterPosture(bot);
  t.after(() => { posture.dispose(); bot.emit('end'); });
  const step = () => { bot.physics.simulatePlayer(new PlayerState(bot, bot.controlState), { getBlock: bot.blockAt }).apply(bot); bot.emit('physicsTick'); };
  return { bot, posture, priorListeners, step, dry: () => { wet = false; }, unload: () => { unloaded = true; } };
}

test('posture is opt-in; native jump raises a submerged idle body without changing oxygen or choosing a direction', t => {
  const { bot, posture, step } = fixture(t);
  bot.emit('physicsTick'); assert.equal(bot.getControlState('jump'), false);
  assert.equal(posture.snapshot().mode, 'none');
  const before = bot.entity.position.clone(), velocity = bot.entity.velocity.clone();
  const state = posture.enable(60000);
  assert.equal(state.active, true); assert.equal(bot.getControlState('jump'), true);
  assert.equal(bot.jumpQueued, true, 'Installed Mineflayer queues a newly pressed jump.');
  assert.ok(bot.entity.position.equals(before)); assert.ok(bot.entity.velocity.equals(velocity));
  step();
  assert.ok(bot.entity.position.y > before.y, 'Only native physics should produce upward motion.');
  assert.equal(bot.entity.position.x, before.x); assert.equal(bot.entity.position.z, before.z);
  assert.equal(bot.oxygenLevel, 17);
  for (const input of ['forward', 'back', 'left', 'right', 'sprint', 'sneak']) assert.equal(bot.getControlState(input), false);
});

test('suspend relinquishes only its own jump; active movement and its queued jump survive ticks, expiry and disable', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const { bot, posture } = fixture(t);
  posture.enable(100); posture.suspend();
  assert.equal(bot.getControlState('jump'), false); assert.equal(bot.jumpQueued, false);
  bot.setControlState('jump', true); bot.setControlState('forward', true);
  bot.emit('physicsTick'); posture.disable(); t.mock.timers.tick(101);
  assert.equal(bot.getControlState('jump'), true); assert.equal(bot.jumpQueued, true);
  assert.equal(bot.getControlState('forward'), true);
  posture.enable(1000); bot.emit('physicsTick');
  assert.equal(posture.snapshot().active, false, 'Enabling during an action does not steal input.');
  bot.clearControlStates(); bot.jumpQueued = false;
  posture.resume(); assert.equal(bot.getControlState('jump'), true);
  assert.equal(posture.snapshot().active, true);
});

test('a forced move onto dry land clears the owned native queue despite stale water state and cannot cause a ground jump', t => {
  const { bot, posture, dry, step } = fixture(t);
  posture.enable(1000); assert.equal(bot.jumpQueued, true);
  dry(); bot.entity.onGround = true;
  assert.equal(bot.entity.isInWater, true, 'The previous physics flag is intentionally stale.');
  bot.emit('forcedMove');
  assert.equal(bot.getControlState('jump'), false); assert.equal(bot.jumpQueued, false);
  assert.equal(posture.snapshot().active, false);
  const height = bot.entity.position.y; step();
  assert.equal(bot.entity.position.y, height); assert.ok(bot.entity.velocity.y <= 0);
  assert.equal(posture.snapshot().mode, 'tread_water', 'The explicit lease remains bounded while paused outside water.');
});

test('expiry is wall-clock bounded even without physics ticks and only explicit enable renews it', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const { bot, posture } = fixture(t);
  posture.enable(1000); t.mock.timers.tick(400);
  posture.suspend(); posture.resume();
  assert.equal(posture.snapshot().remainingMs, 600);
  t.mock.timers.tick(600);
  assert.equal(posture.snapshot().mode, 'none'); assert.equal(posture.snapshot().active, false);
  assert.equal(bot.getControlState('jump'), false); assert.equal(bot.jumpQueued, false);
  bot.emit('physicsTick'); assert.equal(bot.getControlState('jump'), false);
  for (const duration of [0, -1, NaN, Infinity, 1.5, WATER_POSTURE_MAX_MS + 1]) assert.throws(() => posture.enable(duration));
});

test('death, respawn and disconnect revoke authorization; dispose removes only posture listeners', t => {
  const { bot, posture, priorListeners } = fixture(t);
  for (const event of ['death', 'respawn', 'end', 'kicked']) {
    posture.enable(1000); assert.equal(bot.getControlState('jump'), true);
    bot.emit(event); bot.emit('physicsTick');
    assert.equal(posture.snapshot().mode, 'none'); assert.equal(bot.getControlState('jump'), false); assert.equal(bot.jumpQueued, false);
  }
  posture.enable(1000); posture.dispose(); posture.dispose();
  for (const [event, count] of Object.entries(priorListeners)) assert.equal(bot.listenerCount(event), count);
  assert.throws(() => posture.enable());
});

test('unknown/dry/lava body contact never presses jump or alters an input already owned elsewhere', t => {
  const { bot, posture, unload } = fixture(t);
  bot.setControlState('jump', true); posture.enable(1000); posture.disable();
  assert.equal(bot.getControlState('jump'), true); assert.equal(bot.jumpQueued, true);
  bot.clearControlStates(); bot.jumpQueued = false;
  bot.entity.isInLava = true; posture.enable(1000);
  assert.equal(bot.getControlState('jump'), false);
  bot.entity.isInLava = false; unload(); bot.emit('physicsTick');
  assert.equal(bot.getControlState('jump'), false);
});

function worldFixture(t: any) {
  const f = fixture(t), { bot } = f;
  f.posture.dispose();
  bot.inventory.items = () => []; bot.entities = {}; bot.food = 20;
  bot.entity.id = 1; bot.entity.name = 'player'; bot.game.dimension = 'overworld';
  bot.stopDigging = () => {}; bot.quit = () => bot.emit('end');
  t.mock.method(mineflayer, 'createBot', () => bot);
  const world = new MinecraftWorld({ host: 'unused', port: 0, version: '1.21.4', logDirectory: 'unused' });
  // This test exercises the real add/execute/stop ownership lifecycle. Disk
  // logging has separate coverage and should not create world artifacts here.
  t.mock.method(world, 'event', (record: any, type: string, data: any) => {
    const event = { type, ...data }; record.events.push(event); return event;
  });
  const record = world.add('Tester', 'test'); bot.emit('spawn');
  record.task = { id: 'thinking-task', controller: new AbortController() };
  t.after(() => world.close());
  return { ...f, world, record, posture: record.waterPosture!,
    execute: (proposal: any) => world.execute('Tester', proposal, 'thinking-task') };
}

test('world execution preserves chosen posture during reasoning, lends inputs to an action, then resumes', async t => {
  const { bot, record, posture, execute, step } = worldFixture(t);
  const result = await execute({ type: 'posture', mode: 'tread_water', durationMs: 60000 });
  assert.equal(result.status, 'completed'); assert.equal(record.actionController, undefined);
  assert.ok(record.task, 'A thinking task is present but does not own the body.');
  assert.equal(posture.snapshot().active, true); assert.equal(bot.getControlState('jump'), true);
  const moving = execute({ type: 'move', controls: ['forward', 'jump'], ms: 40 });
  await delay(5);
  assert.ok(record.actionController); assert.equal(posture.snapshot().suspended, true);
  assert.equal(posture.snapshot().active, false); assert.equal(bot.getControlState('jump'), true, 'The active movement owns this jump.');
  bot.emit('physicsTick'); assert.equal(bot.getControlState('forward'), true);
  assert.equal((await moving).status, 'completed');
  step(); // Consume the completed move's queued input through native physics.
  assert.equal(record.actionController, undefined); assert.equal(posture.snapshot().active, true);
  assert.equal(bot.getControlState('forward'), false);
  assert.equal((await execute({ type: 'stop' })).status, 'completed');
  assert.equal(posture.snapshot().mode, 'none'); assert.equal(bot.getControlState('jump'), false);
  assert.equal(record.task!.controller.signal.aborted, false, 'An NPC stop does not cancel its reasoning task.');
});

test('world death and close revoke posture without a finally-resume resurrecting the lease', async t => {
  const { world, bot, record, posture, execute } = worldFixture(t);
  await execute({ type: 'posture', mode: 'tread_water', durationMs: 60000 });
  const pending = execute({ type: 'wait', ms: 5000 });
  bot.emit('death');
  assert.equal((await pending).status, 'cancelled');
  assert.equal(record.task!.controller.signal.aborted, true);
  assert.equal(posture.snapshot().mode, 'none'); assert.equal(bot.getControlState('jump'), false);
  record.task = undefined; record.ready = true;
  await world.execute('Tester', { type: 'posture', mode: 'tread_water', durationMs: 60000 });
  assert.equal(posture.snapshot().active, true);
  world.close(); bot.emit('physicsTick');
  assert.equal(posture.snapshot().mode, 'none'); assert.equal(bot.getControlState('jump'), false);
  assert.throws(() => posture.enable(1000), /disposed/);
});

test('world permits a chosen fishing wait beyond fifteen seconds and holds the body until cancellation reels the hook', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const { world, bot, record, posture, execute } = worldFixture(t);
  const rod = { name: 'fishing_rod', count: 1 };
  bot.inventory.items = () => [rod]; bot.heldItem = rod;
  bot.canSeeBlock = () => true; bot.world = { raycast: () => null };
  bot.lookAt = async () => {}; bot._syncWindow = async () => {};
  bot._client.write = (name: string) => { if (name === 'client_command') bot._client.emit('statistics', {}); };
  let clicks = 0;
  bot.activateItem = () => {
    if (++clicks === 1) bot._client.emit('spawn_entity', {
      entityId: 41, type: bot.registry.entitiesByName.fishing_bobber.id, objectData: bot.entity.id,
    });
  };
  await execute({ type: 'posture', mode: 'tread_water', durationMs: 60000 });
  let settled = false;
  const pending = execute({ type: 'fish', position: { x: 2, y: 65, z: 0 }, durationMs: 30000 })
    .finally(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(clicks, 1); assert.equal(posture.snapshot().suspended, true);
  t.mock.timers.tick(16000);
  assert.equal(record.actionController?.signal.aborted, false, 'The old generic fifteen-second limit must not cancel fishing.');
  assert.equal(settled, false);
  world.stop(record);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(clicks, 2, 'Cancellation retracts the one known hook.');
  assert.equal(settled, false, 'Sending the reel is not server acknowledgement.');
  await assert.rejects(world.execute('Tester', { type: 'wait', ms: 1 }), /正在执行/);
  bot._client.emit('entity_destroy', { entityIds: [41] });
  const result = await pending;
  assert.equal(result.status, 'cancelled'); assert.equal(record.actionController, undefined);
  assert.equal(result.details.hookRemoved, true); assert.equal(posture.snapshot().mode, 'none');
  assert.equal(clicks, 2, 'No later cast may outlive the cancelled action.');
});

test('posture and pursuit APIs reject ambiguous modes, invalid booleans and unbounded leases', () => {
  assert.deepEqual(action({ type: 'posture', mode: 'tread_water' }), { type: 'posture', mode: 'tread_water', durationMs: 60000 });
  assert.deepEqual(action({ type: 'posture', mode: 'none' }), { type: 'posture', mode: 'none' });
  for (const value of [0, 120001, NaN, '1000', 1.5]) assert.throws(() => action({ type: 'posture', mode: 'tread_water', durationMs: value }));
  for (const mode of ['auto', 'fly', null]) assert.throws(() => action({ type: 'posture', mode }));
  assert.throws(() => action({ type: 'posture', mode: 'none', durationMs: 1000 }));
  for (const follow of ['true', 1, null]) assert.throws(() => action({ type: 'attack', entityId: 42, follow }));
  assert.equal(action({ type: 'attack', entityId: 42, follow: true }).follow, true);
});

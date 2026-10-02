import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import { MinecraftWorld } from '../adapters/minecraft/src/world.ts';
import { NpcScheduler } from '../packages/bridge/src/npc-scheduler.ts';
import { SurvivalScenario, SURVIVAL_ROSTER } from '../adapters/minecraft/src/survival-scenario.ts';
import { captureInitialSurvivalState, survivalActorsReady } from '../adapters/minecraft/src/survival-readiness.ts';
import { quarantineInventorySession } from '../adapters/minecraft/src/craft-sync.ts';

type Item = { name: string; count: number };
function fakeWorld() {
  const bots = new Map(SURVIVAL_ROSTER.map(actor => [actor.name as string, {
    name: actor.name as string, ready: true, inventorySynced: true,
    bot: { inventory: { slots: Array<Item | null>(46).fill(null) } },
  }]));
  return {
    bots,
    observe(name: string) {
      return { name, inventory: bots.get(name)!.bot.inventory.slots.slice(9, 45).filter(item => item !== null), dimension: 'overworld', health: 20, food: 20 };
    },
  };
}
async function fixture(t: TestContext) {
  const parent = resolve(tmpdir()), directory = await mkdtemp(join(parent, 'anima-survival-boot-test-'));
  const scenario = new SurvivalScenario(directory, () => { throw new Error('These integration tests cannot execute server commands.'); });
  await scenario.restore();
  t.after(async () => {
    await scenario.persistence;
    assert.equal(dirname(resolve(directory)), parent);
    assert.ok(resolve(directory).startsWith(join(parent, 'anima-survival-boot-test-')));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, scenario, world: fakeWorld() };
}
async function flush() { for (let i = 0; i < 16; i += 1) await Promise.resolve(); }
async function waitFor(condition: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'The expected asynchronous scheduler state did not arrive within the test deadline.');
    await delay(5);
  }
}

test('boot requires the exact four actors, spawned and inventory-synchronized', () => {
  const world = fakeWorld();
  assert.equal(survivalActorsReady(world.bots.values()), true);
  const first = world.bots.get('Sheldon')!;
  first.inventorySynced = false;
  assert.equal(survivalActorsReady(world.bots.values()), false, 'Default empty slots before the server inventory packet are not proof.');
  first.inventorySynced = true; first.ready = false;
  assert.equal(survivalActorsReady(world.bots.values()), false);
  first.ready = true;
  world.bots.delete('HuYifei');
  assert.equal(survivalActorsReady(world.bots.values()), false);
  world.bots.set('Stranger', { ...first, name: 'Stranger' });
  assert.equal(survivalActorsReady(world.bots.values()), false, 'Four arbitrary online players do not constitute the configured roster.');
});

test('an unsynchronized actor prevents both partial spawn audits and model dispatch', async t => {
  const f = await fixture(t); let calls = 0;
  f.world.bots.get('HuYifei')!.inventorySynced = false;
  const scheduler = new NpcScheduler({
    getActors: () => [...f.world.bots.values()].map(actor => ({ ...actor, busy: false })),
    run: async () => { calls += 1; return { status: 'completed' }; }, cancel: () => {},
    scenarioStatus: () => ({ complete: f.scenario.status().complete }),
    now: () => 1000,
  });
  t.after(() => scheduler.stop());
  assert.throws(() => {
    captureInitialSurvivalState(f.world, f.scenario);
    f.scenario.start(); scheduler.start();
  }, /synchronize/u);
  await flush();
  assert.deepEqual(f.scenario.status().progress.initialInventory, {});
  assert.equal(calls, 0);
  assert.equal(scheduler.status().phase, 'idle');
});

test('all observations are read before committing any initial inventory record', async t => {
  const f = await fixture(t);
  const observe = f.world.observe;
  f.world.observe = name => { if (name === 'HuYifei') throw new Error('Actor disconnected while reading world.'); return observe(name); };
  assert.throws(() => captureInitialSurvivalState(f.world, f.scenario), /disconnected/u);
  assert.deepEqual(f.scenario.status().progress.initialInventory, {});
});

test('a full-slot armor item blocks a first start even though all main inventory lists are empty', async t => {
  const f = await fixture(t); let calls = 0;
  f.world.bots.get('Sherlock')!.bot.inventory.slots[5] = { name: 'iron_helmet', count: 1 };
  assert.deepEqual(f.world.observe('Sherlock').inventory, []);
  assert.throws(() => {
    captureInitialSurvivalState(f.world, f.scenario);
    calls += 1;
  }, /not all empty/u);
  assert.equal(calls, 0);
  assert.equal(f.scenario.status().progress.initialInventory.Sherlock.itemCount, 1);
  assert.equal(f.scenario.status().progress.initialInventory.Sherlock.source, 'fullInventory');
});

test('four synchronized empty spawns permit four autonomous model tasks, which cancel when the world stops', async t => {
  const f = await fixture(t), calls: { name: string; signal?: AbortSignal }[] = [];
  captureInitialSurvivalState(f.world, f.scenario); f.scenario.start();
  const cancelled: string[] = [];
  const scheduler = new NpcScheduler({
    getActors: () => [...f.world.bots.values()].map(actor => ({ ...actor, busy: false })),
    run(name, _instruction, signal) {
      calls.push({ name, signal });
      return new Promise(resolve => signal!.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true }));
    },
    cancel: name => { cancelled.push(name); },
    scenarioStatus: () => ({ complete: f.scenario.status().complete }), objective: f.scenario.publicContext().objective,
    now: () => 1000, pollMs: 60000, stopWaitMs: 30,
  });
  t.after(() => scheduler.stop()); scheduler.start(); scheduler.tick();
  await waitFor(() => calls.length === 4);
  assert.deepEqual(calls.map(call => call.name), SURVIVAL_ROSTER.map(actor => actor.name));
  assert.equal(scheduler.status().activeTasks, 4);
  for (const actor of f.world.bots.values()) actor.ready = false;
  await scheduler.stop(); await f.scenario.stop(); await flush();
  assert.ok(calls.every(call => call.signal?.aborted));
  assert.equal(cancelled.length, 4);
  scheduler.tick(); await flush();
  assert.equal(calls.length, 4, 'A failed world cannot keep consuming model requests.');
  assert.equal(scheduler.status().phase, 'stopped');
});

test('resuming the same world preserves inventory, world identity and the original empty-handed proof', async t => {
  const f = await fixture(t);
  captureInitialSurvivalState(f.world, f.scenario); f.scenario.start();
  f.world.bots.get('Sheldon')!.bot.inventory.slots[36] = { name: 'oak_log', count: 8 };
  f.scenario.observe('Sheldon', f.world.observe('Sheldon')); await f.scenario.persist();
  const before = f.scenario.status();
  const resumed = new SurvivalScenario(f.directory, () => {}); await resumed.restore();
  captureInitialSurvivalState(f.world, resumed); resumed.start(); await resumed.persistence;
  assert.equal(resumed.status().worldId, before.worldId);
  assert.deepEqual(resumed.status().progress.initialInventory, before.progress.initialInventory);
  assert.equal(resumed.status().progress.actors.Sheldon.inventory[0].count, 8);
  assert.equal(resumed.status().complete, false, 'Obtaining resources does not complete the continuous goal.');
});

test('routine monitoring may update an online actor without overwriting the original spawn audit', async t => {
  const f = await fixture(t);
  captureInitialSurvivalState(f.world, f.scenario); f.scenario.start();
  const initial = f.scenario.status().progress.initialInventory;
  f.world.bots.get('HuYifei')!.ready = false;
  f.world.bots.get('Deadpool')!.bot.inventory.slots[36] = { name: 'cobblestone', count: 6 };
  // The existing periodic monitor intentionally uses observe(), not the startup gate.
  for (const actor of f.world.bots.values()) if (actor.ready) f.scenario.observe(actor.name, f.world.observe(actor.name));
  assert.equal(f.scenario.status().progress.actors.Deadpool.inventory[0].count, 6);
  assert.deepEqual(f.scenario.status().progress.initialInventory, initial);
  assert.equal(f.scenario.status().phase, 'running');
});

test('the public scenario port exposes the complete goal and ordinary rules, not global private observations', async t => {
  const f = await fixture(t);
  captureInitialSurvivalState(f.world, f.scenario);
  f.scenario.observe('Sherlock', { inventory: [{ name: 'private_marker_item', count: 1 }], position: { x: 123456, y: 64, z: 234567 }, dimension: 'overworld' });
  const serialized = JSON.stringify(f.scenario.publicContext());
  assert.ok(serialized.includes('下界') && serialized.includes('末地') && serialized.includes('空手'));
  assert.ok(!serialized.includes('private_marker_item'));
  assert.ok(!serialized.includes('123456'));
  assert.ok(!serialized.includes('progress'));
});

test('quarantined inventory is hidden from observations and summaries and cannot regain factual action deltas', async t => {
  const f = await fixture(t);
  let count = 1;
  const bot: any = { entity: { id: 1, position: new Vec3(0, 64, 0) }, entities: {}, health: 18, food: 17,
    game: { dimension: 'overworld' }, time: { timeOfDay: 1 }, findBlocks: () => [],
    inventory: { items: () => [{ name: 'diamond', count }], slots: [] },
    chat: () => { count = 64; } };
  const world = new MinecraftWorld({ host: '127.0.0.1', port: 25565, version: '1.21.4', logDirectory: f.directory });
  world.event = (_record, type, data) => ({ type, ...data });
  const record: any = { name: 'Sheldon', ready: true, persona: 'test', bot, events: [] };
  world.bots.set(record.name, record);
  assert.equal(world.observe('Sheldon').inventory?.[0].count, 1);
  quarantineInventorySession(bot);
  const observed = world.observe('Sheldon');
  assert.equal(observed.inventoryConfirmed, false);
  assert.equal(observed.inventory, undefined);
  assert.equal(observed.equipment, undefined);
  assert.equal(observed.health, 18);
  assert.equal(world.summary(record).inventory, undefined);
  const receipt: any = await world.execute('Sheldon', { type: 'say', message: 'test' });
  assert.equal(receipt.details.inventoryConfirmed, false);
  assert.deepEqual(receipt.details.inventoryDelta, []);
  assert.deepEqual(receipt.details.unconfirmedInventoryDelta, [{ item: 'diamond', change: 63 }]);
});

test('the real adapter marks inventory synchronized only after a full player packet has been applied', async t => {
  const f = await fixture(t);
  const bot: any = new EventEmitter();
  bot._client = new EventEmitter();
  bot.inventory = { slots: Array(46).fill(null) };
  bot.entity = { position: new Vec3(0, 64, 0) }; bot.game = { dimension: 'overworld' };
  t.mock.method(mineflayer, 'createBot', () => bot);
  const world = new MinecraftWorld({ host: '127.0.0.1', port: 25565, version: '1.21.4', logDirectory: f.directory });
  // Lifecycle logging is irrelevant here; no server or filesystem event writer runs.
  world.event = (_record, type, data) => ({ type, ...data });
  const record = world.add('Sheldon', 'test');
  bot.emit('spawn');
  assert.equal(record.ready, true);
  assert.equal(record.inventorySynced, false);
  bot._client.emit('window_items', { windowId: 1 }); await flush();
  assert.equal(record.inventorySynced, false, 'A container window does not prove player inventory synchronization.');
  bot._client.on('window_items', (packet: any) => {
    if (packet.windowId === 0) bot.inventory.slots[5] = { name: 'iron_helmet', count: 1 };
  });
  bot._client.emit('window_items', { windowId: 0 });
  assert.equal(record.inventorySynced, false, 'Readiness waits for all listeners of this packet.');
  await flush();
  assert.equal(record.inventorySynced, true);
  assert.equal(bot.inventory.slots[5].name, 'iron_helmet');
});

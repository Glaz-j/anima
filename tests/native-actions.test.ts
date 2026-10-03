import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import mineflayer from 'mineflayer';
import minecraftData from 'minecraft-data';
import loadBlock from 'prismarine-block';
import registryFactory from 'prismarine-registry';
import itemFactory from 'prismarine-item';
import installInventory from '../node_modules/mineflayer/lib/plugins/inventory.js';
import installGenericPlace from '../node_modules/mineflayer/lib/plugins/generic_place.js';
import installPlaceBlock from '../node_modules/mineflayer/lib/plugins/place_block.js';
import WorldSync from '../node_modules/prismarine-world/src/worldsync.js';
import { Vec3 } from 'vec3';
import { action } from '../adapters/minecraft/src/validation.ts';
import { MinecraftWorld } from '../adapters/minecraft/src/world.ts';
import { entityHealth, entityVisible, meleeTarget, nativeWalkTo, runNativeAction, solveBowShot } from '../adapters/minecraft/src/native-actions.ts';

function fakeBot() {
  const bot: any = new EventEmitter();
  bot._client = new EventEmitter();
  bot._client.state = 'play';
  bot.loadPlugin = (plugin: (bot: any) => void) => plugin(bot);
  bot._client.write = (name: string) => {
    if (name === 'client_command') queueMicrotask(() => bot._client.emit('statistics', { entries: [] }));
  };
  bot._syncWindow = async () => {};
  bot.entity = { id: 1, position: new Vec3(0, 64, 0), eyeHeight: 1.62, onGround: true, velocity: new Vec3(0, 0, 0) };
  bot.version = '1.21.4'; bot.game = { dimension: 'the_end', gameMode: 'survival' };
  bot.entities = {}; bot.players = {}; bot.health = 20; bot.food = 15; bot.time = { timeOfDay: 0 };
  bot.world = { raycast: () => null }; bot.controls = {}; bot.attacks = [];
  bot.inventory = { slots: [], items: () => [{ name: 'stone', count: 64 }, { name: 'bow', count: 1 }, { name: 'arrow', count: 64 }] };
  bot.setControlState = (key: string, value: boolean) => { bot.controls[key] = value; };
  bot.getControlState = (key: string) => bot.controls[key] === true;
  bot.clearControlStates = () => { bot.controls = {}; };
  bot.stopDigging = () => {}; bot.lookAt = async () => {}; bot.quit = () => {};
  bot.findBlocks = () => []; bot.canSeeBlock = () => true;
  bot.equip = async (item: any) => { bot.heldItem = item; }; bot.attack = (entity: any) => bot.attacks.push(entity.id);
  bot._placeBlockWithOptions = (reference: any, face: Vec3) => bot.placeBlock(reference, face);
  bot.activateItem = () => { bot.usingHeldItem = true; };
  bot.deactivateItem = () => { bot.usingHeldItem = false; };
  bot.blockAt = (position: Vec3) => ({ name: position.y === 63 ? 'stone' : 'air', boundingBox: position.y === 63 ? 'block' : 'empty', position });
  return bot;
}

async function fixture(bot = fakeBot()) {
  const directory = await mkdtemp(join(tmpdir(), 'anima-native-'));
  const world = new MinecraftWorld({ host: '127.0.0.1', port: 25565, version: '1.21.4', logDirectory: directory });
  const record = { name: 'Tester', persona: '', ready: true, bot, events: [] };
  world.bots.set(record.name, record);
  return { bot, record, world };
}

function nativePlacementFixture(options: { itemName?: string; side?: boolean; referenceName?: string } = {}) {
  const bot = fakeBot(), registry = minecraftData('1.21.4'), Block = loadBlock(registry), cell = new Vec3(1, 64, 0);
  const reference = options.side ? cell.offset(1, 0, 0) : cell.offset(0, -1, 0), itemName = options.itemName || 'dirt';
  bot.registry = registry;
  const item = { name: itemName, type: registry.itemsByName[itemName].id, count: 4 }, packets: any[] = [], placementSneak: boolean[] = [];
  bot.inventory.items = () => [item]; let targetName: string | null = 'air', targetState: number | undefined;
  bot.blockAt = (point: Vec3) => {
    const position = point.floored();
    if (position.equals(cell) && targetName === null) return null;
    const name = position.equals(cell) ? targetName! : position.equals(reference) ? options.referenceName || 'stone'
      : !options.side && position.y === 63 ? 'stone' : 'air';
    const block = Block.fromStateId(position.equals(cell) && targetState !== undefined ? targetState : registry.blocksByName[name].defaultState, 0);
    block.position = position; return block;
  };
  let sent!: () => void; const packetSent = new Promise<void>(resolve => { sent = resolve; });
  bot._client.write = (name: string, body: any) => {
    packets.push({ name, body });
    if (name === 'block_place') placementSneak.push(bot.getControlState('sneak'));
    sent();
  };
  bot.supportFeature = (name: string) => name === 'blockPlaceHasInsideBlock';
  bot.swingArm = () => {};
  installGenericPlace(bot); installPlaceBlock(bot);
  const setTarget = (name: string | null, stateId?: number) => { targetName = name; targetState = stateId; };
  const acknowledge = (name: string | null = itemName, stateId?: number) => {
    const before = bot.blockAt(cell), support = bot.blockAt(reference); setTarget(name, stateId);
    bot.emit(`blockUpdate:${reference}`, support, support);
    bot.emit(`blockUpdate:${cell}`, before, bot.blockAt(cell));
  };
  return { bot, cell, reference, packets, placementSneak, packetSent, acknowledge, setTarget };
}

function nativeInteractionFixture() {
  const bot = fakeBot(), registry = registryFactory('1.21.4'), Item = itemFactory(registry), packets: any[] = [];
  bot.registry = registry; bot.supportFeature = registry.supportFeature; bot.QUICK_BAR_START = 36;
  bot.swingArm = () => {};
  let acknowledge = true;
  bot._client.write = (name: string, body: any) => {
    packets.push({ name, body });
    if (name === 'client_command' && acknowledge) queueMicrotask(() => bot._client.emit('statistics', { entries: [] }));
  };
  installInventory(bot, { hideErrors: true }); bot.quickBarSlot = 0;
  const cell = new Vec3(2, 64, 0), Block = loadBlock(registry), block = Block.fromStateId(registry.blocksByName.obsidian.defaultState, 0);
  block.position = cell;
  bot.blockAt = () => block;
  const entity = { id: 9, name: 'cow', position: new Vec3(2, 64, 0), width: .9, height: 1.4 };
  bot.entities[entity.id] = entity;
  return { bot, block, entity, packets,
    held(name?: string) { bot.inventory.updateSlot(36, name ? new Item(registry.itemsByName[name].id, 1) : null); },
    holdStatistics() { acknowledge = false; },
    acknowledge() { bot._client.emit('statistics', { entries: [] }); },
    clicks() { return packets.filter(packet => ['block_place', 'use_entity'].includes(packet.name)); },
  };
}

function pauseNativeAim(bot: any, call = 1) {
  let began!: () => void, release!: () => void, calls = 0;
  const started = new Promise<void>(resolve => { began = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  bot.lookAt = async () => { if (++calls === call) { began(); await wait; } };
  return { started, release };
}

function meleeWalkingFixture() {
  const bot = fakeBot(), registry = minecraftData('1.21.4'), Block = loadBlock(registry), steps: Vec3[] = [];
  bot.registry = registry; bot.entity.position = new Vec3(.5, 64, .5);
  bot.blockAt = (point: Vec3) => {
    const cell = point.floored(), block = Block.fromStateId(registry.blocksByName[cell.y < 64 ? 'stone' : 'air'].defaultState, 0);
    block.position = cell; return block;
  };
  let aim = bot.entity.position.clone();
  bot.lookAt = async (point: Vec3) => { aim = point.clone(); };
  bot.setControlState = (name: string, value: boolean) => {
    bot.controls[name] = value;
    if (name !== 'forward' || !value) return;
    const p = bot.entity.position, dx = aim.x - p.x, dz = aim.z - p.z, distance = Math.hypot(dx, dz);
    if (distance < .001) return;
    const step = Math.min(.25, distance);
    bot.entity.position = p.offset(dx / distance * step, 0, dz / distance * step); steps.push(bot.entity.position.clone());
  };
  for (const name of ['loadPlugin', 'dig', 'placeBlock', 'equip']) bot[name] = () => assert.fail(`Follow must not call ${name}`);
  const enemy = { id: 81, name: 'zombie', position: new Vec3(5.5, 64, .5), width: .6, height: 1.8, health: 20 };
  bot.entities[81] = enemy;
  return { bot, enemy, steps };
}

test('native action schema bounds movement, attacks and inventory actions', () => {
  for (const bad of [{ type: 'attack', entityId: 2, durationMs: 10001 }, { type: 'attack', entityId: -1 },
    { type: 'move', controls: ['forward', 'back'] }, { type: 'move', controls: ['fly'] },
    { type: 'toss', item: 'stone', count: -1 }, { type: 'equip', item: 'stone', destination: 'server' },
    { type: 'interact', entityId: 1, x: 0, y: 64, z: 0 }]) assert.throws(() => action(bad));
  assert.deepEqual(action({ type: 'equip', item: 'stone' }), { type: 'equip', item: 'stone', destination: 'hand' });
  assert.deepEqual(action({ type: 'shoot', entityId: 5 }), { type: 'shoot', entityId: 5 });
});

test('approach accepts exactly one observed object and keeps block cells distinct from foot coordinates', () => {
  for (const proposal of [{ type: 'approach', position: { x: 4, y: 65, z: -2 } }, { type: 'approach', entityId: 3 }]) {
    assert.deepEqual(action(proposal), proposal);
  }
  for (const invalid of [{ type: 'approach' }, { type: 'approach', entityId: -1 }, { type: 'approach', entityId: 1.5 },
    { type: 'approach', position: { x: Infinity, y: 64, z: 0 } }, { type: 'approach', position: { x: 1.5, y: 64, z: 0 } },
    { type: 'approach', position: { x: 1, y: 64, z: 0 }, entityId: 2 }, { type: 'approach', entityId: 3, x: 1, y: 64, z: 0 },
    { type: 'approach', x: 1, y: 64, z: 0 }]) assert.throws(() => action(invalid));
});

test('travel accepts only finite horizontal coordinates and the native body supplies the height', async () => {
  assert.deepEqual(action({ type: 'travel', x: 2.5, z: -1 }), { type: 'travel', x: 2.5, z: -1 });
  for (const invalid of [{ type: 'travel', x: NaN, z: 1 }, { type: 'travel', x: 1, z: Infinity },
    { type: 'travel', x: 1, z: 1, y: 64 }, { type: 'travel', x: 1, z: 1, entityId: 2 },
    { type: 'travel', x: 1 }, { type: 'travel', x: 30_000_001, z: 0 }]) assert.throws(() => action(invalid));
  const { bot, world } = await fixture();
  const previous = bot.blockAt;
  bot.blockAt = (position: Vec3) => { const block = previous(position.floored()); return { ...block,
    shapes: block.boundingBox === 'block' ? [[0, 0, 0, 1, 1, 1]] : [] }; };
  const result = await world.execute('Tester', { type: 'travel', x: .5, z: .5 });
  assert.equal(result.status, 'completed'); assert.equal(result.details.mode, 'native-travel');
  assert.equal(result.details.reached, true); assert.deepEqual(result.details.target, { x: .5, z: .5 });
});

test('native approach reaches an observed interaction block without digging or activating it', async () => {
  const { bot, world } = await fixture();
  bot.canDigBlock = () => false;
  bot.dig = () => { throw new Error('approach must not dig'); };
  bot.activateBlock = () => { throw new Error('approach must not interact'); };
  bot.blockAt = (position: Vec3) => {
    const cell = position.floored(), isTarget = cell.equals(new Vec3(2, 64, 0));
    const name = isTarget ? 'crafting_table' : cell.y === 63 ? 'stone' : 'air';
    return { name, type: isTarget ? 12 : name === 'stone' ? 1 : 0, position: cell,
      boundingBox: name === 'air' ? 'empty' : 'block', shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]] };
  };
  const result = await world.execute('Tester', action({ type: 'approach', position: { x: 2, y: 64, z: 0 } }));
  assert.equal(result.status, 'completed');
  assert.equal(result.details.mode, 'native-approach');
  assert.equal(result.details.reached, true);
  assert.equal(result.details.target.name, 'crafting_table');
  assert.equal(result.details.planning.legs, 0);
  assert.deepEqual(bot.controls, {});
});

test('item use accepts bounded aiming and holding while block interaction accepts only a unit face', () => {
  assert.deepEqual(action({ type: 'use_item' }), { type: 'use_item', hand: 'main', durationMs: 0 });
  for (const invalid of [{ type: 'use_item', hand: 'both' }, { type: 'use_item', durationMs: 5001 },
    { type: 'use_item', durationMs: -1 }, { type: 'use_item', direction: { x: 0, y: 0, z: 0 } },
    { type: 'use_item', direction: { x: Infinity, y: 0, z: 1 } },
    { type: 'use_item', position: { x: 1, y: 64, z: 0 }, direction: { x: 1, y: 0, z: 0 } },
    { type: 'interact', x: 1, y: 64, z: 0, direction: { x: 1, y: 1, z: 0 } },
    { type: 'interact', entityId: 3, direction: { x: 1, y: 0, z: 0 } }]) assert.throws(() => action(invalid));
});

test('air item use equips, aims and reports actual consumption without claiming the intended effect', async () => {
  const bot = fakeBot(), eyeItem = { name: 'ender_eye', count: 2 }, calls: any[] = [];
  bot.inventory.items = () => [eyeItem];
  bot.equip = async (item: any, destination: string) => { calls.push(['equip', destination]); bot.heldItem = item; };
  bot.lookAt = async (point: Vec3) => { calls.push(['look', point]); };
  bot.activateItem = (offHand: boolean) => { calls.push(['use', offHand]); eyeItem.count--; bot.usingHeldItem = true; };
  bot.deactivateItem = () => { calls.push(['release']); bot.usingHeldItem = false; };
  const result = await runNativeAction(bot, action({ type: 'use_item', item: 'minecraft:ender_eye', position: { x: 10, y: 68, z: 0 } }), new AbortController().signal);
  assert.deepEqual(calls, [['equip', 'hand'], ['look', new Vec3(10, 68, 0)], ['use', false], ['release']]);
  assert.equal(result.activationSent, true); assert.equal(result.effectConfirmed, false);
  assert.deepEqual(result.inventoryDelta, [{ item: 'ender_eye', change: -1 }]);
});

test('offhand shield uses the native offhand and is released immediately upon cancellation', async () => {
  const bot = fakeBot(), controller = new AbortController(), shield = { name: 'shield', count: 1 };
  bot.inventory.slots[45] = shield; bot.getEquipmentDestSlot = () => 45;
  let activated: boolean | undefined, releases = 0;
  bot.activateItem = (offHand: boolean) => { activated = offHand; bot.usingHeldItem = true; };
  bot.deactivateItem = () => { releases++; bot.usingHeldItem = false; };
  const pending = runNativeAction(bot, action({ type: 'use_item', hand: 'off', durationMs: 5000 }), controller.signal);
  assert.equal(activated, true); assert.equal(bot.usingHeldItem, true);
  controller.abort();
  await assert.rejects(pending, (error: any) => {
    assert.equal(error.details.activationSent, true); assert.equal(error.details.partial, true);
    assert.deepEqual(error.details.inventoryDelta, []); return true;
  });
  assert.equal(releases, 1); assert.equal(bot.usingHeldItem, false);
});

test('use_item cannot activate after cancelled aiming and refuses an empty hand', async () => {
  const bot = fakeBot(), controller = new AbortController();
  await assert.rejects(runNativeAction(bot, action({ type: 'use_item' }), controller.signal), /装备/);
  bot.heldItem = { name: 'snowball', count: 1 };
  let target: Vec3 | undefined, activated = false;
  bot.lookAt = async (point: Vec3) => { target = point; controller.abort(); };
  bot.activateItem = () => { activated = true; };
  await assert.rejects(runNativeAction(bot, action({ type: 'use_item', direction: { x: 10, y: 0, z: 0 } }), controller.signal), /取消/);
  assert.deepEqual(target, new Vec3(1, 65.62, 0)); assert.equal(activated, false);
});

test('block use passes the selected visible face to native activateBlock, including flint and steel', async () => {
  const bot = fakeBot(), block = { name: 'obsidian', position: new Vec3(2, 64, 0) };
  bot.blockAt = () => block; bot.heldItem = { name: 'flint_and_steel', count: 1 };
  let request: any;
  bot.activateBlock = async (...args: any[]) => { request = args; };
  const proposal = action({ type: 'interact', x: 2, y: 64, z: 0, direction: { x: -1, y: 0, z: 0 } });
  const result = await runNativeAction(bot, proposal, new AbortController().signal);
  assert.deepEqual(request, [block, new Vec3(-1, 0, 0), new Vec3(0, .5, .5)]);
  assert.equal(result.interactionSent, true); assert.equal(result.effectConfirmed, false);
  bot.world.raycast = () => ({ name: 'stone' }); request = null;
  await assert.rejects(runNativeAction(bot, proposal, new AbortController().signal), /交互面被遮挡/);
  assert.equal(request, null);
});

test('installed inventory plugin preserves ordinary block and entity interactions without claiming their effect', async () => {
  const f = nativeInteractionFixture(), { bot } = f, look = bot.lookAt, write = bot._client.write;
  for (const item of [undefined, 'flint_and_steel']) {
    f.held(item);
    const result = await runNativeAction(bot, action({ type: 'interact', x: 2, y: 64, z: 0, direction: { x: -1, y: 0, z: 0 } }), new AbortController().signal);
    const packet = f.clicks().at(-1);
    assert.equal(packet.name, 'block_place'); assert.equal(packet.body.direction, 4);
    assert.deepEqual(packet.body.location, f.block.position);
    assert.deepEqual([packet.body.cursorX, packet.body.cursorY, packet.body.cursorZ], [0, .5, .5]);
    assert.equal(result.interactionSent, true); assert.equal(result.effectConfirmed, false);
  }
  const result = await runNativeAction(bot, action({ type: 'interact', entityId: 9 }), new AbortController().signal);
  assert.equal(f.clicks().at(-1).body.target, 9); assert.equal(result.interactionSent, true);
  assert.equal(bot.lookAt, look); assert.equal(bot._client.write, write);
});

test('installed native interaction revalidates queued cancellation after its awaited look and before packet construction', async () => {
  for (const type of ['block', 'entity']) {
    const f = nativeInteractionFixture(), controller = new AbortController(); let calls = 0;
    f.bot.lookAt = async () => {
      if (++calls === (type === 'entity' ? 2 : 1)) queueMicrotask(() => controller.abort());
    };
    const look = f.bot.lookAt, write = f.bot._client.write;
    const proposal = type === 'block' ? { type: 'interact', x: 2, y: 64, z: 0 } : { type: 'interact', entityId: 9 };
    await assert.rejects(runNativeAction(f.bot, action(proposal), controller.signal), /取消/);
    assert.equal(calls, type === 'entity' ? 2 : 1, 'The cancellation happened inside the actual native aim, not the outer aim.');
    assert.deepEqual(f.clicks(), []);
    assert.equal(f.bot.lookAt, look); assert.equal(f.bot._client.write, write);
  }
});

test('cancelled native interaction keeps the body locked through aim and queue drain, including death and respawn', async () => {
  for (const reason of ['death', 'respawn'] as const) {
    const f = nativeInteractionFixture(), aim = pauseNativeAim(f.bot), { world, record } = await fixture(f.bot);
    f.holdStatistics(); let settled = false;
    const pending = world.execute('Tester', { type: 'interact', x: 2, y: 64, z: 0 }).finally(() => { settled = true; });
    await aim.started;
    world.stop(record, reason);
    f.bot.entity = { ...f.bot.entity, id: 2, position: new Vec3(0, 64, 0) };
    assert.equal(settled, false); assert.deepEqual(f.clicks(), []);
    await assert.rejects(world.execute('Tester', { type: 'wait', ms: 1 }), /正在执行/);
    aim.release(); await delay(0);
    assert.equal(settled, false); assert.deepEqual(f.clicks(), []);
    assert.equal(f.packets.filter(packet => packet.name === 'client_command').length, 1);
    f.acknowledge();
    assert.equal((await pending).status, 'cancelled'); assert.equal(record.actionController, undefined);
  }
});

test('installed block interaction rejects changed target, visibility, reach and held item after aiming', async () => {
  for (const change of ['block', 'unloaded', 'hidden', 'reach', 'hand']) {
    const f = nativeInteractionFixture(), aim = pauseNativeAim(f.bot); f.held('flint_and_steel');
    const pending = runNativeAction(f.bot, action({ type: 'interact', x: 2, y: 64, z: 0 }), new AbortController().signal);
    await aim.started;
    if (change === 'block') f.block.stateId++;
    if (change === 'unloaded') f.bot.blockAt = () => null;
    if (change === 'hidden') f.bot.canSeeBlock = () => false;
    if (change === 'reach') f.bot.entity.position = new Vec3(-8, 64, 0);
    if (change === 'hand') f.held('ender_eye');
    aim.release();
    await assert.rejects(pending, /方块发生变化|主手物品发生变化|交互面被遮挡/);
    assert.deepEqual(f.clicks(), [], change);
  }
});

test('installed entity interaction rechecks identity, proximity and visibility after its internal second aim', async () => {
  for (const change of ['identity', 'reach', 'hidden']) {
    const f = nativeInteractionFixture(), aim = pauseNativeAim(f.bot, 2);
    const pending = runNativeAction(f.bot, action({ type: 'interact', entityId: 9 }), new AbortController().signal);
    await aim.started;
    if (change === 'identity') f.bot.entities[9] = { ...f.entity };
    if (change === 'reach') f.entity.position = new Vec3(10, 64, 0);
    if (change === 'hidden') f.bot.world.raycast = () => ({ name: 'stone' });
    aim.release();
    await assert.rejects(pending);
    assert.deepEqual(f.clicks(), [], change);
  }
});

test('a native interaction already sent before cancellation still drains its queue under the body lock', async () => {
  const f = nativeInteractionFixture(), { world, record } = await fixture(f.bot); f.holdStatistics();
  let settled = false;
  const pending = world.execute('Tester', { type: 'interact', entityId: 9 }).finally(() => { settled = true; });
  await delay(0);
  assert.equal(f.clicks().length, 1); assert.equal(f.packets.at(-1).name, 'client_command');
  world.stop(record);
  assert.equal(settled, false);
  await assert.rejects(world.execute('Tester', { type: 'wait', ms: 1 }), /正在执行/);
  f.acknowledge();
  assert.equal((await pending).status, 'cancelled'); assert.equal(f.clicks().length, 1);
  assert.equal(record.actionController, undefined);
});

test('direct dig accepts the recorded overhead Sherlock logs from eye reach while retaining distance and visibility checks', async () => {
  const target = new Vec3(-228, 76, -111);
  for (const feet of [new Vec3(-226.50141380314918, 71, -109.56524418181638), new Vec3(-226.5006441135258, 71, -110.63799328711728)]) {
    const bot = fakeBot(); bot.entity.position = feet;
    let dug = false;
    const log = { name: 'oak_log', position: target, type: 1, diggable: true };
    bot.blockAt = () => dug ? { name: 'air', position: target, type: 0 } : log;
    bot.canDigBlock = (block: any) => block.diggable && block.position.offset(.5, .5, .5).distanceTo(bot.entity.position.offset(0, 1.65, 0)) <= 5.1;
    bot.dig = async () => { dug = true; };
    assert.ok(feet.distanceTo(target) > 4.5);
    await runNativeAction(bot, action({ type: 'dig', ...target }), new AbortController().signal);
    assert.equal(dug, true);
    dug = false; bot.entity.position = feet.offset(0, -1, 0);
    assert.equal(bot.canDigBlock(log), true, 'The old Mineflayer 5.1m gate alone would allow this farther target.');
    await assert.rejects(runNativeAction(bot, action({ type: 'dig', ...target }), new AbortController().signal), /眼位 4.5/);
    assert.equal(dug, false);
    bot.entity.position = feet; bot.canSeeBlock = () => false;
    await assert.rejects(runNativeAction(bot, action({ type: 'dig', ...target }), new AbortController().signal), /不可见/);
    assert.equal(dug, false);
  }
});

test('direct dig reports native harvest eligibility and the actual held tool without preventing bare-hand opening', async () => {
  const registry = minecraftData('1.21.4'), Block = loadBlock(registry);
  for (const scenario of [
    { name: 'stone', tool: null, eligible: false },
    { name: 'stone', tool: 'wooden_pickaxe', eligible: true },
    { name: 'stone', tool: 'stick', eligible: false },
    { name: 'oak_log', tool: null, eligible: true },
    { name: 'unknown_material', tool: null, eligible: null },
  ]) {
    const bot = fakeBot(), cell = new Vec3(-210, 68, -90);
    bot.entity.position = new Vec3(-209.50003004174133, 69, -89.43544007947607);
    const definition = registry.blocksByName[scenario.name];
    const block: any = definition ? Block.fromStateId(definition.defaultState, 0)
      : { name: scenario.name, type: 99999, boundingBox: 'block' };
    block.position = cell;
    let dug = false;
    bot.blockAt = () => dug ? { name: 'air', type: 0, position: cell } : block;
    bot.canDigBlock = () => true;
    // Owning a pickaxe does not imply it was used. Aiming can finish after a
    // hand update, and a real tool can break during the following dig.
    bot.heldItem = { name: 'stone_pickaxe', type: registry.itemsByName.stone_pickaxe.id, count: 1 };
    bot.lookAt = async () => { bot.heldItem = scenario.tool
      ? { name: scenario.tool, type: registry.itemsByName[scenario.tool].id, count: 1 } : null; };
    bot.equip = async () => { assert.fail('Direct dig must not choose a tool for the NPC.'); };
    bot.dig = async () => { dug = true; bot.heldItem = null; };
    const result = await runNativeAction(bot, action({ type: 'dig', ...cell }), new AbortController().signal);
    assert.equal(dug, true); assert.equal(result.harvestEligible, scenario.eligible, scenario.name + '/' + scenario.tool);
    assert.deepEqual(result.destroyedBlock, { name: scenario.name, position: { x: -210, y: 68, z: -90 } });
    assert.equal(result.heldItem?.name ?? null, scenario.tool);
    assert.equal(result.dropsConfirmed, false); assert.equal(result.pickupConfirmed, false);
    assert.match(result.note, /不保证/);
    if (scenario.eligible === null) assert.equal(result.harvestCheck, 'unknown');
  }
});

function digSightFixture() {
  const bot = fakeBot(), registry = minecraftData('1.21.4'), Block = loadBlock(registry);
  const cell = new Vec3(2, 65, 0), cells = new Map<string, string | null>(), reads: Vec3[] = [];
  bot.entity.position = new Vec3(.5, 64, .5);
  bot.blockAt = (point: Vec3) => {
    const position = point.floored(); reads.push(position);
    const name = cells.has(position.toString()) ? cells.get(position.toString()) : 'air';
    if (name === null) return null;
    const block = Block.fromStateId(registry.blocksByName[name!].defaultState, 0);
    block.position = position; return block;
  };
  // Run the installed Prismarine raycaster with real 1.21.4 block shapes.
  bot.world = Object.create(WorldSync.prototype);
  bot.world.getBlock = (point: Vec3) => bot.blockAt(point);
  bot.canSeeBlock = () => false; // Native canSeeBlock is not an air-cell oracle.
  bot.canDigBlock = () => { assert.fail('Empty or hidden targets must not reach the diggability gate.'); };
  bot.dig = async () => { assert.fail('No dig packet is allowed for these rejected targets.'); };
  return { bot, cell, cells, reads };
}

test('dig rejects known out-of-range geometry without reading hidden or unloaded target contents', async () => {
  const bot = fakeBot();
  bot.blockAt = () => { assert.fail('Out-of-range dig must not read any world block.'); };
  bot.canSeeBlock = () => { assert.fail('Out-of-range dig must not inspect visibility.'); };
  await assert.rejects(runNativeAction(bot, { type: 'dig', x: 8, y: 65, z: 0 }, new AbortController().signal), (error: any) => {
    assert.equal(error.details.dig.reasonCode, 'out_of_reach'); assert.equal(error.details.dig.reach, 4.5);
    assert.ok(error.details.dig.eyeDistance > 4.5); assert.equal(Object.hasOwn(error.details.dig, 'name'), false);
    assert.deepEqual(error.details.dig.target, { x: 8, y: 65, z: 0 }); return true;
  });
});

test('dig distinguishes truly visible empty cells from occluded air and unloaded sight lines', async () => {
  for (const scenario of [
    { target: 'air', prefix: 'air', reason: 'empty_target', name: 'air' },
    { target: 'cave_air', prefix: 'air', reason: 'empty_target', name: 'cave_air' },
    { target: 'void_air', prefix: 'air', reason: 'empty_target', name: 'void_air' },
    { target: 'air', prefix: 'stone', reason: 'target_occluded' },
    { target: 'air', prefix: null, reason: 'unknown_visibility' },
    { target: null, prefix: 'air', reason: 'target_unloaded' },
  ]) {
    const { bot, cell, cells } = digSightFixture();
    cells.set(cell.toString(), scenario.target); cells.set(new Vec3(1, 65, 0).toString(), scenario.prefix);
    await assert.rejects(runNativeAction(bot, { type: 'dig', ...cell }, new AbortController().signal), (error: any) => {
      assert.equal(error.details.dig.reasonCode, scenario.reason, `${scenario.target}/${scenario.prefix}`);
      assert.equal(error.details.dig.name, scenario.name);
      if (scenario.reason !== 'empty_target') assert.doesNotMatch(error.message + JSON.stringify(error.details), /stone|cave_air|void_air|"name"/);
      return true;
    });
  }
});

test('dig reports visible unbreakable blocks without disclosing the name or diggability of hidden blocks', async () => {
  const { bot, cell, cells } = digSightFixture(); cells.set(cell.toString(), 'bedrock');
  let diggabilityReads = 0;
  bot.canDigBlock = () => { diggabilityReads++; return false; };
  await assert.rejects(runNativeAction(bot, { type: 'dig', ...cell }, new AbortController().signal), (error: any) => {
    assert.equal(error.details.dig.reasonCode, 'target_occluded');
    assert.doesNotMatch(error.message + JSON.stringify(error.details), /bedrock|"name"/); return true;
  });
  assert.equal(diggabilityReads, 0);
  bot.canSeeBlock = () => true;
  await assert.rejects(runNativeAction(bot, { type: 'dig', ...cell }, new AbortController().signal), (error: any) => {
    assert.equal(error.details.dig.reasonCode, 'not_diggable'); assert.equal(error.details.dig.name, 'bedrock'); return true;
  });
  assert.equal(diggabilityReads, 1);
});

test('digging a cleared log again reports empty_target through the real world receipt instead of a route failure', async () => {
  const { bot, cell, cells } = digSightFixture(); cells.set(cell.toString(), 'oak_log');
  bot.canSeeBlock = (block: any) => block.name === 'oak_log'; bot.canDigBlock = () => true;
  let digs = 0;
  bot.dig = async () => { digs++; cells.set(cell.toString(), 'air'); };
  const { world } = await fixture(bot);
  const first = await world.execute('Tester', { type: 'dig', ...cell });
  assert.equal(first.status, 'completed'); assert.equal(first.details.destroyedBlock.name, 'oak_log');
  const repeated = await world.execute('Tester', { type: 'dig', ...cell });
  assert.equal(repeated.status, 'failed'); assert.equal(repeated.details.dig.reasonCode, 'empty_target');
  assert.equal(repeated.details.dig.name, 'air'); assert.match(repeated.error, /不是距离或路线失败/); assert.equal(digs, 1);
});

test('dig cancellation after aiming sends no mining action and an in-flight dig is still drained before cancellation returns', async () => {
  const { bot, cell, cells } = digSightFixture(); cells.set(cell.toString(), 'oak_log');
  bot.canSeeBlock = () => true; bot.canDigBlock = () => true;
  const controller = new AbortController(); bot.lookAt = async () => { controller.abort(); };
  await assert.rejects(runNativeAction(bot, { type: 'dig', ...cell }, controller.signal), /取消/);
  bot.lookAt = async () => {};
  let started!: () => void, finish!: () => void, drained = false;
  const miningStarted = new Promise<void>(resolve => { started = resolve; });
  bot.dig = () => new Promise<void>(resolve => { finish = () => { drained = true; resolve(); }; started(); });
  bot.stopDigging = () => { finish?.(); };
  const { world, record } = await fixture(bot);
  const pending = world.execute('Tester', { type: 'dig', ...cell });
  await miningStarted; world.stop(record);
  const result = await pending;
  assert.equal(result.status, 'cancelled'); assert.equal(drained, true); assert.deepEqual(bot.controls, {});
});

test('stopping timed movement clears controls and drains the action', async () => {
  const { bot, record, world } = await fixture();
  const pending = world.execute('Tester', { type: 'move', controls: ['forward'], ms: 5000 });
  assert.equal(bot.controls.forward, true);
  world.stop(record);
  assert.equal((await pending).status, 'cancelled');
  await delay(20);
  assert.deepEqual(bot.controls, {});
  assert.equal(world.summary(record).busy, false);
});

test('cancelled equip cannot later place a block or release the action lock early', async () => {
  const { bot, record, world } = await fixture();
  let resolveEquip: () => void = () => {};
  bot.equip = () => new Promise<void>(resolve => { resolveEquip = resolve; });
  let placed = false; bot.placeBlock = async () => { placed = true; };
  const pending = world.execute('Tester', { type: 'place', x: 1, y: 64, z: 0, item: 'stone' });
  world.stop(record);
  await assert.rejects(world.execute('Tester', { type: 'say', message: 'overlap' }), /正在执行/);
  resolveEquip();
  assert.equal((await pending).status, 'cancelled');
  assert.equal(placed, false);
  assert.equal(world.summary(record).busy, false);
});

test('installed native placement aims once at the attachment face and waits for the actual block acknowledgement', async () => {
  const { bot, cell, reference, packets, packetSent, acknowledge } = nativePlacementFixture(), looks: any[] = [];
  bot.lookAt = async (point: Vec3, force: boolean) => { looks.push({ point, force }); };
  const pending = runNativeAction(bot, { type: 'place', ...cell, item: 'minecraft:dirt' }, new AbortController().signal);
  await packetSent; await delay(0);
  assert.deepEqual(looks, [{ point: reference.offset(.5, 1, .5), force: true }]);
  assert.equal(packets.length, 1); assert.equal(packets[0].name, 'block_place');
  assert.equal(bot.listenerCount(`blockUpdate:${cell}`), 1);
  acknowledge(); await pending;
  assert.equal(bot.blockAt(cell).name, 'dirt');
  assert.equal(bot.listenerCount(`blockUpdate:${cell}`), 0); assert.equal(bot.listenerCount(`blockUpdate:${reference}`), 0);
});

for (const [referenceName, itemName, previousSneak] of [
  ['crafting_table', 'torch', false], ['furnace', 'torch', false],
  ['crafting_table', 'chest', true], ['furnace', 'chest', false],
] as const) {
  test(`placement sneak precedes ${itemName} placement on ${referenceName} and restores ${previousSneak} after acknowledgement`, async () => {
    const f = nativePlacementFixture({ referenceName, itemName });
    f.bot.setControlState('sneak', previousSneak);
    const pending = runNativeAction(f.bot, { type: 'place', ...f.cell, item: itemName }, new AbortController().signal);
    await f.packetSent; await delay(0);
    const heldUntilAcknowledgement = f.bot.getControlState('sneak');
    f.acknowledge(); const result = await pending;
    assert.deepEqual(f.placementSneak, [true], 'Interactive support must receive placement with sneak already active.');
    assert.equal(heldUntilAcknowledgement, true);
    assert.equal(f.bot.getControlState('sneak'), previousSneak);
    assert.equal(result.placementConfirmed, true);
  });
}

for (const previousSneak of [false, true]) {
  test(`placement sneak restores ${previousSneak} after a real unchanged-air refusal`, async () => {
    const f = nativePlacementFixture({ referenceName: 'furnace', itemName: 'chest' });
    f.bot.setControlState('sneak', previousSneak);
    const pending = runNativeAction(f.bot, { type: 'place', ...f.cell, item: 'chest' }, new AbortController().signal);
    const rejected = assert.rejects(pending, /Server refused to place chest/);
    await f.packetSent; await delay(0); f.acknowledge('air'); await rejected;
    assert.deepEqual(f.placementSneak, [true]);
    assert.equal(f.bot.getControlState('sneak'), previousSneak);
    assert.equal(f.bot.listenerCount(`blockUpdate:${f.cell}`), 0);
  });

  test(`placement sneak cancellation drains acknowledgement and never restores previous ${previousSneak}`, async () => {
    const f = nativePlacementFixture({ referenceName: 'crafting_table', itemName: 'torch' });
    f.bot.setControlState('sneak', previousSneak);
    const controls: { key: string; value: boolean }[] = [], setControlState = f.bot.setControlState;
    f.bot.setControlState = (key: string, value: boolean) => { controls.push({ key, value }); setControlState(key, value); };
    const { world, record } = await fixture(f.bot); let settled = false;
    const pending = world.execute('Tester', { type: 'place', ...f.cell, item: 'torch' })
      .then(result => { settled = true; return result; });
    await f.packetSent; await delay(0); world.stop(record); await delay(0);
    const stoppedAt = controls.length;
    assert.equal(f.bot.getControlState('sneak'), false);
    assert.equal(settled, false); assert.equal(world.summary(record).busy, true);
    await assert.rejects(world.execute('Tester', { type: 'say', message: 'overlap' }), /正在执行/);
    f.acknowledge(); const result = await pending;
    assert.deepEqual(f.placementSneak, [true]);
    assert.equal(result.status, 'cancelled'); assert.equal(world.summary(record).busy, false);
    assert.equal(f.bot.getControlState('sneak'), false, 'A stopped action must not re-enable a prior sneak input.');
    assert.equal(controls.slice(stoppedAt).some(control => control.key === 'sneak' && control.value), false,
      'Restoration must not briefly re-enable sneak before the world finally clears controls.');
    assert.equal(f.packets.length, 1);
    assert.equal(f.bot.listenerCount(`blockUpdate:${f.cell}`), 0);
    assert.equal(f.bot.listenerCount(`blockUpdate:${f.reference}`), 0);
  });
}

test('placement sneak starts only after cancellable aim and final local placement validation', async () => {
  for (const changed of ['cancel', 'reach', 'visibility', 'target', 'support', 'body', 'hand']) {
    const itemName = changed === 'body' ? 'dirt' : 'chest';
    const f = nativePlacementFixture({ referenceName: 'furnace', itemName });
    const controller = new AbortController(), original = f.bot.blockAt, controls: unknown[] = [];
    const setControlState = f.bot.setControlState;
    f.bot.setControlState = (key: string, value: boolean) => { controls.push({ key, value }); setControlState(key, value); };
    f.bot.lookAt = async () => {
      if (changed === 'cancel') controller.abort();
      if (changed === 'reach') f.bot.entity.position = new Vec3(30, 64, 0);
      if (changed === 'visibility') f.bot.world.raycast = () => ({ name: 'stone' });
      if (changed === 'target') f.setTarget('stone');
      if (changed === 'support') f.bot.blockAt = (p: Vec3) => p.equals(f.reference) ? { ...original(p), name: 'air', boundingBox: 'empty' } : original(p);
      if (changed === 'body') f.bot.entity.position = f.cell.offset(.5, 0, .5);
      if (changed === 'hand') f.bot.heldItem = { name: 'stone', type: 1, count: 1 };
    };
    await assert.rejects(runNativeAction(f.bot, { type: 'place', ...f.cell, item: itemName }, controller.signal),
      changed === 'cancel' ? /取消/ : changed === 'body' ? /自身身体重叠/ : ['reach', 'visibility'].includes(changed) ? /4\.5/ : /等待期间/);
    assert.deepEqual(f.packets, [], changed);
    assert.deepEqual(controls, [], 'Invalid placement must not acquire a sneak input.');
  }
});

for (const changed of ['entity', 'closed client']) {
  test(`placement sneak boundary never restores old true after ${changed} changes without abort`, async () => {
    const f = nativePlacementFixture({ referenceName: 'furnace', itemName: 'torch' }), controller = new AbortController();
    f.bot.setControlState('sneak', true);
    const controls: boolean[] = [], setControlState = f.bot.setControlState;
    f.bot.setControlState = (key: string, value: boolean) => {
      if (key === 'sneak') controls.push(value);
      setControlState(key, value);
    };
    const pending = runNativeAction(f.bot, { type: 'place', ...f.cell, item: 'torch' }, controller.signal);
    await f.packetSent; await delay(0); const changedAt = controls.length;
    if (changed === 'entity') f.bot.entity = { ...f.bot.entity, id: 2 };
    else f.bot._client.state = 'closed';
    f.acknowledge(); await pending;
    assert.equal(controller.signal.aborted, false);
    assert.equal(controls.slice(changedAt).includes(true), false);
    assert.equal(f.bot.getControlState('sneak'), false);
  });
}

test('placement sneak boundary direct abort releases input synchronously while draining the native acknowledgement', async () => {
  const f = nativePlacementFixture({ referenceName: 'crafting_table', itemName: 'torch' }), controller = new AbortController();
  f.bot.setControlState('sneak', true); let settled = false;
  const pending = runNativeAction(f.bot, { type: 'place', ...f.cell, item: 'torch' }, controller.signal)
    .finally(() => { settled = true; });
  const rejected = assert.rejects(pending, /取消/);
  await f.packetSent; await delay(0); controller.abort();
  const sneakAfterAbort = f.bot.getControlState('sneak');
  await delay(0); const settledBeforeAcknowledgement = settled;
  f.acknowledge(); await rejected;
  assert.equal(sneakAfterAbort, false, 'Direct callers also need synchronous release, without world.stop.');
  assert.equal(settledBeforeAcknowledgement, false);
  assert.equal(f.bot.getControlState('sneak'), false);
  assert.equal(f.packets.length, 1);
  assert.equal(f.bot.listenerCount(`blockUpdate:${f.cell}`), 0);
});

test('placement sneak boundary cleanup exceptions preserve the original server refusal', async () => {
  const f = nativePlacementFixture({ referenceName: 'furnace', itemName: 'chest' });
  const setControlState = f.bot.setControlState; let cleanupAttempts = 0;
  f.bot.setControlState = (key: string, value: boolean) => {
    if (key === 'sneak' && !value) { cleanupAttempts++; throw new Error('control cleanup unavailable'); }
    setControlState(key, value);
  };
  const pending = runNativeAction(f.bot, { type: 'place', ...f.cell, item: 'chest' }, new AbortController().signal);
  const rejected = assert.rejects(pending, /Server refused to place chest/);
  await f.packetSent; await delay(0); f.acknowledge('air'); await rejected;
  assert.equal(cleanupAttempts, 1, 'Exercise the failing cleanup call without hiding the placement failure.');
  assert.equal(f.bot.listenerCount(`blockUpdate:${f.cell}`), 0);
});

for (const changed of ['occluded', 'out of reach']) {
  test(`placement sneak boundary rejects a ${changed} crouching eye with zero packets and inputs`, async () => {
    const f = nativePlacementFixture({ referenceName: 'furnace', itemName: 'torch' });
    if (changed === 'out of reach') f.bot.entity.position = new Vec3(-2.95, 62, .5);
    const entity = f.bot.entity, eyeHeight = entity.eyeHeight, position = entity.position.clone();
    const standingEye = position.offset(0, eyeHeight, 0), crouchingEye = position.offset(0, 1.27, 0);
    const facePoint = f.reference.offset(.5, 1, .5), controls: unknown[] = [], setControlState = f.bot.setControlState;
    assert.ok(f.cell.distanceTo(position) < 4.5);
    assert.ok(facePoint.distanceTo(standingEye) < 4.5);
    if (changed === 'out of reach') assert.ok(facePoint.distanceTo(crouchingEye) > 4.5);
    f.bot.setControlState = (key: string, value: boolean) => { controls.push({ key, value }); setControlState(key, value); };
    f.bot.world.raycast = (origin: Vec3) => {
      assert.equal(f.bot.entity, entity); assert.equal(f.bot.entity.eyeHeight, eyeHeight);
      return changed === 'occluded' && origin.y < standingEye.y - .1 ? { name: 'stone' } : null;
    };
    // Drain an unexpected packet on the old implementation so failure stays local and quick.
    void f.packetSent.then(() => delay(0)).then(() => f.acknowledge());
    await assert.rejects(runNativeAction(f.bot, { type: 'place', ...f.cell, item: 'torch' }, new AbortController().signal), /4\.5|遮挡/);
    assert.deepEqual(f.packets, []); assert.deepEqual(controls, []);
    assert.equal(f.bot.entity, entity); assert.equal(f.bot.entity.eyeHeight, eyeHeight);
    assert.deepEqual(f.bot.entity.position, position);
  });
}

test('installed native placement confirms registry-backed standing and wall torch variants at the requested cell', async () => {
  for (const [itemName, wallName] of [['torch', 'wall_torch'], ['soul_torch', 'soul_wall_torch'], ['redstone_torch', 'redstone_wall_torch']]) {
    for (const side of [false, true]) {
      const f = nativePlacementFixture({ itemName, side }), name = side ? wallName : itemName;
      const definition = f.bot.registry.blocksByName[name], Block = loadBlock(f.bot.registry);
      let stateId = definition.defaultState;
      if (side) {
        stateId = Array.from({ length: definition.maxStateId - definition.minStateId + 1 }, (_, i) => definition.minStateId + i)
          .find(id => Block.fromStateId(id, 0).getProperties().facing === 'west')!;
      }
      let settled = false;
      const pending = runNativeAction(f.bot, { type: 'place', ...f.cell, item: itemName }, new AbortController().signal)
        .then(result => { settled = true; return result; });
      await f.packetSent; await delay(0);
      assert.equal(settled, false); assert.equal(f.packets.length, 1);
      assert.equal(f.packets[0].body.direction, side ? 4 : 1);
      f.acknowledge(name, stateId);
      assert.deepEqual(await pending, { placementConfirmed: true, placedBlock: { name, position: { ...f.cell } } });
      assert.equal(f.bot.blockAt(f.cell).type, definition.id);
      assert.equal(f.bot.listenerCount(`blockUpdate:${f.cell}`), 0);
      assert.equal(f.bot.listenerCount(`blockUpdate:${f.reference}`), 0);
    }
  }
});

test('placement rejects old matching variants, an unchanged air acknowledgement and unrelated registry drops', async () => {
  for (const duringAim of [false, true]) {
    const f = nativePlacementFixture({ itemName: 'torch', side: true });
    if (duringAim) f.bot.lookAt = async () => { f.setTarget('wall_torch'); };
    else f.setTarget('wall_torch');
    await assert.rejects(runNativeAction(f.bot, { type: 'place', ...f.cell, item: 'torch' }, new AbortController().signal), /空位/);
    assert.deepEqual(f.packets, [], 'A pre-existing matching block is not evidence of this placement.');
  }
  for (const changed of ['air', 'soul_wall_torch', null]) {
    const f = nativePlacementFixture({ itemName: 'torch', side: true });
    const pending = runNativeAction(f.bot, { type: 'place', ...f.cell, item: 'torch' }, new AbortController().signal);
    const rejected = assert.rejects(pending, /refused|尚未确认/);
    await f.packetSent; await delay(0); f.acknowledge(changed); await rejected;
    assert.equal(f.bot.listenerCount(`blockUpdate:${f.cell}`), 0);
    assert.equal(f.bot.listenerCount(`blockUpdate:${f.reference}`), 0);
  }
  const f = nativePlacementFixture({ itemName: 'cobblestone' });
  assert.ok(f.bot.registry.blocksByName.stone.drops.includes(f.bot.registry.itemsByName.cobblestone.id));
  const pending = runNativeAction(f.bot, { type: 'place', ...f.cell, item: 'cobblestone' }, new AbortController().signal);
  const rejected = assert.rejects(pending, /尚未确认/);
  await f.packetSent; await delay(0); f.acknowledge('stone'); await rejected;
});

test('wall torch confirmation requires the current registry mapping and a side attachment', async () => {
  for (const changed of ['registry', 'floor']) {
    const f = nativePlacementFixture({ itemName: 'torch', side: changed !== 'floor' });
    if (changed === 'registry') f.bot.registry = { ...f.bot.registry, itemsByName: { ...f.bot.registry.itemsByName,
      torch: { ...f.bot.registry.itemsByName.torch, id: -1 } } };
    const pending = runNativeAction(f.bot, { type: 'place', ...f.cell, item: 'torch' }, new AbortController().signal);
    const rejected = assert.rejects(pending, /尚未确认/);
    await f.packetSent; await delay(0); f.acknowledge('wall_torch'); await rejected;
  }
});

test('cancelling during placement aiming sends zero packets through the installed Mineflayer plugins', async () => {
  const { bot, cell, packets } = nativePlacementFixture(), controller = new AbortController();
  let entered!: () => void, finishLook!: () => void;
  const aiming = new Promise<void>(resolve => { entered = resolve; });
  bot.lookAt = () => { entered(); return new Promise<void>(resolve => { finishLook = resolve; }); };
  const pending = runNativeAction(bot, { type: 'place', ...cell, item: 'dirt' }, controller.signal);
  await aiming; controller.abort(); finishLook();
  await assert.rejects(pending, /取消/); assert.deepEqual(packets, []);
  assert.equal(bot.listenerCount(`blockUpdate:${cell}`), 0);
});

test('a sent native placement remains locked after cancellation until its acknowledgement is drained', async () => {
  const { bot, cell, reference, packets, packetSent, acknowledge } = nativePlacementFixture();
  const { world, record } = await fixture(bot); let settled = false;
  const pending = world.execute('Tester', { type: 'place', ...cell, item: 'dirt' }).then(result => { settled = true; return result; });
  await packetSent; await delay(0); world.stop(record); await delay(0);
  assert.equal(settled, false); assert.equal(world.summary(record).busy, true);
  await assert.rejects(world.execute('Tester', { type: 'say', message: 'overlap' }), /正在执行/);
  assert.equal(packets.length, 1); assert.equal(bot.listenerCount(`blockUpdate:${cell}`), 1);
  acknowledge(); assert.equal((await pending).status, 'cancelled');
  assert.equal(world.summary(record).busy, false); assert.equal(packets.length, 1);
  assert.equal(bot.listenerCount(`blockUpdate:${cell}`), 0); assert.equal(bot.listenerCount(`blockUpdate:${reference}`), 0);
});

test('placement revalidates the cell, support, own body, held item and reach after awaiting aim', async () => {
  for (const changed of ['target', 'support', 'body', 'hand', 'reach', 'visibility']) {
    const { bot, cell, reference, packets } = nativePlacementFixture(), original = bot.blockAt;
    bot.lookAt = async () => {
      if (changed === 'target') bot.blockAt = (p: Vec3) => p.equals(cell) ? { ...original(p), name: 'stone', boundingBox: 'block' } : original(p);
      if (changed === 'support') bot.blockAt = (p: Vec3) => p.equals(reference) ? { ...original(p), name: 'air', boundingBox: 'empty' } : original(p);
      if (changed === 'body') bot.entity.position = cell.offset(.5, 0, .5);
      if (changed === 'hand') bot.heldItem = { name: 'stone', type: 1, count: 1 };
      if (changed === 'reach') bot.entity.position = new Vec3(30, 64, 0);
      if (changed === 'visibility') bot.world.raycast = () => ({ name: 'stone' });
    };
    await assert.rejects(runNativeAction(bot, { type: 'place', ...cell, item: 'dirt' }, new AbortController().signal),
      changed === 'body' ? /自身身体重叠/ : ['reach', 'visibility'].includes(changed) ? /4\.5/ : /等待期间/);
    assert.deepEqual(packets, [], changed);
  }
  const { bot, cell } = nativePlacementFixture(); bot._placeBlockWithOptions = undefined;
  bot.placeBlock = () => assert.fail('Do not silently fall back to uncancellable native aiming.');
  await assert.rejects(runNativeAction(bot, { type: 'place', ...cell, item: 'dirt' }, new AbortController().signal), /不支持/);
});

test('recorded HuYifei placement identifies own-body occupancy and still permits the clear neighbouring cell', async () => {
  const bot = fakeBot(); bot.registry = minecraftData('1.21.4');
  bot.entity.position = new Vec3(-212.32304106773807, 72, -97.50437604244865);
  const placed = new Map<string, any>(); let equips = 0, placements = 0;
  bot.inventory.items = () => [{ name: 'crafting_table', count: 1 }];
  bot.blockAt = (position: Vec3) => placed.get(position.toString()) || { name: position.y === 71 ? 'stone' : 'air',
    boundingBox: position.y === 71 ? 'block' : 'empty', position };
  bot.equip = async (item: any) => { equips++; bot.heldItem = item; };
  bot.placeBlock = async (reference: any, face: Vec3) => {
    placements++; const position = reference.position.plus(face);
    placed.set(position.toString(), { name: 'crafting_table', boundingBox: 'block', position });
  };
  const { world } = await fixture(bot);
  const blocked = await world.execute('Tester', { type: 'place', x: -213, y: 72, z: -98, item: 'crafting_table' });
  assert.equal(blocked.status, 'failed'); assert.match(blocked.error!, /自身身体重叠/);
  assert.equal(blocked.details.placement.reasonCode, 'self_occupied');
  assert.deepEqual(blocked.details.placement.target, { x: -213, y: 72, z: -98 });
  assert.ok(blocked.details.placement.body.min.x < -212 && blocked.details.placement.body.max.x > -213);
  assert.equal(equips, 0); assert.equal(placements, 0);
  const clear = await world.execute('Tester', { type: 'place', x: -214, y: 72, z: -98, item: 'crafting_table' });
  assert.equal(clear.status, 'completed'); assert.equal(placements, 1);
});

test('own-body placement feedback does not forbid a non-solid torch in the same cell', async () => {
  const bot = fakeBot(); bot.registry = minecraftData('1.21.4');
  bot.entity.position = new Vec3(.5, 64, .5); let placed = false;
  bot.inventory.items = () => [{ name: 'torch', count: 1 }];
  bot.blockAt = (position: Vec3) => ({ name: placed && position.y === 64 ? 'torch' : position.y === 63 ? 'stone' : 'air',
    boundingBox: position.y === 63 ? 'block' : 'empty', position });
  bot.placeBlock = async () => { placed = true; };
  await runNativeAction(bot, action({ type: 'place', x: 0, y: 64, z: 0, item: 'torch' }), new AbortController().signal);
  assert.equal(placed, true);
});

test('melee respects reach and does not claim a hit from a sent packet', async t => {
  // Exercise range/evidence semantics independently of a loaded CI machine
  // exhausting this tiny action window before the first precondition check.
  t.mock.method(performance, 'now', () => 0);
  const bot = fakeBot();
  bot.entities[5] = { id: 5, name: 'zombie', position: new Vec3(20, 64, 0), height: 2, width: .6 };
  await assert.rejects(runNativeAction(bot, { type: 'attack', entityId: 5, durationMs: 1 }, new AbortController().signal), /超出/);
  assert.deepEqual(bot.attacks, []);
  bot.entities[5].position = new Vec3(2, 64, 0);
  const result = await runNativeAction(bot, { type: 'attack', entityId: 5, durationMs: 1 }, new AbortController().signal);
  assert.equal(result?.damageConfirmed, false);
  assert.deepEqual(bot.attacks, [5]);
});

test('explicit follow uses the actual planner and native body to regain reach after knockback', async () => {
  const { bot, enemy, steps } = meleeWalkingFixture();
  bot.attack = (target: any) => {
    assert.equal(target, enemy); bot.attacks.push(target.id);
    assert.ok(bot.entity.position.distanceTo(enemy.position) <= 3.31);
    if (bot.attacks.length === 1) enemy.position = enemy.position.offset(2, 0, 0);
    else delete bot.entities[81];
  };
  const result = await runNativeAction(bot, { type: 'attack', entityId: 81, follow: true, durationMs: 4500 }, new AbortController().signal);
  assert.equal(result.follow, true); assert.deepEqual(bot.attacks, [81, 81]);
  assert.equal(result.movement.approaches, 2); assert.ok(result.movement.distance >= 4);
  assert.ok(result.movement.legs >= 4); assert.ok(steps.length > 4);
  assert.equal(result.movement.lastApproach.planning.version, '2.4.5');
  assert.equal(result.stoppedReason, 'target_unloaded'); assert.equal(result.damageConfirmed, false);
  assert.deepEqual(bot.controls, {});
});

test('follow shares one total deadline with pursuit and cannot gain a fresh child navigation timeout', async () => {
  const { bot, steps } = meleeWalkingFixture(), started = Date.now();
  const result = await runNativeAction(bot, { type: 'attack', entityId: 81, follow: true, durationMs: 150 }, new AbortController().signal);
  assert.equal(result.stoppedReason, 'duration_elapsed'); assert.equal(result.attempts, 0);
  assert.ok(result.movement.distance > 0); assert.ok(steps.length > 0);
  assert.ok(Date.now() - started < 700); assert.deepEqual(bot.controls, {});
  const count = steps.length; await delay(70); assert.equal(steps.length, count);
});

test('follow total expiry drains an already pending native look without sending a late strike', async () => {
  const { bot, enemy } = meleeWalkingFixture(); enemy.position = new Vec3(2, 64, .5);
  const aim = pauseNativeAim(bot); let settled = false;
  const pending = runNativeAction(bot, { type: 'attack', entityId: 81, follow: true, durationMs: 40 }, new AbortController().signal)
    .finally(() => { settled = true; });
  await aim.started; await delay(70);
  assert.equal(settled, false); assert.deepEqual(bot.attacks, []); assert.deepEqual(bot.controls, {});
  aim.release(); const result = await pending;
  assert.equal(result.stoppedReason, 'duration_elapsed'); assert.equal(result.attempts, 0);
});

test('follow cannot accumulate unlimited pursuit across repeated knockback', async () => {
  const { bot, enemy } = meleeWalkingFixture(); enemy.position = new Vec3(2.5, 64, .5);
  bot.attack = (target: any) => { bot.attacks.push(target.id); enemy.position = enemy.position.offset(2, 0, 0); };
  await assert.rejects(runNativeAction(bot, { type: 'attack', entityId: 81, follow: true, durationMs: 10000 }, new AbortController().signal), (error: any) => {
    assert.match(error.message, /追近次数预算/); assert.equal(error.details.movement.approaches, 3);
    assert.equal(error.details.attempts, 4); assert.ok(error.details.movement.distance > 4); return true;
  });
  assert.deepEqual(bot.controls, {});
});

test('follow movement budget stops an otherwise reachable distant target without overshooting a whole route', async () => {
  const { bot, enemy } = meleeWalkingFixture(); enemy.position = new Vec3(23.5, 64, .5);
  await assert.rejects(runNativeAction(bot, { type: 'attack', entityId: 81, follow: true, durationMs: 10000 }, new AbortController().signal), (error: any) => {
    assert.match(error.message, /累计移动预算/); assert.equal(error.details.attempts, 0);
    assert.ok(error.details.movement.distance >= 16 && error.details.movement.distance < 16.6); return true;
  });
  assert.deepEqual(bot.attacks, []); assert.deepEqual(bot.controls, {});
});

test('follow refuses unknown support and does not silently fall back to digging or another target', async () => {
  const { bot, steps } = meleeWalkingFixture(), read = bot.blockAt;
  bot.blockAt = (cell: Vec3) => cell.y < 64 && cell.x >= 1 ? null : read(cell);
  bot.entities[82] = { ...bot.entities[81], id: 82, position: new Vec3(1.5, 64, .5) };
  await assert.rejects(runNativeAction(bot, { type: 'attack', entityId: 81, follow: true, durationMs: 3000 }, new AbortController().signal), (error: any) => {
    assert.equal(error.details.attempts, 0); assert.equal(error.details.movement.lastApproach.stoppedReason, 'no_path'); return true;
  });
  assert.deepEqual(steps, []); assert.deepEqual(bot.attacks, []); assert.deepEqual(bot.controls, {});
});

test('melee revalidates identity, hand, visibility, range and cancellation after awaited aiming', async () => {
  for (const changed of ['identity', 'hand', 'visibility', 'range', 'cancel']) {
    const bot = fakeBot(), enemy = { id: 81, name: 'zombie', position: new Vec3(2, 64, 0), width: .6, height: 1.8 };
    bot.entities[81] = enemy; const controller = new AbortController();
    bot.lookAt = async () => {
      if (changed === 'identity') bot.entities[81] = { ...enemy };
      if (changed === 'hand') bot.heldItem = { name: 'stone_sword', type: 1, count: 1 };
      if (changed === 'visibility') bot.world.raycast = () => ({ name: 'stone' });
      if (changed === 'range') enemy.position = new Vec3(8, 64, 0);
      if (changed === 'cancel') controller.abort();
    };
    await assert.rejects(runNativeAction(bot, { type: 'attack', entityId: 81, durationMs: 1000 }, controller.signal));
    assert.deepEqual(bot.attacks, [], changed); assert.deepEqual(bot.controls, {});
  }
});

test('follow stops on lost visibility without exposing the newly hidden target position', async () => {
  const { bot, enemy } = meleeWalkingFixture(), step = bot.setControlState, seen = enemy.position.clone();
  bot.setControlState = (name: string, value: boolean) => {
    step(name, value);
    if (name === 'forward' && value) { enemy.position = new Vec3(13, 64, 0); bot.world.raycast = () => ({ name: 'stone' }); }
  };
  await assert.rejects(runNativeAction(bot, { type: 'attack', entityId: 81, follow: true, durationMs: 2000 }, new AbortController().signal), (error: any) => {
    assert.equal(error.details.attempts, 0); assert.equal(error.details.targetVisible, false);
    assert.deepEqual(error.details.lastObservedTarget.position, { ...seen });
    assert.deepEqual(error.details.movement.lastApproach.target.lastSeenPosition, { ...seen }); return true;
  });
  assert.deepEqual(bot.attacks, []); assert.deepEqual(bot.controls, {});
});

test('follow does not pursue a replacement entity that reuses the chosen id', async () => {
  const { bot, enemy } = meleeWalkingFixture(), step = bot.setControlState;
  bot.setControlState = (name: string, value: boolean) => {
    step(name, value);
    if (name === 'forward' && value) bot.entities[81] = { ...enemy, position: new Vec3(10, 64, 0) };
  };
  await assert.rejects(runNativeAction(bot, { type: 'attack', entityId: 81, follow: true, durationMs: 3000 }, new AbortController().signal), (error: any) => {
    assert.equal(error.details.attempts, 0); assert.equal(error.details.targetLoaded, false);
    assert.deepEqual(error.details.lastObservedTarget.position, { ...enemy.position }); return true;
  });
  assert.deepEqual(bot.attacks, []); assert.deepEqual(bot.controls, {});
});

test('cancelled follow retains the body lock until native aiming settles and sends no late strike or movement', async () => {
  const { bot, steps } = meleeWalkingFixture(), aim = pauseNativeAim(bot), { world, record } = await fixture(bot);
  let settled = false;
  const pending = world.execute('Tester', { type: 'attack', entityId: 81, follow: true, durationMs: 5000 }).finally(() => { settled = true; });
  await aim.started; world.stop(record); await delay(0);
  assert.equal(settled, false); assert.deepEqual(bot.controls, {});
  await assert.rejects(world.execute('Tester', { type: 'wait', ms: 1 }), /正在执行/);
  aim.release(); assert.equal((await pending).status, 'cancelled');
  assert.deepEqual(bot.attacks, []); assert.deepEqual(steps, []); assert.deepEqual(bot.controls, {});
});

test('an initially hidden distant entity reveals no live distance in attack or interaction errors', async () => {
  const bot = fakeBot();
  bot.entities[2] = { id: 2, name: 'zombie', position: new Vec3(8.8, 64, 0), width: .6, height: 1.8, health: 15 };
  bot.world.raycast = () => ({ name: 'stone' });
  bot.lookAt = async () => { assert.fail('An occluded target must not be aimed at.'); };
  bot.activateEntity = async () => { assert.fail('An occluded target must not be interacted with.'); };
  for (const proposal of [{ type: 'attack', entityId: 2, durationMs: 1000 }, { type: 'interact', entityId: 2 }]) {
    await assert.rejects(runNativeAction(bot, proposal, new AbortController().signal), (error: any) => {
      assert.match(error.message, /遮挡/); assert.doesNotMatch(error.message, /8\.5|当前|距离/);
      if (proposal.type === 'attack') {
        assert.equal(error.details.targetVisible, false); assert.equal(error.details.lastObservedTarget, null);
        assert.equal(error.details.attempts, 0); assert.equal(error.details.healthBefore, null); assert.equal(error.details.healthAfter, null);
        assert.doesNotMatch(error.details.stoppedReason, /8\.5|当前|距离/);
      }
      return true;
    });
  }
  assert.deepEqual(bot.attacks, []);
});

test('a moving melee target retains the already-sent strike and last visible range on failure', async () => {
  const bot = fakeBot();
  bot.entity.position = new Vec3(-220.04368136415036, 72, -104.00215645342311);
  const before = bot.entity.position.clone(), enemy = { id: 362, name: 'zombie', height: 1.8, width: .6,
    position: before.offset(2.3, 0, 0), health: 20 };
  bot.entities[362] = enemy;
  bot.attack = (target: any) => { bot.attacks.push(target.id); enemy.position = before.offset(4.6, 0, 0); enemy.health = 18; };
  await assert.rejects(runNativeAction(bot, { type: 'attack', entityId: 362, durationMs: 1000 }, new AbortController().signal), (error: any) => {
    assert.match(error.message, /4\.3/); const d = error.details;
    assert.equal(d.targetId, 362); assert.equal(d.attackEntityId, 362); assert.equal(d.attempts, 1); assert.equal(d.partial, true);
    assert.equal(d.healthBefore, 20); assert.equal(d.healthAfter, 18); assert.equal(d.damageConfirmed, false);
    assert.deepEqual(d.lastObservedTarget.position, { ...enemy.position }); assert.equal(d.lastObservedTarget.reachDistance, 4.3);
    assert.ok(d.lastObservedTarget.time); assert.equal(d.targetVisible, true); return true;
  });
  assert.deepEqual(bot.attacks, [362]); assert.ok(bot.entity.position.equals(before)); assert.deepEqual(bot.controls, {});
});

test('a newly occluded melee target does not reveal its hidden position in a partial failure', async () => {
  const bot = fakeBot(), original = new Vec3(2, 64, 0);
  const enemy = { id: 317, name: 'zombie', height: 1.8, width: .6, position: original, health: 20 };
  bot.entities[317] = enemy;
  bot.attack = (target: any) => {
    bot.attacks.push(target.id); enemy.position = new Vec3(8.8, 64, 0); enemy.health = 7;
    bot.world.raycast = () => ({ name: 'stone' });
  };
  await assert.rejects(runNativeAction(bot, { type: 'attack', entityId: 317, durationMs: 2000 }, new AbortController().signal), (error: any) => {
    assert.match(error.message, /遮挡/); const d = error.details;
    assert.doesNotMatch(error.message, /8\.5|当前|距离/); assert.doesNotMatch(d.stoppedReason, /8\.5|当前|距离/);
    assert.equal(d.attempts, 1); assert.equal(d.partial, true); assert.equal(d.targetVisible, false);
    assert.deepEqual(d.lastObservedTarget.position, { ...original });
    assert.equal(d.healthBefore, 20); assert.equal(d.healthAfter, null); assert.equal(d.damageConfirmed, false); return true;
  });
});

test('melee cancellation preserves sent attempts and never sends a later strike', async () => {
  const bot = fakeBot(), controller = new AbortController();
  bot.entities[25] = { id: 25, name: 'zombie', position: new Vec3(2, 64, 0), width: .6, height: 1.8, health: 12 };
  bot.attack = (target: any) => { bot.attacks.push(target.id); controller.abort(); };
  await assert.rejects(runNativeAction(bot, { type: 'attack', entityId: 25, durationMs: 2500 }, controller.signal), (error: any) => {
    assert.equal(error.details.attempts, 1); assert.equal(error.details.targetId, 25);
    assert.equal(error.details.healthBefore, 12); assert.equal(error.details.partial, true);
    assert.equal(error.details.damageConfirmed, false); assert.match(error.details.note, /不保证命中/); return true;
  });
  await delay(20); assert.deepEqual(bot.attacks, [25]); assert.deepEqual(bot.controls, {});
  await assert.rejects(runNativeAction(bot, { type: 'attack', entityId: 407, durationMs: 1000 }, new AbortController().signal), (error: any) => {
    assert.equal(error.details.targetId, 407); assert.equal(error.details.attempts, 0);
    assert.equal(error.details.partial, false); assert.equal(error.details.lastObservedTarget, null); return true;
  });
});

test('1.21.4 dragon attacks map to body ID and body geometry, never guessed head positions', async () => {
  const bot = fakeBot(), dragon = { id: 100, name: 'ender_dragon', position: new Vec3(2, 64, 0), yaw: 0, width: 16, height: 8 };
  bot.entities[100] = dragon;
  const target = meleeTarget(bot, dragon);
  assert.equal(target.id, 103); assert.equal(target.width, 5); assert.equal(target.height, 3);
  assert.deepEqual(target.position, new Vec3(2, 64, .5));
  const result = await runNativeAction(bot, { type: 'attack', entityId: 100, durationMs: 1 }, new AbortController().signal);
  assert.deepEqual(bot.attacks, [103]);
  assert.equal(result.targetId, 100); assert.equal(result.attackEntityId, 103);
  bot.version = '1.20.4'; assert.throws(() => meleeTarget(bot, dragon), /仅验证/);
});

test('bow cancellation releases held item and stops the pending shot', async () => {
  const { bot, record, world } = await fixture();
  bot.entities[9] = { id: 9, name: 'end_crystal', position: new Vec3(20, 70, 0), width: 2, height: 2 };
  let aim: Vec3 | undefined; bot.lookAt = async (point: Vec3) => { aim = point; };
  const pending = world.execute('Tester', { type: 'shoot', entityId: 9 });
  await delay(10);
  assert.equal(bot.usingHeldItem, true);
  assert.ok(aim && aim.y > 71);
  world.stop(record);
  assert.equal((await pending).status, 'cancelled');
  assert.equal(bot.usingHeldItem, false);
});

test('drag-compensated bow aim crosses static crystal centres at 30–90 blocks and varied heights', () => {
  const origin = new Vec3(7, 73.62, -7);
  for (const distance of [30, 60, 90]) for (const height of [-10, 0, 10, 30]) {
    const target = origin.offset(distance * .6, height, distance * .8);
    if (distance === 90 && height === 30) {
      assert.throws(() => solveBowShot(origin, target), /无法到达/);
      continue;
    }
    const solution = solveBowShot(origin, target);
    // Independent 3D integration checks the actual segment crossing the target's
    // horizontal plane, rather than comparing the solver with its own helper.
    let position = solution.launchOrigin.clone(), velocity = solution.initialVelocity.clone();
    let crossing: Vec3 | undefined;
    for (let tick = 0; tick < 240; tick++) {
      const next = position.plus(velocity);
      const travelled = Math.hypot(position.x - origin.x, position.z - origin.z);
      const nextTravelled = Math.hypot(next.x - origin.x, next.z - origin.z);
      if (nextTravelled >= distance) {
        crossing = position.plus(velocity.scaled((distance - travelled) / (nextTravelled - travelled)));
        break;
      }
      position = next; velocity = velocity.scaled(.99).offset(0, -.05, 0);
    }
    assert.ok(crossing && crossing.distanceTo(target) < .001, `trajectory misses ${distance}m / ${height}m`);
    assert.ok(solution.estimatedFlightTicks > distance / 3);
  }
  assert.throws(() => solveBowShot(origin, origin.offset(0, 30, 0)), /垂直/);
  assert.throws(() => solveBowShot(origin, origin.offset(300, 200, 0)), /无法到达/);
});

test('native straight movement reports blocked and clears controls', async () => {
  const { bot, world } = await fixture();
  const result = await world.execute('Tester', { type: 'goto', x: 5, y: 64, z: 0 });
  assert.equal(result.status, 'failed'); assert.match(result.error!, /障碍/);
  assert.equal(result.details.movement.reasonCode, 'no_progress');
  assert.deepEqual(result.details.movement.target, { x: 5, y: 64, z: 0 });
  assert.deepEqual(bot.controls, {});
});

test('goto does not claim arrival during a jump or on the wrong floor from recorded Deadpool positions', async () => {
  for (const scenario of [
    { current: new Vec3(-234.05509790769005, 73.02442408821369, -111.49112402624162), target: new Vec3(-234.5, 72, -111.5), landingY: 73 },
    { current: new Vec3(-234.4184780265215, 74.25220334025373, -110.9191876831613), target: new Vec3(-234.5, 73, -110.5), landingY: 74 },
  ]) {
    const bot = fakeBot(); bot.entity.position = scenario.current; bot.entity.onGround = false;
    bot.entity.velocity = new Vec3(-.1, -.08, 0); bot.setControlState('jump', true); bot.setControlState('forward', true);
    let settled = false;
    const pending = nativeWalkTo(bot, scenario.target, new AbortController().signal).then(() => { settled = true; return null; }, error => { settled = true; return error; });
    assert.deepEqual(bot.controls, {});
    await delay(15); assert.equal(settled, false, 'Airborne XZ proximity cannot complete a goto.');
    bot.entity.position = new Vec3(scenario.target.x, scenario.landingY, scenario.target.z);
    bot.entity.onGround = true; bot.entity.velocity = new Vec3(0, 0, 0);
    bot.blockAt = (position: Vec3) => ({ name: position.y === scenario.landingY - 1 ? 'stone' : 'air',
      boundingBox: position.y === scenario.landingY - 1 ? 'block' : 'empty', position });
    const failure = await pending;
    assert.equal(failure.details.movement.reasonCode, 'vertical_only');
    assert.equal(failure.details.movement.verticalDelta, -1); assert.deepEqual(bot.controls, {});
  }
});

test('recorded HuYifei descent waits through stale onGround and succeeds only after same-level landing', async () => {
  for (const pausedX of [-225.332, -225.48]) {
    const bot = fakeBot(), target = new Vec3(-225.5, 75, -113.5), checkedCells: Vec3[] = [];
    bot.entity.position = new Vec3(-224.5, 76, -113.5);
    bot.blockAt = (position: Vec3) => {
      checkedCells.push(position.clone());
      if (position.x <= -227) return null;
      const solid = position.y === (position.x >= -225 ? 75 : 74);
      return { name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty', position };
    };
    bot.setControlState = (key: string, value: boolean) => {
      bot.controls[key] = value;
      if (key === 'forward' && value) bot.entity.position = new Vec3(pausedX, 76, -113.5);
    };
    let settled = false;
    const pending = nativeWalkTo(bot, target, new AbortController().signal)
      .then(() => { settled = true; return null; }, error => { settled = true; return error; });
    await delay(80);
    assert.equal(settled, false, 'XZ proximity plus stale onGround must neither fail nor claim arrival.');
    assert.deepEqual(bot.controls, {});
    assert.equal(checkedCells.some(cell => cell.x <= -227), false, 'The motor must not inspect beyond the destination.');
    bot.entity.onGround = false; bot.entity.velocity = new Vec3(-.05, -.08, 0);
    await delay(60); assert.equal(settled, false);
    bot.entity.position = new Vec3(-225.746, 75, -113.5);
    bot.entity.onGround = true; bot.entity.velocity = new Vec3(0, 0, 0);
    assert.equal(await pending, null); assert.deepEqual(bot.controls, {});
  }
});

test('short forward terrain checks stop at the target rather than sampling the next column', async () => {
  const bot = fakeBot(), target = new Vec3(-225.95, 75, -113.5), checkedCells: Vec3[] = [];
  bot.entity.position = new Vec3(-225.25, 76, -113.5);
  bot.blockAt = (position: Vec3) => {
    checkedCells.push(position.clone());
    if (position.x <= -227) return null;
    const solid = position.y === 74;
    return { name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty', position };
  };
  bot.setControlState = (key: string, value: boolean) => {
    bot.controls[key] = value;
    if (key === 'forward' && value) bot.entity.position = target.clone();
  };
  await nativeWalkTo(bot, target, new AbortController().signal);
  assert.equal(checkedCells.some(cell => cell.x <= -227), false);
  assert.deepEqual(bot.controls, {});
});

test('stale ground contact cannot permit an unknown, hazardous or deep descent', async () => {
  for (const kind of ['unknown', 'hazard', 'deep']) {
    const bot = fakeBot(); bot.entity.position = new Vec3(-225.332, 76, -113.5);
    bot.blockAt = (position: Vec3) => {
      if (position.y === 74 && kind === 'unknown') return null;
      return { name: position.y === 74 && kind === 'hazard' ? 'lava' : 'air', boundingBox: 'empty', position };
    };
    await assert.rejects(nativeWalkTo(bot, new Vec3(-225.5, 75, -113.5), new AbortController().signal), (error: any) => {
      assert.equal(error.details.movement.reasonCode, kind === 'unknown' ? 'unknown_support' : kind === 'hazard' ? 'hazardous_landing' : 'unsupported_drop');
      return true;
    });
    assert.deepEqual(bot.controls, {});
  }
});

test('cancelling a pending step down immediately releases controls and cannot resume movement', async () => {
  const bot = fakeBot(), controller = new AbortController();
  bot.entity.position = new Vec3(-225.332, 76, -113.5);
  bot.blockAt = (position: Vec3) => ({ name: position.y === 74 ? 'stone' : 'air',
    boundingBox: position.y === 74 ? 'block' : 'empty', position });
  const pending = nativeWalkTo(bot, new Vec3(-225.5, 75, -113.5), controller.signal);
  bot.setControlState('forward', true); controller.abort();
  assert.deepEqual(bot.controls, {});
  await assert.rejects(pending, /aborted|取消/);
  await delay(60); assert.deepEqual(bot.controls, {});
});

test('explicit dig may remove its own support but leaves the resulting fall to vanilla physics', async () => {
  const bot = fakeBot(), cell = new Vec3(0, 63, 0), reads: Vec3[] = [];
  bot.entity.position = Object.freeze(new Vec3(.5, 64, .5));
  const before = bot.entity.position.clone();
  const stone = { name: 'stone', type: 1, boundingBox: 'block', position: cell };
  const air = { name: 'air', type: 0, boundingBox: 'empty', position: cell };
  let current = stone, dug = false;
  bot.blockAt = (position: Vec3) => { reads.push(position.clone()); return current; };
  bot.canDigBlock = () => true;
  bot.dig = async (block: any) => { assert.equal(block, stone); dug = true; current = air; };
  const result = await runNativeAction(bot, { type: 'dig', x: cell.x, y: cell.y, z: cell.z }, new AbortController().signal);
  assert.equal(dug, true); assert.equal(result.removedSupportingBlock, true);
  assert.ok(bot.entity.position.equals(before)); assert.equal(bot.entity.onGround, true);
  assert.equal(reads.every(position => position.equals(cell)), true, 'Direct dig does not reveal what is below the support.');
  assert.deepEqual(bot.controls, {});
  let miningFinished = false;
  bot.blockAt = () => miningFinished ? null : stone;
  bot.dig = async () => { miningFinished = true; };
  await assert.rejects(runNativeAction(bot, { type: 'dig', x: cell.x, y: cell.y, z: cell.z }, new AbortController().signal), /尚未确认/,
    'An unloaded result cannot prove that support was removed.');
});

test('goto waits for a recorded in-progress descent to land and coast to rest rather than reporting vertical_only', async () => {
  const bot = fakeBot(), target = new Vec3(-224.5, 70, -106.5);
  bot.entity.position = new Vec3(-224.53225485316352, 71.76636799395752, -106.47940920462936);
  bot.entity.onGround = false; bot.entity.velocity = new Vec3(.04, -.3, -.04);
  bot.setControlState('forward', true);
  let completed = false;
  const pending = nativeWalkTo(bot, target, new AbortController().signal).then(() => { completed = true; });
  assert.deepEqual(bot.controls, {}); await delay(15); assert.equal(completed, false);
  bot.entity.position = target.clone(); bot.entity.onGround = true;
  bot.entity.velocity = new Vec3(.04, 0, 0);
  await delay(60); assert.equal(completed, false, 'Ground contact alone does not eliminate horizontal momentum.');
  bot.entity.position = target.offset(.1, 0, 0); bot.entity.velocity = new Vec3(.01, 0, 0);
  await pending; assert.equal(completed, true); assert.equal(bot.entity.position.y, 70); assert.deepEqual(bot.controls, {});
});

test('goto releases control at the horizontal boundary and waits for momentum instead of continuing forward', async () => {
  const bot = fakeBot(); bot.entity.position = new Vec3(1, 64, 0); bot.entity.velocity = new Vec3(.15, 0, 0);
  bot.setControlState('forward', true); bot.setControlState('jump', true);
  let completed = false;
  const pending = nativeWalkTo(bot, new Vec3(1.2, 64, 0), new AbortController().signal).then(() => { completed = true; });
  assert.deepEqual(bot.controls, {}); await delay(15); assert.equal(completed, false);
  bot.entity.position = new Vec3(1.12, 64, 0); bot.entity.velocity = new Vec3(.01, 0, 0);
  await pending; assert.deepEqual(bot.controls, {});
});

test('cancelling while waiting for landing clears controls immediately and leaves no pending body action', async () => {
  const bot = fakeBot(), controller = new AbortController();
  bot.entity.onGround = false; bot.entity.position = new Vec3(0, 65, 0);
  const pending = nativeWalkTo(bot, new Vec3(0, 64, 0), controller.signal);
  bot.setControlState('forward', true); controller.abort();
  assert.deepEqual(bot.controls, {});
  await assert.rejects(pending, /aborted|取消/);
  await delay(60); assert.deepEqual(bot.controls, {});
});

test('an unconfirmed landing has a bounded wait and cannot return reached', async () => {
  const bot = fakeBot(); bot.entity.onGround = false;
  await assert.rejects(nativeWalkTo(bot, bot.entity.position.clone(), new AbortController().signal), (error: any) => {
    assert.equal(error.details.movement.reasonCode, 'landing_unsettled'); return true;
  });
  assert.deepEqual(bot.controls, {});
});

test('movement failure identifies the actual blocking cell and separates a wrong target height', async () => {
  const { bot, world } = await fixture();
  bot.entity.position = new Vec3(.5, 64, .5);
  const original = bot.blockAt;
  bot.blockAt = (position: Vec3) => position.equals(new Vec3(1, 65, 0))
    ? { name: 'oak_leaves', boundingBox: 'block', position } : original(position);
  const blocked = await world.execute('Tester', { type: 'goto', x: 3.5, y: 64, z: .5 });
  assert.equal(blocked.details.movement.reasonCode, 'head_blocked');
  assert.deepEqual(blocked.details.movement.blocker, { name: 'oak_leaves', position: { x: 1, y: 65, z: 0 } });
  assert.deepEqual(bot.controls, {});
  const vertical = await world.execute('Tester', { type: 'goto', x: .5, y: 62, z: .5 });
  assert.equal(vertical.details.movement.reasonCode, 'target_blocked');
  assert.equal(vertical.details.movement.blocker.position.y, 63);
  assert.equal(vertical.details.movement.horizontalDistance, 0);
  assert.equal(vertical.details.movement.verticalDelta, -2);
  assert.deepEqual(vertical.details.movement.current, { x: .5, y: 64, z: .5 });
  assert.deepEqual(vertical.details.movement.target, { x: .5, y: 62, z: .5 });
});

test('goto to an adjacent standing cell actually moves instead of declaring success one block away', async () => {
  const { bot, world } = await fixture();
  bot.entity.position = new Vec3(.5, 64, .5);
  let moved = false;
  bot.setControlState = (key: string, value: boolean) => {
    bot.controls[key] = value;
    if (key === 'forward' && value) { moved = true; bot.entity.position = new Vec3(1.5, 64, .5); }
  };
  const result = await world.execute('Tester', { type: 'goto', x: 1.5, y: 64, z: .5 });
  assert.equal(result.status, 'completed'); assert.equal(moved, true);
  assert.deepEqual(result.after, { x: 1.5, y: 64, z: .5 });
  assert.deepEqual(bot.controls, {});
});

test('observation includes equipment, dimension, visible distant crystals and named health metadata', async () => {
  const { bot, world } = await fixture();
  bot.entities[3] = { id: 3, name: 'end_crystal', type: 'object', position: new Vec3(60, 90, 0), width: 2, height: 2 };
  bot.registry = { entitiesByName: { ender_dragon: { metadataKeys: ['unused', 'health'] } } };
  assert.equal(entityHealth(bot, { name: 'ender_dragon', metadata: [0, 123] }), 123);
  assert.equal(entityHealth(bot, bot.entities[3]), null);
  const observation = world.observe('Tester');
  assert.equal(observation.dimension, 'the_end'); assert.equal(observation.nearbyEntities[0].id, 3);
  assert.equal(observation.equipment.hand, null);
});

test('a crystal above a ledge remains visible when its nearest corner and centre are occluded', () => {
  const bot = fakeBot(), crystal = { position: new Vec3(20, 80, 0), width: 2, height: 2 };
  const endpoints: number[] = [];
  bot.world.raycast = (origin: Vec3, direction: Vec3) => {
    const heightAtWall = origin.y + direction.y * (10 / direction.x);
    endpoints.push(heightAtWall);
    return heightAtWall < 73.5 ? { name: 'obsidian' } : null;
  };
  assert.equal(entityVisible(bot, crystal), true);
  assert.equal(endpoints.length, 3);
  assert.ok(endpoints[0] < 73.5 && endpoints[1] < 73.5 && endpoints[2] >= 73.5);
});

test('observed dropped stacks are distinguished from usable world blocks and player inventory', async () => {
  const { bot, world } = await fixture();
  bot.entities[4] = { id: 4, name: 'item', type: 'object', position: new Vec3(2, 64, 0),
    getDroppedItem: () => ({ name: 'crafting_table', count: 1 }) };
  bot.entities[5] = { id: 5, name: 'item', type: 'object', position: new Vec3(3, 64, 0),
    getDroppedItem: () => null };
  bot.entities[6] = { id: 6, name: 'player', type: 'player', position: new Vec3(4, 64, 0),
    getDroppedItem: () => { throw new Error('Players are not dropped item stacks.'); } };
  const observation = world.observe('Tester');
  const drop = observation.nearbyEntities.find(entity => entity.id === 4)!;
  assert.equal(drop.type, 'item');
  assert.deepEqual(drop.droppedItem, { name: 'crafting_table', count: 1 });
  assert.equal(observation.nearbyEntities.find(entity => entity.id === 5)!.droppedItem, null);
  assert.equal(observation.nearbyEntities.find(entity => entity.id === 6)!.droppedItem, undefined);
  assert.equal(observation.nearbyBlocks.some(block => block.name === 'crafting_table'), false);
});

test('multiple visibility samples do not reveal an entity entirely behind a solid wall', () => {
  const bot = fakeBot(); let casts = 0;
  bot.world.raycast = () => { casts++; return { name: 'stone' }; };
  assert.equal(entityVisible(bot, { position: new Vec3(20, 80, 0), width: 2, height: 2 }), false);
  assert.equal(casts, 3);
});

test('death, respawn, spawn and disconnect update readiness and emit npc events', async context => {
  const bot = fakeBot(); context.mock.method(mineflayer, 'createBot', () => bot);
  const { world } = await fixture();
  const events: string[] = []; world.onEvent = (record, event) => { assert.equal(event.npcId, record.name); events.push(event.type); };
  const record = world.add('Lifecycle', 'test');
  bot.emit('spawn'); assert.equal(record.ready, true);
  record.task = { id: 'interrupted-turn', controller: new AbortController() };
  bot.emit('death'); assert.equal(record.ready, false);
  assert.deepEqual(record.task.controller.signal.reason, { type: 'world-event', event: 'death' });
  const deathPosition = { ...bot.entity.position };
  bot.entity.position.x += 5;
  assert.deepEqual(record.events.find(event => event.type === 'death').position, deathPosition,
    'Later movement must not rewrite the remembered location of a death.');
  bot.emit('respawn'); assert.equal(record.ready, false);
  bot.emit('spawn'); assert.equal(record.ready, true);
  bot.emit('end'); assert.equal(record.ready, false);
  assert.deepEqual(events, ['spawn', 'death', 'respawn', 'spawn', 'disconnected']);
});

test('spawn cannot stand in for a fully received player inventory packet', async context => {
  const bot = fakeBot(); bot._client = new EventEmitter();
  context.mock.method(mineflayer, 'createBot', () => bot);
  const { world } = await fixture();
  const record = world.add('InventorySync', 'test');
  bot.emit('spawn');
  assert.equal(record.ready, true); assert.equal(record.inventorySynced, false);
  bot._client.emit('window_items', { windowId: 3 }); await Promise.resolve();
  assert.equal(record.inventorySynced, false, 'A chest packet cannot confirm the player inventory.');
  bot._client.emit('window_items', { windowId: 0 });
  assert.equal(record.inventorySynced, false, 'Wait until every packet handler has applied the full contents.');
  await Promise.resolve();
  assert.equal(record.inventorySynced, true);
});

test('an NPC stopping its body can finish thinking while operator stop cancels its task', async () => {
  const { world, bot } = await fixture();
  const record = world.get('Tester');
  record.task = { id: 'current-turn', controller: new AbortController() };
  bot.setControlState('forward', true);
  const receipt = await world.execute('Tester', { type: 'stop' }, 'current-turn');
  assert.equal(receipt.status, 'completed');
  assert.equal(record.task.controller.signal.aborted, false);
  assert.deepEqual(bot.controls, {});
  await world.execute('Tester', { type: 'look', x: 1, y: 64, z: 0 }, 'current-turn');
  await world.execute('Tester', { type: 'stop' });
  assert.equal(record.task.controller.signal.aborted, true);
});

test('damage becomes a perceived event without inventing a cause, and action receipts expose changed vitals', async context => {
  const bot = fakeBot(); context.mock.method(mineflayer, 'createBot', () => bot);
  const { world } = await fixture();
  const record = world.add('Damaged', 'test');
  bot.emit('spawn'); bot.emit('health');
  bot.health = 16; bot.emit('health');
  const injury = record.events.find(event => event.type === 'hurt');
  assert.equal(injury.loss, 4); assert.equal(injury.healthBefore, 20); assert.equal(injury.health, 16);
  assert.equal(injury.attacker, undefined);
  bot.health = 18; bot.emit('health');
  assert.equal(record.events.filter(event => event.type === 'hurt').length, 1, 'Healing is not another injury.');
  bot.lookAt = async () => { bot.health = 12; bot.food = 8; };
  const result = await world.execute('Damaged', { type: 'look', x: 1, y: 65, z: 0 });
  assert.deepEqual(result.details.vitals, { healthBefore: 18, health: 12, food: 8 });
});

test('ordinary native receipts expose actual inventory changes, including partial failure', async () => {
  const { bot, world } = await fixture();
  let bag: any[] = [];
  bot.inventory.items = () => bag;
  bot.lookAt = async () => { bag = [{ name: 'oak_log', count: 2 }]; };
  const pickup = await world.execute('Tester', { type: 'look', x: 1, y: 65, z: 0 });
  assert.deepEqual(pickup.details.inventoryDelta, [{ item: 'oak_log', change: 2 }]);
  bot.lookAt = async () => { bag = [{ name: 'oak_log', count: 1 }]; throw new Error('interrupted after an actual inventory update'); };
  const partial = await world.execute('Tester', { type: 'look', x: 1, y: 65, z: 0 });
  assert.equal(partial.status, 'failed');
  assert.deepEqual(partial.details.inventoryDelta, [{ item: 'oak_log', change: -1 }]);
});

test('perception subscriptions stay within one NPC and can interrupt a body without cancelling its task', async () => {
  const { bot, world, record } = await fixture();
  const other = { name: 'Other', persona: '', ready: true, bot: fakeBot(), events: [] };
  world.bots.set(other.name, other);
  record.task = { id: 'perception-turn', controller: new AbortController() };
  const received: string[] = [];
  const unsubscribe = world.subscribe('Tester', event => {
    if (event.type !== 'hurt') return;
    received.push(event.npcId); world.interruptAction('Tester');
  });
  world.event(other, 'hurt', { health: 15 }); assert.deepEqual(received, []);
  const running = world.execute('Tester', { type: 'move', controls: ['forward'], ms: 5000 }, 'perception-turn');
  await delay(5);
  world.event(record, 'hurt', { healthBefore: 20, health: 16, food: 15 });
  assert.equal(record.task.controller.signal.aborted, false);
  const result = await running;
  assert.equal(result.status, 'cancelled'); assert.deepEqual(bot.controls, {});
  assert.deepEqual(received, ['Tester']); assert.equal(record.task.id, 'perception-turn');
  unsubscribe(); unsubscribe();
  world.event(record, 'hurt', { health: 10 }); assert.deepEqual(received, ['Tester']);
});

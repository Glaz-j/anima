import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import entityFactory from 'prismarine-entity';
import itemFactory from 'prismarine-item';
import registryFactory from 'prismarine-registry';
import blockFactory from 'prismarine-block';
import { MinecraftWorld } from '../adapters/minecraft/src/world.ts';
import { blockProperties, BLOCK_PROPERTY_BUDGET } from '../adapters/minecraft/src/block-observation.ts';
import { action } from '../adapters/minecraft/src/validation.ts';
import { nativeWalkTo, runNativeAction } from '../adapters/minecraft/src/native-actions.ts';
import { droppedItemSummary } from '../adapters/minecraft/src/entity-observation.ts';
import { runSurvivalAction } from '../adapters/minecraft/src/survival-actions.ts';
import { synchronizeCraftInventory } from '../adapters/minecraft/src/craft-sync.ts';
import { managedWindowOperation, releaseUnmanagedWindow, windowlessInteraction } from '../adapters/minecraft/src/window-lifecycle.ts';

function fixture() {
  const bag = new Map<string, number>(), blocks = new Map<string, any>(), controls: Record<string, boolean> = {};
  const names = ['oak_log', 'oak_planks', 'wooden_pickaxe', 'raw_iron', 'iron_ingot', 'coal', 'stone'];
  const definitions = Object.fromEntries(names.map((name, i) => [name, { id: i + 1, name }]));
  const items = () => [...bag.entries()].filter(([, count]) => count > 0).map(([name, count]) => ({ ...definitions[name], type: definitions[name].id, metadata: null, count }));
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { id: 1, position: new Vec3(.5, 64, .5), eyeHeight: 1.62, onGround: true }, game: { dimension: 'overworld' }, version: '1.21.4', entities: {},
    registry: { itemsByName: definitions, items: Object.fromEntries(Object.values(definitions).map(i => [i.id, i])),
      blocksByName: { oak_log: { id: 100 }, iron_ore: { id: 101 } } },
    inventory: { items }, currentWindow: null, world: { raycast: () => null },
    clearControlStates: () => { for (const key of Object.keys(controls)) delete controls[key]; },
    setControlState: (key: string, value: boolean) => { controls[key] = value; },
    stopDigging: () => {}, lookAt: async () => {}, equip: async (item: any) => { bot.heldItem = item; },
    canSeeBlock: (block: any) => Boolean(block && !block.hidden), canDigBlock: () => true,
    blockAt: (position: Vec3) => blocks.get(position.floored().toString()) || { position: position.floored(), type: 0, name: 'air', boundingBox: 'empty' },
    findBlocks: ({ matching, maxDistance }: any) => [...blocks.values()].filter(block => typeof matching === 'function' ? matching(block) : block.type === matching)
      .filter(block => block.position.distanceTo(bot.entity.position) <= maxDistance).map(block => block.position),
  });
  bot._client = new EventEmitter();
  bot._client.write = (name: string, packet: any) => {
    assert.equal(name, 'client_command'); assert.equal(packet.actionId, 'request_stats');
    queueMicrotask(() => bot._client.emit('statistics', { entries: [] }));
  };
  function block(name: string, position: Vec3, extra: any = {}) {
    const value = { name, position, type: bot.registry.blocksByName[name]?.id ?? 200, boundingBox: 'block', ...extra };
    blocks.set(position.toString(), value); return value;
  }
  const recipe = { result: { id: definitions.oak_planks.id, count: 4 }, delta: [{ id: definitions.oak_log.id, count: -1 }, { id: definitions.oak_planks.id, count: 4 }], requiresTable: false };
  bot.recipesAll = () => [recipe];
  bot.recipesFor = () => (bag.get('oak_log') || 0) > 0 ? [recipe] : [];
  bot.craft = async (_recipe: any, count: number) => { assert.equal(count, 1); bag.set('oak_log', (bag.get('oak_log') || 0) - 1); bag.set('oak_planks', (bag.get('oak_planks') || 0) + 4); };
  bot._syncWindow = async (window: any) => { assert.equal(window, bot.inventory); };
  const run = (proposal: any, signal = new AbortController().signal) => runNativeAction(bot, action(proposal), signal);
  return { bot, bag, blocks, controls, definitions, block, run };
}

test('survival schemas reject unbounded scans, missing container items and invalid nested positions', () => {
  for (const invalid of [{ type: 'scan', count: 17 }, { type: 'scan', maxDistance: 65 }, { type: 'scan', kind: 'server' },
    { type: 'gather', block: 'oak_log', count: 17 }, { type: 'gather', block: 'oak_log', maxDistance: 33 },
    { type: 'craft', item: 'oak_planks', count: 0 }, { type: 'craft', item: 'oak_planks', table: { x: Infinity, y: 1, z: 1 } },
    { type: 'container', operation: 'withdraw', position: { x: 1, y: 64, z: 0 } },
    { type: 'smelt', input: 'raw_iron', fuel: 'coal', count: 100, position: { x: 1, y: 64, z: 0 } }]) assert.throws(() => action(invalid));
  assert.equal(action({ type: 'gather', block: 'oak_log' }).count, 1);
});

test('scan reveals only visible local blocks/entities with world positions', async () => {
  const { bot, block, run } = fixture();
  block('oak_log', new Vec3(2, 64, 0)); block('oak_log', new Vec3(3, 64, 0), { hidden: true });
  bot.entities[2] = { id: 2, name: 'cow', position: new Vec3(4, 64, 0), height: 1.4, width: 1 };
  const result: any = await run({ type: 'scan', name: 'log', kind: 'blocks', maxDistance: 8 });
  assert.equal(result.blocks.length, 1); assert.deepEqual(result.blocks[0].position, { x: 2, y: 64, z: 0 });
  assert.equal(result.scope, 'visible-loaded-only');
  assert.equal((await run({ type: 'scan', kind: 'entities' }) as any).entities[0].id, 2);
});

test('real block states distinguish filled frames and fluid sources only after visibility in scan and observe', async () => {
  const registry = registryFactory('1.21.4'), Block = blockFactory(registry);
  const { bot, blocks, run } = fixture();
  bot.registry = registry; bot.inventory.slots = []; bot.time = {};
  const world = new MinecraftWorld({ host: 'unused', port: 0, version: '1.21.4', logDirectory: 'unused' });
  world.bots.set('Tester', { name: 'Tester', persona: 'test', bot, ready: true, events: [] });
  const cell = new Vec3(2, 64, 0);
  const state = (name: string, key: string, value: boolean | number | string) => {
    const definition = registry.blocksByName[name];
    for (let id = definition.minStateId; id <= definition.maxStateId; id++) {
      const block: any = Block.fromStateId(id, 0);
      if (block.getProperties()[key] === value) { block.position = cell.clone(); return block; }
    }
    assert.fail(`Missing installed block state: ${name}.${key}=${value}`);
  };
  for (const eye of [false, true]) {
    blocks.set(cell.toString(), state('end_portal_frame', 'eye', eye));
    const scan: any = await run({ type: 'scan', kind: 'blocks', name: 'end_portal_frame', count: 1 });
    assert.equal(scan.blocks[0].properties.eye, eye);
    assert.equal(world.observe('Tester').nearbyBlocks[0].properties.eye, eye);
  }
  // This registry exposes fluid levels as enum strings; preserve the native value.
  for (const level of ['0', '1']) {
    blocks.set(cell.toString(), state('water', 'level', level));
    const scan: any = await run({ type: 'scan', kind: 'blocks', name: 'water', count: 1 });
    assert.equal(scan.blocks[0].properties.level, level);
  }
  let hiddenReads = 0;
  const hidden = state('end_portal_frame', 'eye', true);
  hidden.getProperties = () => { hiddenReads++; return { eye: true, nbt: { private: 'not-visible' } }; };
  blocks.set(cell.toString(), hidden); bot.canSeeBlock = () => false;
  assert.deepEqual((await run({ type: 'scan', kind: 'blocks' }) as any).blocks, []);
  assert.deepEqual(world.observe('Tester').nearbyBlocks, []);
  assert.equal(hiddenReads, 0, 'Do not query hidden interaction state.');
});

test('block property projection keeps native false and zero but excludes arbitrary contents and remains bounded', () => {
  assert.deepEqual(blockProperties({ getProperties: () => ({ eye: false, level: 0, nbt: { Items: 'private' }, arbitrary: 'hidden' }) }),
    { eye: false, level: 0 });
  const result = blockProperties({ getProperties: () => ({ eye: true, level: 0, lit: true, open: false, age: 2,
    waterlogged: false, occupied: false, moisture: 7, powered: true, facing: 'x'.repeat(40), half: 'top', stage: 1 }) })!;
  assert.ok(Object.keys(result).length <= BLOCK_PROPERTY_BUDGET.entries);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= BLOCK_PROPERTY_BUDGET.bytes);
  assert.equal(blockProperties({}), undefined);
  assert.equal(blockProperties({ getProperties: () => { throw new Error('state unavailable'); } }), undefined);
  assert.equal(blockProperties({ getProperties: () => ({ level: NaN, eye: null, facing: 'x'.repeat(33) }) }), undefined);
});

test('a literal animal query does not imply no visible animals and reports how to broaden the query', async () => {
  const { bot, run } = fixture();
  bot.entities[2] = { id: 2, name: 'cow', position: new Vec3(4, 64, 0), height: 1.4, width: 1 };
  const specific: any = await run({ type: 'scan', name: 'animal', kind: 'entities' });
  assert.deepEqual(specific.entities, []);
  assert.equal(specific.filter.mode, 'case-insensitive-substring');
  assert.equal(specific.filter.query, 'animal');
  assert.equal(specific.filter.semanticCategories, false);
  assert.match(specific.filter.note, /省略name/);
  const broad: any = await run({ type: 'scan', kind: 'entities' });
  assert.equal(broad.entities[0].type, 'cow');
  const substring: any = await run({ type: 'scan', name: 'minecraft:CO', kind: 'entities' });
  assert.equal(substring.entities[0].type, 'cow');
  assert.equal(substring.filter.query, 'co');
});

test('dropped item summaries decode official metadata and preserve unknown without reading player equipment', () => {
  const registry = registryFactory('1.21.4'), Entity = entityFactory(registry), Item = itemFactory(registry);
  const entity: any = new Entity(42); entity.name = 'item';
  assert.equal(droppedItemSummary(entity), null, 'Spawn can precede item metadata.');
  entity.metadata[registry.supportFeature('metadataIxOfItem')] = Item.toNotch(new Item(registry.itemsByName.crafting_table.id, 3));
  assert.deepEqual(droppedItemSummary(entity), { name: 'crafting_table', count: 3 });
  for (const method of [() => null, () => { throw new Error('metadata incomplete'); }, () => ({ name: 'stone', count: NaN })]) {
    assert.equal(droppedItemSummary({ name: 'item', getDroppedItem: method }), null);
  }
  assert.equal(droppedItemSummary({ name: 'item', displayName: 'crafting_table', equipment: [{ name: 'crafting_table', count: 3 }] }), null);
  assert.equal(droppedItemSummary({ name: 'player', getDroppedItem: () => { assert.fail('Do not inspect another player inventory.'); } }), null);
});

test('scan finds visible drops by the decoded stack name and keeps them distinct from placed blocks', async () => {
  const { bot, run } = fixture();
  bot.entities[5] = { id: 5, name: 'item', position: new Vec3(3, 64, 0), height: .25, width: .25,
    getDroppedItem: () => ({ name: 'crafting_table', count: 1, nbt: { private: 'not exposed' } }) };
  bot.entities[6] = { id: 6, name: 'item', position: new Vec3(4, 64, 0), height: .25, width: .25, getDroppedItem: () => null };
  let result: any = await run({ type: 'scan', name: 'crafting_table', kind: 'both' });
  assert.deepEqual(result.blocks, []); assert.equal(result.entities.length, 1);
  assert.equal(result.entities[0].type, 'item'); assert.deepEqual(result.entities[0].droppedItem, { name: 'crafting_table', count: 1 });
  result = await run({ type: 'scan', kind: 'entities' });
  assert.equal(result.entities.find((entity: any) => entity.id === 6).droppedItem, null);
  bot.world.raycast = () => ({ name: 'stone' });
  assert.deepEqual((await run({ type: 'scan', name: 'crafting_table', kind: 'entities' }) as any).entities, []);
});

test('scan searches beyond the old hidden 64 candidates and marks a capped empty search as incomplete', async () => {
  const { bot, block, run } = fixture();
  const candidates = Array.from({ length: 600 }, (_, index) => block('stone', new Vec3(index % 20, 40 + Math.floor(index / 20), 0), { hidden: true }));
  candidates[70].hidden = false;
  bot.findBlocks = ({ count }: any) => candidates.slice(0, count).map(candidate => candidate.position);
  let result: any = await run({ type: 'scan', name: 'stone', kind: 'blocks', maxDistance: 64 });
  assert.equal(result.blocks.length, 1);
  assert.deepEqual(result.blocks[0].position, { ...candidates[70].position });
  assert.equal(result.candidateLimitReached, undefined); assert.equal(result.searchIncomplete, true);
  candidates[70].hidden = true;
  result = await run({ type: 'scan', name: 'stone', kind: 'blocks', maxDistance: 64 });
  assert.deepEqual(result.blocks, []); assert.match(result.note, /空结果不代表/);
  assert.equal(result.candidateCount, undefined);
});

test('unnamed scan gives visible block types a place before filling duplicate ground samples', async () => {
  const { block, run } = fixture();
  for (let x = 0; x < 20; x++) block('grass_block', new Vec3(x, 63, 0));
  block('oak_log', new Vec3(20, 64, 0)); block('stone', new Vec3(21, 64, 0));
  const result: any = await run({ type: 'scan', kind: 'blocks', maxDistance: 32, count: 3 });
  assert.deepEqual(result.blocks.map((entry: any) => entry.name), ['grass_block', 'oak_log', 'stone']);
  assert.equal(result.searchIncomplete, true); assert.equal(result.outputTruncated.blocks, true);
});

test('scan and unsuccessful gather disclose no hidden resource count or exhaustion signal', async () => {
  const results: any[] = [];
  for (const hiddenCount of [0, 1, 600]) {
    const { bot, block, run } = fixture();
    const hidden = Array.from({ length: hiddenCount }, (_, index) => block('oak_log',
      new Vec3(index % 20, 50 + Math.floor(index / 20), 0), { hidden: true }));
    bot.findBlocks = ({ count }: any) => hidden.slice(0, count).map(candidate => candidate.position);
    const scan = await run({ type: 'scan', name: 'oak_log', kind: 'blocks', maxDistance: 64 });
    let failure: any;
    await assert.rejects(run({ type: 'gather', block: 'oak_log', maxDistance: 32 }), (error: any) => {
      failure = { message: error.message, details: error.details }; return true;
    });
    results.push({ scan, failure });
  }
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[1], results[2]);
});

test('recipes describe ingredients/table requirements without claiming a table exists', async () => {
  const { bot, bag, definitions, run } = fixture(); bag.set('oak_log', 1);
  bot.recipesAll = (_id: number, _meta: unknown, table: unknown) => {
    assert.ok(table); return [{ result: { id: definitions.wooden_pickaxe.id, count: 1 }, requiresTable: true,
      delta: [{ id: definitions.oak_planks.id, count: -3 }] }];
  };
  const result: any = await run({ type: 'recipes', item: 'wooden_pickaxe' });
  assert.deepEqual(result.recipes[0].materials, [{ item: 'oak_planks', count: 3 }]);
  assert.equal(result.recipes[0].requiresTable, true); assert.equal(result.recipes[0].hasMaterials, false);
});

test('recipe samples rank inventory-compatible alternatives before truncating combinations', async () => {
  const { bot, bag, definitions, run } = fixture(); bag.set('oak_planks', 3);
  const recipe = (materials: any[]) => ({ result: { id: definitions.wooden_pickaxe.id, count: 1 }, requiresTable: true, delta: materials });
  bot.recipesAll = () => [
    ...Array.from({ length: 13 }, () => recipe([{ id: definitions.oak_log.id, count: -3 }])),
    recipe([{ id: definitions.oak_planks.id, count: -3 }, { id: definitions.coal.id, count: -1 }]),
    recipe([{ id: definitions.oak_planks.id, count: -3 }]),
  ];
  const result: any = await run({ type: 'recipes', item: 'wooden_pickaxe' });
  assert.equal(result.totalRecipes, 15); assert.equal(result.omitted, 3); assert.equal(result.recipes.length, 12);
  assert.equal(result.recipes[0].hasMaterials, true);
  assert.equal(result.recipes[1].materials[0].item, 'oak_planks');
  assert.match(result.note, /备选样本/);
});

test('craft counts requested output units and verifies each real inventory increment', async () => {
  const { bag, run } = fixture(); bag.set('oak_log', 3);
  const result: any = await run({ type: 'craft', item: 'oak_planks', count: 5 });
  assert.equal(result.crafts, 2); assert.equal(result.produced, 8);
  assert.equal(bag.get('oak_log'), 1);
  assert.deepEqual(result.inventoryDelta, [{ item: 'oak_log', change: -2 }, { item: 'oak_planks', change: 8 }]);
});

test('craft rejects a success-shaped native return with no produced items', async () => {
  const { bot, bag, run } = fixture(); bag.set('oak_log', 1); bot.craft = async () => {};
  await assert.rejects(run({ type: 'craft', item: 'oak_planks' }), /没有观察到/);
});

function nativeInventoryFixture() {
  const require = createRequire(import.meta.url), registry = registryFactory('1.21.4'), Item = itemFactory(registry);
  const bot: any = Object.assign(new EventEmitter(), {
    version: '1.21.4', registry, supportFeature: registry.supportFeature,
    _client: new EventEmitter(), QUICK_BAR_START: 36,
    entity: { id: 1, position: new Vec3(0, 64, 0) }, game: { gameMode: 'survival' },
    clearControlStates() {}, stopDigging() {},
    lookAt: async () => {}, swingArm() {},
  });
  const sent: any[] = [];
  bot._client.write = (name: string, packet: any) => { sent.push({ name, ...packet }); };
  require('mineflayer/lib/plugins/inventory.js')(bot, { hideErrors: true });
  require('mineflayer/lib/plugins/simple_inventory.js')(bot);
  require('mineflayer/lib/plugins/furnace.js')(bot);
  require('mineflayer/lib/plugins/craft.js')(bot);
  const full = (stateId: number, entries: Record<number, [string, number]>, cursor?: [string, number]) => {
    const items = Array.from({ length: 46 }, (_, slot) => entries[slot] ? Item.toNotch(new Item(registry.itemsByName[entries[slot][0]].id, entries[slot][1])) : Item.toNotch(null));
    bot._client.emit('window_items', { windowId: 0, stateId, items, carriedItem: Item.toNotch(cursor ? new Item(registry.itemsByName[cursor[0]].id, cursor[1]) : null) });
  };
  return { bot, Item, registry, sent, full };
}

function openNativeFurnace(fixture: ReturnType<typeof nativeInventoryFixture>, contents = true) {
  const { bot, Item, registry } = fixture;
  bot._client.emit('open_window', { windowId: 1, inventoryType: 'minecraft:furnace', windowTitle: 'Furnace' });
  const sendContents = () => {
    const items = Array.from({ length: bot.currentWindow.slots.length }, (_, slot) => Item.toNotch(slot === 3 ? new Item(registry.itemsByName.cobblestone.id, 7) : null));
    bot._client.emit('window_items', { windowId: 1, stateId: 4, items, carriedItem: Item.toNotch(null) });
  };
  if (contents) sendContents();
  return sendContents;
}

test('installed native generic activation leaves furnace menu open, misroutes equip slots and window-0 sync', async () => {
  const fixture = nativeInventoryFixture(), { bot, sent, full } = fixture;
  full(0, { 9: ['cobblestone', 7] });
  await bot.activateBlock({ position: new Vec3(1, 64, 0) });
  openNativeFurnace(fixture);
  assert.equal(bot.currentWindow.id, 1);
  await bot.equip(bot.inventory.items()[0], 'hand');
  assert.ok(sent.some(packet => packet.name === 'window_click' && packet.windowId === 1 && packet.slot === 36), 'Native equip used inventory slot 36 on a furnace window, whose hotbar starts at 30.');
  assert.equal(bot.heldItem, null, 'The native hand remains empty despite equip resolving.');
  let synced = false;
  const pending = bot._syncWindow(bot.inventory).then(() => { synced = true; });
  assert.equal(sent.at(-1).windowId, 0);
  await delay(0); assert.equal(synced, false, 'Server has menu 1, so a window-0 request receives no answer.');
  // Drain the native test promise; no real server/game is connected.
  full(5, { 9: ['cobblestone', 7] }); await pending;
});

for (const cancelled of [false, true]) test(`windowless interaction closes late initialized furnace and drains close before return (cancelled=${cancelled})`, async () => {
  const fixture = nativeInventoryFixture(), { bot, sent, full } = fixture, controller = new AbortController();
  full(0, { 9: ['oak_log', 2] });
  let finished = false;
  const pending = windowlessInteraction(bot, controller.signal, () => bot.activateBlock({ position: new Vec3(1, 64, 0) }))
    .then(value => { finished = true; return { value }; }, error => { finished = true; return { error }; });
  await delay(0); assert.ok(sent.some(packet => packet.name === 'block_place'));
  const initialize = openNativeFurnace(fixture, false);
  assert.equal(sent.filter(packet => packet.name === 'close_window').length, 0, 'Do not copy an uninitialized empty menu over inventory.');
  if (cancelled) controller.abort();
  await delay(0); assert.equal(finished, false);
  initialize();
  assert.equal(sent.filter(packet => packet.name === 'close_window').length, 1);
  assert.equal(bot.currentWindow, null);
  bot._client.emit('statistics', { entries: [] });
  await delay(0); assert.equal(finished, false, 'Closing the UI locally has not drained the server close yet.');
  assert.equal(sent.at(-2).name, 'window_click'); assert.equal(sent.at(-2).windowId, 0);
  full(5, { 9: ['cobblestone', 7] }); bot._client.emit('statistics', { entries: [] });
  const outcome: any = await pending;
  if (cancelled) assert.match(outcome.error.message, /取消/); else assert.equal(outcome.error, undefined);
  assert.equal(bot.inventory.items()[0].name, 'cobblestone');
  assert.equal(bot.inventory.items()[0].count, 7);
  assert.equal(bot.listenerCount('windowOpen'), 0);
  await bot.equip(bot.inventory.items()[0], 'hand');
  assert.equal(bot.heldItem.name, 'cobblestone');
  assert.equal(sent.filter(packet => packet.name === 'window_click' && packet.mode === 0).every(packet => packet.windowId === 0), true);
});

test('existing unmanaged furnace is fully initialized and closed before a new inventory operation', async () => {
  const fixture = nativeInventoryFixture(), { bot, full } = fixture;
  const initialize = openNativeFurnace(fixture, false);
  const pending = releaseUnmanagedWindow(bot);
  await delay(0);
  initialize(); bot._client.emit('statistics', { entries: [] }); await delay(0);
  full(5, { 9: ['cobblestone', 7] }); bot._client.emit('statistics', { entries: [] });
  await pending; assert.equal(bot.currentWindow, null); assert.equal(bot.inventory.items()[0].count, 7);
});

test('managed native close is followed by authoritative inventory sync even when the operation throws', async () => {
  const fixture = nativeInventoryFixture(), { bot, Item, registry, full } = fixture;
  let operate: () => void = () => {};
  const pending = managedWindowOperation(bot, async () => {
    openNativeFurnace(fixture);
    assert.equal(bot.currentWindow.id, 1, 'The owner may use its menu without auto-close.');
    await new Promise<void>(resolve => { operate = resolve; });
    bot.currentWindow.updateSlot(3, new Item(registry.itemsByName.cobblestone.id, 99));
    await bot.closeWindow(bot.currentWindow);
    throw new Error('cancelled transfer');
  }).catch(error => error);
  await delay(0); operate(); await delay(0);
  assert.equal(bot.inventory.items()[0].count, 99, 'Native close temporarily copied its prediction.');
  bot._client.emit('statistics', { entries: [] }); await delay(0);
  full(5, { 9: ['cobblestone', 7] }); bot._client.emit('statistics', { entries: [] });
  const error = await pending;
  assert.match(error.message, /cancelled transfer/); assert.equal(bot.inventory.items()[0].count, 7);
  assert.equal(bot.currentWindow, null);
});

test('ordinary non-menu interactions finish on the queue barrier without waiting for windowOpen', async () => {
  const { bot, sent } = nativeInventoryFixture();
  const pending = windowlessInteraction(bot, new AbortController().signal, () => bot.activateBlock({ position: new Vec3(1, 64, 0) }));
  await delay(0); bot._client.emit('statistics', { entries: [] }); await pending;
  assert.equal(sent.some(packet => packet.name === 'close_window'), false);
  assert.equal(bot.listenerCount('windowOpen'), 0);
});

test('failed generic cleanup marks inventory unknown and still closes a late initialized window on the quarantined connection', async () => {
  const fixture = nativeInventoryFixture(), { bot, sent } = fixture;
  const write = bot._client.write;
  bot._client.write = (name: string, packet: any) => {
    if (name === 'client_command') throw new Error('statistics write failed after activation');
    write(name, packet);
  };
  await assert.rejects(windowlessInteraction(bot, new AbortController().signal, () => bot.activateBlock({ position: new Vec3(1, 64, 0) })), (error: any) => {
    assert.equal(error.inventoryUnconfirmed, true); assert.equal(error.details.inventoryConfirmed, false);
    assert.deepEqual(error.details.inventoryDelta, []); return true;
  });
  bot._client.write = write;
  openNativeFurnace(fixture);
  await delay(0);
  assert.equal(bot.currentWindow, null); assert.equal(sent.filter(packet => packet.name === 'close_window').length, 1);
  await assert.rejects(releaseUnmanagedWindow(bot), /重新连接/);
  bot._client.emit('end'); assert.equal(bot.listenerCount('windowOpen'), 0);
});

test('final managed cleanup failure downgrades an earlier confirmed craft and hides its delta from facts', async () => {
  const { bot, bag, block, run } = fixture(); bag.set('oak_log', 1); block('crafting_table', new Vec3(1, 64, 0));
  const nativeCraft = bot.craft, write = bot._client.write; let stats = 0;
  bot.craft = async (...args: any[]) => { await nativeCraft(...args); bot.emit('windowClose', { id: 1 }); };
  bot._client.write = (name: string, packet: any) => {
    if (++stats === 3) throw new Error('final close barrier failed');
    write(name, packet);
  };
  await assert.rejects(run({ type: 'craft', item: 'oak_planks', count: 4, table: { x: 1, y: 64, z: 0 } }), (error: any) => {
    assert.equal(error.details.crafts, 1, 'The batch had passed its confirmation before final cleanup failed.');
    assert.equal(error.details.inventoryConfirmed, false); assert.deepEqual(error.details.inventoryDelta, []);
    assert.deepEqual(error.details.unconfirmedInventoryDelta, [{ item: 'oak_log', change: -1 }, { item: 'oak_planks', change: 4 }]);
    return true;
  });
  await assert.rejects(run({ type: 'craft', item: 'oak_planks' }), /重新连接/);
  bot._client.emit('end');
});

test('installed native _syncWindow accepts an old full packet; the queue barrier waits for the later actual snapshot', async () => {
  const { bot, sent, full } = nativeInventoryFixture();
  full(1, { 9: ['oak_log', 8] });
  let finished = false;
  const pending = synchronizeCraftInventory(bot).then(() => { finished = true; });
  assert.deepEqual(sent.map(packet => packet.name), ['window_click', 'client_command']);
  full(2, { 9: ['oak_log', 3], 10: ['oak_planks', 4] });
  await delay(0); assert.equal(finished, false, 'The old full packet resolves native once, but is not the end of the server queue.');
  full(3, { 9: ['oak_log', 7], 10: ['oak_planks', 4] });
  await delay(0); assert.equal(finished, false);
  bot._client.emit('statistics', { entries: [] }); await pending;
  assert.equal(bot.inventory.count(bot.registry.itemsByName.oak_log.id, null), 7);
  assert.equal(bot._client.listenerCount('statistics'), 0);
});

test('a timed-out statistics request quarantines its native connection even after the late response arrives', async () => {
  const { bot, sent, full } = nativeInventoryFixture();
  const pending = synchronizeCraftInventory(bot, 15);
  full(1, {});
  await assert.rejects(pending, /屏障超时/);
  bot._client.emit('statistics', { entries: [] });
  const sentCount = sent.length;
  await assert.rejects(synchronizeCraftInventory(bot), /重新连接/);
  assert.equal(sent.length, sentCount, 'No blind sync/stats retry may consume the late response.');
});

test('cancellation while a real native baseline waits for statistics drains it before releasing the body lock', async () => {
  const { bot, sent, full } = nativeInventoryFixture(), controller = new AbortController();
  let finished = false;
  const pending = runSurvivalAction(bot, action({ type: 'craft', item: 'oak_planks', count: 4 }), controller.signal, { moveTo: async () => {}, approachBlock: async () => { assert.fail('Non-gather actions must not request resource approach.'); }, entityVisible: () => true })
    .then(() => { finished = true; return null; }, error => { finished = true; return error; });
  full(1, { 9: ['oak_log', 2] });
  controller.abort(); await delay(5); assert.equal(finished, false);
  bot._client.emit('statistics', { entries: [] });
  const error = await pending;
  assert.match(error.message, /取消/);
  assert.equal(sent.filter(packet => packet.name === 'window_click' && packet.mode !== 5).length, 0);
  assert.equal(bot._client.listenerCount('statistics'), 0);
});

test('disconnect after native full snapshot but before the statistics barrier prevents future batches', async () => {
  const { bot, sent, full } = nativeInventoryFixture();
  const pending = synchronizeCraftInventory(bot);
  full(1, {}); bot._client.emit('end');
  await assert.rejects(pending, /连接已关闭/);
  const count = sent.length;
  await assert.rejects(synchronizeCraftInventory(bot), /重新连接/);
  assert.equal(sent.length, count);
});

test('baseline rejects real authoritative grid/cursor leftovers before native craft can consume them', async () => {
  const { bot, sent, full } = nativeInventoryFixture();
  const pending = runSurvivalAction(bot, action({ type: 'craft', item: 'oak_planks', count: 4 }), new AbortController().signal, { moveTo: async () => {}, approachBlock: async () => { assert.fail('Non-gather actions must not request resource approach.'); }, entityVisible: () => true });
  full(1, { 1: ['oak_log', 1], 9: ['oak_log', 2] }, ['oak_planks', 2]);
  bot._client.emit('statistics', { entries: [] });
  await assert.rejects(pending, (error: any) => {
    assert.match(error.message, /开始前/);
    assert.deepEqual(error.details.craftingWindow.cursor, { item: 'oak_planks', count: 2 });
    assert.deepEqual(error.details.craftingWindow.inputs[0], { slot: 1, stack: { item: 'oak_log', count: 1 } });
    return true;
  });
  assert.equal(sent.filter(packet => packet.name === 'window_click' && packet.mode !== 5).length, 0);
});

test('table crafting uses the same baseline/batch barriers and cannot bypass a quarantined connection', async () => {
  const { bot, bag, block, run } = fixture(); bag.set('oak_log', 2); block('crafting_table', new Vec3(1, 64, 0));
  let syncs = 0; bot._syncWindow = async () => { syncs++; };
  const result: any = await run({ type: 'craft', item: 'oak_planks', count: 4, table: { x: 1, y: 64, z: 0 } });
  assert.equal(syncs, 2); assert.equal(result.inventoryConfirmed, true);
  bot._client.write = () => {};
  await assert.rejects(synchronizeCraftInventory(bot, 10), /屏障超时/);
  bot.craft = async () => { assert.fail('A table is not an escape from quarantine.'); };
  await assert.rejects(run({ type: 'craft', item: 'oak_planks', table: { x: 1, y: 64, z: 0 } }), /重新连接/);
});

function fragmentedNativeCraftFixture() {
  const { bot, Item, registry, full } = nativeInventoryFixture();
  const require = createRequire(import.meta.url), server = require('prismarine-windows')('1.21.4').createWindow(0, 'minecraft:inventory', 'server');
  const oak = registry.itemsByName.oak_log.id, planks = registry.itemsByName.oak_planks.id;
  server.updateSlot(9, new Item(oak, 5)); full(0, { 9: ['oak_log', 5] });
  let stateId = 0, processing = false, delivering = false, actualCrafts = 0;
  const incoming: any[] = [], outgoing: any[] = [], timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void) => { const timer = setTimeout(() => { timers.delete(timer); fn(); }, 1); timers.add(timer); };
  const send = (name: string, packet: any) => {
    outgoing.push({ name, packet: structuredClone(packet) });
    if (delivering) return;
    delivering = true;
    const deliver = () => { const message = outgoing.shift(); bot._client.emit(message.name, message.packet); if (outgoing.length) later(deliver); else delivering = false; };
    later(deliver);
  };
  const result = () => {
    const entries = server.slots.slice(1, 5).filter(Boolean);
    server.updateSlot(0, entries.length === 1 && entries[0].type === oak ? new Item(planks, 4) : null);
    // Official 1.21.4 slotChangedCraftingGrid sends slot 0 even for an empty result.
    send('set_slot', { windowId: 0, stateId: ++stateId, slot: 0, item: Item.toNotch(server.slots[0]) });
  };
  const snapshot = () => send('window_items', { windowId: 0, stateId: ++stateId, items: server.slots.map((entry: any) => Item.toNotch(entry)), carriedItem: Item.toNotch(server.selectedItem) });
  bot._client.write = (name: string, packet: any) => {
    incoming.push({ name, packet: structuredClone(packet) });
    if (processing) return;
    processing = true;
    const process = () => {
      const message = incoming.shift(), click = message.packet;
      if (message.name === 'client_command') send('statistics', { entries: [] });
      else {
        assert.equal(message.name, 'window_click');
        if (click.mode === 5) snapshot();
        else {
          const stale = click.stateId !== stateId;
          const takingOutput = click.slot === 0 && server.slots[0];
          server.acceptClick({ ...click, item: server.slots[click.slot] });
          if (takingOutput) {
            actualCrafts++;
            for (let slot = 1; slot <= 4; slot++) if (server.slots[slot]) {
              if (--server.slots[slot].count === 0) server.updateSlot(slot, null);
              result();
            }
          } else if (click.slot >= 1 && click.slot <= 4) result();
          if (stale) snapshot();
          else if (takingOutput) {
            // These later ingredient updates are distinct from the earlier output
            // update. Native craft can issue its final click before they arrive.
            for (let slot = 1; slot <= 4; slot++) send('set_slot', { windowId: 0, stateId: ++stateId, slot, item: Item.toNotch(server.slots[slot]) });
          }
        }
      }
      if (incoming.length) later(process); else processing = false;
    };
    later(process);
  };
  return { bot, server, oak, planks, get actualCrafts() { return actualCrafts; },
    get pendingPackets() { return incoming.length + outgoing.length; }, close: () => { for (const timer of timers) clearTimeout(timer); } };
}

test('installed native craft and inventory plugins complete successive batches despite fragmented late full snapshots', async () => {
  const fixture = fragmentedNativeCraftFixture(), { bot, server, oak, planks } = fixture;
  try {
    const details: any = await runSurvivalAction(bot, action({ type: 'craft', item: 'oak_planks', count: 12 }), new AbortController().signal, { moveTo: async () => {}, approachBlock: async () => { assert.fail('Non-gather actions must not request resource approach.'); }, entityVisible: () => true });
    assert.equal(fixture.actualCrafts, 3); assert.equal(details.crafts, 3); assert.equal(details.produced, 12);
    assert.equal(server.count(oak, null), 2); assert.equal(server.count(planks, null), 12);
    assert.equal(server.selectedItem, null); assert.ok(server.slots.slice(1, 5).every((entry: any) => entry === null));
    assert.deepEqual(details.inventoryDelta, [{ item: 'oak_log', change: -3 }, { item: 'oak_planks', change: 12 }]);
  } finally { fixture.close(); }
});

test('the previous native sync-only boundary can return before its own request finishes processing', async () => {
  const fixture = fragmentedNativeCraftFixture(), { bot, oak, planks, server } = fixture;
  try {
    await bot._syncWindow(bot.inventory);
    await bot.craft(bot.recipesFor(planks, null, 1, null)[0], 1, null);
    await bot._syncWindow(bot.inventory);
    assert.ok(fixture.pendingPackets > 0, 'Native sync resolved while later click/sync packets are still queued.');
    // The old boundary resolves on the full correction to an earlier click;
    // the newer full snapshot is still queued. Drain through the new boundary.
    await synchronizeCraftInventory(bot);
    assert.equal(server.count(oak, null), 4); assert.equal(server.count(planks, null), 4);
    assert.equal(bot.inventory.count(oak, null), 4);
    assert.equal(fixture.pendingPackets, 0, 'The statistics barrier drains the complete preceding queue.');
  } finally { fixture.close(); }
});

test('2x2 craft waits for an authoritative baseline and each delayed batch before starting the next', async () => {
  const { bot, bag, run } = fixture(); bag.set('oak_log', 3); bag.set('oak_planks', 12);
  let syncCalls = 0, batches = 0, finished = false, releaseSync: () => void = () => {};
  bot._syncWindow = (window: any) => {
    assert.equal(window, bot.inventory); const syncNumber = ++syncCalls;
    return new Promise<void>(resolve => { releaseSync = () => {
      bag.set('oak_planks', syncNumber === 1 ? 0 : batches * 4); resolve();
    }; });
  };
  bot.craft = async () => { batches++; bag.set('oak_log', 3 - batches); };
  const pending = run({ type: 'craft', item: 'oak_planks', count: 12 }).then(result => { finished = true; return result; });
  assert.equal(syncCalls, 1); assert.equal(batches, 0);
  releaseSync(); await delay(0);
  for (let batch = 1; batch <= 3; batch++) {
    assert.equal(batches, batch); assert.equal(syncCalls, batch + 1);
    await delay(5); assert.equal(finished, false); assert.equal(batches, batch, 'No new craft may overtake its pending inventory reply.');
    releaseSync(); await delay(0);
  }
  const result: any = await pending;
  assert.equal(result.produced, 12); assert.equal(result.crafts, 3); assert.equal(result.inventoryConfirmed, true);
  assert.deepEqual(result.inventoryDelta, [{ item: 'oak_log', change: -3 }, { item: 'oak_planks', change: 12 }]);
});

test('2x2 craft rejects optimistic production corrected by the server and does not repeat that batch', async () => {
  const { bot, bag, run } = fixture(); bag.set('oak_log', 1);
  let syncCalls = 0, batches = 0;
  bot.craft = async () => { batches++; bag.set('oak_log', 0); bag.set('oak_planks', 4); };
  bot._syncWindow = async () => {
    if (++syncCalls === 2) { bag.set('oak_log', 1); bag.set('oak_planks', 0); }
  };
  await assert.rejects(run({ type: 'craft', item: 'oak_planks', count: 8 }), (error: any) => {
    assert.match(error.message, /没有观察到/); assert.equal(error.details.inventoryConfirmed, true);
    assert.equal(error.details.crafts, 0); assert.equal(error.details.partial, false);
    assert.deepEqual(error.details.inventoryDelta, []); return true;
  });
  assert.equal(batches, 1); assert.equal(syncCalls, 2);
});

test('cancelling during 2x2 batch sync drains the native promise before returning and never sends another batch', async () => {
  const { bot, bag, run } = fixture(); bag.set('oak_log', 2);
  const controller = new AbortController(); const originalCraft = bot.craft;
  let batches = 0, syncCalls = 0, finished = false, releaseSync: () => void = () => {};
  bot.craft = async (...args: any[]) => { batches++; await originalCraft(...args); };
  bot._syncWindow = async () => {
    if (++syncCalls === 1) return;
    await new Promise<void>(resolve => { releaseSync = resolve; });
  };
  const pending = run({ type: 'craft', item: 'oak_planks', count: 8 }, controller.signal)
    .then(() => { finished = true; return null; }, error => { finished = true; return error; });
  await delay(0); assert.equal(syncCalls, 2); assert.equal(batches, 1);
  controller.abort(); await delay(5);
  assert.equal(finished, false, 'The caller still owns the body lock until this native sync has drained.');
  releaseSync(); const error = await pending;
  assert.match(error.message, /取消/); assert.equal(error.details.inventoryConfirmed, true);
  assert.equal(error.details.partial, true); assert.equal(batches, 1);
  assert.equal(error.details.inventoryDelta.find((entry: any) => entry.item === 'oak_planks').change, 4);
});

test('disconnect or native sync timeout cannot confirm predicted production or start a following batch', async () => {
  const { bot, bag, run } = fixture(); bag.set('oak_log', 2);
  const controller = new AbortController(); const originalCraft = bot.craft;
  let batches = 0, syncCalls = 0, finished = false, rejectSync: (error: Error) => void = () => {};
  bot.craft = async (...args: any[]) => { batches++; await originalCraft(...args); };
  bot._syncWindow = async () => {
    if (++syncCalls === 1) return;
    await new Promise<void>((_resolve, reject) => { rejectSync = reject; });
  };
  const pending = run({ type: 'craft', item: 'oak_planks', count: 8 }, controller.signal)
    .then(() => { finished = true; return null; }, error => { finished = true; return error; });
  await delay(0); assert.equal(batches, 1);
  // World disconnect handling aborts the body's signal; the already-issued
  // native sync can reject later (its event wait has its own bounded timeout).
  controller.abort({ type: 'world-event', event: 'disconnected' }); await delay(5);
  assert.equal(finished, false); rejectSync(new Error('No inventory reply after disconnect'));
  const error = await pending;
  assert.match(error.message, /disconnect/); assert.equal(error.details.inventoryConfirmed, false);
  assert.match(error.details.note, /客户端预测/); assert.equal(batches, 1);
});

test('cancelled craft records partial production and starts no further recipe batch', async () => {
  const { bot, bag, run } = fixture(); bag.set('oak_log', 3);
  const controller = new AbortController(), original = bot.craft;
  bot.craft = async (...args: any[]) => { await original(...args); controller.abort(); };
  await assert.rejects(run({ type: 'craft', item: 'oak_planks', count: 8 }, controller.signal), (error: any) => {
    assert.equal(error.details.partial, false, 'Predicted production is not a confirmed partial batch.');
    assert.equal(error.details.inventoryConfirmed, false, 'Cancellation happened before a server sync confirmed this native craft.');
    assert.deepEqual(error.details.inventoryDelta, []);
    assert.equal(error.details.unconfirmedInventoryDelta.find((entry: any) => entry.item === 'oak_planks').change, 4);
    return true;
  });
  assert.equal(bag.get('oak_log'), 2);
});

test('gather records mined blocks and actual pickup, preserves partial failure when resources run out', async () => {
  const { bot, bag, blocks, block, run } = fixture();
  const position = new Vec3(2, 64, 0); block('oak_log', position);
  bot.dig = async (target: any) => { blocks.delete(target.position.toString()); bag.set('oak_log', 1); };
  await assert.rejects(run({ type: 'gather', block: 'oak_log', count: 2 }), (error: any) => {
    assert.equal(error.details.minedBlocks, 1); assert.equal(error.details.pickupConfirmed, true);
    assert.deepEqual(error.details.positions, [{ x: 2, y: 64, z: 0 }]);
    assert.deepEqual(error.details.inventoryDelta, [{ item: 'oak_log', change: 1 }]); return true;
  });
});

test('gather never guesses drops and refuses harvest-restricted blocks without a usable tool', async () => {
  const { bot, blocks, block, run } = fixture();
  const position = new Vec3(2, 64, 0); block('oak_log', position);
  bot.dig = async (target: any) => { blocks.delete(target.position.toString()); };
  const result: any = await run({ type: 'gather', block: 'oak_log' });
  assert.equal(result.minedBlocks, 1); assert.equal(result.pickupConfirmed, false); assert.deepEqual(result.inventoryDelta, []);
  block('iron_ore', position, { harvestTools: { 999: true } });
  await assert.rejects(run({ type: 'gather', block: 'iron_ore' }), /没有能获取/);
});

test('gather skips the nearest supporting stone and mines a legal adjacent candidate', async () => {
  const { bot, bag, blocks, block, run } = fixture();
  bot.registry.blocksByName.stone = { id: 102 };
  const support = new Vec3(0, 63, 0), adjacent = new Vec3(1, 63, 0), dug: Vec3[] = [];
  block('stone', support); block('stone', adjacent);
  bot.dig = async (target: any) => { dug.push(target.position); blocks.delete(target.position.toString()); bag.set('stone', 1); };
  const result: any = await run({ type: 'gather', block: 'stone', count: 1, maxDistance: 8 });
  assert.deepEqual(dug, [adjacent]); assert.equal(result.minedBlocks, 1);
  assert.equal(blocks.get(support.toString())?.name, 'stone');
});

test('gather leaves the supporting block intact when it is the only candidate', async () => {
  const { bot, blocks, block, run } = fixture();
  bot.registry.blocksByName.stone = { id: 102 };
  const support = bot.entity.position.floored().offset(0, -1, 0); block('stone', support);
  bot.dig = async () => { assert.fail('The supporting block must not be mined.'); };
  await assert.rejects(run({ type: 'gather', block: 'stone' }), (error: any) => {
    assert.equal(error.details.minedBlocks, 0); assert.deepEqual(error.details.inventoryDelta, []); return true;
  });
  assert.equal(blocks.get(support.toString())?.name, 'stone');
});

test('gather delegates a high visible target to the body without requiring adjacent cardinal standing cells', async () => {
  const { bot, bag, blocks, block } = fixture(), target = new Vec3(6, 69, 0);
  block('oak_log', target);
  // An interaction position two horizontal cells away and three cells below
  // the log was outside the former four-directions/three-heights enumeration.
  const feet = new Vec3(4.5, 66, .5); block('stone', feet.floored().offset(0, -1, 0));
  const controller = new AbortController(), approached: any[] = [];
  bot.dig = async (found: any) => { assert.deepEqual(found.position, target); blocks.delete(target.toString()); bag.set('oak_log', 1); };
  const result: any = await runSurvivalAction(bot, action({ type: 'gather', block: 'oak_log', maxDistance: 16 }), controller.signal, {
    approachBlock: async (position, signal) => {
      assert.equal(signal, controller.signal); approached.push(position); bot.entity.position = feet.clone();
      return { arbitraryPlannerReceipt: true };
    },
    moveTo: async () => { assert.fail('Resource approach must not fall back to straight-line item pickup movement.'); }, entityVisible: () => true,
  });
  assert.deepEqual(approached, [{ ...target }]); assert.equal(result.movementAttempts, 1);
  assert.equal(result.minedBlocks, 1); assert.deepEqual(result.inventoryDelta, [{ item: 'oak_log', change: 1 }]);
  assert.deepEqual(result.approach, { arbitraryPlannerReceipt: true });
  assert.deepEqual(result.rejectedCandidates, []);
});

test('gather skips a planner-rejected high log and approaches a later visible candidate', async () => {
  const { bot, bag, blocks, block } = fixture(), high = new Vec3(0, 70, 0), target = new Vec3(7, 64, 0);
  block('oak_log', high); block('oak_log', target); block('stone', new Vec3(6, 63, 0));
  const approached: any[] = [];
  bot.dig = async (found: any) => { assert.deepEqual(found.position, target); blocks.delete(target.toString()); bag.set('oak_log', 1); };
  const result: any = await runSurvivalAction(bot, action({ type: 'gather', block: 'oak_log', maxDistance: 16 }), new AbortController().signal, {
    approachBlock: async position => {
      approached.push(position);
      if (position.y === high.y) throw new Error('本次规划没有到达此高处目标。');
      bot.entity.position = new Vec3(6.5, 64, .5);
    },
    moveTo: async () => { assert.fail('Resource approach must use the injected planner.'); }, entityVisible: () => true,
  });
  assert.deepEqual(approached, [{ ...high }, { ...target }]); assert.equal(result.minedBlocks, 1);
  assert.deepEqual(result.selectedTarget, { ...target });
  assert.deepEqual(result.rejectedCandidates[0].position, { ...high });
  assert.match(result.rejectedCandidates[0].reason, /本次规划/);
  assert.deepEqual(result.inventoryDelta, [{ item: 'oak_log', change: 1 }]);
});

test('gather prefers a directly diggable target over a nearer unusable candidate without walking', async () => {
  const { bot, bag, blocks, block, run } = fixture(), unusable = new Vec3(1, 64, 0), target = new Vec3(3, 64, 0);
  block('oak_log', unusable); block('oak_log', target);
  bot.canDigBlock = (found: any) => found.position.equals(target);
  bot.setControlState = () => { assert.fail('No walking is needed.'); };
  bot.dig = async (found: any) => { assert.deepEqual(found.position, target); blocks.delete(target.toString()); bag.set('oak_log', 1); };
  const result: any = await run({ type: 'gather', block: 'oak_log' });
  assert.equal(result.minedBlocks, 1); assert.deepEqual(result.selectedTarget, { ...target });
  assert.deepEqual(result.rejectedCandidates, []); assert.equal(blocks.get(unusable.toString())?.name, 'oak_log');
});

test('gather limits failed navigation attempts and rejection output without mining or declaring the whole area inaccessible', async () => {
  const { bot, block } = fixture(); let walks = 0;
  for (let x = 6; x <= 27; x += 3) {
    block('oak_log', new Vec3(x, 64, 0));
    block('stone', new Vec3(x - 1, 63, 0)); block('stone', new Vec3(x + 1, 63, 0));
  }
  bot.dig = async () => { assert.fail('Blocked navigation must never mine remotely.'); };
  await assert.rejects(runSurvivalAction(bot, action({ type: 'gather', block: 'oak_log', maxDistance: 32 }), new AbortController().signal, {
    approachBlock: async () => { walks++; throw new Error('已知障碍挡路'); },
    moveTo: async () => { assert.fail('No straight-line fallback.'); }, entityVisible: () => true,
  }), (error: any) => {
    assert.match(error.message, /其他位置或路线仍未知/); assert.equal(walks, 3);
    assert.equal(error.details.movementAttempts, 3); assert.equal(error.details.minedBlocks, 0);
    assert.ok(error.details.rejectedCandidates.length <= 12);
    assert.equal(error.details.rejectedCandidateCount, 11);
    assert.deepEqual(error.details.inventoryDelta, []); return true;
  });
});

test('gather can try a later resource after the planner cannot approach the first one', async () => {
  const { bot, bag, blocks, block } = fixture(), blocked = new Vec3(7, 64, 0), reachable = new Vec3(12, 64, 0);
  block('oak_log', blocked); block('oak_log', reachable);
  for (const x of [6, 8, 11]) block('stone', new Vec3(x, 63, 0));
  let walks = 0;
  bot.dig = async (found: any) => { assert.deepEqual(found.position, reachable); blocks.delete(reachable.toString()); bag.set('oak_log', 1); };
  const result: any = await runSurvivalAction(bot, action({ type: 'gather', block: 'oak_log', maxDistance: 16 }), new AbortController().signal, {
    approachBlock: async position => {
      walks++;
      if (position.x === blocked.x) throw Object.assign(new Error('前方头部空间被遮挡。'), {
        details: { movement: { reasonCode: 'head_blocked' }, approach: { reached: false, stoppedReason: 'no_route' } },
      });
      bot.entity.position = new Vec3(11.5, 64, .5);
      return { reached: true, planning: { plans: 1, legs: 3 } };
    }, moveTo: async () => { assert.fail('No straight-line fallback.'); }, entityVisible: () => true,
  });
  assert.equal(walks, 2); assert.equal(result.minedBlocks, 1);
  assert.deepEqual(result.selectedTarget, { ...reachable });
  assert.equal(result.rejectedCandidates[0].movement.reasonCode, 'head_blocked');
  assert.deepEqual(result.approach, { reached: true, planning: { plans: 1, legs: 3 } }, 'Only the latest bounded summary is retained.');
  assert.equal(blocks.get(blocked.toString())?.name, 'oak_log');
});

for (const condition of ['still-far', 'changed', 'occluded', 'supporting'] as const) {
  test(`gather verifies actual dig conditions after a successful approach receipt: ${condition}`, async () => {
    const { bot, blocks, block } = fixture(), target = new Vec3(7, 64, 0);
    block('oak_log', target);
    let approaches = 0;
    bot.dig = async () => { assert.fail('A planner receipt cannot authorize an invalid dig.'); };
    await assert.rejects(runSurvivalAction(bot, action({ type: 'gather', block: 'oak_log', maxDistance: 16 }), new AbortController().signal, {
      approachBlock: async position => {
        approaches++; assert.deepEqual(position, { ...target });
        if (condition !== 'still-far') bot.entity.position = new Vec3(6.5, 64, .5);
        if (condition === 'changed') blocks.delete(target.toString());
        if (condition === 'occluded') blocks.get(target.toString()).hidden = true;
        if (condition === 'supporting') bot.entity.position = new Vec3(7.5, 65, .5);
        return { status: 'completed' };
      },
      moveTo: async () => { assert.fail('No straight-line fallback.'); }, entityVisible: () => true,
    }), (error: any) => {
      assert.equal(approaches, 1); assert.equal(error.details.minedBlocks, 0);
      assert.deepEqual(error.details.approach, { status: 'completed' }, 'Keep the receipt for diagnostics without trusting it as dig success.');
      assert.deepEqual(error.details.inventoryDelta, []); assert.equal(error.details.pickupConfirmed, false);
      assert.match(error.details.rejectedCandidates[0].reason, /实际可挖范围/);
      return true;
    });
  });
}

test('gather can use actual dig reach after a partial approach failure without claiming navigation success', async () => {
  const { bot, bag, blocks, block } = fixture(), target = new Vec3(7, 64, 0);
  block('oak_log', target);
  bot.dig = async (found: any) => { assert.deepEqual(found.position, target); blocks.delete(target.toString()); bag.set('oak_log', 1); };
  const result: any = await runSurvivalAction(bot, action({ type: 'gather', block: 'oak_log', maxDistance: 16 }), new AbortController().signal, {
    approachBlock: async () => { bot.entity.position = new Vec3(4.5, 64, .5); throw new Error('规划结束前已停止移动。'); },
    moveTo: async () => { assert.fail('No straight-line fallback.'); }, entityVisible: () => true,
  });
  assert.equal(result.minedBlocks, 1); assert.equal(result.pickupConfirmed, true);
  assert.match(result.rejectedCandidates[0].reason, /已停止移动/);
  assert.deepEqual(result.inventoryDelta, [{ item: 'oak_log', change: 1 }]);
});

test('gather cancellation during a candidate approach starts no next route and preserves earlier mined inventory', async () => {
  const { bot, bag, blocks, block } = fixture(), first = new Vec3(2, 64, 0), later = new Vec3(7, 64, 0);
  block('oak_log', first); block('oak_log', later); block('stone', new Vec3(6, 63, 0));
  const controller = new AbortController(); let walks = 0, clears = 0;
  bot.clearControlStates = () => { clears++; };
  bot.dig = async (found: any) => { assert.deepEqual(found.position, first); blocks.delete(first.toString()); bag.set('oak_log', 1); };
  await assert.rejects(runSurvivalAction(bot, action({ type: 'gather', block: 'oak_log', count: 2, maxDistance: 16 }), controller.signal, {
    approachBlock: async () => {
      walks++; controller.abort();
      throw Object.assign(new Error('cancelled movement'), { details: { approach: { reached: false, partial: true, stoppedReason: 'cancelled' } } });
    },
    moveTo: async () => { assert.fail('No straight-line fallback.'); }, entityVisible: () => true,
  }), (error: any) => {
    assert.match(error.message, /取消/); assert.equal(error.details.minedBlocks, 1); assert.equal(error.details.partial, true);
    assert.deepEqual(error.details.inventoryDelta, [{ item: 'oak_log', change: 1 }]);
    assert.deepEqual(error.details.approach, { reached: false, partial: true, stoppedReason: 'cancelled' });
    assert.deepEqual(error.details.selectedTarget, { ...later }); return true;
  });
  assert.equal(walks, 1); assert.ok(clears >= 1);
});

test('gather uses the same reachable 4–4.5 metre interval as direct dig without unnecessary navigation', async () => {
  const { bot, bag, blocks, block, run } = fixture(); const target = new Vec3(4, 66, 0);
  assert.ok(target.distanceTo(bot.entity.position) > 4 && target.distanceTo(bot.entity.position) < 4.5);
  block('oak_log', target);
  bot.dig = async (found: any) => { blocks.delete(found.position.toString()); bag.set('oak_log', 1); };
  bot.setControlState = () => { throw new Error('No navigation needed for a directly reachable block'); };
  const result: any = await run({ type: 'gather', block: 'oak_log' });
  assert.equal(result.minedBlocks, 1); assert.equal(result.pickupConfirmed, true);
});

test('gather shares conservative eye reach with dig for an overhead log rather than demanding an unnecessary standing route', async () => {
  const { bot, bag, block, blocks, run } = fixture();
  bot.entity.position = new Vec3(-226.5006441135258, 71, -110.63799328711728);
  const target = new Vec3(-228, 76, -111); block('oak_log', target);
  bot.canDigBlock = (found: any) => found.position.offset(.5, .5, .5).distanceTo(bot.entity.position.offset(0, 1.65, 0)) <= 5.1;
  bot.setControlState = () => { assert.fail('A reachable overhead log needs no approach movement.'); };
  bot.dig = async (found: any) => { assert.deepEqual(found.position, target); blocks.delete(target.toString()); bag.set('oak_log', 1); };
  const result: any = await run({ type: 'gather', block: 'oak_log', maxDistance: 8 });
  assert.equal(result.minedBlocks, 1); assert.equal(result.pickupConfirmed, true);
  assert.deepEqual(result.selectedTarget, { ...target });
});

test('gather waits briefly for a directly overhead item to fall instead of requesting vertical flight', async () => {
  const { bot, bag, blocks, block, run } = fixture(); block('oak_log', new Vec3(1, 66, 0));
  let fallTimer: ReturnType<typeof setTimeout> | undefined;
  bot.dig = async (found: any) => {
    blocks.delete(found.position.toString());
    bot.entities[33] = { id: 33, name: 'item', position: new Vec3(.5, 66.8, .5), height: .25, width: .25 };
    fallTimer = setTimeout(() => { delete bot.entities[33]; bag.set('oak_log', 1); }, 350);
  };
  bot.setControlState = () => { throw new Error('Do not move toward an overhead item'); };
  try {
    const result: any = await run({ type: 'gather', block: 'oak_log' });
    assert.equal(result.minedBlocks, 1); assert.equal(result.pickupConfirmed, true);
  } finally { clearTimeout(fallTimer); }
});

for (const blockName of ['chest', 'furnace']) test(`${blockName} container withdrawal confirms bag quantity and always closes the native window`, async () => {
  const { bot, bag, block, definitions, run } = fixture(); block(blockName, new Vec3(1, 64, 0));
  let contents = 5, closed = false;
  const window = { items: () => bot.inventory.items(), containerItems: () => [{ name: 'coal', count: contents }],
    withdraw: async (id: number, _meta: unknown, count: number) => { assert.equal(id, definitions.coal.id); contents -= count; bag.set('coal', count); },
    close: async () => { closed = true; bot.currentWindow = null; } };
  bot[blockName === 'furnace' ? 'openFurnace' : 'openContainer'] = async () => { bot.currentWindow = window; return window; };
  const result: any = await run({ type: 'container', position: { x: 1, y: 64, z: 0 }, operation: 'withdraw', item: 'coal', count: 2 });
  assert.equal(result.transferred, 2); assert.equal(contents, 3); assert.equal(closed, true);
});

test('smelt tracks actual input/fuel/output instead of assuming a recipe succeeded', async () => {
  const { bot, bag, block, definitions, run } = fixture(); block('furnace', new Vec3(1, 64, 0));
  bag.set('raw_iron', 1); bag.set('coal', 1);
  let input: any = null, output: any = null, closed = false;
  const furnace = { items: () => bot.inventory.items(), inputItem: () => input, outputItem: () => output, fuelItem: () => null, fuel: 0, progress: 0,
    putInput: async (id: number, _meta: unknown, count: number) => { assert.equal(id, definitions.raw_iron.id); bag.set('raw_iron', 0); input = { name: 'raw_iron', count }; },
    putFuel: async (id: number) => { assert.equal(id, definitions.coal.id); bag.set('coal', 0); input = null; output = { name: 'iron_ingot', count: 1 }; },
    takeOutput: async () => { bag.set('iron_ingot', (bag.get('iron_ingot') || 0) + output.count); output = null; },
    close: async () => { closed = true; bot.currentWindow = null; } };
  bot.openFurnace = async () => { bot.currentWindow = furnace; return furnace; };
  const result: any = await run({ type: 'smelt', position: { x: 1, y: 64, z: 0 }, input: 'raw_iron', fuel: 'coal' });
  assert.equal(result.collected, 1); assert.equal(result.output, 'iron_ingot'); assert.equal(closed, true);
  assert.ok(result.inventoryDelta.some((entry: any) => entry.item === 'iron_ingot' && entry.change === 1));
});

for (const operation of ['smelt', 'withdraw']) test(`installed furnace plugin ${operation} counts active-window player slots before close refreshes bot.inventory`, async () => {
  const fixture = nativeInventoryFixture(), { bot, Item, registry, full } = fixture;
  const require = createRequire(import.meta.url), windows = require('prismarine-windows')('1.21.4');
  const serverInventory = windows.createWindow(0, 'minecraft:inventory', 'player');
  const serverFurnace = windows.createWindow(1, 'minecraft:furnace', 'furnace');
  const log = registry.itemsByName.oak_log.id, planks = registry.itemsByName.oak_planks.id, charcoal = registry.itemsByName.charcoal.id;
  if (operation === 'smelt') {
    serverInventory.updateSlot(9, new Item(log, 1)); serverInventory.updateSlot(10, new Item(planks, 1));
    full(0, { 9: ['oak_log', 1], 10: ['oak_planks', 1] });
  } else {
    serverFurnace.updateSlot(2, new Item(charcoal, 1)); full(0, {});
  }
  let menu = serverInventory, stateId = 0, cooked = false, beforeClose: any;
  const block = { name: 'furnace', position: new Vec3(1, 64, 0) };
  bot.blockAt = () => block; bot.canSeeBlock = () => true;
  const snapshot = () => bot._client.emit('window_items', { windowId: menu.id, stateId: ++stateId,
    items: menu.slots.map((entry: any) => Item.toNotch(entry)), carriedItem: Item.toNotch(menu.selectedItem) });
  const slot = (index: number, value: any) => {
    serverFurnace.updateSlot(index, value);
    bot._client.emit('set_slot', { windowId: 1, stateId: ++stateId, slot: index, item: Item.toNotch(value) });
  };
  const openFurnace = bot.openFurnace;
  bot.openFurnace = async (...args: any[]) => {
    const furnace = await openFurnace(...args), method = operation === 'smelt' ? 'takeOutput' : 'withdraw', take = furnace[method];
    assert.equal(furnace.inventoryItems, undefined, 'This nonexistent API caused the old fallback to stale window 0.');
    furnace[method] = async (...arguments_: any[]) => {
      const output = await take(...arguments_);
      beforeClose = { current: furnace.count(charcoal, null), staleInventory: bot.inventory.count(charcoal, null) };
      return output;
    };
    return furnace;
  };
  bot._client.write = (name: string, packet: any) => queueMicrotask(() => {
    if (name === 'block_place') {
      menu = serverFurnace;
      for (let i = 9; i < 45; i++) menu.updateSlot(i - 6, Item.fromNotch(Item.toNotch(serverInventory.slots[i])));
      bot._client.emit('open_window', { windowId: 1, inventoryType: 'minecraft:furnace', windowTitle: 'furnace' });
      snapshot();
    } else if (name === 'window_click') {
      assert.equal(packet.windowId, menu.id);
      if (packet.mode === 5) snapshot();
      else {
        menu.acceptClick({ ...packet, item: menu.slots[packet.slot] });
        if (!cooked && serverFurnace.slots[0]?.type === log && serverFurnace.slots[1]?.type === planks) {
          cooked = true;
          // The test server completes the cook deterministically; the installed
          // furnace/transfer/takeOutput implementations still handle every click.
          slot(0, null); slot(1, null); slot(2, new Item(charcoal, 1));
          for (const [property, value] of [[1, 150], [0, 150]]) bot._client.emit('craft_progress_bar', { windowId: 1, property, value });
        }
      }
    } else if (name === 'close_window') {
      for (let i = 3; i < 39; i++) serverInventory.updateSlot(i + 6, Item.fromNotch(Item.toNotch(serverFurnace.slots[i])));
      menu = serverInventory;
    } else if (name === 'client_command') bot._client.emit('statistics', { entries: [] });
    else assert.fail(`Unexpected packet ${name}`);
  });
  const proposal = operation === 'smelt' ? { type: 'smelt', input: 'oak_log', fuel: 'oak_planks', count: 1, position: { x: 1, y: 64, z: 0 } }
    : { type: 'container', operation: 'withdraw', item: 'charcoal', count: 1, position: { x: 1, y: 64, z: 0 } };
  const details: any = await runSurvivalAction(bot, action(proposal), new AbortController().signal, { moveTo: async () => {}, approachBlock: async () => { assert.fail('Non-gather actions must not request resource approach.'); }, entityVisible: () => true });
  assert.deepEqual(beforeClose, { current: 1, staleInventory: 0 });
  if (operation === 'smelt') {
    assert.equal(details.collected, 1); assert.equal(details.output, 'charcoal');
    assert.deepEqual(details.inventoryDelta, [{ item: 'oak_log', change: -1 }, { item: 'oak_planks', change: -1 }, { item: 'charcoal', change: 1 }]);
  } else {
    assert.equal(details.transferred, 1); assert.deepEqual(details.inventoryDelta, [{ item: 'charcoal', change: 1 }]);
  }
  assert.equal(bot.inventory.count(charcoal, null), 1); assert.equal(serverInventory.count(charcoal, null), 1);
  assert.equal(bot.currentWindow, null);
});

test('smelt cancellation closes the window and reports materials left in the furnace', async () => {
  const { bot, bag, block, run } = fixture(); block('furnace', new Vec3(1, 64, 0));
  bag.set('raw_iron', 1); bag.set('coal', 1);
  const controller = new AbortController(); let input: any = null, fuel: any = null, closed = false;
  const furnace = { items: () => bot.inventory.items(), inputItem: () => input, outputItem: () => null, fuelItem: () => fuel, fuel: 0, progress: .2,
    putInput: async () => { bag.set('raw_iron', 0); input = { name: 'raw_iron', count: 1 }; },
    putFuel: async () => { bag.set('coal', 0); fuel = { name: 'coal', count: 1 }; controller.abort(); },
    close: async () => { closed = true; bot.currentWindow = null; } };
  bot.openFurnace = async () => { bot.currentWindow = furnace; return furnace; };
  await assert.rejects(run({ type: 'smelt', position: { x: 1, y: 64, z: 0 }, input: 'raw_iron', fuel: 'coal' }, controller.signal), (error: any) => {
    assert.equal(error.details.remaining.input.item, 'raw_iron'); assert.equal(error.details.collected, 0); return true;
  });
  assert.equal(closed, true);
});

test('sleep requires a visible bed in the overworld and a confirmed sleeping state', async () => {
  const { bot, block, run } = fixture(); block('red_bed', new Vec3(1, 64, 0));
  bot.isABed = (target: any) => target.name.endsWith('_bed'); bot.sleep = async () => { bot.isSleeping = true; };
  assert.equal((await run({ type: 'sleep', position: { x: 1, y: 64, z: 0 } }) as any).sleeping, true);
  bot.game.dimension = 'the_nether';
  await assert.rejects(run({ type: 'sleep', position: { x: 1, y: 64, z: 0 } }), /当前维度/);
});

test('native short walking can jump a single block and refuses a deep drop', async () => {
  const { bot, controls, block, blocks } = fixture(); block('stone', new Vec3(1, 64, 0));
  let jumped = false;
  bot.setControlState = (key: string, value: boolean) => {
    controls[key] = value; if (key === 'jump' && value) jumped = true;
    if (key === 'forward' && value) bot.entity.position = new Vec3(2.5, 65, .5);
  };
  await nativeWalkTo(bot, new Vec3(2.5, 65, .5), new AbortController().signal, .65);
  assert.equal(jumped, true);
  blocks.clear(); bot.entity.position = new Vec3(.5, 64, .5); bot.clearControlStates();
  await assert.rejects(nativeWalkTo(bot, new Vec3(2.5, 64, .5), new AbortController().signal), /深坑/);
  assert.deepEqual(controls, {});
});

test('native walking accepts known two/three-block descents and distinguishes unknown support', async () => {
  for (const drop of [2, 3]) {
    const { bot, block } = fixture(); block('stone', new Vec3(1, 63 - drop, 0));
    bot.setControlState = (key: string, value: boolean) => { if (key === 'forward' && value) bot.entity.position = new Vec3(2.5, 64 - drop, .5); };
    await nativeWalkTo(bot, new Vec3(2.5, 64 - drop, .5), new AbortController().signal);
    assert.equal(bot.entity.position.y, 64 - drop);
  }
  const { bot } = fixture(), original = bot.blockAt;
  bot.blockAt = (position: Vec3) => position.y === 62 ? null : original(position);
  await assert.rejects(nativeWalkTo(bot, new Vec3(2.5, 61, .5), new AbortController().signal), /尚未加载/);
});

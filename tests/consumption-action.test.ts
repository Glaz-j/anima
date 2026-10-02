import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import registryFactory from 'prismarine-registry';
import itemFactory from 'prismarine-item';
import { Vec3 } from 'vec3';
import installInventory from '../node_modules/mineflayer/lib/plugins/inventory.js';
import installHealth from '../node_modules/mineflayer/lib/plugins/health.js';
import { consumeHeldItem } from '../adapters/minecraft/src/consumption-action.ts';

function fixture() {
  const registry = registryFactory('1.21.4'), Item = itemFactory(registry), packets: any[] = [];
  const bot: any = Object.assign(new EventEmitter(), {
    version: '1.21.4', registry, supportFeature: registry.supportFeature, QUICK_BAR_START: 36,
    _client: new EventEmitter(), game: { gameMode: 'survival' },
    entity: { id: 17, position: new Vec3(.5, 64, .5), yaw: 0, pitch: 0 },
  });
  let stats = true, stateId = 0;
  bot._client.write = (name: string, body: any) => {
    packets.push({ name, body });
    if (name === 'client_command' && stats) queueMicrotask(() => bot._client.emit('statistics', { entries: [] }));
  };
  installInventory(bot, { hideErrors: true }); installHealth(bot, { respawn: false }); bot.quickBarSlot = 0;
  bot._client.emit('update_health', { health: 5, food: 17, foodSaturation: 0 });
  const slot = (index: number, name?: string, count = 1) => bot._client.emit('set_slot', {
    windowId: 0, stateId: ++stateId, slot: index,
    item: Item.toNotch(name ? new Item(registry.itemsByName[name].id, count) : null),
  });
  slot(36, 'cod'); packets.length = 0;
  const snapshot = () => [
    ...['entity_status', 'update_health', 'end', 'statistics'].map(event => bot._client.listenerCount(event)),
    bot.inventory.listenerCount('updateSlot'), bot.listenerCount('death'), bot.listenerCount('respawn'),
  ];
  return { bot, packets, slot, snapshot,
    status: (entityId = 17, entityStatus = 9) => bot._client.emit('entity_status', { entityId, entityStatus }),
    health: (food = 19) => bot._client.emit('update_health', { health: 5, food, foodSaturation: 0 }),
    uses: () => packets.filter(packet => packet.name === 'use_item'),
    stops: () => packets.filter(packet => packet.name === 'block_dig'),
    pauseStats: () => { stats = false; }, ack: () => bot._client.emit('statistics', { entries: [] }),
  };
}

test('native completion before slot and food packets waits for actual consumption, not healing', async () => {
  const f = fixture(), listeners = f.snapshot(); let settled = false;
  const pending = consumeHeldItem(f.bot, new AbortController().signal).finally(() => { settled = true; });
  assert.equal(f.uses().length, 1); f.status(); await delay(0);
  assert.equal(settled, false); assert.equal(f.bot.food, 17);
  f.slot(36); await delay(0); assert.equal(settled, false, 'The food result packet has not arrived.');
  f.health(); const result = await pending;
  assert.equal(result.nativeFinished, true); assert.equal(result.useCompleted, true);
  assert.equal(result.consumptionConfirmed, true); assert.equal(result.inventoryConfirmed, true);
  assert.deepEqual(result.inventoryDelta, [{ item: 'cod', change: -1 }]);
  assert.equal(result.food, 19); assert.equal(result.health, 5); assert.equal(result.healthBefore, 5);
  assert.equal(f.uses().length, 1); assert.equal(f.stops().length, 1); assert.deepEqual(f.snapshot(), listeners);
});

test('native heldItemChanged early completion retracts but does not claim consumption', async () => {
  const f = fixture(), listeners = f.snapshot();
  const pending = consumeHeldItem(f.bot, new AbortController().signal);
  const rejected = assert.rejects(pending, (error: any) => {
    assert.equal(error.details.nativeFinished, true); assert.equal(error.details.useCompleted, false);
    assert.equal(error.details.consumptionConfirmed, false); assert.equal(error.details.inventoryConfirmed, true);
    assert.deepEqual(error.details.inventoryDelta, []); return true;
  });
  // A server-driven move of the stack changes the held item without eating it.
  f.slot(9, 'cod'); f.slot(36); await delay(0);
  assert.equal(f.bot.usingHeldItem, false); assert.equal(f.stops().length, 1);
  await rejected; assert.equal(f.uses().length, 1); assert.deepEqual(f.snapshot(), listeners);
});

test('confirmed slot and nutrition still await the already sent queue barrier', async () => {
  const f = fixture(), listeners = f.snapshot(); f.pauseStats(); let settled = false;
  const pending = consumeHeldItem(f.bot, new AbortController().signal).finally(() => { settled = true; });
  f.status(); f.slot(36); f.health(); await delay(0);
  assert.equal(settled, false); assert.equal(f.packets.filter(p => p.name === 'client_command').length, 1);
  f.ack(); assert.equal((await pending).consumptionConfirmed, true); assert.deepEqual(f.snapshot(), listeners);
});

test('cancellation retracts despite unrelated entity status clearing usingHeldItem and drains native use', async () => {
  const f = fixture(), controller = new AbortController(), listeners = f.snapshot(); let settled = false;
  const pending = consumeHeldItem(f.bot, controller.signal).finally(() => { settled = true; });
  const rejected = assert.rejects(pending, (error: any) => {
    assert.match(error.message, /取消/); assert.equal(error.details.consumptionConfirmed, false); return true;
  });
  f.status(99, 2); assert.equal(f.bot.usingHeldItem, false); controller.abort(); await delay(0);
  assert.equal(f.stops().length, 1); assert.equal(settled, false, 'The native pending promise still owns the body.');
  assert.equal(f.packets.filter(p => p.name === 'client_command').length, 0);
  f.status(); await rejected;
  assert.equal(f.uses().length, 1); assert.equal(f.stops().length, 1); assert.deepEqual(f.snapshot(), listeners);
});

test('disconnect does not send more packets and waits for native timeout before releasing', async () => {
  const f = fixture(), listeners = f.snapshot(); let settled = false;
  const pending = consumeHeldItem(f.bot, new AbortController().signal).finally(() => { settled = true; });
  const rejected = assert.rejects(pending, (error: any) => {
    assert.equal(error.details.inventoryConfirmed, false); assert.equal(error.details.consumptionConfirmed, false);
    assert.deepEqual(error.details.inventoryDelta, []); return true;
  });
  f.bot._client.emit('end'); await delay(0); assert.equal(settled, false);
  await rejected; assert.deepEqual(f.packets.map(packet => packet.name), ['use_item']);
  assert.deepEqual(f.snapshot(), listeners);
});

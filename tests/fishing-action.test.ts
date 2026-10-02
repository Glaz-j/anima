import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import registryFactory from 'prismarine-registry';
import itemFactory from 'prismarine-item';
import { Vec3 } from 'vec3';
import installInventory from '../node_modules/mineflayer/lib/plugins/inventory.js';
import installFishing from '../node_modules/mineflayer/lib/plugins/fishing.js';
import { fishOnce } from '../adapters/minecraft/src/fishing-action.ts';
import { action } from '../adapters/minecraft/src/validation.ts';

const proposal = { type: 'fish', position: { x: 3, y: 63, z: 0 }, durationMs: 1000 };
function fixture() {
  const registry = registryFactory('1.21.4'), Item = itemFactory(registry), packets: any[] = [];
  const bot: any = Object.assign(new EventEmitter(), {
    version: '1.21.4', registry, supportFeature: registry.supportFeature, QUICK_BAR_START: 36,
    _client: new EventEmitter(), entities: {}, health: 20,
    entity: { id: 17, position: new Vec3(.5, 64, .5), eyeHeight: 1.62, yaw: 0, pitch: 0 },
    game: { gameMode: 'survival' }, lookAt: async () => {}, canSeeBlock: () => true, world: { raycast: () => null },
    blockAt: (point: Vec3) => ({ name: point.floored().equals(new Vec3(3, 63, 0)) ? 'water' : 'air', position: point.floored() }),
  });
  let stats = true;
  bot._client.write = (name: string, body: any) => {
    packets.push({ name, body });
    if (name === 'client_command' && stats) queueMicrotask(() => bot._client.emit('statistics', { entries: [] }));
  };
  installInventory(bot, { hideErrors: true }); bot.quickBarSlot = 0;
  bot.inventory.updateSlot(36, new Item(registry.itemsByName.fishing_rod.id, 1));
  bot.equip = async (item: any) => bot.inventory.updateSlot(36, item);
  const snapshot = () => ['spawn_entity', 'entity_metadata', 'entity_destroy', 'end', 'statistics'].map(name => bot._client.listenerCount(name));
  const spawn = (id = 61, owner = 17) => {
    bot.entities[id] = { id, name: 'fishing_bobber', position: new Vec3(3.5, 63.9, .5) };
    bot._client.emit('spawn_entity', { entityId: id, type: registry.entitiesByName.fishing_bobber.id, objectData: owner });
  };
  const bite = (id = 61) => bot._client.emit('entity_metadata', { entityId: id, metadata: [{ key: 9, value: true }] });
  const destroy = (id = 61) => { delete bot.entities[id]; bot._client.emit('entity_destroy', { entityIds: [id] }); };
  return { bot, packets, registry, Item, snapshot, spawn, bite, destroy,
    casts: () => packets.filter(packet => packet.name === 'use_item'),
    pauseStats: () => { stats = false; }, ack: () => bot._client.emit('statistics', { entries: [] }),
  };
}

test('fish schema supplies the bounded default and requires an integer water cell', () => {
  assert.deepEqual(action({ type: 'fish', position: proposal.position }), { ...proposal, durationMs: 30000 });
  for (const invalid of [{ ...proposal, durationMs: 0 }, { ...proposal, durationMs: 45001 },
    { ...proposal, position: { x: 3.2, y: 63, z: 0 } }]) assert.throws(() => action(invalid));
});

test('installed bot.fish has no cancellation handle and deactivateItem does not settle it', async () => {
  const f = fixture(); installFishing(f.bot); let settled = false;
  const pending = f.bot.fish().catch((error: Error) => error).finally(() => { settled = true; });
  f.spawn(); f.bot.deactivateItem(); await delay(0);
  assert.equal(settled, false); f.destroy(); assert.match((await pending).message, /cancelled/);
});

test('only own owner-id hook biting triggers immediate native reel before delayed statistics', async () => {
  const f = fixture(), listeners = f.snapshot(); f.pauseStats(); let settled = false;
  const pending = fishOnce(f.bot, proposal, new AbortController().signal).finally(() => { settled = true; });
  await delay(0); assert.equal(f.casts().length, 1);
  f.spawn(60, 18); f.bite(60); // owner id + 1 is another player's hook.
  f.bot._client.emit('world_particles', { particle: { type: 'fishing' }, amount: 6, x: 3.5, y: 63.9, z: .5 });
  await delay(0); assert.equal(f.casts().length, 1);
  f.spawn(); f.bite(); await delay(0);
  assert.equal(f.casts().length, 2, 'Reel precedes the statistics response.'); assert.equal(settled, false);
  assert.deepEqual(f.packets.map(packet => packet.name), ['use_item', 'use_item', 'client_command']);
  f.bot.inventory.updateSlot(9, new f.Item(f.registry.itemsByName.cod.id, 1));
  f.destroy(); await delay(0); assert.equal(settled, false, 'The queue is still draining.');
  f.ack(); const result = await pending;
  assert.equal(result.biteDetected, true); assert.equal(result.reelSent, true); assert.equal(result.hookRemoved, true);
  assert.equal(result.catchConfirmed, false); assert.deepEqual(result.inventoryDelta, [{ item: 'cod', change: 1 }]);
  assert.deepEqual(f.snapshot(), listeners);
});

test('cancellation before spawn drains the late own hook then retracts without recasting', async () => {
  const f = fixture(), controller = new AbortController(), listeners = f.snapshot(); f.pauseStats();
  const pending = fishOnce(f.bot, proposal, controller.signal); const rejected = assert.rejects(pending, (error: any) => {
    assert.equal(error.details.outcome, 'cancelled'); assert.equal(error.details.reelSent, true);
    assert.equal(error.details.hookRemoved, true); assert.equal(error.details.biteDetected, false); return true;
  });
  await delay(0); controller.abort(); await delay(0);
  assert.equal(f.casts().length, 1); f.spawn(); f.ack(); await delay(0);
  assert.equal(f.casts().length, 2); f.destroy(); f.ack(); await rejected;
  assert.deepEqual(f.snapshot(), listeners);
});

test('no-bite timeout retracts its hook but never reports a catch', async () => {
  const f = fixture(), listeners = f.snapshot();
  const pending = fishOnce(f.bot, { ...proposal, durationMs: 30 }, new AbortController().signal);
  const rejected = assert.rejects(pending, (error: any) => {
    assert.equal(error.details.outcome, 'timeout'); assert.equal(error.details.biteDetected, false);
    assert.equal(error.details.reelSent, true); assert.deepEqual(error.details.inventoryDelta, []); return true;
  });
  await delay(0); f.spawn(); await delay(50); assert.equal(f.casts().length, 2); f.destroy(); await rejected;
  assert.deepEqual(f.snapshot(), listeners);
});

test('cancelled native aiming is drained and sends no cast', async () => {
  const f = fixture(), controller = new AbortController(), listeners = f.snapshot(); let release!: () => void, settled = false;
  f.bot.lookAt = () => new Promise<void>(resolve => { release = resolve; });
  const pending = fishOnce(f.bot, proposal, controller.signal).finally(() => { settled = true; });
  const rejected = assert.rejects(pending, /取消/);
  await delay(0); controller.abort(); await delay(0); assert.equal(settled, false);
  release(); await rejected; assert.deepEqual(f.casts(), []); assert.deepEqual(f.snapshot(), listeners);
});

test('unconfirmed missing hook and disconnect quarantine later fishing and remove per-cast listeners', async () => {
  for (const disconnected of [false, true]) {
    const f = fixture(), controller = new AbortController(), listeners = f.snapshot();
    const pending = fishOnce(f.bot, proposal, controller.signal);
    const rejected = assert.rejects(pending, (error: any) => {
      assert.equal(error.details.inventoryConfirmed, false); assert.equal(error.details.reelSent, false); return true;
    });
    await delay(0);
    if (disconnected) f.bot._client.emit('end'); else controller.abort();
    await rejected; assert.deepEqual(f.snapshot(), listeners); assert.equal(f.casts().length, 1);
    f.spawn(); f.bite(); await delay(0); assert.equal(f.casts().length, 1);
    await assert.rejects(fishOnce(f.bot, proposal, new AbortController().signal), /上次鱼钩收尾未确认/);
  }
});

test('water reach, actual water, sight and held rod are revalidated before casting', async () => {
  for (const changed of ['far', 'not_water', 'unloaded', 'occluded', 'hand']) {
    const f = fixture();
    f.bot.lookAt = async () => {
      if (changed === 'far') f.bot.entity.position = new Vec3(30, 64, 0);
      if (changed === 'not_water') f.bot.blockAt = (position: Vec3) => ({ name: 'stone', position });
      if (changed === 'unloaded') { const read = f.bot.blockAt; f.bot.blockAt = (position: Vec3) => position.x === 1 ? null : read(position); }
      if (changed === 'occluded') f.bot.world.raycast = () => ({ name: 'stone' });
      if (changed === 'hand') f.bot.inventory.updateSlot(36, null);
    };
    await assert.rejects(fishOnce(f.bot, proposal, new AbortController().signal)); assert.deepEqual(f.casts(), [], changed);
  }
});

test('after bite and hook cleanup briefly observes actual delayed slot pickup without attributing it', async () => {
  const f = fixture(), listeners = f.snapshot(), slotListeners = f.bot.inventory.listenerCount('updateSlot'); let settled = false;
  const pending = fishOnce(f.bot, proposal, new AbortController().signal).finally(() => { settled = true; });
  await delay(0); f.spawn(); f.bite(); await delay(0); f.destroy(); await delay(0);
  assert.equal(settled, false); assert.equal(f.casts().length, 2);
  f.bot._client.emit('set_slot', { windowId: 0, stateId: 1, slot: 9,
    item: f.Item.toNotch(new f.Item(f.registry.itemsByName.cod.id, 1)) });
  const result = await pending;
  assert.equal(result.pickupObservation.status, 'inventory_gain_observed');
  assert.ok(result.pickupObservation.maxWaitMs <= 1500);
  assert.deepEqual(result.inventoryDelta, [{ item: 'cod', change: 1 }]); assert.equal(result.catchConfirmed, false);
  assert.deepEqual(f.snapshot(), listeners); assert.equal(f.bot.inventory.listenerCount('updateSlot'), slotListeners);
});

test('a bite without observed inventory gain has a bounded optional wait and never claims a catch', async () => {
  const f = fixture(), listeners = f.snapshot();
  const pending = fishOnce(f.bot, proposal, new AbortController().signal);
  await delay(0); f.spawn(); f.bite(); await delay(0); f.destroy();
  const result = await pending;
  assert.equal(result.pickupObservation.status, 'no_gain_observed_in_window');
  assert.ok(result.pickupObservation.maxWaitMs <= 1500); assert.ok(result.pickupObservation.waitMs < 2000);
  assert.equal(result.catchConfirmed, false); assert.deepEqual(result.inventoryDelta, []);
  assert.equal(f.casts().length, 2); assert.deepEqual(f.snapshot(), listeners);
});

test('cancel, disconnect and body changes end optional pickup observation without another toggle', async () => {
  for (const event of ['cancel', 'end', 'death', 'respawn']) {
    const f = fixture(), controller = new AbortController(), listeners = f.snapshot();
    const slotListeners = f.bot.inventory.listenerCount('updateSlot');
    const pending = fishOnce(f.bot, proposal, controller.signal);
    const rejected = assert.rejects(pending, (error: any) => {
      assert.equal(error.details.pickupObservation.status, 'interrupted');
      if (event !== 'cancel') assert.equal(error.details.inventoryConfirmed, false);
      assert.equal(error.details.catchConfirmed, false); return true;
    });
    await delay(0); f.spawn(); f.bite(); await delay(0); f.destroy(); await delay(0);
    if (event === 'cancel') controller.abort();
    else if (event === 'end') f.bot._client.emit('end');
    else f.bot.emit(event);
    await rejected; assert.equal(f.casts().length, 2); assert.deepEqual(f.snapshot(), listeners);
    assert.equal(f.bot.inventory.listenerCount('updateSlot'), slotListeners);
  }
});

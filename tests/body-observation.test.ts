import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import registryFactory from 'prismarine-registry';
import installEntities from '../node_modules/mineflayer/lib/plugins/entities.js';
import installHealth from '../node_modules/mineflayer/lib/plugins/health.js';
import { bodyEnvironment, trackBodyEnvironment } from '../adapters/minecraft/src/body-observation.ts';
import { MinecraftWorld } from '../adapters/minecraft/src/world.ts';

function fixture(t: any, trackBeforePlugins = false) {
  const bot: any = new EventEmitter();
  bot.version = '1.21.4'; bot.registry = registryFactory(bot.version); bot.supportFeature = bot.registry.supportFeature;
  bot._client = new EventEmitter(); bot._client.username = 'Tester'; bot._client.write = () => {};
  const earlyCleanup = trackBeforePlugins ? trackBodyEnvironment(bot) : undefined;
  installEntities(bot); installHealth(bot, { respawn: false });
  const cleanup = earlyCleanup || trackBodyEnvironment(bot); t.after(cleanup);
  bot._client.emit('login', { entityId: 1 });
  const air = (value: unknown, entityId = bot.entity.id) => bot._client.emit('entity_metadata', {
    entityId, metadata: [{ key: bot.registry.entitiesByName.player.metadataKeys.indexOf('air_supply'), type: 'varint', value }],
  });
  return { bot, air };
}

test('self locomotion preserves native true, false and unknown without inferring breathing', t => {
  const { bot } = fixture(t);
  // Prismarine Entity starts with native onGround=true; water flags do not yet exist.
  assert.deepEqual(bodyEnvironment(bot), { locomotion: { onGround: true } });
  bot.entity.isInWater = true; bot.entity.isInLava = false; bot.entity.onGround = false;
  assert.deepEqual(bodyEnvironment(bot), { locomotion: { inWater: true, inLava: false, onGround: false } });
  bot.entity.isInWater = 'false'; bot.entity.isInLava = null; delete bot.entity.onGround;
  bot.oxygenLevel = 20;
  assert.deepEqual(bodyEnvironment(bot), {}, 'An unverified global oxygenLevel is not evidence of full self air.');
});

test('real Mineflayer metadata conversion is native 0–20 scale and another entity cannot replace self oxygen', t => {
  const { bot, air } = fixture(t);
  let nativeBreathEvents = 0; bot.on('breath', () => nativeBreathEvents++);
  air(300);
  assert.equal(bot.oxygenLevel, 20);
  assert.deepEqual(bodyEnvironment(bot).oxygen, { level: 20, max: 20, unit: 'native-oxygen' });
  air(254);
  assert.equal(bot.oxygenLevel, 17); assert.equal(bodyEnvironment(bot).oxygen?.level, 17);
  const other = new bot.entity.constructor(2); other.name = 'player'; bot.entities[2] = other;
  air(0, 2);
  assert.equal(bot.oxygenLevel, 0, 'The installed plugin currently overwrites its global oxygen for other entities.');
  assert.equal(bodyEnvironment(bot).oxygen?.level, 17, 'Only our own metadata is authoritative for this body.');
  assert.equal(nativeBreathEvents, 3);
  air(0);
  assert.deepEqual(bodyEnvironment(bot).oxygen, { level: 0, max: 20, unit: 'native-oxygen' });
  air(-20);
  assert.equal(bot.oxygenLevel, -1, 'Vanilla drowning metadata may make the native conversion briefly negative.');
  assert.equal(bodyEnvironment(bot).oxygen?.level, 0, 'Exhausted air is represented as zero remaining reserve.');
});

test('missing or invalid own air supply stays unknown rather than inheriting another entity or manufacturing full air', t => {
  const { bot, air } = fixture(t);
  const other = new bot.entity.constructor(2); other.name = 'player'; bot.entities[2] = other;
  air(300, 2);
  assert.equal(bot.oxygenLevel, 20); assert.equal(bodyEnvironment(bot).oxygen, undefined);
  for (const invalid of [undefined, null, '300', NaN, Infinity, 1.5, -21, 301]) {
    air(0); air(invalid);
    assert.equal(bodyEnvironment(bot).oxygen, undefined, `Invalid air supply ${String(invalid)} is not accepted.`);
  }
  air(120);
  bot._client.emit('entity_metadata', { entityId: 1, metadata: [] });
  assert.equal(bodyEnvironment(bot).oxygen?.level, 8, 'An unrelated own metadata update preserves the last known self air.');
});

test('death, respawn, login and entity replacement invalidate old self air until a fresh own packet', t => {
  const { bot, air } = fixture(t);
  for (const event of ['death', 'respawn', 'login', 'replace']) {
    air(0); assert.equal(bodyEnvironment(bot).oxygen?.level, 0);
    if (event === 'death') bot._client.emit('update_health', { health: 0, food: 18, foodSaturation: 0 });
    if (event === 'respawn') bot._client.emit('respawn', {});
    if (event === 'login') bot._client.emit('login', { entityId: 1 });
    if (event === 'replace') {
      bot.entity = Object.assign(new bot.entity.constructor(1), { name: 'player' }); bot.entities[1] = bot.entity;
    }
    assert.equal(bodyEnvironment(bot).oxygen, undefined, event);
    air(300); assert.equal(bodyEnvironment(bot).oxygen?.level, 20);
  }
  const listeners = bot._client.listenerCount('entity_metadata');
  bot.emit('end');
  assert.equal(bot._client.listenerCount('entity_metadata'), listeners - 1);
  assert.equal(bodyEnvironment(bot).oxygen, undefined);
});

test('Minecraft world observation distinguishes unobserved oxygen from confirmed zero', t => {
  const { bot, air } = fixture(t);
  bot.game = { dimension: 'overworld', gameMode: 'survival' }; bot.health = 20; bot.food = 20;
  bot.inventory = { items: () => [], slots: [] }; bot.time = { timeOfDay: 6000, isDay: true };
  bot.findBlocks = () => []; bot.blockAt = () => null; bot.world = { raycast: () => null };
  const world = new MinecraftWorld({ host: 'unused', port: 0, version: bot.version, logDirectory: 'unused-no-events' });
  world.bots.set('Tester', { name: 'Tester', persona: '', bot, ready: true, inventorySynced: true, events: [] });
  let observed = world.observe('Tester');
  assert.equal(Object.hasOwn(observed, 'oxygen'), false);
  bot.entity.isInWater = true; bot.entity.isInLava = false; bot.entity.onGround = false;
  air(0); observed = world.observe('Tester');
  assert.deepEqual(observed.oxygen, { level: 0, max: 20, unit: 'native-oxygen' });
  assert.deepEqual(observed.locomotion, { inWater: true, inLava: false, onGround: false });
  assert.equal(observed.health, 20); assert.equal(observed.food, 20);
});

test('tracking registered before native plugins still observes own packets and rejects unrecognized metadata layouts', t => {
  const { bot, air } = fixture(t, true);
  air(45); assert.equal(bodyEnvironment(bot).oxygen?.level, 3);
  bot._client.emit('respawn', {});
  bot.entity.name = 'unrecognized';
  air(300); assert.equal(bodyEnvironment(bot).oxygen, undefined);
  bot.entity.name = 'player';
  air(0); assert.equal(bodyEnvironment(bot).oxygen?.level, 0);
});

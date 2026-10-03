import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { MinecraftBody } from '../adapters/minecraft/src/minecraft-body.ts';

async function flush() { for (let i = 0; i < 16; i++) await Promise.resolve(); }

function fixture() {
  const bot: any = new EventEmitter(), calls: any[] = [], pending: (() => void)[] = [];
  bot.entity = { id: 1, position: new Vec3(0, 64, 0), eyeHeight: 1.62, width: .6, height: 1.8,
    onGround: true, isInWater: false, isInLava: false, velocity: new Vec3(0, 0, 0) };
  bot._client = new EventEmitter(); bot._client.write = () => {};
  bot.entities = {}; bot.health = 4; bot.food = 20; bot.version = '1.21.4';
  bot.game = { dimension: 'overworld', gameMode: 'survival' };
  bot.inventory = { slots: [], items: () => [] }; bot.registry = { foodsByName: {} };
  bot.world = { raycast: () => null };
  bot.blockAt = (position: Vec3) => ({ name: position.y < 64 ? 'stone' : 'air',
    boundingBox: position.y < 64 ? 'block' : 'empty', position });
  bot.setControlState = () => {}; bot.getControlState = () => false;
  bot.clearControlStates = () => {}; bot.stopDigging = () => {}; bot.deactivateItem = () => {};
  const world: any = { event: () => {}, executeOwned: (_name: string, action: any, signal: AbortSignal) => {
    calls.push({ action, signal });
    return new Promise(resolve => pending.push(() => resolve({ status: 'cancelled', action })));
  } };
  const record: any = { name: 'Tester', bot, ready: true, events: [] };
  const body = new MinecraftBody(world, record); record.body = body;
  const spider = (name = 'spider', id = 9) => {
    const entity = { id, name, position: new Vec3(2, 64, 0), width: 1.4, height: .9, health: 16 };
    bot.entities[id] = entity; return entity;
  };
  const submit = async (reactions = ['flee'], resume = false, chaseRange = 12) => {
    const result = body.submit({ expectedVersion: body.snapshot().version, steps: [], reactions,
      policy: { chaseRange } }, resume);
    await flush(); assert.equal(result.accepted, true);
  };
  const drain = async () => { for (const done of pending.splice(0)) done(); await flush(); };
  const clean = async () => { const done = body.dispose(); await drain(); await done; };
  return { bot, body, record, calls, spider, submit, drain, clean };
}

for (const kind of ['spider', 'cave_spider']) {
  test(`${kind} becomes a local threat only after it hurts this NPC and invalidates the perception cache`, async t => {
    const f = fixture(); t.after(f.clean); const source = f.spider(kind);
    await f.submit(); assert.equal(f.calls.length, 0, 'An untouched spider is neutral.');
    f.bot.emit('entityHurt', { id: 88 }, source); f.body.controller.tick(); await flush();
    assert.equal(f.calls.length, 0, 'Damage to another actor is not evidence of attacking us.');
    f.bot.emit('entityHurt', f.bot.entity); f.body.controller.tick(); await flush();
    assert.equal(f.calls.length, 0, 'Do not infer an attacker from proximity.');
    f.bot.emit('entityHurt', f.bot.entity, source); f.body.controller.tick(); await flush();
    assert.equal(f.calls.length, 1, 'A genuine source must bypass the old empty 200ms cache.');
    assert.equal(f.calls[0].action.type, 'retreat'); assert.equal(f.calls[0].action.entityId, source.id);
    assert.equal(f.calls[0].action.maxDistance, 12);
  });
}

test('a recent spider attacker cannot grant a missing reflex or expand a zero movement budget', async t => {
  const f = fixture(); t.after(f.clean); const source = f.spider();
  await f.submit([]); f.bot.emit('entityHurt', f.bot.entity, source);
  f.body.controller.tick(); await flush(); assert.equal(f.calls.length, 0);
  await f.submit(['flee'], false, 0);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].action.maxDistance, 0);
});

for (const event of ['death', 'respawn', 'spawn', 'end', 'dimension']) {
  test(`recent spider damage is cleared on ${event}`, async t => {
    const f = fixture(); t.after(f.clean); const source = f.spider();
    await f.submit([]); f.bot.emit('entityHurt', f.bot.entity, source);
    if (event === 'dimension') { f.bot.game.dimension = 'the_nether'; f.bot.emit('game'); }
    else f.bot.emit(event);
    await f.submit(); assert.equal(f.calls.length, 0);
  });
}

test('operator stop drops attacker evidence and ignores damage until an explicit resume', async t => {
  const f = fixture(); t.after(f.clean); const source = f.spider();
  await f.submit([]); f.bot.emit('entityHurt', f.bot.entity, source);
  const stopped = f.body.stop('operator'); await f.drain(); await stopped;
  f.bot.emit('entityHurt', f.bot.entity, source);
  await f.submit(['flee'], true); assert.equal(f.calls.length, 0);
  f.bot.emit('entityHurt', f.bot.entity, source); f.body.controller.tick(); await flush();
  assert.equal(f.calls.length, 1);
});

test('disposal removes the local damage event listener', async () => {
  const f = fixture(); const source = f.spider();
  assert.equal(f.bot.listenerCount('entityHurt'), 1);
  await f.clean(); assert.equal(f.bot.listenerCount('entityHurt'), 0);
  f.bot.emit('entityHurt', f.bot.entity, source); assert.equal(f.calls.length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLocalThreats, LOCAL_THREAT_TTL_MS, LOCAL_THREAT_RANGE, MAX_LOCAL_THREATS } from '../adapters/minecraft/src/local-threats.ts';

function fixture() {
  let time = 1000;
  const bot: any = new EventEmitter();
  bot.entity = { id: 1, name: 'player', position: { x: 0, y: 64, z: 0 } };
  bot.health = 20; bot.game = { dimension: 'overworld' }; bot.entities = {};
  const hidden = new Set<any>(), dead = new Set<any>();
  const threats = createLocalThreats(bot, { now: () => time,
    isVisible: entity => !hidden.has(entity), isAlive: entity => !dead.has(entity) });
  const spider = (id = 2, name = 'spider') => {
    const entity = { id, name, type: 'mob', health: 16, position: { x: 2, y: 64, z: 0 } };
    bot.entities[id] = entity; return entity;
  };
  return { bot, threats, hidden, dead, spider, setTime: (value: number) => { time = value; } };
}

test('spiders remain neutral until this exact bot is hurt by that exact local source', () => {
  const f = fixture();
  for (const name of ['spider', 'cave_spider']) {
    const source = f.spider(name === 'spider' ? 2 : 3, name);
    assert.equal(f.threats.has(source), false);
    assert.equal(f.threats.record({ ...f.bot.entity }, source), false, 'A matching victim ID is not a self-hit.');
    assert.equal(f.threats.record(f.bot.entity, source), true);
    assert.equal(f.threats.has(source), true);
  }
});

test('unknown sources, self, players, other mobs and hits on other actors cannot authorize a threat', () => {
  const f = fixture(), source = f.spider(), other = { id: 9 };
  const player = { ...f.spider(3), type: 'player' }, namedPlayer = { ...f.spider(4), username: 'spider' };
  f.bot.entities[3] = player; f.bot.entities[4] = namedPlayer;
  for (const candidate of [undefined, null, f.bot.entity, player, namedPlayer, f.spider(5, 'zombie')]) {
    assert.equal(f.threats.record(f.bot.entity, candidate), false);
    assert.equal(f.threats.has(candidate), false);
  }
  assert.equal(f.threats.record(other, source), false);
  assert.equal(f.threats.record(undefined, source), false);
  assert.equal(f.threats.has(source), false);
});

test('recording requires the loaded identity, finite local positions, visibility and at most 24 blocks', () => {
  const f = fixture(), source = f.spider();
  assert.equal(f.threats.record(f.bot.entity, { ...source }), false);
  delete f.bot.entities[source.id]; assert.equal(f.threats.record(f.bot.entity, source), false);
  f.bot.entities[source.id] = source;
  f.hidden.add(source); assert.equal(f.threats.record(f.bot.entity, source), false); f.hidden.clear();
  source.position.x = LOCAL_THREAT_RANGE + .001;
  assert.equal(f.threats.record(f.bot.entity, source), false);
  source.position.x = NaN; assert.equal(f.threats.record(f.bot.entity, source), false);
  source.position.x = 0; source.position.y = 64 + LOCAL_THREAT_RANGE + .001;
  assert.equal(f.threats.record(f.bot.entity, source), false, 'Range includes vertical distance.');
  source.position.y = 64; source.position.x = LOCAL_THREAT_RANGE;
  assert.equal(f.threats.record(f.bot.entity, source), true);
});

test('has rechecks current visibility, range and local health without using remembered positions', () => {
  const f = fixture(), source = f.spider(); f.threats.record(f.bot.entity, source);
  f.hidden.add(source); assert.equal(f.threats.has(source), false); f.hidden.clear();
  source.position.x = 25; assert.equal(f.threats.has(source), false);
  source.position.x = 2; assert.equal(f.threats.has(source), true);
  f.dead.add(source); assert.equal(f.threats.has(source), false);
  assert.equal(f.threats.record(f.bot.entity, source), false);
  f.dead.clear(); assert.equal(f.threats.has(source), false, 'Locally confirmed metadata death clears evidence too.');
  f.threats.record(f.bot.entity, source); source.health = 0; assert.equal(f.threats.has(source), false);
  source.health = 16; assert.equal(f.threats.has(source), false, 'Known death removes old evidence.');
});

test('unload and ID reuse never transfer aggression to a different entity', () => {
  const f = fixture(), source = f.spider(); f.threats.record(f.bot.entity, source);
  const replacement = f.spider(source.id);
  assert.equal(f.threats.has(source), false); assert.equal(f.threats.has(replacement), false);
  assert.equal(f.threats.record(f.bot.entity, replacement), true);
  delete f.bot.entities[replacement.id]; assert.equal(f.threats.has(replacement), false);
  f.bot.entities[replacement.id] = replacement;
  assert.equal(f.threats.has(replacement), false, 'An observed unload clears even the previous object.');
});

test('evidence expires at 10 seconds and reads or unrelated hits cannot renew it', () => {
  const f = fixture(), source = f.spider(); f.threats.record(f.bot.entity, source);
  f.setTime(1000 + LOCAL_THREAT_TTL_MS - 1); assert.equal(f.threats.has(source), true);
  assert.equal(f.threats.record({ id: 88 }, source), false);
  assert.equal(f.threats.record(f.bot.entity, undefined), false);
  f.setTime(1000 + LOCAL_THREAT_TTL_MS); assert.equal(f.threats.has(source), false);
});

test('a later valid self-hit refreshes only that source', () => {
  const f = fixture(), a = f.spider(2), b = f.spider(3);
  f.threats.record(f.bot.entity, a); f.threats.record(f.bot.entity, b);
  f.setTime(6000); assert.equal(f.threats.record(f.bot.entity, a), true);
  f.setTime(11000); assert.equal(f.threats.has(a), true); assert.equal(f.threats.has(b), false);
  f.setTime(16000); assert.equal(f.threats.has(a), false);
});

test('clear supports lifecycle boundaries, and self death, respawn identity and dimension changes are fail-closed', () => {
  const f = fixture(), source = f.spider();
  for (const lifecycle of ['death', 'spawn', 'dimension', 'stop', 'dispose']) {
    assert.equal(f.threats.record(f.bot.entity, source), true);
    f.threats.clear(); f.threats.clear();
    assert.equal(f.threats.has(source), false, lifecycle);
  }
  f.threats.record(f.bot.entity, source); f.bot.health = 0;
  assert.equal(f.threats.has(source), false); assert.equal(f.threats.record(f.bot.entity, source), false);
  f.bot.health = 20; assert.equal(f.threats.has(source), false);
  f.threats.record(f.bot.entity, source); f.bot.entity = { ...f.bot.entity };
  assert.equal(f.threats.has(source), false);
  f.threats.record(f.bot.entity, source); f.bot.game.dimension = 'the_nether';
  assert.equal(f.threats.has(source), false);
});

test('memory is capped and refresh preserves the most recent actual attack evidence', () => {
  const f = fixture(), sources = Array.from({ length: MAX_LOCAL_THREATS }, (_, i) => f.spider(i + 2));
  for (const source of sources) assert.equal(f.threats.record(f.bot.entity, source), true);
  f.threats.record(f.bot.entity, sources[0]);
  const newest = f.spider(MAX_LOCAL_THREATS + 2); f.threats.record(f.bot.entity, newest);
  assert.equal(f.threats.has(sources[0]), true); assert.equal(f.threats.has(sources[1]), false);
  assert.equal(f.threats.has(newest), true);
  assert.equal(sources.filter(source => f.threats.has(source)).length + 1, MAX_LOCAL_THREATS);
});

test('uncertain perception and invalid clocks fail closed; the module installs no listeners or game inputs', () => {
  const f = fixture(), source = f.spider();
  const uncertain = createLocalThreats(f.bot, { isVisible: () => { throw new Error('unavailable'); } });
  assert.equal(uncertain.record(f.bot.entity, source), false);
  f.threats.record(f.bot.entity, source); f.setTime(999); assert.equal(f.threats.has(source), false);
  f.setTime(NaN); assert.equal(f.threats.record(f.bot.entity, source), false);
  assert.deepEqual(f.bot.eventNames(), []);
  assert.equal(f.bot._client, undefined); assert.equal(f.bot.setControlState, undefined);
});

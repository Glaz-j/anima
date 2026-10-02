import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { localPerception, LOCAL_PERCEPTION_BUDGET } from '../adapters/minecraft/src/local-perception.ts';
import { runNativeAction } from '../adapters/minecraft/src/native-actions.ts';

const cube = [[0, 0, 0, 1, 1, 1]];
const empty = (name = 'air') => ({ name, boundingBox: 'empty', shapes: [] });
const solid = (name = 'grass_block') => ({ name, boundingBox: 'block', shapes: cube });
const key = (p: Vec3) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

function fixture(resolve = (p: Vec3): any => p.y < 64 ? solid() : empty(), position = new Vec3(.5, 64, .5)) {
  const reads: Vec3[] = [], overrides = new Map<string, any>();
  const bot: any = {
    entity: { id: 1, position, eyeHeight: 1.62, height: 1.8, width: .6 }, entities: {},
    blockAt(p: Vec3) {
      reads.push(p.clone());
      const cell = p.floored(), block = overrides.has(key(cell)) ? overrides.get(key(cell)) : resolve(cell);
      return block ? { ...block, position: cell } : null;
    },
    inventory: { items: () => [{ name: 'crafting_table', count: 1 }] },
  };
  return { bot, reads, overrides };
}

test('a flat local observation distinguishes foot coordinates from empty placement cells', async () => {
  const { bot, overrides } = fixture();
  const terrain = localPerception(bot);
  assert.equal(terrain.scope, 'visible-loaded-local'); assert.equal(terrain.routeUnverified, true);
  assert.deepEqual(terrain.origin, [.5, 64, .5]);
  assert.equal(terrain.standable.length, 6); assert.equal(terrain.placeable.length, 6);
  assert.ok(terrain.standable.every(p => p.feet[1] === 64 && p.deltaY === 0 && p.support === 'grass_block'));
  assert.ok(terrain.placeable.every(p => p.target[1] === 64 && p.reference[1] === 63));
  assert.ok(terrain.placeable.every(p => !(p.target[0] === 0 && p.target[2] === 0)));
  // Exercise the real executor with one advertised target. A ground block's
  // y=63 would fail; the observed y=64 empty cell should be actionable.
  bot.equip = async (item: any) => { bot.heldItem = item; };
  bot.lookAt = async () => {};
  bot.world = { raycast: () => null };
  bot._placeBlockWithOptions = async (reference: any, face: Vec3) => {
    overrides.set(key(reference.position.plus(face)), solid('crafting_table'));
  };
  const [x, y, z] = terrain.placeable[0].target;
  await runNativeAction(bot, { type: 'place', item: 'crafting_table', x, y, z }, new AbortController().signal);
  assert.equal(bot.blockAt(new Vec3(x, y, z)).name, 'crafting_table');
});

test('visible one-block rises and two-block descents retain explicit ground height', () => {
  const { bot } = fixture(p => {
    const floor = p.x > 0 ? 64 : p.x < 0 ? 61 : 63;
    return p.y <= floor ? solid() : empty();
  });
  const terrain = localPerception(bot);
  assert.ok(terrain.standable.some(p => p.feet[0] === 1.5 && p.feet[1] === 65 && p.deltaY === 1));
  assert.ok(terrain.standable.some(p => p.feet[0] === -1.5 && p.feet[1] === 62 && p.deltaY === -2));
  assert.ok(!terrain.standable.some(p => p.feet[0] === -.5 && p.feet[1] === 62), 'the near cliff foot is hidden by its lip');
  assert.equal(terrain.routeUnverified, true, 'a landing cell is not a path or a movement guarantee');
});

test('loaded rooms and mineral surfaces behind a wall never leak into the summary', () => {
  const { bot } = fixture(p => {
    if (p.x === 1) return solid('stone');
    if (p.x > 1 && p.y < 64) return solid('diamond_ore');
    if (p.x > 1 && p.y === 64 && p.z === 0) return empty('lava');
    return p.y < 64 ? solid() : empty();
  });
  const terrain = localPerception(bot);
  assert.ok(terrain.standable.length > 0);
  assert.ok(!terrain.standable.some(p => p.feet[0] > 1));
  assert.ok(!terrain.placeable.some(p => p.target[0] > 1));
  assert.doesNotMatch(JSON.stringify(terrain), /diamond_ore|lava/);
});

test('an unloaded sight corridor is opaque even when the remote cells are loaded', () => {
  const { bot } = fixture(p => p.x === 1 ? null : p.y < 64 ? solid('stone') : empty());
  const terrain = localPerception(bot);
  assert.ok(terrain.standable.length > 0);
  assert.ok(terrain.standable.every(p => p.feet[0] < 1));
  assert.ok(terrain.placeable.every(p => p.target[0] < 1));
  const unavailable = fixture(() => null);
  assert.deepEqual(localPerception(unavailable.bot).standable, []);
  assert.deepEqual(localPerception(unavailable.bot).placeable, []);
});

test('feet/head clearance, hazardous landings and partial supports are not advertised as standing cells', () => {
  const { bot, overrides } = fixture();
  overrides.set('-1,65,0', solid('stone'));
  overrides.set('0,63,-1', solid('magma_block'));
  overrides.set('1,63,0', { ...solid('oak_slab'), shapes: [[0, 0, 0, 1, .5, 1]] });
  overrides.set('0,64,1', empty('water'));
  const terrain = localPerception(bot);
  const forbidden = new Set(['-0.5,64,0.5', '0.5,64,-0.5', '1.5,64,0.5', '0.5,64,1.5']);
  assert.ok(terrain.standable.every(p => !forbidden.has(p.feet.join(','))));
  assert.ok(terrain.hazards.some(p => p.name === 'magma_block'));
  assert.ok(terrain.hazards.some(p => p.name === 'water'));
});

test('placing excludes grass, the actor body and another player occupying an otherwise clear cell', () => {
  const { bot, overrides } = fixture();
  overrides.set('-1,64,0', empty('short_grass'));
  bot.entities[2] = { id: 2, name: 'player', position: new Vec3(1.5, 64, .5), width: .6, height: 1.8 };
  const terrain = localPerception(bot);
  const forbidden = new Set(['-1,64,0', '0,64,0', '0,65,0', '1,64,0', '1,65,0']);
  assert.ok(terrain.placeable.length > 0);
  assert.ok(terrain.placeable.every(p => !forbidden.has(p.target.join(','))));
  assert.ok(terrain.standable.some(p => p.feet.join(',') === '-0.5,64,0.5'), 'short grass can be walked through');
});

test('side placements expose only the actual native attachment face within reach', () => {
  const { bot, overrides } = fixture(p => p.y < 61 ? solid() : empty());
  overrides.set('0,63,0', solid('stone'));
  overrides.set('2,64,0', solid('stone'));
  const terrain = localPerception(bot);
  const candidate = terrain.placeable.find(p => p.target.join(',') === '1,64,0');
  assert.ok(candidate, 'an exposed side facing the observer can support a nearby placement');
  assert.deepEqual(candidate.reference, [2, 64, 0]);
  assert.deepEqual(candidate.face, [-1, 0, 0]);
});

test('perception stays within fixed read, output and radius budgets without invoking bot actions', () => {
  const position = new Vec3(29_999_990.5, 64, -29_999_990.5);
  const { bot, reads } = fixture(p => p.y < 64 ? solid('a'.repeat(100)) : empty(), position);
  for (const method of ['findBlocks', 'chat', 'dig', 'placeBlock', 'setControlState', 'lookAt', 'loadColumn']) {
    bot[method] = () => { throw new Error(`unexpected side effect: ${method}`); };
  }
  const terrain = localPerception(bot);
  assert.ok(terrain.standable.length <= 6 && terrain.placeable.length <= 6 && terrain.hazards.length <= 3);
  assert.ok(Buffer.byteLength(JSON.stringify(terrain), 'utf8') <= LOCAL_PERCEPTION_BUDGET.bytes);
  assert.ok(reads.length <= LOCAL_PERCEPTION_BUDGET.blockReads);
  const base = position.floored();
  for (const p of reads) {
    assert.ok(Math.abs(p.x - base.x) <= 4 && Math.abs(p.z - base.z) <= 4);
    assert.ok(p.y >= base.y - 4 && p.y <= base.y + 3);
  }
  for (const p of terrain.placeable) assert.ok(new Vec3(...p.target).distanceTo(position) <= 4.5);
  assert.deepEqual(localPerception({}).placeable, []);
});

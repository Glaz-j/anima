import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Vec3 } from 'vec3';
import registryFactory from 'prismarine-registry';
import blockFactory from 'prismarine-block';
import { PlayerState } from 'prismarine-physics';
import installPhysics from '../node_modules/mineflayer/lib/plugins/physics.js';
import { runBridgeSkill } from '../adapters/minecraft/src/bridge-skill.ts';
import { runContinuousSkill } from '../adapters/minecraft/src/continuous-skills.ts';

function fixture(t: any, options: { physics?: boolean; spend?: boolean; spendDelay?: number; direction?: number; denyPlacement?: boolean; jitter?: boolean } = {}) {
  const registry = registryFactory('1.21.4'), Block = blockFactory(registry), blocks = new Map<string, string>();
  const key = (p: Vec3) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  blocks.set('0,63,0', 'bedrock'); blocks.set(`${3 * (options.direction || 1)},63,0`, 'bedrock');
  const stack = { name: 'cobblestone', type: registry.itemsByName.cobblestone.id, count: 8 };
  const bot: any = Object.assign(new EventEmitter(), {
    version: '1.21.4', registry, supportFeature: registry.supportFeature,
    entity: { id: 1, name: 'player', position: new Vec3(.5, 64, .5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0,
      height: 1.8, width: .6, eyeHeight: 1.62, onGround: true, isInWater: false, isInLava: false, effects: {}, attributes: {} },
    entities: {}, health: 20, food: 20, game: { gameMode: 'survival' },
    _client: Object.assign(new EventEmitter(), { state: 'play' }), _syncWindow: async () => {}, controls: {},
  });
  bot._client.write = (name: string) => { if (name === 'client_command') queueMicrotask(() => bot._client.emit('statistics', { entries: [] })); };
  bot.inventory = Object.assign(new EventEmitter(), { slots: [], items: () => stack.count > 0 ? [stack] : [] });
  bot.blockAt = (p: Vec3) => { const position = p.floored(), b = Block.fromStateId(registry.blocksByName[blocks.get(key(p)) || 'air'].defaultState, 0); b.position = position; return b; };
  bot.world = { raycast: (origin: Vec3, direction: Vec3, distance: number) => {
    for (let along = .01; along < distance; along += .01) { const block = bot.blockAt(origin.plus(direction.scaled(along))); if (block.boundingBox === 'block') return block; }
    return null;
  } };
  bot.setControlState = (name: string, value: boolean) => { bot.controls[name] = value; };
  bot.clearControlStates = () => { bot.controls = {}; };
  bot.stopDigging = () => {}; bot.deactivateItem = () => {}; bot.lookAt = async () => {};
  bot.equip = async (item: any) => { bot.heldItem = item; };
  const placements: { reference: Vec3; face: Vec3; actor: Vec3; sneaking: boolean }[] = [];
  bot._placeBlockWithOptions = async (reference: any, face: Vec3) => {
    placements.push({ reference: reference.position.clone(), face: face.clone(), actor: bot.entity.position.clone(), sneaking: bot.controlState?.sneak ?? bot.controls.sneak });
    if (!options.denyPlacement) blocks.set(key(reference.position.plus(face)), 'cobblestone');
    if (options.spend !== false) {
      if (options.spendDelay) setTimeout(() => { stack.count -= 1; }, options.spendDelay);
      else stack.count -= 1;
    }
  };
  if (options.physics) {
    installPhysics(bot, { physicsEnabled: true });
    let tick = 0;
    const timer = setInterval(() => {
      const frames = options.jitter ? [1, 2, 1, 3][tick++ % 4] : 1;
      for (let i = 0; i < frames; i++) { bot.physics.simulatePlayer(new PlayerState(bot, bot.controlState), { getBlock: bot.blockAt }).apply(bot); bot.emit('physicsTick'); }
    }, 50);
    t.after(() => { clearInterval(timer); bot.emit('end'); });
  }
  return { bot, blocks, stack, placements };
}
const signal = () => new AbortController().signal;

for (const direction of [1, -1]) test(`bridge crouches beyond a real side face and crosses two blocks with vanilla physics (${direction})`, async t => {
  const { bot, placements, stack } = fixture(t, { physics: true, direction });
  const result = await runBridgeSkill(bot, { type: 'bridge', x: .5 + 2 * direction, z: .5, maxBlocks: 2 }, signal());
  assert.equal(result.reached, true); assert.equal(result.placed, 2); assert.equal(result.spent, 2); assert.equal(stack.count, 6);
  assert.ok(Math.abs(bot.entity.position.x - (.5 + 2 * direction)) <= .16); assert.equal(bot.entity.position.y, 64); assert.equal(bot.entity.onGround, true);
  assert.equal(placements.length, 2);
  for (const [i, placement] of placements.entries()) {
    const faceX = placement.reference.x + .5 + placement.face.x * .5;
    assert.ok((placement.actor.x - faceX) * placement.face.x > 0, 'Eye must be on the visible side, not above the hidden top edge.');
    const currentSupportEdge = i * direction + (direction > 0 ? 1 : 0);
    assert.ok((placement.actor.x - currentSupportEdge) * direction < .25, 'Body must retain overlap with its current support.');
    assert.equal(placement.sneaking, true);
  }
  assert.equal(bot.controlState.forward, false); assert.equal(bot.controlState.sneak, false);
  assert.equal(bot.listenerCount('physicsTick'), 0);
});
test('physics catch-up frames cannot run the crouching body beyond the supporting edge', async t => {
  const { bot, placements } = fixture(t, { physics: true, jitter: true });
  const result = await runBridgeSkill(bot, { type: 'bridge', x: 2.5, z: .5, maxBlocks: 2 }, signal());
  assert.equal(result.reached, true); assert.equal(bot.entity.position.y, 64);
  assert.ok(placements.every((placement, i) => placement.actor.x > i + 1 && placement.actor.x < i + 1.25));
});

test('bridge refuses unbounded targets, unapproved materials and unsupported starts before inputs', async t => {
  const { bot, placements } = fixture(t);
  await assert.rejects(runBridgeSkill(bot, { type: 'bridge', x: 13.5, z: .5 }, signal()), /12 格/u);
  await assert.rejects(runBridgeSkill(bot, { type: 'bridge', x: 1.5, z: .5, item: 'sand' }, signal()), /重力方块/u);
  await assert.rejects(runBridgeSkill(bot, { type: 'bridge', x: 1.5, z: .5, maxBlocks: 13 }, signal()), /预算/u);
  bot.entity.onGround = false;
  await assert.rejects(runBridgeSkill(bot, { type: 'bridge', x: 1.5, z: .5 }, signal()), /支撑/u);
  assert.equal(placements.length, 0); assert.deepEqual(bot.controls, {});
});

test('cancel while aiming drains the aim and never sends late movement or placement', async t => {
  const { bot, placements } = fixture(t); let release!: () => void;
  bot.lookAt = () => new Promise<void>(resolve => { release = resolve; });
  const controller = new AbortController(); let settled = false;
  const operation = runBridgeSkill(bot, { type: 'bridge', x: 1.5, z: .5 }, controller.signal).finally(() => { settled = true; });
  const rejected = assert.rejects(operation, /取消/u);
  await delay(0); controller.abort(); await delay(0); assert.equal(settled, false); assert.deepEqual(bot.controls, {});
  release(); await rejected; assert.equal(placements.length, 0); assert.deepEqual(bot.controls, {});
  assert.equal(bot.listenerCount('physicsTick'), 0); assert.equal(bot.listenerCount('death'), 0);
});

test('material budget stops at a real partial bridge instead of inventing free blocks', async t => {
  const { bot, placements, stack } = fixture(t, { physics: true });
  await assert.rejects(runBridgeSkill(bot, { type: 'bridge', x: 2.5, z: .5, maxBlocks: 1 }, signal()), (error: any) => {
    assert.equal(error.details.placed, 1); assert.equal(error.details.spent, 1); assert.equal(error.details.partial, true); return /预算/u.test(error.message);
  });
  assert.equal(placements.length, 1); assert.equal(stack.count, 7); assert.equal(bot.entity.onGround, true);
});

test('a visible new block without confirmed item consumption cannot report bridge success', async t => {
  const { bot, placements } = fixture(t, { physics: true, spend: false });
  await assert.rejects(runBridgeSkill(bot, { type: 'bridge', x: 1.5, z: .5 }, signal()), /库存消耗/u);
  assert.equal(placements.length, 1); assert.ok(bot.entity.position.x < 1.3, 'Do not walk onto unconfirmed placement.');
});

test('server denial cannot report placement success or move onto the still empty gap', async t => {
  const { bot, placements } = fixture(t, { physics: true, denyPlacement: true });
  await assert.rejects(runBridgeSkill(bot, { type: 'bridge', x: 1.5, z: .5 }, signal()), /确认放置结果/u);
  assert.equal(placements.length, 1); assert.ok(bot.entity.position.x < 1.3);
});

test('continuous dispatch can resume a genuinely supported overhang and waits for delayed inventory broadcast', async t => {
  const { bot, stack, placements } = fixture(t, { physics: true, spendDelay: 150 });
  bot.entity.position = new Vec3(1.15, 64, .5); // Initial interrupted pose, not a skill position write.
  const result = await runContinuousSkill(bot, { type: 'bridge', x: 1.5, z: .5, maxBlocks: 1 }, signal());
  assert.equal(result.reached, true); assert.equal(result.inventoryConfirmed, true); assert.equal(result.spent, 1);
  assert.equal(stack.count, 7); assert.equal(placements.length, 1); assert.equal(bot.entity.position.y, 64);
});

test('cancel after placement drains delayed consumption before returning the partial receipt', async t => {
  const { bot, stack, placements } = fixture(t, { physics: true, spendDelay: 150 });
  const respawnListeners = bot.listenerCount('respawn'), kickedListeners = bot.listenerCount('kicked');
  const controller = new AbortController(), original = bot._placeBlockWithOptions;
  bot._placeBlockWithOptions = async (...args: any[]) => { await original(...args); controller.abort(); };
  await assert.rejects(runContinuousSkill(bot, { type: 'bridge', x: 2.5, z: .5, maxBlocks: 2 }, controller.signal), (error: any) => {
    assert.equal(error.details.spent, 1); assert.equal(error.details.placed, 1); assert.equal(error.details.inventoryConfirmed, true);
    assert.equal(error.details.reached, false); assert.equal(error.details.partial, true); return true;
  });
  assert.equal(stack.count, 7); assert.equal(placements.length, 1); assert.equal(bot.controlState.forward, false);
  assert.equal(bot.listenerCount('respawn'), respawnListeners); assert.equal(bot.listenerCount('kicked'), kickedListeners);
});

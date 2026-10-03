import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Vec3 } from 'vec3';
import registryFactory from 'prismarine-registry';
import blockFactory from 'prismarine-block';
import { PlayerState } from 'prismarine-physics';
import installPhysics from '../node_modules/mineflayer/lib/plugins/physics.js';
import { findSafeFood, meleeCooldownMs, runContinuousSkill } from '../adapters/minecraft/src/continuous-skills.ts';

function fixture() {
  const registry = registryFactory('1.21.4'), Block = blockFactory(registry);
  const bot: any = Object.assign(new EventEmitter(), {
    version: '1.21.4', registry, supportFeature: registry.supportFeature,
    entity: { id: 1, name: 'player', position: new Vec3(.5, 64, .5), velocity: new Vec3(0, 0, 0),
      yaw: 0, pitch: 0, height: 1.8, width: .6, eyeHeight: 1.62, onGround: true, isInWater: false, isInLava: false, effects: {}, attributes: {} },
    entities: {}, health: 20, food: 12, game: { gameMode: 'survival' },
    _client: Object.assign(new EventEmitter(), { state: 'play' }), _syncWindow: async () => {},
    controls: {}, attacks: [] as number[], looks: [] as Vec3[], items: [] as any[],
  });
  bot._client.write = (name: string) => { if (name === 'client_command') queueMicrotask(() => bot._client.emit('statistics', { entries: [] })); };
  bot.inventory = Object.assign(new EventEmitter(), { slots: [], items: () => bot.items.filter((i: any) => i.count > 0) });
  bot.world = { raycast: () => null };
  bot.blockAt = (p: Vec3) => {
    const b = Block.fromStateId(registry.blocksByName[p.y < 64 ? 'stone' : 'air'].defaultState, 0); b.position = p.floored(); return b;
  };
  bot.setControlState = (key: string, value: boolean) => { bot.controls[key] = value; if (key === 'jump' && value) bot.jumpQueued = true; };
  bot.clearControlStates = () => { bot.controls = {}; };
  bot.stopDigging = () => {};
  bot.lookAt = async (p: Vec3) => { bot.looks.push(p.clone()); };
  bot.canSeeBlock = () => true;
  bot.attack = (e: any) => { bot.attacks.push(e.id); };
  bot.equip = async (item: any) => { bot.heldItem = item; };
  bot.deactivateItem = () => { bot.usingHeldItem = false; };
  return { bot, registry, Block };
}
function enemy(bot: any, p = new Vec3(.5, 64, 2.5)) {
  return bot.entities[10] = { id: 10, name: 'zombie', position: p, width: .6, height: 1.8, health: 20 };
}
const signal = () => new AbortController().signal;

test('combat tracks at a fast cadence while respecting held weapon cooldown across skill slices', async () => {
  const { bot } = fixture(); enemy(bot); bot.heldItem = { name: 'iron_sword' };
  const result = await runContinuousSkill(bot, { type: 'combat', entityId: 10, durationMs: 210 }, signal());
  assert.ok(result.controlTicks >= 3); assert.ok(bot.looks.length >= 3);
  assert.equal(bot.attacks.length, 1); assert.equal(result.attempts, 1);
  assert.equal(result.killConfirmed, false);
  await runContinuousSkill(bot, { type: 'combat', entityId: 10, durationMs: 150 }, signal());
  assert.equal(bot.attacks.length, 1, 'Restarting a skill must not reset melee charge.');
  assert.equal(bot.jumpQueued, false); assert.deepEqual(bot.controls, {});
  assert.equal(meleeCooldownMs('wooden_axe'), 1250); assert.equal(meleeCooldownMs('iron_sword'), 625);
});

test('combat target disappearance is an observation, never invented kill evidence', async () => {
  const { bot } = fixture(); enemy(bot);
  bot.attack = () => { delete bot.entities[10]; };
  const result = await runContinuousSkill(bot, { type: 'combat', entityId: 10, durationMs: 200 }, signal());
  assert.equal(result.attempts, 1); assert.equal(result.targetLoaded, false);
  assert.equal(result.killConfirmed, false); assert.equal(result.stoppedReason, 'target_unavailable');
});

test('combat refuses hidden or out-of-policy targets before writing attacks', async () => {
  const { bot } = fixture(); enemy(bot, new Vec3(.5, 64, 8));
  await assert.rejects(runContinuousSkill(bot, { type: 'combat', entityId: 10, durationMs: 100, maxDistance: 4 }, signal()), /授权/);
  bot.world.raycast = () => ({ position: new Vec3(0, 64, 1) });
  await assert.rejects(runContinuousSkill(bot, { type: 'combat', entityId: 10, durationMs: 100 }, signal()), /可见/);
  assert.deepEqual(bot.attacks, []); assert.deepEqual(bot.controls, {});
});

test('cancellation clears controls immediately, drains pending aim and cannot send a late strike', async () => {
  const { bot } = fixture(); enemy(bot);
  let resolveLook!: () => void, settled = false;
  bot.lookAt = () => new Promise<void>(resolve => { resolveLook = resolve; });
  const controller = new AbortController(); bot.controls.forward = true;
  const task = runContinuousSkill(bot, { type: 'combat', entityId: 10, durationMs: 1000 }, controller.signal).finally(() => { settled = true; });
  const rejected = assert.rejects(task, /取消/);
  await delay(0); controller.abort(); await delay(0);
  assert.deepEqual(bot.controls, {}); assert.equal(settled, false); assert.deepEqual(bot.attacks, []);
  resolveLook(); await rejected; assert.deepEqual(bot.attacks, []);
  assert.equal(bot.listenerCount('death'), 0); assert.equal(bot.listenerCount('end'), 0);
});

test('retreat refuses a cliff and does not manufacture movement', async () => {
  const { bot, registry, Block } = fixture(); enemy(bot, new Vec3(.5, 64, 2));
  const start = bot.entity.position.clone();
  bot.blockAt = (p: Vec3) => { const b = Block.fromStateId(registry.blocksByName.air.defaultState, 0); b.position = p.floored(); return b; };
  await assert.rejects(runContinuousSkill(bot, { type: 'retreat', entityId: 10, durationMs: 100 }, signal()), /落脚点/);
  assert.ok(bot.entity.position.equals(start)); assert.deepEqual(bot.controls, {});
});

test('retreat reports exhausted authorization as failure instead of a completed zero-motion skill', async () => {
  const { bot } = fixture(); enemy(bot, new Vec3(.5, 64, 2));
  const origin = { x: .5, y: 64, z: .5 };
  bot.entity.position = new Vec3(.5, 64, -7);
  await assert.rejects(runContinuousSkill(bot, { type: 'retreat', entityId: 10, origin, maxDistance: 8, durationMs: 100 }, signal()), (error: any) => {
    assert.equal(error.details.stoppedReason, 'distance_limit'); assert.equal(error.details.authorizationExhausted, true);
    assert.equal(error.details.maxDistance, 8); assert.deepEqual(error.details.origin, origin); return true;
  });
  assert.deepEqual(bot.controls, {}); assert.deepEqual(bot.looks, []);
});

test('pickup respects an internal fixed gathering origin instead of granting a fresh local radius', async () => {
  const { bot } = fixture(); bot.entity.position = new Vec3(23, 64, 0);
  bot.entities[50] = { id: 50, name: 'item', position: new Vec3(26, 64, 0), width: .25, height: .25 };
  await assert.rejects(runContinuousSkill(bot, { type: 'pickup', entityId: 50, durationMs: 100,
    maxDistance: 4, origin: { x: 20, y: 64, z: 0 } }, signal()), (error: any) => error.details.stoppedReason === 'pickup_unavailable');
  assert.deepEqual(bot.looks, []); assert.deepEqual(bot.controls, {});
});

test('pickup rejects grounded landing positions outside the original area even when the floating item is inside', async () => {
  const { bot, Block, registry } = fixture(); bot.entity.position = new Vec3(20, 64, 0);
  bot.entities[50] = { id: 50, name: 'item', position: new Vec3(23.9, 64.1, 0), width: .25, height: .25 };
  bot.blockAt = (p: Vec3) => { const b = Block.fromStateId(registry.blocksByName[p.y < 63 ? 'stone' : 'air'].defaultState, 0); b.position = p.floored(); return b; };
  await assert.rejects(runContinuousSkill(bot, { type: 'pickup', entityId: 50, durationMs: 70,
    maxDistance: 4, origin: { x: 20, y: 64, z: 0 } }, signal()), /abort|取消/iu);
  assert.deepEqual(bot.looks, []); assert.deepEqual(bot.controls, {});
  assert.equal(bot.listenerCount('physicsTick'), 0); assert.equal(bot.listenerCount('move'), 0);
});

test('pickup drains aiming and removes boundary listeners when physical displacement crosses its original area', async () => {
  const { bot } = fixture(); bot.entity.position = new Vec3(20, 64, 0);
  bot.entities[50] = { id: 50, name: 'item', position: new Vec3(23, 64, 0), width: .25, height: .25 };
  let finishAim!: () => void; bot.lookAt = () => new Promise<void>(resolve => { finishAim = resolve; });
  const task = runContinuousSkill(bot, { type: 'pickup', entityId: 50, durationMs: 1000,
    maxDistance: 4, origin: { x: 20, y: 64, z: 0 } }, signal());
  const rejected = assert.rejects(task, (error: any) => error.details.stoppedReason === 'distance_limit');
  await delay(0); bot.entity.position = new Vec3(25, 64, 0); bot.emit('move');
  finishAim(); await rejected;
  assert.deepEqual(bot.controls, {}); assert.equal(bot.listenerCount('physicsTick'), 0); assert.equal(bot.listenerCount('move'), 0);
});

test('surface uses real water contact and distinguishes surface air from confirmed breathing or shore arrival', async () => {
  const { bot, registry, Block } = fixture();
  bot.entity.isInWater = true; bot.entity.onGround = false;
  bot.blockAt = (p: Vec3) => { const b = Block.fromStateId(registry.blocksByName[p.y < 65 ? 'water' : 'air'].defaultState, 0); b.position = p.floored(); return b; };
  const result = await runContinuousSkill(bot, { type: 'surface', durationMs: 100 }, signal());
  assert.equal(result.surfaceReached, true); assert.equal(result.airSpaceObserved, true);
  assert.equal(result.breathingConfirmed, false); assert.equal(result.shoreReached, false);
  assert.equal(bot.health, 20); assert.equal(bot.jumpQueued, false);
});

test('surface with a target cannot claim success when its deadline expires underwater', async () => {
  const { bot, registry, Block } = fixture(); bot.entity.isInWater = true; bot.entity.onGround = false;
  bot.blockAt = (p: Vec3) => {
    const target = Math.floor(p.z) === 2;
    const name = target ? p.y < 65 ? 'stone' : 'air' : p.y < 68 ? 'water' : 'air';
    const b = Block.fromStateId(registry.blocksByName[name].defaultState, 0); b.position = p.floored(); return b;
  };
  await assert.rejects(runContinuousSkill(bot, { type: 'surface', target: { x: .5, y: 65, z: 2.5 }, durationMs: 100 }, signal()), /岸点/);
  assert.deepEqual(bot.controls, {}); assert.equal(bot.jumpQueued, false);
});

test('eat chooses a real safe food and waits for native use plus item and hunger confirmation', async () => {
  const { bot } = fixture(); bot.items = [{ name: 'rotten_flesh', count: 8 }, { name: 'bread', count: 2 }];
  assert.equal(findSafeFood(bot)?.name, 'bread');
  bot.consume = async () => {
    bot.usingHeldItem = true;
    bot._client.emit('entity_status', { entityId: 1, entityStatus: 9 });
    bot.heldItem.count--; bot.inventory.emit('updateSlot');
    bot.food = 17; bot._client.emit('update_health', { health: 20, food: 17 });
  };
  const result = await runContinuousSkill(bot, { type: 'eat' }, signal());
  assert.equal(result.item, 'bread'); assert.equal(result.consumptionConfirmed, true);
  assert.deepEqual(result.inventoryDelta, [{ item: 'bread', change: -1 }]);
  assert.equal(bot.food, 17); assert.equal(bot.health, 20);
});

test('eat never silently falls back to harmful food', async () => {
  const { bot } = fixture(); bot.items = [{ name: 'rotten_flesh', count: 8 }];
  assert.equal(findSafeFood(bot), undefined);
  await assert.rejects(runContinuousSkill(bot, { type: 'eat' }, signal()), /安全食物/);
  assert.equal(bot.heldItem, undefined);
});

test('jump rejects unsupported, hidden, distant or obstructed platforms before moving', async () => {
  const { bot } = fixture();
  await assert.rejects(runContinuousSkill(bot, { type: 'jump_to', x: .5, y: 64, z: 5.5 }, signal()), /3.6/);
  bot.canSeeBlock = () => false;
  await assert.rejects(runContinuousSkill(bot, { type: 'jump_to', x: .5, y: 64, z: 2.5 }, signal()), /可见/);
  assert.deepEqual(bot.controls, {}); assert.equal(bot.jumpQueued, false);
});

test('jump really crosses a gap using the installed Minecraft physics and confirms a stable landing', async t => {
  const { bot, registry, Block } = fixture();
  bot.blockAt = (p: Vec3) => {
    const z = Math.floor(p.z), platform = z <= 0 || z >= 3;
    const name = platform && p.y < 64 ? 'stone' : 'air';
    const b = Block.fromStateId(registry.blocksByName[name].defaultState, 0); b.position = p.floored(); return b;
  };
  installPhysics(bot, { physicsEnabled: true });
  const actualInputs: { key: string; value: boolean }[] = [], write = bot.setControlState;
  bot.setControlState = (key: string, value: boolean) => { actualInputs.push({ key, value }); write(key, value); };
  const timer = setInterval(() => {
    bot.physics.simulatePlayer(new PlayerState(bot, bot.controlState), { getBlock: bot.blockAt }).apply(bot);
    bot.emit('physicsTick');
  }, 50);
  t.after(() => { clearInterval(timer); bot.emit('end'); });
  const result = await runContinuousSkill(bot, { type: 'jump_to', x: .5, y: 64, z: 3.5, durationMs: 2500 }, signal());
  assert.equal(result.tookOff, true); assert.equal(result.landed, true); assert.equal(result.reached, true);
  assert.ok(Math.abs(bot.entity.position.z - 3.5) <= .55);
  assert.ok(actualInputs.some(input => input.key === 'jump' && input.value));
  assert.ok(actualInputs.some(input => input.key === 'forward' && input.value));
  assert.equal(bot.entity.onGround, true); assert.equal(bot.jumpQueued, false);
});

test('a jump without physics progress fails instead of claiming teleportation or arrival', async () => {
  const { bot } = fixture(); const before = bot.entity.position.clone();
  await assert.rejects(runContinuousSkill(bot, { type: 'jump_to', x: .5, y: 64, z: 2.5, durationMs: 100 }, signal()));
  assert.ok(bot.entity.position.equals(before)); assert.equal(bot.jumpQueued, false);
});

function physicsClock(t: any, bot: any, jitter = false) {
  installPhysics(bot, { physicsEnabled: true });
  let timer: ReturnType<typeof setTimeout>, stopped = false, index = 0;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      // Mineflayer catches up multiple physics frames synchronously after a
      // stalled Windows timer; the controller must react between these frames.
      const frames = jitter ? [1, 2, 1, 3, 1][index % 5] : 1;
      for (let i = 0; i < frames; i++) {
        bot.physics.simulatePlayer(new PlayerState(bot, bot.controlState), { getBlock: bot.blockAt }).apply(bot);
        bot.emit('physicsTick');
      }
      index++; schedule();
    }, jitter ? [62, 104, 58, 155, 42][index % 5] : 50);
  };
  schedule();
  t.after(() => { stopped = true; clearTimeout(timer); bot.emit('end'); });
}

for (const ceiling of [67, 68]) {
  test(`jump climbs a one-block step beneath ceiling y=${ceiling} using actual collision physics`, async t => {
    const { bot, registry, Block } = fixture();
    bot.blockAt = (p: Vec3) => {
      const cell = p.floored();
      const solid = cell.y < 64 || (cell.x >= 1 && cell.y === 64) || cell.y >= ceiling;
      const b = Block.fromStateId(registry.blocksByName[solid ? 'stone' : 'air'].defaultState, 0);
      b.position = cell; return b;
    };
    physicsClock(t, bot);
    let touchedCeiling = false, maxY = bot.entity.position.y;
    bot.on('physicsTick', () => {
      maxY = Math.max(maxY, bot.entity.position.y);
      if (!bot.entity.onGround && bot.entity.isCollidedVertically
        && Math.abs(bot.entity.position.y + bot.entity.height - ceiling) < .001) touchedCeiling = true;
    });
    // Two air blocks above the raised floor suffice. A fabricated parabola
    // reaches y=65.75 halfway across and incorrectly intersects ceiling y=67.
    const result = await runContinuousSkill(bot, { type: 'jump_to', x: 1.5, y: 65, z: .5, durationMs: 2500 }, signal());
    assert.equal(result.tookOff, true); assert.equal(result.landed, true); assert.equal(result.reached, true);
    assert.equal(bot.entity.onGround, true); assert.ok(Math.abs(bot.entity.position.y - 65) <= .01);
    assert.ok(Math.abs(bot.entity.position.x - 1.5) <= .55);
    assert.ok(Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) <= .04);
    assert.ok(maxY <= ceiling - bot.entity.height + .001);
    if (ceiling === 67) assert.equal(touchedCeiling, true, 'The real jump clips against the ceiling and still lands.');
    assert.equal(bot.jumpQueued, false);
  });
}

for (const barrier of ['stone', 'fire', 'unloaded']) {
  test(`jump physics rejects an intermediate ${barrier} barrier before issuing motion`, async t => {
    const { bot, registry, Block } = fixture();
    bot.blockAt = (p: Vec3) => {
      const cell = p.floored(), blocked = cell.z === 1 && cell.y >= 64;
      if (blocked && barrier === 'unloaded') return null;
      const name = cell.y < 64 ? 'stone' : blocked ? barrier : 'air';
      const b = Block.fromStateId(registry.blocksByName[name].defaultState, 0);
      b.position = cell; return b;
    };
    installPhysics(bot, { physicsEnabled: true }); t.after(() => bot.emit('end'));
    const inputs: { key: string; value: boolean }[] = [], write = bot.setControlState;
    bot.setControlState = (key: string, value: boolean) => { inputs.push({ key, value }); write(key, value); };
    const origin = bot.entity.position.clone();
    // The target itself is supported and clear. The cloned real physics must
    // reject the intermediate path, including non-solid fire and missing data.
    await assert.rejects(runContinuousSkill(bot, { type: 'jump_to', x: .5, y: 64, z: 3.5 }, signal()),
      (error: any) => error.details?.stoppedReason === 'jump_no_trajectory');
    assert.equal(inputs.some(input => input.value), false);
    assert.ok(bot.entity.position.equals(origin)); assert.equal(bot.jumpQueued, false);
    assert.equal(bot.listenerCount('physicsTick'), 0);
  });
}

test('jump rejects a one-block step whose destination has insufficient headroom', async t => {
  const { bot, registry, Block } = fixture();
  bot.blockAt = (p: Vec3) => {
    const cell = p.floored(), solid = cell.y < 64 || (cell.x >= 1 && (cell.y === 64 || cell.y >= 66));
    const b = Block.fromStateId(registry.blocksByName[solid ? 'stone' : 'air'].defaultState, 0);
    b.position = cell; return b;
  };
  installPhysics(bot, { physicsEnabled: true }); t.after(() => bot.emit('end'));
  await assert.rejects(runContinuousSkill(bot, { type: 'jump_to', x: 1.5, y: 65, z: .5 }, signal()),
    (error: any) => error.details?.stoppedReason === 'landing_unavailable');
  assert.equal(bot.jumpQueued, false); assert.ok(Object.values(bot.controlState).every(value => !value));
});

for (const start of [.5, 3.0712913947914795]) {
  test(`jump crosses consecutive one-block platforms from x=${start} despite tick jitter and catch-up`, async t => {
    const { bot, registry, Block } = fixture(); bot.entity.position.x = start;
    bot.blockAt = (p: Vec3) => {
      const x = Math.floor(p.x), z = Math.floor(p.z), platform = z === 0 && (x <= 0 || [3, 6, 9].includes(x));
      const name = platform && p.y < 64 ? 'stone' : 'air';
      const b = Block.fromStateId(registry.blocksByName[name].defaultState, 0); b.position = p.floored(); return b;
    };
    physicsClock(t, bot, true);
    for (const x of start < 1 ? [3.5, 6.5, 9.5] : [6.5, 9.5]) {
      const result = await runContinuousSkill(bot, { type: 'jump_to', x, y: 64, z: .5, durationMs: 5000 }, signal());
      assert.equal(result.reached, true); assert.equal(result.landed, true);
      assert.ok(Math.abs(bot.entity.position.x - x) <= .35, `stable position ${bot.entity.position.x} near ${x}`);
      assert.equal(bot.entity.onGround, true); assert.equal(bot.listenerCount('physicsTick'), 0);
      assert.ok(Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) < .04);
    }
  });
}

test('surfacing starts beneath an occluded shore and reaches it through real water physics', async t => {
  const { bot, registry, Block } = fixture();
  bot.entity.position = new Vec3(.5, 61, .5); bot.entity.isInWater = true; bot.entity.onGround = false;
  bot.blockAt = (p: Vec3) => {
    const shore = Math.floor(p.x) >= 4;
    const name = p.y < 61 || (shore && p.y < 63) ? 'stone' : p.y < 63 ? 'water' : 'air';
    const b = Block.fromStateId(registry.blocksByName[name].defaultState, 0); b.position = p.floored(); return b;
  };
  bot.canSeeBlock = () => bot.entity.position.y + 1.62 >= 63.1;
  physicsClock(t, bot, true);
  let upwardWhileHidden = false;
  const write = bot.setControlState;
  bot.setControlState = (key: string, value: boolean) => {
    if (key === 'jump' && value && !bot.canSeeBlock()) upwardWhileHidden = true;
    write(key, value);
  };
  const result = await runContinuousSkill(bot, { type: 'surface', target: { x: 4.5, y: 63, z: .5 }, durationMs: 10000 }, signal());
  assert.equal(upwardWhileHidden, true); assert.equal(result.shoreReached, true); assert.equal(result.dryGround, true);
  assert.equal(bot.entity.onGround, true); assert.equal(bot.entity.isInWater, false);
  assert.ok(Math.abs(bot.entity.position.y - 63) <= .2);
});

test('surface can see a bank top behind an occluding rim and walks the remaining distance after climbing out', async t => {
  const { bot, registry, Block } = fixture();
  bot.entity.position = new Vec3(.5, 61, .5); bot.entity.isInWater = true; bot.entity.onGround = false;
  bot.blockAt = (p: Vec3) => {
    const x = Math.floor(p.x), z = Math.floor(p.z), pool = x >= -2 && x <= 2 && z >= -2 && z <= 2;
    const name = p.y < 61 ? 'stone' : p.y < 64 ? pool ? 'water' : 'stone' : 'air';
    const b = Block.fromStateId(registry.blocksByName[name].defaultState, 0); b.position = p.floored(); return b;
  };
  // The block-centre API does not see the floor block behind the rim. A real
  // unobstructed ray to its TOP surface is necessary once our eyes clear water.
  bot.canSeeBlock = () => false;
  bot.world.raycast = (origin: Vec3, direction: Vec3, distance: number) => {
    for (let d = .02; d < distance; d += .04) {
      const b = bot.blockAt(origin.plus(direction.scaled(d)));
      if (b.boundingBox === 'block') return { position: b.position };
    }
    return null;
  };
  physicsClock(t, bot, true);
  const result = await runContinuousSkill(bot, { type: 'surface', target: { x: 4.5, y: 64, z: .5 }, durationMs: 10000 }, signal());
  assert.equal(result.shoreReached, true); assert.equal(result.dryGround, true);
  assert.equal(bot.entity.onGround, true); assert.equal(bot.entity.isInWater, false);
  assert.ok(bot.entity.position.distanceTo(new Vec3(4.5, 64, .5)) <= .8);
});

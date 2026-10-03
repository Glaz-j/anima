import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import minecraftData from 'minecraft-data';
import loadBlock from 'prismarine-block';
import { Vec3 } from 'vec3';
import { APPROACH_LIMITS, approachTarget, travelToArea } from '../adapters/minecraft/src/approach.ts';
import { nativeWalkTo } from '../adapters/minecraft/src/native-actions.ts';

const registry = minecraftData('1.21.4'), Block = loadBlock(registry);
// Actual installed Movements, Move and AStar are exercised in every test. This
// fixture supplies loaded collision geometry and a small native motor simulator.
function fixture(resolve: (cell: Vec3) => string | null) {
  const reads: Vec3[] = [], steps: Vec3[] = [], controls: Record<string, boolean> = {};
  const bot: any = { registry, game: { minY: -64 }, entities: {}, controls,
    entity: { position: new Vec3(.5, 64, .5), eyeHeight: 1.62, width: .6, height: 1.8,
      onGround: true, velocity: new Vec3(0, 0, 0) },
    blockAt(p: Vec3) {
      const cell = p.floored(); reads.push(cell);
      const name = resolve(cell); if (!name) return null;
      const block = Block.fromStateId(registry.blocksByName[name].defaultState, 0); block.position = cell; return block;
    }, canSeeBlock: () => true,
    clearControlStates() { for (const key of Object.keys(controls)) delete controls[key]; }, stopDigging() {},
  };
  for (const name of ['dig', 'placeBlock', 'chat', 'loadPlugin']) bot[name] = () => assert.fail(`Forbidden ${name}`);
  Object.defineProperty(bot, 'pathfinder', { get: () => assert.fail('The plugin must never own control.') });
  let aim = bot.entity.position.clone();
  bot.lookAt = async (point: Vec3) => { aim = point.clone(); };
  const bodyClear = (p: Vec3) => {
    for (let x = Math.floor(p.x - .299); x <= Math.floor(p.x + .299); x++)
      for (let z = Math.floor(p.z - .299); z <= Math.floor(p.z + .299); z++)
        for (let y = Math.floor(p.y); y <= Math.floor(p.y + 1.799); y++)
          if (bot.blockAt(new Vec3(x, y, z))?.boundingBox !== 'empty') return false;
    return true;
  };
  bot.setControlState = (name: string, value: boolean) => {
    controls[name] = value; if (name !== 'forward' || !value) return;
    const before = bot.entity.position, dx = aim.x - before.x, dz = aim.z - before.z, distance = Math.hypot(dx, dz);
    const n = Math.min(.2, distance); if (n < 1e-6) return;
    const next = before.offset(dx / distance * n, 0, dz / distance * n);
    for (const dy of [0, 1, -1, -2, -3]) {
      if (dy === 1 && !controls.jump) continue;
      const p = new Vec3(next.x, Math.floor(before.y) + dy, next.z);
      const supported = [-.299, .299].some(x => [-.299, .299].some(z => bot.blockAt(p.offset(x, -1, z))?.boundingBox === 'block'));
      if (bodyClear(p) && supported) {
        bot.entity.position = p; steps.push(p.clone()); return;
      }
    }
  };
  return { bot, reads, steps };
}
const controls = { moveTo: nativeWalkTo, entityVisible: () => true };
const proposal = (position: Vec3) => ({ type: 'approach', position: { ...position } });
const openFloor = (p: Vec3) => p.y < 64 ? 'stone' : 'air';
function entity(bot: any, p = new Vec3(10.5, 64, .5)) {
  return bot.entities[7] = { id: 7, name: 'cow', width: .9, height: 1.4, position: p };
}

test('real planner approaches overhead wood from a distant supported ledge, without adjacent standing cells', async () => {
  const target = new Vec3(8, 68, 0);
  const { bot, steps } = fixture(p => p.equals(target) ? 'oak_log'
    : p.x <= 5 && Math.abs(p.z) <= 2 && p.y < (p.x >= 3 ? 65 : 64) ? 'stone' : 'air');
  const result = await approachTarget(bot, proposal(target), new AbortController().signal, controls);
  assert.equal(result.reached, true); assert.equal(result.target.name, 'oak_log');
  assert.ok(result.distance <= 4.5); assert.ok(bot.entity.position.x <= 5.6);
  assert.equal(bot.entity.position.y, 65, 'The native body must actually ascend the full-block step.');
  assert.ok(steps.some(p => p.y === 65)); assert.ok(result.planning.legs > 0);
  assert.equal(result.planning.version, '2.4.5'); assert.deepEqual(bot.controls, {});
  assert.ok(result.planning.nodes <= APPROACH_LIMITS.nodes && result.planning.blockReads <= APPROACH_LIMITS.blockReads);
  assert.doesNotMatch(JSON.stringify(result), /waypoints|diamond|openHeap|visitedChunks/);
});

test('real planner rounds a two-block obstacle using native walking and keeps the original target', async () => {
  const target = new Vec3(8, 68, 0);
  const { bot, steps } = fixture(p => p.equals(target) ? 'crafting_table'
    : p.x === 2 && p.z === 0 && p.y >= 64 && p.y <= 65 ? 'oak_log' : openFloor(p));
  const result = await approachTarget(bot, proposal(target), new AbortController().signal, controls);
  assert.equal(result.reached, true); assert.deepEqual(result.target.position, { ...target });
  assert.ok(steps.some(p => Math.abs(p.z - .5) > .7));
  assert.ok(steps.every(p => !(Math.floor(p.x) === 2 && Math.floor(p.z) === 0 && p.y < 66)));
  assert.ok(result.distance <= 4.5); assert.deepEqual(bot.controls, {});
});

test('a visible target across unsupported or unknown floor has no route and creates no blocks', async () => {
  for (const support of ['air', null]) {
    const target = new Vec3(9, 66, 0);
    const { bot, steps } = fixture(p => p.equals(target) ? 'oak_log'
      : p.y < 64 ? p.x <= 1 && Math.abs(p.z) <= 1 ? 'stone' : support : 'air');
    await assert.rejects(approachTarget(bot, proposal(target), new AbortController().signal, controls), (error: any) => {
      assert.equal(error.details.approach.stoppedReason, 'no_path'); assert.equal(error.details.approach.reached, false); return true;
    });
    assert.deepEqual(steps, []); assert.deepEqual(bot.controls, {});
  }
});

test('target visibility is checked before disclosure, including missing entity and unknown sight cells', async () => {
  const { bot } = fixture(p => p.x === 2 ? null : p.x === 6 && p.y === 66 && p.z === 0 ? 'diamond_ore' : openFloor(p));
  await assert.rejects(approachTarget(bot, proposal(new Vec3(6, 66, 0)), new AbortController().signal, controls), (error: any) => {
    assert.equal(error.details.approach.stoppedReason, 'target_not_visible');
    assert.doesNotMatch(JSON.stringify(error.details), /diamond_ore/); return true;
  });
  await assert.rejects(approachTarget(bot, { type: 'approach', entityId: 7 }, new AbortController().signal, controls), (error: any) => {
    assert.equal(error.details.approach.stoppedReason, 'target_not_visible');
    assert.deepEqual(error.details.approach.target, { kind: 'entity', entityId: 7 }); return true;
  });
  entity(bot, new Vec3(90, 64, 0));
  await assert.rejects(approachTarget(bot, { type: 'approach', entityId: 7 }, new AbortController().signal,
    { ...controls, entityVisible: () => assert.fail('Do not raycast out-of-range targets.') }), (error: any) => {
    assert.equal(error.details.approach.stoppedReason, 'target_out_of_range');
    assert.equal(error.details.approach.target.lastSeenPosition, undefined); return true;
  });
});

test('planning success is insufficient when the native body does not reach a valid position', async () => {
  const target = new Vec3(8, 66, 0);
  const { bot } = fixture(p => p.equals(target) ? 'crafting_table' : openFloor(p));
  let calls = 0;
  await assert.rejects(approachTarget(bot, proposal(target), new AbortController().signal,
    { ...controls, moveTo: async () => { calls++; } }), (error: any) => {
    assert.equal(error.details.approach.reached, false); assert.equal(error.details.approach.partial, false);
    assert.ok(error.details.approach.planning.legs <= APPROACH_LIMITS.legs); return true;
  });
  assert.ok(calls > 0); assert.ok(bot.entity.position.equals(new Vec3(.5, 64, .5)));
});

test('native collision diagnostics do not disclose arbitrary hidden block identities', async () => {
  const target = new Vec3(8, 66, 0), { bot } = fixture(p => p.equals(target) ? 'crafting_table' : openFloor(p));
  await assert.rejects(approachTarget(bot, proposal(target), new AbortController().signal, {
    ...controls, moveTo: async () => { throw Object.assign(new Error('前方障碍超过可自动跳跃的一格高度。'), {
      details: { movement: { reasonCode: 'step_blocked', blocker: { name: 'diamond_ore', position: { x: 2, y: 65, z: 0 } } } },
    }); },
  }), (error: any) => {
    assert.equal(error.details.approach.lastMovement.reasonCode, 'step_blocked');
    assert.doesNotMatch(JSON.stringify(error.details), /diamond_ore|blocker/); return true;
  });
});

test('an empty successful plan centres an offset body and waits for real native settling', async () => {
  for (const mode of ['offset', 'momentum']) {
    const { bot } = fixture(openFloor);
    if (mode === 'offset') {
      bot.entity.position = new Vec3(.95, 64, .5); entity(bot, new Vec3(-2.55, 64, .5));
    } else {
      entity(bot, new Vec3(2.5, 64, .5)); bot.entity.velocity = new Vec3(.1, 0, 0);
      const clear = bot.clearControlStates;
      // Simulated vanilla friction, never a velocity write by the planner.
      bot.clearControlStates = () => { clear(); setTimeout(() => { bot.entity.velocity = new Vec3(0, 0, 0); }, 1); };
    }
    let calls = 0;
    const result = await approachTarget(bot, { type: 'approach', entityId: 7 }, new AbortController().signal,
      { ...controls, moveTo: async (...args: Parameters<typeof nativeWalkTo>) => { calls++; await nativeWalkTo(...args); } });
    assert.equal(result.reached, true, mode); assert.equal(calls, 1, mode);
    assert.equal(result.planning.plans, 1); assert.equal(result.planning.legs, 1);
    assert.ok(result.distance <= 3); assert.equal(bot.entity.velocity.x, 0); assert.deepEqual(bot.controls, {});
  }
});

test('visible moving entities are replanned and final reach uses the actual interaction box', async () => {
  const { bot } = fixture(openFloor), cow = entity(bot, new Vec3(8.5, 64, .5)); let calls = 0;
  const result = await approachTarget(bot, { type: 'approach', entityId: 7 }, new AbortController().signal,
    { ...controls, moveTo: async (...args: Parameters<typeof nativeWalkTo>) => {
      await nativeWalkTo(...args); if (++calls === 1) cow.position = new Vec3(10.5, 64, .5);
    } });
  assert.equal(result.reached, true); assert.ok(result.distance <= 3);
  assert.equal(result.reachKind, 'interaction'); assert.ok(result.distance > 1, 'Ordinary creatures keep their three-metre interaction boundary.');
  assert.ok(result.planning.plans >= 2); assert.deepEqual(result.target.lastSeenPosition, { ...cow.position });
});

test('a dropped item within old melee reach requires native walking to actual pickup proximity', async () => {
  const { bot, steps } = fixture(openFloor), item = entity(bot, new Vec3(3, 64, .5));
  item.name = 'item'; item.width = .25; item.height = .25;
  const result = await approachTarget(bot, { type: 'approach', entityId: 7 }, new AbortController().signal, controls);
  assert.equal(result.reached, true); assert.ok(result.planning.legs > 0); assert.ok(steps.length > 0);
  assert.equal(result.reachKind, 'pickup-proximity'); assert.equal(result.interactionReached, true);
  assert.ok(result.distance <= 1); assert.equal(result.verticalOffset, 0);
  assert.equal(result.pickupConfirmed, false); assert.equal(bot.entities[7], item, 'The still-present item must not be reported as collected.');
});

test('a dropped item on a cell corner still has a reachable goal with the real planner and motor', async () => {
  const { bot } = fixture(openFloor), item = entity(bot, new Vec3(3.999, 64, 1.999));
  item.name = 'item_stack'; item.width = .25; item.height = .25;
  const result = await approachTarget(bot, { type: 'approach', entityId: 7 }, new AbortController().signal, controls);
  assert.equal(result.reached, true); assert.ok(result.distance <= 1); assert.equal(result.pickupConfirmed, false);
  assert.ok(result.planning.legs > 0); assert.deepEqual(result.target.lastSeenPosition, { ...item.position });
});

test('an overhead dropped item does not satisfy pickup reach by horizontal distance alone', async () => {
  const { bot } = fixture(p => Math.abs(p.x) <= 1 && Math.abs(p.z) <= 1 ? openFloor(p) : 'air');
  const item = entity(bot, new Vec3(.5, 66, .5)); item.name = 'item'; item.width = .25; item.height = .25;
  await assert.rejects(approachTarget(bot, { type: 'approach', entityId: 7 }, new AbortController().signal, controls), (error: any) => {
    assert.equal(error.details.approach.stoppedReason, 'no_path'); assert.equal(error.details.approach.reached, false);
    assert.equal(error.details.approach.distance, 0); assert.equal(error.details.approach.verticalOffset, 2);
    assert.equal(error.details.approach.pickupConfirmed, false); return true;
  });
});

test('a disappearing target item stops with its last seen position without claiming collection', async () => {
  const { bot } = fixture(openFloor), item = entity(bot, new Vec3(4.5, 64, .5));
  item.name = 'item'; item.width = .25; item.height = .25;
  await assert.rejects(approachTarget(bot, { type: 'approach', entityId: 7 }, new AbortController().signal, {
    ...controls, moveTo: async (...args: Parameters<typeof nativeWalkTo>) => { await nativeWalkTo(...args); delete bot.entities[7]; },
  }), (error: any) => {
    assert.equal(error.details.approach.stoppedReason, 'target_not_visible'); assert.equal(error.details.approach.reached, false);
    assert.equal(error.details.approach.partial, true); assert.equal(error.details.approach.pickupConfirmed, false);
    assert.deepEqual(error.details.approach.target.lastSeenPosition, { ...item.position }); return true;
  });
});

test('losing entity visibility stops the active native leg and never exposes its hidden new coordinates', async () => {
  const { bot } = fixture(openFloor), cow = entity(bot); let visible = true, begin!: () => void, finish!: () => void, settled = false;
  const started = new Promise<void>(resolve => { begin = resolve; }), drain = new Promise<void>(resolve => { finish = resolve; });
  const pending = approachTarget(bot, { type: 'approach', entityId: 7 }, new AbortController().signal, {
    entityVisible: () => visible,
    moveTo: async (_bot, _point, signal) => {
      bot.entity.position = bot.entity.position.offset(.2, 0, 0); bot.controls.forward = true; begin();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); await drain;
      throw new Error('native stopped');
    },
  });
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await started; visible = false; cow.position = new Vec3(20.123, 64, 12.345);
  await delay(70); assert.deepEqual(bot.controls, {}); assert.equal(settled, false);
  finish();
  await assert.rejects(pending, (error: any) => {
    assert.equal(error.details.approach.stoppedReason, 'target_not_visible');
    assert.equal(error.details.approach.partial, true); assert.equal(error.details.approach.planning.legs, 1);
    assert.deepEqual(error.details.approach.target.lastSeenPosition, { x: 10.5, y: 64, z: .5 });
    assert.doesNotMatch(JSON.stringify(error.details), /20\.123|12\.345/); return true;
  });
});

test('a newly closed wall invalidates the route before issuing another movement leg', async () => {
  let wall = false;
  const target = new Vec3(9, 66, 0);
  const { bot } = fixture(p => p.equals(target) ? 'crafting_table' : wall && p.x === 2 && p.y >= 64 ? 'stone'
    : Math.abs(p.z) > 1 ? 'stone' : openFloor(p));
  let calls = 0;
  await assert.rejects(approachTarget(bot, proposal(target), new AbortController().signal, {
    ...controls, moveTo: async (...args: Parameters<typeof nativeWalkTo>) => { calls++; await nativeWalkTo(...args); wall = true; },
  }), (error: any) => {
    assert.equal(error.details.approach.reached, false); assert.equal(error.details.approach.partial, true);
    assert.equal(error.details.approach.stoppedReason, 'no_path'); return true;
  });
  assert.equal(calls, 1); assert.deepEqual(bot.controls, {});
});

for (const kind of ['cancel', 'deadline']) test(`${kind} stops controls immediately but awaits the native operation before releasing`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { bot } = fixture(openFloor); entity(bot); const controller = new AbortController();
  let begin!: () => void, finish!: () => void, settled = false, calls = 0;
  const started = new Promise<void>(resolve => { begin = resolve; }), drain = new Promise<void>(resolve => { finish = resolve; });
  const pending = approachTarget(bot, { type: 'approach', entityId: 7 }, controller.signal, {
    ...controls, moveTo: async (_bot, _point, signal) => {
      calls++; bot.entity.position = bot.entity.position.offset(.2, 0, 0); bot.controls.forward = true; begin();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); await drain;
      throw new Error('native cleanup complete');
    },
  });
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await started;
  if (kind === 'cancel') controller.abort(new Error('stop now'));
  t.mock.timers.tick(APPROACH_LIMITS.durationMs + 1); await Promise.resolve();
  assert.equal(settled, false); assert.deepEqual(bot.controls, {}); assert.equal(calls, 1);
  finish();
  await assert.rejects(pending, (error: any) => {
    assert.equal(error.details.approach.stoppedReason, kind === 'cancel' ? 'cancelled' : 'time_limit');
    assert.equal(error.details.approach.partial, true); assert.equal(error.details.approach.reached, false); return true;
  });
  assert.equal(calls, 1); assert.deepEqual(bot.controls, {});
});

test('one travel action crosses several native steps and gains over eight metres without choosing a target height', async () => {
  const { bot, steps } = fixture(p => p.y < (p.x >= 11 ? 67 : p.x >= 7 ? 66 : p.x >= 3 ? 65 : 64) ? 'stone' : 'air');
  bot.canSeeBlock = () => assert.fail('Travel must not require a visible resource target.');
  const start = bot.entity.position.clone(), target = { type: 'travel' as const, x: 13.5, z: .5 };
  const result = await travelToArea(bot, target, new AbortController().signal, controls);
  assert.equal(result.mode, 'native-travel'); assert.equal(result.reached, true);
  assert.deepEqual(result.target, { x: 13.5, z: .5 }); assert.ok(result.distance <= 1.25);
  assert.ok(bot.entity.position.x - start.x >= 8); assert.equal(bot.entity.position.y, 67);
  for (const y of [64, 65, 66, 67]) assert.ok(steps.some(p => p.y === y), `Actual native movement visits floor ${y}.`);
  assert.equal(bot.entity.onGround, true); assert.equal(bot.entity.velocity.x, 0); assert.deepEqual(bot.controls, {});
  assert.ok(result.planning.legs >= 8 && result.planning.legs <= APPROACH_LIMITS.legs);
  assert.equal(result.target.y, undefined); assert.doesNotMatch(JSON.stringify(result), /waypoints|map|stone|routeHeight/);
});

test('travel can round an occluding loaded wall with legal native movement without reporting the hidden map', async () => {
  const { bot, steps } = fixture(p => p.x === 4 && Math.abs(p.z) <= 1 && p.y >= 64 && p.y < 68 ? 'diamond_ore' : openFloor(p));
  const result = await travelToArea(bot, { type: 'travel', x: 10.5, z: .5 }, new AbortController().signal, controls);
  assert.equal(result.reached, true); assert.ok(result.distance <= 1.25);
  assert.ok(steps.some(p => Math.abs(p.z - .5) > 1.5));
  assert.ok(steps.every(p => !(Math.floor(p.x) === 4 && Math.abs(Math.floor(p.z)) <= 1 && p.y < 68)));
  assert.doesNotMatch(JSON.stringify(result), /diamond_ore|waypoints|blocker/); assert.deepEqual(bot.controls, {});
});

test('travel takes its safe reachable prefix once and stops before unknown crossings or unsupported cliffs', async () => {
  for (const kind of ['unknown', 'cliff']) {
    const { bot, steps } = fixture(p => kind === 'unknown' && p.x >= 3 ? null
      : p.x <= 2 && Math.abs(p.z) <= 2 && p.y < 64 ? 'stone' : 'air');
    await assert.rejects(travelToArea(bot, { type: 'travel', x: 12.5, z: .5 }, new AbortController().signal, controls), (error: any) => {
      assert.equal(error.details.travel.reached, false); assert.equal(error.details.travel.stoppedReason, 'no_path');
      assert.deepEqual(error.details.travel.target, { x: 12.5, z: .5 }); assert.equal(error.details.travel.target.y, undefined);
      assert.equal(error.details.travel.partial, true); assert.equal(error.details.travel.planning.plans, 1);
      assert.equal(error.details.travel.planning.legs, 2); assert.ok(error.details.travel.distance < 12);
      assert.deepEqual(error.details.travel.position, { ...bot.entity.position });
      assert.doesNotMatch(JSON.stringify(error.details), /waypoints|openHeap|visitedChunks/); return true;
    });
    assert.ok(steps.length > 0); assert.ok(bot.entity.position.x > 2);
    assert.ok(steps.every(p => p.x <= 2.61 && p.y === 64)); assert.deepEqual(bot.controls, {});
  }
});

test('travel recovery requires meaningful progress from the actual offset body, not the planner cell centre', async () => {
  const { bot, steps } = fixture(p => p.x >= 0 && p.x <= 1 && p.z === 0 && p.y < 64 ? 'stone' : 'air');
  bot.entity.position = new Vec3(.95, 64, .9);
  const target = { type: 'travel' as const, x: 12.5, z: 4.5 };
  const before = bot.entity.position.clone(), endpoint = new Vec3(1.5, 64, .5);
  const distance = (p: Vec3) => Math.hypot(target.x - p.x, target.z - p.z);
  assert.ok(distance(before.floored().offset(.5, 0, .5)) - distance(endpoint) > .5);
  assert.ok(distance(before) - distance(endpoint) < .5);
  await assert.rejects(travelToArea(bot, target, new AbortController().signal, controls), (error: any) => {
    assert.equal(error.details.travel.stoppedReason, 'no_path'); assert.equal(error.details.travel.reached, false);
    assert.equal(error.details.travel.planning.legs, 0); assert.equal(error.details.travel.partial, false); return true;
  });
  assert.deepEqual(steps, []); assert.ok(bot.entity.position.equals(before)); assert.deepEqual(bot.controls, {});
});

test('travel recovery stops before a loaded landing hidden below the current ledge', async () => {
  const { bot, steps } = fixture(p => p.z === 0 && p.x >= 0 && p.x <= 1 && p.y < (p.x === 0 ? 64 : 61) ? 'stone' : 'air');
  await assert.rejects(travelToArea(bot, { type: 'travel', x: 5.5, z: .5 }, new AbortController().signal, controls), (error: any) => {
    assert.equal(error.details.travel.stoppedReason, 'no_path'); assert.equal(error.details.travel.reached, false);
    assert.ok(error.details.travel.planning.nodes > 1, 'The planner can reach the lower loaded landing.');
    assert.equal(error.details.travel.planning.plans, 1); assert.equal(error.details.travel.planning.legs, 0);
    assert.equal(error.details.travel.partial, false); return true;
  });
  assert.deepEqual(steps, []); assert.deepEqual(bot.controls, {});
});

test('travel recovery rechecks support and stops its one prefix when the next landing changes', async () => {
  let removed = false;
  const { bot, steps } = fixture(p => p.z === 0 && p.x >= 0 && p.x <= 3 && p.y < 64
    && !(removed && p.x >= 2) ? 'stone' : 'air');
  await assert.rejects(travelToArea(bot, { type: 'travel', x: 12.5, z: .5 }, new AbortController().signal, {
    ...controls, moveTo: async (...args: Parameters<typeof nativeWalkTo>) => { await nativeWalkTo(...args); removed = true; },
  }), (error: any) => {
    assert.equal(error.details.travel.stoppedReason, 'no_path'); assert.equal(error.details.travel.reached, false);
    assert.equal(error.details.travel.partial, true); assert.equal(error.details.travel.planning.plans, 1);
    assert.equal(error.details.travel.planning.legs, 1); return true;
  });
  assert.ok(steps.length > 0); assert.ok(steps.every(p => p.x <= 1.61)); assert.deepEqual(bot.controls, {});
});

test('real planner and native body allow a three-block descent while refusing four blocks', async () => {
  for (const drop of [3, 4]) {
    const { bot, steps } = fixture(p => {
      if (p.x < -2 || p.x > 5 || Math.abs(p.z) > 1) return 'air';
      return p.y < (p.x <= 0 ? 64 : 64 - drop) ? 'stone' : 'air';
    });
    const pending = travelToArea(bot, { type: 'travel', x: 3.5, z: .5 }, new AbortController().signal, controls);
    if (drop === 3) {
      const result = await pending;
      assert.equal(result.reached, true); assert.equal(bot.entity.position.y, 61);
      assert.ok(result.distance <= 1.25); assert.equal(bot.entity.onGround, true);
      assert.ok(steps.some(p => p.y === 61), 'The actual native body must descend, not just receive a successful plan.');
      assert.ok(steps.every(p => p.y >= 61)); assert.ok(result.planning.legs > 0);
    } else {
      await assert.rejects(pending, (error: any) => {
        assert.equal(error.details.travel.stoppedReason, 'no_path'); assert.equal(error.details.travel.reached, false);
        assert.equal(error.details.travel.planning.legs, 0); assert.equal(error.details.travel.partial, false); return true;
      });
      assert.deepEqual(steps, []); assert.ok(bot.entity.position.equals(new Vec3(.5, 64, .5)));
    }
    assert.deepEqual(bot.controls, {});
  }
});

test('travel never treats planner success or matching XZ with no grounded support as physical arrival', async () => {
  const { bot } = fixture(openFloor);
  await assert.rejects(travelToArea(bot, { type: 'travel', x: 12.5, z: .5 }, new AbortController().signal,
    { ...controls, moveTo: async () => {} }), (error: any) => {
    assert.equal(error.details.travel.reached, false); assert.equal(error.details.travel.partial, false);
    assert.ok(error.details.travel.planning.legs <= APPROACH_LIMITS.legs); return true;
  });
  bot.entity.onGround = false;
  await assert.rejects(travelToArea(bot, { type: 'travel', x: .5, z: .5 }, new AbortController().signal, controls), (error: any) => {
    assert.equal(error.details.travel.stoppedReason, 'not_grounded'); assert.equal(error.details.travel.reached, false); return true;
  });
  const unsupported = fixture(() => 'air').bot;
  await assert.rejects(travelToArea(unsupported, { type: 'travel', x: .5, z: .5 }, new AbortController().signal, controls), (error: any) => {
    assert.equal(error.details.travel.stoppedReason, 'no_path'); assert.equal(error.details.travel.reached, false); return true;
  });
});

test('travel waits for an actual knockback landing then plans from the new grounded position', async () => {
  const { bot, steps } = fixture(openFloor);
  bot.entity.position = new Vec3(.5, 64.7, .5); bot.entity.onGround = false;
  const landed = new Vec3(1.5, 64, .5);
  let firstMove: Vec3 | undefined;
  const landing = setTimeout(() => { bot.entity.position = landed.clone(); bot.entity.onGround = true; }, 120);
  try {
    const pending = travelToArea(bot, { type: 'travel', x: 4.5, z: .5 }, new AbortController().signal, {
      ...controls, moveTo: async (...args: Parameters<typeof nativeWalkTo>) => {
        assert.equal(bot.entity.onGround, true, 'Do not force a route while the body is airborne.');
        firstMove ??= bot.entity.position.clone(); await nativeWalkTo(...args);
      },
    });
    await delay(40);
    assert.equal(firstMove, undefined); assert.deepEqual(steps, []); assert.deepEqual(bot.controls, {});
    const result = await pending;
    assert.ok(firstMove?.equals(landed), 'The old airborne cell must not seed the route.');
    assert.equal(result.reached, true); assert.ok(result.planning.legs > 0);
    assert.ok(result.planning.groundingWaitMs >= 100 && result.planning.groundingWaitMs < APPROACH_LIMITS.groundingMs);
    assert.ok(result.distance <= 1.25); assert.deepEqual(bot.controls, {});
  } finally { clearTimeout(landing); }
});

test('cancelling during the landing wait stops without issuing or leaving a queued native move', async () => {
  const { bot, steps } = fixture(openFloor), controller = new AbortController();
  bot.entity.onGround = false;
  let calls = 0;
  const pending = travelToArea(bot, { type: 'travel', x: 4.5, z: .5 }, controller.signal, {
    ...controls, moveTo: async () => { calls++; },
  });
  const rejected = assert.rejects(pending, (error: any) => {
    assert.equal(error.details.travel.stoppedReason, 'cancelled');
    assert.equal(error.details.travel.reached, false); assert.equal(error.details.travel.planning.plans, 0);
    return true;
  });
  await delay(40); controller.abort(); await rejected;
  bot.entity.onGround = true; await delay(70);
  assert.equal(calls, 0); assert.deepEqual(steps, []); assert.deepEqual(bot.controls, {});
});

test('landing wait still stops when an entity becomes hidden without disclosing its new location', async () => {
  const { bot } = fixture(openFloor), cow = entity(bot);
  bot.entity.onGround = false; let visible = true;
  const lastSeen = cow.position.clone();
  const pending = approachTarget(bot, { type: 'approach', entityId: 7 }, new AbortController().signal, {
    entityVisible: () => visible, moveTo: async () => assert.fail('No move should start before landing.'),
  });
  const rejected = assert.rejects(pending, (error: any) => {
    assert.equal(error.details.approach.stoppedReason, 'target_not_visible');
    assert.equal(error.details.approach.planning.legs, 0);
    assert.deepEqual(error.details.approach.target.lastSeenPosition, { ...lastSeen });
    assert.doesNotMatch(JSON.stringify(error.details), /20\.123|12\.345/); return true;
  });
  await delay(20); visible = false; cow.position = new Vec3(20.123, 64, 12.345);
  await rejected; assert.deepEqual(bot.controls, {});
});

test('travel rejects distant XZ before reading collision geometry', async () => {
  const { bot, reads } = fixture(openFloor);
  await assert.rejects(travelToArea(bot, { type: 'travel', x: 33.5, z: .5 }, new AbortController().signal, controls), (error: any) => {
    assert.equal(error.details.travel.stoppedReason, 'target_out_of_range'); assert.equal(error.details.travel.planning.legs, 0); return true;
  });
  assert.deepEqual(reads, []);
});

for (const route of ['complete', 'partial']) test(`travel cancellation drains the active native ${route} route leg and preserves partial progress`, async () => {
  const { bot } = fixture(route === 'complete' ? openFloor : p => p.z === 0 && p.x >= 0 && p.x <= 2 && p.y < 64 ? 'stone' : 'air');
  const controller = new AbortController();
  let begin!: () => void, finish!: () => void, settled = false, calls = 0;
  const started = new Promise<void>(resolve => { begin = resolve; }), drain = new Promise<void>(resolve => { finish = resolve; });
  const pending = travelToArea(bot, { type: 'travel', x: 13.5, z: .5 }, controller.signal, {
    ...controls, moveTo: async (_bot, _point, signal) => {
      calls++; bot.entity.position = bot.entity.position.offset(.2, 0, 0); bot.controls.forward = true; begin();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); await drain;
      throw new Error('native cleanup complete');
    },
  });
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await started; controller.abort(new Error('stop now')); await Promise.resolve();
  assert.deepEqual(bot.controls, {}); assert.equal(settled, false); assert.equal(calls, 1);
  finish();
  await assert.rejects(pending, (error: any) => {
    assert.equal(error.details.travel.mode, 'native-travel'); assert.equal(error.details.travel.stoppedReason, 'cancelled');
    assert.equal(error.details.travel.partial, true); assert.equal(error.details.travel.reached, false);
    assert.deepEqual(error.details.travel.target, { x: 13.5, z: .5 }); assert.equal(error.details.approach, undefined); return true;
  });
  assert.equal(calls, 1); assert.deepEqual(bot.controls, {});
});

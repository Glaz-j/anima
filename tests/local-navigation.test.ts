import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import minecraftData from 'minecraft-data';
import loadBlock from 'prismarine-block';
import { Vec3 } from 'vec3';
import { LOCAL_NAVIGATION_BUDGET, navigateLocally, planLocalRoute } from '../adapters/minecraft/src/local-navigation.ts';
import { runNativeAction } from '../adapters/minecraft/src/native-actions.ts';
import { MinecraftWorld } from '../adapters/minecraft/src/world.ts';

const registry = minecraftData('1.21.4'), Block = loadBlock(registry);
function fixture(resolve: (cell: Vec3) => string | null = p => p.y < 64 ? 'stone' : 'air') {
  const reads: Vec3[] = [], steps: Vec3[] = [], controls: Record<string, boolean> = {};
  const bot: any = { entity: { position: new Vec3(.5, 64, .5), eyeHeight: 1.62, width: .6, height: 1.8,
    onGround: true, velocity: new Vec3(0, 0, 0) }, controls,
    blockAt(p: Vec3) {
      const cell = p.floored(); reads.push(cell);
      const name = resolve(cell); if (!name) return null;
      const block = Block.fromStateId(registry.blocksByName[name].defaultState, 0); block.position = cell; return block;
    }, clearControlStates() { for (const key of Object.keys(controls)) delete controls[key]; },
    stopDigging() {},
  };
  let aim = bot.entity.position.clone();
  bot.lookAt = async (point: Vec3) => { aim = point.clone(); };
  // A bounded kinematic fixture for the real native motor. Body collision and
  // support use real 1.21.4 block shapes; no test movement can cross a solid wall.
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
      if (bodyClear(p) && bot.blockAt(p.offset(0, -1, 0))?.boundingBox === 'block') {
        bot.entity.position = p; steps.push(p.clone()); return;
      }
    }
  };
  return { bot, reads, steps };
}
const blocked = (reasonCode = 'step_blocked') => Object.assign(new Error('直线前方有障碍。'), {
  details: { movement: { reasonCode } },
});

test('visible local routes use bounded cardinal standing cells and real block collision geometry', () => {
  const { bot, reads } = fixture(), target = new Vec3(3.5, 64, .5), plan = planLocalRoute(bot, target);
  assert.equal(plan.complete, true); assert.deepEqual(plan.waypoints.at(-1), target);
  let previous = bot.entity.position;
  for (const point of plan.waypoints) {
    assert.equal(point.y, 64);
    assert.ok(Math.abs(point.x - previous.x) + Math.abs(point.z - previous.z) <= 1.001);
    previous = point;
  }
  assert.ok(plan.nodes <= LOCAL_NAVIGATION_BUDGET.nodes && plan.candidates <= LOCAL_NAVIGATION_BUDGET.candidates);
  assert.ok(reads.length <= LOCAL_NAVIGATION_BUDGET.blockReads);
  assert.ok(reads.every(p => Math.abs(p.x) <= 5 && Math.abs(p.z) <= 5 && p.y >= 60 && p.y <= 69));
});

test('a solid wall or an unloaded sight corridor prevents planning through hidden loaded terrain', () => {
  for (const barrier of ['stone', null]) {
    const routes: string[] = [];
    for (const hidden of ['stone', 'diamond_ore']) {
      const { bot } = fixture(p => p.x === 1 ? barrier : p.y < 64 ? p.x > 1 ? hidden : 'stone' : 'air');
      const plan = planLocalRoute(bot, new Vec3(3.5, 64, .5));
      assert.equal(plan.complete, false); assert.ok(plan.waypoints.every(p => p.x < 1));
      routes.push(JSON.stringify(plan.waypoints));
    }
    assert.equal(routes[0], routes[1], 'Hidden mineral identity cannot influence the visible route.');
  }
});

test('local routes refuse deep drops, liquid landings, partial floors and unsupported air jumps', () => {
  for (const kind of ['deep', 'water', 'slab', 'gap']) {
    const { bot } = fixture(p => {
      if (p.x === 1) {
        if (kind === 'deep') return p.y < 60 ? 'stone' : 'air';
        if (kind === 'water') return p.y === 64 ? 'water' : p.y < 64 ? 'stone' : 'air';
        if (kind === 'slab') return p.y === 63 ? 'stone_slab' : p.y < 63 ? 'stone' : 'air';
        return 'air';
      }
      return p.y < 64 ? 'stone' : 'air';
    });
    const plan = planLocalRoute(bot, new Vec3(2.5, 64, .5));
    assert.equal(plan.complete, false, kind); assert.ok(plan.waypoints.every(p => p.x < 1), kind);
  }
});

test('goto from a non-centred start rounds a two-block tree using the native motor and reaches only the original goal', async () => {
  const { bot, steps } = fixture(p => p.y < 64 ? 'stone' : p.x === 1 && p.z === 0 && p.y < 66 ? 'oak_log' : 'air');
  bot.entity.position = new Vec3(.65, 64, .64);
  const target = new Vec3(3.5, 64, .5), start = bot.entity.position.clone();
  const initialPlan = planLocalRoute(bot, target);
  assert.equal(initialPlan.complete, false);
  assert.ok(initialPlan.waypoints.every(p => !p.equals(target)), 'The target behind the trunk is still hidden from the original eye.');
  const result = await runNativeAction(bot, { type: 'goto', ...target }, new AbortController().signal);
  assert.equal(result.movement, 'native-local-navigation'); assert.equal(result.reached, true);
  assert.ok(bot.entity.position.distanceTo(target) <= .45); assert.equal(bot.entity.onGround, true);
  assert.ok(steps.some(p => Math.abs(p.z - start.z) > .7), 'Execution must take an actual side route.');
  assert.ok(steps.every(p => !(Math.floor(p.x) === 1 && Math.floor(p.z) === 0 && p.y < 66)));
  assert.ok(result.navigation.plans <= LOCAL_NAVIGATION_BUDGET.plans && result.navigation.legs <= LOCAL_NAVIGATION_BUDGET.legs);
  assert.deepEqual(bot.controls, {});
});

test('a requested point inside a solid trunk cannot become a successful standing goal', async () => {
  const { bot } = fixture(p => p.y < 64 ? 'stone' : p.x === 1 && p.z === 0 && p.y < 66 ? 'oak_log' : 'air');
  const target = new Vec3(1.5, 64, .5); let calls = 0;
  await assert.rejects(navigateLocally(bot, target, new AbortController().signal, async (_bot, point) => {
    if (++calls === 1) throw blocked();
    assert.equal(bot.blockAt(point).boundingBox, 'empty'); bot.entity.position = point.clone();
  }), (error: any) => {
    assert.equal(error.details.navigation.reached, false); assert.deepEqual(error.details.navigation.target, { ...target });
    assert.equal(error.details.navigation.stoppedReason, 'target_blocked'); return true;
  });
  assert.equal(calls, 0, 'A visibly solid destination must not spend twelve legs circling it.');
  assert.ok(bot.entity.position.distanceTo(target) > .45);
});

test('an unreachable overhead target is never relabelled as success after partial navigation', async () => {
  const { bot } = fixture(), target = new Vec3(2.5, 70, .5); let calls = 0;
  await assert.rejects(navigateLocally(bot, target, new AbortController().signal, async (_bot, point) => {
    if (++calls === 1) throw blocked('vertical_only');
    // Simulates confirmed walking on the only real floor, not the requested y70.
    assert.equal(point.y, 64); bot.entity.position = point.clone();
  }), (error: any) => {
    assert.equal(error.details.navigation.reached, false); assert.equal(error.details.navigation.partial, true);
    assert.deepEqual(error.details.navigation.target, { ...target });
    assert.ok(error.details.navigation.plans <= LOCAL_NAVIGATION_BUDGET.plans);
    assert.ok(error.details.navigation.legs <= LOCAL_NAVIGATION_BUDGET.legs); return true;
  });
  assert.ok(calls <= LOCAL_NAVIGATION_BUDGET.legs + 1); assert.equal(bot.entity.position.y, 64);
});

test('a native landing at y65 cannot satisfy a y64.90 target on a different floor', async () => {
  const { bot } = fixture();
  const target = new Vec3(1.5, 64.90, .5); let calls = 0;
  await assert.rejects(navigateLocally(bot, target, new AbortController().signal, async (_bot, point) => {
    calls++; assert.deepEqual(point, target); bot.entity.position = new Vec3(target.x, 65, target.z);
  }), (error: any) => {
    assert.equal(error.details.navigation.reached, false); assert.deepEqual(error.details.navigation.target, { ...target }); return true;
  });
  assert.equal(calls, 1); assert.equal(bot.entity.position.y, 65);
});

test('recorded HuYifei stone-wall destination fails before walking with the witnessed blocker', async () => {
  const { bot, steps } = fixture(p => p.y < 69 || p.x === -223 && p.z === -113 && p.y <= 70 ? 'stone' : 'air');
  bot.entity.position = new Vec3(-221.4646139021313, 69, -112.50652868842094);
  const target = new Vec3(-222.5, 69, -112.5), before = bot.entity.position.clone();
  await assert.rejects(runNativeAction(bot, { type: 'goto', ...target }, new AbortController().signal), (error: any) => {
    assert.equal(error.details.movement.reasonCode, 'target_blocked');
    assert.deepEqual(error.details.movement.blocker, { name: 'stone', position: { x: -223, y: 69, z: -113 } });
    assert.equal(error.details.navigation.plans, 0); assert.equal(error.details.navigation.legs, 0);
    assert.equal(error.details.navigation.partial, false); return true;
  });
  assert.ok(bot.entity.position.equals(before)); assert.deepEqual(steps, []); assert.deepEqual(bot.controls, {});
});

test('hidden or unloaded destination geometry is not classified or disclosed by the early check', async () => {
  for (const wall of ['stone', null]) {
    const { bot } = fixture(p => p.x === 1 ? wall : p.x === 3 && p.z === 0 && p.y === 64 ? 'diamond_ore' : p.y < 64 ? 'stone' : 'air');
    let calls = 0;
    await assert.rejects(navigateLocally(bot, new Vec3(3.5, 64, .5), new AbortController().signal, async () => {
      calls++; throw new Error('fixture native stop');
    }), (error: any) => {
      assert.match(error.message, /fixture native stop/); assert.doesNotMatch(JSON.stringify(error.details), /diamond_ore|target_blocked/); return true;
    });
    assert.equal(calls, 1, 'An unseen destination must still be handed to ordinary navigation.');
  }
});

test('support contact is legal but an actually colliding visible head block is not', async () => {
  for (const floor of ['stone', 'stone_slab']) {
    const y = floor === 'stone' ? 65 : 64.5;
    const { bot } = fixture(p => p.y === 64 ? floor : p.y < 64 ? 'stone' : 'air');
    bot.entity.position = new Vec3(.5, y, .5);
    const target = new Vec3(1.5, y, .5);
    const result = await navigateLocally(bot, target, new AbortController().signal, async (_bot, point) => { bot.entity.position = point.clone(); });
    assert.equal(result.reached, true, floor);
  }
  const { bot } = fixture(p => p.x === 1 && p.z === 0 && p.y === 65 ? 'stone' : p.y < 64 ? 'stone' : 'air');
  await assert.rejects(navigateLocally(bot, new Vec3(1.5, 64, .5), new AbortController().signal, async () => {
    assert.fail('Do not start walking into a visible head obstruction.');
  }), (error: any) => { assert.equal(error.details.movement.blocker.position.y, 65); return true; });
});

test('newly exposed destination collision ends an in-progress detour without another leg', async () => {
  let wall = true;
  const { bot } = fixture(p => wall && p.x === 1 ? 'stone' : p.x === 3 && p.z === 0 && p.y === 64 ? 'stone' : p.y < 64 ? 'stone' : 'air');
  let calls = 0;
  await assert.rejects(navigateLocally(bot, new Vec3(3.5, 64, .5), new AbortController().signal, async (_bot, point) => {
    if (++calls === 1) throw blocked();
    bot.entity.position = point.clone(); wall = false;
  }), (error: any) => {
    assert.equal(error.details.navigation.stoppedReason, 'target_blocked'); assert.equal(error.details.navigation.partial, true);
    assert.equal(error.details.navigation.legs, 1); return true;
  });
  assert.equal(calls, 2); assert.deepEqual(bot.controls, {});
});

test('cancel during a detour stops the current native leg and prevents further planning or movement', async () => {
  const { bot } = fixture(), controller = new AbortController(); let calls = 0, startLeg!: () => void;
  const started = new Promise<void>(resolve => { startLeg = resolve; });
  const pending = navigateLocally(bot, new Vec3(3.5, 64, .5), controller.signal, async (_bot, _point, signal) => {
    if (++calls === 1) throw blocked();
    bot.entity.position = bot.entity.position.offset(.3, 0, 0);
    bot.controls.forward = true;
    signal.addEventListener('abort', () => bot.clearControlStates(), { once: true }); startLeg();
    await delay(5000, undefined, { signal });
  });
  await started; controller.abort(new Error('生成期间受伤的短动作窗口已结束。'));
  await assert.rejects(pending, (error: any) => {
    assert.match(error.message, /导航已取消.*短动作窗口已结束/);
    assert.doesNotMatch(error.message, /前方有障碍/);
    assert.equal(error.details.movement.reasonCode, 'cancelled');
    assert.equal(error.details.navigation.initialFailure.message, '直线前方有障碍。');
    assert.equal(error.details.navigation.initialFailure.movement.reasonCode, 'step_blocked');
    assert.equal(error.details.navigation.partial, true);
    assert.equal(error.details.navigation.segmentDisplacementSum, .3);
    assert.deepEqual(error.details.navigation.current, { ...bot.entity.position });
    assert.equal(error.details.navigation.stoppedReason, 'cancelled'); assert.equal(error.details.navigation.reached, false); return true;
  });
  assert.equal(calls, 2); assert.deepEqual(bot.controls, {}); await delay(10); assert.equal(calls, 2);
});

test('dynamic rejection has bounded replans, honest partial position and no hidden edits', async () => {
  const { bot } = fixture(); let calls = 0;
  for (const name of ['dig', 'placeBlock', 'chat', 'setPosition', 'loadColumn']) bot[name] = () => assert.fail(name);
  await assert.rejects(navigateLocally(bot, new Vec3(3.5, 64, .5), new AbortController().signal, async (_bot, point) => {
    calls++;
    if (calls === 2) { bot.entity.position = point.clone(); return; }
    throw blocked();
  }), (error: any) => {
    const navigation = error.details.navigation;
    assert.equal(error.message, '直线前方有障碍。');
    assert.equal(error.details.movement.reasonCode, 'step_blocked');
    assert.notEqual(navigation.stoppedReason, 'cancelled'); assert.notEqual(navigation.stoppedReason, 'time_limit');
    assert.equal(navigation.reached, false); assert.equal(navigation.partial, true);
    assert.deepEqual(navigation.current, { ...bot.entity.position }); assert.ok(navigation.lastLegFailure);
    assert.ok(navigation.plans <= LOCAL_NAVIGATION_BUDGET.plans && navigation.legs <= LOCAL_NAVIGATION_BUDGET.legs); return true;
  });
  assert.ok(calls <= LOCAL_NAVIGATION_BUDGET.legs + 1); assert.deepEqual(bot.controls, {});
});

test('the total deadline aborts an active native leg once and clears movement without rescheduling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { bot } = fixture(); let calls = 0, startLeg!: () => void, finishDrain!: () => void, settled = false;
  const started = new Promise<void>(resolve => { startLeg = resolve; });
  const drain = new Promise<void>(resolve => { finishDrain = resolve; });
  const pending = navigateLocally(bot, new Vec3(3.5, 64, .5), new AbortController().signal, async (_bot, _point, signal) => {
    if (++calls === 1) throw blocked();
    bot.entity.position = bot.entity.position.offset(.2, 0, 0);
    bot.controls.forward = true; startLeg();
    await new Promise<void>(resolve => signal.addEventListener('abort', () => {
      bot.clearControlStates(); resolve();
    }, { once: true }));
    await drain;
    throw new Error('native cancelled');
  });
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await started; t.mock.timers.tick(LOCAL_NAVIGATION_BUDGET.durationMs);
  await Promise.resolve();
  assert.equal(settled, false, 'The timeout requests cancellation but cannot release an undrained body operation.');
  assert.equal(calls, 2); assert.deepEqual(bot.controls, {});
  finishDrain();
  await assert.rejects(pending, (error: any) => {
    assert.match(error.message, /导航已超时/); assert.doesNotMatch(error.message, /前方有障碍/);
    assert.equal(error.details.movement.reasonCode, 'time_limit');
    assert.equal(error.details.navigation.initialFailure.message, '直线前方有障碍。');
    assert.equal(error.details.navigation.partial, true); assert.equal(error.details.navigation.segmentDisplacementSum, .2);
    assert.equal(error.details.navigation.plans, 1); assert.equal(error.details.navigation.legs, 1);
    assert.equal(error.details.navigation.stoppedReason, 'time_limit'); return true;
  });
  assert.equal(calls, 2); assert.deepEqual(bot.controls, {});
  t.mock.timers.tick(LOCAL_NAVIGATION_BUDGET.durationMs); assert.equal(calls, 2);
});

test('task cancellation reaches native goto with its reason and holds the body lock until native look finishes', async t => {
  const { bot } = fixture();
  bot.inventory = { items: () => [] }; bot.health = 20; bot.food = 20;
  let beginLook!: () => void, finishLook!: () => void, settled = false;
  const started = new Promise<void>(resolve => { beginLook = resolve; });
  const drain = new Promise<void>(resolve => { finishLook = resolve; });
  bot.lookAt = async () => { beginLook(); await drain; };
  // No bot connection or file logging: exercise the actual world body lock and
  // native goto against an already constructed local fixture.
  const world = new MinecraftWorld({ host: 'fixture.invalid', port: 0, version: '1.21.4', logDirectory: 'unused' });
  t.mock.method(world, 'event', (record: any, type: string, data: any) => {
    const event = { type, ...data }; record.events.push(event); return event;
  });
  const task = { id: 'cancel-navigation-fixture', controller: new AbortController() };
  const record: any = { name: 'Fixture', persona: '', bot, ready: true, events: [], task };
  world.bots.set(record.name, record);
  const pending = world.execute(record.name, { type: 'goto', x: 3.5, y: 64, z: .5 }, task.id);
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await started;
  const reason = { type: 'world-event', event: 'death' };
  task.controller.abort(reason);
  assert.equal(record.actionController.signal.reason, reason);
  await Promise.resolve();
  assert.equal(settled, false); assert.ok(record.actionController, 'Cancellation must not unlock an unsettled native call.');
  assert.deepEqual(bot.controls, {});
  await assert.rejects(world.execute(record.name, { type: 'wait', ms: 1 }, task.id), /正在执行行动/);
  finishLook();
  const receipt = await pending;
  assert.equal(receipt.status, 'cancelled'); assert.match(receipt.error, /导航已取消.*world-event:death/);
  assert.equal(receipt.details.navigation.stoppedReason, 'cancelled');
  assert.equal(receipt.details.navigation.plans, 0); assert.equal(receipt.details.navigation.legs, 0);
  assert.equal(record.actionController, undefined); assert.deepEqual(bot.controls, {});
});

test('an earlier cancellation is not relabelled as timeout while native cleanup drains past the deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { bot } = fixture(), controller = new AbortController();
  let begin!: () => void, finish!: () => void, calls = 0;
  const started = new Promise<void>(resolve => { begin = resolve; });
  const drain = new Promise<void>(resolve => { finish = resolve; });
  const pending = navigateLocally(bot, new Vec3(3.5, 64, .5), controller.signal, async () => {
    calls++; begin(); await drain;
    throw new Error('native cleanup finished');
  });
  await started;
  controller.abort(new Error('操作者停止了本轮。'));
  t.mock.timers.tick(LOCAL_NAVIGATION_BUDGET.durationMs + 1);
  finish();
  await assert.rejects(pending, (error: any) => {
    assert.match(error.message, /导航已取消.*操作者停止/); assert.doesNotMatch(error.message, /超时/);
    assert.equal(error.details.navigation.stoppedReason, 'cancelled');
    assert.equal(error.details.navigation.plans, 0); assert.equal(error.details.navigation.legs, 0); return true;
  });
  assert.equal(calls, 1); assert.deepEqual(bot.controls, {});
});

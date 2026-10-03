import { setTimeout as delay } from 'node:timers/promises';
import { Vec3 } from 'vec3';
import { PlayerState } from 'prismarine-physics';
import { approachTarget } from './approach.ts';
import { assertInventorySessionUsable } from './craft-sync.ts';
import { consumeHeldItem } from './consumption-action.ts';
import { runBridgeSkill } from './bridge-skill.ts';
import { checkSignal, clearLine, closestPoint, entityHealth, entityVisible, haltNative, meleeTarget, nativeWalkTo, runNativeAction } from './native-actions.ts';

export const CONTINUOUS_SKILL_LIMITS = Object.freeze({ tickMs: 50, combatMs: 10000, surfaceMs: 10000,
  retreatMs: 5000, jumpMs: 5000, pursuitRange: 32, retreatDistance: 8, jumpDistance: 3.6 });
const HAZARDS = new Set(['lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'sweet_berry_bush', 'powder_snow',
  'campfire', 'soul_campfire', 'wither_rose', 'cobweb']);
const WATER = new Set(['water', 'flowing_water', 'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant', 'bubble_column']);
const UNSAFE_FOODS = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chicken', 'chorus_fruit', 'suspicious_stew']);
// Cooldown belongs to the body, not one skill invocation. Restarting a short
// combat lease must not manufacture a fresh, fully charged attack.
const lastAttacks = new WeakMap<object, number>();
const vector = (p: any) => new Vec3(p.x, p.y, p.z);
const eyes = (bot: any) => bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0);
const horizontal = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);
const failure = (code: string, message: string, details: any = {}) => Object.assign(new Error(message), { details: { ...details, stoppedReason: code } });
const block = (bot: any, p: Vec3) => bot.blockAt(p.floored());
const water = (b: any) => b && (WATER.has(b.name) || b.isWaterlogged === true);
const passable = (b: any, allowWater = false) => !!b && b.boundingBox === 'empty' && !HAZARDS.has(b.name) && (allowWater || !water(b));
const support = (b: any) => !!b && b.boundingBox === 'block' && !HAZARDS.has(b.name) && !water(b)
  && (!b.shapes || b.shapes.some((s: number[]) => s.every((n, i) => n === [0, 0, 0, 1, 1, 1][i])));

function position(value: any) {
  if (!value || !['x', 'y', 'z'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key]) && Math.abs(value[key]) <= 30000000))
    throw failure('invalid_target', '目标必须是有限坐标。');
  return vector(value);
}
function duration(value: unknown, fallback: number, max: number) {
  const ms = value ?? fallback;
  if (!Number.isInteger(ms) || Number(ms) < 1 || Number(ms) > max) throw failure('invalid_duration', `技能时长必须是 1–${max} 毫秒。`);
  return Number(ms);
}
function movementRange(value: unknown) {
  const range = value ?? 12;
  if (typeof range !== 'number' || !Number.isFinite(range) || range < 0 || range > 32)
    throw failure('invalid_range', '追近或撤退范围必须是 0–32 格。');
  return range;
}
function entity(bot: any, id: number, identity?: any) {
  const target = bot.entities[id];
  if (!Number.isInteger(id) || !target?.position || target.id === bot.entity.id || (identity && target !== identity))
    throw failure('target_unavailable', '原目标已经卸载或改变，不能继续操作。');
  if (!entityVisible(bot, target)) throw failure('target_not_visible', '目标不再可见，停止追踪。');
  return target;
}

/** Vanilla 1.21 melee attack speeds; custom item attributes are not inferred. */
export function meleeCooldownMs(itemName = '') {
  let speed = 4;
  if (itemName.endsWith('_sword')) speed = 1.6;
  else if (itemName.endsWith('_pickaxe')) speed = 1.2;
  else if (itemName.endsWith('_shovel')) speed = 1;
  else if (itemName.endsWith('_axe')) speed = ['wooden_axe', 'stone_axe'].includes(itemName) ? .8 : itemName === 'iron_axe' ? .9 : 1;
  else if (itemName.endsWith('_hoe')) speed = itemName === 'stone_hoe' ? 2 : itemName === 'iron_hoe' ? 3 : ['diamond_hoe', 'netherite_hoe'].includes(itemName) ? 4 : 1;
  else if (itemName === 'trident') speed = 1.1;
  else if (itemName === 'mace') speed = .6;
  return Math.ceil(1000 / speed);
}

function space(bot: any, feet: Vec3, allowWater = false) {
  const half = (bot.entity.width || .6) / 2 - .001;
  for (let x = Math.floor(feet.x - half); x <= Math.floor(feet.x + half); x++)
    for (let z = Math.floor(feet.z - half); z <= Math.floor(feet.z + half); z++)
      for (let y = Math.floor(feet.y + .001); y <= Math.floor(feet.y + (bot.entity.height || 1.8) - .001); y++)
        if (!passable(block(bot, new Vec3(x, y, z)), allowWater)) return false;
  return true;
}
function groundedPlatform(bot: any, feet: Vec3) {
  return support(block(bot, feet.offset(0, -.05, 0))) && space(bot, feet);
}
/** Shared local precondition; an unavailable shore must not gate emergency ascent. */
export function surfaceTargetAvailable(bot: any, target: { x: number; y: number; z: number }) {
  const feet = vector(target);
  try { return feet.distanceTo(bot.entity.position) <= 12 && groundedPlatform(bot, feet); }
  catch { return false; }
}
// The centre of a floor block behind a same-height rim can be hidden even when
// its walkable top face is visible. Sample that actual surface, not underground.
function shoreVisible(bot: any, feet: Vec3) {
  return !!bot.canSeeBlock(block(bot, feet.offset(0, -.05, 0))) || clearLine(bot, feet.offset(0, .05, 0));
}

/** A conservative one-input lookahead. Unsupported/unknown edges never count as a route. */
function stepToward(bot: any, target: Vec3) {
  const current = bot.entity.position, distance = horizontal(current, target);
  if (distance < .05) return null;
  const step = Math.min(.65, distance), ahead = new Vec3(current.x + (target.x - current.x) / distance * step,
    Math.floor(current.y + .05), current.z + (target.z - current.z) / distance * step);
  if (groundedPlatform(bot, ahead)) return { jump: false };
  if (bot.entity.onGround && support(block(bot, ahead)) && groundedPlatform(bot, ahead.offset(0, 1, 0))) return { jump: true };
  return null;
}

async function look(bot: any, point: Vec3, signal: AbortSignal) {
  checkSignal(signal); await bot.lookAt(point, true); checkSignal(signal);
}
const tick = (signal: AbortSignal) => delay(CONTINUOUS_SKILL_LIMITS.tickMs, undefined, { signal });

async function combat(bot: any, action: any, signal: AbortSignal, elapsed: () => boolean) {
  const identity = entity(bot, action.entityId), origin = action.origin ? position(action.origin) : bot.entity.position.clone(), range = movementRange(action.maxDistance);
  const details: any = { targetId: action.entityId, attempts: 0, controlTicks: 0, healthBefore: entityHealth(bot, identity),
    healthAfter: entityHealth(bot, identity), targetLoaded: true, damageConfirmed: false, killConfirmed: false,
    note: '挥击次数不等于命中或击杀；目标卸载不代表被击败。' };
  const dead = (target: any) => { if (target === identity) { details.killConfirmed = true; details.healthAfter = 0; } };
  bot.on('entityDead', dead);
  const weapon = bot.inventory.items().filter((item: any) => item.name.endsWith('_sword'))
    .sort((a: any, b: any) => ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'].indexOf(a.name.split('_')[0])
      - ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'].indexOf(b.name.split('_')[0]))[0];
  try { if (weapon && bot.heldItem?.name !== weapon.name) { checkSignal(signal); await bot.equip(weapon, 'hand'); checkSignal(signal); }
  while (!elapsed()) {
    checkSignal(signal); details.controlTicks++;
    if (details.killConfirmed) { details.stoppedReason = 'target_dead_observed'; return details; }
    const candidate = bot.entities[action.entityId];
    if (!candidate || candidate !== identity) { details.targetLoaded = false; details.stoppedReason = 'target_unavailable'; return details; }
    const root = entity(bot, action.entityId, identity);
    if (root.position.distanceTo(origin) > Math.max(3, range)
      || bot.entity.position.distanceTo(origin) > range)
      throw failure('pursuit_limit', '本次战斗超出授权局部范围。', details);
    details.healthAfter = entityHealth(bot, root);
    if (details.healthAfter !== null && details.healthAfter <= 0) { details.stoppedReason = 'target_dead_observed'; return details; }
    const target = meleeTarget(bot, root), point = closestPoint(bot, target);
    await look(bot, point, signal);
    // The look operation may await physics. Revalidate identity, sight and reach
    // before writing any attack or motion input.
    const fresh = meleeTarget(bot, entity(bot, action.entityId, identity)), freshPoint = closestPoint(bot, fresh);
    if (eyes(bot).distanceTo(freshPoint) <= 3 && clearLine(bot, freshPoint)) {
      bot.clearControlStates();
      const now = performance.now();
      if (now - (lastAttacks.get(bot) ?? -Infinity) >= meleeCooldownMs(bot.heldItem?.name)) {
        checkSignal(signal); bot.attack(fresh); lastAttacks.set(bot, now); details.attempts++;
      }
    } else {
      if (bot.entity.position.distanceTo(origin) + .65 >= range) throw failure('pursuit_limit', '继续追近会越过本次授权范围。', details);
      const step = stepToward(bot, root.position);
      if (step) {
        bot.setControlState('jump', step.jump); bot.setControlState('sprint', false); bot.setControlState('forward', true);
      } else {
        bot.clearControlStates();
        if (!bot.entity.onGround) { await tick(signal); continue; }
        await approachTarget(bot, { type: 'approach', entityId: action.entityId }, signal,
          { moveTo: async (_bot, next, childSignal, radius) => {
            if (next.distanceTo(origin) > range) throw failure('pursuit_limit', '路线超出本次授权范围。', details);
            await nativeWalkTo(bot, next, childSignal, radius);
          }, entityVisible: (_bot, current) => current === identity && current.position.distanceTo(origin) <= Math.max(3, range) && entityVisible(bot, current) });
      }
    }
    await tick(signal);
  }
  details.stoppedReason = 'duration_elapsed'; return details;
  } catch (error: any) { error.details = { ...details, ...error.details }; throw error; }
  finally { bot.removeListener('entityDead', dead); }
}

async function pickup(bot: any, action: any, signal: AbortSignal) {
  const drop = entity(bot, action.entityId), origin = action.origin ? position(action.origin) : bot.entity.position.clone();
  const range = movementRange(action.maxDistance);
  if (!['item', 'item_stack'].includes(drop.name) || drop.position.distanceTo(origin) > range || bot.entity.position.distanceTo(origin) > range)
    throw failure('pickup_unavailable', '只能靠近授权范围内可见的真实掉落物。');
  const bounded = new AbortController(); let crossedBoundary = false;
  const cancelled = () => bounded.abort(signal.reason);
  const checkBoundary = () => {
    if (bot.entity.position.distanceTo(origin) > range) { crossedBoundary = true; bounded.abort(); bot.clearControlStates(); }
  };
  signal.addEventListener('abort', cancelled, { once: true });
  if (signal.aborted) cancelled();
  bot.on('physicsTick', checkBoundary); bot.on('move', checkBoundary);
  const before = bot.inventory.items().reduce((n: number, i: any) => n + i.count, 0);
  const until = Date.now() + Math.min(action.durationMs || 8000, 10000);
  try { while (bot.entities[drop.id] === drop && Date.now() < until) {
    checkBoundary(); checkSignal(bounded.signal);
    if (!entityVisible(bot, drop) || drop.position.distanceTo(origin) > range) break;
    // Grounded feet positions only; an airborne drop is not a flight destination.
    const base = drop.position.floored();
    const targets = [0, -1, -2, -3].map(dy => new Vec3(drop.position.x, base.y + dy, drop.position.z))
      .filter(p => p.distanceTo(origin) <= range && groundedPlatform(bot, p));
    if (!targets.length) { await tick(bounded.signal); continue; }
    await nativeWalkTo(bot, targets[0], bounded.signal, .5);
    await delay(200, undefined, { signal: bounded.signal });
  }
  const after = bot.inventory.items().reduce((n: number, i: any) => n + i.count, 0);
  return { targetId: drop.id, inventoryIncreased: after > before, note: '掉落物消失不证明已拾取；任务完成以实际库存为准。' };
  } catch (error) {
    if (crossedBoundary && !signal.aborted) throw failure('distance_limit', '拾取已经达到原采集区域的授权边界。', { origin: { ...origin }, maxDistance: range });
    throw error;
  } finally {
    signal.removeEventListener('abort', cancelled);
    bot.removeListener('physicsTick', checkBoundary); bot.removeListener('move', checkBoundary);
  }
}

async function surface(bot: any, action: any, signal: AbortSignal, elapsed: () => boolean) {
  const target = action.target === undefined ? undefined : position(action.target);
  if (target && !surfaceTargetAvailable(bot, target))
    throw failure('shore_unavailable', '岸点必须是12格内已加载且可站立的真实平台。');
  const details: any = { controlTicks: 0, shoreReached: false, dryGround: false, breathingConfirmed: false };
  try { while (!elapsed()) {
    checkSignal(signal); details.controlTicks++;
    const current = bot.entity.position, wet = bot.entity.isInWater === true && (water(block(bot, current.offset(0, .4, 0))) || water(block(bot, current.offset(0, 1, 0))));
    details.position = { ...current };
    if (bot.entity.isInLava) throw failure('lava', '当前不是可执行浮水的水体。', details);
    if (!wet) {
      if (bot.entity.onGround && groundedPlatform(bot, current)) {
        bot.clearControlStates();
        details.dryGround = true; details.shoreReached = !!target && horizontal(current, target) <= .8 && Math.abs(current.y - target.y) < .25;
        if (target && !details.shoreReached) {
          if (!groundedPlatform(bot, target) || !shoreVisible(bot, target)) throw failure('wrong_shore', '已到干地，但指定岸点尚不可见或不可站立。', details);
          await nativeWalkTo(bot, target, signal, .4); checkSignal(signal);
          const actual = bot.entity.position;
          details.shoreReached = horizontal(actual, target) <= .8 && Math.abs(actual.y - target.y) < .25
            && bot.entity.onGround && !bot.entity.isInWater && groundedPlatform(bot, actual);
          details.position = { ...actual };
          if (!details.shoreReached) throw failure('wrong_shore', '已到干地，剩余步行后仍未确认到达指定岸点。', details);
        }
        details.stoppedReason = 'dry_ground'; return details;
      }
      // Jumping out of water briefly has dry contact while still airborne. Keep
      // the last visible shore direction through that arc, otherwise clearing
      // forward at the rim makes the body fall back into the pool forever.
      bot.setControlState('jump', false);
      bot.setControlState('forward', !!target && horizontal(current, target) > .3
        && shoreVisible(bot, target));
      await tick(signal); continue;
    }
    if (!block(bot, current.offset(0, 1, 0))) throw failure('unknown_water', '头部水域尚未加载。', details);
    if (!target && passable(block(bot, eyes(bot)))) {
      details.surfaceReached = true; details.airSpaceObserved = true; details.stoppedReason = 'surface_air'; return details;
    }
    bot.setControlState('jump', true);
    if (target && horizontal(current, target) > .3) {
      // A pool wall may occlude the shore from below water. Keep the already
      // authorized upward input until it becomes visible, then swim towards it.
      // Lack of a shore sightline must never disable emergency surfacing.
      if (!groundedPlatform(bot, target)) throw failure('shore_unavailable', '指定岸点已经不可站立。', details);
      if (!shoreVisible(bot, target)) {
        bot.setControlState('forward', false); await tick(signal); continue;
      }
      const d = horizontal(current, target), ahead = new Vec3(current.x + (target.x - current.x) / d * .55,
        Math.floor(current.y + .05), current.z + (target.z - current.z) / d * .55);
      const leading = ahead.offset((target.x - current.x) / d * .3, 0, (target.z - current.z) / d * .3);
      const swim = space(bot, ahead, true), climb = (support(block(bot, ahead)) || support(block(bot, leading)))
        && space(bot, ahead.offset(0, 1, 0), true);
      if (!swim && !climb) {
        if (current.y < target.y - .9) { bot.setControlState('forward', false); await tick(signal); continue; }
        throw failure('shore_route_blocked', '通向岸点的局部水路被阻挡，不能继续直游。', { ...details, position: { ...current }, ahead: { ...ahead } });
      }
      await look(bot, new Vec3(target.x, current.y + 1.62, target.z), signal);
      bot.setControlState('forward', true);
    } else bot.setControlState('forward', false);
    await tick(signal);
  }
  details.stoppedReason = 'duration_elapsed'; return details;
  } catch (error: any) { error.details = { ...details, ...error.details }; throw error; }
}

type JumpInput = { forward: boolean; back: boolean; sprint: boolean; jump: boolean };
const jumpInput = (forward = false, back = false, jump = false): JumpInput => ({ forward, back, sprint: forward, jump });

/** Local model-predictive input selection. PlayerState is cloned and NEVER
 * applied to the bot: only the real Mineflayer physics/server can move it. */
function predictJumpInput(bot: any, target: Vec3, airborne: boolean) {
  if (typeof bot.physics?.simulatePlayer !== 'function') throw failure('physics_unavailable', '跳跃需要已启动的原生物理反馈。');
  const world = { getBlock: (p: Vec3) => block(bot, p) };
  let best: { input: JumpInput; score: number; landing: Vec3 } | undefined;
  // Run-up is at most four physics ticks and may only remain on safe support.
  // In air, choose when to release/countersteer. Recompute at every real tick,
  // so OS timer jitter cannot add an unnoticed extra 50 ms of thrust.
  const delays = airborne ? [0] : [0, 1, 2, 3, 4];
  for (const launchDelay of delays) for (let driveTicks = 0; driveTicks <= 14; driveTicks++) for (const brake of [false, true]) {
    const state: any = new PlayerState(bot, { ...bot.controlState });
    let first: JumpInput | undefined, tookOff = airborne, landed = false, stable = 0, bad = false;
    const direction = new Vec3(-Math.sin(state.yaw), 0, -Math.cos(state.yaw));
    for (let i = 0; i < 30; i++) {
      const beforeLaunch = !airborne && i < launchDelay;
      const driving = beforeLaunch || i - launchDelay < driveTicks;
      const reversing = !driving && brake && state.vel.x * direction.x + state.vel.z * direction.z > .012;
      const input = landed ? jumpInput() : jumpInput(driving, reversing, !airborne && i === launchDelay);
      first ??= input;
      state.control = { ...input, left: false, right: false, sneak: false };
      bot.physics.simulatePlayer(state, world);
      if (state.isInWater || state.isInLava || !space(bot, state.pos) || state.pos.y < target.y - 1.1) { bad = true; break; }
      if (beforeLaunch && !groundedPlatform(bot, state.pos)) { bad = true; break; }
      if (!state.onGround && (airborne || i >= launchDelay) && state.pos.y > bot.entity.position.y + .03) tookOff = true;
      if (tookOff && state.onGround) {
        landed = true;
        if (!groundedPlatform(bot, state.pos) || Math.abs(state.pos.y - target.y) > .2 || horizontal(state.pos, target) > .55) { bad = true; break; }
        stable++;
        if (stable >= 4 && Math.hypot(state.vel.x, state.vel.z) < .035) break;
      }
    }
    if (bad || !landed || stable < 2) continue;
    const score = horizontal(state.pos, target) + Math.hypot(state.vel.x, state.vel.z) * 2 + launchDelay * .012;
    if (!best || score < best.score) best = { input: first!, score, landing: state.pos.clone() };
  }
  return best;
}

async function jumpTo(bot: any, action: any, signal: AbortSignal, elapsed: () => boolean) {
  const target = position(action), origin = bot.entity.position.clone();
  if (!bot.entity.onGround || bot.entity.isInWater || bot.entity.isInLava) throw failure('not_grounded', '单跳必须从干燥地面起跳。');
  if (horizontal(origin, target) > CONTINUOUS_SKILL_LIMITS.jumpDistance || Math.abs(target.y - origin.y) > 1.05)
    throw failure('jump_out_of_range', '此技能只接受3.6格内且高差不超过1格的单跳。');
  if (!groundedPlatform(bot, target) || !bot.canSeeBlock(block(bot, target.offset(0, -.05, 0))))
    throw failure('landing_unavailable', '落点必须是当前可见、加载且有身体空间的平台。');
  if (horizontal(origin, target) < .4 && Math.abs(origin.y - target.y) < .2) return { reached: true, tookOff: false, landed: true };
  // predictJumpInput must find a safe native-physics trajectory before any
  // motion input. A fabricated arc rejects valid jumps whose upward motion is
  // clipped by a low ceiling; the real collision model already handles that.
  const details: any = { target: { ...target }, tookOff: false, landed: false, reached: false, controlTicks: 0 };
  let stableTicks = 0, groundedTicks = 0;
  await look(bot, new Vec3(target.x, origin.y + 1.62, target.z), signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: any) => {
      if (settled) return; settled = true;
      bot.removeListener('physicsTick', update); signal.removeEventListener('abort', aborted);
      if (error) { error.details = { ...details, ...error.details }; reject(error); } else resolve(details);
    };
    const aborted = () => finish(failure('cancelled', '跳跃已取消或超过时限。'));
    const update = () => {
      try {
        checkSignal(signal); details.controlTicks++;
        if (elapsed()) throw failure('jump_timeout', '跳跃时限内没有确认稳定着陆。');
        const current = bot.entity.position, d = horizontal(current, target);
        if (!bot.entity.onGround && (current.y > origin.y + .03 || current.y < origin.y - .15)) details.tookOff = true;
        if (details.tookOff) bot.setControlState('jump', false);
        if (details.tookOff && bot.entity.onGround) {
          groundedTicks++; bot.clearControlStates(); bot.jumpQueued = false; details.landed = true;
          if (d <= .55 && Math.abs(current.y - target.y) <= .2 && groundedPlatform(bot, current)) {
            const speed = Math.hypot(bot.entity.velocity?.x ?? 0, bot.entity.velocity?.z ?? 0);
            stableTicks = speed <= .04 ? stableTicks + 1 : 0;
            if (stableTicks >= 3) { details.reached = true; details.after = { ...current }; finish(); }
          } else if (groundedTicks >= 2) throw failure('missed_landing', '实际着陆位置没有到达指定平台。');
          return;
        }
        if (current.y < target.y - 1.5) throw failure('fell_below_target', '实际下落已低于目标平台。');
        const prediction = predictJumpInput(bot, target, details.tookOff);
        if (!prediction) {
          // Never step off the launch platform without a feasible trajectory.
          if (!details.tookOff) throw failure('jump_no_trajectory', '当前起步速度和平台条件没有可确认的单跳轨迹。');
          // A late server correction can invalidate predictions midair. Continue
          // actual steering towards the target; only actual landing is success.
          bot.setControlState('forward', d > .25); bot.setControlState('back', false);
          return;
        }
        details.predictedLanding = { ...prediction.landing };
        for (const [key, value] of Object.entries(prediction.input)) bot.setControlState(key, value);
      } catch (error) { finish(error); }
    };
    signal.addEventListener('abort', aborted, { once: true });
    bot.on('physicsTick', update); update();
  });
}

async function retreat(bot: any, action: any, signal: AbortSignal, elapsed: () => boolean) {
  const identity = entity(bot, action.entityId), origin = action.origin ? position(action.origin) : bot.entity.position.clone(), range = movementRange(action.maxDistance);
  const details: any = { targetId: action.entityId, controlTicks: 0, distance: 0 };
  try { while (!elapsed()) {
    checkSignal(signal); details.controlTicks++;
    const threat = entity(bot, action.entityId, identity), current = bot.entity.position;
    details.distance = current.distanceTo(origin);
    if (details.distance + .65 >= range) throw failure('distance_limit', '撤退已经达到本次授权距离；需要重新评估，不能继续沿旧范围反复启动。',
      { ...details, authorizationExhausted: true, origin: { ...origin }, maxDistance: range });
    if (threat.position.distanceTo(origin) > Math.max(3, range)) throw failure('threat_out_of_range', '威胁已超出本次局部授权范围。', details);
    const away = current.minus(threat.position), length = Math.hypot(away.x, away.z);
    if (length < .05) throw failure('no_retreat_direction', '威胁与自身水平位置重叠，无法确认撤退方向。', details);
    const choices = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2];
    let chosen: { target: Vec3; jump: boolean } | undefined;
    for (const angle of choices) {
      const dx = (away.x * Math.cos(angle) - away.z * Math.sin(angle)) / length;
      const dz = (away.x * Math.sin(angle) + away.z * Math.cos(angle)) / length;
      const target = current.offset(dx * 1.2, 0, dz * 1.2), step = stepToward(bot, target);
      if (step) { chosen = { target, ...step }; break; }
    }
    if (!chosen) throw failure('retreat_blocked', '背离威胁的局部方向没有已加载安全落脚点。', details);
    await look(bot, chosen.target.offset(0, 1.62, 0), signal);
    bot.setControlState('jump', chosen.jump); bot.setControlState('sprint', true); bot.setControlState('forward', true);
    await tick(signal);
  }
  details.distance = bot.entity.position.distanceTo(origin); details.stoppedReason = 'duration_elapsed'; return details;
  } catch (error: any) { error.details = { ...details, ...error.details }; throw error; }
}

export function findSafeFood(bot: any) {
  const foods = bot.inventory.items().filter((item: any) => item.count > 0 && !UNSAFE_FOODS.has(item.name) && bot.registry?.foodsByName?.[item.name]);
  foods.sort((a: any, b: any) => (bot.registry.foodsByName[b.name].foodPoints || 0) - (bot.registry.foodsByName[a.name].foodPoints || 0));
  return foods[0];
}

async function eat(bot: any, signal: AbortSignal) {
  assertInventorySessionUsable(bot);
  if (!(bot.food < 20)) throw failure('not_hungry', '当前没有确认的饥饿需求。');
  const selected = findSafeFood(bot);
  if (!selected) throw failure('no_safe_food', '真实背包中没有已知安全食物。');
  checkSignal(signal);
  await bot.equip(selected, 'hand'); checkSignal(signal);
  if (bot.heldItem?.name !== selected.name) throw failure('equip_unconfirmed', '未确认所选食物已经装备。');
  return consumeHeldItem(bot, signal);
}

/** Called only under the world's single body lease; never acquires or releases
 * the outer arbiter lock. Cancellation releases inputs immediately and drains
 * every awaited native operation before this promise settles. */
export async function runContinuousSkill(bot: any, action: any, signal: AbortSignal, emit: (type: string, data: any) => void = () => {}) {
  const kind = action?.type;
  const stop = () => { haltNative(bot); bot.jumpQueued = false; };
  if (kind === 'bridge') {
    try { checkSignal(signal); return await runBridgeSkill(bot, action, signal, emit); }
    finally { stop(); }
  }
  if (!['combat', 'surface', 'jump_to', 'retreat', 'eat', 'pickup'].includes(kind)) {
    signal.addEventListener('abort', stop, { once: true });
    try { checkSignal(signal); return await runNativeAction(bot, action, signal, emit); }
    finally { signal.removeEventListener('abort', stop); stop(); }
  }
  const max = ['combat', 'surface', 'eat', 'pickup'].includes(kind) ? 10000 : 5000;
  const ms = duration(action.durationMs, kind === 'eat' ? 10000 : 1000, max), started = performance.now();
  const deadline = new AbortController(), activeSignal = AbortSignal.any([signal, deadline.signal]);
  const owner = bot.entity;
  const ended = () => deadline.abort(new Error('身体已死亡、重生或断线。'));
  const events = ['death', 'respawn', 'end', 'kicked'];
  let expired = false;
  const timer = setTimeout(() => { expired = true; deadline.abort(); }, ms);
  activeSignal.addEventListener('abort', stop, { once: true });
  for (const event of events) bot.on(event, ended);
  let result: any;
  try {
    checkSignal(activeSignal);
    if (!owner?.position || !(bot.health > 0)) throw failure('body_unavailable', '角色身体尚不可操作。');
    const elapsed = () => performance.now() - started >= ms;
    if (kind === 'combat') result = await combat(bot, action, activeSignal, elapsed);
    else if (kind === 'surface') result = await surface(bot, action, activeSignal, elapsed);
    else if (kind === 'jump_to') result = await jumpTo(bot, action, activeSignal, elapsed);
    else if (kind === 'retreat') result = await retreat(bot, action, activeSignal, elapsed);
    else if (kind === 'pickup') result = await pickup(bot, action, activeSignal);
    else result = await eat(bot, activeSignal);
    if (signal.aborted || bot.entity !== owner) throw failure('cancelled', '技能取消或身体已改变。', result);
    return result;
  } catch (error: any) {
    if (expired && !signal.aborted && bot.entity === owner && kind === 'surface' && action.target)
      throw failure('shore_timeout', '时限内没有实际到达指定岸点。', error.details);
    if (expired && !signal.aborted && bot.entity === owner && ['combat', 'surface', 'retreat'].includes(kind))
      return { ...error.details, stoppedReason: 'duration_elapsed', durationMs: performance.now() - started,
        note: '此回执仅确认技能时间片结束，不证明目标完成。' };
    throw error;
  } finally {
    clearTimeout(timer); activeSignal.removeEventListener('abort', stop);
    for (const event of events) bot.removeListener(event, ended);
    stop();
  }
}

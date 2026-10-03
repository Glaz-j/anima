import { Vec3 } from 'vec3';
import { navigateLocally } from './local-navigation.ts';
import { approachTarget, travelToArea } from './approach.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { runSurvivalAction, SURVIVAL_ACTIONS } from './survival-actions.ts';
import { assertInventorySessionUsable } from './craft-sync.ts';
import { releaseUnmanagedWindow, windowlessInteraction } from './window-lifecycle.ts';
import { fishOnce } from './fishing-action.ts';
import { consumeHeldItem } from './consumption-action.ts';
import { BROADCAST_PREFIX } from './communication.ts';

export function checkSignal(signal: AbortSignal) {
  if (signal.aborted) throw new Error('行动已取消或超时。');
}

export function haltNative(bot: any) {
  // Mineflayer's native promises are drained by the caller before its lock is released.
  for (const stop of [() => bot.clearControlStates(), () => bot.stopDigging(),
    () => { if (bot.usingHeldItem) bot.deactivateItem(); }]) {
    try { stop(); } catch { /* A disconnected client may no longer accept packets. */ }
  }
}

export function entityHealth(bot: any, entity: any): number | null {
  if (typeof entity.health === 'number') return entity.health;
  const keys = bot.registry?.entitiesByName?.[entity.name]?.metadataKeys;
  const index = keys?.indexOf('health');
  const health = index >= 0 ? entity.metadata?.[index] : undefined;
  return typeof health === 'number' ? health : null;
}

export function meleeTarget(bot: any, entity: any) {
  if (entity.name !== 'ender_dragon') return entity;
  if (bot.version !== '1.21.4') throw new Error('末影龙部位映射目前仅验证了 Minecraft 1.21.4。');
  // Vanilla 1.21.4 recreates parts at parent ID + index + 1; body is index 2.
  // Body geometry follows EnderDragon.tickPart(body, sin(yaw)*.5, 0, -cos(yaw)*.5).
  // Mineflayer yaw is PI - the protocol yaw. Do not guess the history-dependent head.
  return { ...entity, id: entity.id + 3, name: 'ender_dragon_body', width: 5, height: 3,
    parentId: entity.id, position: entity.position.offset(Math.sin(entity.yaw || 0) * .5, 0, Math.cos(entity.yaw || 0) * .5) };
}

function eye(bot: any) { return bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0); }

/** Empty cells have no hit surface; a clear ray must also cross loaded cells. */
function emptyCellSight(bot: any, cell: Vec3, block: any): 'visible' | 'occluded' | 'unknown' {
  const origin = eye(bot), delta = cell.offset(.5, .5, .5).minus(origin), distance = delta.norm();
  if (distance < 1e-8) return 'visible';
  const direction = delta.scaled(1 / distance), current = origin.floored();
  const keys = ['x', 'y', 'z'] as const;
  const step = keys.map(key => Math.sign(direction[key]));
  const next = keys.map((key, i) => step[i] === 0 ? Infinity
    : (current[key] + (step[i] > 0 ? 1 : 0) - origin[key]) / direction[key]);
  const stride = keys.map(key => direction[key] === 0 ? Infinity : Math.abs(1 / direction[key]));
  let reached = false;
  // A 4.5-block segment crosses fewer than 12 voxel boundaries. Do not let
  // prismarine-world's raycast silently treat an unloaded cell as transparent.
  for (let count = 0; count < 16; count++) {
    if (!(current.equals(cell) ? block : bot.blockAt(current))) return 'unknown';
    if (current.equals(cell)) { reached = true; break; }
    const axis = next.indexOf(Math.min(...next));
    if (next[axis] > distance) break;
    current[keys[axis]] += step[axis]; next[axis] += stride[axis];
  }
  if (!reached || typeof bot.world?.raycast !== 'function') return 'unknown';
  return bot.world.raycast(origin, direction, distance) ? 'occluded' : 'visible';
}

function requireDigTarget(bot: any, cell: Vec3) {
  const distance = eye(bot).distanceTo(cell.offset(.5, .5, .5));
  const fail = (reasonCode: string, message: string, visibleName?: string): never => {
    throw Object.assign(new Error(message), { details: { dig: { reasonCode, target: { ...cell },
      eyeDistance: Number(distance.toFixed(3)), reach: 4.5, ...(visibleName ? { name: visibleName } : {}) } } });
  };
  // This distance comes only from the requested coordinates, not hidden blocks.
  if (distance > 4.5) fail('out_of_reach', `目标格中心超出眼位 4.5 格挖掘范围（当前 ${distance.toFixed(2)} 格）；未读取该格内容。`);
  const block = bot.blockAt(cell);
  if (!block) fail('target_unloaded', '目标格尚未加载，内容未知；不能判断是否为空或可挖。');
  if (['air', 'cave_air', 'void_air'].includes(block.name)) {
    const sight = emptyCellSight(bot, cell, block);
    if (sight === 'unknown') fail('unknown_visibility', '目标格视线经过未加载区域或暂时无法确认，内容未知。');
    if (sight === 'occluded') fail('target_occluded', '目标格不可见，视线被方块遮挡；未确认该格内容。');
    fail('empty_target', '已确认目标格为空，没有方块可挖；这不是距离或路线失败。', block.name);
  }
  if (!bot.canSeeBlock(block)) fail('target_occluded', '目标格不可见，视线被方块遮挡；未确认该格内容。');
  if (!bot.canDigBlock(block)) fail('not_diggable', `已看见目标方块 ${block.name}，但它当前不能挖掘。`, block.name);
  return block;
}

export function closestPoint(bot: any, entity: any) {
  const origin = eye(bot), position = entity.position, radius = (entity.width || .6) / 2;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  return new Vec3(clamp(origin.x, position.x - radius, position.x + radius),
    clamp(origin.y, position.y, position.y + (entity.height || 1)),
    clamp(origin.z, position.z - radius, position.z + radius));
}

export function clearLine(bot: any, point: Vec3) {
  return clearLineFrom(bot, point, eye(bot));
}

function clearLineFrom(bot: any, point: Vec3, origin: Vec3) {
  const ray = point.minus(origin), distance = ray.norm();
  return distance < .01 || !bot.world.raycast(origin, ray.scaled(1 / distance), Math.max(0, distance - .05));
}

export function entityVisible(bot: any, entity: any) {
  const height = entity.height || 1;
  // An entity can remain visible above a ledge even when the closest corner is
  // occluded. Sample its known loaded geometry, without revealing through walls.
  return [closestPoint(bot, entity), entity.position.offset(0, height * .5, 0),
    entity.position.offset(0, height * .9, 0)].some(point => clearLine(bot, point));
}

function resolveEntity(bot: any, id: number) {
  const entity = bot.entities[id];
  if (!entity || entity.id === bot.entity.id || !entity.position) throw new Error('目标实体不在当前加载世界中。');
  return entity;
}

function requireReach(bot: any, target: any, limit: number) {
  const point = closestPoint(bot, target);
  // Do not disclose a loaded-but-occluded entity's current distance in an error.
  if (!clearLine(bot, point)) throw new Error('目标被方块遮挡。');
  const distance = eye(bot).distanceTo(point);
  if (distance > limit) throw new Error(`目标超出 ${limit} 格交互距离（当前 ${distance.toFixed(1)}）。`);
  return point;
}

function inventoryItem(bot: any, name: string) {
  const item = bot.inventory.items().find((i: any) => i.name === name.replace(/^minecraft:/u, ''));
  if (!item) throw new Error(`背包没有 ${name}。`);
  return item;
}

function matchesPlacedItem(bot: any, item: { name: string; type: number }, block: any, face: Vec3) {
  if (!block) return false;
  const definition = bot.registry?.blocksByName?.[block.name];
  if (typeof block.type === 'number' && definition && block.type !== definition.id) return false;
  if (block.name === item.name) return true;
  // These vanilla wall variants share their standing item's identity. Drops
  // alone are not a placement mapping (stone also drops cobblestone), so only
  // these explicit pairs are accepted, with the active registry confirming it.
  const wallVariant: Record<string, string> = {
    torch: 'wall_torch', soul_torch: 'soul_wall_torch', redstone_torch: 'redstone_wall_torch',
  };
  const registeredItem = bot.registry?.itemsByName?.[item.name];
  return face.y === 0 && wallVariant[item.name] === block.name
    && registeredItem?.id === item.type && Boolean(bot.registry?.blocksByName?.[item.name])
    && !bot.registry?.itemsByName?.[block.name] && block.type === definition?.id
    && Array.isArray(definition?.drops) && definition.drops.includes(item.type);
}

function harvestEligibility(block: any, heldItemType: number | null) {
  if (typeof block.canHarvest === 'function') {
    try {
      const eligible = block.canHarvest(heldItemType);
      if (typeof eligible === 'boolean') return { harvestEligible: eligible, harvestCheck: 'canHarvest' };
    } catch { /* Missing registry information remains unknown. */ }
  }
  // Prismarine's native canHarvest also returns null/undefined for a missing
  // required tool. A known harvestTools map disambiguates those from missing data.
  if (block.harvestTools && typeof block.harvestTools === 'object') {
    return { harvestEligible: heldItemType !== null && Boolean(block.harvestTools[heldItemType]), harvestCheck: 'harvestTools' };
  }
  return { harvestEligible: null, harvestCheck: 'unknown' };
}

function requireOwnBodyClear(bot: any, cell: Vec3, itemName: string) {
  const collisions = bot.registry?.blockCollisionShapes, raw = collisions?.blocks?.[itemName.replace(/^minecraft:/u, '')];
  const shapeIds = Array.isArray(raw) ? raw : typeof raw === 'number' ? [raw] : [];
  const fullCube = shapeIds.length > 0 && shapeIds.every((id: number) => {
    const shapes = collisions.shapes[id];
    return shapes?.length === 1 && shapes[0].length === 6 && shapes[0].every((n: number, i: number) => n === [0, 0, 0, 1, 1, 1][i]);
  });
  // Non-solid and state-dependent shapes (torches, slabs, stairs, etc.) can
  // legally share part of the player's cell; do not invent a whole-cell ban.
  if (!fullCube) return;
  const position = bot.entity.position, halfWidth = (bot.entity.width || .6) / 2, height = bot.entity.height || 1.8;
  const min = position.offset(-halfWidth, 0, -halfWidth), max = position.offset(halfWidth, height, halfWidth);
  if (cell.x < max.x && cell.x + 1 > min.x && cell.y < max.y && cell.y + 1 > min.y && cell.z < max.z && cell.z + 1 > min.z) {
    throw Object.assign(new Error('目标放置格与自身身体重叠，不能在该格放置完整实体方块。'), { details: { placement: {
      reasonCode: 'self_occupied', target: { ...cell }, body: { min: { ...min }, max: { ...max } },
    } } });
  }
}

async function checked(signal: AbortSignal, promise: Promise<unknown>) {
  await promise;
  checkSignal(signal);
}

function handIdentity(bot: any) {
  const held = bot.heldItem;
  return held ? { name: held.name, type: held.type, metadata: held.metadata } : null;
}

function requireUnchangedHand(bot: any, expected: ReturnType<typeof handIdentity>) {
  const held = bot.heldItem;
  if (expected ? !held || held.name !== expected.name || held.type !== expected.type || held.metadata !== expected.metadata || !(held.count > 0) : Boolean(held)) {
    throw new Error('等待期间主手物品发生变化，未发送交互。');
  }
}

export const MELEE_FOLLOW_LIMITS = Object.freeze({ approaches: 3, distance: 16, range: 32 });

async function runMelee(bot: any, proposal: any, signal: AbortSignal) {
  const started = performance.now(), durationMs = proposal.durationMs ?? 1000, follow = proposal.follow === true;
  const origin = bot.entity.position.clone(), identity = bot.entities[proposal.entityId], hand = handIdentity(bot);
  const deadline = new AbortController(), activeSignal = AbortSignal.any([signal, deadline.signal]);
  let expired = false, movementLimited = false, initial = true, distance = 0;
  const details: any = { targetId: proposal.entityId, follow, attempts: 0, attackEntityId: null,
    healthBefore: null, healthAfter: null, lastObservedTarget: null, targetLoaded: false, targetVisible: false,
    damageConfirmed: false, movement: { approaches: 0, legs: 0, distance: 0, before: { ...origin }, after: { ...origin } },
    note: `${follow ? '只追近指定且持续可见的同一实体，追近与挥击共用总时限' : '近战只执行原地挥击'}；attempts是已发送次数，不保证命中或击杀，血量变化仅为观察，不能单独归因于此次攻击。` };
  const stop = () => haltNative(bot);
  activeSignal.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(() => { expired = true; deadline.abort(new Error('近战总时限已到。')); }, durationMs);
  const observeTarget = () => {
    const entity = bot.entities[proposal.entityId];
    details.targetLoaded = Boolean(entity && entity === identity && entity.id !== bot.entity.id && entity.position);
    details.targetVisible = false; details.healthAfter = null;
    if (!details.targetLoaded) return;
    const target = meleeTarget(bot, entity);
    details.attackEntityId = target.id;
    // Follow never refreshes a target outside this action's original local area.
    details.targetVisible = entity.position.distanceTo(follow ? origin : bot.entity.position) <= (follow ? MELEE_FOLLOW_LIMITS.range : 96)
      && entityVisible(bot, entity);
    if (details.targetVisible) {
      details.healthAfter = entityHealth(bot, entity);
      if (initial) details.healthBefore = details.healthAfter;
      details.lastObservedTarget = { position: { ...entity.position },
        reachDistance: Number(eye(bot).distanceTo(closestPoint(bot, target)).toFixed(3)), time: new Date().toISOString() };
    }
    initial = false;
    return target;
  };
  const currentTarget = () => {
    if (performance.now() - started >= durationMs && !activeSignal.aborted) { expired = true; deadline.abort(new Error('近战总时限已到。')); }
    checkSignal(activeSignal);
    const target = observeTarget();
    if (!target) throw new Error('原目标实体已改变或不在当前加载世界中。');
    if (follow && identity.position.distanceTo(origin) > MELEE_FOLLOW_LIMITS.range) throw new Error('目标已超出本次追近的32格局部范围。');
    if (!details.targetVisible) throw new Error('目标被方块遮挡。');
    requireUnchangedHand(bot, hand);
    return target;
  };
  const updateMovement = () => {
    details.movement.distance = Number(distance.toFixed(3)); details.movement.after = { ...bot.entity.position };
    details.partial = details.attempts > 0 || distance > .01;
  };
  try {
    do {
      let target = currentTarget();
      const point = closestPoint(bot, target);
      if (follow && (eye(bot).distanceTo(point) > 3 || !clearLine(bot, point))) {
        if (details.movement.approaches >= MELEE_FOLLOW_LIMITS.approaches) throw new Error('本次追近次数预算已用完。');
        details.movement.approaches++;
        const before = bot.entity.position.clone();
        try {
          details.movement.lastApproach = await approachTarget(bot, { type: 'approach', entityId: proposal.entityId }, activeSignal, {
            entityVisible: (_bot, entity) => entity === identity && entity.position.distanceTo(origin) <= MELEE_FOLLOW_LIMITS.range && entityVisible(bot, entity),
            moveTo: async (_bot, next, childSignal, radius) => {
              currentTarget(); details.movement.legs++;
              let previous = bot.entity.position.clone();
              const sample = () => {
                const current = bot.entity.position; distance += previous.distanceTo(current); previous = current.clone();
                if (distance >= MELEE_FOLLOW_LIMITS.distance) { movementLimited = true; deadline.abort(new Error('本次追近累计移动预算已用完。')); }
              };
              const monitor = setInterval(sample, 20);
              try { await nativeWalkTo(bot, next, childSignal, radius); }
              finally { clearInterval(monitor); sample(); updateMovement(); }
            },
          });
        } catch (error: any) { if (error.details?.approach) details.movement.lastApproach = error.details.approach; throw error; }
        target = currentTarget();
        if (before.distanceTo(bot.entity.position) < .01 && (eye(bot).distanceTo(closestPoint(bot, target)) > 3 || !clearLine(bot, closestPoint(bot, target))))
          throw new Error('靠近未改变站位，指定目标仍不可近战；请重新观察。');
        continue;
      }
      await bot.lookAt(requireReach(bot, target, 3), true);
      // A native look can wait for physics. Never send a stale strike after
      // cancellation, replacement, changed hand, knockback or new occlusion.
      target = currentTarget();
      if (follow && (eye(bot).distanceTo(closestPoint(bot, target)) > 3 || !clearLine(bot, closestPoint(bot, target)))) {
        await delay(25, undefined, { signal: activeSignal }); continue;
      }
      requireReach(bot, target, 3);
      bot.attack(target); details.attempts++;
      await delay(Math.min(650, Math.max(1, durationMs - (performance.now() - started))), undefined, { signal: activeSignal });
      if (!bot.entities[proposal.entityId]) { details.stoppedReason = 'target_unloaded'; break; }
    } while (performance.now() - started < durationMs);
    observeTarget(); updateMovement(); details.stoppedReason ??= 'duration_elapsed';
    return details;
  } catch (error: any) {
    updateMovement();
    if (expired && !signal.aborted && !movementLimited) { observeTarget(); details.stoppedReason = 'duration_elapsed'; return details; }
    if (!activeSignal.aborted) { try { observeTarget(); } catch { /* Preserve the original error. */ } }
    const failure = movementLimited && !signal.aborted ? new Error('本次追近累计移动预算已用完。') : error;
    failure.details = { ...details, stoppedReason: failure.message };
    throw failure;
  } finally { clearTimeout(timer); activeSignal.removeEventListener('abort', stop); stop(); }
}

async function useItem(bot: any, proposal: any, signal: AbortSignal) {
  const offHand = proposal.hand === 'off', destination = offHand ? 'off-hand' : 'hand';
  const held = () => offHand ? bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')] : bot.heldItem;
  // Equipping is not consumption. Snapshot only after the requested hand has
  // settled, and include equipment slots because inventory.items excludes them.
  if (proposal.item && held()?.name !== proposal.item.replace(/^minecraft:/u, '')) {
    await checked(signal, bot.equip(inventoryItem(bot, proposal.item), destination));
  }
  const selected = held();
  if (!selected) throw new Error(`请先在${offHand ? '副手' : '主手'}装备要使用的物品，或提供 item。`);
  if (proposal.item && selected.name !== proposal.item.replace(/^minecraft:/u, '')) throw new Error('没有确认指定物品已装备到请求的手。');
  let aimPoint: Vec3 | undefined;
  if (proposal.position) {
    aimPoint = new Vec3(proposal.position.x, proposal.position.y, proposal.position.z);
    if (aimPoint.distanceTo(eye(bot)) < .000001) throw new Error('瞄准点不能等于眼睛位置。');
  } else if (proposal.direction) {
    const direction = new Vec3(proposal.direction.x, proposal.direction.y, proposal.direction.z);
    aimPoint = eye(bot).plus(direction.scaled(1 / direction.norm()));
  }
  if (aimPoint) await checked(signal, bot.lookAt(aimPoint, true));
  const snapshot = () => {
    const items = bot.inventory.slots.length > 0 ? bot.inventory.slots.slice(5).filter(Boolean) : bot.inventory.items();
    const totals = new Map<string, number>();
    for (const item of items) totals.set(item.name, (totals.get(item.name) || 0) + item.count);
    return totals;
  };
  const before = snapshot(), details: any = { item: selected.name, hand: proposal.hand, durationMs: proposal.durationMs,
    activationSent: false, effectConfirmed: false, ...(aimPoint ? { aimPoint: { ...aimPoint } } : {}) };
  const update = () => {
    const after = snapshot();
    details.inventoryDelta = [...new Set([...before.keys(), ...after.keys()])].map(item => ({ item,
      change: (after.get(item) || 0) - (before.get(item) || 0) })).filter(entry => entry.change !== 0);
    details.heldItemAfter = held() ? { item: held().name, count: held().count } : null;
  };
  try {
    checkSignal(signal);
    bot.activateItem(offHand); details.activationSent = true;
    if (proposal.durationMs > 0) await delay(proposal.durationMs, undefined, { signal });
    checkSignal(signal);
    if (bot.usingHeldItem) bot.deactivateItem();
    await delay(100, undefined, { signal });
    update();
    details.note = '已按请求使用并松开物品；库存差异是实际观察，不能单独证明投掷命中、定位成功或产生方块效果。';
    return details;
  } catch (error: any) {
    update(); error.details = { ...details, partial: details.activationSent, stoppedReason: error.message }; throw error;
  } finally {
    // Releasing can itself fire a charged projectile; cancellation stops holding
    // immediately but cannot undo a use packet already accepted by the server.
    try { if (bot.usingHeldItem) bot.deactivateItem(); } catch { /* Disconnection may prevent a release packet. */ }
  }
}

function arrowAtDistance(distance: number, angle: number) {
  let x = 0, y = 0, vx = 3 * Math.cos(angle), vy = 3 * Math.sin(angle);
  for (let tick = 0; tick < 240; tick++) {
    const nextX = x + vx, nextY = y + vy;
    if (nextX >= distance) {
      const fraction = (distance - x) / vx;
      return { height: y + vy * fraction, flightTicks: tick + fraction };
    }
    x = nextX; y = nextY;
    vx *= .99; vy = vy * .99 - .05;
  }
  return null;
}

/** Full-charge Java bow in air; excludes weapon spread, player motion and collisions. */
export function solveBowShot(eyePosition: Vec3, target: Vec3) {
  const launchOrigin = eyePosition.offset(0, -.1, 0), delta = target.minus(launchOrigin);
  const horizontal = Math.hypot(delta.x, delta.z);
  if (!Number.isFinite(horizontal) || !Number.isFinite(delta.y) || horizontal < .1) throw new Error('目标几乎垂直或坐标无效；请先调整站位。');
  let lower: number | undefined, upper: number | undefined;
  let previous: { angle: number; error: number } | undefined;
  // First below→above crossing is the lower arc; very high arcs can be unreachable.
  for (let degrees = -85; degrees <= 85; degrees += .5) {
    const angle = degrees * Math.PI / 180, result = arrowAtDistance(horizontal, angle);
    if (!result) { previous = undefined; continue; }
    const error = result.height - delta.y;
    if (previous && previous.error <= 0 && error >= 0) { lower = previous.angle; upper = angle; break; }
    previous = { angle, error };
  }
  if (lower === undefined || upper === undefined) throw new Error('当前弓箭弹道无法到达目标；请靠近后重试。');
  for (let step = 0; step < 32; step++) {
    const middle = (lower + upper) / 2, result = arrowAtDistance(horizontal, middle)!;
    if (result.height < delta.y) lower = middle; else upper = middle;
  }
  const angle = (lower + upper) / 2, trajectory = arrowAtDistance(horizontal, angle)!;
  const horizontalSpeed = 3 * Math.cos(angle);
  return {
    launchOrigin,
    aimPoint: eyePosition.offset(delta.x, Math.tan(angle) * horizontal, delta.z),
    initialVelocity: new Vec3(delta.x / horizontal * horizontalSpeed, 3 * Math.sin(angle), delta.z / horizontal * horizontalSpeed),
    estimatedFlightTicks: trajectory.flightTicks,
  };
}

export async function nativeWalkTo(bot: any, target: Vec3, signal: AbortSignal, radius = .45) {
  let previous = bot.entity.position.clone(), progressAt = Date.now();
  let settlingAt: number | undefined;
  const started = Date.now();
  const stopControls = () => { try { bot.clearControlStates(); } catch { /* Client may have disconnected. */ } };
  const failure = (message: string, reasonCode: string, checkedCell?: Vec3, blocker?: any) => {
    const current = bot.entity.position;
    return Object.assign(new Error(message), { details: { movement: {
      reasonCode, target: { ...target }, current: { ...current },
      horizontalDistance: Number(Math.hypot(target.x - current.x, target.z - current.z).toFixed(3)),
      verticalDelta: Number((target.y - current.y).toFixed(3)),
      ...(checkedCell ? { checkedCell: { ...checkedCell } } : {}),
      ...(blocker ? { blocker: { name: blocker.name, position: { ...blocker.position } } } : {}),
    } } });
  };
  const hazards = new Set(['lava', 'water', 'fire', 'soul_fire', 'magma_block', 'cactus', 'sweet_berry_bush', 'powder_snow']);
  const safe = (block: any) => block && !hazards.has(block.name);
  const requireSupport = (feet: Vec3) => {
    // A floor at depth 1 is level; depth 4 is a known three-block descent.
    // Unknown chunks and hazardous landing blocks are never treated as air.
    for (let depth = 1; depth <= 4; depth++) {
      const cell = feet.offset(0, -depth, 0), floor = bot.blockAt(cell);
      if (!floor) throw failure('前方落脚地形尚未加载，不能确认下落高度。', 'unknown_support', cell);
      if (!safe(floor)) throw failure('前方落脚点有危险，停止移动。', 'hazardous_landing', cell, floor);
      if (floor.boundingBox === 'block') return;
    }
    throw failure('前方落差超过3格或没有已知支撑，停止直走以免掉入深坑。', 'unsupported_drop', feet);
  };
  const pendingDescent = (position: Vec3) => {
    const feet = new Vec3(position.x, Math.floor(position.y + .05), position.z).floored();
    const halfWidth = (bot.entity.width || .6) / 2 - .001;
    const support: { cell: Vec3; block: any }[] = [];
    for (let x = Math.floor(position.x - halfWidth); x <= Math.floor(position.x + halfWidth); x++) {
      for (let z = Math.floor(position.z - halfWidth); z <= Math.floor(position.z + halfWidth); z++) {
        const cell = new Vec3(x, feet.y - 1, z);
        support.push({ cell, block: bot.blockAt(cell) });
      }
    }
    // A body still overlapping the upper step needs to keep approaching the
    // target. Once its entire footprint clears that step, onGround can remain
    // true until the next physics tick; it is not proof of a wrong-floor landing.
    if (support.some(({ block }) => block?.boundingBox === 'block')) return false;
    for (const { cell, block } of support) {
      if (!block) throw failure('脚下地形尚未加载，不能确认下落高度。', 'unknown_support', cell);
      if (!safe(block)) throw failure('脚下落脚点有危险，停止移动。', 'hazardous_landing', cell, block);
    }
    requireSupport(feet);
    return true;
  };
  signal.addEventListener('abort', stopControls, { once: true });
  try { while (true) {
    checkSignal(signal);
    const position = bot.entity.position;
    const horizontal = Math.hypot(target.x - position.x, target.z - position.z);
    if (Date.now() - started > 12000) throw failure('这段原生移动超过12秒；请重新观察并选择较近坐标。', 'time_limit');
    if (position.distanceTo(previous) >= .15) { previous = position.clone(); progressAt = Date.now(); }
    const grounded = bot.entity.onGround === true;
    const sameHeight = Math.floor(position.y + .01) === Math.floor(target.y + .01) && Math.abs(target.y - position.y) <= .125;
    const descending = horizontal <= radius && grounded && !sameHeight && target.y < position.y && pendingDescent(position);
    if (horizontal <= radius && (sameHeight || !grounded || descending || horizontal < .05)) {
      // Reaching XZ during a jump/fall is not arrival. Release input immediately;
      // vanilla physics must finish the landing and horizontal momentum first.
      stopControls(); settlingAt ??= Date.now();
      if (grounded && !sameHeight && !descending) throw failure('已经着地，但目标在当前脚下或头顶的其他高度；请重新选择落脚点。', 'vertical_only');
      const horizontalSpeed = Math.hypot(bot.entity.velocity?.x ?? 0, bot.entity.velocity?.z ?? 0);
      if (grounded && sameHeight && horizontalSpeed <= .025) return;
      if (Date.now() - settlingAt > 2000) throw failure('已松开移动控制，但仍未在目标高度稳定着地。', 'landing_unsettled');
      await delay(50, undefined, { signal });
      continue;
    }
    settlingAt = undefined;
    if (Date.now() - progressAt > 1500) throw failure('直线移动遇到障碍或没有进展；请观察后选择另一坐标。', 'no_progress');
    if (horizontal < .05) throw failure('目标在当前脚下或头顶，需要选择可以行走的落脚点。', 'vertical_only');
    const lookAhead = Math.min(.8, horizontal);
    const ahead = new Vec3(position.x + (target.x - position.x) / horizontal * lookAhead, Math.floor(position.y + .05),
      position.z + (target.z - position.z) / horizontal * lookAhead).floored();
    const feet = bot.blockAt(ahead), head = bot.blockAt(ahead.offset(0, 1, 0));
    if (!safe(feet) || !safe(head)) {
      const obstructing = !safe(feet) ? feet : head, cell = !safe(feet) ? ahead : ahead.offset(0, 1, 0);
      throw failure('前方是危险或未加载的地形；请选择其他路线。', obstructing ? 'hazard' : 'unknown_cell', cell, obstructing);
    }
    let jump = false;
    if (feet.boundingBox === 'block') {
      const ceiling = bot.blockAt(ahead.offset(0, 2, 0));
      if (head.boundingBox !== 'empty' || !safe(ceiling) || ceiling.boundingBox !== 'empty') {
        const obstructing = head.boundingBox !== 'empty' ? head : ceiling;
        throw failure('前方障碍超过可自动跳跃的一格高度。', 'step_blocked',
          ahead.offset(0, head.boundingBox !== 'empty' ? 1 : 2, 0), obstructing);
      }
      jump = true;
    } else {
      requireSupport(ahead);
      if (head.boundingBox !== 'empty') throw failure('前方头部空间被遮挡。', 'head_blocked', ahead.offset(0, 1, 0), head);
    }
    await checked(signal, bot.lookAt(new Vec3(target.x, position.y + (bot.entity.eyeHeight || 1.62), target.z), true));
    bot.setControlState('jump', jump);
    bot.setControlState('forward', true);
    await delay(50, undefined, { signal });
  } } finally { stopControls(); signal.removeEventListener('abort', stopControls); }
}

export async function runNativeAction(bot: any, proposal: any, signal: AbortSignal,
  emit: (type: string, data: any) => void = () => {}) {
  checkSignal(signal);
  if (['place', 'equip', 'use_item', 'toss', 'consume', 'shoot', 'fish', 'gather', 'craft', 'smelt', 'container', 'interact'].includes(proposal.type)) {
    assertInventorySessionUsable(bot);
    if (bot.currentWindow) { await releaseUnmanagedWindow(bot); checkSignal(signal); }
  }
  const approach = (target: any, actionSignal: AbortSignal) => approachTarget(bot, target, actionSignal, { moveTo: nativeWalkTo, entityVisible });
  if (proposal.type === 'travel') return travelToArea(bot, proposal, signal, { moveTo: nativeWalkTo, entityVisible });
  if (proposal.type === 'approach') return approach(proposal, signal);
  if (proposal.type === 'fish') return fishOnce(bot, proposal, signal);
  if (SURVIVAL_ACTIONS.has(proposal.type)) return runSurvivalAction(bot, proposal, signal, { moveTo: nativeWalkTo, entityVisible,
    approachBlock: (position, actionSignal) => approach({ type: 'approach', position }, actionSignal) });
  if ('x' in proposal) {
    const target = new Vec3(proposal.x, proposal.y, proposal.z);
    const limit = ['dig', 'place', 'interact'].includes(proposal.type) ? 4.5 : 32;
    if (proposal.type !== 'dig' && target.distanceTo(bot.entity.position) > limit) throw new Error(`行动目标超出 ${limit} 格范围。`);
    if (proposal.type === 'goto') {
      return navigateLocally(bot, target, signal, nativeWalkTo);
    }
    if (proposal.type === 'look') { await checked(signal, bot.lookAt(target, true)); return; }
    if (proposal.type === 'dig') {
      const cell = target.floored(), block = requireDigTarget(bot, cell);
      const position = bot.entity.position, halfWidth = (bot.entity.width || .6) / 2;
      const supporting = bot.entity.onGround === true && block.boundingBox === 'block'
        && cell.y === Math.floor(position.y - .01)
        && cell.x < position.x + halfWidth && cell.x + 1 > position.x - halfWidth
        && cell.z < position.z + halfWidth && cell.z + 1 > position.z - halfWidth;
      await checked(signal, bot.lookAt(cell.offset(.5, .5, .5), true));
      const held = bot.heldItem;
      const heldItem = held ? { name: held.name, type: held.type, count: held.count } : null;
      const harvest = harvestEligibility(block, typeof held?.type === 'number' ? held.type : null);
      await checked(signal, bot.dig(block, 'ignore'));
      const after = bot.blockAt(cell);
      if (!after || after.type === block.type) throw new Error('世界尚未确认方块变化。');
      return { destroyedBlock: { name: block.name, position: { ...cell } }, heldItem, ...harvest,
        removedSupportingBlock: supporting, dropsConfirmed: false, pickupConfirmed: false,
        note: '已确认目标方块改变；harvestEligible只表示当时手持物品是否符合原生采集条件，破坏成功不保证产生掉落或进入背包，入包以实际inventoryDelta为准。' };
    }
    if (proposal.type === 'place') {
      if (typeof bot._placeBlockWithOptions !== 'function') throw new Error('当前 Mineflayer 不支持可取消转向后的原生放置入口，无法安全发送放置动作。');
      const cell = target.floored(), placementEntity = bot.entity;
      if (!['air', 'cave_air', 'void_air'].includes(bot.blockAt(cell)?.name || '')) throw new Error('目标格不是空位。');
      const item = inventoryItem(bot, proposal.item);
      const expectedItem = { name: item.name, type: item.type };
      requireOwnBodyClear(bot, cell, item.name);
      const faces = [new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, -1, 0)];
      const face = faces.find(f => bot.blockAt(cell.minus(f))?.boundingBox === 'block');
      if (!face) throw new Error('周围没有可依附的实体方块。');
      const reference = bot.blockAt(cell.minus(face));
      const referenceState = { name: reference.name, type: reference.type, stateId: reference.stateId };
      const facePoint = reference.position.offset(.5, .5, .5).plus(face.scaled(.5));
      const validatePlacement = () => {
        checkSignal(signal);
        if (bot.entity !== placementEntity) throw new Error('等待期间角色实体发生变化，未发送放置。');
        if (!['air', 'cave_air', 'void_air'].includes(bot.blockAt(cell)?.name || '')) throw new Error('等待期间目标格已不再是空位。');
        const currentReference = bot.blockAt(cell.minus(face));
        if (currentReference?.boundingBox !== 'block' || currentReference.name !== referenceState.name ||
          currentReference.type !== referenceState.type || currentReference.stateId !== referenceState.stateId) throw new Error('等待期间放置支撑发生变化，请重新观察。');
        requireOwnBodyClear(bot, cell, expectedItem.name);
        if (bot.heldItem?.name !== expectedItem.name || bot.heldItem?.type !== expectedItem.type || !(bot.heldItem?.count > 0)) throw new Error('等待期间手持物品发生变化，未发送放置。');
        if (facePoint.distanceTo(eye(bot)) > 4.5 || !clearLine(bot, facePoint)) throw new Error('放置附着面被遮挡或超出眼位 4.5 格范围。');
        // The pinned 1.21.4 client receives crouching pose metadata later. Check
        // the lower eye as well without modifying Mineflayer's entity state.
        const crouchingEye = bot.entity.position.offset(0, Math.min(bot.entity.eyeHeight || 1.62, 1.27), 0);
        if (facePoint.distanceTo(crouchingEye) > 4.5 || !clearLineFrom(bot, facePoint, crouchingEye))
          throw new Error('潜行放置附着面被遮挡或超出眼位 4.5 格范围。');
        return currentReference;
      };
      await checked(signal, bot.equip(item, 'hand'));
      validatePlacement();
      // The native genericPlace awaits lookAt internally without an AbortSignal.
      // Aim under our cancellation gate, then skip that internal async boundary.
      await checked(signal, bot.lookAt(facePoint, true));
      const currentReference = validatePlacement();
      const previousSneak = bot.getControlState?.('sneak') === true;
      const releaseSneak = () => { try { bot.setControlState('sneak', false); } catch { /* Disconnected client. */ } };
      signal.addEventListener('abort', releaseSneak, { once: true });
      try {
        // Place attaches a block; interacting with its support is a separate action.
        // Keep the posture through the native acknowledgement, even on failure.
        bot.setControlState('sneak', true);
        checkSignal(signal);
        await checked(signal, bot._placeBlockWithOptions(currentReference, face, { forceLook: 'ignore', swingArm: 'right' }));
        const placed = bot.blockAt(cell);
        if (!matchesPlacedItem(bot, expectedItem, placed, face)) throw new Error('世界尚未确认放置结果。');
        return { placementConfirmed: true, placedBlock: { name: placed.name, position: { ...cell } } };
      } finally {
        signal.removeEventListener('abort', releaseSneak);
        const restore = previousSneak && !signal.aborted && bot.entity === placementEntity && bot._client?.state === 'play';
        try { bot.setControlState('sneak', restore); } catch { /* Preserve the placement error after disconnect. */ }
      }
    }
    if (proposal.type === 'interact') {
      const cell = target.floored(), block = bot.blockAt(cell);
      if (!block || ['air', 'cave_air', 'void_air'].includes(block.name) || !bot.canSeeBlock(block)) throw new Error('交互方块不可见或是空气；空气中使用物品请调用 use_item。');
      const expectedBlock = { name: block.name, type: block.type, stateId: block.stateId }, expectedHand = handIdentity(bot);
      const direction = proposal.direction ? new Vec3(proposal.direction.x, proposal.direction.y, proposal.direction.z) : new Vec3(0, 1, 0);
      const cursor = new Vec3(.5, .5, .5).plus(direction.scaled(.5));
      const facePoint = cell.plus(cursor);
      const validate = () => {
        checkSignal(signal);
        const current = bot.blockAt(cell);
        if (!current || current.name !== expectedBlock.name || current.type !== expectedBlock.type || current.stateId !== expectedBlock.stateId)
          throw new Error('等待期间目标方块发生变化或卸载，未发送交互。');
        requireUnchangedHand(bot, expectedHand);
        if (!bot.canSeeBlock(current) || facePoint.distanceTo(eye(bot)) > 4.5 || !clearLine(bot, facePoint))
          throw new Error('指定交互面被遮挡或超出 4.5 格交互距离。');
      };
      validate();
      // Installed Mineflayer 4.39.0 activateBlock awaits lookAt, then reads
      // block.position while constructing block_place. Guard that synchronous
      // read, not only the awaited look promise: a queued cancellation microtask
      // must not slip between validation and the native packet construction.
      // This per-call argument changes no bot methods or client write function.
      const guardedBlock = new Proxy(block, { get(object, key, receiver) {
        if (key === 'position') { validate(); return cell; }
        return Reflect.get(object, key, receiver);
      } });
      await windowlessInteraction(bot, signal, () => bot.activateBlock(guardedBlock, direction, cursor));
      return { interactionSent: true, effectConfirmed: false, position: { ...block.position }, direction: { ...direction },
        heldItem: bot.heldItem?.name ?? null };
    }
  }
  if (proposal.type === 'say' || proposal.type === 'broadcast') {
    const channel = proposal.type === 'broadcast' ? 'broadcast' : 'local';
    bot.chat((channel === 'broadcast' ? BROADCAST_PREFIX : '') + proposal.message);
    emit('said', { message: proposal.message, channel });
    return { sent: true, channel };
  }
  if (proposal.type === 'wait') { await delay(proposal.ms, undefined, { signal }); return; }
  if (proposal.type === 'move') {
    for (const control of proposal.controls) bot.setControlState(control, true);
    await delay(proposal.ms, undefined, { signal });
    return;
  }
  if (proposal.type === 'equip') { await checked(signal, bot.equip(inventoryItem(bot, proposal.item), proposal.destination)); return; }
  if (proposal.type === 'use_item') return useItem(bot, proposal, signal);
  if (proposal.type === 'consume') return consumeHeldItem(bot, signal);
  if (proposal.type === 'toss') {
    const item = inventoryItem(bot, proposal.item);
    if (item.count < proposal.count) throw new Error('指定物品数量不足。');
    await checked(signal, bot.toss(item.type, item.metadata, proposal.count));
    return { dropped: proposal.count };
  }
  if (proposal.type === 'interact') {
    const entity = resolveEntity(bot, proposal.entityId), point = requireReach(bot, entity, 3);
    const expectedHand = handIdentity(bot);
    const validate = () => {
      checkSignal(signal);
      if (bot.entities[proposal.entityId] !== entity) throw new Error('等待期间目标实体改变或卸载，未发送交互。');
      requireUnchangedHand(bot, expectedHand);
      requireReach(bot, entity, 3);
    };
    await checked(signal, bot.lookAt(point, true));
    // The same installed native implementation reads entity.id in the use_entity
    // packet after its internal lookAt. Keep native behavior and scope cleanup.
    const guardedEntity = new Proxy(entity, { get(object, key, receiver) {
      if (key === 'id' || key === 'position') validate();
      return Reflect.get(object, key, receiver);
    } });
    await windowlessInteraction(bot, signal, () => bot.activateEntity(guardedEntity));
    return { interactionSent: true, effectConfirmed: false };
  }
  if (proposal.type === 'attack') {
    return runMelee(bot, proposal, signal);
  }
  if (proposal.type === 'shoot') {
    const entity = resolveEntity(bot, proposal.entityId);
    if (entity.position.distanceTo(bot.entity.position) > 96 || !entityVisible(bot, entity)) throw new Error('射击目标不可见或超过 96 格。');
    const bow = inventoryItem(bot, 'bow');
    inventoryItem(bot, 'arrow');
    await checked(signal, bot.equip(bow, 'hand'));
    const target = entity.position.offset(0, (entity.height || 1) / 2, 0);
    const trajectory = solveBowShot(eye(bot), target);
    await checked(signal, bot.lookAt(trajectory.aimPoint, true));
    bot.activateItem();
    await delay(1100, undefined, { signal });
    checkSignal(signal); bot.deactivateItem();
    return { shot: true, aimPoint: trajectory.aimPoint, estimatedFlightTicks: Number(trajectory.estimatedFlightTicks.toFixed(2)),
      damageConfirmed: false, note: '静止目标的空气阻力与重力补偿；仍受原版弓箭散布、玩家移动和遮挡影响，未确认命中。' };
  }
  throw new Error('行动未实现。');
}

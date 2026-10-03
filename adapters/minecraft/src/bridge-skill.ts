import { Vec3 } from 'vec3';
import { setTimeout as delay } from 'node:timers/promises';
import { checkSignal, runNativeAction } from './native-actions.ts';
import { assertInventorySessionUsable, synchronizeServerQueue } from './craft-sync.ts';

export interface BridgeAction { type: 'bridge'; x: number; z: number; item?: string; maxBlocks?: number; origin?: { x: number; y: number; z: number } }
export const BRIDGE_LIMITS = Object.freeze({ range: 12, materialBudget: 12, timeoutMs: 45_000, segmentMs: 5000, overhang: .15 });
const FULL = [0, 0, 0, 1, 1, 1];
const AIR = new Set(['air', 'cave_air', 'void_air']);
export const BRIDGE_MATERIALS = Object.freeze(['cobblestone', 'stone', 'dirt', 'oak_planks', 'spruce_planks', 'birch_planks', 'deepslate', 'cobbled_deepslate', 'netherrack']);
const MATERIALS = new Set(BRIDGE_MATERIALS);
const solid = (block: any) => block?.boundingBox === 'block' && block.shapes?.some((shape: number[]) => shape.length === 6 && shape.every((n, i) => n === FULL[i]))
  && !['magma_block', 'cactus', 'campfire', 'soul_campfire', 'powder_snow'].includes(block.name);
const horizontal = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);
const identity = (block: any) => [block?.name, block?.type, block?.stateId].join(':');
const error = (code: string, message: string) => Object.assign(new Error(message), { details: { stoppedReason: code } });

/** A bounded, body-owned horizontal bridge. All movement is vanilla control input;
 * all placement goes through the existing visibility/collision-checked action. */
export async function runBridgeSkill(bot: any, action: BridgeAction, signal: AbortSignal, emit: (type: string, data: any) => void = () => {}) {
  try { return await executeBridgeSkill(bot, action, signal, emit); }
  catch (failure: any) {
    // Preconditions make no placements. Later failures already carry the
    // drained, server-observed partial receipt from executeBridgeSkill.
    failure.details = { reached: false, placed: 0, spent: 0, inventoryConfirmed: true, ...failure.details };
    throw failure;
  }
}

async function executeBridgeSkill(bot: any, action: BridgeAction, signal: AbortSignal, emit: (type: string, data: any) => void) {
  const item = (action.item || 'cobblestone').replace(/^minecraft:/u, ''), maxBlocks = action.maxBlocks ?? 8;
  if (![action.x, action.z].every(Number.isFinite)) throw error('invalid_target', '搭桥目标必须是有限水平坐标。');
  if (!Number.isInteger(maxBlocks) || maxBlocks < 0 || maxBlocks > BRIDGE_LIMITS.materialBudget) throw error('invalid_budget', '搭桥材料预算必须为 0–12。');
  if (!MATERIALS.has(item)) throw error('unsupported_material', '搭桥只使用已支持的稳定完整方块，不能用重力方块、液体或特殊形状物品。');
  assertInventorySessionUsable(bot); checkSignal(signal);
  if (bot.game?.gameMode !== 'survival') throw error('not_survival', '搭桥技能要求真实生存物品消耗。');
  const owner = bot.entity, start: Vec3 = owner.position.clone();
  const origin = action.origin ? new Vec3(action.origin.x, action.origin.y, action.origin.z) : start.clone();
  if (![origin.x, origin.y, origin.z].every(Number.isFinite)) throw error('invalid_origin', '搭桥起点必须是有限坐标。');
  const level = Math.round(origin.y), destination = new Vec3(action.x, level, action.z);
  const goal = new Vec3(Math.floor(action.x), level - 1, Math.floor(action.z));
  // A cancelled bridge may be at the deliberate overhang: the body centre is
  // over air while its real collision footprint remains supported behind it.
  const half = (owner.width || .6) / 2, supports: { cell: Vec3; overlap: number }[] = [];
  for (let x = Math.floor(start.x - half + .001); x <= Math.floor(start.x + half - .001); x++) {
    for (let z = Math.floor(start.z - half + .001); z <= Math.floor(start.z + half - .001); z++) {
      const cell = new Vec3(x, level - 1, z);
      const ox = Math.min(start.x + half, x + 1) - Math.max(start.x - half, x);
      const oz = Math.min(start.z + half, z + 1) - Math.max(start.z - half, z);
      if (ox >= .05 && oz >= .05 && solid(bot.blockAt(cell))) supports.push({ cell, overlap: ox * oz });
    }
  }
  const centred = supports.find(({ cell }) => cell.x === Math.floor(start.x) && cell.z === Math.floor(start.z));
  const from = (centred || supports.sort((a, b) => b.overlap - a.overlap)[0])?.cell;
  if (Math.abs(start.y - level) > .08 || !owner.onGround || !from) throw error('no_support', '先稳定站在完整支撑方块上再开始搭桥。');
  if (horizontal(origin, destination) > BRIDGE_LIMITS.range || horizontal(origin, start) > BRIDGE_LIMITS.range + .25
    || Math.abs(goal.x - from.x) + Math.abs(goal.z - from.z) > BRIDGE_LIMITS.range)
    throw error('range_limit', '水平搭桥范围和网格步数均不能超过 12 格。');
  if (Math.hypot(bot.entity.velocity?.x || 0, bot.entity.velocity?.z || 0) > .08) throw error('unsettled_start', '开始搭桥前需先停止高速移动。');
  const own = new AbortController(), active = AbortSignal.any([signal, own.signal]);
  const details: any = { reached: false, item, maxBlocks, placed: 0, spent: 0, steps: 0, controlTicks: 0, placements: [], target: { ...destination }, inventoryConfirmed: true };
  const stop = () => { try { bot.clearControlStates(); bot.jumpQueued = false; } catch { /* Disconnected body. */ } };
  const lost = () => { stop(); own.abort(new Error('搭桥期间死亡或断线。')); };
  const timer = setTimeout(() => { stop(); own.abort(new Error('搭桥技能超时。')); }, BRIDGE_LIMITS.timeoutMs);
  const lossEvents = ['death', 'respawn', 'end', 'kicked'];
  active.addEventListener('abort', stop, { once: true }); for (const event of lossEvents) bot.on(event, lost);
  const amount = () => bot.inventory.items().filter((stack: any) => stack.name === item).reduce((count: number, stack: any) => count + stack.count, 0);
  const get = (cell: Vec3) => { const block = bot.blockAt(cell); if (!block) throw error('unknown_cell', '搭桥周围地形尚未加载。'); return block; };
  const check = () => {
    checkSignal(active);
    if (bot.entity !== owner) throw error('body_replaced', '身体实体已更换，原搭桥授权停止。');
    const p: Vec3 = bot.entity.position, half = (bot.entity.width || .6) / 2;
    // onGround can be false for the first zero-vertical-motion physics frame.
    // The loaded collision support/footprint below is the invariant; do not
    // manufacture or overwrite a grounding flag to get past that transition.
    if (Math.abs(p.y - level) > .125 || (bot.entity.velocity?.y || 0) > .05) throw error('support_lost', '身体离开原支撑高度，停止搭桥。');
    if (horizontal(origin, p) > BRIDGE_LIMITS.range + .25) throw error('range_limit', '身体越过授权搭桥范围。');
    let supported = false;
    for (let x = Math.floor(p.x - half + .001); x <= Math.floor(p.x + half - .001); x++) {
      for (let z = Math.floor(p.z - half + .001); z <= Math.floor(p.z + half - .001); z++) {
        const floor = get(new Vec3(x, level - 1, z));
        const overlapX = Math.min(p.x + half, x + 1) - Math.max(p.x - half, x);
        const overlapZ = Math.min(p.z + half, z + 1) - Math.max(p.z - half, z);
        supported ||= solid(floor) && overlapX >= .05 && overlapZ >= .05;
        for (let y = level; y <= level + 1; y++) if (!AIR.has(get(new Vec3(x, y, z)).name)) throw error('body_obstructed', '搭桥身体空间被遮挡或含危险地形。');
      }
    }
    if (!supported) throw error('support_lost', '身体不再与可靠支撑保持足够重叠，停止前进。');
  };
  async function move(target: Vec3, requiredSupport?: { cell: Vec3; state: string }) {
    check(); stop(); bot.setControlState('sneak', true);
    await bot.lookAt(new Vec3(target.x, bot.entity.position.y + (bot.entity.eyeHeight || 1.62), target.z), true);
    check();
    const start: Vec3 = bot.entity.position.clone(), dx = target.x - start.x, dz = target.z - start.z;
    await new Promise<void>((resolve, reject) => {
      let done = false, previous = start.clone(), progressAt = Date.now();
      const finish = (failure?: unknown) => {
        if (done) return; done = true; clearInterval(poll); clearTimeout(timeout); bot.removeListener('physicsTick', update); active.removeEventListener('abort', cancelled);
        try { bot.setControlState('forward', false); } catch { /* Disconnected body. */ }
        failure ? reject(failure) : resolve();
      };
      const cancelled = () => finish(error('cancelled', '搭桥行动已取消。'));
      const update = () => {
        if (done) return;
        try {
          check(); details.controlTicks++;
          if (requiredSupport && (!solid(get(requiredSupport.cell)) || identity(get(requiredSupport.cell)) !== requiredSupport.state)) throw error('support_changed', '等待期间搭桥支撑发生变化。');
          const p: Vec3 = bot.entity.position, distance = horizontal(p, target), remaining = (target.x - p.x) * dx + (target.z - p.z) * dz;
          if (p.distanceTo(previous) > .025) { previous = p.clone(); progressAt = Date.now(); }
          if (distance <= .055 || remaining <= 0) {
            bot.setControlState('forward', false);
            if (distance > .16) throw error('overshoot', '搭桥边缘移动过冲，停止并重新观察。');
            if (Math.hypot(bot.entity.velocity?.x || 0, bot.entity.velocity?.z || 0) <= .018) return finish();
          } else bot.setControlState('forward', true);
          if (Date.now() - progressAt > 1500) throw error('no_progress', '蹲行没有真实进展，不能继续搭桥。');
        } catch (failure) { finish(failure); }
      };
      const timeout = setTimeout(() => finish(error('segment_timeout', '搭桥局部蹲行超时。')), BRIDGE_LIMITS.segmentMs);
      const poll = setInterval(update, 50);
      bot.on('physicsTick', update); active.addEventListener('abort', cancelled, { once: true }); update();
    });
  }
  try {
    stop(); check(); let current = from.clone();
    while (!current.equals(goal)) {
      check();
      const reference = get(current); if (!solid(reference)) throw error('no_support', '当前搭桥支撑不再是完整方块。');
      const dx = goal.x - current.x, dz = goal.z - current.z;
      const direction = Math.abs(dx) >= Math.abs(dz) && dx !== 0 ? new Vec3(Math.sign(dx), 0, 0) : new Vec3(0, 0, Math.sign(dz));
      const next = current.plus(direction), existing = get(next);
      if (!solid(existing)) {
        if (!AIR.has(existing.name)) throw error('blocked_target', '下一搭桥格不是已知空气，不能替换液体或其他方块。');
        if (details.spent >= maxBlocks) throw error('budget_exhausted', '授权搭桥材料预算已经用完。');
        if (amount() < 1) throw error('material_missing', '背包没有足够的授权搭桥材料。');
        // Move the eye beyond the actual outer face while keeping a 0.15-block
        // overlap of the player's footprint on the reference. Sneak physics
        // provides additional ledge protection; no position/velocity writes.
        const peek = current.offset(.5, 1, .5).plus(direction.scaled(.5 + BRIDGE_LIMITS.overhang));
        await move(peek, { cell: current, state: identity(reference) }); check();
        const before = amount(); let placementFailure: any;
        try { await runNativeAction(bot, { type: 'place', x: next.x, y: next.y, z: next.z, item }, active, emit); }
        catch (failure) { placementFailure = failure; }
        try { await synchronizeServerQueue(bot); }
        catch (failure: any) { details.inventoryConfirmed = false; placementFailure ||= failure; }
        // Block updates and the next inventory broadcast can be separated by a
        // server tick. The ordered stats reply alone does not prove the latter
        // has arrived. Keep ownership and drain the already-issued placement,
        // including after cancellation, without issuing any further input.
        if (details.inventoryConfirmed && solid(get(next)) && get(next).name === item && amount() === before) {
          const until = performance.now() + 1200;
          while (amount() === before && performance.now() < until && bot.entity === owner && bot._client?.state === 'play') await delay(25);
          try { await synchronizeServerQueue(bot); }
          catch (failure: any) { details.inventoryConfirmed = false; placementFailure ||= failure; }
        }
        const placed = get(next), spent = before - amount();
        if (solid(placed) && placed.name === item) { details.placed++; details.placements.push({ ...next }); }
        if (details.inventoryConfirmed) details.spent += Math.max(0, spent);
        if (placementFailure) throw placementFailure;
        if (!solid(placed) || placed.name !== item || spent !== 1) {
          details.inventoryConfirmed = false;
          throw error('placement_unconfirmed', '未同时确认真实搭桥方块与恰好一块库存消耗。');
        }
        if (details.spent > maxBlocks) throw error('budget_exceeded', '观察到物品消耗超过授权预算，立即停止。');
        emit('bridge-progress', { placed: details.placed, spent: details.spent, position: { ...next } });
      }
      check(); await move(next.offset(.5, 1, .5), { cell: next, state: identity(get(next)) });
      current = next; details.steps++;
    }
    if (horizontal(bot.entity.position, destination) > .12) await move(destination, { cell: goal, state: identity(get(goal)) });
    check(); details.reached = horizontal(bot.entity.position, destination) <= .16;
    if (!details.reached) throw error('target_not_reached', '尚未真实抵达搭桥目标。');
    return details;
  } catch (failure: any) {
    failure.details = { ...details, ...failure.details, partial: details.placed > 0, position: { ...bot.entity.position } }; throw failure;
  } finally { clearTimeout(timer); active.removeEventListener('abort', stop); for (const event of lossEvents) bot.removeListener(event, lost); stop(); }
}

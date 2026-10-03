import { createRequire } from 'node:module';
import { setImmediate as yieldTurn, setTimeout as delay } from 'node:timers/promises';
import { Vec3 } from 'vec3';

// These are pure planner internals, verified against this exact installed version.
// Never load the plugin: movement and cancellation remain owned by the body layer.
const require = createRequire(import.meta.url);
const plannerVersion = require('mineflayer-pathfinder/package.json').version;
const Movements = require('mineflayer-pathfinder/lib/movements.js');
const AStar = require('mineflayer-pathfinder/lib/astar.js');
const Move = require('mineflayer-pathfinder/lib/move.js');
export const APPROACH_LIMITS = Object.freeze({ range: 32, durationMs: 12000, plans: 4, legs: 48,
  nodes: 1600, blockReads: 16000, planMs: 100, tickMs: 5, distance: 64, groundingMs: 1000 });
const HAZARDS = new Set(['water', 'lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'powder_snow',
  'sweet_berry_bush', 'campfire', 'soul_campfire', 'wither_rose', 'cobweb']);
const isDroppedItem = (target: any) => target?.kind === 'entity' && ['item', 'item_stack'].includes(target.name);
// Java 1.21.4 Player.aiStep queries its bounding box inflated by (1,.5,1).
// Use a conservative subset, not eye-to-entity melee reach. Server pickup still
// depends on delay, ownership and inventory capacity; proximity proves none of those.
const PICKUP = { horizontal: 1, plannedHorizontal: .85, minY: -.4, maxY: 1.4 };
const point = (value: any) => new Vec3(value.x, value.y, value.z);
const positionKey = (p: Vec3) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
const cube = (block: any) => block?.boundingBox === 'block' && block.shapes?.some((s: number[]) =>
  s.every((v, i) => v === [0, 0, 0, 1, 1, 1][i]));
const failure = (code: string, message: string) => Object.assign(new Error(message), { approachCode: code });

function intersects(block: any, cell: Vec3, eye: Vec3, delta: Vec3) {
  return (block.shapes || []).some((shape: number[]) => {
    let near = 0, far = 1;
    for (const [i, axis] of (['x', 'y', 'z'] as const).entries()) {
      const low = cell[axis] + shape[i], high = cell[axis] + shape[i + 3], d = delta[axis];
      if (Math.abs(d) < 1e-9) { if (eye[axis] <= low || eye[axis] >= high) return false; }
      else {
        const a = (low - eye[axis]) / d, b = (high - eye[axis]) / d;
        near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b));
        if (far <= near + 1e-8) return false;
      }
    }
    return far > 1e-6 && near < 1 - 1e-6;
  });
}

/** Unknown cells interrupt sight, even if they happen to be inside a loaded chunk. */
function lineClear(get: (p: Vec3) => any, eye: Vec3, target: Vec3, targetCell?: Vec3) {
  const delta = target.minus(eye), cell = eye.floored(), end = target.floored();
  const axes = ['x', 'y', 'z'] as const, step = axes.map(axis => Math.sign(delta[axis]));
  const t = axes.map((axis, i) => delta[axis] ? (cell[axis] + (step[i] > 0 ? 1 : 0) - eye[axis]) / delta[axis] : Infinity);
  for (let n = 0; n < 128; n++) {
    const block = get(cell);
    if (!block) return false;
    if (targetCell?.equals(cell)) return true;
    if (intersects(block, cell, eye, delta)) return false;
    if (cell.equals(end)) return true;
    const i = t[0] <= t[1] && t[0] <= t[2] ? 0 : t[1] <= t[2] ? 1 : 2;
    if (t[i] > 1) return false;
    cell[axes[i]] += step[i]; t[i] += Math.abs(1 / delta[axes[i]]);
  }
  return false;
}

function closest(eye: Vec3, entity: any) {
  const p = entity.position, half = (entity.width || .6) / 2;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  return new Vec3(clamp(eye.x, p.x - half, p.x + half), clamp(eye.y, p.y, p.y + (entity.height || 1)),
    clamp(eye.z, p.z - half, p.z + half));
}

type MovementControls = {
  moveTo(bot: any, target: Vec3, signal: AbortSignal, radius?: number): Promise<unknown>;
  entityVisible(bot: any, entity: any): boolean;
};
export function approachTarget(bot: any, proposal: any, signal: AbortSignal, controls: MovementControls) {
  return navigate(bot, proposal, signal, controls, false);
}
export function travelToArea(bot: any, proposal: { type: 'travel'; x: number; z: number }, signal: AbortSignal, controls: MovementControls) {
  return navigate(bot, proposal, signal, controls, true);
}

async function navigate(bot: any, proposal: any, signal: AbortSignal, controls: MovementControls, travel: boolean) {
  const limits = APPROACH_LIMITS, origin: Vec3 = bot.entity.position.clone(), controller = new AbortController();
  const actionLabel = travel ? '前往区域' : '靠近目标';
  let expired = false, plans = 0, nodes = 0, reads = 0, legs = 0, travelled = 0, groundingWaitMs = 0;
  let target: any, blockIdentity: any, lastMovement: any;
  const stopControls = () => { try { bot.clearControlStates(); } catch { /* disconnected */ } };
  const abort = () => controller.abort(signal.reason);
  controller.signal.addEventListener('abort', stopControls, { once: true });
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(() => { if (!controller.signal.aborted) { expired = true; controller.abort(); } }, limits.durationMs);
  const check = () => { if (controller.signal.aborted) throw failure(expired ? 'time_limit' : 'cancelled',
    `${actionLabel}${expired ? '已超时。' : '已取消。'}`); };
  const get = (p: Vec3) => {
    if (++reads > limits.blockReads) throw failure('read_budget', '本次靠近的碰撞读取预算已用完。');
    if (p.distanceTo(origin) > limits.range) return null;
    try { return bot.blockAt(p.floored()) || null; } catch { return null; }
  };
  const eyes = (feet: Vec3) => feet.offset(0, bot.entity.eyeHeight || 1.62, 0);
  const sight = (feet: Vec3, current: any, read = get) => {
    if (current.kind === 'area') return true; // Travel has no resource target to discover or reveal.
    const eye = eyes(feet);
    if (current.kind === 'block') return lineClear(read, eye, current.position.offset(.5, .5, .5), current.position);
    return lineClear(read, eye, closest(eye, current));
  };
  const reach = (feet: Vec3, current: any) => current.kind === 'area' ? Math.hypot(current.x - feet.x, current.z - feet.z) : current.kind === 'block'
    ? eyes(feet).distanceTo(current.position.offset(.5, .5, .5)) : isDroppedItem(current)
      ? Math.hypot(current.position.x - feet.x, current.position.z - feet.z) : eyes(feet).distanceTo(closest(eyes(feet), current));
  const withinReach = (feet: Vec3, current: any, planned = false) => {
    if (current.kind === 'area') return reach(feet, current) <= (planned ? 1 : 1.25);
    if (isDroppedItem(current)) {
      const dy = current.position.y - feet.y;
      return dy >= PICKUP.minY && dy <= PICKUP.maxY && reach(feet, current) <= (planned ? PICKUP.plannedHorizontal : PICKUP.horizontal);
    }
    return reach(feet, current) <= (current.kind === 'block' ? planned ? 4.2 : 4.5 : planned ? 2.7 : 3);
  };
  const standable = (feet: Vec3, read = get) => {
    const floor = read(feet.offset(0, -1, 0));
    if (!cube(floor) || HAZARDS.has(floor.name)) return false;
    const half = (bot.entity.width || .6) / 2 - .001;
    for (let x = Math.floor(feet.x - half); x <= Math.floor(feet.x + half); x++)
      for (let z = Math.floor(feet.z - half); z <= Math.floor(feet.z + half); z++)
        for (let y = Math.floor(feet.y + .001); y <= Math.floor(feet.y + (bot.entity.height || 1.8) - .001); y++) {
          const b = read(new Vec3(x, y, z));
          if (!b || b.boundingBox !== 'empty' || HAZARDS.has(b.name)) return false;
        }
    return true;
  };
  const describeTarget = () => !target ? undefined : target.kind === 'area' ? { x: target.x, z: target.z } : target.kind === 'block'
    ? { kind: 'block', position: { ...target.position }, name: target.name }
    : { kind: 'entity', entityId: target.id, ...(target.position ? { name: target.name, lastSeenPosition: { ...target.position } } : {}) };
  const summary = (reached: boolean) => ({ mode: travel ? 'native-travel' : 'native-approach', reached, target: describeTarget(), position: { ...bot.entity.position },
    ...(target?.position || target?.kind === 'area' ? { distance: Number(reach(bot.entity.position, target).toFixed(3)) } : {}),
    ...(travel ? { note: 'distance 为到目标水平坐标的距离；到达仅确认当前实际落脚点，不表示发现资源或验证整片区域。' } : {}),
    ...(target?.position ? { reachKind: isDroppedItem(target) ? 'pickup-proximity' : 'interaction', interactionReached: reached } : {}),
    ...(isDroppedItem(target) ? { pickupConfirmed: false, verticalOffset: Number((target.position.y - bot.entity.position.y).toFixed(3)),
      note: 'reached 仅表示达到掉落物近身范围；distance 为水平距离，不代表已拾取。途中其它库存变化不能归因于此实体。' } : {}),
    partial: travelled > .01 || bot.entity.position.distanceTo(origin) > .01,
    planning: { version: plannerVersion, plans, nodes, blockReads: reads, legs, distance: Number(travelled.toFixed(3)),
      ...(groundingWaitMs > 0 ? { groundingWaitMs } : {}) },
    ...(lastMovement ? { lastMovement } : {}) });
  const refresh = () => {
    check();
    if (target.kind === 'area') return;
    if (target.kind === 'block') {
      const b = get(target.position);
      if (!b || b.name !== blockIdentity.name || b.type !== blockIdentity.type) throw failure('target_changed', '目标方块已改变或卸载，请重新观察。');
    } else {
      const entity = bot.entities[target.id];
      // Never copy coordinates from a loaded-but-hidden target into planning or receipts.
      if (entity?.position?.distanceTo(origin) > limits.range) throw failure('target_out_of_range', '目标已超出本次靠近的局部范围。');
      if (!entity?.position || !controls.entityVisible(bot, entity)) throw failure('target_not_visible', '目标实体已不可见或卸载，停止追随。');
      const eye = eyes(bot.entity.position), height = entity.height || 1;
      if (![closest(eye, entity), entity.position.offset(0, height / 2, 0), entity.position.offset(0, height * .9, 0)]
        .some(p => lineClear(get, eye, p))) throw failure('target_not_visible', '目标实体的视线被遮挡或经过未知地形。');
      target = { kind: 'entity', id: entity.id, name: entity.name, width: entity.width, height: entity.height, position: entity.position.clone() };
    }
    if (target.position.distanceTo(origin) > limits.range) throw failure('target_out_of_range', '目标已超出本次靠近的局部范围。');
  };
  const arrived = () => bot.entity.onGround === true && Math.hypot(bot.entity.velocity?.x || 0, bot.entity.velocity?.z || 0) <= .025
    && withinReach(bot.entity.position, target) && sight(bot.entity.position, target)
    && (target.kind !== 'block' || bot.canSeeBlock(get(target.position)))
    && (target.kind !== 'area' || standable(bot.entity.position));
  const waitForGround = async () => {
    if (bot.entity.onGround === true) return;
    // A knockback/jump can be in flight when the NPC chooses to leave. Let
    // ordinary physics land before choosing the planner's start cell. This
    // bounded wait never changes velocity/position or borrows a new deadline.
    stopControls();
    const started = Date.now();
    try {
      while (bot.entity.onGround !== true) {
        refresh();
        const remaining = limits.groundingMs - groundingWaitMs - (Date.now() - started);
        if (remaining <= 0) throw failure('not_grounded', '短暂等待后身体仍未着地，停止规划路线。');
        await delay(Math.min(50, remaining), undefined, { signal: controller.signal });
      }
      refresh();
    } finally { groundingWaitMs += Date.now() - started; }
  };
  try {
    check();
    if (plannerVersion !== '2.4.5') throw failure('unsupported_planner', '身体的纯规划入口仅验证了 mineflayer-pathfinder 2.4.5。');
    if (travel) {
      if (!Number.isFinite(proposal?.x) || !Number.isFinite(proposal?.z)) throw failure('invalid_target', 'travel 必须指定有限的水平坐标 x、z。');
      target = { kind: 'area', x: proposal.x, z: proposal.z };
      if (reach(origin, target) > limits.range) throw failure('target_out_of_range', '目标水平坐标超出本次32格局部范围。');
    } else {
    const hasPosition = proposal?.position && ['x', 'y', 'z'].every(axis => Number.isFinite(proposal.position[axis]));
    const hasEntity = Number.isInteger(proposal?.entityId) && proposal.entityId >= 0;
    if (Boolean(hasPosition) === hasEntity || (proposal?.position !== undefined && proposal?.entityId !== undefined))
      throw failure('invalid_target', 'approach 必须指定一个方块 position 或 entityId。');
    if (hasPosition) {
      const position = point(proposal.position).floored(), block = get(position);
      if (!block || ['air', 'cave_air', 'void_air'].includes(block.name) || !bot.canSeeBlock(block)) throw failure('target_not_visible', '目标必须是已加载且当前可见的实际方块。');
      const observed = { kind: 'block', position, name: block.name };
      if (!sight(bot.entity.position, observed)) throw failure('target_not_visible', '目标方块的视线被遮挡或经过未知地形。');
      blockIdentity = { name: block.name, type: block.type }; target = observed;
    } else {
      target = { kind: 'entity', id: proposal.entityId };
    }
    }
    refresh();
    if (arrived()) return summary(true);
    while (plans < limits.plans && legs < limits.legs && travelled < limits.distance) {
      check(); refresh();
      if (arrived()) return summary(true);
      await waitForGround();
      if (arrived()) return summary(true);
      const snapshot = { ...target, ...(target.position ? { position: target.position.clone() } : {}) }, cache = new Map<string, any>();
      const plannerGet = (p: Vec3) => {
        const key = positionKey(p);
        if (!cache.has(key)) cache.set(key, get(p));
        return cache.get(key);
      };
      const facade = { registry: bot.registry, game: { minY: bot.game?.minY ?? -64 },
        inventory: { items: () => [] }, entities: {}, entity: bot.entity, blockAt: plannerGet };
      const movements = new Movements(facade);
      movements.canDig = false; movements.allow1by1towers = false; movements.allowParkour = false;
      movements.allowSprinting = false; movements.canOpenDoors = false; movements.allowEntityDetection = false;
      // Pathfinder 2.4.5 counts down to the supporting block, one below the
      // landing feet. Four here permits a three-block foot descent; the explicit
      // foot delta filter below and nativeWalkTo still reject larger drops.
      movements.maxDropDown = 4; movements.infiniteLiquidDropdownDistance = false; movements.scafoldingBlocks = []; movements.climbables.clear();
      for (const name of HAZARDS) if (bot.registry.blocksByName[name]) movements.blocksToAvoid.add(bot.registry.blocksByName[name].id);
      const goal = { heuristic: (n: Vec3) => {
        const p = n.offset(.5, 0, .5);
        if (snapshot.kind === 'area') return Math.max(0, reach(p, snapshot) - 1);
        const dy = snapshot.position.y - p.y;
        return isDroppedItem(snapshot) ? Math.max(0, reach(p, snapshot) - PICKUP.plannedHorizontal, dy - PICKUP.maxY, PICKUP.minY - dy)
          : Math.max(0, reach(p, snapshot) - (snapshot.kind === 'block' ? 4 : 2.5));
      },
        isEnd: (n: Vec3) => {
          const p = n.offset(.5, 0, .5);
          return withinReach(p, snapshot, true) && standable(p, plannerGet) && sight(p, snapshot, plannerGet);
        } };
      const neighborSource = { getNeighbors: (node: any) => {
        check(); if (++nodes > limits.nodes) throw failure('node_budget', '本次靠近的规划节点预算已用完。');
        return movements.getNeighbors(node).filter((next: any) => !next.toBreak.length && !next.toPlace.length && !next.parkour
          && Math.abs(next.x - node.x) + Math.abs(next.z - node.z) === 1 && next.y - node.y <= 1 && node.y - next.y <= 3
          && next.offset(.5, 0, .5).distanceTo(origin) <= limits.range && standable(next.offset(.5, 0, .5), plannerGet));
      } };
      const start = bot.entity.position.floored(); plans++;
      const search = new AStar(new Move(start.x, start.y, start.z, 0, 0), neighborSource, goal, limits.planMs, limits.tickMs, limits.range);
      let plan: any;
      do { check(); plan = search.compute(); if (plan.status === 'partial') await yieldTurn(); } while (plan.status === 'partial');
      check();
      const routeFailure = plan.status === 'success' ? undefined : failure(plan.status === 'timeout' ? 'planning_budget' : 'no_path',
        travel ? '本次有界规划未找到通往目标区域的已知落脚路线；未知地形与其他路线仍未验证。' : '本次有界规划未找到可交互站位；未知地形与其他路线仍未验证。');
      // AStar retains its best reachable path on noPath. Travel may take that
      // existing prefix once if it advances toward the requested XZ, without
      // turning the reachable endpoint into a new goal or starting exploration.
      const recovering = travel && plan.status === 'noPath' && plan.path.length > 0
        && reach(plan.path.at(-1).offset(.5, 0, .5), snapshot) <= reach(bot.entity.position, snapshot) - .5;
      if (routeFailure && !recovering) throw routeFailure;
      // An empty successful path means the cell centre is a valid goal, not that
      // the actual offset body is already centred/grounded/stationary.
      const route = plan.path.length ? plan.path : [new Move(start.x, start.y, start.z, 0, 0)];
      for (const node of route) {
        check(); refresh();
        if (arrived()) return summary(true);
        if (snapshot.kind === 'entity' && target.position.distanceTo(snapshot.position) > .5) break;
        if (legs >= limits.legs || travelled >= limits.distance) throw failure('movement_budget', '本次靠近的移动预算已用完。');
        const next = node.offset(.5, 0, .5);
        if (travelled + bot.entity.position.distanceTo(next) > limits.distance) throw failure('movement_budget', '本次靠近的移动预算已用完。');
        if (!standable(next)) break; // Replan a changed wall/floor without issuing a move into it.
        if (recovering && (!lineClear(get, eyes(bot.entity.position), next.offset(0, .01, 0))
          || !lineClear(get, eyes(bot.entity.position), next.offset(0, 1.5, 0)))) break;
        const before = bot.entity.position.clone(); legs++;
        const legController = new AbortController(), forwardAbort = () => legController.abort(controller.signal.reason);
        controller.signal.addEventListener('abort', forwardAbort, { once: true });
        let visibilityFailure: any;
        const monitor = target.kind === 'entity' ? setInterval(() => {
          try { refresh(); } catch (error) { visibilityFailure = error; legController.abort(error); stopControls(); }
        }, 50) : undefined;
        try { await controls.moveTo(bot, next, legController.signal, .12); }
        catch (error: any) {
          check(); if (visibilityFailure) throw visibilityFailure;
          // Planner/body collision knowledge must not become a hidden-resource
          // report. Retain the native failure code, not its arbitrary block data.
          lastMovement = { message: String(error.message).slice(0, 240),
            ...(error.details?.movement?.reasonCode ? { reasonCode: error.details.movement.reasonCode } : {}) }; break;
        } finally {
          clearInterval(monitor); controller.signal.removeEventListener('abort', forwardAbort);
          travelled += before.distanceTo(bot.entity.position); stopControls();
        }
        if (visibilityFailure) throw visibilityFailure;
        check(); refresh();
        if (arrived()) return summary(true);
      }
      if (routeFailure) throw routeFailure;
    }
    throw failure('movement_budget', '本次靠近的重规划或移动预算已用完。');
  } catch (error: any) {
    const code = controller.signal.aborted ? expired ? 'time_limit' : 'cancelled' : error.approachCode || 'native_failed';
    const result = controller.signal.aborted ? failure(code, `${actionLabel}${expired ? '已超时。' : '已取消。'}`) : error;
    result.details = { ...error.details, [travel ? 'travel' : 'approach']: { ...summary(false), stoppedReason: code } };
    throw result;
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', stopControls); stopControls();
  }
}

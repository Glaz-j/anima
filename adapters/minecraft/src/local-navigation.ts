import { Vec3 } from 'vec3';

/** Local motor planning only: no resource search, block edits or entity pursuit. */
export const LOCAL_NAVIGATION_BUDGET = Object.freeze({
  radius: 4, vertical: 3, nodes: 96, candidates: 512, blockReads: 4096,
  sightLines: 512, plans: 8, legs: 12, plannedDistance: 24, durationMs: 12000,
});
const CUBE = [[0, 0, 0, 1, 1, 1]];
const HAZARDS = new Set(['lava', 'water', 'fire', 'soul_fire', 'magma_block', 'cactus',
  'sweet_berry_bush', 'powder_snow', 'campfire', 'soul_campfire', 'wither_rose']);
const key = (p: Vec3) => `${Math.floor(p.x)},${Math.floor(p.y + .01)},${Math.floor(p.z)}`;
const fullCube = (b: any) => b?.boundingBox === 'block' && (!Array.isArray(b.shapes) ||
  b.shapes.some((s: number[]) => s.length === 6 && s.every((v, i) => v === CUBE[0][i])));
const clear = (b: any) => b?.boundingBox === 'empty' && !HAZARDS.has(b.name);

function intersects(block: any, cell: Vec3, origin: Vec3, delta: Vec3) {
  const shapes = Array.isArray(block.shapes) ? block.shapes : block.boundingBox === 'block' ? CUBE : [];
  return shapes.some((shape: number[]) => {
    let near = 0, far = 1;
    for (let i = 0; i < 3; i++) {
      const axis = (['x', 'y', 'z'] as const)[i], d = delta[axis];
      const lo = cell[axis] + shape[i], hi = cell[axis] + shape[i + 3];
      if (Math.abs(d) < 1e-9) { if (origin[axis] <= lo || origin[axis] >= hi) return false; }
      else {
        const a = (lo - origin[axis]) / d, b = (hi - origin[axis]) / d;
        near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b));
        if (far <= near + 1e-8) return false;
      }
    }
    return far > 1e-6 && near < 1 - 1e-6;
  });
}

function loadedSightLine(get: (cell: Vec3) => any, eye: Vec3, point: Vec3, maxCells: number) {
  const delta = point.minus(eye), cell = eye.floored(), end = point.floored();
  const step = new Vec3(Math.sign(delta.x), Math.sign(delta.y), Math.sign(delta.z));
  const next = (axis: 'x' | 'y' | 'z') => delta[axis] === 0 ? Infinity
    : (cell[axis] + (step[axis] > 0 ? 1 : 0) - eye[axis]) / delta[axis];
  const t = { x: next('x'), y: next('y'), z: next('z') };
  for (let n = 0; n < maxCells; n++) {
    const b = get(cell);
    if (!b || intersects(b, cell, eye, delta)) return false;
    if (cell.equals(end)) return true;
    const axis = t.x <= t.y && t.x <= t.z ? 'x' : t.y <= t.z ? 'y' : 'z';
    if (t[axis] > 1) return false;
    cell[axis] += step[axis]; t[axis] += Math.abs(1 / delta[axis]);
  }
  return false;
}

/** Reject only an actual body collision with a surface visible from this eye. */
function visibleDestinationBlocker(bot: any, target: Vec3) {
  const origin: Vec3 = bot.entity.position;
  if (origin.distanceTo(target) > 32) return null;
  const eye = origin.offset(0, bot.entity.eyeHeight || 1.62, 0), cache = new Map<string, any>();
  const get = (p: Vec3) => {
    const cell = p.floored(), id = key(cell);
    if (cache.has(id)) return cache.get(id);
    if (cache.size >= 1024) return null;
    let block: any; try { block = bot.blockAt(cell) || null; } catch { block = null; }
    cache.set(id, block); return block;
  };
  const half = (bot.entity.width || .6) / 2, height = bot.entity.height || 1.8;
  const min = target.offset(-half, 0, -half), max = target.offset(half, height, half);
  for (let x = Math.floor(min.x + .001); x <= Math.floor(max.x - .001); x++)
    for (let z = Math.floor(min.z + .001); z <= Math.floor(max.z - .001); z++)
      for (let y = Math.floor(min.y + .001); y <= Math.floor(max.y - .001); y++) {
        const cell = new Vec3(x, y, z), block = get(cell);
        if (!block) continue;
        const shapes = Array.isArray(block.shapes) ? block.shapes : block.boundingBox === 'block' ? CUBE : [];
        for (const shape of shapes) {
          if (!['x', 'y', 'z'].every((axis, i) => Math.min(max[axis], cell[axis] + shape[i + 3]) >
            Math.max(min[axis], cell[axis] + shape[i]) + .001)) continue;
          const center = cell.offset((shape[0] + shape[3]) / 2, (shape[1] + shape[4]) / 2, (shape[2] + shape[5]) / 2);
          for (const [axis, i] of [['x', 0], ['y', 1], ['z', 2]] as const) for (const sign of [-1, 1]) {
            const surface = center.clone(); surface[axis] = cell[axis] + shape[i + (sign > 0 ? 3 : 0)] + sign * .001;
            if ((eye[axis] - surface[axis]) * sign <= 0) continue;
            if (loadedSightLine(get, eye, surface, 128)) return { name: block.name, position: { ...cell } };
          }
        }
      }
  return null;
}

/** Only vertices visible from this actual eye position enter the search graph. */
export function planLocalRoute(bot: any, target: Vec3, visited = new Set<string>(), blocked = new Set<string>()) {
  const origin: Vec3 = bot.entity.position.clone(), base = origin.floored();
  const eye = origin.offset(0, bot.entity.eyeHeight || 1.62, 0), budget = LOCAL_NAVIGATION_BUDGET;
  const cache = new Map<string, any>(); let reads = 0, candidates = 0, rays = 0;
  let truncated = false;
  const get = (p: Vec3) => {
    const c = p.floored(), id = key(c);
    if (Math.abs(c.x - base.x) > budget.radius + 1 || Math.abs(c.z - base.z) > budget.radius + 1 ||
      c.y < base.y - budget.vertical - 1 || c.y > base.y + budget.vertical + 2) return null;
    if (cache.has(id)) return cache.get(id);
    if (reads >= budget.blockReads) { truncated = true; return null; }
    reads++;
    let b: any; try { b = bot.blockAt(c) || null; } catch { b = null; }
    cache.set(id, b); return b;
  };
  const visible = (point: Vec3) => {
    if (rays >= budget.sightLines) { truncated = true; return false; }
    rays++;
    return loadedSightLine(get, eye, point, 48);
  };
  const bodyClear = (p: Vec3) => {
    const half = (bot.entity.width || .6) / 2 - .001, height = bot.entity.height || 1.8;
    for (let x = Math.floor(p.x - half); x <= Math.floor(p.x + half); x++)
      for (let z = Math.floor(p.z - half); z <= Math.floor(p.z + half); z++)
        for (let y = Math.floor(p.y + .001); y <= Math.floor(p.y + height - .001); y++)
          if (!clear(get(new Vec3(x, y, z)))) return false;
    return true;
  };
  const standable = (p: Vec3) => {
    const floor = get(p.offset(0, -1, 0));
    return fullCube(floor) && !HAZARDS.has(floor.name) && bodyClear(p) &&
      eye.y > p.y && visible(p.offset(0, .001, 0)) && visible(p.offset(0, 1.5, 0));
  };
  const edgeClear = (from: Vec3, to: Vec3) => {
    // Four-neighbour edges avoid corner cutting. Check the lifted body corridor
    // as well as the landing; a one-block step still needs jumping headroom.
    const y = Math.max(from.y, to.y), length = Math.hypot(to.x - from.x, to.z - from.z);
    const steps = Math.max(1, Math.ceil(length / .2));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, p = new Vec3(from.x + (to.x - from.x) * t, y, from.z + (to.z - from.z) * t);
      if (!bodyClear(p)) return false;
    }
    for (let y = to.y; y < from.y; y++) if (!bodyClear(new Vec3(to.x, y, to.z))) return false;
    return true;
  };
  type Node = { point: Vec3; parent?: Node; cost: number };
  const root: Node = { point: origin, cost: 0 }, queue = [root], seen = new Map([[key(origin), root]]);
  let best: Node | undefined, complete: Node | undefined;
  const distance = (p: Vec3) => p.distanceTo(target);
  const score = (n: Node) => distance(n.point) + n.cost * .3;
  while (queue.length && seen.size < budget.nodes && candidates < budget.candidates) {
    queue.sort((a, b) => score(a) - score(b));
    const node = queue.shift()!, cell = node.point.floored();
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1, -1, -2, -3]) {
      if (candidates >= budget.candidates || seen.size >= budget.nodes) { truncated = true; break; }
      const p = new Vec3(cell.x + dx + .5, Math.floor(node.point.y + .01) + dy, cell.z + dz + .5), id = key(p);
      if (seen.has(id) || blocked.has(id) || Math.hypot(p.x - origin.x, p.z - origin.z) > budget.radius ||
        Math.abs(p.y - base.y) > budget.vertical) continue;
      candidates++;
      if (!standable(p) || !edgeClear(node.point, p)) continue;
      const next: Node = { point: p, parent: node, cost: node.cost + node.point.distanceTo(p) };
      seen.set(id, next); queue.push(next);
      if (id === key(target) && Math.abs(p.y - target.y) <= .125) { complete = next; break; }
      if (!visited.has(id) && (!best || score(next) < score(best))) best = next;
    }
    if (complete) break;
  }
  // The start cell can contain an exact requested point after approaching it.
  if (key(origin) === key(target) && Math.abs(origin.y - target.y) <= .125 && bodyClear(target)) complete = root;
  const chosen = complete || best, path: Vec3[] = [];
  for (let n = chosen; n?.parent; n = n.parent) path.unshift(n.point);
  if (complete && (!path.length || path.at(-1)!.distanceTo(target) > .01)) path.push(target.clone());
  return { waypoints: path, complete: Boolean(complete), nodes: seen.size, candidates, reads, truncated };
}

const RECOVERABLE = new Set(['step_blocked', 'head_blocked', 'unsupported_drop', 'no_progress', 'vertical_only']);
const reached = (bot: any, target: Vec3) => bot.entity.onGround === true &&
  Math.hypot(target.x - bot.entity.position.x, target.z - bot.entity.position.z) <= .45 &&
  Math.floor(target.y + .01) === Math.floor(bot.entity.position.y + .01) &&
  Math.abs(target.y - bot.entity.position.y) <= .125 &&
  Math.hypot(bot.entity.velocity?.x || 0, bot.entity.velocity?.z || 0) <= .025;

/** Augment an NPC-selected goto; every actual movement remains in nativeWalkTo. */
export async function navigateLocally(bot: any, target: Vec3, signal: AbortSignal,
  walk: (bot: any, target: Vec3, signal: AbortSignal, radius?: number) => Promise<unknown>) {
  const budget = LOCAL_NAVIGATION_BUDGET, controller = new AbortController(), origin = bot.entity.position.clone();
  let expired = false, plans = 0, legs = 0, plannedDistance = 0, segmentDisplacementSum = 0, initial: any, latest: any;
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(() => {
    if (controller.signal.aborted) return; // Preserve whichever cancellation won while native cleanup drains.
    expired = true; controller.abort();
  }, budget.durationMs);
  const visited = new Set([key(origin)]), blocked = new Set<string>();
  const summary = () => ({ mode: 'visible-local-detour', target: { ...target }, current: { ...bot.entity.position },
    plans, legs, plannedDistance: Number(plannedDistance.toFixed(3)),
    // Endpoint displacements are not a measurement of the physics trajectory.
    segmentDisplacementSum: Number(segmentDisplacementSum.toFixed(3)), reached: reached(bot, target),
    partial: segmentDisplacementSum > .01 || origin.distanceTo(bot.entity.position) > .01,
    ...(latest ? { lastLegFailure: { message: latest.message, movement: latest.details?.movement } } : {}) });
  const fail = (reason: string) => {
    const interrupted = reason === 'cancelled' || reason === 'time_limit';
    const original = initial || new Error(reason), movement = original.details?.movement;
    const rawCause = controller.signal.reason;
    const cause = (typeof rawCause === 'string' ? rawCause : rawCause instanceof Error ? rawCause.message
      : [rawCause?.type, rawCause?.event].filter(value => typeof value === 'string').join(':')).slice(0, 240);
    // A detour may already have passed its initial obstacle before the body is
    // interrupted. Preserve that evidence without presenting it as the stop cause.
    const error: any = interrupted ? new Error(reason === 'time_limit' ? '导航已超时。'
      : `导航已取消${cause ? `：${cause}` : '。'}`) : original;
    error.details = { ...original.details, ...(movement || interrupted ? { movement: {
      ...(interrupted ? { reasonCode: reason } : movement), target: { ...target },
      current: { ...bot.entity.position }, horizontalDistance: Number(Math.hypot(target.x - bot.entity.position.x, target.z - bot.entity.position.z).toFixed(3)),
      verticalDelta: Number((target.y - bot.entity.position.y).toFixed(3)) } } : {}), navigation: { ...summary(), stoppedReason: reason,
      ...(interrupted ? { initialFailure: original.details?.navigation?.initialFailure || { message: original.message, ...(movement ? { movement } : {}) } } : {}) } };
    return error;
  };
  const rejectBlockedTarget = () => {
    if (controller.signal.aborted) throw fail(expired ? 'time_limit' : 'cancelled');
    const blocker = visibleDestinationBlocker(bot, target);
    if (!blocker) return;
    // Only the witnessed colliding block is disclosed. Hidden/unknown target
    // geometry is not classified as blocked and remains eligible for exploration.
    initial = Object.assign(new Error('目标站立位置与当前可见实体方块重叠，无法通过绕行进入；请重新观察并选择行动。'), {
      details: { movement: { reasonCode: 'target_blocked', blocker } },
    });
    throw fail('target_blocked');
  };
  try {
    if (controller.signal.aborted) throw new Error('行动已取消或超时。');
    rejectBlockedTarget();
    try {
      await walk(bot, target, controller.signal);
      rejectBlockedTarget();
      if (reached(bot, target)) return { movement: 'native-short-walk', reached: true };
      throw new Error('移动尚未在原目标稳定着地。');
    } catch (error: any) {
      initial = error;
      if (controller.signal.aborted || !RECOVERABLE.has(error.details?.movement?.reasonCode)) throw error;
    }
    while (plans < budget.plans && legs < budget.legs && plannedDistance < budget.plannedDistance) {
      if (controller.signal.aborted) throw fail(expired ? 'time_limit' : 'cancelled');
      if (bot.entity.onGround !== true) throw fail('not_grounded');
      rejectBlockedTarget();
      const route = planLocalRoute(bot, target, visited, blocked); plans++;
      if (!route.waypoints.length) throw fail('no_visible_route');
      // Partial routes move to a visible frontier, then re-observe from there.
      for (const point of route.waypoints) {
        if (controller.signal.aborted) throw fail(expired ? 'time_limit' : 'cancelled');
        rejectBlockedTarget();
        const length = bot.entity.position.distanceTo(point);
        if (legs >= budget.legs || plannedDistance + length > budget.plannedDistance) throw fail('movement_budget');
        const before = bot.entity.position.clone(); legs++; plannedDistance += length;
        // Intermediate centres need tighter alignment than the final goal so
        // the next cardinal leg does not cut a wall corner with the body edge.
        try { await walk(bot, point, controller.signal, point.equals(target) ? .45 : .12); }
        catch (error: any) {
          latest = error; blocked.add(key(point));
          if (controller.signal.aborted || !RECOVERABLE.has(error.details?.movement?.reasonCode)) throw fail(expired ? 'time_limit' : signal.aborted ? 'cancelled' : 'native_rejected');
          break;
        } finally { segmentDisplacementSum += before.distanceTo(bot.entity.position); }
        rejectBlockedTarget();
        visited.add(key(point));
        if (reached(bot, target)) return { movement: 'native-local-navigation', reached: true, navigation: summary() };
      }
    }
    throw fail('search_budget');
  } catch (error: any) {
    initial ||= error;
    throw fail(expired ? 'time_limit' : signal.aborted ? 'cancelled' : error.details?.navigation?.stoppedReason || 'native_rejected');
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', abort);
    try { bot.clearControlStates(); } catch { /* Disconnection may already have closed the client. */ }
  }
}

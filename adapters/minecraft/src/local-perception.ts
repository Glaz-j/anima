import { Vec3 } from 'vec3';

type Point = [number, number, number];
type Standing = { feet: Point; deltaY: number; support: string };
type Placement = { target: Point; reference: Point; face: Point };
type Hazard = { position: Point; name: string };

export type LocalTerrain = {
  scope: 'visible-loaded-local'; origin: Point | null; radius: number;
  routeUnverified: true; standable: Standing[]; placeable: Placement[]; hazards: Hazard[];
};

export const LOCAL_PERCEPTION_BUDGET = Object.freeze({
  radius: 3, minDy: -3, maxDy: 2, standable: 6, placeable: 6, hazards: 3,
  blockReads: 1024, sightLines: 256, bytes: 2048,
});

const AIR = new Set(['air', 'cave_air', 'void_air']);
const HAZARDS = new Set(['lava', 'water', 'fire', 'soul_fire', 'magma_block', 'cactus',
  'sweet_berry_bush', 'powder_snow', 'campfire', 'soul_campfire', 'wither_rose']);
// Match native-actions.ts: placement uses the first solid neighbour, not a
// hypothetical more convenient face selected by this observation helper.
const FACES: Point[] = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]];
const CUBE = [[0, 0, 0, 1, 1, 1]];
const tuple = (p: Vec3): Point => [p.x, p.y, p.z];
const finite = (p: any) => p && [p.x, p.y, p.z].every(Number.isFinite);
const nameOf = (b: any) => String(b.name || '').slice(0, 64);
const fullCube = (b: any) => b?.boundingBox === 'block' &&
  (!Array.isArray(b.shapes) || b.shapes.some((s: number[]) => s.length === 6 && s.every((v, i) => v === CUBE[0][i])));
const safeAir = (b: any) => b?.boundingBox === 'empty' && !HAZARDS.has(b.name);

/** Does the open sight segment intersect a loaded block's collision geometry? */
function obstructs(block: any, cell: Vec3, from: Vec3, delta: Vec3) {
  const shapes = Array.isArray(block.shapes) ? block.shapes : block.boundingBox === 'block' ? CUBE : [];
  return shapes.some((shape: number[]) => {
    let near = 0, far = 1;
    for (let axis = 0; axis < 3; axis++) {
      const key = (['x', 'y', 'z'] as const)[axis], v = delta[key];
      const low = cell[key] + shape[axis], high = cell[key] + shape[axis + 3];
      if (Math.abs(v) < 1e-9) {
        if (from[key] <= low || from[key] >= high) return false;
      } else {
        const a = (low - from[key]) / v, b = (high - from[key]) / v;
        near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b));
        if (far <= near + 1e-8) return false;
      }
    }
    return far > 1e-6 && near < 1 - 1e-6;
  });
}

/**
 * A bounded, synchronous observation. Never moves, loads chunks, finds ores or
 * chooses a route. Coordinates are [x,y,z]; standable.feet is a block centre,
 * while placeable.target is the EMPTY cell accepted by the place action.
 * Conservative integer-height candidates omit slabs, fences and hidden gaps.
 */
export function localPerception(bot: any): LocalTerrain {
  const position = bot.entity?.position;
  const result: LocalTerrain = { scope: 'visible-loaded-local', origin: finite(position)
    ? [position.x, position.y, position.z].map(v => Number(v.toFixed(3))) as Point : null,
  radius: LOCAL_PERCEPTION_BUDGET.radius, routeUnverified: true, standable: [], placeable: [], hazards: [] };
  if (!finite(position) || typeof bot.blockAt !== 'function') return result;
  const origin = new Vec3(position.x, position.y, position.z), base = origin.floored();
  const eye = origin.offset(0, bot.entity.eyeHeight || 1.62, 0);
  const cache = new Map<string, any>();
  let reads = 0, sightLines = 0;
  const get = (p: Vec3) => {
    const cell = p.floored(), key = cell.toString();
    // The extra ring is only for a candidate's adjacent support / sight line.
    if (Math.abs(cell.x - base.x) > 4 || Math.abs(cell.z - base.z) > 4 ||
      cell.y < base.y - 4 || cell.y > base.y + 3) return null;
    if (cache.has(key)) return cache.get(key);
    if (++reads > LOCAL_PERCEPTION_BUDGET.blockReads) return null;
    let block: any;
    try { block = bot.blockAt(cell) || null; } catch { block = null; }
    cache.set(key, block); return block;
  };
  const visible = (point: Vec3) => {
    if (++sightLines > LOCAL_PERCEPTION_BUDGET.sightLines) return false;
    const delta = point.minus(eye), cell = eye.floored(), end = point.floored();
    const step = new Vec3(Math.sign(delta.x), Math.sign(delta.y), Math.sign(delta.z));
    const next = (axis: 'x' | 'y' | 'z') => delta[axis] === 0 ? Infinity :
      (cell[axis] + (step[axis] > 0 ? 1 : 0) - eye[axis]) / delta[axis];
    const t = { x: next('x'), y: next('y'), z: next('z') };
    for (let count = 0; count < 32; count++) {
      const block = get(cell);
      // Unlike a normal raycast, an unloaded cell is NOT transparent.
      if (!block || obstructs(block, cell, eye, delta)) return false;
      if (cell.equals(end)) return true;
      const axis = t.x <= t.y && t.x <= t.z ? 'x' : t.y <= t.z ? 'y' : 'z';
      if (t[axis] > 1) return false;
      cell[axis] += step[axis]; t[axis] += Math.abs(1 / delta[axis]);
    }
    return false;
  };
  const faceVisible = (cell: Vec3, face: Point) => {
    const center = cell.offset(.5, .5, .5), normal = new Vec3(...face);
    const surface = center.plus(normal.scaled(.501));
    const towardEye = eye.minus(surface);
    return towardEye.dot(normal) > 0 && visible(surface);
  };
  const occupied = (cell: Vec3) => {
    const entities = [bot.entity, ...Object.values(bot.entities || {})];
    return entities.some((entity: any) => {
      if (!finite(entity?.position) || entity.name === 'item' || entity.name === 'experience_orb') return false;
      const p = entity.position, half = (entity.width || .6) / 2, height = entity.height || 1.8;
      return p.x + half > cell.x && p.x - half < cell.x + 1 &&
        p.z + half > cell.z && p.z - half < cell.z + 1 && p.y + height > cell.y && p.y < cell.y + 1;
    });
  };
  const columns: { dx: number; dz: number }[] = [];
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
    if (dx * dx + dz * dz <= 9) columns.push({ dx, dz });
  }
  columns.sort((a, b) => a.dx * a.dx + a.dz * a.dz - b.dx * b.dx - b.dz * b.dz);
  for (const { dx, dz } of columns) for (const dy of [0, 1, -1, -2, -3, 2]) {
    const cell = base.offset(dx, dy, dz), block = get(cell);
    if (!block) continue;
    if (result.hazards.length < LOCAL_PERCEPTION_BUDGET.hazards && HAZARDS.has(block.name) &&
      (block.boundingBox === 'empty' ? visible(cell.offset(.5, .5, .5)) : FACES.some(f => faceVisible(cell, f)))) {
      result.hazards.push({ position: tuple(cell), name: nameOf(block) });
    }
    if (result.standable.length < LOCAL_PERCEPTION_BUDGET.standable && (dx || dz) && dy <= 1 &&
      safeAir(block) && safeAir(get(cell.offset(0, 1, 0)))) {
      const floor = cell.offset(0, -1, 0), support = get(floor);
      if (fullCube(support) && !HAZARDS.has(support.name) && !occupied(cell) && !occupied(cell.offset(0, 1, 0)) &&
        faceVisible(floor, [0, 1, 0]) && visible(cell.offset(.5, 1.5, .5))) {
        result.standable.push({ feet: tuple(cell.offset(.5, 0, .5)), deltaY: dy, support: nameOf(support) });
      }
    }
    if (result.placeable.length >= LOCAL_PERCEPTION_BUDGET.placeable || !AIR.has(block.name) ||
      cell.distanceTo(origin) > 4.5 || occupied(cell)) continue;
    const face = FACES.find(f => get(cell.offset(-f[0], -f[1], -f[2]))?.boundingBox === 'block');
    if (!face) continue;
    const reference = cell.offset(-face[0], -face[1], -face[2]);
    if (!fullCube(get(reference)) || !faceVisible(reference, face) || !visible(cell.offset(.5, .5, .5))) continue;
    result.placeable.push({ target: tuple(cell), reference: tuple(reference), face: [...face] });
  }
  // Keep the adapter observation bounded even close to Minecraft's world edge.
  while (Buffer.byteLength(JSON.stringify(result), 'utf8') > LOCAL_PERCEPTION_BUDGET.bytes) {
    if (result.placeable.length) result.placeable.pop();
    else if (result.standable.length) result.standable.pop();
    else if (result.hazards.length) result.hazards.pop();
    else break;
  }
  return result;
}

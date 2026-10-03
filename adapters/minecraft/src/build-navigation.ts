import { Vec3 } from 'vec3';

const AIR = new Set(['air', 'cave_air', 'void_air']);
const HAZARDS = new Set(['lava', 'water', 'fire', 'soul_fire', 'magma_block', 'cactus', 'campfire', 'soul_campfire', 'powder_snow']);
const key = (p: Vec3) => `${Math.floor(p.x)},${Math.floor(p.y + .01)},${Math.floor(p.z)}`;

/** Loaded collision geometry only. Never excavates, scaffolds or teleports.
 * Search is confined to the explicit construction site, with a fixed budget. */
export function planBuildRoute(bot: any, targets: Vec3[], origin: {x:number;y:number;z:number}) {
  const goals = new Set(targets.map(key)), cache = new Map<string, any>();
  const get = (p: Vec3) => {
    const id = key(p);
    if (!cache.has(id)) cache.set(id, bot.blockAt(p.floored()) ?? null);
    return cache.get(id);
  };
  const clear = (p: Vec3) => AIR.has(get(p)?.name) && AIR.has(get(p.offset(0, 1, 0))?.name);
  const stand = (p: Vec3) => {
    const floor = get(p.offset(0, -1, 0));
    return floor?.boundingBox === 'block' && !HAZARDS.has(floor.name) && clear(p);
  };
  const start = bot.entity.position.floored().offset(.5, 0, .5);
  const queue = [start], parents = new Map<string, Vec3 | null>([[key(start), null]]);
  let chosen: Vec3 | undefined;
  for (let index = 0; index < queue.length && index < 4096; index++) {
    const p = queue[index];
    if (goals.has(key(p)) && stand(p)) { chosen = p; break; }
    for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) for (const dy of [0,1,-1]) {
      const n = p.offset(dx, dy, dz), id = key(n);
      if (parents.has(id) || parents.size >= 4096 || cache.size >= 20000
        || Math.hypot(n.x-origin.x,n.z-origin.z)>24 || n.y<origin.y-1 || n.y>origin.y+11) continue;
      if (!stand(n)) continue;
      // Jumping needs clearance above the departure; descending needs it
      // above the destination. Four-neighbour edges cannot cut wall corners.
      if (dy === 1 && !clear(p.offset(0,1,0)) || dy === -1 && !clear(n.offset(0,1,0))) continue;
      parents.set(id,p); queue.push(n);
    }
  }
  if (!chosen) return null;
  const route: Vec3[] = [];
  for (let p: Vec3 | null | undefined = chosen; p && parents.get(key(p)); p = parents.get(key(p))) route.unshift(p);
  if (!route.length && start.distanceTo(bot.entity.position)>.25) route.push(start);
  return { route, destination: chosen, nodes: parents.size, blockReads: cache.size };
}

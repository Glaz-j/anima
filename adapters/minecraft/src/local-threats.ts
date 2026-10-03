export const LOCAL_THREAT_TTL_MS = 10_000;
export const LOCAL_THREAT_RANGE = 24;
export const MAX_LOCAL_THREATS = 64;

type ThreatChecks = {
  isVisible: (entity: any) => boolean;
  /** Use the same local health interpretation as normal body perception. */
  isAlive?: (entity: any) => boolean;
  now?: () => number;
};

/** Evidence from this bot's entityHurt(victim, source), never nearby guesses.
 * The owner supplies lifecycle clear() calls and event subscriptions. This
 * module neither grants reactions nor sends game inputs, and cannot prevent
 * a neutral spider's first attack. */
export function createLocalThreats(bot: any, checks: ThreatChecks) {
  const now = checks.now ?? Date.now;
  const entries = new Map<number, { entity: any; victim: any; dimension: unknown; at: number }>();

  const clear = () => { entries.clear(); };
  const alive = (entity: any) => {
    try { return entity.health !== 0 && (!checks.isAlive || checks.isAlive(entity) === true); }
    catch { return false; }
  };
  const prune = (at: number) => {
    if (!Number.isFinite(at) || !bot.entity || bot.health <= 0) { clear(); return; }
    for (const [id, entry] of entries) {
      if (at < entry.at || at - entry.at >= LOCAL_THREAT_TTL_MS
        || entry.victim !== bot.entity || entry.dimension !== bot.game?.dimension
        || bot.entities?.[id] !== entry.entity || !alive(entry.entity)) entries.delete(id);
    }
  };
  const eligible = (entity: any) => {
    if (!bot.entity || bot.health <= 0 || !entity || entity === bot.entity
      || !Number.isInteger(entity.id) || entity.id === bot.entity.id
      || !['spider', 'cave_spider'].includes(entity.name)
      || entity.type === 'player' || entity.username !== undefined
      || bot.entities?.[entity.id] !== entity || !alive(entity)) return false;
    const from = bot.entity.position, to = entity.position;
    if (![from?.x, from?.y, from?.z, to?.x, to?.y, to?.z].every(Number.isFinite)
      || Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) > LOCAL_THREAT_RANGE) return false;
    try {
      return checks.isVisible(entity) === true;
    } catch {
      // Missing local perception remains unknown, not an aggression claim.
      return false;
    }
  };

  return {
    record(victim: any, source: any): boolean {
      const at = now(); prune(at);
      if (!Number.isFinite(at) || victim !== bot.entity || !eligible(source)) return false;
      // Refresh only on another confirmed self-hit. Reads cannot extend TTL.
      entries.delete(source.id);
      entries.set(source.id, { entity: source, victim, dimension: bot.game?.dimension, at });
      if (entries.size > MAX_LOCAL_THREATS) entries.delete(entries.keys().next().value!);
      return true;
    },
    has(entity: any): boolean {
      const at = now(); prune(at);
      const entry = entries.get(entity?.id);
      if (!entry || entry.entity !== entity) return false;
      if (!eligible(entity)) return false;
      return true;
    },
    clear,
  };
}

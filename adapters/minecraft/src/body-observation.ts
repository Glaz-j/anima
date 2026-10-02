/** Native self-body observations only. None of these values establish a safe
 * route, a breathable head position, or the cause of lost health. */
export interface BodyEnvironment {
  locomotion?: { inWater?: boolean; inLava?: boolean; onGround?: boolean };
  oxygen?: { level: number; max: 20; unit: 'native-oxygen' };
}

type SelfBreath = { entity?: object; airSupply?: number };
const breaths = new WeakMap<object, SelfBreath>();

/** Mineflayer 4.39's global oxygenLevel is also overwritten by OTHER entities'
 * air_supply metadata. Keep the same conversion, but accept only our own packet.
 * A login/respawn never inherits the previous body's last oxygen reading. */
export function trackBodyEnvironment(bot: any): () => void {
  const state: SelfBreath = {};
  breaths.set(bot, state);
  const reset = () => { state.entity = undefined; state.airSupply = undefined; };
  const metadata = (packet: any) => {
    const entity = bot.entity;
    if (!entity || packet.entityId !== entity.id || !Array.isArray(packet.metadata)) return;
    const keys = bot.registry?.entitiesByName?.[entity.name]?.metadataKeys;
    const index = Array.isArray(keys) ? keys.indexOf('air_supply') : -1;
    if (index < 0) return;
    const update = packet.metadata.find((entry: any) => entry.key === index);
    if (!update) return;
    const value = update.value;
    state.entity = entity;
    // Vanilla's air supply is 300 when full and briefly reaches -20 before a
    // drowning tick. Invalid/custom out-of-range values remain unknown.
    state.airSupply = Number.isInteger(value) && value >= -20 && value <= 300 ? value : undefined;
  };
  const cleanup = () => {
    reset(); breaths.delete(bot);
    bot._client.removeListener('entity_metadata', metadata);
    bot._client.removeListener('login', reset);
    bot._client.removeListener('respawn', reset);
    bot.removeListener('death', reset);
    bot.removeListener('end', cleanup);
  };
  bot._client.on('entity_metadata', metadata);
  bot._client.on('login', reset);
  bot._client.on('respawn', reset);
  bot.on('death', reset);
  bot.once('end', cleanup);
  return cleanup;
}

export function bodyEnvironment(bot: any): BodyEnvironment {
  const result: BodyEnvironment = {};
  const locomotion: NonNullable<BodyEnvironment['locomotion']> = {};
  for (const [field, native] of [['inWater', 'isInWater'], ['inLava', 'isInLava'], ['onGround', 'onGround']] as const) {
    if (typeof bot.entity?.[native] === 'boolean') locomotion[field] = bot.entity[native];
  }
  if (Object.keys(locomotion).length) result.locomotion = locomotion;
  const state = breaths.get(bot);
  if (state?.entity === bot.entity && state?.airSupply !== undefined) {
    // This is Mineflayer's rounded 0–20 scale, NOT seconds remaining. Negative
    // native air supply means exhausted air; never manufacture a negative reserve.
    result.oxygen = { level: Math.max(0, Math.round(state.airSupply / 15)), max: 20, unit: 'native-oxygen' };
  }
  return result;
}

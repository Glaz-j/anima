import { SURVIVAL_ROSTER, type SurvivalObservation, type SurvivalScenario } from './survival-scenario.ts';

export interface SurvivalActorReadiness {
  name: string;
  ready: boolean;
  inventorySynced?: boolean;
}
interface InitialWorld {
  bots: Map<string, SurvivalActorReadiness & { bot: { inventory: { slots: Array<{ name: string; count: number } | null> } } }>;
  observe(name: string): SurvivalObservation;
}

/** A connected socket or spawn event alone is not an inventory synchronization. */
export function survivalActorsReady(actors: Iterable<SurvivalActorReadiness>) {
  const records = [...actors];
  if (records.length !== SURVIVAL_ROSTER.length) return false;
  const byName = new Map(records.map(record => [record.name, record]));
  return SURVIVAL_ROSTER.every(({ name }) => {
    const record = byName.get(name);
    return record?.ready === true && record.inventorySynced === true;
  });
}

/**
 * First-start gate only, not the partial observer used during normal gameplay.
 * Read every actor first: a failed observation must not leave half a spawn audit.
 */
export function captureInitialSurvivalState(world: InitialWorld, scenario: SurvivalScenario) {
  if (!survivalActorsReady(world.bots.values())) throw new Error('All four survival participants must spawn and synchronize their inventories first.');
  const observations = SURVIVAL_ROSTER.map(({ name }) => {
    const record = world.bots.get(name)!;
    if (!Array.isArray(record.bot.inventory.slots)) throw new Error(`Inventory slots are unavailable for ${name}.`);
    const observation = world.observe(name);
    if (!Array.isArray(observation.inventory)) throw new Error(`Inventory observation is unavailable for ${name}.`);
    const fullInventory = record.bot.inventory.slots.filter(item => item !== null && item !== undefined).map(item => {
      if (typeof item.name !== 'string' || !Number.isInteger(item.count) || item.count <= 0) throw new Error(`Invalid synchronized inventory item for ${name}.`);
      return { name: item.name, count: item.count };
    });
    return { name, observation: { ...observation, fullInventory } };
  });
  for (const { name, observation } of observations) scenario.observe(name, observation);
  if (!scenario.status().progress.initialEmptyVerified) throw new Error('The four original spawn inventories were not all empty; this is not a from-scratch start.');
  return scenario.status().progress;
}

import { randomUUID } from 'node:crypto';
import { bodyEnvironment } from '../src/body-observation.ts';
import { entityHealth, entityVisible } from '../src/native-actions.ts';
import type { ExamEvent } from './types.ts';

const HOSTILE = new Set(['zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton', 'stray', 'wither_skeleton', 'creeper', 'blaze', 'pillager', 'vindicator', 'witch', 'endermite', 'silverfish']);
type Hazard = { id: string; lastSeen: number; responded: boolean };

/** A candidate-local, read-only observer with identical semantics in all
 * architectures. No authorization, referee state or RCON data enters it.
 * Latency ends at a relevant issued input, not proof of escape or a hit. */
export class ExamReactionObserver {
  private hazards = new Map<'water' | 'enemy', Hazard>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private bot: any;
  private currentAction: () => any;
  private emit: (event: ExamEvent) => void;
  private now: () => number;
  constructor(bot: any, currentAction: () => any, emit: (event: ExamEvent) => void, now = Date.now) {
    this.bot = bot; this.currentAction = currentAction; this.emit = emit; this.now = now;
  }

  start() {
    this.stopped = false;
    this.update();
    this.timer = setInterval(() => this.update(), 50);
    this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); this.timer = undefined; this.stopped = true; this.hazards.clear(); }

  update(at = this.now()) {
    if (this.stopped) return;
    const bot = this.bot, p = bot.entity?.position;
    if (!p || bot.health <= 0) return;
    const env = bodyEnvironment(bot);
    const head = bot.blockAt(p.offset(0, bot.entity.eyeHeight || 1.62, 0));
    const water = env.locomotion?.inWater === true &&
      (head?.name === 'water' || (env.oxygen?.level !== undefined && env.oxygen.level < 18));
    const enemy = Object.values(bot.entities || {}).some((entity: any) =>
      entity.id !== bot.entity.id && HOSTILE.has(entity.name) && entityHealth(bot, entity) !== 0
      && entity.position?.distanceTo(p) <= 7 && entityVisible(bot, entity));
    for (const [key, present] of [['water', water], ['enemy', enemy]] as const) {
      const hazard = this.hazards.get(key);
      if (present) {
        if (hazard) hazard.lastSeen = at;
        else {
          const id = randomUUID(); this.hazards.set(key, { id, lastSeen: at, responded: false });
          this.emit({ type: 'hazard-observed', at, hazardId: id, message: `local-${key}; observer-v2` });
        }
      } else if (hazard && at - hazard.lastSeen >= 1000) this.hazards.delete(key);
    }
  }

  input(event: ExamEvent) {
    if (this.stopped || event.type !== 'input') return;
    // Control can run before our 50ms sampling timer. Observe the same local
    // state now so the first real response cannot vanish between timer ticks.
    // A zero sample means response within this observation resolution.
    this.update(event.at);
    const action = this.currentAction();
    const moves = event.channel?.startsWith('key:') && event.value === true;
    const directed = event.channel === 'aim' || event.channel === 'use_entity' || moves;
    for (const [key, hazard] of this.hazards) {
      if (hazard.responded || event.at - hazard.lastSeen >= 1000) continue;
      const relevant = key === 'water'
        ? (event.channel === 'key:jump' && event.value === true) || (action?.type === 'surface' && directed)
        : ['combat', 'retreat', 'attack', 'shoot'].includes(action?.type) && directed;
      if (!relevant) continue;
      hazard.responded = true;
      this.emit({ type: 'reaction', at: event.at, hazardId: hazard.id, message: 'issued-response; observer-v2' });
    }
  }
}

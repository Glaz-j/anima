import { setTimeout as delay } from 'node:timers/promises';
import { LocalRcon, parseSnbt } from './rcon.ts';
import type { ExamServerConfig } from './server.ts';
import type { Capability, EnemySpec, ExamAdapter, ExamTask, ServerEvidence, Vec } from './types.ts';

const STATS = {
  deaths: ['ex_deaths', 'deathCount'], damage: ['ex_damage', 'minecraft.custom:minecraft.damage_taken'],
  jump: ['ex_jump', 'minecraft.custom:minecraft.jump'], placed_cobblestone: ['ex_place', 'minecraft.used:minecraft.cobblestone'],
  killed_zombie: ['ex_zombie', 'minecraft.killed:minecraft.zombie'], killed_skeleton: ['ex_skeleton', 'minecraft.killed:minecraft.skeleton'],
  crafted_pickaxe: ['ex_craft', 'minecraft.crafted:minecraft.wooden_pickaxe'],
  mined_oak: ['ex_oak', 'minecraft.mined:minecraft.oak_log'], ate_beef: ['ex_eat', 'minecraft.used:minecraft.cooked_beef'],
} as const;
const pos = (position: Vec) => {
  if (Object.values(position).some(n => !Number.isFinite(n) || Math.abs(n) > 1000)) throw new Error('Invalid arena coordinates.');
  return `${position.x} ${position.y} ${position.z}`;
};
const identifier = (value: string) => { if (!/^[a-z][a-z0-9_]*$/u.test(value)) throw new Error('Invalid arena identifier.'); return value; };
function checked(response: string, command: string) {
  if (/Unknown or incomplete command|Incorrect argument|Expected |Invalid |No player was found|No entity was found|Could not |Unable to |Cannot /u.test(response)) {
    throw new Error(`Arena command failed (${command.split(' ')[0]}): ${response.slice(0, 240)}`);
  }
  return response;
}
function compound(response: string) {
  const start = response.indexOf('{');
  if (start < 0) throw new Error('Server did not return entity NBT.');
  return parseSnbt(response.slice(start));
}
function vector(value: unknown): Vec {
  if (!Array.isArray(value) || value.length !== 3 || value.some(n => !Number.isFinite(n))) throw new Error('Missing server entity position.');
  return { x: value[0], y: value[1], z: value[2] };
}
function numberField(value: unknown, field: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Missing server NBT field: ${field}`);
  return value;
}

/** Privileged arena owner. Only the runner receives it; executors get neither this instance nor its evidence. */
export class VanillaExamAdapter implements ExamAdapter {
  readonly mode = 'real-server' as const;
  readonly capabilities = new Set<Capability>(['isolated-world', 'server-player-nbt', 'server-statistics', 'server-entities', 'server-clock']);
  private rcon = new LocalRcon(); private connected = false; private prepared = false;
  private actor = ''; private sequence = 0; private enemies: EnemySpec[] = [];
  private config: ExamServerConfig;
  constructor(config: ExamServerConfig) {
    if (config.kind !== 'anima-skill-exam' || config.gamePort === 25565 || config.rconPort === 25565) throw new Error('Refusing to operate the survival server.');
    this.config = config;
  }
  private async command(command: string, signal?: AbortSignal) {
    signal?.throwIfAborted(); const response = await this.rcon.command(command); signal?.throwIfAborted(); return checked(response, command);
  }
  async prepare(task: ExamTask, actor: string, signal: AbortSignal): Promise<ServerEvidence> {
    if (task.initialHealth !== undefined && (!Number.isInteger(task.initialHealth) || task.initialHealth < 1 || task.initialHealth > 20))
      throw new Error('Invalid initial health (integer 1–20 required).');
    if (!/^[A-Za-z0-9_]{1,16}$/u.test(actor)) throw new Error('Invalid actor.');
    if (this.prepared) throw new Error('Clean up the previous exam before preparing another.');
    if (!this.connected) { await this.rcon.connect(this.config.rconPort, this.config.rconPassword); this.connected = true; }
    const online = await this.command('list', signal);
    const names = online.includes(': ') ? online.slice(online.indexOf(': ') + 2).split(', ').filter(Boolean) : [];
    if (names.length !== 1 || names[0] !== actor) throw new Error('The isolated arena requires exactly the exam actor online.');
    this.actor = actor; this.sequence = 0; this.enemies = structuredClone(task.enemies); this.prepared = true;
    for (const command of [
      'tick unfreeze', 'tick rate 20', 'difficulty normal', 'gamerule doDaylightCycle false', 'gamerule doWeatherCycle false',
      'gamerule doMobSpawning false', 'gamerule mobGriefing false', 'gamerule naturalRegeneration false',
      'gamerule keepInventory false', 'gamerule doImmediateRespawn false', 'gamerule fallDamage true',
      'gamerule fireDamage true', 'gamerule drowningDamage true', 'gamerule doTileDrops true',
      'time set midnight', 'weather clear', `gamemode creative ${actor}`, `clear ${actor}`, `effect clear ${actor}`,
    ]) await this.command(command, signal);
    // No actor can reach the arena until it has finished being rebuilt. This is setup, outside the scored time.
    await this.command(`tp ${actor} 0.5 90 0.5`, signal);
    await this.rcon.command('kill @e[type=!minecraft:player]');
    for (const command of [
      'fill -17 59 -17 17 79 17 minecraft:air', 'fill -17 63 -17 17 63 17 minecraft:bedrock',
      'fill -17 60 -17 -17 70 17 minecraft:bedrock', 'fill 17 60 -17 17 70 17 minecraft:bedrock',
      'fill -17 60 -17 17 70 -17 minecraft:bedrock', 'fill -17 60 17 17 70 17 minecraft:bedrock',
    ]) await this.command(command, signal);
    for (const fill of task.terrain) await this.command(`fill ${pos(fill.from)} ${pos(fill.to)} minecraft:${identifier(fill.block)}`, signal);
    for (const item of task.inventory) {
      if (!Number.isInteger(item.count) || item.count < 1 || item.count > 64) throw new Error('Invalid initial item count.');
      await this.command(`give ${actor} minecraft:${identifier(item.item)} ${item.count}`, signal);
    }
    for (const [objective, criterion] of Object.values(STATS)) {
      const response = await this.rcon.command(`scoreboard objectives add ${objective} ${criterion}`);
      if (!/already exists/u.test(response)) checked(response, 'scoreboard objectives add');
      await this.command(`scoreboard players set ${actor} ${objective} 0`, signal);
    }
    for (const enemy of this.enemies) await this.spawn(enemy, signal, false);
    const initial = await this.establishBaseline(task, signal);
    // Establish a complete pre-damage baseline before allowing enemies to act.
    // Keep its clock/timestamp: exposure between activation and dispatch counts.
    for (const enemy of this.enemies) await this.command(`data merge entity @e[tag=${identifier(enemy.tag)},limit=1] {NoAI:0b}`, signal);
    if (this.enemies.length) initial.opponentsActivatedAt = Date.now();
    return initial;
  }
  private async establishBaseline(task: ExamTask, signal: AbortSignal): Promise<ServerEvidence> {
    const actor = this.actor, deadline = Date.now() + 20_000, expectedHealth = task.initialHealth ?? 20;
    const read = async () => compound(await this.command(`data get entity ${actor}`, signal));
    const health = (nbt: any) => numberField(nbt.Health, 'Health');
    const food = (nbt: any) => numberField(nbt.foodLevel, 'foodLevel');
    const isTrue = (value: any) => value === true || value === 1;
    const problem = (nbt: any): string | undefined => {
      if (health(nbt) !== expectedHealth) return `health=${health(nbt)}`;
      if (task.initialFood ? food(nbt) <= 0 || food(nbt) > task.initialFood.maximum : food(nbt) !== 20) return `food=${food(nbt)}`;
      if (numberField(nbt.playerGameType, 'playerGameType') !== 0) return 'not survival';
      if (!nbt.abilities || ['invulnerable', 'flying', 'mayfly'].some(key => isTrue(nbt.abilities[key]))) return 'creative abilities remain';
      const effects = nbt.active_effects ?? nbt.ActiveEffects ?? [];
      if (!Array.isArray(effects) || effects.length) return 'status effects remain';
      if (numberField(nbt.HurtTime, 'HurtTime') > 0 || numberField(nbt.DeathTime, 'DeathTime') > 0) return 'recent injury or death';
      if (numberField(nbt.FallDistance, 'FallDistance') > .05 || numberField(nbt.Fire, 'Fire') > 0) return 'fall or fire still active';
      if (numberField(nbt.Air, 'Air') <= 0) return 'air depleted';
      const p = vector(nbt.Pos), velocity = vector(nbt.Motion), water = task.category === 'water-rescue';
      if (Math.hypot(p.x - task.spawn.x, p.z - task.spawn.z) > .3 || Math.abs(p.y - task.spawn.y) > (water ? .5 : .1)) return 'spawn position not settled';
      if (!water && !isTrue(nbt.OnGround)) return 'not grounded at spawn';
      if (Math.hypot(velocity.x, velocity.z) > .04 || Math.abs(velocity.y) > (water ? .15 : .08)) return 'motion not settled';
    };
    let lastProblem = 'initial state not observed';
    try {
      // Recovery is allowed only before returning the initial evidence. Enemies
      // remain NoAI throughout; no scored injury is repaired or discarded.
      for (let attempt = 0; attempt < 3 && Date.now() < deadline; attempt++) {
        await this.command(`tp ${actor} ${pos(task.spawn)} -90 0`, signal);
        await this.command(`gamemode survival ${actor}`, signal);
        await this.command(`effect clear ${actor}`, signal);
        await this.command(`effect give ${actor} minecraft:instant_health 1 10 true`, signal);
        await this.command(`effect give ${actor} minecraft:saturation 1 10 true`, signal);
        const restoreUntil = Math.min(deadline, Date.now() + 2500);
        let restored = false;
        while (Date.now() < restoreUntil) {
          const nbt = await read();
          if (health(nbt) === 20 && food(nbt) === 20 && numberField(nbt.foodSaturationLevel, 'foodSaturationLevel') >= 20) { restored = true; break; }
          await delay(50, undefined, { signal });
        }
        await this.command(`effect clear ${actor}`, signal);
        if (!restored) { lastProblem = 'health/food restoration not confirmed'; continue; }
        if (task.initialFood) {
          const hungerUntil = Math.min(deadline, Date.now() + 12_000);
          let hungry = false;
          await this.command(`effect give ${actor} minecraft:hunger 15 255 true`, signal);
          try {
            while (Date.now() < hungerUntil) {
              const nbt = await read();
              if (health(nbt) !== 20) { lastProblem = `health=${health(nbt)} during hunger setup`; break; }
              if (food(nbt) > 0 && food(nbt) <= task.initialFood.maximum) { hungry = true; break; }
              await delay(250, undefined, { signal });
            }
          } finally { await this.rcon.command(`effect clear ${actor} minecraft:hunger`); }
          if (!hungry) { lastProblem = 'healthy hunger precondition not confirmed'; continue; }
        }
        if (expectedHealth < 20)
          await this.command(`damage ${actor} ${20 - expectedHealth} minecraft:generic`, signal);
        // Observe an unbuffed stable interval, rather than treating a sleep or
        // the effect command's acknowledgement as proof of a fair baseline.
        const settleUntil = Math.min(deadline, Date.now() + 3000);
        let stableSince: number | undefined;
        while (Date.now() < settleUntil) {
          const nbt = await read(), issue = problem(nbt);
          if (issue) {
            lastProblem = issue; stableSince = undefined;
            if (health(nbt) !== expectedHealth || food(nbt) <= 0) break;
          } else {
            stableSince ??= Date.now();
            if (Date.now() - stableSince >= 500) {
              const initial = await this.sample(signal);
              // Sampling scores/entities takes several round trips. A delayed
              // movement packet must not cause an injury behind that snapshot.
              const after = await read(), afterIssue = problem(after);
              if (!afterIssue && initial.actor.health === expectedHealth
                && (task.initialFood ? initial.actor.food > 0 && initial.actor.food <= task.initialFood.maximum : initial.actor.food === 20)) return initial;
              lastProblem = afterIssue || 'full evidence disagrees with stable baseline'; break;
            }
          }
          await delay(50, undefined, { signal });
        }
      }
      throw new Error(`Arena baseline did not stabilize before scoring (max 3 recoveries/20s; ${lastProblem}).`);
    } catch (error) {
      // Best-effort cleanup must not replace the original initialization error.
      try { await this.rcon.command(`effect clear ${actor}`); } catch { /* Connection may already be gone. */ }
      throw error;
    }
  }
  private async spawn(enemy: EnemySpec, signal: AbortSignal, active = true) {
    await this.command(`summon minecraft:${identifier(enemy.type)} ${pos(enemy.position)} {Tags:["anima_exam_enemy","${identifier(enemy.tag)}"],PersistenceRequired:1b,CanPickUpLoot:0b,IsBaby:0b,NoAI:${active ? 0 : 1}b}`, signal);
  }
  async sample(signal: AbortSignal): Promise<ServerEvidence> {
    if (!this.prepared) throw new Error('No exam prepared.');
    const nbt = compound(await this.command(`data get entity ${this.actor}`, signal));
    const inventory: Record<string, number> = {};
    if (!Array.isArray(nbt.Inventory)) throw new Error('Server inventory is not available.');
    for (const item of nbt.Inventory) {
      if (typeof item.id !== 'string') throw new Error('Unknown inventory item format.');
      const name = item.id.replace(/^minecraft:/u, ''), count = numberField(item.count ?? item.Count, 'item count');
      inventory[name] = (inventory[name] || 0) + count;
    }
    const statistics: Record<string, number> = {};
    for (const [name, [objective]] of Object.entries(STATS)) {
      const response = await this.command(`scoreboard players get ${this.actor} ${objective}`, signal);
      const match = response.match(/ has (-?\d+) /u); if (!match) throw new Error(`Missing scoreboard evidence: ${name}`);
      statistics[name] = Number(match[1]);
    }
    const enemies: ServerEvidence['enemies'] = [];
    for (const spec of this.enemies) {
      const response = await this.rcon.command(`data get entity @e[tag=${identifier(spec.tag)},limit=1]`);
      signal.throwIfAborted();
      if (/No entity was found/u.test(response)) enemies.push({ tag: spec.tag, type: spec.type, alive: false });
      else {
        const nbt = compound(checked(response, 'data get entity'));
        const health = numberField(nbt.Health, 'enemy Health');
        enemies.push({ tag: spec.tag, type: spec.type, alive: health > 0, health, position: vector(nbt.Pos) });
      }
    }
    const time = await this.command('time query gametime', signal);
    const match = time.match(/(?:The time is|is) (\d+)/u); if (!match) throw new Error('Missing server clock evidence.');
    return {
      source: 'vanilla-rcon', sequence: ++this.sequence, sampledAt: Date.now(), serverTick: Number(match[1]),
      actor: { name: this.actor, position: vector(nbt.Pos), health: numberField(nbt.Health, 'Health'), food: numberField(nbt.foodLevel, 'foodLevel'),
        air: numberField(nbt.Air, 'Air'), onGround: nbt.OnGround === 1 || nbt.OnGround === true, inventory }, statistics, enemies,
    };
  }
  async inject(task: ExamTask, evidence: ServerEvidence, signal: AbortSignal) {
    if (!task.perturbation || this.enemies.some(enemy => enemy.tag === task.perturbation!.enemy.tag)) throw new Error('Unexpected or repeated perturbation.');
    const enemy = structuredClone(task.perturbation.enemy);
    // A nearby encounter follows the actor instead of relying on advance knowledge of its route.
    enemy.position = { x: Math.min(14.5, evidence.actor.position.x + 3), y: 64, z: Math.min(14.5, evidence.actor.position.z + 2) };
    this.enemies.push(enemy); await this.spawn(enemy, signal);
  }
  async cleanup() {
    if (this.connected && this.prepared) {
      try { await this.rcon.command('kill @e[tag=anima_exam_enemy]'); } finally { this.prepared = false; }
    }
  }
  close() { this.rcon.close(); this.connected = false; this.prepared = false; }
}

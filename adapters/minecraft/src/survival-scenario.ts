import { appendFile, mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DRAGON_ROSTER } from './dragon-scenario.ts';

// Reuse identities only. The old equipped End trial is a different experiment.
export const SURVIVAL_ROSTER = DRAGON_ROSTER;
export const SURVIVAL_OBJECTIVE = '四人从随机新世界的自然出生区域空手开始，按普通生存规则自主合作，获取资源、准备食物与装备、进入下界和末地，最终亲自击败末影龙。';
export const SURVIVAL_RULES = {
  difficulty: 'easy', mode: 'survival', randomSeed: true, initialInventory: 'empty',
  keepInventory: false, immediateRespawn: false, naturalMobSpawning: true,
  mobGriefing: true, daylightCycle: true, weatherCycle: true,
  naturalRegeneration: true, hunger: true, deathDrops: true,
  fallDamage: true, fireDamage: true, drowningDamage: true, spawnRadius: 4,
  suppliedEquipment: false, suppliedEffects: false, teleportation: false,
  structureLocation: false, removeCrystalCages: false, dragonHealth: 200,
};
export const SURVIVAL_SCOPE = '完整随机世界生存流程：从空手出生开始，资源、建造、食物、下界、末地与屠龙都由 NPC 在普通生存中自主完成。';

const SETUP_COMMANDS = [
  'difficulty easy', 'gamerule keepInventory false', 'gamerule doImmediateRespawn false',
  'gamerule doMobSpawning true', 'gamerule mobGriefing true', 'gamerule naturalRegeneration true',
  'gamerule doDaylightCycle true', 'gamerule doWeatherCycle true',
  'gamerule fallDamage true', 'gamerule fireDamage true', 'gamerule drowningDamage true',
  'gamerule doEntityDrops true', 'gamerule doMobLoot true', 'gamerule doTileDrops true',
  'gamerule announceAdvancements true', 'gamerule spawnRadius 4',
  'scoreboard objectives add anima_survival dummy',
] as const;
const ALLOWED_SETUP = new Set<string>(SETUP_COMMANDS);
const STAGES = ['starting', 'resources', 'smelting', 'nether', 'end', 'victory'] as const;
type Stage = typeof STAGES[number];
type Milestone = { reachedAt: string; actor: string; evidence: string };
type InventoryItem = { name: string; count: number };
export interface SurvivalObservation {
  name?: string; time?: string; position?: { x: number; y: number; z: number };
  dimension?: string; health?: number; food?: number;
  inventory?: InventoryItem[];
  fullInventory?: InventoryItem[];
  [key: string]: unknown;
}
type Snapshot = {
  kind: 'survival'; runId: string; worldId: string;
  objective: string; scope: string; rules: typeof SURVIVAL_RULES;
  phase: 'preparing' | 'running' | 'victory' | 'stopped';
  startedAt: string; updatedAt?: string; wonAt?: string;
  progress: {
    stage: Stage;
    milestones: Partial<Record<Stage, Milestone>>;
    initialInventory: Record<string, { checkedAt: string; empty: boolean; itemCount: number; source?: 'fullInventory' | 'inventory' }>;
    initialEmptyVerified: boolean;
    actors: Record<string, { observedAt: string; dimension?: string; position?: SurvivalObservation['position']; health?: number; food?: number; inventory: InventoryItem[] }>;
  };
  observedDragon: boolean; dragonHealth?: number; dragonPresent?: number;
  crystals?: number; dragonPhase?: number; victories: string[];
  actions: Record<string, number>; attacks: Record<string, number>; deaths: Record<string, number>; errors: string[];
};

/** Creates or resumes only this scenario's own server directory, never another world. */
export async function prepareSurvivalServer(directory: string, port: number, worldId?: string) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid survival server port.');
  await mkdir(directory, { recursive: true });
  const markerPath = join(directory, 'anima-survival-server.json');
  let marker: { kind: string; worldId?: string } | undefined;
  try { marker = JSON.parse(await readFile(markerPath, 'utf8')); }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  if (marker && (marker.kind !== 'survival' || (worldId && marker.worldId !== worldId))) {
    throw new Error('This server directory belongs to a different world.');
  }
  if (!marker) {
    const existing = await readdir(directory);
    if (existing.some(name => ['world', 'server.properties', 'level.dat', 'run.json'].includes(name))) {
      throw new Error('Refusing to replace an existing world with the survival experiment.');
    }
    marker = { kind: 'survival', worldId };
    await writeFile(markerPath, JSON.stringify(marker, null, 2) + '\n', { flag: 'wx' });
  }
  await writeFile(join(directory, 'eula.txt'), 'eula=true\n');
  await writeFile(join(directory, 'server.properties'), [
    'server-ip=127.0.0.1', `server-port=${port}`, 'online-mode=false', 'enforce-secure-profile=false',
    'motd=Anima ordinary survival from scratch', 'max-players=8',
    'gamemode=survival', 'force-gamemode=true', 'difficulty=easy', 'hardcore=false',
    'spawn-protection=0', 'view-distance=8', 'simulation-distance=8',
    'level-type=minecraft:normal', 'level-name=world', 'level-seed=', 'generate-structures=true',
    'spawn-animals=true', 'spawn-monsters=true', 'spawn-npcs=true', 'allow-nether=true',
    'enable-rcon=false', 'enable-query=false', 'enable-command-block=false',
    'sync-chunk-writes=true', 'pause-when-empty-seconds=-1', 'pvp=true', '',
  ].join('\n'));
}

export class SurvivalScenario {
  directory: string;
  send: (command: string) => void;
  snapshot: Snapshot;
  lineBuffer = '';
  persistence: Promise<unknown> = Promise.resolve();

  constructor(directory: string, send: (command: string) => void) {
    this.directory = directory; this.send = send;
    const startedAt = new Date().toISOString();
    this.snapshot = {
      kind: 'survival', runId: `survival-${randomUUID()}`, worldId: `world-${randomUUID()}`,
      objective: SURVIVAL_OBJECTIVE, scope: SURVIVAL_SCOPE, rules: { ...SURVIVAL_RULES },
      phase: 'preparing', startedAt,
      progress: { stage: 'starting', milestones: {}, initialInventory: {}, initialEmptyVerified: false, actors: {} },
      observedDragon: false, victories: [], actions: {}, attacks: {}, deaths: {}, errors: [],
    };
  }

  async restore() {
    await mkdir(this.directory, { recursive: true });
    try {
      const previous = JSON.parse(await readFile(join(this.directory, 'run.json'), 'utf8'));
      if (previous.kind !== 'survival' || !previous.runId || !previous.worldId || !previous.progress?.initialInventory) {
        throw new Error('This run is not a from-scratch survival experiment; choose a new directory.');
      }
      this.snapshot = { ...previous, objective: SURVIVAL_OBJECTIVE, scope: SURVIVAL_SCOPE,
        phase: previous.phase === 'victory' ? 'victory' : 'preparing' };
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    await this.persist();
  }

  /** This is a fixed initialization allowlist, never an agent or arbitrary-console tool. */
  command(command: string) {
    if (!ALLOWED_SETUP.has(command)) throw new Error('Only ordinary-survival initialization is allowed; shortcut commands are forbidden.');
    this.persistence = this.persistence.then(() => appendFile(join(this.directory, 'admin.jsonl'), JSON.stringify({ time: new Date().toISOString(), command }) + '\n'));
    this.send(command);
  }
  setup() { for (const command of SETUP_COMMANDS) this.command(command); }

  start() {
    if (!this.snapshot.progress.initialEmptyVerified) throw new Error('Verify all four NPCs actually spawned with empty inventories before starting.');
    if (this.snapshot.phase !== 'victory') this.snapshot.phase = 'running';
    void this.persist();
  }
  stop() { if (this.snapshot.phase !== 'victory') this.snapshot.phase = 'stopped'; return this.persist(); }
  status() { return structuredClone({ ...this.snapshot, complete: this.snapshot.phase === 'victory' }); }
  publicContext() {
    return {
      worldId: this.snapshot.worldId, objective: SURVIVAL_OBJECTIVE, scope: SURVIVAL_SCOPE,
      companions: SURVIVAL_ROSTER.map(actor => ({ name: actor.name, roleId: actor.roleId })),
      rules: { ...SURVIVAL_RULES },
      mechanics: '这是普通生存：昼夜、怪物、饥饿、天气和死亡掉落正常运行。角色需要根据自己的观察、知识和同伴交流，自主规划完整目标；没有预先提供的装备、资源、传送或要塞位置。',
      complete: this.snapshot.phase === 'victory',
    };
  }

  private milestone(stage: Stage, actor: string, evidence: string) {
    if (!this.snapshot.progress.milestones[stage]) {
      this.snapshot.progress.milestones[stage] = { reachedAt: new Date().toISOString(), actor, evidence };
    }
    if (STAGES.indexOf(stage) > STAGES.indexOf(this.snapshot.progress.stage)) this.snapshot.progress.stage = stage;
  }

  /** Call with real per-actor observations, particularly once before the first agent turn. */
  observe(name: string, observation: SurvivalObservation) {
    if (!SURVIVAL_ROSTER.some(actor => actor.name === name)) return;
    if (observation.inventoryConfirmed === false || !Array.isArray(observation.inventory)) return;
    const inventory = observation.inventory.filter(item => item && typeof item.name === 'string' && Number.isFinite(item.count) && item.count > 0)
      .map(item => ({ name: item.name, count: item.count }));
    const now = new Date().toISOString();
    if (!this.snapshot.progress.initialInventory[name]) {
      // Mineflayer's ordinary inventory view can exclude armor and crafting
      // slots. The initial world check passes all occupied slots explicitly.
      const source = Array.isArray(observation.fullInventory) ? 'fullInventory' : 'inventory';
      const initialItems = source === 'fullInventory' ? observation.fullInventory! : inventory;
      const itemCount = initialItems.filter(item => item && Number.isFinite(item.count) && item.count > 0).reduce((total, item) => total + item.count, 0);
      this.snapshot.progress.initialInventory[name] = { checkedAt: now, empty: itemCount === 0, itemCount, source };
      this.snapshot.progress.initialEmptyVerified = SURVIVAL_ROSTER.every(actor => this.snapshot.progress.initialInventory[actor.name]?.empty === true);
      void this.persist();
    }
    this.snapshot.progress.actors[name] = {
      observedAt: now, dimension: observation.dimension,
      position: observation.position ? { ...observation.position } : undefined,
      health: observation.health, food: observation.food, inventory,
    };
    if (inventory.length) this.milestone('resources', name, `实际背包：${inventory.slice(0, 6).map(item => `${item.name}×${item.count}`).join('、')}`);
    if (['nether', 'the_nether', 'minecraft:the_nether'].includes(observation.dimension || '')) this.milestone('nether', name, '实际观察确认角色进入下界。');
    if (['end', 'the_end', 'minecraft:the_end'].includes(observation.dimension || '')) this.milestone('end', name, '实际观察确认角色进入末地。');
  }
  event(name: string, event: any) {
    if (!SURVIVAL_ROSTER.some(actor => actor.name === name)) return;
    if (event.type === 'observation' && event.observation) this.observe(name, event.observation);
    if (event.type === 'death') this.snapshot.deaths[name] = (this.snapshot.deaths[name] || 0) + 1;
    if (event.type === 'action') {
      this.snapshot.actions[name] = (this.snapshot.actions[name] || 0) + 1;
      if (['attack', 'shoot'].includes(event.action?.type) && event.status === 'completed') this.snapshot.attacks[name] = (this.snapshot.attacks[name] || 0) + 1;
    }
  }

  poll() {
    if (this.snapshot.phase !== 'running') return;
    // These queries only record existing state. They do not locate structures,
    // load a route, grant advancements, modify inventory, or damage any entity.
    if (this.snapshot.progress.milestones.end) {
      const end = 'execute in minecraft:the_end';
      this.send(`${end} store result score dragon_hp anima_survival run data get entity @e[type=minecraft:ender_dragon,limit=1] Health 100`);
      this.send(`${end} store success score dragon_present anima_survival if entity @e[type=minecraft:ender_dragon]`);
      this.send(`${end} store result score crystal_count anima_survival if entity @e[type=minecraft:end_crystal]`);
      this.send(`${end} store result score dragon_phase anima_survival run data get entity @e[type=minecraft:ender_dragon,limit=1] DragonPhase`);
      for (const key of ['dragon_hp', 'dragon_present', 'crystal_count', 'dragon_phase']) this.send(`scoreboard players get ${key} anima_survival`);
    }
    for (const { name } of SURVIVAL_ROSTER) for (const [stage, advancement] of [
      ['smelting', 'minecraft:story/smelt_iron'], ['nether', 'minecraft:story/enter_the_nether'],
      ['end', 'minecraft:story/enter_the_end'], ['victory', 'minecraft:end/kill_dragon'],
    ]) {
      const key = `${stage}_${name}`;
      this.send(`execute store success score ${key} anima_survival if entity @a[name=${name},advancements={${advancement}=true}]`);
      this.send(`scoreboard players get ${key} anima_survival`);
    }
    void this.persist();
  }

  console(chunk: string) {
    this.lineBuffer += chunk;
    const lines = this.lineBuffer.split(/\r?\n/u); this.lineBuffer = lines.pop() || '';
    if (this.lineBuffer.length > 20000) this.lineBuffer = this.lineBuffer.slice(-20000);
    for (const line of lines) {
      const match = /^\[[^\]]+\] \[Server thread\/INFO\]: (dragon_hp|dragon_present|crystal_count|dragon_phase|(?:smelting|nether|end|victory)_\w+) has (-?\d+) \[anima_survival\]$/u.exec(line);
      if (!match) continue;
      const [, key, raw] = match, value = Number(raw);
      if (key === 'dragon_hp') { this.snapshot.dragonHealth = value / 100; if (value > 0) this.snapshot.observedDragon = true; }
      if (key === 'dragon_present') this.snapshot.dragonPresent = value;
      if (key === 'crystal_count') this.snapshot.crystals = value;
      if (key === 'dragon_phase') this.snapshot.dragonPhase = value;
      const advance = /^(smelting|nether|end|victory)_(\w+)$/u.exec(key);
      if (advance && value === 1) {
        const [, stage, name] = advance;
        if (!SURVIVAL_ROSTER.some(actor => actor.name === name)) continue;
        if (stage === 'victory') {
          if (!this.snapshot.victories.includes(name)) this.snapshot.victories.push(name);
        } else {
          this.milestone(stage as Stage, name, stage === 'smelting'
            ? '服务器自然进度 smelt_iron：获得铁锭；这项进度本身不区分冶炼与其他合法来源。'
            : `服务器自然进度确认进入${stage === 'nether' ? '下界' : '末地'}。`);
        }
      }
      if (this.snapshot.phase === 'running' && this.snapshot.observedDragon && this.snapshot.victories.length && this.snapshot.dragonPresent === 0) {
        this.snapshot.phase = 'victory'; this.snapshot.wonAt = new Date().toISOString();
        this.milestone('victory', this.snapshot.victories[0], '服务器自然屠龙成就、曾实际存在的活龙与龙实体消失共同确认。');
        void this.persist();
      }
    }
  }

  persist() {
    this.snapshot.updatedAt = new Date().toISOString();
    const body = JSON.stringify(this.snapshot, null, 2);
    this.persistence = this.persistence.then(async () => {
      const target = join(this.directory, 'run.json'), temporary = target + '.tmp';
      await writeFile(temporary, body); await rename(temporary, target);
    }).catch(error => { this.snapshot.errors = [...this.snapshot.errors, String(error.message)].slice(-50); });
    return this.persistence;
  }
}

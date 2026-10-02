import { appendFile, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

export const DRAGON_ROSTER = [
  { name: 'Sheldon', roleId: 'sheldon', persona: '谢耳朵：精确、重视规则，习惯分析风险，也会笨拙地关心同伴。' },
  { name: 'Sherlock', roleId: 'sherlock', persona: '福尔摩斯：观察敏锐、重视证据，愿意检验假设和调整计划。' },
  { name: 'Deadpool', roleId: 'deadpool', persona: '死侍：话多爱开玩笑，行动大胆，但关心队友，不把冒险强加给他人。' },
  { name: 'HuYifei', roleId: 'huyifei', persona: '胡一菲：直率果断、护短，愿意组织合作并承担责任。' },
] as const;

export const EASY_RULES = {
  difficulty: 'easy', mode: 'survival', keepInventory: true,
  immediateRespawn: true, naturalMobSpawning: false, mobGriefing: false,
  equipment: 'netherite armor, sharpness V sword, power V bow, arrows, food, blocks',
  effects: 'resistance II, regeneration II, slow falling, saturation',
  removeCrystalCages: true, dragonHealth: 200,
  scope: '直接进入末地，测试四 NPC 协作战斗；不包含从零生存与寻找要塞。',
};

export async function prepareDragonServer(directory: string, port: number) {
  await mkdir(directory, { recursive: true });
  // A separate save preserves the existing creative sandbox.
  await writeFile(join(directory, 'eula.txt'), 'eula=true\n');
  await writeFile(join(directory, 'server.properties'), [
    'server-ip=127.0.0.1', `server-port=${port}`, 'online-mode=false',
    'enforce-secure-profile=false', 'motd=Anima four NPC dragon experiment',
    'max-players=8', 'gamemode=survival', 'difficulty=easy', 'spawn-protection=0',
    'view-distance=8', 'simulation-distance=8', 'level-type=minecraft:normal',
    'level-name=world', 'level-seed=8675309', 'generate-structures=true',
    'enable-rcon=false', 'enable-query=false', 'enable-command-block=false',
    'sync-chunk-writes=true', 'pause-when-empty-seconds=-1', 'pvp=false', '',
  ].join('\n'));
}

type Snapshot = {
  runId: string; phase: 'preparing' | 'running' | 'victory' | 'stopped';
  startedAt: string; updatedAt?: string; wonAt?: string;
  rules: typeof EASY_RULES; observedDragon: boolean; dragonHealth?: number;
  dragonPresent?: number; crystals?: number; dragonPhase?: number;
  victories: string[]; actions: Record<string, number>; attacks: Record<string, number>;
  deaths: Record<string, number>; errors: string[];
};

// Console-only authority: this object is never exposed as an agent tool.
export class DragonScenario {
  directory: string;
  snapshot: Snapshot;
  send: (command: string) => void;
  lineBuffer = '';
  persistence: Promise<unknown> = Promise.resolve();
  removedCages = new Set<string>();
  constructor(directory: string, send: (command: string) => void) {
    this.directory = directory; this.send = send;
    this.snapshot = {
      runId: new Date().toISOString().replace(/[:.]/gu, '-'), phase: 'preparing',
      startedAt: new Date().toISOString(), rules: EASY_RULES, observedDragon: false,
      victories: [], actions: {}, attacks: {}, deaths: {}, errors: [],
    };
  }
  async restore() {
    await mkdir(this.directory, { recursive: true });
    try {
      const previous = JSON.parse(await readFile(join(this.directory, 'run.json'), 'utf8'));
      if (previous.runId && previous.rules) this.snapshot = { ...previous, phase: previous.phase === 'victory' ? 'victory' : 'preparing' };
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    await this.persist();
  }
  command(command: string) {
    if (/[\r\n]/u.test(command)) throw new Error('One console command per request.');
    // No shortcut victory commands, even in setup. Combat happens via player packets.
    if (/\b(?:kill|damage)\s/iu.test(command) || /\bHealth\b/iu.test(command) || /\badvancement\s+grant\b/iu.test(command)) throw new Error('Direct damage or forced victory is forbidden in the experiment.');
    this.persistence = this.persistence.then(() => appendFile(join(this.directory, 'admin.jsonl'), JSON.stringify({ time: new Date().toISOString(), command }) + '\n'));
    this.send(command);
  }
  setup() {
    for (const command of [
      'difficulty easy', 'gamerule keepInventory true', 'gamerule doImmediateRespawn true',
      'gamerule doMobSpawning false', 'gamerule mobGriefing false',
      'gamerule fallDamage false', 'gamerule fireDamage false', 'gamerule drowningDamage false',
      'gamerule doDaylightCycle false', 'gamerule doWeatherCycle false',
      'gamerule announceAdvancements true', 'time set day', 'weather clear',
      'scoreboard objectives add anima_lab dummy',
    ]) this.command(command);
  }
  provision(name: string, index: number, respawn = false) {
    if (!DRAGON_ROSTER.some(actor => actor.name === name)) throw new Error('Unknown trial participant.');
    const x = [-7, 7, -7, 7][index], z = [-7, -7, 7, 7][index];
    this.command(`gamemode survival ${name}`);
    for (const effect of ['resistance 1000000 1', 'regeneration 1000000 1', 'slow_falling 1000000 0', 'saturation 1000000 0']) {
      this.command(`effect give ${name} minecraft:${effect} true`);
    }
    if (!respawn) {
      for (const [slot, item] of [['head', 'helmet'], ['chest', 'chestplate'], ['legs', 'leggings'], ['feet', 'boots']]) {
        this.command(`item replace entity ${name} armor.${slot} with minecraft:netherite_${item}[minecraft:enchantments={levels:{"minecraft:protection":4}}]`);
      }
      for (const item of [
        'netherite_sword[minecraft:enchantments={levels:{"minecraft:sharpness":5}}] 1',
        'bow[minecraft:enchantments={levels:{"minecraft:power":5,"minecraft:infinity":1}}] 1',
        'arrow 64', 'golden_carrot 64', 'cobblestone 64', 'netherite_pickaxe 1',
      ]) this.command(`give ${name} minecraft:${item}`);
    }
    this.command(`execute in minecraft:the_end run tp ${name} ${x} 72 ${z}`);
  }
  start() { if (this.snapshot.phase !== 'victory') this.snapshot.phase = 'running'; void this.persist(); }
  stop() { if (this.snapshot.phase !== 'victory') this.snapshot.phase = 'stopped'; return this.persist(); }
  publicContext() {
    return {
      objective: '击败末影龙可以帮助大家逃出这个世界。',
      companions: DRAGON_ROSTER.map(r => ({ name: r.name, roleId: r.roleId })),
      rules: EASY_RULES,
      mechanics: '水晶可以给龙回血。弓箭可远程射击；龙落在中央时可近战。goto仅能直线短距靠近，遇障会失败。需要自己观察并与同伴协商。',
      complete: this.snapshot.phase === 'victory',
    };
  }
  status() { return { ...this.snapshot, complete: this.snapshot.phase === 'victory' }; }
  event(name: string, event: any) {
    if (event.type === 'death') this.snapshot.deaths[name] = (this.snapshot.deaths[name] || 0) + 1;
    if (event.type === 'action') {
      this.snapshot.actions[name] = (this.snapshot.actions[name] || 0) + 1;
      if (['attack', 'shoot'].includes(event.action?.type) && event.status === 'completed') this.snapshot.attacks[name] = (this.snapshot.attacks[name] || 0) + 1;
    }
  }
  poll() {
    if (this.snapshot.phase !== 'running') return;
    const end = 'execute in minecraft:the_end';
    // All metrics are read-only. Exact health is for the operator, not private NPC context.
    this.send(`${end} store result score dragon_hp anima_lab run data get entity @e[type=minecraft:ender_dragon,limit=1] Health 100`);
    this.send(`${end} store success score dragon_present anima_lab if entity @e[type=minecraft:ender_dragon]`);
    this.send(`${end} store result score crystal_count anima_lab if entity @e[type=minecraft:end_crystal]`);
    this.send(`${end} store result score dragon_phase anima_lab run data get entity @e[type=minecraft:ender_dragon,limit=1] DragonPhase`);
    for (const key of ['dragon_hp', 'dragon_present', 'crystal_count', 'dragon_phase']) this.send(`scoreboard players get ${key} anima_lab`);
    for (const { name } of DRAGON_ROSTER) {
      this.send(`execute store success score victory_${name} anima_lab if entity @a[name=${name},advancements={minecraft:end/kill_dragon=true}]`);
      this.send(`scoreboard players get victory_${name} anima_lab`);
    }
    void this.persist();
  }
  console(chunk: string) {
    this.lineBuffer += chunk;
    const lines = this.lineBuffer.split(/\r?\n/u); this.lineBuffer = lines.pop() || '';
    for (const line of lines) {
      const match = /^\[[^\]]+\] \[Server thread\/INFO\]: (dragon_hp|dragon_present|crystal_count|dragon_phase|victory_\w+) has (-?\d+) \[anima_lab\]$/u.exec(line);
      if (match) {
        const [, key, raw] = match; const value = Number(raw);
        if (key === 'dragon_hp') { this.snapshot.dragonHealth = value / 100; if (value > 0) this.snapshot.observedDragon = true; }
        if (key === 'dragon_present') this.snapshot.dragonPresent = value;
        if (key === 'crystal_count') this.snapshot.crystals = value;
        if (key === 'dragon_phase') this.snapshot.dragonPhase = value;
        if (key.startsWith('victory_') && value === 1) {
          const name = key.slice(8);
          if (DRAGON_ROSTER.some(r => r.name === name) && !this.snapshot.victories.includes(name)) this.snapshot.victories.push(name);
        }
      }
      // The advancement is server-owned and is never granted by the harness.
      if (this.snapshot.observedDragon && this.snapshot.victories.length && this.snapshot.dragonPresent === 0 && this.snapshot.phase === 'running') {
        this.snapshot.phase = 'victory'; this.snapshot.wonAt = new Date().toISOString(); void this.persist();
      }
    }
  }
  openCages(bots: Iterable<any>) {
    for (const record of bots) for (const entity of Object.values(record.bot.entities) as any[]) {
      if (!['end_crystal', 'ender_crystal'].includes(entity.name) || this.removedCages.has(entity.uuid || String(entity.id))) continue;
      this.removedCages.add(entity.uuid || String(entity.id));
      const { x, y, z } = entity.position.floored();
      this.command(`execute in minecraft:the_end run fill ${x - 3} ${y - 2} ${z - 3} ${x + 3} ${y + 4} ${z + 3} air replace iron_bars`);
    }
  }
  persist() {
    this.snapshot.updatedAt = new Date().toISOString();
    const body = JSON.stringify(this.snapshot, null, 2);
    this.persistence = this.persistence.then(async () => {
      const target = join(this.directory, 'run.json'), temporary = target + '.tmp';
      await writeFile(temporary, body); await rename(temporary, target);
    }).catch(error => { this.snapshot.errors.push(String(error.message)); });
    return this.persistence;
  }
}

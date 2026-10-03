import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { terms } from './retrieval.ts';

export type MemoryKind = 'fact' | 'hearsay' | 'intent';
export type MemoryTopic = 'goal' | 'plan' | 'place' | 'coordination' | 'note';
export type GoalStatus = 'active' | 'completed' | 'abandoned';
export interface GoalIntentOptions { goalId?: string; goalStatus?: GoalStatus; completionCondition?: string; }
export interface WorldProgressState {
  dimension?: string; position?: { x: number; y: number; z: number }; health?: number; food?: number;
  inventory?: Record<string, number>;
}
export interface WorldInformationCheck { query: string; fingerprint: string; }
export interface WorldActionProgress {
  /** Native receipt ID; stable across event, tool and controller snapshots. */
  id: string; action: string; status: 'completed' | 'failed' | 'cancelled';
  /** A revoked skill may still return a completed physical operation while draining. */
  nativeStatus?: 'completed' | 'failed' | 'cancelled';
  error?: string; stoppedReason?: string;
  /** Original body authorization, never an attribution to the latest goal. */
  intentId?: string; intentVersion?: number; reaction?: string; finishedAt?: number;
  blockChanges: number;
  results?: Record<string, boolean | number>;
}
export interface WorldTurnProgress {
  version: 1; start: WorldProgressState; end: WorldProgressState; actions: Record<string, number>;
  checks: WorldInformationCheck[]; failures: string[]; blockChanges: number;
  /** Actual positive/negative inventory receipts, including interrupted actions. */
  inventoryChanges: { item: string; change: number }[];
  /** Observed changes only: no inferred cause, tactical plan or success claim. */
  situationChanges: string[];
  /** Each real receipt is accounted once, including receipts arriving between turns. */
  actionReceipts?: WorldActionProgress[];
}
export interface WorldMemoryEntry {
  id: string; npcId: string; roleId: string; worldId?: string; kind: MemoryKind;
  time: string; text: string; sourceId?: string; topic?: MemoryTopic;
  progress?: WorldTurnProgress;
  /** A goal's stable ID, or the goal associated with a plan. Null means unbound. */
  goalId?: string | null;
  goalStatus?: GoalStatus;
  /** The NPC's own proposed criterion, never a world completion verdict. */
  completionCondition?: string;
  eventType?: string;
}

export function progressState(raw: any): WorldProgressState {
  const state: WorldProgressState = {};
  if (typeof raw?.dimension === 'string') state.dimension = raw.dimension.slice(0, 80);
  if (raw?.position && ['x', 'y', 'z'].every(key => Number.isFinite(raw.position[key]))) {
    state.position = Object.fromEntries(['x', 'y', 'z'].map(key => [key, Math.round(raw.position[key])])) as WorldProgressState['position'];
  }
  for (const key of ['health', 'food'] as const) if (Number.isFinite(raw?.[key])) state[key] = raw[key];
  // Use the full real observation, not the inventory shortened for model context.
  if (raw?.inventoryConfirmed !== false && Array.isArray(raw?.inventory)) {
    state.inventory = {};
    for (const item of raw.inventory) if (typeof item?.name === 'string' && Number.isFinite(item.count)) {
      const name = item.name.slice(0, 80);
      state.inventory[name] = (state.inventory[name] || 0) + item.count;
    }
  }
  return state;
}

export function inventoryChanges(before: WorldProgressState, after: WorldProgressState) {
  if (!before.inventory || !after.inventory) return [];
  return [...new Set([...Object.keys(before.inventory), ...Object.keys(after.inventory)])].sort()
    .map(item => ({ item, change: (after.inventory![item] || 0) - (before.inventory![item] || 0) })).filter(item => item.change !== 0);
}

export function situationChanges(before: WorldProgressState | undefined, after: WorldProgressState): string[] {
  if (!before) return [];
  const changes: string[] = [];
  if (before.dimension && after.dimension && before.dimension !== after.dimension) changes.push(`维度改变：${before.dimension}→${after.dimension}`);
  for (const key of ['health', 'food'] as const) if (Number.isFinite(before[key]) && Number.isFinite(after[key]) && after[key]! < before[key]!) {
    changes.push(`${key === 'health' ? '生命' : '饥饿值'}下降：${before[key]}→${after[key]}`);
  }
  return changes;
}

export function worldMemoryNamespace(value: unknown = 'minecraft'): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(value)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(value)) throw new Error('Invalid world memory namespace.');
  return value;
}

export function clipped(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, Math.max(0, limit - 6)) + '…[截断]';
}

// Extractive packing only: no language model rewrites, inferred causes or invented facts.
export function compactMemory(entries: WorldMemoryEntry[], budget = 4500): string {
  const output: string[] = [];
  let length = 0;
  for (const entry of entries) {
    const fields = { id: entry.id, kind: entry.kind, topic: entry.topic, time: entry.time,
      ...(entry.goalId !== undefined ? { goalId: entry.goalId } : {}), ...(entry.goalStatus ? { goalStatus: entry.goalStatus } : {}),
      ...(entry.completionCondition ? { completionCondition: entry.completionCondition } : {}) };
    const available = Math.max(0, budget - length - JSON.stringify({ ...fields, text: '' }).length - 1);
    if (available < 40) break;
    const line = JSON.stringify({ ...fields, text: clipped(entry.text, Math.min(700, available)) });
    if (length + line.length + 1 > budget) break;
    output.push(line); length += line.length + 1;
  }
  return output.join('\n');
}

function observationMemory(entry: WorldMemoryEntry) {
  return entry.sourceId?.startsWith('observation:') || entry.text.startsWith('本角色亲眼观察');
}

function reviewCheckpoint(entry: WorldMemoryEntry) { return entry.sourceId?.startsWith('goal-review-checkpoint:'); }

/** Automatic history should not resurrect a past inventory, instruction or rumour.
 * Explicit recall still searches the untouched original entries. */
function usefulAutomaticHistory(entry: WorldMemoryEntry) {
  if (entry.kind !== 'fact' || entry.progress || reviewCheckpoint(entry)) return false;
  if (entry.topic === 'place') return true;
  return !/^(?:observation|action|event):/u.test(entry.sourceId || '')
    && !/^(?:本角色亲眼观察|本角色收到世界事件|仅按回执状态记录|聊天回执仅说明|攻击\/射击完成)/u.test(entry.text);
}

export class WorldMemory {
  readonly entries: WorldMemoryEntry[] = [];
  private sourceIds = new Set<string>();
  private writes: Promise<void> = Promise.resolve();
  readonly file: string; readonly npcId: string; readonly roleId: string; readonly worldId: string;
  private constructor(file: string, npcId: string, roleId: string, worldId: string) { this.file = file; this.npcId = npcId; this.roleId = roleId; this.worldId = worldId; }

  static async open(directory: string, npcId: string, roleId = 'custom', worldId = 'minecraft'): Promise<WorldMemory> {
    if (!/^[A-Za-z0-9_-]{1,40}$/u.test(npcId) || !/^[a-z][a-z0-9-]{0,39}$/u.test(roleId)) throw new Error('Invalid world memory identity.');
    worldId = worldMemoryNamespace(worldId);
    const memory = new WorldMemory(join(directory, npcId, `${roleId}.jsonl`), npcId, roleId, worldId);
    try {
      const raw = await readFile(memory.file, 'utf8');
      for (const line of raw.split(/\r?\n/u).filter(Boolean)) {
        const entry = JSON.parse(line) as WorldMemoryEntry;
        if (entry.npcId !== npcId || entry.roleId !== roleId || (entry.worldId ?? 'minecraft') !== worldId
          || !['fact', 'hearsay', 'intent'].includes(entry.kind) || typeof entry.text !== 'string') {
          throw new Error('World memory identity or schema mismatch.');
        }
        memory.entries.push(entry);
        if (entry.sourceId) memory.sourceIds.add(entry.sourceId);
      }
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    return memory;
  }

  async add(kind: MemoryKind, text: string, sourceId?: string, time = new Date().toISOString(), topic?: MemoryTopic, progress?: WorldTurnProgress,
    metadata?: Pick<WorldMemoryEntry, 'goalId' | 'goalStatus' | 'completionCondition' | 'eventType'>) {
    if (sourceId && this.sourceIds.has(sourceId)) return;
    const entry: WorldMemoryEntry = { id: randomUUID(), npcId: this.npcId, roleId: this.roleId, worldId: this.worldId, kind, time,
      text: clipped(text, 1600), ...(sourceId ? { sourceId } : {}), ...(topic ? { topic } : {}), ...(progress ? { progress } : {}), ...metadata };
    if (topic === 'goal' && metadata?.goalStatus && !entry.goalId) entry.goalId = entry.id;
    // Reserve the ID synchronously so duplicate events within one observation cannot race.
    if (sourceId) this.sourceIds.add(sourceId);
    const operation = this.writes.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await appendFile(this.file, JSON.stringify(entry) + '\n', 'utf8');
      this.entries.push(entry);
    });
    this.writes = operation.catch(() => { if (sourceId) this.sourceIds.delete(sourceId); });
    await operation;
    return entry;
  }

  async ingestEvents(events: unknown) {
    if (!Array.isArray(events)) return;
    for (const event of events.slice(-100)) {
      if (!event || typeof event !== 'object') continue;
      const source = typeof event.id === 'string' ? `event:${event.id}` : undefined;
      const time = typeof event.time === 'string' ? event.time : undefined;
      if (event.type === 'heard' && typeof event.message === 'string') {
        const channel = event.channel === 'broadcast' ? '通过世界频道说' : '说';
        await this.add('hearsay', `${String(event.speaker || '未知说话者')}${channel}：${event.message}`, source, time);
      } else if (event.type === 'action') {
        await this.recordAction(event, undefined, time);
      } else if (['hurt', 'spawn', 'respawn', 'death', 'disconnected'].includes(event.type)) {
        await this.add('fact', `本角色收到世界事件：${JSON.stringify({ type: event.type, position: event.position,
          healthBefore: event.healthBefore, health: event.health, food: event.food, loss: event.loss })}`, source, time, undefined, undefined, { eventType: event.type });
      }
    }
  }

  async recordAction(receipt: any, sourceId?: string, time?: string) {
    const action = receipt.action || { type: receipt.type };
    const note = receipt.details?.inventoryConfirmed === false ? '此回执的库存差异尚未得到服务器确认，不能当作实际产物或材料消耗。'
      : ['say', 'broadcast'].includes(action.type) ? '聊天回执仅说明发送操作，不证明别人听见、相信或记住。'
      : ['attack', 'shoot'].includes(action.type) ? '攻击/射击完成仅表示操作结束；attempts/shot不是命中或击杀证据，仅按details中的健康变化或明确确认判断。'
        : '仅按回执状态记录，失败或取消不表示目标完成。';
    const ownership = receipt.bodyIntent ? '此回执归属bodyIntent中的原授权：status是实际操作结果，controlStatus是授权生命周期结果。旧授权取消后的真实局部成果仍保留，但不表示当前目标或步骤完成。\n' : '';
    return this.add('fact', `${ownership}${note}\n${JSON.stringify({ action, status: receipt.status, error: receipt.error, vitals: receipt.details?.vitals,
      details: receipt.details ?? receipt.detail, confirmedHealthChange: receipt.confirmedHealthChange,
      before: receipt.before, after: receipt.after, bodyIntent: receipt.bodyIntent })}`,
      sourceId || (receipt.id ? `action:${receipt.id}` : undefined), time);
  }

  /** Derive current intent from append order, including records from before goal IDs existed. */
  private activeIntent() {
    let goal: WorldMemoryEntry | undefined, plan: WorldMemoryEntry | undefined, goalId: string | undefined;
    for (const entry of this.entries) {
      if (entry.kind !== 'intent') continue;
      if (entry.topic === 'goal') {
        const id = entry.goalId || entry.id;
        if (!entry.goalStatus || entry.goalStatus === 'active') {
          // A revised goal gets a fresh checkpoint; an old plan is not silently resumed.
          goal = entry; goalId = id; plan = undefined;
        } else if (id === goalId) { goal = undefined; goalId = undefined; plan = undefined; }
      } else if (entry.topic === 'plan') {
        const associated = entry.goalId === undefined ? goalId ?? null : entry.goalId;
        if (associated === (goalId ?? null)) plan = entry;
      }
    }
    return { goal, plan, goalId };
  }

  currentIntent() { return this.activeIntent(); }

  /** A read-only projection of the latest goal transitions, never executable plans.
   * Replacements are derived from append order, including pre-goalId records. */
  goalHistoryContext(budget = 1100) {
    const header = '最近目标变更（最新在前；历史意图判断，不是活动目标或世界事实。较新的结束/替换记录覆盖旧审议note中的目标状态；不恢复旧plan，也不代表世界胜利）：';
    const history: { kind: 'intent'; status: 'completed' | 'abandoned' | 'replaced'; time: string;
      goalId: string; goal: string; judgment?: string; replacedBy?: string }[] = [];
    let active: WorldMemoryEntry | undefined;
    for (const entry of this.entries) {
      if (entry.kind !== 'intent' || entry.topic !== 'goal') continue;
      const id = entry.goalId || entry.id;
      if (!entry.goalStatus || entry.goalStatus === 'active') {
        if (active && id !== (active.goalId || active.id)) history.push({ kind: 'intent', status: 'replaced',
          time: entry.time, goalId: active.goalId || active.id, goal: clipped(active.text, 100), replacedBy: clipped(entry.text, 160) });
        active = entry;
      } else if (active && id === (active.goalId || active.id)) {
        history.push({ kind: 'intent', status: entry.goalStatus, time: entry.time,
          goalId: id, goal: clipped(active.text, 100), judgment: clipped(entry.text, 160) });
        active = undefined;
      }
      if (history.length > 3) history.shift();
    }
    if (!history.length) return '';
    const limit = Math.max(0, Math.floor(budget));
    if (header.length >= limit) return '';
    const output = [header];
    let length = header.length;
    for (const row of history.reverse()) {
      const line = JSON.stringify(row);
      if (length + line.length + 1 > limit) break;
      output.push(line); length += line.length + 1;
    }
    return output.length > 1 ? output.join('\n') : '';
  }

  /** Count completed decision tasks, not provider turns or scheduler restarts. */
  goalReviewDue(interval = 3) {
    const checkpoint = this.entries.findLastIndex(reviewCheckpoint);
    return this.entries.slice(checkpoint + 1).filter(entry => entry.progress?.version === 1).length >= interval;
  }

  async checkpointGoalReview(taskId: string) {
    return this.add('fact', '内部目标审议周期检查点；不属于居民的世界经历。', `goal-review-checkpoint:${taskId}`);
  }

  async rememberIntent(text: string, topic: MemoryTopic = 'note', options: GoalIntentOptions = {}) {
    if (options.goalStatus && !['active', 'completed', 'abandoned'].includes(options.goalStatus)) throw new Error('未知目标状态。');
    if ((options.goalStatus || options.completionCondition !== undefined) && topic !== 'goal') throw new Error('目标状态和完成条件只能用于 category=goal。');
    if (options.goalId !== undefined && !['goal', 'plan'].includes(topic)) throw new Error('goalId 只能关联目标或计划。');
    const current = this.activeIntent();
    if (options.goalId !== undefined && options.goalId !== current.goalId) throw new Error('goalId 不是当前有效目标；若要选择新目标，省略 goalId 并保存 active goal。');
    if (topic === 'goal') {
      const goalStatus = options.goalStatus || 'active';
      const goalId = options.goalId ?? (goalStatus === 'active' ? undefined : current.goalId);
      if (goalStatus !== 'active' && !goalId) throw new Error('当前没有可完成或放弃的目标。');
      const completionCondition = options.completionCondition === undefined
        ? (goalId === current.goalId ? current.goal?.completionCondition : undefined)
        : clipped(options.completionCondition.trim(), 400);
      return this.add('intent', text, undefined, undefined, topic, undefined,
        { goalStatus, ...(goalId ? { goalId } : {}), ...(completionCondition ? { completionCondition } : {}) });
    }
    return this.add('intent', text, undefined, undefined, topic, undefined,
      topic === 'plan' ? { goalId: options.goalId ?? current.goalId ?? null } : undefined);
  }

  recentProgress(limit = 6) {
    return this.entries.filter(entry => entry.progress?.version === 1).slice(-limit).map(entry => entry.progress!);
  }

  async recordProgress(taskId: string, progress: WorldTurnProgress) {
    return this.add('fact', '本轮执行统计（自动提取的观察和回执；不判断战略目标是否完成）。', `turn:${taskId}`, undefined, undefined, progress);
  }

  /** Deterministic reflection, not an autonomous strategy or a rewritten goal. */
  progressContext(current?: WorldProgressState, currentChanges: string[] = [], budget = 2200, pending?: WorldTurnProgress) {
    const reportEntries = this.entries.filter(entry => entry.progress?.version === 1);
    const selected = reportEntries.slice(-6), reports = selected.map(entry => entry.progress!);
    // Body work can finish between reasoning turns. Include newly consumed
    // receipts in this review before the current turn's report is persisted.
    const hasPending = !!pending?.actionReceipts?.length;
    if (hasPending) reports.push(pending!);
    if (!reports.length && !currentChanges.length) return '尚无多轮执行记录。';
    const rows = reports.map(report => {
      const delta = inventoryChanges(report.start, report.end);
      const moved = report.start.dimension === report.end.dimension && report.start.position && report.end.position
        ? Math.round(Math.hypot(...(['x', 'y', 'z'] as const).map(key => report.end.position![key] - report.start.position![key]))) : undefined;
      return { actions: report.actions, inventoryDelta: delta.slice(0, 6), receiptInventoryDelta: report.inventoryChanges.slice(0, 4),
        blockChanges: report.blockChanges, displacement: moved, situationChanges: report.situationChanges.slice(-3), failures: report.failures.slice(-2),
        ...(report.actionReceipts?.length ? { actualReceipts: report.actionReceipts.slice(-2) } : {}) };
    });
    const materialChange = (report: WorldTurnProgress) => report.blockChanges > 0
      || [...inventoryChanges(report.start, report.end), ...report.inventoryChanges].some(item => item.change > 0);
    let unchanged = 0;
    for (const report of [...reports].reverse()) { if (materialChange(report)) break; unchanged += 1; }
    const repetitions = new Map<string, { query: string; count: number }>();
    for (const report of reports) for (const check of report.checks) {
      const key = `${check.query}\0${check.fingerprint}`, item = repetitions.get(key) || { query: check.query, count: 0 };
      item.count += 1; repetitions.set(key, item);
    }
    const repeated = [...repetitions.values()].filter(item => item.count >= 3).sort((a, b) => b.count - a.count).slice(0, 3);
    const last = reports.at(-1);
    const changed = [...new Set([...(last?.situationChanges || []), ...currentChanges, ...situationChanges(last?.end, current || {})])].slice(-5);
    // Compare actual holdings across turn boundaries too: a death may finish a
    // task before its inventory clears, with the loss only seen on the next spawn.
    const priorReport = reportEntries.at(-selected.length - 1);
    const startIndex = priorReport ? this.entries.indexOf(priorReport) + 1 : 0;
    const deaths = this.entries.slice(startIndex).filter(entry => entry.kind === 'fact' && (entry.eventType === 'death'
      || (!entry.eventType && entry.text.startsWith('本角色收到世界事件：') && /"type":"death"/u.test(entry.text)))).length;
    const states = reports.flatMap(report => [report.start, report.end]);
    if (current) states.push(current);
    const decreases = new Map<string, number>();
    let unknownTransitions = 0;
    for (let i = 1; i < states.length; i++) {
      if (!states[i - 1].inventory || !states[i].inventory) { unknownTransitions++; continue; }
      for (const item of inventoryChanges(states[i - 1], states[i])) if (item.change < 0) decreases.set(item.item, (decreases.get(item.item) || 0) + item.change);
    }
    const inventoryKnown = !!states[0]?.inventory && !!states.at(-1)?.inventory;
    const retained = inventoryKnown ? inventoryChanges(states[0], states.at(-1)!) : [];
    const reduced = [...decreases].map(([item, change]) => ({ item, change })).sort((a, b) => a.item.localeCompare(b.item));
    const retention = { deathEvents: deaths, inventoryComparisonKnown: inventoryKnown, netRetainedDelta: retained.slice(0, 8),
      observedInventoryDecreases: reduced.slice(0, 6), unknownTransitions,
      omitted: { netRetainedDelta: Math.max(0, retained.length - 8), observedInventoryDecreases: Math.max(0, reduced.length - 6) } };
    const warnings = [
      ...(deaths ? ['近期发生死亡；零星拾取或方块改动不抵消死亡与背包减少，结合实际保有资源复核目标。'] : []),
      ...(changed.length ? [`重大情境变化：${JSON.stringify(changed)}。先结合当前身体和环境，自主复核旧goal/plan是否还适用；旧打算不是必须继续执行的命令。`] : []),
      ...(repeated.length || unchanged >= 3 ? [`需要反思：最近连续${unchanged}轮没有记录到背包新增或方块改动；重复返回相同结果的查询：${JSON.stringify(repeated)}。这不证明探索无价值或目标不可达。检查正在依赖的假设；决定继续的理由、换一种可验证的尝试或修改goal/plan，别仅把同一计划再说一遍。`] : []),
    ];
    const header = `近期死亡与资源保有：${JSON.stringify(retention)}\n净变化比较窗口首末实际背包；减少可能来自消耗、转移或丢失，不推断原因或资源价值。未知库存不算空包；采集回执仍保留在下方。\n${warnings.join('\n')}\n最近${reports.length}轮真实变化（较旧在前；移动/扫描/聊天次数不等于资源进展；位移不是完整路径）${hasPending ? '，末项含本轮新接收的异步回执' : ''}。回执按首次接收轮去重，可能源于上一轮或已撤销的intent；保留实际成果不代表当前目标完成：\n`;
    const room = Math.max(0, budget - header.length - 40);
    // Keep complete records, dropping older ones instead of cutting JSON.
    while (rows.length > 1 && JSON.stringify(rows).length > room) rows.shift();
    return clipped(header + (JSON.stringify(rows).length <= room ? JSON.stringify(rows) : '详细回执超出本次上下文预算。'), budget);
  }

  /** Positions come only from an actual world observation, not from model prose. */
  async recordPlaces(blocks: unknown, dimension: string | undefined) {
    if (!Array.isArray(blocks)) return;
    for (const block of blocks.slice(0, 16)) {
      const position = block?.position || block;
      const name = block?.name;
      if (typeof name !== 'string' || !/(?:_log|_ore|_bed|chest|furnace|crafting_table|portal|spawner|campfire|water|lava)$/u.test(name)
        || !['x', 'y', 'z'].every(key => Number.isFinite(position[key]))) continue;
      const location = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
      const sourceId = `place:${dimension || 'unknown'}:${name}:${location.x},${location.y},${location.z}`;
      await this.add('fact', `曾在实际观察中发现方块地点：${JSON.stringify({ name, dimension: dimension || 'unknown', position: location })}。这是当时的记录，重访时需要检查现状。`, sourceId, undefined, 'place');
    }
  }

  recall(query: string, limit = 5, exclude: Set<string> = new Set()) {
    const tokens = new Set(terms(query));
    return this.entries.map((entry, order) => ({ entry, order,
      score: [...new Set(terms(entry.text))].filter(term => tokens.has(term)).length }))
      .filter(item => item.score > 0 && !item.entry.progress && !reviewCheckpoint(item.entry) && !exclude.has(item.entry.id))
      .sort((a, b) => b.score - a.score || b.order - a.order).slice(0, limit).map(item => item.entry);
  }

  context(query: string, budget = 4500) {
    const reverse = this.entries.filter(entry => !entry.progress && !reviewCheckpoint(entry)).reverse();
    const { goal: currentGoal, plan: latestPlan } = this.activeIntent();
    // Give the latest plan its full space before older goals or teammate prose.
    const current = [latestPlan, currentGoal].filter(Boolean) as WorldMemoryEntry[];
    const other = [...reverse.filter(entry => entry.kind === 'hearsay').slice(0, 3),
      ...reverse.filter(entry => entry.kind === 'intent' && !['goal', 'plan'].includes(entry.topic || '')).slice(0, 2)];
    const pinned = new Set([...current, ...other].map(entry => entry.id));
    const latestObservation = reverse.find(observationMemory);
    const recent = reverse.filter(entry => !pinned.has(entry.id) && entry.kind !== 'intent'
      && (!observationMemory(entry) || entry.id === latestObservation?.id)).slice(0, 8);
    const older = this.recall(query, 5, new Set([...pinned, ...recent.map(entry => entry.id),
      ...reverse.filter(entry => !usefulAutomaticHistory(entry)).map(entry => entry.id)]));
    const headings = ['当前有效目标与关联计划（均为角色意图及自己提出的完成条件；当前身体以本轮观察和后续回执为准）：',
      '同伴原话与其他打算（hearsay仅是听说；旧审议note须结合上方最新目标状态复核）：',
      '近期记忆（最新在前；事实是当时的观察/回执）：',
      '较早相关事实与地点（原文摘录；地点需重访核实，旧计划和临时身体状态可另用显式回忆查找）：'];
    const usable = Math.max(0, budget - headings.join('').length - 12);
    const activeText = compactMemory(current, Math.floor(usable * 0.5))
      || (current.length ? '当前goal/plan超出摘要预算，可显式回忆。' : '当前没有有效goal或plan。');
    const history = this.goalHistoryContext(Math.min(1100, Math.floor(Math.max(0, usable - activeText.length) * 0.35)));
    const remaining = Math.max(0, usable - activeText.length - history.length);
    return `${headings[0]}\n${activeText}\n${history}`
      + `\n${headings[1]}\n${compactMemory(other, Math.floor(remaining * 0.4))}`
      + `\n${headings[2]}\n${compactMemory(recent, Math.floor(remaining * 0.3))}`
      + `\n${headings[3]}\n${compactMemory(older, Math.floor(remaining * 0.3))}`;
  }
}

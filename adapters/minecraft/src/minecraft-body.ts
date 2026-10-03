import { randomUUID } from 'node:crypto';
import { BodyController, type BodyIntent, type BodyCurrent, type BodySelection, type BodyEvent } from '../../../packages/bridge/src/body-controller.ts';
import { action, ApiError, coordinates } from './validation.ts';
import { bodyEnvironment } from './body-observation.ts';
import { entityVisible, entityHealth, haltNative } from './native-actions.ts';
import { inventorySessionUsable } from './craft-sync.ts';
import { trackInputs } from './input-telemetry.ts';
import { findSafeFood, surfaceTargetAvailable } from './continuous-skills.ts';
import { copyGatherState } from './survival-actions.ts';
import { droppedItemSummary } from './entity-observation.ts';
import { BRIDGE_LIMITS, BRIDGE_MATERIALS } from './bridge-skill.ts';
import { validateBuild } from './build-skill.ts';
import { BUILD_LIMITS, compileBuild } from './build-blueprints.ts';
import { createLocalThreats } from './local-threats.ts';
import type { MinecraftWorld, BotRecord } from './world.ts';

const REACTIONS = ['surface', 'eat', 'defend', 'flee'] as const;
const HOSTILE = new Set(['zombie', 'husk', 'drowned', 'skeleton', 'stray', 'wither_skeleton', 'creeper', 'blaze', 'pillager', 'vindicator', 'witch', 'endermite', 'silverfish']);
export const NON_BODY_ACTIONS = new Set(['scan', 'recipes', 'say', 'broadcast']);
export type BodyPolicy = { retreatHealth: number; eatBelow: number; threatRange: number; chaseRange: number };
export interface MinecraftPlan { steps: any[]; policy: BodyPolicy; label: string; anchor: { x: number; y: number; z: number }; terminal: boolean }
export interface MinecraftAppend { expectedVersion: number; steps: any[]; ttlMs?: number; terminal?: boolean }
interface FastState { ready: boolean; health: number; food: number; water: boolean; lava: boolean; oxygen?: number; enemies: any[] }
type SkillRequest = { native: any; step?: number; version: number; reaction?: string };
type BridgeProgress = { spent: number; inventoryConfirmed: boolean; exhausted: boolean; origin: { x: number; y: number; z: number } };
type MovementOrigin = MinecraftPlan['anchor'];
const shoreTargetKey = (target: MovementOrigin) => [target.x, target.y, target.z].join(',');
const ENCOUNTER_CLEAR_MS = 2000;
const CONFIRMATION_WAIT_MS = 5000;
const MAX_UNPRODUCTIVE_ATTEMPTS = 3;
const TERMINAL_CODES = new Set(['invalid_block', 'invalid_item', 'no_visible_resource', 'candidates_exhausted',
  'missing_tool', 'missing_prerequisites', 'distance_limit', 'authorization_exhausted', 'not_hungry']);
type ReactionBlocked = { reaction: string; encounterId: string; intentVersion: number; receiptId: number; code: string };
type GatherState = { origin: MovementOrigin; attemptedTargets: string[]; movementAttempts: number };

// A bounded navigation attempt has already exhausted its local correction.
// The brain must inspect the result before authorizing another attempt. These
// codes describe this executor's attempt, not absolute world reachability.
const REPLAN_CODES = new Set(['jump_arc_blocked', 'jump_out_of_range', 'landing_unavailable',
  'jump_no_trajectory', 'missed_landing', 'fell_below_target', 'target_blocked', 'no_visible_route',
  'no_path', 'search_budget', 'movement_budget', 'node_budget', 'read_budget', 'planning_budget',
  'step_blocked', 'head_blocked', 'vertical_only', 'hazard', 'hazardous_landing',
  'unsupported_drop', 'no_progress', 'target_changed', 'target_not_visible', 'target_out_of_range', 'target_occluded',
  'shore_route_blocked', 'build_conflict', 'build_unknown_cell', 'build_missing_material', 'build_unreachable', 'build_passage_blocked', 'build_range_limit']);
type ReplanRequired = { intentVersion: number; stepIndex: number; receiptId: number; code: string; reason: string };
function stoppedCode(details: any): string | undefined {
  // A compound skill may successfully approach before discovering a different
  // terminal prerequisite. Its own typed outcome supersedes historical legs.
  if (typeof details?.stoppedReason === 'string' && /^[a-z][a-z0-9_]*$/u.test(details.stoppedReason)) return details.stoppedReason;
  // Outer navigation receipts can retain an earlier obstacle as evidence. Its
  // code must not override the current reason (e.g. not_grounded or cancellation).
  const code = details?.navigation?.stoppedReason ?? details?.travel?.stoppedReason
    ?? details?.approach?.stoppedReason ?? details?.stoppedReason ?? details?.movement?.reasonCode ?? details?.dig?.reasonCode;
  return typeof code === 'string' ? code : undefined;
}

/** The world timeout leaves the bridge's own deadline time to drain its receipt. */
export function bodyActionTimeoutMs(action: any) {
  if (action.type === 'build') return BUILD_LIMITS.sliceMs + 3000;
  if (action.type === 'bridge') return BRIDGE_LIMITS.timeoutMs + 3000;
  if (action.type === 'fish') return action.durationMs + 8000;
  return ['gather', 'craft', 'smelt', 'container'].includes(action.type) ? 45000 : 15000;
}

export function validateBodyAction(raw: any) {
  if (!raw || typeof raw !== 'object') throw new ApiError(400, '无效身体技能。');
  if (raw.type === 'build') { try { return validateBuild(raw); } catch (error:any) { throw new ApiError(400,error.message); } }
  if (raw.type === 'bridge') {
    const { x, z } = coordinates({ x: raw.x, y: 0, z: raw.z });
    const item = typeof raw.item === 'string' ? raw.item.replace(/^minecraft:/u, '') : raw.item ?? 'cobblestone';
    const maxBlocks = raw.maxBlocks ?? 8;
    if (!BRIDGE_MATERIALS.includes(item)) throw new ApiError(400, '搭桥材料必须是已支持的稳定完整方块。');
    if (!Number.isInteger(maxBlocks) || maxBlocks < 0 || maxBlocks > BRIDGE_LIMITS.materialBudget)
      throw new ApiError(400, '搭桥材料预算必须是0–12块，重试不会重置预算。');
    return { type: 'bridge', x, z, item, maxBlocks, ...(raw.origin ? { origin: coordinates(raw.origin) } : {}) };
  }
  if (['jump_to', 'surface', 'combat', 'retreat', 'eat', 'pickup'].includes(raw.type)) {
    const type = raw.type, maxDurationMs = ['jump_to', 'retreat'].includes(type) ? 5000 : 10000;
    const durationMs = raw.durationMs ?? (type === 'jump_to' ? 5000 : type === 'retreat' ? 3000 : 8000);
    if (!Number.isInteger(durationMs) || durationMs < 50 || durationMs > maxDurationMs)
      throw new ApiError(400, `技能时限必须是50–${maxDurationMs}毫秒。`);
    if (type === 'jump_to') return { type, ...coordinates(raw), durationMs };
    if (type === 'combat' || type === 'retreat' || type === 'pickup') {
      if (!Number.isInteger(raw.entityId) || raw.entityId < 0) throw new ApiError(400, '技能需要当前可见实体ID。');
      const maxDistance = raw.maxDistance ?? 12;
      const maxRange = type === 'pickup' ? 32 : 24;
      if (!Number.isFinite(maxDistance) || maxDistance < 0 || maxDistance > maxRange)
        throw new ApiError(400, `局部移动范围必须是0–${maxRange}格。`);
      return { type, entityId: raw.entityId, durationMs, maxDistance,
        ...(raw.origin ? { origin: coordinates(raw.origin) } : {}) };
    }
    return { type, durationMs, ...(type === 'surface' && raw.target ? { target: coordinates(raw.target) } : {}) };
  }
  const parsed = action(raw);
  if (NON_BODY_ACTIONS.has(parsed.type) || parsed.type === 'stop' || parsed.type === 'posture')
    throw new ApiError(400, '查询和聊天请使用action；停止使用cancel_body。浮水使用surface技能。');
  return parsed;
}

/** The quick loop consumes only this actor's local perception and planner-authorized reactions. */
export class MinecraftBody {
  readonly controller: BodyController<FastState, MinecraftPlan, SkillRequest>;
  readonly telemetry: ReturnType<typeof trackInputs>;
  private world: MinecraftWorld;
  private record: BotRecord;
  private emitMetric: (event: any) => void;
  private completed = new Set<number>();
  private mined = new Map<number, number>();
  private gathering = new Map<number, { item: string; before: number }>();
  private gatherStates = new Map<number, GatherState>();
  private unproductive = new Map<number, number>();
  private confirmationWait = new Map<number, { at: number; code: string }>();
  private lastStepReceipt = new Map<number, number>();
  private throughputOptimizations = true;
  private planningLatencies: number[] = [];
  private skillDurations = new Map<string, number[]>();
  private skillStart?: { key: string; position: MovementOrigin; health?: number; food: number };
  private bridges = new Map<number, BridgeProgress>();
  private buildTotals = new Map<number, number>();
  private stepOrigins = new Map<number, MovementOrigin>();
  private encounter?: { id: string; origin: MovementOrigin; exitRange: number; clearSince?: number;
    blocked?: Record<string, ReactionBlocked>; unproductive?: Record<string, number> };
  private movementScope = 0;
  private dimension?: string;
  private lastHealth?: number;
  private movementListeners: { event: string; listener: (...args: any[]) => void }[] = [];
  private localThreats: ReturnType<typeof createLocalThreats>;
  private cache?: { at: number; enemies: any[] };
  private hazard?: { id: string; key: string; at: number; reacted?: boolean };
  private quietUntil = 0;
  private lastDangerAt = 0;
  private activeReaction?: string;
  private goalFinished = false;
  private planningNotice?: string;
  private planningCheckPending = false;
  private replanRequired?: ReplanRequired;
  private blockedShoreTargets = new Set<string>();
  private goalStatus: 'idle' | 'working' | 'blocked' | 'watching' | 'completed' | 'cancelled' | 'expired' | 'stopped' = 'idle';

  constructor(world: MinecraftWorld, record: BotRecord, emitMetric: (event: any) => void = () => {}) {
    this.world = world; this.record = record;
    this.localThreats = createLocalThreats(record.bot, {
      isVisible: entity => entityVisible(record.bot, entity),
      isAlive: entity => entityHealth(record.bot, entity) !== 0,
    });
    this.emitMetric = event => { try { emitMetric(event); } catch { /* Observability cannot take body ownership. */ } };
    record.waterPosture?.disable();
    this.telemetry = trackInputs(record.bot, event => {
      this.emitMetric(event);
      const reaction = this.activeReaction;
      const relevant = event.type === 'input' && (event.channel === 'aim' || event.channel === 'use_entity'
        || (event.channel?.startsWith('key:') && event.value === true));
      if (relevant && this.hazard && !this.hazard.reacted &&
        (this.hazard.key === 'water' ? reaction === 'surface' : ['defend', 'flee'].includes(reaction || ''))) {
        this.hazard.reacted = true;
        this.emitMetric({ type: 'reaction', at: event.at, hazardId: this.hazard.id });
      }
    });
    this.controller = new BodyController({
      readState: () => this.readState(),
      select: (state, intent, current) => this.select(state, intent, current),
      execute: async (request, signal) => world.executeOwned(record.name, request.native, signal),
      halt: () => haltNative(record.bot),
      onEvent: event => this.onEvent(event), tickMs: 50,
    });
    this.dimension = record.bot.game?.dimension;
    this.lastHealth = record.bot.health;
    for (const event of ['death', 'respawn', 'spawn', 'end', 'game', 'health']) {
      const listener = () => {
        if (['death', 'respawn', 'spawn', 'end'].includes(event)) this.resetMovementScope();
        this.checkMovementLifecycle();
      };
      record.bot.on(event, listener); this.movementListeners.push({ event, listener });
    }
    const hurt = (victim: any, source: any) => {
      const status = this.controller.snapshot();
      if (!record.ready || status.stopped || status.disposed) return;
      // Mineflayer supplies the local damage source; proximity alone is not evidence.
      if (this.localThreats.record(victim, source)) this.cache = undefined;
    };
    record.bot.on('entityHurt', hurt); this.movementListeners.push({ event: 'entityHurt', listener: hurt });
    this.controller.start();
  }

  snapshot() {
    const snapshot = this.controller.snapshot();
    return { ...snapshot, goalStatus: snapshot.stopped ? 'stopped' : this.goalFinished ? 'completed' : this.goalStatus,
      workCompleted: this.goalFinished, completedSteps: [...this.completed],
      ...this.planningState(snapshot),
      reactionBlocked: Object.values(this.encounter?.blocked ?? {}),
      ...(this.replanRequired ? { replanRequired: { ...this.replanRequired } } : {}),
      bridgeProgress: [...this.bridges].map(([step, progress]) => ({ step, ...progress })), inputs: this.telemetry.snapshot() };
  }

  /** Feature ablation is configured before work starts; never mutates a live grant. */
  setThroughputOptimizations(enabled: boolean) {
    if (enabled === this.throughputOptimizations) return;
    const snapshot = this.controller.snapshot();
    if (snapshot.intent || snapshot.current) throw new ApiError(409, '吞吐量策略只能在身体空闲且没有授权目标时切换。');
    this.throughputOptimizations = enabled;
  }

  /** Measured brain-start to first accepted plan, not individual token latency. */
  recordPlanningLatency(ms: number) {
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.planningLatencies.push(Math.min(60000, Math.max(500, ms)));
    if (this.planningLatencies.length > 16) this.planningLatencies.shift();
  }

  submit(raw: any, resume = false) {
    const snapshot = this.controller.snapshot();
    if (!Number.isInteger(raw?.expectedVersion) || raw.expectedVersion !== snapshot.version)
      return { accepted: false, reason: 'stale_version', version: snapshot.version };
    if (!Array.isArray(raw.steps) || raw.steps.length > 12) throw new ApiError(400, 'steps必须是最多12个技能的数组；空数组表示保持观察与授权的自保。');
    const steps = raw.steps.map(validateBodyAction);
    if (raw.terminal !== undefined && typeof raw.terminal !== 'boolean') throw new ApiError(400, 'terminal必须是布尔值。');
    const terminal = raw.terminal ?? false;
    const ttlMs = raw.ttlMs ?? 120000;
    if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300000) throw new ApiError(400, '目标授权时限必须是1–300秒。');
    const reactions = raw.reactions ?? [];
    if (!Array.isArray(reactions) || reactions.some((r: any) => !REACTIONS.includes(r))) throw new ApiError(400, '无效应急授权。');
    const policy: BodyPolicy = { retreatHealth: 6, eatBelow: 14, threatRange: 7, chaseRange: 12, ...raw.policy };
    for (const [key, max] of [['retreatHealth', 20], ['eatBelow', 20], ['threatRange', 16], ['chaseRange', 24]] as const) {
      if (!Number.isFinite(policy[key]) || policy[key] < 0 || policy[key] > max) throw new ApiError(400, `${key}超出允许范围。`);
    }
    const old = snapshot.intent;
    if (old && !raw.restart && !snapshot.stopped && JSON.stringify(old.goal.steps) === JSON.stringify(steps)
      && old.goal.terminal === terminal
      && JSON.stringify(old.goal.policy) === JSON.stringify(policy)
      && JSON.stringify([...old.allowedReactions].sort()) === JSON.stringify([...new Set(reactions)].sort())) {
      const renewed = this.controller.renew(snapshot.version, Date.now() + ttlMs);
      return { ...renewed, status: renewed.accepted ? 'accepted' : 'rejected', unchanged: renewed.accepted,
        intentId: old.id, note: '相同目标仅续期，保留当前执行和进度；确需从头重做时显式restart=true。', control: this.snapshot() };
    }
    const anchor = coordinates(this.record.bot.entity?.position);
    const intent = { id: randomUUID(), version: snapshot.version + 1, goal: { steps, policy, anchor, terminal, label: String(raw.label ?? 'NPC目标').slice(0, 160) },
      expiresAt: Date.now() + ttlMs, allowedReactions: reactions };
    const result = resume ? this.controller.resume(intent) : this.controller.submit(intent);
    if (result.accepted) { this.completed.clear(); this.mined.clear(); this.gathering.clear(); this.gatherStates.clear(); this.unproductive.clear(); this.confirmationWait.clear(); this.lastStepReceipt.clear(); this.bridges.clear(); this.buildTotals.clear(); this.stepOrigins.clear(); this.hazard = undefined; this.quietUntil = 0; this.controller.tick(); }
    return { ...result, intentId: result.accepted ? intent.id : undefined, status: result.accepted ? 'accepted' : 'rejected',
      note: '接收不代表完成；身体使用独立生命周期，停止思考不会撤销此目标。', control: this.snapshot() };
  }

  /** Append only; progress, material budgets, origins and reactions belong to
   * the existing lineage. Omitted TTL preserves its current finite lease. */
  append(raw: MinecraftAppend) {
    const snapshot = this.controller.snapshot(), old = snapshot.intent;
    if (!Number.isSafeInteger(raw?.expectedVersion) || raw.expectedVersion !== snapshot.version)
      return { accepted: false, reason: 'stale_version', version: snapshot.version };
    if (!Array.isArray(raw.steps) || !raw.steps.length || raw.steps.length + (old?.goal.steps.length ?? 0) > 12)
      throw new ApiError(400, '追加steps必须是非空技能数组；包含已完成步骤的计划总长度最多12步。');
    const steps = raw.steps.map(validateBodyAction);
    if (raw.terminal !== undefined && typeof raw.terminal !== 'boolean') throw new ApiError(400, 'terminal必须是布尔值。');
    if (raw.ttlMs !== undefined && (!Number.isInteger(raw.ttlMs) || raw.ttlMs < 1000 || raw.ttlMs > 300000))
      throw new ApiError(400, '目标授权时限必须是1–300秒。');
    if (!old || snapshot.stopped || snapshot.disposed || this.workBlocked(snapshot))
      return { accepted: false, reason: 'append_unavailable', version: snapshot.version };
    const result = this.controller.extend(raw.expectedVersion, { ...old.goal, terminal: raw.terminal ?? old.goal.terminal, steps: [...old.goal.steps, ...steps] },
      raw.ttlMs === undefined ? old.expiresAt : Date.now() + raw.ttlMs);
    if (result.accepted) this.controller.tick();
    return { ...result, status: result.accepted ? 'accepted' : 'rejected', intentId: result.accepted ? old.id : undefined,
      control: this.snapshot() };
  }

  private planningState(snapshot: ReturnType<MinecraftBody['controller']['snapshot']>) {
    const intent = snapshot.intent, now = Date.now();
    const remainingSteps = intent?.goal.steps.filter((_, index) => !this.completed.has(index)).length ?? 0;
    const sorted = [...this.planningLatencies].sort((a, b) => a - b);
    const planningHorizonMs = Math.min(60000, (sorted.length ? sorted[Math.ceil(sorted.length * .9) - 1] : 12000) + 1500);
    let remainingWorkMs = 0, position = coordinates(this.record.bot.entity?.position ?? { x: 0, y: 0, z: 0 });
    for (const [index, step] of (intent?.goal.steps ?? []).entries()) {
      if (this.completed.has(index)) continue;
      let duration = this.estimateStepMs(step, index, position);
      // Route estimates already use the live position, so do not subtract
      // elapsed travel a second time. Timed skills use their remaining slice.
      if (snapshot.current?.skill.action.step === index && !snapshot.current.skill.action.reaction
        && !['goto', 'travel', 'jump_to', 'bridge'].includes(step.type))
        duration = Math.max(50, duration - Math.max(0, now - snapshot.current.startedAt));
      remainingWorkMs += duration;
      if (['goto', 'jump_to', 'travel', 'bridge', 'look_at'].includes(step.type) && Number.isFinite(step.x) && Number.isFinite(step.z))
        position = { x: step.x, y: step.y ?? position.y, z: step.z };
    }
    const planningNeeded = !!intent && intent.expiresAt > now && !snapshot.stopped && !snapshot.disposed
      && !this.workBlocked(snapshot)
      && this.record.ready && this.record.bot.health > 0 && remainingSteps > 0
      && (this.throughputOptimizations
        ? !intent.goal.terminal && remainingWorkMs <= planningHorizonMs || intent.expiresAt - now <= planningHorizonMs
        : remainingSteps <= 2 || intent.expiresAt - now <= 15000);
    return { remainingSteps, planningNeeded, planningHorizonMs, remainingWorkMs: Math.round(remainingWorkMs) };
  }

  private estimateStepMs(step: any, index: number, position: MovementOrigin) {
    if (step.type === 'wait' || step.type === 'move') return step.ms;
    const history = this.skillDurations.get(step.type) ?? [];
    const sorted = [...history].sort((a, b) => a - b), measured = sorted[Math.floor(sorted.length / 2)];
    if (step.type === 'build') {
      let total=this.buildTotals.get(index);
      if(total===undefined){total=compileBuild(step.blueprint,step).blocks.length;this.buildTotals.set(index,total);}
      const receipt=this.controller.snapshot().recentReceipts.find(r=>r.id===this.lastStepReceipt.get(index));
      const details=(receipt?.result as any)?.details;
      const matched=Number.isInteger(details?.matched)?Math.max(0,Math.min(total,details.matched)):0;
      const perBlock=measured===undefined?1000:measured/Math.max(1,details?.placed??step.batchBlocks??BUILD_LIMITS.sliceBlocks);
      return Math.max(100,(total-matched)*Math.max(500,Math.min(10000,perBlock)));
    }
    if (step.type === 'gather') return Math.max(0, step.count - (this.mined.get(index) ?? 0)) * (measured ?? 4000);
    if (['goto', 'travel', 'jump_to', 'bridge'].includes(step.type) && Number.isFinite(step.x) && Number.isFinite(step.z)) {
      const distance = Math.hypot(step.x - position.x, step.z - position.z, (step.y ?? position.y) - position.y);
      return Math.max(100, distance / 3.5 * 1000 + 300);
    }
    return measured ?? step.durationMs ?? ({ look: 150, equip: 250, place: 1000, dig: 3000,
      craft: 1500, smelt: 10000, container: 1500, eat: 2000 } as Record<string, number>)[step.type] ?? 2000;
  }

  private workBlocked(snapshot: ReturnType<MinecraftBody['controller']['snapshot']>) {
    const index = snapshot.intent?.goal.steps.findIndex((_, step) => !this.completed.has(step)) ?? -1;
    const bridge = this.bridges.get(index);
    return !!snapshot.blocked || !!this.replanRequired || this.goalStatus === 'blocked'
      || !!bridge && (!bridge.inventoryConfirmed || bridge.exhausted);
  }

  private queuePlanningCheck() {
    if (this.planningCheckPending) return;
    this.planningCheckPending = true;
    // Selection runs before core preconditions/backoff. Report only after that
    // tick has established whether the current work can actually continue.
    queueMicrotask(() => {
      this.planningCheckPending = false;
      const snapshot = this.controller.snapshot(), planning = this.planningState(snapshot), intent = snapshot.intent;
      if (!intent || !planning.planningNeeded) return;
      const notice = `${snapshot.version}:${planning.remainingSteps}`;
      if (this.planningNotice === notice) return;
      this.planningNotice = notice;
      try { this.world.event(this.record, 'planning-needed', { intentId: intent.id, intentVersion: snapshot.version,
        ...planning, expiresAt: intent.expiresAt, reason: this.throughputOptimizations
          ? intent.expiresAt - Date.now() <= planning.planningHorizonMs ? 'lease-low' : 'work-time-low'
          : planning.remainingSteps <= 2 ? 'steps-low' : 'lease-low' }); }
      catch { /* Planning notifications cannot take body ownership. */ }
    });
  }

  cancel(expectedVersion: number) {
    const current = this.controller.snapshot().version;
    if (expectedVersion !== current) return { accepted: false, version: current, reason: 'stale_version' };
    return this.controller.cancel(current + 1);
  }
  stop(reason?: string) { return this.controller.stop(reason); }
  async dispose() {
    await this.controller.dispose(); this.telemetry.dispose();
    for (const { event, listener } of this.movementListeners) this.record.bot.removeListener(event, listener);
    this.movementListeners = [];
  }

  private resetMovementScope() {
    this.encounter = undefined; this.stepOrigins.clear(); this.cache = undefined;
    this.localThreats.clear();
    this.lastDangerAt = 0; this.movementScope++;
  }

  private checkMovementLifecycle() {
    const { bot } = this.record, dimension = bot.game?.dimension;
    if (this.dimension !== undefined && dimension !== undefined && dimension !== this.dimension
      || bot.health <= 0 && this.lastHealth !== bot.health) this.resetMovementScope();
    else if (this.encounter && Number.isFinite(bot.health) && Number.isFinite(this.lastHealth) && bot.health < this.lastHealth!)
      this.encounter.clearSince = undefined;
    this.dimension = dimension; this.lastHealth = bot.health;
  }

  private updateEncounter(state: FastState, policy: BodyPolicy, current: BodyCurrent<SkillRequest> | undefined, now: number) {
    if (!this.encounter) return;
    // A narrower replacement policy cannot manufacture a safe gap. The exit
    // radius has hysteresis; brief lost sight and reaction draining do not reset it.
    this.encounter.exitRange = Math.max(this.encounter.exitRange, policy.threatRange + 2);
    const reacting = current?.skill.reaction === 'defend' || current?.skill.reaction === 'flee';
    if (!state.ready || state.water || state.lava || reacting || state.enemies.some(enemy => enemy.distance <= this.encounter!.exitRange)) {
      this.encounter.clearSince = undefined; return;
    }
    this.encounter.clearSince ??= now;
    if (now - this.encounter.clearSince >= ENCOUNTER_CLEAR_MS) this.encounter = undefined;
  }

  private readState(): FastState {
    const bot = this.record.bot, now = Date.now();
    this.checkMovementLifecycle();
    this.emitMetric({ type: 'control-tick', at: now });
    const ready = this.record.ready && !!bot.entity && bot.health > 0;
    if (ready && (!this.cache || now - this.cache.at >= 200)) {
      const enemies = Object.values(bot.entities).filter((e: any) => e.id !== bot.entity.id
        && (HOSTILE.has(e.name) || this.localThreats.has(e))
        && entityHealth(bot, e) !== 0
        && e.position && e.position.distanceTo(bot.entity.position) <= 24 && entityVisible(bot, e));
      this.cache = { at: now, enemies };
    }
    const environment = bodyEnvironment(bot);
    return { ready, health: bot.health, food: bot.food, water: environment.locomotion?.inWater === true,
      lava: environment.locomotion?.inLava === true, oxygen: environment.oxygen?.level,
      enemies: ready ? (this.cache?.enemies || []).filter(e => bot.entities[e.id] === e && entityHealth(bot, e) !== 0
        && (HOSTILE.has(e.name) || this.localThreats.has(e)))
        .map(e => ({ id: e.id, name: e.name, distance: e.position.distanceTo(bot.entity.position) })).sort((a, b) => a.distance - b.distance) : [] };
  }

  private select(state: FastState, intent: BodyIntent<MinecraftPlan>, current?: BodyCurrent<SkillRequest>): BodySelection<SkillRequest> {
    this.queuePlanningCheck();
    // Work completion and policy authorization have different lifetimes. Even
    // while a new hazard is being handled, tell the brain its original work is done.
    if (intent.goal.steps.length && intent.goal.steps.every((_, index) => this.completed.has(index))) this.finishGoal(intent);
    const now = Date.now(), allowed = intent.allowedReactions, p = intent.goal.policy;
    this.updateEncounter(state, p, current, now);
    if (!state.ready) return { kind: 'wait', reason: 'body_unavailable' };
    const run = (native: any, priority: number, reaction?: string, step?: number): BodySelection<SkillRequest> => ({
      // Until a planned combat step actually starts, its provisional origin may
      // move while a reaction drains. Identity stays stable during that wait;
      // the committed origin then belongs to this lineage/step for its lifetime.
      kind: 'run', key: `${intent.id}:${reaction || `step-${step}`}:${JSON.stringify(['combat', 'retreat'].includes(native.type)
        ? { ...native, origin: undefined, movementScope: this.movementScope, encounter: reaction ? this.encounter?.id : undefined }
        : native.type === 'gather' ? { ...native, gatherState: undefined } : native)}`,
      action: { native, version: intent.version, reaction, step }, reaction, priority,
      timeoutMs: bodyActionTimeoutMs(native) + (native.type === 'bridge' ? 2000 : 3000),
    });
    const markHazard = (key: string) => {
      if (this.hazard?.key === key) return;
      this.hazard = { id: randomUUID(), key, at: now };
      this.emitMetric({ type: 'hazard-observed', at: now, hazardId: this.hazard.id });
    };
    // Reuse a locally valid shore, but an obsolete work target cannot prevent
    // authorized vertical ascent. Reaction receipts never complete shore work.
    if (state.water && allowed.includes('surface') && !state.lava
      && (state.oxygen === undefined || state.oxygen < 18)) {
      markHazard('water');
      const plannedSurface = intent.goal.steps.find((s: any, i: number) => s.type === 'surface' && !this.completed.has(i));
      const surface = current?.skill.reaction === 'surface' ? current.skill.action.native : plannedSurface;
      const usable = surface && (!surface.target || !this.blockedShoreTargets.has(shoreTargetKey(surface.target))
        && surfaceTargetAvailable(this.record.bot, surface.target));
      return run(usable ? surface : { type: 'surface', durationMs: surface?.durationMs ?? 8000 }, 100, 'surface');
    }
    const enemy = state.enemies.find(e => e.distance <= p.threatRange);
    if (enemy) {
      this.lastDangerAt = now; markHazard(`enemy:${enemy.id}`);
      const reactionOrigin = () => {
        this.encounter ??= { id: randomUUID(), origin: coordinates(this.record.bot.entity.position), exitRange: p.threatRange + 2 };
        this.encounter.clearSince = undefined; return this.encounter.origin;
      };
      if ((state.health <= p.retreatHealth || enemy.name === 'creeper') && allowed.includes('flee')
        && !this.encounter?.blocked?.flee)
        return run({ type: 'retreat', entityId: enemy.id, durationMs: 3000, maxDistance: p.chaseRange, origin: reactionOrigin() }, 90, 'flee');
      if (allowed.includes('defend') && !this.encounter?.blocked?.defend)
        return run({ type: 'combat', entityId: enemy.id, durationMs: 8000, maxDistance: p.chaseRange, origin: reactionOrigin() }, 80, 'defend');
    }
    // Finish an already authorized short reaction to avoid jitter at perception boundaries.
    if (current?.skill.reaction && now - this.lastDangerAt < 500 && ['defend', 'flee'].includes(current.skill.reaction)) return current.skill;
    if (!enemy) this.hazard = undefined;
    const hasFood = inventorySessionUsable(this.record.bot) && findSafeFood(this.record.bot);
    if (state.food < p.eatBelow && allowed.includes('eat') && hasFood && now >= this.quietUntil)
      return run({ type: 'eat' }, 40, 'eat');
    const index = intent.goal.steps.findIndex((_, i) => !this.completed.has(i));
    if (index < 0) {
      // Do not revoke authorized survival reactions merely because a work list
      // ended. The original lease still expires and can be revoked by the brain.
      if (intent.goal.steps.length && !allowed.length) return { kind: 'complete' };
      return { kind: 'wait' };
    }
    const step = intent.goal.steps[index];
    // Reflexes above remain authorized even while ordinary work awaits a new
    // decision. Renewal alone does not erase failure or replay completed work.
    if (this.replanRequired?.intentVersion === intent.version && this.replanRequired.stepIndex === index) {
      // Oxygen recovery stops selecting a new reaction, but blocked ordinary
      // work must not repeatedly abort an already authorized floating slice.
      // Its native loop still releases input in air and ends on dry ground;
      // the controller retains cancellation, lease and skill deadlines.
      if (current?.skill.reaction === 'surface' && allowed.includes('surface') && state.water && !state.lava)
        return current.skill;
      return { kind: 'wait', reason: `replan_required:${this.replanRequired.code}` };
    }
    if (step.type === 'bridge') {
      let progress = this.bridges.get(index);
      if (!progress) {
        progress = { spent: 0, inventoryConfirmed: true, exhausted: false, origin: coordinates(this.record.bot.entity.position) };
        this.bridges.set(index, progress);
      }
      if (!progress.inventoryConfirmed || !inventorySessionUsable(this.record.bot)) return { kind: 'wait', reason: 'bridge_inventory_unconfirmed' };
      if (progress.exhausted) return { kind: 'wait', reason: 'bridge_budget_exhausted' };
      // A zero budget still permits walking on the already confirmed bridge.
      // Only an actual need for another block exhausts this step's authority.
      return run({ ...step, origin: progress.origin, maxBlocks: Math.max(0, step.maxBlocks - progress.spent) }, 10, undefined, index);
    }
    if (step.type === 'gather') {
      const bot = this.record.bot;
      if (!inventorySessionUsable(bot)) return this.waitForConfirmation(intent, index, 'inventory_unconfirmed');
      const count = (name: string) => bot.inventory.items().filter((i: any) => i.name === name).reduce((n: number, i: any) => n + i.count, 0);
      // Same-name block items (logs, dirt, etc.) have an explicit inventory goal.
      // Other blocks retain mined-block semantics; receipts expose their actual drops.
      const expectedItem = bot.registry?.itemsByName?.[step.block];
      const blockDrops = bot.registry?.blocksByName?.[step.block]?.drops;
      if (!this.gathering.has(index) && expectedItem && (!blockDrops || blockDrops.includes(expectedItem.id)))
        this.gathering.set(index, { item: step.block, before: count(step.block) });
      const gathering = this.gathering.get(index), remaining = step.count - (this.mined.get(index) || 0);
      if (remaining <= 0) {
        if (!gathering || count(gathering.item) - gathering.before >= step.count) {
          this.completed.add(index); return this.select(state, intent, current);
        }
        const origin = this.gatherStates.get(index)?.origin;
        const drop = origin && Object.values(bot.entities).find((e: any) => ['item', 'item_stack'].includes(e.name)
          && e.position.distanceTo(origin) <= step.maxDistance && entityVisible(bot, e)
          && droppedItemSummary(e)?.name === gathering.item) as any;
        if (drop) { this.confirmationWait.delete(index); return run({ type: 'pickup', entityId: drop.id, origin, maxDistance: step.maxDistance, durationMs: 8000 }, 10, undefined, index); }
        return this.waitForConfirmation(intent, index, 'mined_but_pickup_unconfirmed');
      }
      this.confirmationWait.delete(index);
      return run({ ...step, count: Math.min(1, remaining), gatherState: this.gatherStates.get(index)
        ?? { origin: coordinates(bot.entity.position), attemptedTargets: [], movementAttempts: 0 } }, 10, undefined, index);
    }
    return run(['combat', 'retreat'].includes(step.type) ? { ...step, origin: this.stepOrigins.get(index) ?? coordinates(this.record.bot.entity.position),
      maxDistance: Math.min(step.maxDistance, p.chaseRange) } : step, 10, undefined, index);
  }

  private blockStep(intent: BodyIntent<MinecraftPlan>, index: number, code: string, receiptId: number, reason = code) {
    if (this.replanRequired || this.completed.has(index)) return;
    this.replanRequired = { intentVersion: intent.version, stepIndex: index, receiptId, code, reason: reason.slice(0, 240) };
    this.goalStatus = 'blocked';
    try { this.world.event(this.record, 'goal-blocked', { ...this.replanRequired, intentId: intent.id,
      note: '本次执行需要重新观察或规划；保留已有进度和应急授权，相同计划续期不会重试。' }); }
    catch { /* Reporting must not revoke survival authorization. */ }
  }

  private waitForConfirmation(intent: BodyIntent<MinecraftPlan>, index: number, code: string): BodySelection<SkillRequest> {
    if (this.throughputOptimizations) {
      let waiting = this.confirmationWait.get(index);
      if (!waiting || waiting.code !== code) { waiting = { at: Date.now(), code }; this.confirmationWait.set(index, waiting); }
      if (Date.now() - waiting.at >= CONFIRMATION_WAIT_MS)
        this.blockStep(intent, index, code, this.lastStepReceipt.get(index) ?? 0);
    }
    return { kind: 'wait', reason: code };
  }

  private madeProgress(receipt: NonNullable<BodyEvent['receipt']>) {
    const result: any = receipt.result, details = result?.details ?? {}, start = this.skillStart;
    const planning = details.travel?.planning;
    const unstartedTravel = receipt.status === 'failed' && result?.action?.type === 'travel'
      && stoppedCode(details) === 'not_grounded' && planning?.plans === 0 && planning.nodes === 0 && planning.legs === 0;
    const blockedShore = receipt.status === 'failed' && result?.action?.type === 'surface' && !!result.action.target
      && stoppedCode(details) === 'shore_route_blocked';
    const blockedRetreat = receipt.status === 'failed' && result?.action?.type === 'retreat'
      && stoppedCode(details) === 'retreat_blocked';
    const current = this.record.bot.entity?.position;
    // Buoyancy does not advance an unstarted horizontal journey or a blocked
    // route to shore. Bouncing in a rejected retreat also does not establish
    // escape progress. Other outcomes and emergency ascent retain vertical credit.
    const moved = start?.key === receipt.key && current && (unstartedTravel || blockedShore || blockedRetreat
      ? Math.hypot(current.x - start.position.x, current.z - start.position.z)
      : current.distanceTo(start.position)) >= .15;
    return !!(moved || details.minedBlocks > 0 || details.spent > 0 || result?.action?.type === 'build' && details.placed > 0 || details.inventoryIncreased === true
      || details.consumptionConfirmed === true || details.killConfirmed === true
      || Number.isFinite(details.healthAfter) && Number.isFinite(details.healthBefore) && details.healthAfter < details.healthBefore
      || start?.key === receipt.key && Number.isFinite(details.healthAfter) && Number.isFinite(start.health) && details.healthAfter < start.health!
      || start?.key === receipt.key && this.record.bot.food > start.food);
  }

  private finishGoal(intent: BodyIntent<MinecraftPlan>) {
    if (this.goalFinished) return;
    this.goalFinished = true;
    this.goalStatus = 'completed';
    try {
      this.world.event(this.record, 'goal-finished', { intentId: intent.id, intentVersion: intent.version,
        status: 'completed', workCompleted: true, completedSteps: [...this.completed],
        terminal: this.throughputOptimizations && intent.goal.terminal,
        reactionsRetained: intent.allowedReactions.length > 0, expiresAt: intent.expiresAt });
    } catch { /* A reporting failure must not withdraw the authorized survival policy. */ }
  }

  private onEvent(event: BodyEvent) {
    const encounterSkill = event.receipt?.reaction === 'defend' || event.receipt?.reaction === 'flee'
      || /:(?:defend|flee):/u.test(event.key ?? '');
    if (this.encounter && (['intent-accepted', 'intent-cancelled', 'intent-expired', 'control-stopped'].includes(event.type)
      || encounterSkill && ['skill-started', 'skill-finished'].includes(event.type)))
      this.encounter.clearSince = undefined;
    if (event.type === 'intent-accepted') {
      this.goalFinished = false;
      this.planningNotice = undefined;
      this.replanRequired = undefined;
      this.blockedShoreTargets.clear();
      this.goalStatus = this.controller.snapshot().intent?.goal.steps.length ? 'working' : 'watching';
    }
    if (event.type === 'intent-extended') { this.goalFinished = false; this.goalStatus = 'working'; }
    const ended = event.type === 'intent-cancelled' ? 'cancelled' : event.type === 'intent-expired' ? 'expired'
      : event.type === 'control-stopped' ? 'stopped' : undefined;
    if (ended) { this.goalStatus = ended; this.goalFinished = false; this.replanRequired = undefined; this.blockedShoreTargets.clear(); }
    if (event.type === 'control-stopped') { this.localThreats.clear(); this.cache = undefined; }
    if (['skill-finished', 'skill-cancelling', 'control-stopped'].includes(event.type)) this.activeReaction = undefined;
    const receipt = event.receipt;
    if (event.type === 'skill-finished' && receipt) {
      const snapshot = this.controller.snapshot(), currentVersion = snapshot.version;
      const shoreResult: any = receipt.result;
      if (snapshot.intent && receipt.intentId === snapshot.intent.id && receipt.status === 'failed'
        && shoreResult?.action?.type === 'surface' && shoreResult.action.target
        && stoppedCode(shoreResult.details) === 'shore_route_blocked') {
        // Keep this failed route scoped to the grant, including append/renew.
        // A late cancelled receipt cannot poison a replacement plan. Retain
        // authorized vertical ascent while the brain chooses another shore.
        const key = shoreTargetKey(shoreResult.action.target);
        this.blockedShoreTargets.add(key);
        if (receipt.reaction === 'surface') {
          const index = snapshot.intent.goal.steps.findIndex((step, i) => step.type === 'surface' && step.target
            && !this.completed.has(i) && shoreTargetKey(step.target) === key);
          if (index >= 0) this.blockStep(snapshot.intent, index, 'shore_route_blocked', receipt.id,
            String(shoreResult.error ?? 'shore_route_blocked'));
        }
      }
      if (snapshot.intent && receipt.intentId === snapshot.intent.id && !receipt.reaction) {
        const match = /:step-(\d+):/u.exec(receipt.key);
        if (match) {
          const index = Number(match[1]), result: any = receipt.result;
          const native = result?.action, details = result?.details || {};
          const step = this.controller.snapshot().intent?.goal.steps[index];
          this.lastStepReceipt.set(index, receipt.id);
          if (native?.type === 'gather') {
            const gatheringState = copyGatherState(details.gatherState);
            if (gatheringState) this.gatherStates.set(index, gatheringState);
          }
          if (native?.type === 'gather') this.mined.set(index, (this.mined.get(index) || 0) + Math.max(0, result.details?.minedBlocks || 0));
          else if (step?.type === 'bridge') {
            const progress = this.bridges.get(index);
            if (progress) {
              const known = native?.type === 'bridge' && details.inventoryConfirmed === true
                && Number.isInteger(details.spent) && details.spent >= 0 && details.spent <= native.maxBlocks;
              if (known) progress.spent += details.spent;
              else progress.inventoryConfirmed = false;
              if (progress.spent > step.maxBlocks) progress.inventoryConfirmed = false;
              progress.exhausted ||= details.stoppedReason === 'budget_exhausted' && progress.spent >= step.maxBlocks;
              if (receipt.status === 'completed' && details.reached === true && progress.inventoryConfirmed) this.completed.add(index);
            }
          }
          else if (receipt.status === 'completed' && step?.type !== 'gather') {
            const finished = native?.type === 'combat' ? details.killConfirmed === true || details.stoppedReason === 'target_dead_observed' || (typeof details.healthAfter === 'number' && details.healthAfter <= 0)
              : native?.type === 'surface' ? (native.target ? details.shoreReached === true : details.dryGround === true || details.surfaceReached === true)
              : native?.type === 'build' ? details.reached === true
              : native?.type === 'jump_to' ? details.reached === true && details.landed === true
              : native?.type === 'eat' ? details.consumptionConfirmed === true : true;
            if (finished) this.completed.add(index);
          }
          const stopped = stoppedCode(details);
          let code = receipt.status === 'failed' && stopped && REPLAN_CODES.has(stopped) ? stopped : undefined;
          if (this.throughputOptimizations && step && !this.completed.has(index) && receipt.status !== 'cancelled') {
            if (stopped && TERMINAL_CODES.has(stopped)) code = stopped;
            const productive = this.madeProgress(receipt);
            const count = productive ? 0 : (this.unproductive.get(index) ?? 0) + 1;
            this.unproductive.set(index, count);
            if (count >= MAX_UNPRODUCTIVE_ATTEMPTS) code ??= 'repeated_no_progress';
            if (productive) this.confirmationWait.delete(index);
          }
          if (step && code) this.blockStep(snapshot.intent, index, code, receipt.id, String(result?.error ?? receipt.reason ?? code));
          if (receipt.status === 'completed' && native && (this.completed.has(index) || this.madeProgress(receipt))) {
            const duration = receipt.finishedAt - receipt.startedAt;
            if (duration >= 50 && duration <= 60000) {
              const durations = this.skillDurations.get(native.type) ?? [];
              durations.push(duration / (native.type === 'gather' ? Math.max(1, details.minedBlocks ?? 1) : 1));
              if (durations.length > 16) durations.shift();
              this.skillDurations.set(native.type, durations);
            }
          }
        }
      }
      if (this.throughputOptimizations && snapshot.intent && receipt.intentId === snapshot.intent.id
        && this.encounter && ['defend', 'flee'].includes(receipt.reaction ?? '') && receipt.status !== 'cancelled') {
        const reaction = receipt.reaction!, details: any = (receipt.result as any)?.details ?? {};
        const stopped = stoppedCode(details);
        this.encounter.unproductive ??= {};
        this.encounter.unproductive[reaction] = this.madeProgress(receipt) ? 0 : (this.encounter.unproductive[reaction] ?? 0) + 1;
        const code = stopped === 'distance_limit' || stopped === 'authorization_exhausted' ? stopped
          : this.encounter.unproductive[reaction] >= MAX_UNPRODUCTIVE_ATTEMPTS ? 'repeated_no_progress' : undefined;
        if (code && !this.encounter.blocked?.[reaction]) {
          const blocked = { reaction, encounterId: this.encounter.id, intentVersion: currentVersion, receiptId: receipt.id, code };
          this.encounter.blocked ??= {}; this.encounter.blocked[reaction] = blocked;
          try { this.world.event(this.record, 'goal-blocked', { ...blocked, intentId: snapshot.intent.id, stepIndex: -1,
            note: '当前遭遇中的反应已达到移动授权边界或没有进展；其它有效工作和反应仍保留。' }); }
          catch { /* Reporting cannot take body ownership. */ }
        }
      }
      if (receipt.reaction === 'eat' && receipt.status !== 'completed') this.quietUntil = Date.now() + 5000;
      this.emitMetric({ type: 'skill-stop', at: event.time, skill: receipt.key });
    }
    if (event.type === 'skill-started') {
      const request = this.controller.snapshot().current?.skill.action;
      if (request) {
        const target = this.record.bot.entities[request.native.entityId];
        this.skillStart = { key: event.key!, position: coordinates(this.record.bot.entity.position),
          health: target ? entityHealth(this.record.bot, target) ?? undefined : undefined, food: this.record.bot.food };
        if (request.step !== undefined && request.native.type === 'gather' && !this.gatherStates.has(request.step)) {
          const state = copyGatherState(request.native.gatherState);
          if (state) this.gatherStates.set(request.step, state);
        }
      }
      if (request && !request.reaction && request.step !== undefined && ['combat', 'retreat'].includes(request.native.type)
        && !this.stepOrigins.has(request.step)) this.stepOrigins.set(request.step, coordinates(request.native.origin));
      this.activeReaction = REACTIONS.find(reaction => event.key?.includes(`:${reaction}:`));
      this.emitMetric({ type: 'skill-start', at: event.time, skill: event.key });
    }
    if (event.type !== 'skill-progress') this.world.event(this.record, event.type, { controlEvent: event });
  }
}

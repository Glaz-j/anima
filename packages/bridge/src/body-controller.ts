/** World-independent, single-owner execution loop. All decision ports are synchronous. */
export interface BodyIntent<Goal> {
  id?: string;
  version: number;
  goal: Goal;
  expiresAt: number;
  allowedReactions: readonly string[];
}

export interface BodySkill<Action> {
  kind: 'run';
  /** Stable identity including the action's target/parameters, not only its name. */
  key: string;
  action: Action;
  priority: number;
  reaction?: string;
  timeoutMs?: number;
  minRunMs?: number;
}

export type BodySelection<Action> = BodySkill<Action>
  | { kind: 'wait'; reason?: string }
  | { kind: 'complete'; reason?: string };

export interface BodyExecutionResult {
  status: 'completed' | 'failed' | 'cancelled';
  reason?: string;
  details?: unknown;
  data?: unknown;
  [key: string]: unknown;
}

export interface BodyReceipt {
  id: number;
  key: string;
  intentId?: string;
  intentVersion: number;
  reaction?: string;
  startedAt: number;
  finishedAt: number;
  status: BodyExecutionResult['status'];
  reason?: string;
  /** Actual outcome is preserved even if authorization was revoked before it arrived. */
  result: BodyExecutionResult;
}

export interface BodyCurrent<Action> {
  id: number;
  intentId?: string;
  intentVersion: number;
  skill: BodySkill<Action>;
  startedAt: number;
  phase: 'running' | 'draining';
  progress?: unknown;
  cancelReason?: string;
}

export interface BodyEvent {
  type: 'intent-accepted' | 'intent-renewed' | 'intent-extended' | 'intent-rejected' | 'intent-cancelled' | 'intent-finished'
    | 'intent-expired' | 'intent-blocked' | 'skill-started' | 'skill-progress'
    | 'skill-cancelling' | 'skill-finished' | 'control-stopped' | 'control-error';
  time: number;
  intentId?: string;
  intentVersion?: number;
  skillId?: number;
  key?: string;
  status?: string;
  reason?: string;
  progress?: unknown;
  receipt?: BodyReceipt;
}

export interface BodyControllerOptions<State, Goal, Action> {
  readState(): State;
  select(state: State, intent: Readonly<BodyIntent<Goal>>, current?: Readonly<BodyCurrent<Action>>): BodySelection<Action>;
  canStart?(state: State, skill: Readonly<BodySkill<Action>>, intent: Readonly<BodyIntent<Goal>>): boolean | string;
  execute(action: Action, signal: AbortSignal, progress: (value: unknown) => void): Promise<BodyExecutionResult>;
  halt(reason: string): void | Promise<void>;
  onEvent?(event: BodyEvent): void;
  now?: () => number;
  tickMs?: number;
  skillTimeoutMs?: number;
  switchDelayMs?: number;
  minRunMs?: number;
  failureBackoffMs?: number;
  maxFailureBackoffMs?: number;
  drainWarningMs?: number;
  receiptLimit?: number;
}

export interface BodyCommandResult { accepted: boolean; version: number; reason?: string }

type Active<Action> = BodyCurrent<Action> & {
  lineage: number;
  controller: AbortController;
  settled: Promise<void>;
  haltSettled?: Promise<void>;
  cancelledAt?: number;
  drainWarned?: boolean;
};

function duration(value: number | undefined, fallback: number, name: string) {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < 0) throw new Error(`Invalid body controller ${name}.`);
  return result;
}

/** No planning request or model AbortSignal owns this controller's lifetime. */
export class BodyController<State, Goal, Action> {
  private options: BodyControllerOptions<State, Goal, Action>;
  private now: () => number;
  private intent?: BodyIntent<Goal>;
  private active?: Active<Action>;
  private version = 0;
  private lineage = 0;
  private stopped = false;
  private disposed = false;
  private ticking = false;
  private timer?: ReturnType<typeof setInterval>;
  private nextId = 0;
  private receipts: BodyReceipt[] = [];
  private failures = new Map<string, { count: number; until: number }>();
  private candidate?: { key: string; since: number };
  private blocked?: string;
  private metrics = { ticks: 0, skillsStarted: 0, skillsCompleted: 0, skillsFailed: 0,
    skillsCancelled: 0, preemptions: 0, rejectedIntents: 0, errors: 0,
    maxTickGapMs: 0, maxDrainMs: 0 };
  private lastTick?: number;
  private settings: { tickMs: number; skillTimeoutMs: number; switchDelayMs: number;
    minRunMs: number; failureBackoffMs: number; maxFailureBackoffMs: number;
    drainWarningMs: number; receiptLimit: number };

  constructor(options: BodyControllerOptions<State, Goal, Action>) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.settings = {
      tickMs: Math.max(1, duration(options.tickMs, 50, 'tickMs')),
      skillTimeoutMs: duration(options.skillTimeoutMs, 15000, 'skillTimeoutMs'),
      switchDelayMs: duration(options.switchDelayMs, 150, 'switchDelayMs'),
      minRunMs: duration(options.minRunMs, 250, 'minRunMs'),
      failureBackoffMs: duration(options.failureBackoffMs, 1000, 'failureBackoffMs'),
      maxFailureBackoffMs: duration(options.maxFailureBackoffMs, 30000, 'maxFailureBackoffMs'),
      drainWarningMs: duration(options.drainWarningMs, 2000, 'drainWarningMs'),
      receiptLimit: Math.max(1, Math.floor(duration(options.receiptLimit, 32, 'receiptLimit'))),
    };
    this.settings.maxFailureBackoffMs = Math.max(this.settings.failureBackoffMs, this.settings.maxFailureBackoffMs);
  }

  private emit(event: Omit<BodyEvent, 'time'>) {
    try { this.options.onEvent?.(structuredClone({ time: this.now(), ...event })); }
    catch { this.metrics.errors += 1; }
  }

  private reject(reason: string): BodyCommandResult {
    this.metrics.rejectedIntents += 1;
    this.emit({ type: 'intent-rejected', intentVersion: this.version, reason });
    return { accepted: false, version: this.version, reason };
  }

  submit(intent: BodyIntent<Goal>): BodyCommandResult {
    if (this.disposed) return this.reject('Controller disposed.');
    if (this.stopped) return this.reject('Controller stopped; explicit resume with a newer intent is required.');
    return this.accept(intent);
  }

  private accept(intent: BodyIntent<Goal>): BodyCommandResult {
    // A reply prepared before a lease expired cannot win merely because the
    // periodic tick has not processed expiry yet.
    this.expireIntentIfNeeded();
    if (!Number.isSafeInteger(intent.version) || intent.version <= this.version) return this.reject('Stale or invalid intent version.');
    if (!Number.isFinite(intent.expiresAt) || intent.expiresAt <= this.now()) return this.reject('Intent already expired.');
    if (intent.id !== undefined && (typeof intent.id !== 'string' || !intent.id
      || intent.id === this.intent?.id || intent.id === this.active?.intentId))
      return this.reject('Replacement requires a new intent id.');
    if (!Array.isArray(intent.allowedReactions) || intent.allowedReactions.some(value => typeof value !== 'string')) return this.reject('Invalid allowed reactions.');
    let copy: BodyIntent<Goal>;
    try { copy = structuredClone(intent); } catch { return this.reject('Intent must be structured-cloneable.'); }
    this.version = copy.version;
    this.lineage += 1;
    this.intent = copy;
    this.failures.clear();
    this.blocked = undefined;
    this.candidate = undefined;
    this.cancelActive('Intent replaced.');
    this.emit({ type: 'intent-accepted', intentId: copy.id, intentVersion: copy.version });
    return { accepted: true, version: this.version };
  }

  /** Cancel is versioned too: a late cancellation must not cancel a newer goal. */
  cancel(version: number, reason = 'Cancelled by planner.'): BodyCommandResult {
    if (!Number.isSafeInteger(version) || version <= this.version) return this.reject('Stale or invalid cancel version.');
    const previous = this.intent;
    this.version = version;
    this.intent = undefined;
    this.candidate = undefined;
    this.cancelActive(reason);
    this.emit({ type: 'intent-cancelled', intentId: previous?.id, intentVersion: previous?.version ?? version, reason });
    return { accepted: true, version: this.version };
  }

  /** Stop is latched, including after execution finishes or late model results arrive. */
  stop(reason = 'Stopped by operator.'): Promise<void> {
    // Stop invalidates the version observed by in-flight planner requests too.
    // Merely latching stopped would let an already prepared resume(v + 1) revive it.
    this.version = Math.min(Number.MAX_SAFE_INTEGER, this.version + 1);
    this.stopped = true;
    this.intent = undefined;
    this.candidate = undefined;
    this.cancelActive(reason);
    this.emit({ type: 'control-stopped', intentVersion: this.version, reason });
    return this.whenIdle();
  }

  resume(intent: BodyIntent<Goal>): BodyCommandResult {
    if (this.disposed) return this.reject('Controller disposed.');
    const result = this.accept(intent);
    if (result.accepted) this.stopped = false;
    return result;
  }

  /** Renew only the already observed authorization. No target/progress/version
   * changes and no cancellation of the current skill. Expiry cannot be undone. */
  renew(expectedVersion: number, expiresAt: number): BodyCommandResult {
    const now = this.now();
    this.expireIntentIfNeeded(now);
    if (this.disposed || this.stopped || !this.intent || this.intent.expiresAt <= now
      || expectedVersion !== this.version || !Number.isFinite(expiresAt) || expiresAt <= now)
      return this.reject('Cannot renew absent, stopped, expired or stale authorization.');
    this.intent.expiresAt = Math.max(this.intent.expiresAt, expiresAt);
    this.emit({ type: 'intent-renewed', intentId: this.intent.id, intentVersion: this.version });
    return { accepted: true, version: this.version };
  }

  /** Extend one live authorization using compare-and-swap. The caller preserves
   * the running action's meaning; its receipt retains the version it started at. */
  extend(expectedVersion: number, goal: Goal, expiresAt: number): BodyCommandResult {
    const now = this.now();
    this.expireIntentIfNeeded(now);
    if (this.disposed || this.stopped || !this.intent || this.blocked
      || expectedVersion !== this.version || this.version >= Number.MAX_SAFE_INTEGER
      || !Number.isFinite(expiresAt) || expiresAt <= now)
      return this.reject('Cannot extend absent, stopped, expired, blocked or stale authorization.');
    let copy: Goal;
    try { copy = structuredClone(goal); } catch { return this.reject('Goal must be structured-cloneable.'); }
    this.version += 1;
    this.intent = { ...this.intent, version: this.version, goal: copy,
      expiresAt: Math.max(this.intent.expiresAt, expiresAt) };
    this.emit({ type: 'intent-extended', intentId: this.intent.id, intentVersion: this.version });
    return { accepted: true, version: this.version };
  }

  start() {
    if (this.disposed) throw new Error('Controller disposed.');
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), this.settings.tickMs);
      this.timer.unref?.();
    }
    this.tick();
  }

  async dispose() {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.stop('Controller disposed.');
  }

  whenIdle(): Promise<void> { return this.active?.settled ?? Promise.resolve(); }

  private noteBlocked(reason: string) {
    if (this.blocked === reason) return;
    this.blocked = reason;
    this.emit({ type: 'intent-blocked', intentId: this.intent?.id, intentVersion: this.intent?.version, reason });
  }

  private retireIntent(type: 'intent-expired' | 'intent-finished', intent: BodyIntent<Goal>, reason?: string) {
    // Completing/revoking authorization is a state transition just like stop:
    // outstanding plans based on the preceding observed version become stale.
    this.version = Math.min(Number.MAX_SAFE_INTEGER, this.version + 1);
    this.intent = undefined;
    this.candidate = undefined;
    this.blocked = undefined;
    this.cancelActive(type === 'intent-expired' ? 'Intent expired.' : 'Goal completed.');
    this.emit({ type, intentId: intent.id, intentVersion: intent.version, reason });
  }

  private expireIntentIfNeeded(now = this.now()): boolean {
    if (!this.intent || now < this.intent.expiresAt) return false;
    this.retireIntent('intent-expired', this.intent);
    return true;
  }

  /** Reentrant calls are ignored; never await skill or model work in this method. */
  tick(): void {
    if (this.ticking || this.disposed) return;
    this.ticking = true;
    const now = this.now();
    this.metrics.ticks += 1;
    if (this.lastTick !== undefined) this.metrics.maxTickGapMs = Math.max(this.metrics.maxTickGapMs, now - this.lastTick);
    this.lastTick = now;
    try {
      this.expireIntentIfNeeded(now);
      if (this.active) {
        if (this.active.phase === 'running' && now - this.active.startedAt >= (this.active.skill.timeoutMs ?? this.settings.skillTimeoutMs)) this.cancelActive('Skill deadline exceeded.');
        if (this.active.phase === 'draining') {
          if (!this.active.drainWarned && now - this.active.cancelledAt! >= this.settings.drainWarningMs) {
            this.active.drainWarned = true;
            this.noteBlocked('Previous skill has not drained; body ownership remains held.');
          }
          return;
        }
      }
      if (this.stopped || !this.intent) return;
      const intent = this.intent;
      const state = this.options.readState();
      const choice = this.options.select(state, structuredClone(intent), this.current());
      // A port may trigger stop/replace synchronously; its old answer is no longer authorized.
      if (this.intent !== intent || this.stopped) return;
      if (this.expireIntentIfNeeded()) return;
      if (choice.kind === 'complete') {
        this.retireIntent('intent-finished', intent, choice.reason);
        return;
      }
      if (choice.kind === 'wait') {
        this.candidate = undefined;
        this.cancelActive(choice.reason ?? 'No authorized skill selected.');
        if (choice.reason) this.noteBlocked(choice.reason);
        return;
      }
      if (choice.kind !== 'run' || !choice.key || !Number.isFinite(choice.priority)
        || (choice.timeoutMs !== undefined && (!Number.isFinite(choice.timeoutMs) || choice.timeoutMs <= 0))
        || (choice.minRunMs !== undefined && (!Number.isFinite(choice.minRunMs) || choice.minRunMs < 0))) throw new Error('Invalid skill selection.');
      if (choice.reaction && !intent.allowedReactions.includes(choice.reaction)) {
        this.cancelActive('Selected reaction is not authorized.');
        this.noteBlocked(`Reaction not authorized: ${choice.reaction}`);
        return;
      }
      if (this.active?.skill.key === choice.key) { this.candidate = undefined; this.blocked = undefined; return; }
      const failure = this.failures.get(choice.key);
      if (failure && failure.until > now) {
        if (this.active && choice.priority > this.active.skill.priority) this.cancelActive('Higher-priority behavior unavailable during backoff.');
        this.noteBlocked(`Skill in failure backoff: ${choice.key}`);
        return;
      }
      const permitted = this.options.canStart?.(state, choice, structuredClone(intent));
      if (this.intent !== intent || this.stopped) return;
      if (permitted === false || typeof permitted === 'string') {
        if (this.active && choice.priority > this.active.skill.priority) this.cancelActive('Higher-priority behavior preconditions failed.');
        this.noteBlocked(typeof permitted === 'string' ? permitted : `Skill preconditions failed: ${choice.key}`);
        return;
      }
      this.blocked = undefined;
      // An expensive synchronous port must not extend a planner's finite lease.
      if (this.expireIntentIfNeeded()) return;
      if (this.active) {
        if (this.candidate?.key !== choice.key) this.candidate = { key: choice.key, since: now };
        const urgent = choice.priority > this.active.skill.priority;
        if (!urgent && (now - this.candidate.since < this.settings.switchDelayMs
          || now - this.active.startedAt < (this.active.skill.minRunMs ?? this.settings.minRunMs))) return;
        this.metrics.preemptions += 1;
        this.cancelActive(`Preempted by ${choice.key}.`);
        return;
      }
      this.candidate = undefined;
      this.launch(intent, choice);
    } catch (error) {
      this.metrics.errors += 1;
      const reason = error instanceof Error ? error.message : String(error);
      this.cancelActive(`Control error: ${reason}`);
      this.noteBlocked(reason);
      this.emit({ type: 'control-error', intentVersion: this.intent?.version, reason });
    } finally { this.ticking = false; }
  }

  private current(): BodyCurrent<Action> | undefined {
    if (!this.active) return undefined;
    const { id, intentId, intentVersion, skill, startedAt, phase, progress, cancelReason } = this.active;
    return structuredClone({ id, intentId, intentVersion, skill, startedAt, phase, progress, cancelReason });
  }

  private cancelActive(reason: string) {
    const active = this.active;
    if (!active || active.phase === 'draining') return;
    active.phase = 'draining';
    active.cancelReason = reason;
    active.cancelledAt = this.now();
    active.controller.abort(reason);
    // halt may itself be asynchronous; its late completion must never touch a new owner.
    try { active.haltSettled = Promise.resolve(this.options.halt(reason)).catch(error => this.haltFailed(error)); }
    catch (error) { active.haltSettled = Promise.resolve(); this.haltFailed(error); }
    this.emit({ type: 'skill-cancelling', intentVersion: active.intentVersion, skillId: active.id, key: active.skill.key, reason });
  }

  private haltFailed(error: unknown) {
    this.metrics.errors += 1;
    this.version = Math.min(Number.MAX_SAFE_INTEGER, this.version + 1);
    this.stopped = true;
    this.intent = undefined;
    this.emit({ type: 'control-error', reason: `Body halt failed: ${error instanceof Error ? error.message : String(error)}` });
  }

  private launch(intent: BodyIntent<Goal>, choice: BodySkill<Action>) {
    const active: Active<Action> = { id: ++this.nextId, intentId: intent.id, intentVersion: intent.version, lineage: this.lineage,
      skill: structuredClone(choice), startedAt: this.now(), phase: 'running',
      controller: new AbortController(), settled: Promise.resolve() };
    this.active = active;
    this.metrics.skillsStarted += 1;
    const progress = (value: unknown) => {
      if (this.active !== active || active.phase !== 'running') return;
      active.progress = structuredClone(value);
      this.emit({ type: 'skill-progress', intentId: intent.id, intentVersion: intent.version, skillId: active.id, key: choice.key, progress: value });
    };
    active.settled = Promise.resolve().then(() => {
      if (active.controller.signal.aborted) return { status: 'cancelled', reason: active.cancelReason } as BodyExecutionResult;
      return this.options.execute(structuredClone(choice.action), active.controller.signal, progress);
    }).catch(error => ({ status: active.controller.signal.aborted ? 'cancelled' : 'failed',
      reason: error instanceof Error ? error.message : String(error) } as BodyExecutionResult)).then(async rawResult => {
      let result: BodyExecutionResult;
      try {
        if (!rawResult || !['completed', 'failed', 'cancelled'].includes(rawResult.status)) throw new Error('Invalid skill execution result.');
        result = structuredClone(rawResult);
      } catch (error) { result = { status: 'failed', reason: error instanceof Error ? error.message : String(error) }; }
      // Cancellation can arrive while awaiting an initially absent halt promise.
      // Re-check its identity in this same continuation before releasing ownership.
      let observed: Promise<void> | undefined;
      do { observed = active.haltSettled; await observed; } while (observed !== active.haltSettled);
      this.finish(active, intent, result);
    });
    this.emit({ type: 'skill-started', intentId: intent.id, intentVersion: intent.version, skillId: active.id, key: choice.key });
  }

  private finish(active: Active<Action>, intent: BodyIntent<Goal>, result: BodyExecutionResult) {
    const cancelled = active.controller.signal.aborted;
    const receipt: BodyReceipt = { id: active.id, key: active.skill.key, intentId: intent.id,
      intentVersion: intent.version, reaction: active.skill.reaction, startedAt: active.startedAt,
      finishedAt: this.now(), status: cancelled ? 'cancelled' : result.status,
      reason: active.cancelReason ?? result.reason, result };
    const sameLineage = !!this.intent && active.lineage === this.lineage;
    if (receipt.status === 'completed') { this.metrics.skillsCompleted += 1; if (sameLineage) this.failures.delete(receipt.key); }
    else if (receipt.status === 'failed' || (receipt.status === 'cancelled'
      && (!cancelled || receipt.reason === 'Skill deadline exceeded.'))) {
      if (receipt.status === 'failed') this.metrics.skillsFailed += 1;
      else this.metrics.skillsCancelled += 1;
      if (sameLineage) {
        const count = (this.failures.get(receipt.key)?.count ?? 0) + 1;
        const until = this.now() + Math.min(this.settings.maxFailureBackoffMs, this.settings.failureBackoffMs * 2 ** Math.min(count - 1, 20));
        this.failures.set(receipt.key, { count, until });
        if (this.failures.size > 128) this.failures.delete(this.failures.keys().next().value!);
      }
    } else this.metrics.skillsCancelled += 1;
    if (active.cancelledAt !== undefined) this.metrics.maxDrainMs = Math.max(this.metrics.maxDrainMs, this.now() - active.cancelledAt);
    this.receipts.push(structuredClone(receipt));
    if (this.receipts.length > this.settings.receiptLimit) this.receipts.shift();
    if (this.active === active) this.active = undefined;
    this.emit({ type: 'skill-finished', intentId: intent.id, intentVersion: intent.version,
      skillId: active.id, key: active.skill.key, status: receipt.status, reason: receipt.reason, receipt });
  }

  snapshot() {
    return structuredClone({ version: this.version, stopped: this.stopped, disposed: this.disposed,
      phase: this.stopped ? 'stopped' : this.active?.phase ?? (this.intent ? 'ready' : 'idle'),
      intent: this.intent, current: this.current(), blocked: this.blocked,
      recentReceipts: this.receipts, metrics: this.metrics });
  }
}

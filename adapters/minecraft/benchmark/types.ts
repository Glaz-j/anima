export type Vec = { x: number; y: number; z: number };
export type ExamStatus = 'passed' | 'failed' | 'unsupported' | 'infra-error' | 'cancelled';
export type ExamArchitecture = 'serial' | 'parallel' | 'dual';
export interface ExamCandidateMetadata { model?: { provider?: string; id: string }; controller?: string }
export interface ExamSourceIdentity { gitHead: string | null; dirty: boolean | null; workingTreeId: string; capturedAt: string }
export type ExamCategory = 'combat-single' | 'combat-multiple' | 'parkour-empty' | 'parkour-items' | 'craft' | 'gather' | 'navigate' | 'water-rescue' | 'eat-resume' | 'interrupt-resume';
export type Capability = 'server-player-nbt' | 'server-statistics' | 'server-entities' | 'server-blocks' | 'server-clock' | 'isolated-world';
export interface Checkpoint { center: Vec; radius: number; grounded: boolean }
export interface EnemySpec { type: 'zombie' | 'skeleton'; position: Vec; tag: string }
export interface ExamTask {
  id: string; revision: number; stage: 1 | 2; category: ExamCategory; title: string; instruction: string;
  timeoutMs: number; required: Capability[]; spawn: Vec;
  inventory: { item: string; count: number }[];
  terrain: { from: Vec; to: Vec; block: string }[];
  enemies: EnemySpec[]; checkpoints: Checkpoint[];
  objective: { item?: string; count?: number; statistic?: string; minJumps?: number; maxPlaced?: number; requirePlacement?: boolean };
  perturbation?: { when: 'first-resource'; enemy: EnemySpec };
  initialFood?: { maximum: number };
}

/** Referee-only truth. Never add this object to an agent's observations. */
export interface ServerEvidence {
  source: 'vanilla-rcon' | 'fixture'; sequence: number; sampledAt: number; serverTick: number;
  /** Initial snapshot precedes opponent activation, so its damage baseline includes startup exposure. */
  opponentsActivatedAt?: number;
  actor: { name: string; position: Vec; health: number; food: number; air: number; onGround: boolean; inventory: Record<string, number> };
  statistics: Record<string, number>;
  enemies: { tag: string; type: string; alive: boolean; position?: Vec; health?: number }[];
  blocks?: Record<string, string>;
}
export interface ExamEvent {
  at: number;
  type: 'input' | 'control-tick' | 'skill-start' | 'skill-stop' | 'model-start' | 'model-end' | 'hazard-observed' | 'reaction' | 'goal-revised' | 'note';
  /** For input: change of a held control, or a discrete use/attack. Repeated held-state writes do not count. */
  channel?: string; value?: string | number | boolean; discrete?: boolean;
  skill?: string; hazardId?: string; revision?: number; message?: string;
}
export interface ExamAdapter {
  mode: 'real-server' | 'fixture'; capabilities: ReadonlySet<Capability>;
  prepare(task: ExamTask, actor: string, signal: AbortSignal): Promise<ServerEvidence>;
  sample(signal: AbortSignal): Promise<ServerEvidence>;
  inject?(task: ExamTask, evidence: ServerEvidence, signal: AbortSignal): Promise<void>;
  cleanup(): Promise<void>;
}
export interface ExamExecutor {
  /** Start must return promptly, while a controller/agent runs independently. Do not wait for the goal to finish here. */
  start(context: {
    taskId: string; category?: ExamCategory; actor: string; instruction: string; mode: 'skill' | 'agent'; architecture: ExamArchitecture; modelDelayMs: number;
    signal: AbortSignal; emit(event: ExamEvent): void;
    /** Report a confirmed infrastructure fault, never ordinary task/skill failure. Pass a credential-free summary. */
    fail(summary: string): void;
  }): Promise<{ stop(): Promise<void> }>;
}
export interface ExamMetrics {
  elapsedMs: number; gameTicks: number; realtimeRatio: number;
  damageTaken: number; deaths: number;
  /** Compatibility aliases: these count issued inputs, not confirmed game effects. */
  effectiveInputs: number; effectiveApm: number;
  issuedInputs: number; issuedInputApm: number;
  inputMetricScope: 'issued-inputs-not-confirmed-effects';
  /** rawInputCalls counts input telemetry events, not all Mineflayer method calls. */
  rawInputCalls: number; peakOneSecondInputs: number;
  /** Interior gaps between observed control ticks; not an estimate of motor activity. */
  controlGapP95Ms: number | null; controlGapMaxMs: number | null;
  controlTickSamples: number;
  controlObservationStartGapMs: number; controlObservationTailGapMs: number;
  controlObservationMaxGapMs: number;
  /** Includes expected idle/startup/goal-completed time. A gap alone does not establish a fault. */
  controlObservationScope: 'trial-window-tick-coverage-including-idle';
  hazardsObserved: number; reactionSamples: number; missedHazards: number;
  /** Unanswered observations are right-censored at the end of the trial. */
  unansweredHazardMaxAgeMs: number | null;
  reactionCompletionRate: number | null;
  reactionLatencyScope: 'responded-hazards-only-report-missed-separately';
  reactionP50Ms: number | null; reactionP95Ms: number | null;
  modelCalls: number; modelWaitMs: number; uninstrumented: boolean;
}
export interface ExamResult {
  schemaVersion: 1 | 2; runId: string; taskId: string; taskRevision: number;
  stage: 1 | 2; actor: string; mode: 'skill' | 'agent'; execution: 'real-server' | 'fixture';
  realScore: boolean; status: ExamStatus; reason: string; startedAt: string;
  modelDelayMs: number; metrics: ExamMetrics; checkpointsReached: number;
  evidenceCount: number; perturbationInjected: boolean;
  /** Older schema-1 trials may lack attribution; never silently label them dual. */
  architecture?: ExamArchitecture; candidate?: ExamCandidateMetadata; source?: ExamSourceIdentity;
}

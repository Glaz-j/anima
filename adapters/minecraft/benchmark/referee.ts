import type { ExamTask, ServerEvidence } from './types.ts';

export class EvidenceError extends Error {}
export type Verdict = { status: 'running' | 'passed' | 'failed'; reason: string };
const distance = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const itemCount = (e: ServerEvidence, item: string) => e.actor.inventory[item] || 0;

/** Deterministic referee fed only by the trusted server adapter. Agent prose cannot satisfy a predicate. */
export class SkillExamReferee {
  task: ExamTask; initial: ServerEvidence; latest: ServerEvidence;
  checkpointsReached = 0; checkpointSince?: number; evidenceCount = 1;
  injectedAt?: number; threatSeen = false; threatResolvedAt?: number; inventoryAtResolution?: number;
  ateAt?: number; inventoryWhenAte?: number;
  constructor(task: ExamTask, initial: ServerEvidence) {
    this.task = task; this.initial = structuredClone(initial); this.latest = initial;
    this.validate(initial);
    if (task.initialFood && initial.actor.food > task.initialFood.maximum) throw new EvidenceError('Hunger precondition was not established.');
    if (initial.actor.health !== 20) throw new EvidenceError('Actor must begin at full health (20).');
    if (task.enemies.some(expected => !initial.enemies.some(actual => actual.tag === expected.tag && actual.type === expected.type && actual.alive && Number(actual.health) > 0))) {
      throw new EvidenceError('Specified enemies were not observed alive before dispatch.');
    }
    for (const supplied of task.inventory) {
      if (itemCount(initial, supplied.item) !== supplied.count) throw new EvidenceError(`Initial inventory mismatch: ${supplied.item}`);
    }
    const suppliedItems = new Set(task.inventory.map(item => item.item));
    if (Object.entries(initial.actor.inventory).some(([item, count]) => count > 0 && !suppliedItems.has(item))) throw new EvidenceError('Unexpected initial inventory.');
  }
  validate(e: ServerEvidence) {
    const finite = [e.sequence, e.sampledAt, e.serverTick, e.actor.health, e.actor.food, e.actor.air, ...Object.values(e.actor.position), ...Object.values(e.actor.inventory), ...Object.values(e.statistics)];
    if (finite.some(value => !Number.isFinite(value))) throw new EvidenceError('Server evidence contains missing or non-finite fields.');
    if (typeof e.actor.onGround !== 'boolean' || e.actor.name !== this.initial.actor.name || e.source !== this.initial.source) throw new EvidenceError('Evidence identity changed.');
    for (const required of ['deaths', 'damage', 'jump', 'placed_cobblestone', 'killed_zombie', 'killed_skeleton', 'crafted_pickaxe', 'mined_oak', 'ate_beef']) {
      if (!Number.isFinite(e.statistics[required])) throw new EvidenceError(`Missing server statistic: ${required}`);
    }
  }
  delta(name: string, e = this.latest) { return e.statistics[name] - this.initial.statistics[name]; }
  inventoryDelta(item: string, e = this.latest) { return itemCount(e, item) - itemCount(this.initial, item); }
  perturbationReady(e = this.latest) {
    return Boolean(this.task.perturbation && this.injectedAt === undefined && this.inventoryDelta(this.task.objective.item || 'oak_log', e) >= 1);
  }
  injected(at: number) { this.injectedAt = at; }
  update(e: ServerEvidence): Verdict {
    this.validate(e);
    if (e.sequence <= this.latest.sequence || e.sampledAt < this.latest.sampledAt || e.serverTick < this.latest.serverTick) throw new EvidenceError('Stale or out-of-order server evidence.');
    this.latest = e; this.evidenceCount += 1;
    if (this.delta('deaths') > 0 || e.actor.health <= 0) return { status: 'failed', reason: 'Actor died.' };
    if (e.actor.position.y < 59 || Math.abs(e.actor.position.x) > 18 || Math.abs(e.actor.position.z) > 18) return { status: 'failed', reason: 'Actor left the allowed arena or fell below it.' };
    if (this.task.objective.maxPlaced !== undefined && this.delta('placed_cobblestone') > this.task.objective.maxPlaced) return { status: 'failed', reason: 'Placement budget exceeded.' };
    if (this.task.category === 'parkour-empty' && Object.values(e.actor.inventory).some(count => count > 0)) return { status: 'failed', reason: 'Empty-handed course received an item.' };
    const checkpoint = this.task.checkpoints[this.checkpointsReached];
    if (checkpoint) {
      if (distance(e.actor.position, checkpoint.center) <= checkpoint.radius && (!checkpoint.grounded || e.actor.onGround)) {
        this.checkpointSince ??= e.sampledAt;
        if (e.sampledAt - this.checkpointSince >= (this.task.category === 'navigate' ? 0 : 250)) { this.checkpointsReached += 1; this.checkpointSince = undefined; }
      } else this.checkpointSince = undefined;
    }
    if (this.task.category === 'eat-resume' && this.ateAt === undefined && this.delta('ate_beef') > 0 && e.actor.food > this.initial.actor.food && itemCount(e, 'cooked_beef') < itemCount(this.initial, 'cooked_beef')) {
      this.ateAt = e.sampledAt; this.inventoryWhenAte = this.inventoryDelta('oak_log');
    }
    if (this.task.perturbation && this.injectedAt !== undefined) {
      const spec = this.task.perturbation.enemy, enemy = e.enemies.find(enemy => enemy.tag === spec.tag);
      if (enemy?.alive) this.threatSeen = true;
      // Disappearance alone is insufficient: server kill statistic must also increase.
      if (this.threatSeen && !enemy?.alive && this.delta(`killed_${spec.type}`) >= 1 && this.threatResolvedAt === undefined) {
        this.threatResolvedAt = e.sampledAt; this.inventoryAtResolution = this.inventoryDelta(this.task.objective.item || 'oak_log');
      }
    }
    const requiredItem = this.task.objective.item, requiredStatistic = this.task.objective.statistic;
    let complete = true;
    if (requiredItem) complete &&= this.inventoryDelta(requiredItem) >= (this.task.objective.count || 1);
    if (requiredStatistic) complete &&= this.delta(requiredStatistic) >= (this.task.objective.count || 1);
    if (this.task.checkpoints.length) complete &&= this.checkpointsReached === this.task.checkpoints.length;
    if (this.task.objective.minJumps) complete &&= this.delta('jump') >= this.task.objective.minJumps;
    if (this.task.objective.requirePlacement) complete &&= this.delta('placed_cobblestone') > 0;
    if (this.task.enemies.length) {
      complete &&= this.task.enemies.every(spec => e.enemies.some(actual => actual.tag === spec.tag && actual.alive === false));
      for (const type of new Set(this.task.enemies.map(enemy => enemy.type))) complete &&= this.delta(`killed_${type}`) >= this.task.enemies.filter(enemy => enemy.type === type).length;
    }
    if (this.task.category === 'water-rescue') complete &&= e.actor.air >= 0 && e.actor.position.y >= 64 && e.actor.onGround;
    if (this.task.category === 'eat-resume') complete &&= this.ateAt !== undefined && e.sampledAt > this.ateAt && this.inventoryDelta('oak_log') > (this.inventoryWhenAte ?? Infinity);
    if (this.task.perturbation) complete &&= this.threatResolvedAt !== undefined && e.sampledAt > this.threatResolvedAt && this.inventoryDelta(requiredItem || 'oak_log') > (this.inventoryAtResolution ?? Infinity);
    return complete ? { status: 'passed', reason: 'All server-backed task predicates satisfied.' } : { status: 'running', reason: 'Task is still in progress.' };
  }
}

/** Isolated real-server continuity probe; never a phase-one or general-intelligence score.
 * No connection occurs without --run. See --help for short, repeatable trials.
 * Baseline/optimized are feature ablations of the SAME source and skill library.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { NpcScheduler } from '../../../packages/bridge/src/npc-scheduler.ts';
import { measureContinuity, type ContinuityEvent } from './continuity-metrics.ts';
import type { ExamServerConfig } from './server.ts';
import type { ServerEvidence, Vec } from './types.ts';

export type ProbeOptions = { run: boolean; mode: 'scripted' | 'agent'; variant: 'baseline' | 'optimized';
  task: 'route' | 'obstacle'; repeat: number; plannerDelayMs: number; timeoutMs: number; model: string };
export type ProbeAblation = 'continuity' | 'throughput' | 'perception';
/** Perception keeps both v1 and v2 enabled; only fresh model-request observations differ. */
export type EfficiencyProbeOptions = Omit<ProbeOptions, 'task'> & {
  task: 'route' | 'material' | 'continuation'; ablation: Exclude<ProbeAblation, 'continuity'> };
type TrialOptions = Omit<ProbeOptions, 'task'> & { task: ProbeOptions['task'] | EfficiencyProbeOptions['task'] };
export function probeFeatures(ablation: ProbeAblation, variant: ProbeOptions['variant']) {
  const optimized = variant === 'optimized';
  return { continuityEnabled: ablation !== 'continuity' || optimized,
    throughputOptimizations: ablation === 'perception' || ablation === 'throughput' && optimized,
    liveObservation: ablation === 'perception' && optimized };
}
export const PUBLIC_ROUTE: readonly Vec[] = [
  { x: 4.5, y: 64, z: .5 }, { x: 4.5, y: 64, z: 4.5 }, { x: .5, y: 64, z: 4.5 },
  { x: -3.5, y: 64, z: 4.5 }, { x: -3.5, y: 64, z: .5 }, { x: -3.5, y: 64, z: -3.5 },
];
const OBSTACLE_DESTINATION = { x: 6.5, y: 64, z: .5 };
const OBSTACLE_RECOVERY = [{ x: -3.5, y: 64, z: 2.5 }, { x: 4.5, y: 64, z: 2.5 }, OBSTACLE_DESTINATION];
const distance = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export function parseContinuityArgs(argv: string[]): ProbeOptions {
  const options: ProbeOptions = { run: false, mode: 'scripted', variant: 'optimized', task: 'route', repeat: 1,
    plannerDelayMs: 2000, timeoutMs: 180000, model: 'gpt-6.1-sol' };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--run') { options.run = true; continue; }
    if (argument === '--help') { options.run = false; return options; }
    const [key, inline] = argument.split('=', 2), value = inline ?? argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value: ${key}`);
    if (key === '--mode' && ['scripted', 'agent'].includes(value)) options.mode = value as ProbeOptions['mode'];
    else if (key === '--variant' && ['baseline', 'optimized'].includes(value)) options.variant = value as ProbeOptions['variant'];
    else if (key === '--task' && ['route', 'obstacle'].includes(value)) options.task = value as ProbeOptions['task'];
    else if (key === '--model' && /^[A-Za-z0-9_.:/-]{1,120}$/u.test(value)) options.model = value;
    else if (['--repeat', '--planner-delay-ms', '--timeout-ms'].includes(key)) {
      const number = Number(value), limits = key === '--repeat' ? [1, 20] : key === '--timeout-ms' ? [5000, 600000] : [0, 30000];
      if (!Number.isInteger(number) || number < limits[0] || number > limits[1]) throw new Error(`Invalid ${key}.`);
      if (key === '--repeat') options.repeat = number;
      else if (key === '--timeout-ms') options.timeoutMs = number;
      else options.plannerDelayMs = number;
    } else throw new Error(`Unknown or invalid argument: ${key}`);
  }
  return options;
}

export function assertContinuityIsolation(config: ExamServerConfig, root: string) {
  assert.equal(config.kind, 'anima-skill-exam'); assert.equal(config.gamePort, 25575); assert.equal(config.rconPort, 25585);
  assert.equal(config.version, '1.21.4');
  assert.equal(resolve(config.directory), resolve(root, 'var/minecraft/skill-exam/server'));
}

/** Reject unparseable responses as well as unexpected players. The check precedes every reset/injection. */
export function assertArenaPlayers(response: string, expected: string[]) {
  const match = /^There are (\d+) of a max of \d+ players online:\s*(.*)$/u.exec(response.trim());
  if (!match) throw new Error('Cannot verify isolated arena player list.');
  const actual = match[2] ? match[2].split(/,\s*/u) : [];
  assert.equal(Number(match[1]), actual.length, 'Arena player count is inconsistent.');
  assert.deepEqual(actual.sort(), [...expected].sort(), 'Other players are online; refusing arena reset/injection.');
}

/** A checkpoint counts only when referee NBT confirms ground contact and proximity. */
export class RouteReferee {
  reached = 0;
  private finalStableSince?: number;
  readonly checkpoints: readonly Vec[];
  constructor(checkpoints: readonly Vec[]) { this.checkpoints = checkpoints; }
  observe(evidence: ServerEvidence): boolean {
    const target = this.checkpoints[this.reached];
    if (!target) return true;
    const arrived = evidence.actor.health > 0 && evidence.actor.onGround && distance(evidence.actor.position, target) <= .7;
    if (!arrived) { this.finalStableSince = undefined; return false; }
    // Interior arrivals may be in motion; demanding a pause would handicap legitimate pipelining.
    if (this.reached < this.checkpoints.length - 1) { this.reached++; return false; }
    this.finalStableSince ??= evidence.sampledAt;
    if (evidence.sampledAt - this.finalStableSince < 300) return false;
    this.reached++; return true;
  }
}

export const efficiencyInstruction = (task: TrialOptions['task'], published = task === 'continuation' ? 3 : PUBLIC_ROUTE.length) =>
  task === 'route' || task === 'continuation'
    ? `按顺序在地面经过这些公开脚部坐标：${PUBLIC_ROUTE.slice(0, published).map(p => `(${p.x},${p.y},${p.z})`).join('、')}。${published < PUBLIC_ROUTE.length ? '这是当前已经公开的工作段；途中会通过消息公开后续工作，不要猜测尚未发布的目标。' : '这是完整的全部路线；最后停稳即可，没有尚未公开的后续工作。'}不得破坏或放置方块。可自行决定一次规划几步、分批续接和何时复核；可用身体技能上限保持原样。`
    : task === 'material'
      ? '旧工作是用背包材料合成橡木板。若实际执行确认材料不足，不要重复同一个不可行操作；改为前往公开会合地点(6.5,64,0.5)并停稳。这是完整任务，不要求在考场寻找未提供的原料。不得破坏或放置方块。'
      : '前一个身体计划正在执行。途中会出现一次局部障碍；根据实际观察和失败回执自行调整，最终抵达脚部坐标(6.5,64,0.5)并停稳。不得破坏或放置方块。';
const instructionFor = (task: ProbeOptions['task']) => task === 'route'
  ? `按顺序在地面经过这些公开脚部坐标：${PUBLIC_ROUTE.map(p => `(${p.x},${p.y},${p.z})`).join('、')}。最后停稳。不得破坏或放置方块。可自行决定一次规划几步、分批续接和何时复核；可用身体技能上限保持原样。`
  : efficiencyInstruction(task);

export async function runContinuityTrial(root: string, options: TrialOptions, output: string, parentSignal: AbortSignal,
  ablation: ProbeAblation = 'continuity') {
  const [{ MinecraftWorld }, { loadNpcModel, runTask }, { loadExamServer }, { VanillaExamAdapter }, { LocalRcon },
    { getExamTask }, { captureExamSource }] = await Promise.all([
    import('../src/world.ts'), import('../src/llm.ts'), import('./server.ts'), import('./adapter.ts'), import('./rcon.ts'),
    import('./tasks.ts'), import('./runner.ts'),
  ]);
  await mkdir(output, { recursive: true });
  const config = await loadExamServer(root); assertContinuityIsolation(config, root);
  const source = await captureExamSource(root), actor = 'ContinuityProbe';
  const { continuityEnabled, throughputOptimizations, liveObservation } = probeFeatures(ablation, options.variant);
  let published = options.task === 'continuation' ? 3 : PUBLIC_ROUTE.length, continuationPublished = false;
  const publicInstruction = () => ablation !== 'continuity' ? efficiencyInstruction(options.task, published) : instructionFor(options.task as ProbeOptions['task']);
  const events: ContinuityEvent[] = [], cleanupErrors: string[] = [];
  const emit = (type: string, data: Record<string, unknown> = {}) => events.push({ at: Date.now(), type, ...data });
  const controller = new AbortController(), signal = controller.signal;
  const abort = () => controller.abort(parentSignal.reason ?? new Error('Interrupted.'));
  parentSignal.addEventListener('abort', abort, { once: true }); if (parentSignal.aborted) abort();
  const rcon = new LocalRcon(), referee = new VanillaExamAdapter(config);
  let world: InstanceType<typeof MinecraftWorld> | undefined, record: ReturnType<InstanceType<typeof MinecraftWorld>['add']> | undefined;
  let scheduler: NpcScheduler | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let startedAt: number | undefined, endedAt: number | undefined, initial: ServerEvidence | undefined, final: ServerEvidence | undefined;
  let error: string | undefined, successful = false, obstacleInjected = false, turn = 0, nextStep = 0;
  let waitingForObstacleFailure = options.task === 'obstacle' || options.task === 'material';
  let materialFailureObserved = false;
  let nativeOwners = 0, maxNativeOwners = 0, ownerId = 0, seedVersion: number | undefined;
  let model: { id: string; provider: string } | undefined;
  const jobs = new Set<Promise<unknown>>();
  const route = new RouteReferee(['route', 'continuation'].includes(options.task) ? PUBLIC_ROUTE : [OBSTACLE_DESTINATION]);
  const until = async (condition: () => boolean, label: string, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) { signal.throwIfAborted(); if (Date.now() >= deadline) throw new Error(label); await delay(25, undefined, { signal }); }
  };
  try {
    await rcon.connect(config.rconPort, config.rconPassword);
    assertArenaPlayers(await rcon.command('list'), []);
    if (options.mode === 'agent') {
      process.env.ANIMA_MC_MODEL_CONTINUITYPROBE = options.model;
      const runtime = await loadNpcModel(actor); model = { id: runtime.model.id, provider: runtime.model.provider };
      assert.equal(model.id, options.model);
    }
    world = new MinecraftWorld({ host: '127.0.0.1', port: config.gamePort, version: config.version, dualLoop: true,
      logDirectory: join(output, 'candidate-events') });
    world.memoryNamespace = `continuity-${randomUUID()}`;
    const native = world.executeOwned.bind(world);
    world.executeOwned = async (name, action, ownerSignal) => {
      const id = ++ownerId; nativeOwners++; maxNativeOwners = Math.max(maxNativeOwners, nativeOwners);
      emit('native-start', { id, action });
      try { return await native(name, action, ownerSignal); }
      finally { nativeOwners--; emit('native-end', { id }); }
    };
    world.onEvent = (_record, event) => {
      emit('world-event', { event });
      const control = event.controlEvent;
      if (event.type === 'skill-started') emit('skill-start', { id: control.skillId, key: control.key,
        intentId: control.intentId, version: control.intentVersion, action: _record.body?.snapshot().current?.skill.action.native });
      if (event.type === 'skill-finished') emit('skill-finish', { id: control.receipt.id, key: control.key,
        version: control.receipt.intentVersion, status: control.receipt.status, receipt: control.receipt });
      if (options.task === 'material' && event.type === 'skill-finished' && control?.receipt?.result?.action?.type === 'craft'
        && control.receipt.status === 'failed' && !materialFailureObserved) {
        materialFailureObserved = true; waitingForObstacleFailure = false;
        emit('material-failure-confirmed', { receipt: control.receipt });
        scheduler?.wake(actor, { type: 'work-result', message: '刚才合成操作失败；请按公开任务规则检查实际回执并选择后续工作。' });
      }
      if (['planning-needed', 'goal-finished', 'goal-blocked'].includes(event.type)) emit(event.type, { event });
      if (['intent-accepted', 'intent-extended'].includes(event.type)) emit('plan-accepted', {
        operation: event.type === 'intent-extended' ? 'append' : 'submit', version: control?.intentVersion, event });
      // The obsolete seeded plan must fail before planning its correction. No hidden obstacle facts enter the planner.
      if (event.type === 'goal-blocked') waitingForObstacleFailure = false;
      if (!waitingForObstacleFailure) scheduler?.wake(actor, event);
    };
    record = world.add(actor, '独立技能考场测试角色。认真观察，依据实际行动与回执完成公开目标。');
    await until(() => Boolean(record?.ready && record.inventorySynced), 'Probe actor failed to connect.');
    assertArenaPlayers(await rcon.command('list'), [actor]);
    const fixture = getExamTask('navigate-01'); fixture.terrain = []; fixture.inventory = []; fixture.enemies = [];
    initial = await referee.prepare(fixture, actor, signal);
    const body = record.body!;
    body.setThroughputOptimizations(throughputOptimizations);
    const performTurn = async (name: string, instruction: string, turnSignal?: AbortSignal) => {
      const currentTurn = ++turn, jointSignal = turnSignal ? AbortSignal.any([signal, turnSignal]) : signal;
      emit('scheduler-turn-start', { id: currentTurn });
      try {
        if (options.task === 'material' && currentTurn === 1) {
          emit('fixture-seed-start');
          const seeded = body.submit({ expectedVersion: body.snapshot().version, ttlMs: 120000,
            label: '公开旧工作：空背包材料检查', reactions: [], steps: [{ type: 'craft', item: 'oak_planks', count: 1 }] });
          assert.equal(seeded.accepted, true); seedVersion = seeded.version;
          return { status: 'completed' };
        }
        if (options.task === 'obstacle' && currentTurn === 1) {
          emit('fixture-seed-start');
          const seeded = body.submit({ expectedVersion: body.snapshot().version, ttlMs: 120000,
            label: '公开的旧工作计划，等待局部障碍测试', reactions: [],
            steps: [{ type: 'goto', x: -3.5, y: 64, z: .5 }, { type: 'goto', x: 2.5, y: 64, z: .5 }] });
          assert.equal(seeded.accepted, true); seedVersion = seeded.version;
          await until(() => Boolean(body.snapshot().current), 'Seeded first skill did not begin.', 5000);
          assertArenaPlayers(await rcon.command('list'), [actor]);
          jointSignal.throwIfAborted();
          const response = await rcon.command('fill 2 64 0 2 65 0 minecraft:bedrock');
          if (!/Successfully filled/u.test(response)) throw new Error('Obstacle insertion was not confirmed.');
          obstacleInjected = true; emit('obstacle-injected', { block: { x: 2, y: 64, z: 0 }, seedVersion });
          return { status: 'completed' };
        }
        emit('planner-start', { id: currentTurn, mode: options.mode });
        if (options.mode === 'agent') {
          const result = await runTask(world!, name, instruction, join(output, 'candidate-root'), {
            signal: jointSignal, worldId: world!.memoryNamespace, bodyExecution: 'dual', continuity: continuityEnabled,
            throughputOptimizations, liveObservation,
            onModelCall: event => events.push({ ...event, schedulerTurnId: currentTurn }),
            context: { purpose: '公开短技能连续行动实验；所有可执行能力来自生产技能库。' },
          });
          emit('planner-result', { id: currentTurn, model: result.model, status: result.status, reason: result.reason,
            turns: result.turns, toolTrace: result.toolTrace, goalReview: result.goalReview ? { status: result.goalReview.status,
              turns: result.goalReview.turns, durationMs: result.goalReview.durationMs } : undefined });
          return result;
        }
        // This deterministic two-step planner is a controller diagnostic, never labeled a real Agent.
        emit('planner-delay-start', { id: currentTurn });
        try { await delay(options.plannerDelayMs, undefined, { signal: jointSignal }); }
        finally { emit('planner-delay-end', { id: currentTurn }); }
        const state = body.snapshot(), points = ['route', 'continuation'].includes(options.task) ? PUBLIC_ROUTE.slice(0, published)
          : options.task === 'material' ? [OBSTACLE_DESTINATION] : OBSTACLE_RECOVERY;
        if (nextStep >= points.length) return { status: 'completed' };
        const steps = points.slice(nextStep, nextStep + 2).map(point => ({ type: 'goto', ...point }));
        const append = continuityEnabled && state.intent && !state.workCompleted && !state.replanRequired;
        // Baseline waits for its authorized work to finish; it never replaces a running plan for artificial disadvantage.
        if (!append && state.current && !state.replanRequired) return { status: 'completed' };
        const terminal = throughputOptimizations && published === PUBLIC_ROUTE.length && nextStep + steps.length >= points.length;
        const accepted = append ? body.append({ expectedVersion: state.version, steps, ttlMs: 120000, terminal })
          : body.submit({ expectedVersion: state.version, steps, label: '公开坐标段接力', reactions: [], ttlMs: 120000, terminal });
        emit('scripted-plan-result', { operation: append ? 'append' : 'submit', accepted: accepted.accepted, version: accepted.version });
        if (accepted.accepted) nextStep += steps.length;
        return { status: 'completed' };
      } finally { emit('scheduler-turn-end', { id: currentTurn }); }
    };
    scheduler = new NpcScheduler({
      getActors: () => [{ name: actor, ready: record!.ready && !record!.operatorStopped,
        busy: Boolean(record!.task || (!record!.body && record!.actionController)) }],
      run: (name, instruction, turnSignal) => {
        const job = performTurn(name, instruction, turnSignal); jobs.add(job); void job.then(() => jobs.delete(job), () => jobs.delete(job)); return job;
      },
      cancel: () => world!.stop(record!), cancelTurn: () => { record!.task?.controller.abort(); },
      scenarioStatus: () => ({ complete: successful, summary: publicInstruction() }), objective: publicInstruction(),
      intervalMs: 10000, eventCooldownMs: 4000, pollMs: 50, taskTimeoutMs: options.timeoutMs, stopWaitMs: 10000,
      continuityEnabled, continuityCooldownMs: 250,
      onError: failure => { emit('scheduler-error', { message: failure.message }); },
    });
    startedAt = Date.now(); emit('trial-start');
    timer = setTimeout(() => controller.abort(new Error('Continuity probe deadline exceeded.')), options.timeoutMs);
    scheduler.start(); emit('scheduler-start', { status: scheduler.status() });
    while (!successful) {
      signal.throwIfAborted();
      if (!record.ready || record.error) throw new Error(record.error ?? 'Actor disconnected.');
      final = await referee.sample(signal); emit('server-evidence', { evidence: final });
      assert.ok(final.actor.health > 0, 'Actor died.');
      assert.equal(final.statistics.deaths, 0, 'Actor death recorded.');
      const prior = route.reached; successful = route.observe(final);
      if (route.reached !== prior) emit('checkpoint-confirmed', { count: route.reached, serverTick: final.serverTick });
      if (options.task === 'continuation' && !continuationPublished && route.reached >= 1 && nativeOwners > 0) {
        const original = body.snapshot().intent;
        published = PUBLIC_ROUTE.length; continuationPublished = true;
        emit('continuation-published', { publicInstruction: publicInstruction(), nativeOwners, serverTick: final.serverTick,
          originalQueue: original ? { intentId: original.id, version: original.version, stepCount: original.goal.steps.length } : null,
          followupFirstTarget: PUBLIC_ROUTE[3] });
        world.event(record, 'heard', { speaker: 'ExamCoordinator', message: `后续工作现在公开：${publicInstruction()}` });
      }
      if (options.task === 'obstacle' && successful)
        assert.ok(obstacleInjected && events.some(event => event.type === 'goal-blocked'), 'Obstacle failure/replanning coverage is required.');
      if (options.task === 'material' && successful) assert.ok(materialFailureObserved, 'A real craft failure must precede recovery.');
      if (options.task === 'continuation' && successful) assert.ok(continuationPublished, 'Continuation must be published during native work.');
      if (!successful) await delay(100, undefined, { signal });
    }
    assert.ok(final!.serverTick > initial.serverTick, 'The server clock must advance.');
    assert.equal(maxNativeOwners, 1, 'Native ownership overlaps.');
  } catch (cause: any) { error = String(cause?.message ?? cause); }
  finally {
    endedAt = Date.now(); emit('trial-end', { successful, error });
    controller.abort(); if (timer) clearTimeout(timer); parentSignal.removeEventListener('abort', abort);
    const clean = async (label: string, operation: () => unknown) => {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([Promise.resolve().then(operation), new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error('Cleanup did not confirm completion within 15s.')), 15000);
        })]);
      } catch (cause: any) { cleanupErrors.push(`${label}: ${String(cause?.message ?? cause)}`); }
      finally { if (deadline) clearTimeout(deadline); }
    };
    await clean('scheduler stop', () => scheduler?.stop()); emit('scheduler-stop', { status: scheduler?.status() });
    await clean('body stop', () => record && world?.stop(record));
    await clean('planner drain', () => Promise.allSettled([...jobs]));
    await clean('body dispose', () => record?.body?.dispose());
    await clean('referee cleanup', () => referee.cleanup()); await clean('referee close', () => referee.close());
    await clean('world close', () => world?.close());
    await clean('actor disconnected', async () => {
      if (!world) return;
      const deadline = Date.now() + 10000;
      while (true) {
        const response = await rcon.command('list');
        try { assertArenaPlayers(response, []); return; } catch { if (Date.now() >= deadline) throw new Error('Arena did not drain; no next trial may reset it.'); }
        await delay(100);
      }
    });
    rcon.close();
    const result = { schemaVersion: 1, status: error || cleanupErrors.length ? 'failed' : 'passed', error, cleanupErrors,
      mode: options.mode, variant: options.variant, task: options.task, source, model, ablation,
      comparison: 'same-source-feature-ablation; not an old-commit reproduction',
      ablationScope: ablation === 'continuity' ? 'continuation scheduling + append tool and guidance + planning notices + stale-turn cancellation + urgent goal-review deferral'
        : ablation === 'perception' ? 'v3 bounded fresh observation on each model request only; v1 continuity and v2 throughput enabled in both arms'
          : 'v2 throughput prompt + inline plan memory + adaptive planning horizon/terminal plans + bounded local failure recovery; v1 continuity enabled in both arms; liveObservation disabled',
      throughputOptimizations, liveObservation,
      scheduler: { implementation: 'production-NpcScheduler', intervalMs: 10000, eventCooldownMs: 4000,
        pollMs: 50, continuityEnabled, continuityCooldownMs: 250 },
      planner: { realAgent: options.mode === 'agent', artificialModelDelayMs: 0,
        actualRuntimeModels: [...new Set(events.filter(event => event.type === 'world-event'
          && (event.event as any)?.type === 'task-started').map(event => (event.event as any).model))],
        modelTimingScope: 'all runTask streamSimple calls, including goal review and execution reasoning; union of request wall-time clipped at trial end; no phase-specific timing attribution',
        scriptedDelayPerTurnMs: options.mode === 'scripted' ? options.plannerDelayMs : 0,
        maxStepsPerCommit: options.mode === 'scripted' ? 2 : 12 },
      publicInstruction: publicInstruction(), initial, final, maxNativeOwners, obstacleInjected, materialFailureObserved, continuationPublished,
      serverConfirmedSuccess: successful && !error, checkpointsReached: route.reached, requiredCheckpoints: route.checkpoints.length,
      metrics: startedAt === undefined ? null : measureContinuity(events, startedAt, endedAt),
      limitations: ['Small fixed arena, not general survival or a phase-one score.',
        ...(options.mode === 'scripted' ? ['Scripted planning tests the control mechanism; it is not an LLM Agent result.'] : []),
        ...(options.task === 'obstacle' ? ['The initial obsolete plan is fixture-seeded in the first scheduler turn; only subsequent turns test planning.',
          'Correction planning starts after the seeded failure; this tests scheduler wakeup and actual correction, not an in-flight stale-model cancellation or autonomous obstacle anticipation.'] : []),
        ...(options.task === 'material' ? ['The impossible old craft is fixture-seeded; only failure handling and the explicitly public fallback are candidate decisions.'] : []),
        ...(options.task === 'continuation' ? ['Later checkpoints are published only after a server-confirmed first arrival during native skill ownership; all three initial checkpoints may be batched freely.'] : []),
        'No-work time measures native skill ownership; referee evidence separately decides actual arrival.'],
    };
    await writeFile(join(output, 'events.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n');
    await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    return result;
  }
}

const USAGE = `node --env-file-if-exists=.env adapters/minecraft/benchmark/continuity-probe.ts --run
  [--mode scripted|agent] [--variant baseline|optimized] [--task route|obstacle]
  [--repeat 1] [--planner-delay-ms 2000] [--timeout-ms 180000] [--model gpt-6.1-sol]
Requires an already running, empty isolated arena on 25575/25585; never starts a game server.
No --run: usage only. Scripted delay is not model latency. Agent mode adds zero artificial delay.
Outputs (including fresh candidate memory): var/minecraft/skill-exam/continuity/<run>/<trial>/`;

export async function main(argv = process.argv.slice(2)) {
  const options = parseContinuityArgs(argv); if (!options.run) { console.log(USAGE); return; }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const output = join(root, 'var/minecraft/skill-exam/continuity', `${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}`);
  const controller = new AbortController(), interrupt = () => controller.abort(new Error('Interrupted.'));
  process.once('SIGINT', interrupt);
  const priorModel = process.env.ANIMA_MC_MODEL_CONTINUITYPROBE;
  try {
    for (let index = 0; index < options.repeat; index++) {
      controller.signal.throwIfAborted();
      const directory = join(output, `${index + 1}-${options.mode}-${options.variant}-${options.task}`);
      const result = await runContinuityTrial(root, options, directory, controller.signal);
      console.log(JSON.stringify({ ...result, output: directory }, null, 2));
      if (result.status !== 'passed') { process.exitCode = 1; break; }
    }
  } finally {
    process.removeListener('SIGINT', interrupt);
    if (priorModel === undefined) delete process.env.ANIMA_MC_MODEL_CONTINUITYPROBE;
    else process.env.ANIMA_MC_MODEL_CONTINUITYPROBE = priorModel;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

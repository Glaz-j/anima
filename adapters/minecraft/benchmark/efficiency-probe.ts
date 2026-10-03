/** Throughput and perception feature ablations. No game/model access without --run. */
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runContinuityTrial, parseContinuityArgs, type EfficiencyProbeOptions } from './continuity-probe.ts';
import type { ContinuityEvent } from './continuity-metrics.ts';

export function parseEfficiencyArgs(argv: string[]): EfficiencyProbeOptions {
  let task: EfficiencyProbeOptions['task'] = 'route';
  let ablation: EfficiencyProbeOptions['ablation'] = 'throughput';
  const common: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--task' || argument.startsWith('--task=')) {
      const value = argument.startsWith('--task=') ? argument.slice(7) : argv[++index];
      if (!['route', 'material', 'continuation'].includes(value)) throw new Error('Invalid --task.');
      task = value as EfficiencyProbeOptions['task'];
    } else if (argument === '--ablation' || argument.startsWith('--ablation=')) {
      const value = argument.startsWith('--ablation=') ? argument.slice(11) : argv[++index];
      if (!['throughput', 'perception'].includes(value)) throw new Error('Invalid --ablation.');
      ablation = value as EfficiencyProbeOptions['ablation'];
    } else common.push(argument);
  }
  return { ...parseContinuityArgs(common), task, ablation };
}

/** This is executor handoff evidence; server checkpoints remain the arrival authority. */
function continuationHandoff(within: ContinuityEvent[]) {
  const publication = within.find(event => event.type === 'continuation-published');
  const original = publication?.originalQueue as any, target = publication?.followupFirstTarget as any;
  const unknown = { publicationToUsefulCommitMs: null, commitBeforeOriginalCompletion: null, handoffIdleMs: null,
    continuationCommitEvidence: null };
  if (!publication || typeof original?.intentId !== 'string' || !Number.isSafeInteger(original.stepCount)
    || original.stepCount < 1 || !target || ![target.x, target.y, target.z].every(Number.isFinite)) return unknown;
  const isWork = (event: ContinuityEvent, intentId: string, version?: unknown) => event.type === 'skill-start'
    && typeof event.key === 'string' && event.key.startsWith(`${intentId}:step-`)
    && /^step-\d+:/u.test(event.key.slice(intentId.length + 1)) && (version === undefined || event.version === version);
  let commit: ContinuityEvent | undefined, followup: ContinuityEvent | undefined;
  for (const candidate of within.filter(event => event.type === 'plan-accepted' && event.at >= publication.at)) {
    const intentId = (candidate.event as any)?.controlEvent?.intentId;
    if (typeof intentId !== 'string' || !Number.isSafeInteger(candidate.version)
      || !['append', 'submit'].includes(String(candidate.operation))
      || candidate.operation === 'append' && intentId !== original.intentId) continue;
    const started = within.slice(within.indexOf(candidate) + 1).find(event => isWork(event, intentId, candidate.version)
      && (event.action as any)?.type === 'goto'
      && ['x', 'y', 'z'].every(axis => Math.abs((event.action as any)[axis] - target[axis]) < .001));
    if (started) { commit = candidate; followup = started; break; }
  }
  // Appending advances intentVersion while retaining the original steps. Match
  // the frozen original lineage/index and its actual receipt, not goal-finished.
  const prefix = `${original.intentId}:step-${original.stepCount - 1}:`;
  const finalReceipt = within.filter(event => event.type === 'skill-finish').map(event => event.receipt as any)
    .find(receipt => receipt?.intentId === original.intentId && receipt.status === 'completed'
      && typeof receipt.key === 'string' && receipt.key.startsWith(prefix)
      && Number.isFinite(receipt.finishedAt) && receipt.finishedAt >= publication.at
      && receipt.finishedAt <= (followup?.at ?? within.at(-1)!.at)
      && within.some(event => isWork(event, original.intentId, receipt.intentVersion)
        && event.id === receipt.id && event.key === receipt.key && event.at <= receipt.finishedAt));
  const uninterruptedGap = followup && finalReceipt && !within.some(event => event.type === 'skill-start'
    && event !== followup && event.at >= finalReceipt.finishedAt && within.indexOf(event) < within.indexOf(followup));
  return { publicationToUsefulCommitMs: commit ? commit.at - publication.at : null,
    commitBeforeOriginalCompletion: commit && finalReceipt ? commit.at < finalReceipt.finishedAt : null,
    handoffIdleMs: uninterruptedGap ? Math.max(0, followup!.at - finalReceipt.finishedAt) : null,
    continuationCommitEvidence: commit && followup ? { acceptedAt: commit.at, operation: commit.operation,
      intentId: (commit.event as any).controlEvent.intentId, version: commit.version,
      followupSkillId: followup.id, followupSkillStartedAt: followup.at,
      originalIntentId: original.intentId, originalLastStepIndex: original.stepCount - 1,
      originalLastSkillFinishedAt: finalReceipt?.finishedAt ?? null } : null };
}

/** Native starts remain diagnostic; only server checkpoints establish useful progress. */
export function measureEfficiency(events: ContinuityEvent[], startedAt: number, endedAt: number) {
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) throw new Error('Invalid efficiency window.');
  const within = events.filter(event => event.at >= startedAt && event.at <= endedAt).sort((a, b) => a.at - b.at);
  const planners = within.filter(event => event.type === 'planner-start');
  const plannerStart = planners[0]?.at;
  // runTask grants an empty survival policy before calling the model. A raw
  // acceptance alone therefore does not prove the candidate planned any work.
  // Link a candidate acceptance to the exact lineage/version's step skill;
  // a reflex, a fixture seed, or a newer appended version is not this proof.
  const candidatePlans = within.filter(event => {
    if (event.type !== 'plan-accepted') return false;
    const preceding = within.slice(0, within.indexOf(event));
    const planner = preceding.findLast(start => start.type === 'planner-start');
    if (!planner) return false;
    if (planner.mode === 'scripted') return true;
    return planner.mode === 'agent' && preceding.some(start => start.type === 'model-start'
      && start.at >= planner.at && start.at <= event.at
      && (start.schedulerTurnId === undefined || planner.id === undefined || start.schedulerTurnId === planner.id));
  });
  const candidate = candidatePlans[0];
  const control = (candidate?.event as any)?.controlEvent;
  const intentId = typeof control?.intentId === 'string' ? control.intentId : undefined;
  const version = candidate?.version;
  const skill = candidate && intentId && Number.isSafeInteger(version) ? within.slice(within.indexOf(candidate) + 1).find(event => event.type === 'skill-start'
    && event.at >= candidate.at && event.version === version && typeof event.key === 'string'
    && event.key.startsWith(`${intentId}:step-`) && /^step-\d+:/u.test(event.key.slice(intentId.length + 1))) : undefined;
  // If the first candidate acceptance cannot be proved nonempty (or never
  // starts), return unknown rather than silently measuring a later replacement.
  const firstPlanAt = skill ? candidate!.at : undefined;
  const candidatePlanner = candidate && within.slice(0, within.indexOf(candidate)).findLast(event => event.type === 'planner-start');
  const afterCandidate = candidate ? within.slice(within.indexOf(candidate) + 1) : [];
  const linkedModelEvents = within.filter(event => event.type === 'model-start' && event.at >= (candidatePlanner?.at ?? Infinity));
  const postPlanRequestCount = firstPlanAt === undefined || candidatePlanner?.id === undefined
    || linkedModelEvents.some(event => event.schedulerTurnId === undefined) ? null
      : afterCandidate.filter(event => event.type === 'model-start' && event.schedulerTurnId === candidatePlanner.id).length;
  const firstCandidatePlanEvidence = skill ? { proof: 'same-lineage-version-work-skill' as const,
    acceptedAt: candidate!.at, intentId, version, operation: candidate!.operation,
    skillId: skill.id, skillStartedAt: skill.at, skillKey: skill.key }
    : { proof: 'unavailable' as const, reason: candidate ? 'first-candidate-plan-has-no-matching-work-start' : 'no-candidate-plan-after-planning-start' };
  const firstProgressAt = within.find(event => event.type === 'checkpoint-confirmed')?.at;
  const materialFailureAt = within.find(event => event.type === 'material-failure-confirmed')?.at;
  const resumed = materialFailureAt === undefined ? undefined : within.find(event => event.type === 'native-start'
    && event.at >= materialFailureAt && (event.action as any)?.type !== 'craft')?.at;
  const traces = within.filter(event => event.type === 'planner-result').flatMap(event => Array.isArray(event.toolTrace) ? event.toolTrace : []);
  const agentPlanners = planners.filter(event => event.mode === 'agent');
  const traceCoverage = planners.length > 0 && planners.every(event => ['agent', 'scripted'].includes(String(event.mode)))
    && agentPlanners.every(planner => planner.id !== undefined
    && within.some(event => event.type === 'planner-result' && event.id === planner.id && Array.isArray(event.toolTrace)));
  const firstPlanToolIndex = traces.findIndex(tool => ['body_plan', 'body_append'].includes(tool.name) && tool.status === 'accepted');
  const startsByAction: Record<string, number> = {};
  for (const event of within.filter(event => event.type === 'native-start')) {
    const type = String((event.action as any)?.type ?? 'unknown'); startsByAction[type] = (startsByAction[type] ?? 0) + 1;
  }
  return { analysisRevision: 'efficiency-v3.0-perception-work-plan-proof', elapsedMs: endedAt - startedAt,
    firstCandidatePlanEvidence,
    firstCandidatePlanMs: plannerStart === undefined || firstPlanAt === undefined ? null : firstPlanAt - plannerStart,
    modelRequestsBeforeFirstCandidatePlan: firstPlanAt === undefined ? null : within.filter(event => event.type === 'model-start' && event.at <= firstPlanAt).length,
    postPlanRequestCount,
    modelRequestsAfterFirstCandidatePlan: firstPlanAt === undefined ? null : afterCandidate.filter(event => event.type === 'model-start').length,
    observeToolCalls: traceCoverage ? traces.filter(tool => tool.name === 'observe').length : null,
    ...continuationHandoff(within),
    firstServerProgressMs: firstProgressAt === undefined ? null : firstProgressAt - startedAt,
    materialFailureToResumedWorkMs: materialFailureAt === undefined || resumed === undefined ? null : resumed - materialFailureAt,
    toolsBeforeFirstAcceptedCandidatePlan: firstPlanToolIndex < 0 ? null : traces.slice(0, firstPlanToolIndex).map(tool => tool.name),
    nativeStartsByAction: startsByAction,
    serverConfirmedCheckpoints: within.filter(event => event.type === 'checkpoint-confirmed').length,
    continuationPublishedDuringWork: within.some(event => event.type === 'continuation-published' && Number(event.nativeOwners) > 0),
    scope: 'first candidate acceptance must follow actual agent model start (scripted planners exempt) and match exact lineage/version work-step start within window; bootstrap/reflex/fixture acceptances excluded; unproved first plans remain null rather than measuring a later replacement; postPlanRequestCount counts only later requests in that first work plan scheduler turn with explicit event linkage; observeToolCalls requires in-window result traces for every agent planner; continuation commit requires matching lineage/version followup work start and handoff uses the frozen original queue last-step receipt.finishedAt, never an appended goal-finished; native ownership is not server-verified movement; post-window planner traces excluded' };
}

const USAGE = `node --env-file-if-exists=.env adapters/minecraft/benchmark/efficiency-probe.ts --run
  [--mode scripted|agent] [--variant baseline|optimized] [--task route|material|continuation]
  [--ablation throughput|perception]
  [--repeat 1] [--planner-delay-ms 2000] [--timeout-ms 180000] [--model gpt-6.1-sol]
Both arms use production NpcScheduler with v1 continuity enabled.
Default throughput: only v2 features differ; liveObservation is off in both arms.
Perception: v1/v2 are on in both arms; only optimized enables liveObservation.
Requires the already running empty isolated arena 25575/25585. No --run: usage only.
Scripted mode is a mechanism diagnostic, not model performance. Real Agent receives no injected delay.
Outputs: var/minecraft/skill-exam/efficiency/<run>/<trial>/`;

export async function main(argv = process.argv.slice(2)) {
  const options = parseEfficiencyArgs(argv); if (!options.run) { console.log(USAGE); return; }
  const root = resolve(import.meta.dirname, '../../..');
  const output = join(root, 'var/minecraft/skill-exam/efficiency', `${options.ablation}-${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}`);
  const controller = new AbortController(), interrupt = () => controller.abort(new Error('Interrupted.'));
  process.once('SIGINT', interrupt);
  const priorModel = process.env.ANIMA_MC_MODEL_CONTINUITYPROBE;
  try {
    for (let index = 0; index < options.repeat; index++) {
      controller.signal.throwIfAborted();
      const directory = join(output, `${index + 1}-${options.mode}-${options.variant}-${options.task}`);
      const result = await runContinuityTrial(root, options, directory, controller.signal, options.ablation);
      const events = (await readFile(join(directory, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) as ContinuityEvent[];
      const start = events.find(event => event.type === 'trial-start')?.at, end = events.find(event => event.type === 'trial-end')?.at;
      const report = { ...result, schemaVersion: 3, efficiency: start === undefined || end === undefined ? null : measureEfficiency(events, start, end) };
      await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify({ ...report, output: directory }, null, 2));
      if (report.status !== 'passed') { process.exitCode = 1; break; }
    }
  } finally {
    process.removeListener('SIGINT', interrupt);
    if (priorModel === undefined) delete process.env.ANIMA_MC_MODEL_CONTINUITYPROBE;
    else process.env.ANIMA_MC_MODEL_CONTINUITYPROBE = priorModel;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

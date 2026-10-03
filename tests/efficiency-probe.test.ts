import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseEfficiencyArgs, measureEfficiency } from '../adapters/minecraft/benchmark/efficiency-probe.ts';
import { efficiencyInstruction, probeFeatures } from '../adapters/minecraft/benchmark/continuity-probe.ts';

test('v2 is opt-in, bounded, and has no arbitrary game server target', () => {
  assert.equal(parseEfficiencyArgs([]).run, false);
  assert.equal(parseEfficiencyArgs([]).ablation, 'throughput');
  assert.equal(parseEfficiencyArgs(['--run', '--task=continuation', '--variant=baseline']).task, 'continuation');
  assert.equal(parseEfficiencyArgs(['--task', 'material']).model, 'gpt-6.1-sol');
  for (const argv of [['--task=obstacle'], ['--task'], ['--repeat=0'], ['--port=25565'], ['--timeout-ms=9999999'],
    ['--ablation'], ['--ablation=continuity'], ['--ablation='], ['--ablation=perception', '--port=25565']])
    assert.throws(() => parseEfficiencyArgs(argv));
  const child = spawnSync(process.execPath, ['adapters/minecraft/benchmark/efficiency-probe.ts'], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /No --run: usage only/);
});

test('perception changes only live observations and legacy ablations explicitly disable them', () => {
  for (const args of [['--ablation=perception'], ['--ablation', 'perception']]) {
    const options = parseEfficiencyArgs(args);
    assert.equal(options.ablation, 'perception'); assert.equal(options.run, false);
  }
  assert.deepEqual(probeFeatures('perception', 'baseline'), {
    continuityEnabled: true, throughputOptimizations: true, liveObservation: false });
  assert.deepEqual(probeFeatures('perception', 'optimized'), {
    continuityEnabled: true, throughputOptimizations: true, liveObservation: true });
  for (const ablation of ['continuity', 'throughput'] as const) for (const variant of ['baseline', 'optimized'] as const) {
    const features = probeFeatures(ablation, variant);
    assert.equal(features.liveObservation, false);
    assert.equal(features.continuityEnabled, ablation === 'throughput' || variant === 'optimized');
    assert.equal(features.throughputOptimizations, ablation === 'throughput' && variant === 'optimized');
  }
  const child = spawnSync(process.execPath, ['adapters/minecraft/benchmark/efficiency-probe.ts', '--ablation=perception'],
    { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /Perception: v1\/v2 are on/);
});

test('continuation only publishes currently known checkpoints and a complete final objective', () => {
  const first = efficiencyInstruction('continuation', 3), later = efficiencyInstruction('continuation', 6);
  assert.match(first, /这是当前已经公开的工作段/u); assert.doesNotMatch(first, /-3.5/u);
  assert.match(later, /\(-3.5,64,-3.5\)/u); assert.match(later, /完整的全部路线/u);
  assert.match(efficiencyInstruction('material'), /材料不足/u);
  assert.match(efficiencyInstruction('material'), /公开会合地点/u);
});

test('v2 metrics exclude fixture plans and distinguish actual checkpoint progress from busy retries', () => {
  const result = measureEfficiency([
    { at: 0, type: 'plan-accepted' }, { at: 10, type: 'native-start', action: { type: 'craft' } },
    { at: 20, type: 'material-failure-confirmed' }, { at: 30, type: 'native-start', action: { type: 'craft' } },
    { at: 100, type: 'planner-start', mode: 'agent' }, { at: 120, type: 'model-start' }, { at: 240, type: 'model-start' },
    { at: 300, type: 'plan-accepted', version: 2, event: { controlEvent: { intentId: 'candidate', intentVersion: 2 } } },
    { at: 350, type: 'skill-start', version: 2, id: 3, key: 'candidate:step-0:{"type":"goto"}' },
    { at: 350, type: 'native-start', action: { type: 'goto' } },
    { at: 400, type: 'planner-result', toolTrace: [{ name: 'remember', status: 'recorded' }, { name: 'body_plan', status: 'accepted' }] },
    { at: 500, type: 'checkpoint-confirmed' }, { at: 510, type: 'continuation-published', nativeOwners: 1 },
  ], 0, 1000);
  assert.equal(result.firstCandidatePlanMs, 200); assert.equal(result.firstServerProgressMs, 500);
  assert.equal(result.modelRequestsBeforeFirstCandidatePlan, 2); assert.equal(result.materialFailureToResumedWorkMs, 330);
  assert.deepEqual(result.toolsBeforeFirstAcceptedCandidatePlan, ['remember']);
  assert.deepEqual(result.nativeStartsByAction, { craft: 2, goto: 1 });
  assert.equal(result.serverConfirmedCheckpoints, 1); assert.equal(result.continuationPublishedDuringWork, true);
  assert.equal(result.analysisRevision, 'efficiency-v3.0-perception-work-plan-proof');
  assert.equal(result.firstCandidatePlanEvidence.proof, 'same-lineage-version-work-skill');
});

test('v2 missing timing evidence remains null, not a perfect zero', () => {
  const result = measureEfficiency([{ at: 10, type: 'native-start', action: { type: 'retreat' } }], 0, 100);
  assert.equal(result.firstCandidatePlanMs, null); assert.equal(result.firstServerProgressMs, null);
  assert.equal(result.materialFailureToResumedWorkMs, null); assert.equal(result.toolsBeforeFirstAcceptedCandidatePlan, null);
  assert.equal(result.serverConfirmedCheckpoints, 0);
  assert.equal(result.postPlanRequestCount, null); assert.equal(result.observeToolCalls, null);
  assert.equal(result.publicationToUsefulCommitMs, null); assert.equal(result.commitBeforeOriginalCompletion, null);
  assert.equal(result.handoffIdleMs, null);
  assert.throws(() => measureEfficiency([], 100, 0));
});

test('post-plan request counts use the captured scheduler turn and observe counts require complete trace evidence', () => {
  const events = [
    { at: 10, type: 'planner-start', id: 1, mode: 'agent' },
    { at: 20, type: 'model-start', schedulerTurnId: 1 }, acceptance(30, 1, 'candidate'), work(35, 1, 'candidate'),
    { at: 40, type: 'model-start', schedulerTurnId: 1 },
    { at: 50, type: 'planner-result', id: 1, toolTrace: [{ name: 'observe' }, { name: 'body_plan' }, { name: 'observe' }] },
    { at: 60, type: 'planner-start', id: 2, mode: 'agent' },
    { at: 70, type: 'model-start', schedulerTurnId: 2 },
    { at: 80, type: 'planner-result', id: 2, toolTrace: [{ name: 'body_append' }] },
  ];
  const result = measureEfficiency(events, 0, 100);
  assert.equal(result.postPlanRequestCount, 1); assert.equal(result.modelRequestsAfterFirstCandidatePlan, 2);
  assert.equal(result.observeToolCalls, 2);
  assert.equal(measureEfficiency(events.map(event => event.at === 40 ? { ...event, at: 30 } : event), 0, 100).postPlanRequestCount, 1,
    'A request recorded after acceptance counts even when both timestamps share a millisecond.');
  assert.equal(measureEfficiency(events, 0, 75).observeToolCalls, null, 'The ongoing second turn has no in-window trace.');
  assert.equal(measureEfficiency(events.map(event => event.type === 'model-start'
    ? { ...event, schedulerTurnId: undefined } : event), 0, 100).postPlanRequestCount, null);
  const wrongTurn = measureEfficiency(events.map(event => event.at === 20 ? { ...event, schedulerTurnId: 9 } : event), 0, 100);
  assert.equal(wrongTurn.firstCandidatePlanMs, null, 'Another turn cannot establish this candidate acceptance.');
});

function handoffEvents() {
  const originalKey = 'original:step-2:{"type":"goto"}', nextTarget = { type: 'goto', x: -3.5, y: 64, z: 4.5 };
  return [
    { at: 10, type: 'skill-start', id: 11, version: 1, key: originalKey },
    { at: 20, type: 'continuation-published', originalQueue: { intentId: 'original', version: 1, stepCount: 3 }, followupFirstTarget: nextTarget },
    { ...acceptance(30, 2, 'original'), operation: 'append' },
    { at: 70, type: 'skill-finish', receipt: { id: 11, key: originalKey, intentId: 'original', intentVersion: 1,
      finishedAt: 50, status: 'completed' } },
    { at: 80, type: 'skill-start', id: 12, version: 2, key: 'original:step-3:{"type":"goto"}', action: nextTarget },
    { at: 95, type: 'goal-finished', event: { intentId: 'original', terminal: true } },
  ];
}

test('continuation commit requires matching followup work and handoff uses the original receipt completion time', () => {
  const result = measureEfficiency(handoffEvents(), 0, 100);
  assert.equal(result.publicationToUsefulCommitMs, 10);
  assert.equal(result.commitBeforeOriginalCompletion, true);
  assert.equal(result.handoffIdleMs, 30, 'Receipt finishedAt=50, not receipt event=70 or appended goal-finished=95.');
  assert.equal(result.continuationCommitEvidence?.originalLastStepIndex, 2);
  assert.equal(result.continuationCommitEvidence?.followupSkillId, 12);
});

test('wrong lineage, wrong version, reflexes, old targets, and absent work cannot prove a useful continuation', () => {
  for (const change of [
    { key: 'foreign:step-3:{"type":"goto"}' }, { version: 3 }, { key: 'original:flee:{"type":"goto"}' },
    { action: { type: 'goto', x: .5, y: 64, z: 4.5 } }, { at: 101 },
  ]) {
    const events = handoffEvents().map(event => event.at === 80 ? { ...event, ...change } : event);
    const result = measureEfficiency(events, 0, 100);
    assert.equal(result.publicationToUsefulCommitMs, null); assert.equal(result.commitBeforeOriginalCompletion, null);
    assert.equal(result.handoffIdleMs, null);
  }
  const foreignAppend = handoffEvents().map(event => event.at === 30 ? { ...acceptance(30, 2, 'foreign'), operation: 'append' }
    : event.at === 80 ? { ...event, key: 'foreign:step-3:{"type":"goto"}' } : event);
  assert.equal(measureEfficiency(foreignAppend, 0, 100).publicationToUsefulCommitMs, null);
  for (const omitted of [10, 70]) {
    const result = measureEfficiency(handoffEvents().filter(event => event.at !== omitted), 0, 100);
    assert.equal(result.publicationToUsefulCommitMs, 10);
    assert.equal(result.commitBeforeOriginalCompletion, null); assert.equal(result.handoffIdleMs, null);
  }
  const wrongReceipt = handoffEvents().map(event => event.at === 70 ? { ...event, receipt: { ...(event as any).receipt, intentId: 'foreign' } } : event);
  assert.equal(measureEfficiency(wrongReceipt, 0, 100).handoffIdleMs, null);
  const interveningWork = [...handoffEvents(), { at: 60, type: 'skill-start', id: 13, version: 2, key: 'original:step-2:{"type":"goto"}' }];
  assert.equal(measureEfficiency(interveningWork, 0, 100).handoffIdleMs, null,
    'An intervening work interval is not proven idle time.');
});

const acceptance = (at: number, version: number, intentId: string) => ({ at, type: 'plan-accepted', version,
  event: { controlEvent: { intentId, intentVersion: version } } });
const work = (at: number, version: number, intentId: string) => ({ at, type: 'skill-start', version, id: version,
  key: `${intentId}:step-0:{"type":"goto"}` });

test('initial empty survival grant and its later reflex are not a one-millisecond candidate plan', () => {
  const result = measureEfficiency([
    { at: 100, type: 'planner-start', mode: 'agent' }, acceptance(101, 1, 'bootstrap'),
    { at: 102, type: 'model-start' }, { at: 110, type: 'skill-start', version: 1, key: 'bootstrap:flee:{"type":"retreat"}' },
    { at: 150, type: 'model-start' }, acceptance(200, 2, 'candidate'), work(201, 2, 'candidate'),
  ], 0, 400);
  assert.equal(result.firstCandidatePlanMs, 100); assert.equal(result.modelRequestsBeforeFirstCandidatePlan, 2);
  assert.equal(result.firstCandidatePlanEvidence.version, 2);
  assert.equal(result.firstCandidatePlanEvidence.intentId, 'candidate');
});

test('a scripted planner has no model calls but still requires work from its own candidate version', () => {
  const result = measureEfficiency([
    acceptance(10, 1, 'fixture'), work(11, 1, 'fixture'),
    { at: 100, type: 'planner-start', mode: 'scripted' }, acceptance(200, 2, 'candidate'), work(201, 2, 'candidate'),
  ], 0, 400);
  assert.equal(result.firstCandidatePlanMs, 100); assert.equal(result.modelRequestsBeforeFirstCandidatePlan, 0);
});

test('matching version with the wrong lineage, reflex, later append or post-window skill cannot prove the initial plan', () => {
  for (const other of [work(201, 2, 'stale'), work(201, 3, 'candidate'), work(401, 2, 'candidate'),
    { at: 201, type: 'skill-start', version: 2, key: 'candidate:surface:{"type":"surface"}' }]) {
    const result = measureEfficiency([
      { at: 100, type: 'planner-start', mode: 'agent' }, { at: 110, type: 'model-start' },
      acceptance(200, 2, 'candidate'), other,
      acceptance(250, 4, 'replacement'), work(251, 4, 'replacement'),
    ], 0, 400);
    assert.equal(result.firstCandidatePlanMs, null); assert.equal(result.modelRequestsBeforeFirstCandidatePlan, null);
    assert.equal(result.firstCandidatePlanEvidence.reason, 'first-candidate-plan-has-no-matching-work-start');
  }
});

test('a new planning round cannot use a previous round model call to legitimize a fixture acceptance', () => {
  const result = measureEfficiency([
    { at: 100, type: 'planner-start', mode: 'agent' }, { at: 110, type: 'model-start' },
    { at: 200, type: 'planner-start', mode: 'agent' }, acceptance(201, 1, 'fixture'), work(202, 1, 'fixture'),
    { at: 210, type: 'model-start' }, acceptance(300, 2, 'candidate'), work(301, 2, 'candidate'),
    { at: 450, type: 'planner-result', toolTrace: [{ name: 'observe', status: 'completed' }, { name: 'body_plan', status: 'accepted' }] },
  ], 0, 400);
  assert.equal(result.firstCandidatePlanMs, 200); assert.equal(result.modelRequestsBeforeFirstCandidatePlan, 2);
  assert.equal(result.toolsBeforeFirstAcceptedCandidatePlan, null, 'Post-window traces remain excluded rather than guessed to be in-window.');
});

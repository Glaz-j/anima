import test from 'node:test';
import assert from 'node:assert/strict';
import { measureExam } from '../adapters/minecraft/benchmark/metrics.ts';
import type { ExamEvent, ServerEvidence } from '../adapters/minecraft/benchmark/types.ts';

function evidence(at: number, tick = at / 50): ServerEvidence {
  return { source: 'fixture', sequence: at, sampledAt: at, serverTick: tick,
    actor: { name: 'ExamBot', position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, air: 300, onGround: true, inventory: {} },
    statistics: {}, enemies: [] };
}

test('unanswered hazards remain visible instead of vanishing from reaction statistics', () => {
  const metrics = measureExam([
    { type: 'hazard-observed', at: 1100, hazardId: 'responded' },
    { type: 'reaction', at: 1200, hazardId: 'responded' },
    { type: 'hazard-observed', at: 1500, hazardId: 'unanswered' },
  ], evidence(1000), evidence(2500));
  assert.equal(metrics.reactionP50Ms, 100);
  assert.equal(metrics.reactionSamples, 1); assert.equal(metrics.hazardsObserved, 2);
  assert.equal(metrics.missedHazards, 1); assert.equal(metrics.unansweredHazardMaxAgeMs, 1000);
  assert.equal(metrics.reactionCompletionRate, .5);
  assert.equal(metrics.reactionLatencyScope, 'responded-hazards-only-report-missed-separately');
});

test('no reactions produces censored unanswered observations, not zero-millisecond success', () => {
  const metrics = measureExam([
    { type: 'hazard-observed', at: 1000, hazardId: 'first' },
    { type: 'hazard-observed', at: 1400, hazardId: 'second' },
  ], evidence(1000), evidence(2000));
  assert.equal(metrics.reactionP50Ms, null); assert.equal(metrics.reactionP95Ms, null);
  assert.equal(metrics.missedHazards, 2); assert.equal(metrics.reactionSamples, 0);
  assert.equal(metrics.reactionCompletionRate, 0); assert.equal(metrics.unansweredHazardMaxAgeMs, 1000);
});

test('duplicate hazard and reaction events cannot manufacture extra successful response samples', () => {
  const metrics = measureExam([
    { type: 'hazard-observed', at: 1100, hazardId: 'one' },
    { type: 'hazard-observed', at: 1110, hazardId: 'one' },
    { type: 'reaction', at: 1200, hazardId: 'one' },
    { type: 'reaction', at: 1300, hazardId: 'one' },
    { type: 'hazard-observed', at: 1400, hazardId: 'one' },
    { type: 'reaction', at: 1500, hazardId: 'unknown' },
  ], evidence(1000), evidence(2000));
  assert.equal(metrics.hazardsObserved, 1); assert.equal(metrics.reactionSamples, 1);
  assert.equal(metrics.reactionP95Ms, 100); assert.equal(metrics.missedHazards, 0);
});

test('responses after the recorded trial window cannot erase a missed reaction', () => {
  const metrics = measureExam([
    { type: 'hazard-observed', at: 1900, hazardId: 'late' },
    { type: 'reaction', at: 2100, hazardId: 'late' },
  ], evidence(1000), evidence(2000));
  assert.equal(metrics.missedHazards, 1); assert.equal(metrics.unansweredHazardMaxAgeMs, 100);
  assert.equal(metrics.reactionSamples, 0);
});

test('tick coverage includes silent tail and startup while preserving interior tick-gap metrics', () => {
  const metrics = measureExam([
    { type: 'control-tick', at: 1100 }, { type: 'control-tick', at: 1150 }, { type: 'control-tick', at: 1200 },
  ], evidence(1000), evidence(2000));
  assert.equal(metrics.controlGapP95Ms, 50); assert.equal(metrics.controlGapMaxMs, 50);
  assert.equal(metrics.controlTickSamples, 3);
  assert.equal(metrics.controlObservationStartGapMs, 100); assert.equal(metrics.controlObservationTailGapMs, 800);
  assert.equal(metrics.controlObservationMaxGapMs, 800);
  assert.equal(metrics.controlObservationScope, 'trial-window-tick-coverage-including-idle');
});

test('a legitimately completed skill can leave an observation gap without becoming a reported fault', () => {
  const metrics = measureExam([
    { type: 'control-tick', at: 1000 }, { type: 'control-tick', at: 1050 },
    { type: 'skill-stop', at: 1100, skill: 'finished-goal' },
  ], evidence(1000), evidence(2000));
  assert.equal(metrics.controlObservationTailGapMs, 950);
  assert.equal(metrics.controlObservationScope, 'trial-window-tick-coverage-including-idle');
  assert.equal('controlFault' in metrics, false);
});

test('no observed ticks reports the whole observation window uncovered without inventing heartbeat timing', () => {
  const metrics = measureExam([], evidence(1000), evidence(2000));
  assert.equal(metrics.controlTickSamples, 0); assert.equal(metrics.controlGapP95Ms, null);
  assert.equal(metrics.controlObservationMaxGapMs, 1000); assert.equal(metrics.controlObservationTailGapMs, 1000);
  assert.equal(metrics.reactionCompletionRate, null); assert.equal(metrics.unansweredHazardMaxAgeMs, null);
});

test('control ticks never count as inputs and held-state rewrites do not inflate issued APM', () => {
  const events: ExamEvent[] = Array.from({ length: 20 }, (_, i) => ({ type: 'control-tick', at: 1000 + i * 50 }));
  events.push(...Array.from({ length: 20 }, (_, i) => ({ type: 'input' as const, at: 1000 + i * 50, channel: 'key:forward', value: true, discrete: false })));
  events.push({ type: 'input', at: 1980, channel: 'key:forward', value: false, discrete: false });
  events.push({ type: 'input', at: 1990, channel: 'attack', value: 'target', discrete: true });
  const metrics = measureExam(events, evidence(1000), evidence(2000));
  assert.equal(metrics.controlTickSamples, 20); assert.equal(metrics.rawInputCalls, 22);
  assert.equal(metrics.issuedInputs, 3); assert.equal(metrics.issuedInputApm, 180);
  assert.equal(metrics.effectiveInputs, metrics.issuedInputs); assert.equal(metrics.effectiveApm, metrics.issuedInputApm);
  assert.equal(metrics.inputMetricScope, 'issued-inputs-not-confirmed-effects');
});

test('zero-duration or incomplete evidence cannot produce infinite APM or fabricated latency', () => {
  const metrics = measureExam([], evidence(1000), evidence(1000));
  assert.equal(metrics.issuedInputApm, 0); assert.equal(metrics.controlObservationMaxGapMs, 0);
  assert.equal(metrics.reactionP50Ms, null);
  const missing = measureExam([]);
  assert.equal(missing.issuedInputApm, 0); assert.equal(missing.controlObservationTailGapMs, 0);
});

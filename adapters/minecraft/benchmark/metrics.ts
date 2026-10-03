import type { ExamEvent, ExamMetrics, ServerEvidence } from './types.ts';

function percentile(values: number[], quantile: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}
export function measureExam(events: readonly ExamEvent[], initial?: ServerEvidence, final?: ServerEvidence): ExamMetrics {
  const start = initial?.sampledAt ?? 0, end = final?.sampledAt ?? start;
  const elapsedMs = Math.max(0, end - start), gameTicks = Math.max(0, (final?.serverTick ?? 0) - (initial?.serverTick ?? 0));
  const ordered = events.filter(event => Number.isFinite(event.at) && event.at >= start && event.at <= end).toSorted((a, b) => a.at - b.at);
  const inputs: number[] = [], states = new Map<string, unknown>(), ticks: number[] = [];
  const hazards = new Map<string, { at: number; responded: boolean }>(), reactions: number[] = [];
  const modelStart = new Map<string, number>(); let modelCalls = 0, modelWaitMs = 0, rawInputCalls = 0;
  for (const event of ordered) {
    if (event.type === 'input') {
      rawInputCalls += 1;
      if (!event.channel) continue;
      if (event.discrete || !states.has(event.channel) || states.get(event.channel) !== event.value) inputs.push(event.at);
      states.set(event.channel, event.value);
    }
    if (event.type === 'control-tick') ticks.push(event.at);
    if (event.type === 'hazard-observed' && event.hazardId && !hazards.has(event.hazardId)) hazards.set(event.hazardId, { at: event.at, responded: false });
    if (event.type === 'reaction' && event.hazardId) {
      const hazard = hazards.get(event.hazardId);
      if (hazard && !hazard.responded) { reactions.push(event.at - hazard.at); hazard.responded = true; }
    }
    if (event.type === 'model-start') { modelCalls += 1; modelStart.set(event.channel || 'planner', event.at); }
    if (event.type === 'model-end' && modelStart.has(event.channel || 'planner')) {
      modelWaitMs += event.at - modelStart.get(event.channel || 'planner')!; modelStart.delete(event.channel || 'planner');
    }
  }
  for (const pending of modelStart.values()) modelWaitMs += Math.max(0, end - pending);
  let peakOneSecondInputs = 0, left = 0;
  for (let right = 0; right < inputs.length; right += 1) {
    while (inputs[right] - inputs[left] >= 1000) left += 1;
    peakOneSecondInputs = Math.max(peakOneSecondInputs, right - left + 1);
  }
  const gaps = ticks.slice(1).map((at, i) => at - ticks[i]);
  const startGap = ticks.length ? ticks[0] - start : elapsedMs;
  const tailGap = ticks.length ? end - ticks[ticks.length - 1] : elapsedMs;
  const unanswered = [...hazards.values()].filter(hazard => !hazard.responded);
  const issuedApm = elapsedMs > 0 ? inputs.length * 60_000 / elapsedMs : 0;
  const maximumGap = gaps.reduce((maximum, gap) => Math.max(maximum, gap), 0);
  return {
    elapsedMs, gameTicks, realtimeRatio: elapsedMs > 0 ? gameTicks * 50 / elapsedMs : 0,
    damageTaken: Math.max(0, ((final?.statistics.damage ?? 0) - (initial?.statistics.damage ?? 0)) / 10),
    deaths: Math.max(0, (final?.statistics.deaths ?? 0) - (initial?.statistics.deaths ?? 0)),
    effectiveInputs: inputs.length, effectiveApm: issuedApm,
    issuedInputs: inputs.length, issuedInputApm: issuedApm, inputMetricScope: 'issued-inputs-not-confirmed-effects',
    rawInputCalls, peakOneSecondInputs, controlGapP95Ms: percentile(gaps, 0.95), controlGapMaxMs: gaps.length ? maximumGap : null,
    controlTickSamples: ticks.length, controlObservationStartGapMs: startGap, controlObservationTailGapMs: tailGap,
    controlObservationMaxGapMs: Math.max(startGap, tailGap, maximumGap),
    controlObservationScope: 'trial-window-tick-coverage-including-idle',
    hazardsObserved: hazards.size, reactionSamples: reactions.length, missedHazards: unanswered.length,
    unansweredHazardMaxAgeMs: unanswered.length ? unanswered.reduce((maximum, hazard) => Math.max(maximum, end - hazard.at), 0) : null,
    reactionCompletionRate: hazards.size ? reactions.length / hazards.size : null,
    reactionLatencyScope: 'responded-hazards-only-report-missed-separately',
    reactionP50Ms: percentile(reactions, 0.5), reactionP95Ms: percentile(reactions, 0.95), modelCalls, modelWaitMs,
    uninstrumented: !ordered.some(event => event.type === 'control-tick') || !ordered.some(event => event.type === 'input'),
  };
}

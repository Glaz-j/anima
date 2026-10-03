/** Pure diagnostics for the continuity probe. Scripted planner delay is never model time. */
export interface ContinuityEvent { at: number; type: string; channel?: string; id?: number; [key: string]: unknown }
type Span = { start: number; end: number };

function spans(events: ContinuityEvent[], startType: string, endType: string, start: number, end: number) {
  const active = new Map<string | number, number>(), result: Span[] = [];
  for (const event of [...events].sort((a, b) => a.at - b.at)) {
    const key = event.channel ?? event.id ?? 0;
    if (event.type === startType) active.set(key, event.at);
    else if (event.type === endType && active.has(key)) {
      result.push({ start: Math.max(start, active.get(key)!), end: Math.min(end, event.at) }); active.delete(key);
    }
  }
  for (const at of active.values()) result.push({ start: Math.max(start, at), end });
  return result.filter(span => span.end >= span.start).sort((a, b) => a.start - b.start);
}
function merge(spans: Span[]) {
  const result: Span[] = [];
  for (const span of spans) {
    const last = result.at(-1);
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else result.push({ ...span });
  }
  return result;
}
const duration = (spans: Span[]) => spans.reduce((total, span) => total + span.end - span.start, 0);

/** Disjoint occupancy accounting, not a claim that an overlapping model caused every idle millisecond. */
function idlePartition(start: number, end: number, work: Span[], model: Span[], scripted: Span[]) {
  const boundaries = [...new Set([start, end, ...[...work, ...model, ...scripted]
    .flatMap(span => [Math.max(start, span.start), Math.min(end, span.end)])])]
    .filter(at => at >= start && at <= end).sort((a, b) => a - b);
  const result = { noWorkDuringModelMs: 0, noWorkDuringScriptedDelayMs: 0, otherNoWorkMs: 0 };
  const covers = (spans: Span[], at: number) => spans.some(span => span.start <= at && span.end > at);
  for (let index = 1; index < boundaries.length; index++) {
    const from = boundaries[index - 1], ms = boundaries[index] - from;
    if (covers(work, from)) continue;
    if (covers(model, from)) result.noWorkDuringModelMs += ms;
    else if (covers(scripted, from)) result.noWorkDuringScriptedDelayMs += ms;
    else result.otherNoWorkMs += ms;
  }
  return result;
}

export function measureContinuity(events: ContinuityEvent[], start: number, end: number) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error('Invalid continuity window.');
  const within = events.filter(event => event.at >= start && event.at <= end);
  const work = merge(spans(events, 'native-start', 'native-end', start, end));
  const model = merge(spans(events, 'model-start', 'model-end', start, end));
  const scripted = merge(spans(events, 'planner-delay-start', 'planner-delay-end', start, end));
  const gaps = work.slice(1).map((span, index) => ({ from: work[index].end, to: span.start, durationMs: span.start - work[index].end,
    ...idlePartition(work[index].end, span.start, [], model, scripted) }));
  let overlapMs = 0;
  for (const a of model) for (const b of work) overlapMs += Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  const blocked = within.filter(event => event.type === 'goal-blocked').map(event => {
    const after = (type: string) => within.find(next => next.at >= event.at && next.type === type)?.at;
    const plannerAt = after('planner-start'), acceptedAt = after('plan-accepted'), workAt = after('native-start');
    return { at: event.at, plannerStartedAfterMs: plannerAt === undefined ? null : plannerAt - event.at,
      planAcceptedAfterMs: acceptedAt === undefined ? null : acceptedAt - event.at,
      workResumedAfterMs: workAt === undefined ? null : workAt - event.at };
  });
  return {
    elapsedMs: end - start, nativeWorkMs: duration(work), noNativeWorkMs: end - start - duration(work),
    ...idlePartition(start, end, work, model, scripted),
    startupNoWorkMs: work.length ? work[0].start - start : end - start,
    tailNoWorkMs: work.length ? end - work.at(-1)!.end : 0,
    interSkillNoWorkMs: gaps.reduce((sum, gap) => sum + gap.durationMs, 0),
    interSkillGapMaxMs: gaps.length ? Math.max(...gaps.map(gap => gap.durationMs)) : null, interSkillGaps: gaps,
    modelCalls: within.filter(event => event.type === 'model-start').length, modelWaitMs: duration(model),
    scriptedPlannerDelayMs: duration(scripted), modelNativeWorkOverlapMs: overlapMs,
    plannerTurns: within.filter(event => event.type === 'planner-start').length,
    skillStarts: within.filter(event => event.type === 'skill-start').length,
    skillFailures: within.filter(event => event.type === 'skill-finish' && event.status === 'failed').length,
    goalFinishes: within.filter(event => event.type === 'goal-finished').length,
    planningNeededEvents: within.filter(event => event.type === 'planning-needed').length,
    acceptedAppends: within.filter(event => event.type === 'plan-accepted' && event.operation === 'append').length,
    blocked,
    scope: 'native-owner-occupancy-not-confirmed-movement; startup-and-tail-included-in-noNativeWorkMs; open-spans-censored-at-trial-end',
    partitionScope: 'noNativeWorkMs = noWorkDuringModelMs + noWorkDuringScriptedDelayMs + otherNoWorkMs; modelWaitMs overlaps nativeWorkMs and is not additive; occupancy is not causal attribution',
  };
}

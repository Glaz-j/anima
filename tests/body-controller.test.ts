import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { BodyController, type BodyControllerOptions, type BodyEvent, type BodyExecutionResult,
  type BodyIntent, type BodySelection } from '../packages/bridge/src/body-controller.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 16; i += 1) await Promise.resolve(); }
type State = { mode: string; permitted: boolean; done: boolean };
type Goal = { resource: string };
type Action = { name: string };
type Options = BodyControllerOptions<State, Goal, Action>;
function intent(version = 1, overrides: Partial<BodyIntent<Goal>> = {}): BodyIntent<Goal> {
  return { id: `goal-${version}`, version, goal: { resource: 'wood' }, expiresAt: 100000,
    allowedReactions: ['surface', 'defend', 'eat'], ...overrides };
}
function fixture(overrides: Partial<Options> = {}) {
  let now = 1000;
  const state: State = { mode: 'work', permitted: true, done: false };
  const calls: { action: Action; signal: AbortSignal; report: (value: unknown) => void;
    pending: ReturnType<typeof deferred<BodyExecutionResult>> }[] = [];
  const events: BodyEvent[] = [];
  const halts: string[] = [];
  const select: Options['select'] = (state, goal) => state.done ? { kind: 'complete' }
    : { kind: 'run', key: `${state.mode}:${goal.goal.resource}`, action: { name: state.mode },
      priority: state.mode === 'work' ? 1 : 10, reaction: state.mode === 'work' ? undefined : state.mode };
  const controller = new BodyController<State, Goal, Action>({
    now: () => now, readState: () => state, select, canStart: state => state.permitted,
    execute(action, signal, report) { const pending = deferred<BodyExecutionResult>(); calls.push({ action, signal, report, pending }); return pending.promise; },
    halt(reason) { halts.push(reason); }, onEvent: event => events.push(event),
    ...overrides,
  });
  return { controller, state, calls, events, halts, time(value: number) { now = value; },
    async begin(goal = intent()) { assert.equal(controller.submit(goal).accepted, true); controller.tick(); await flush(); },
    async clean() { const stopping = controller.dispose(); for (const call of calls) call.pending.resolve({ status: 'cancelled' }); await stopping; },
  };
}

test('a persistent skill keeps sole ownership through many nonblocking control ticks', async t => {
  const f = fixture(); t.after(() => f.clean()); await f.begin();
  for (let i = 0; i < 1000; i += 1) { f.time(1000 + i); assert.equal(f.controller.tick(), undefined); }
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].signal.aborted, false);
  f.calls[0].report({ blocks: 3 });
  assert.deepEqual(f.controller.snapshot().current?.progress, { blocks: 3 });
  f.state.done = true;
  f.calls[0].pending.resolve({ status: 'completed', data: { blocks: 8 } }); await flush();
  f.controller.tick();
  assert.equal(f.controller.snapshot().intent, undefined);
  assert.deepEqual(f.controller.snapshot().recentReceipts[0].result.data, { blocks: 8 });
  assert.equal(f.events.filter(event => event.type === 'intent-finished').length, 1);
});

test('renewing an observed authorization preserves execution and cannot revive expiry or stop', async t => {
  const f = fixture(); t.after(() => f.clean()); await f.begin();
  const initial = f.controller.snapshot(), call = f.calls[0];
  assert.equal(f.controller.renew(initial.version, 150000).accepted, true);
  assert.equal(call.signal.aborted, false);
  assert.equal(f.controller.snapshot().current!.id, initial.current!.id);
  assert.equal(f.controller.snapshot().intent!.expiresAt, 150000);
  assert.equal(f.controller.renew(initial.version - 1, 160000).accepted, false);
  f.time(150001);
  assert.equal(f.controller.renew(initial.version, 200000).accepted, false);
  const stopping = f.controller.stop(); call.pending.resolve({ status: 'cancelled' }); await stopping;
  assert.equal(f.controller.renew(f.controller.snapshot().version, 200000).accepted, false);
});

test('extension advances control version while preserving the running skill and its original receipt', async t => {
  const f = fixture(); t.after(() => f.clean()); await f.begin();
  f.calls[0].report({ blocks: 2 });
  const before = f.controller.snapshot(), goal = { resource: 'wood' };
  assert.deepEqual(f.controller.extend(before.version, goal, 150000), { accepted: true, version: 2 });
  goal.resource = 'stone'; f.controller.tick(); await flush();
  const after = f.controller.snapshot();
  assert.equal(after.intent?.id, before.intent?.id); assert.equal(after.intent?.version, 2);
  assert.equal(after.intent?.goal.resource, 'wood'); assert.equal(after.intent?.expiresAt, 150000);
  assert.deepEqual(after.intent?.allowedReactions, before.intent?.allowedReactions);
  assert.deepEqual(after.current, before.current); assert.equal(f.calls.length, 1); assert.equal(f.halts.length, 0);
  assert.equal(f.calls[0].signal.aborted, false);
  assert.equal(f.controller.extend(1, { resource: 'wood' }, 180000).accepted, false);
  assert.equal(f.controller.submit(intent(2)).accepted, false);
  assert.equal(f.controller.renew(1, 180000).accepted, false);
  assert.equal(f.controller.cancel(2).accepted, false);
  f.calls[0].pending.resolve({ status: 'completed' }); await flush();
  assert.equal(f.controller.snapshot().recentReceipts[0].intentVersion, 1);
  assert.equal(f.controller.snapshot().recentReceipts[0].intentId, before.intent?.id);
  assert.equal(f.events.filter(event => event.type === 'intent-extended').length, 1);
});

test('failure after extension still backs off the same authorized lineage', async t => {
  const f = fixture(); t.after(() => f.clean()); await f.begin();
  f.controller.extend(1, { resource: 'wood' }, 150000);
  f.calls[0].pending.resolve({ status: 'failed', reason: 'try later' }); await flush();
  f.controller.tick(); await flush(); assert.equal(f.calls.length, 1);
  assert.match(f.controller.snapshot().blocked!, /failure backoff/u);
  f.time(1999); f.controller.tick(); await flush(); assert.equal(f.calls.length, 1);
  f.time(2000); f.controller.tick(); await flush(); assert.equal(f.calls.length, 2);
  assert.equal(f.controller.snapshot().current?.intentVersion, 2);
});

for (const state of ['stopped', 'cancelled', 'expired', 'blocked'] as const) {
  test(`extension cannot revive ${state} authorization`, async t => {
    const f = fixture(); t.after(() => f.clean()); await f.begin();
    if (state === 'stopped') void f.controller.stop();
    if (state === 'cancelled') f.controller.cancel(2);
    if (state === 'expired') f.time(100000);
    if (state === 'blocked') { f.state.mode = 'surface'; f.state.permitted = false; f.controller.tick(); }
    assert.equal(f.controller.extend(f.controller.snapshot().version, { resource: 'wood' }, 200000).accepted, false);
    if (state !== 'blocked') assert.equal(f.controller.snapshot().intent, undefined);
  });
}

test('replacement cannot reuse the live or draining intent identity', async t => {
  const f = fixture(); t.after(() => f.clean()); await f.begin();
  assert.equal(f.controller.submit(intent(2, { id: 'goal-1' })).accepted, false);
  f.controller.cancel(2);
  assert.equal(f.controller.submit(intent(3, { id: 'goal-1' })).accepted, false);
  assert.equal(f.controller.submit(intent(3)).accepted, true);
});

test('emergency aborts immediately but replacement cannot execute until original operation drains', async t => {
  const f = fixture({ minRunMs: 5000, switchDelayMs: 5000 }); t.after(() => f.clean()); await f.begin();
  f.state.mode = 'surface'; f.controller.tick();
  assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(f.halts.length, 1);
  for (let i = 0; i < 100; i += 1) f.controller.tick();
  await flush(); assert.equal(f.calls.length, 1);
  assert.equal(f.controller.snapshot().current?.phase, 'draining');
  f.calls[0].pending.resolve({ status: 'completed', details: { actuallyCollected: 2 } }); await flush();
  f.controller.tick(); await flush();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].action.name, 'surface');
  assert.equal(f.controller.snapshot().recentReceipts[0].status, 'cancelled');
  assert.equal(f.controller.snapshot().recentReceipts[0].result.status, 'completed', 'Late actual results remain available for accounting.');
});

test('resume reselects from fresh state and revalidates preconditions after draining', async t => {
  const f = fixture(); t.after(() => f.clean()); await f.begin();
  f.state.mode = 'surface'; f.controller.tick();
  f.state.mode = 'eat'; f.state.permitted = false;
  f.calls[0].pending.resolve({ status: 'cancelled' }); await flush();
  f.controller.tick(); await flush(); assert.equal(f.calls.length, 1);
  f.state.permitted = true; f.controller.tick(); await flush();
  assert.equal(f.calls[1].action.name, 'eat', 'The obsolete surface candidate was not queued and replayed.');
});

test('unauthorized reactions cannot obtain the body', async t => {
  const f = fixture(); t.after(() => f.clean()); await f.begin(intent(1, { allowedReactions: [] }));
  f.state.mode = 'defend'; f.controller.tick();
  assert.equal(f.calls[0].signal.aborted, true);
  f.calls[0].pending.resolve({ status: 'cancelled' }); await flush();
  f.controller.tick(); await flush();
  assert.equal(f.calls.length, 1);
  assert.match(f.controller.snapshot().blocked!, /not authorized/);
});

test('new brain intent revokes old work immediately and late completion cannot complete the new goal', async t => {
  const f = fixture(); t.after(() => f.clean()); await f.begin();
  const replacement = intent(2, { goal: { resource: 'stone' }, allowedReactions: [] });
  assert.equal(f.controller.submit(replacement).accepted, true);
  assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(f.controller.submit(intent(1)).accepted, false);
  assert.equal(f.controller.cancel(1).accepted, false);
  f.calls[0].pending.resolve({ status: 'completed', data: { blocks: 8 } }); await flush();
  assert.equal(f.controller.snapshot().intent?.version, 2);
  assert.equal(f.events.some(event => event.type === 'intent-finished'), false);
  f.controller.tick(); await flush();
  assert.equal(f.controller.snapshot().current?.skill.key, 'work:stone');
});

test('cancel is versioned, does not allow late brain replies to revive the cancelled goal', async t => {
  const f = fixture(); t.after(() => f.clean()); await f.begin();
  assert.equal(f.controller.cancel(2).accepted, true);
  assert.equal(f.controller.submit(intent(2)).accepted, false);
  f.calls[0].pending.resolve({ status: 'cancelled' }); await flush();
  f.controller.tick(); await flush(); assert.equal(f.calls.length, 1);
  assert.equal(f.controller.submit(intent(3)).accepted, true);
  f.controller.tick(); await flush(); assert.equal(f.calls.length, 2);
});

test('stop latches until explicit fresh-version resume, including when a late model result arrives', async t => {
  const f = fixture(); t.after(() => f.clean()); await f.begin();
  const stopped = f.controller.stop();
  assert.equal(f.controller.submit(intent(100)).accepted, false);
  f.calls[0].pending.resolve({ status: 'completed' }); await stopped;
  for (let i = 0; i < 10; i += 1) f.controller.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.controller.resume(intent(1)).accepted, false);
  assert.equal(f.controller.resume(intent(2)).accepted, false, 'Resume prepared against the pre-stop version is obsolete.');
  assert.equal(f.controller.snapshot().stopped, true);
  assert.equal(f.controller.resume(intent(3)).accepted, true);
  f.controller.tick(); await flush(); assert.equal(f.calls.length, 2);
});

test('expiry revokes running authorization; expired or invalid submissions never start', async t => {
  const f = fixture(); t.after(() => f.clean());
  assert.equal(f.controller.submit(intent(1, { expiresAt: 1000 })).accepted, false);
  assert.equal(f.controller.submit(intent(0)).accepted, false);
  await f.begin(intent(1, { expiresAt: 1100 }));
  f.time(1100); f.controller.tick();
  assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.controller.snapshot().intent, undefined);
  f.calls[0].pending.resolve({ status: 'cancelled' }); await flush();
  f.controller.tick(); await flush(); assert.equal(f.calls.length, 1);
  assert.equal(f.events.filter(event => event.type === 'intent-expired').length, 1);
});

for (const entry of ['tick', 'submit', 'renew', 'resume'] as const) {
  test(`${entry} observes lease expiry and rejects a plan prepared from the preceding version`, async t => {
    const f = fixture(); t.after(() => f.clean()); await f.begin(intent(1, { expiresAt: 1100 }));
    const observedVersion = f.controller.snapshot().version;
    const lateReply = intent(observedVersion + 1, { expiresAt: 5000 });
    f.time(1100);
    if (entry === 'tick') f.controller.tick();
    else if (entry === 'submit') assert.equal(f.controller.submit(lateReply).accepted, false);
    else if (entry === 'renew') assert.equal(f.controller.renew(observedVersion, 5000).accepted, false);
    else assert.equal(f.controller.resume(lateReply).accepted, false);
    assert.equal(f.controller.snapshot().version, observedVersion + 1);
    assert.equal(f.controller.snapshot().intent, undefined); assert.equal(f.calls[0].signal.aborted, true);
    assert.equal(f.controller.submit(lateReply).accepted, false);
    assert.equal(f.controller.resume(lateReply).accepted, false);
    assert.equal(f.controller.renew(observedVersion, 5000).accepted, false);
    for (let i = 0; i < 3; i++) f.controller.tick();
    assert.equal(f.controller.snapshot().version, observedVersion + 1, 'One expiry advances the version exactly once.');
    assert.equal(f.events.filter(event => event.type === 'intent-expired').length, 1);
    f.calls[0].pending.resolve({ status: 'completed' }); await flush();
    f.controller.tick(); await flush(); assert.equal(f.calls.length, 1);
    assert.equal(f.controller.submit(intent(f.controller.snapshot().version + 1)).accepted, true,
      'A fresh observation may explicitly authorize new work.');
  });
}

test('goal completion invalidates late repeated plans while allowing a freshly observed new goal', async t => {
  const f = fixture(); t.after(() => f.clean()); await f.begin(intent(1, { allowedReactions: [] }));
  const observedVersion = f.controller.snapshot().version;
  f.calls[0].pending.resolve({ status: 'completed' }); await flush(); f.state.done = true; f.controller.tick();
  assert.equal(f.controller.snapshot().version, observedVersion + 1);
  assert.equal(f.controller.snapshot().intent, undefined);
  assert.equal(f.controller.submit(intent(observedVersion + 1, { allowedReactions: [] })).accepted, false);
  assert.equal(f.controller.resume(intent(observedVersion + 1, { allowedReactions: [] })).accepted, false);
  f.state.done = false;
  for (let i = 0; i < 5; i++) f.controller.tick(); await flush();
  assert.equal(f.calls.length, 1); assert.equal(f.events.filter(event => event.type === 'intent-finished').length, 1);
  assert.equal(f.controller.submit(intent(f.controller.snapshot().version + 1)).accepted, true);
  f.controller.tick(); await flush(); assert.equal(f.calls.length, 2);
});

test('a slow same-skill selection cannot retain ownership past expiry or reuse the old version', async t => {
  let now = 1000, expireDuringSelect = false;
  const f = fixture({ now: () => now, select: () => {
    if (expireDuringSelect) now = 1100;
    return { kind: 'run', key: 'persistent-work', action: { name: 'work' }, priority: 1 };
  } });
  t.after(() => f.clean()); await f.begin(intent(1, { expiresAt: 1100 }));
  expireDuringSelect = true; f.controller.tick();
  assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.controller.snapshot().version, 2);
  assert.equal(f.controller.submit(intent(2)).accepted, false);
  assert.equal(f.events.filter(event => event.type === 'intent-expired').length, 1);
});

test('a stalled cancel or action timeout never releases ownership by timer alone', async t => {
  const f = fixture({ skillTimeoutMs: 100, drainWarningMs: 50 }); t.after(() => f.clean()); await f.begin();
  f.time(1100); f.controller.tick(); assert.equal(f.calls[0].signal.aborted, true);
  f.time(9000); f.controller.tick(); f.controller.tick(); await flush();
  assert.equal(f.calls.length, 1); assert.equal(f.controller.snapshot().current?.phase, 'draining');
  assert.equal(f.events.filter(event => event.reason?.includes('has not drained')).length, 1);
  f.calls[0].pending.resolve({ status: 'cancelled' }); await flush();
  f.controller.tick(); await flush(); assert.equal(f.calls.length, 1, 'Timed-out skill is backed off after actual drain.');
  f.time(10000); f.controller.tick(); await flush(); assert.equal(f.calls.length, 2);
});

test('async halt is drained along with execution before replacement starts', async t => {
  const halt = deferred<void>();
  const f = fixture({ halt: () => halt.promise });
  t.after(async () => { halt.resolve(); await f.clean(); }); await f.begin();
  f.state.mode = 'surface'; f.controller.tick();
  f.calls[0].pending.resolve({ status: 'cancelled' }); await flush();
  f.controller.tick(); await flush(); assert.equal(f.calls.length, 1);
  halt.resolve(); await flush(); f.controller.tick(); await flush();
  assert.equal(f.calls.length, 2);
});

test('cancel during promise finalization also waits for newly created halt promise', async t => {
  const halt = deferred<void>();
  const f = fixture({ halt: () => halt.promise });
  t.after(async () => { halt.resolve(); await f.clean(); }); await f.begin();
  f.calls[0].pending.resolve({ status: 'completed' });
  // Put cancellation into the same microtask turn as execution fulfillment.
  await Promise.resolve();
  f.controller.submit(intent(2));
  await flush(); f.controller.tick(); await flush();
  assert.equal(f.calls.length, 1);
  assert.equal(f.controller.snapshot().current?.phase, 'draining');
  halt.resolve(); await flush(); f.controller.tick(); await flush();
  assert.equal(f.calls.length, 2);
});

test('failures use bounded exponential retry backoff instead of one attempt per tick', async t => {
  const f = fixture({ failureBackoffMs: 100, maxFailureBackoffMs: 200 }); t.after(() => f.clean()); await f.begin();
  f.calls[0].pending.resolve({ status: 'failed', reason: 'No food.' }); await flush();
  for (let i = 0; i < 50; i += 1) f.controller.tick();
  assert.equal(f.calls.length, 1);
  f.time(1100); f.controller.tick(); await flush(); assert.equal(f.calls.length, 2);
  f.calls[1].pending.reject(new Error('Still no food.')); await flush();
  f.time(1200); f.controller.tick(); await flush(); assert.equal(f.calls.length, 2);
  f.time(1300); f.controller.tick(); await flush(); assert.equal(f.calls.length, 3);
});

test('equal-priority candidates must remain stable and respect minimum run time', async t => {
  const f = fixture({ minRunMs: 200, switchDelayMs: 100,
    select: state => ({ kind: 'run', key: state.mode, action: { name: state.mode }, priority: 1 }) });
  t.after(() => f.clean()); await f.begin();
  f.state.mode = 'other'; f.time(1100); f.controller.tick();
  f.state.mode = 'work'; f.time(1150); f.controller.tick();
  f.state.mode = 'other'; f.time(1200); f.controller.tick();
  assert.equal(f.calls[0].signal.aborted, false);
  f.time(1299); f.controller.tick(); assert.equal(f.calls[0].signal.aborted, false);
  f.time(1300); f.controller.tick(); assert.equal(f.calls[0].signal.aborted, true);
});

test('brain timeout is independent; body continues until an explicit command or lease expiry', async t => {
  const f = fixture(); t.after(() => f.clean()); await f.begin();
  const brain = new AbortController(); brain.abort('Model deadline.');
  f.time(5000); f.controller.tick();
  assert.equal(f.calls[0].signal.aborted, false);
  assert.equal(f.controller.snapshot().intent?.version, 1);
});

test('intent and snapshot mutation cannot bypass authorization', async t => {
  const f = fixture(); t.after(() => f.clean()); const proposed = intent(); await f.begin(proposed);
  proposed.goal.resource = 'diamonds'; (proposed.allowedReactions as string[]).push('forbidden');
  const snapshot = f.controller.snapshot(); snapshot.intent!.goal.resource = 'iron';
  snapshot.current!.skill.action.name = 'changed';
  assert.equal(f.controller.snapshot().intent?.goal.resource, 'wood');
  assert.equal(f.controller.snapshot().current?.skill.action.name, 'work');
  assert.equal(f.controller.snapshot().intent?.allowedReactions.includes('forbidden'), false);
});

test('halt failure latches stopped rather than silently transferring body ownership', async t => {
  const f = fixture({ halt() { throw new Error('Device unavailable.'); } }); t.after(() => f.clean()); await f.begin();
  f.state.mode = 'surface'; f.controller.tick();
  f.calls[0].pending.resolve({ status: 'cancelled' }); await flush();
  f.controller.tick(); await flush();
  assert.equal(f.controller.snapshot().stopped, true); assert.equal(f.calls.length, 1);
  assert.equal(f.controller.submit(intent(2)).accepted, false);
});

test('synchronous selection faults abort unsafe work and remain observable', async t => {
  let broken = false;
  const f = fixture({ select() { if (broken) throw new Error('Bad observation.');
    return { kind: 'run', key: 'work', priority: 1, action: { name: 'work' } }; } });
  t.after(() => f.clean()); await f.begin(); broken = true; f.controller.tick();
  assert.equal(f.calls[0].signal.aborted, true);
  assert.ok(f.events.some(event => event.type === 'control-error' && event.reason === 'Bad observation.'));
});

test('start runs a real local timer while an execution promise remains pending', async t => {
  const f = fixture({ tickMs: 2 }); t.after(() => f.clean());
  f.controller.submit(intent()); f.controller.start(); await delay(30);
  assert.equal(f.calls.length, 1); assert.ok(f.controller.snapshot().metrics.ticks >= 2);
  f.state.mode = 'surface';
  for (let i = 0; i < 20 && !f.calls[0].signal.aborted; i += 1) await delay(5);
  assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(f.calls.length, 1, 'The timer does not orphan the still-running operation.');
});

test('an unavailable urgent reaction stops unsafe ordinary work while requesting replanning', async t => {
  const f = fixture(); t.after(() => f.clean()); await f.begin();
  f.state.mode = 'surface'; f.state.permitted = false; f.controller.tick();
  assert.equal(f.calls[0].signal.aborted, true);
  assert.match(f.controller.snapshot().blocked!, /preconditions/);
});

test('reentrant stop from a decision port prevents that decision from starting', async t => {
  let controller: BodyController<State, Goal, Action>;
  const f = fixture({ select() { void controller.stop(); return { kind: 'run', key: 'late', priority: 1, action: { name: 'late' } }; } });
  controller = f.controller; t.after(() => f.clean()); await f.begin();
  assert.equal(f.calls.length, 0); assert.equal(controller.snapshot().stopped, true);
});

test('wait clears current work and progress after cancellation is ignored', async t => {
  let choice: BodySelection<Action> = { kind: 'run', key: 'work', priority: 1, action: { name: 'work' } };
  const f = fixture({ select: () => choice }); t.after(() => f.clean()); await f.begin();
  choice = { kind: 'wait', reason: 'No safe route.' }; f.controller.tick();
  const before = f.events.length; f.calls[0].report({ blocks: 999 });
  assert.equal(f.events.length, before); assert.equal(f.calls[0].signal.aborted, true);
});

test('observer exceptions do not release a live skill or crash the control loop', async t => {
  const f = fixture({ onEvent() { throw new Error('Telemetry down.'); } }); t.after(() => f.clean()); await f.begin();
  f.controller.tick(); assert.equal(f.calls.length, 1);
  assert.ok(f.controller.snapshot().metrics.errors >= 2);
});

test('a spontaneously cancelled skill is backed off instead of restarted every tick', async t => {
  const f = fixture(); t.after(() => f.clean()); await f.begin();
  f.calls[0].pending.resolve({ status: 'cancelled', reason: 'World unavailable.' }); await flush();
  for (let i = 0; i < 100; i += 1) f.controller.tick();
  await flush(); assert.equal(f.calls.length, 1);
});

test('authorization is checked again after a synchronous decision consumes the remaining lease', async t => {
  let advance!: () => void;
  const f = fixture({ canStart() { advance(); return true; } }); t.after(() => f.clean());
  advance = () => f.time(1100);
  await f.begin(intent(1, { expiresAt: 1100 }));
  assert.equal(f.calls.length, 0); assert.equal(f.controller.snapshot().intent, undefined);
});

test('every explicit stop invalidates the observed version, even while already stopped', async t => {
  const f = fixture(); t.after(() => f.clean()); await f.begin();
  const firstStop = f.controller.stop();
  assert.equal(f.controller.snapshot().version, 2);
  const secondStop = f.controller.stop();
  assert.equal(f.controller.snapshot().version, 3);
  assert.equal(f.controller.resume(intent(3)).accepted, false);
  f.calls[0].pending.resolve({ status: 'cancelled' }); await Promise.all([firstStop, secondStop]);
  assert.equal(f.controller.resume(intent(4)).accepted, true);
});

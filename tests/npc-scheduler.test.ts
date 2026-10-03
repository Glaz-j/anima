import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { NpcScheduler, type ActorState, type SchedulerOptions } from '../packages/bridge/src/npc-scheduler.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() {
  // Dispatch, agent resolution, cancellation, and finalization each use microtasks.
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}
async function eventually(check: () => boolean, message: string) {
  const deadline = Date.now() + 2000;
  while (!check() && Date.now() < deadline) await delay(5);
  assert.ok(check(), message);
}
function fixture(overrides: Partial<SchedulerOptions> = {}) {
  let now = 1000;
  let complete = false;
  const actors: ActorState[] = ['A', 'B', 'C', 'D'].map(name => ({ name, ready: true, busy: false }));
  const calls: { name: string; instruction: string; signal?: AbortSignal; pending: ReturnType<typeof deferred<unknown>> }[] = [];
  const cancelled: string[] = [];
  const errors: string[] = [];
  const scheduler = new NpcScheduler({
    getActors: () => actors,
    run(name, instruction, signal) {
      const pending = deferred<unknown>();
      calls.push({ name, instruction, signal, pending });
      return pending.promise;
    },
    cancel(name) { cancelled.push(name); },
    scenarioStatus: () => ({ complete, summary: complete ? 'World confirmed completion.' : 'Objective remains active.' }),
    now: () => now, pollMs: 60000, stopWaitMs: 10, taskTimeoutMs: 60000,
    onError(error) { errors.push(error.message); },
    ...overrides,
  });
  return {
    scheduler, actors, calls, cancelled, errors,
    time(value: number) { now = value; },
    done() { complete = true; },
    async cleanup() {
      for (const call of calls) call.pending.resolve({ status: 'completed' });
      await scheduler.stop();
    },
  };
}

test('four independent NPC tasks run concurrently; an individual NPC never overlaps itself', async t => {
  const f = fixture(); t.after(() => f.cleanup());
  f.actors.push({ name: 'Fifth', ready: true, busy: false });
  f.scheduler.start(); await flush();
  assert.deepEqual(f.calls.map(call => call.name), ['A', 'B', 'C', 'D']);
  assert.equal(f.scheduler.status().activeTasks, 4);
  f.time(100000); f.scheduler.tick(); await flush();
  assert.equal(f.calls.length, 4, 'Busy tasks do not overlap despite many elapsed heartbeats.');
  f.calls[0].pending.resolve({ status: 'completed' }); await flush();
  f.time(112000); f.scheduler.tick(); await flush();
  assert.equal(f.calls.length, 5);
  assert.equal(f.calls[4].name, 'A');
  assert.equal(f.scheduler.status().activeTasks, 4);
  assert.ok(f.calls[4].instruction.includes('末影龙'));
});

test('NPC speech is deduplicated and coalesced without accelerating the normal heartbeat', async t => {
  const f = fixture(); t.after(() => f.cleanup());
  for (const actor of f.actors.slice(1)) actor.ready = false;
  f.scheduler.start(); await flush();
  f.calls[0].pending.resolve({ status: 'completed' }); await flush();
  f.time(1100);
  f.scheduler.wake('A', { id: 'one', type: 'heard', speaker: 'B', message: '队友消息一' });
  f.scheduler.wake('A', { id: 'one', type: 'heard', speaker: 'B', message: '队友消息一' });
  f.scheduler.wake('A', { id: 'repeat', type: 'heard', speaker: 'B', message: '队友消息一' });
  f.scheduler.wake('A', { id: 'two', type: 'heard', speaker: 'B', message: '队友消息二' });
  f.scheduler.wake('A', { type: 'said', message: '自己的输出' });
  f.scheduler.wake('A', { type: 'task-finished' });
  assert.equal(f.scheduler.status().pendingEvents, 2);
  f.time(9000); f.scheduler.tick(); await flush();
  assert.equal(f.calls.length, 1);
  f.time(13000); f.scheduler.tick(); await flush();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].instruction.match(/队友消息一/gu)?.length, 1);
  assert.equal(f.calls[1].instruction.match(/队友消息二/gu)?.length, 1);
});

test('human messages use a shared cooldown and events arriving during execution survive the task', async t => {
  const f = fixture(); t.after(() => f.cleanup());
  f.actors.splice(1);
  f.scheduler.start(); await flush();
  f.scheduler.wake('A', { type: 'heard', speaker: 'Human', message: '第一条' });
  f.scheduler.wake('A', { type: 'heard', speaker: 'Human', message: '第二条' });
  f.time(5000); f.scheduler.tick(); await flush();
  assert.equal(f.calls.length, 1);
  f.calls[0].pending.resolve({ status: 'completed' }); await flush();
  assert.equal(f.scheduler.status().pendingEvents, 2);
  f.time(12999); f.scheduler.tick(); await flush();
  assert.equal(f.calls.length, 1);
  f.time(13000); f.scheduler.tick(); await flush();
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls[1].instruction.includes('第一条'));
  assert.ok(f.calls[1].instruction.includes('第二条'));
});

test('NPC broadcasts remain bounded heard events and neither interrupt nor accelerate another NPC', async t => {
  const f = fixture(); t.after(() => f.cleanup());
  for (const actor of f.actors.slice(1)) actor.ready = false;
  f.scheduler.start(); await flush();
  f.time(1500);
  for (let i = 0; i < 40; i++) f.scheduler.wake('A', {
    id: `broadcast-${i}`, type: 'heard', speaker: 'B', channel: 'broadcast', message: `世界频道原话${i}`,
  });
  assert.equal(f.scheduler.status().pendingEvents, 24);
  assert.deepEqual(f.cancelled, []); assert.equal(f.calls[0].signal?.aborted, false);
  f.time(5000); f.scheduler.tick(); await flush();
  assert.equal(f.calls.length, 1, 'Public chat does not interrupt the active decision or body.');
  f.calls[0].pending.resolve({ status: 'completed' }); await flush();
  assert.equal(f.scheduler.status().actors[0].nextRunAt, 17000);
  f.time(16999); f.scheduler.tick(); await flush(); assert.equal(f.calls.length, 1);
  f.time(17000); f.scheduler.tick(); await flush(); assert.equal(f.calls.length, 2);
  assert.match(f.calls[1].instruction, /世界频道原话39/);
  assert.match(f.calls[1].instruction, /broadcast/);
  assert.equal(f.scheduler.status().pendingEvents, 0);
});

test('hurt queued during execution shortens the next wait without overlapping an active or busy body', async t => {
  const f = fixture(); t.after(() => f.cleanup()); f.actors.splice(1);
  f.scheduler.start(); await flush();
  f.time(2000);
  for (let index = 0; index < 40; index++) f.scheduler.wake('A', { id: `hurt-${index}`, type: 'hurt', healthBefore: 10, health: 9 });
  f.time(5000); f.scheduler.tick(); await flush();
  assert.equal(f.calls.length, 1);
  assert.equal(f.scheduler.status().pendingEvents, 24, 'A hit burst stays bounded.');
  f.calls[0].pending.resolve({ status: 'incomplete', reason: 'budget' }); await flush();
  assert.equal(f.scheduler.status().actors[0].nextRunAt, 5250);
  f.time(5249); f.scheduler.tick(); await flush(); assert.equal(f.calls.length, 1);
  f.actors[0].busy = true;
  f.time(5250); f.scheduler.tick(); await flush(); assert.equal(f.calls.length, 1);
  f.actors[0].busy = false; f.actors[0].ready = false;
  f.scheduler.tick(); await flush(); assert.equal(f.calls.length, 1);
  f.actors[0].ready = true;
  f.scheduler.tick(); await flush(); assert.equal(f.calls.length, 2);
  assert.match(f.calls[1].instruction, /hurt/);
  f.time(10000); f.scheduler.tick(); await flush(); assert.equal(f.calls.length, 2);
});

test('idle hurt retains the merge window and successive hits do not postpone its due time', async t => {
  const f = fixture(); t.after(() => f.cleanup()); f.actors.splice(1);
  f.scheduler.start(); await flush();
  f.calls[0].pending.resolve({ status: 'completed' }); await flush();
  f.time(1200); f.scheduler.wake('A', { id: 'first', type: 'hurt', healthBefore: 20, health: 18 });
  assert.equal(f.scheduler.status().actors[0].nextRunAt, 2200);
  f.time(1900); f.scheduler.wake('A', { id: 'second', type: 'hurt', healthBefore: 18, health: 16 });
  assert.equal(f.scheduler.status().actors[0].nextRunAt, 2200);
  f.time(2199); f.scheduler.tick(); await flush(); assert.equal(f.calls.length, 1);
  f.time(2200); f.scheduler.tick(); await flush(); assert.equal(f.calls.length, 2);
  assert.equal(f.scheduler.status().activeTasks, 1);
});

test('unsubstantiated hurt labels and unchanged health retain the ordinary event cooldown', async t => {
  const f = fixture(); t.after(() => f.cleanup()); f.actors.splice(1);
  f.scheduler.start(); await flush();
  f.scheduler.wake('A', { type: 'hurt', message: '受伤了' });
  f.scheduler.wake('A', { type: 'hurt', healthBefore: 20, health: 20 });
  f.scheduler.wake('A', { type: 'hurt', healthBefore: '20', health: '18' });
  f.calls[0].pending.resolve({ status: 'completed' }); await flush();
  assert.equal(f.scheduler.status().actors[0].nextRunAt, 5000);
  f.time(2000); f.scheduler.tick(); await flush(); assert.equal(f.calls.length, 1);
});

test('real hurt cannot bypass provider failure backoff', async t => {
  const f = fixture({ intervalMs: 1000, errorBackoffMs: 10000 }); t.after(() => f.cleanup()); f.actors.splice(1);
  f.scheduler.start(); await flush();
  f.scheduler.wake('A', { type: 'hurt', healthBefore: 20, health: 18 });
  f.calls[0].pending.reject(new Error('provider unavailable')); await flush();
  assert.equal(f.scheduler.status().actors[0].nextRunAt, 11000);
  f.time(2000); f.scheduler.wake('A', { type: 'hurt', healthBefore: 18, health: 15 });
  f.scheduler.tick(); await flush(); assert.equal(f.calls.length, 1);
  assert.equal(f.scheduler.status().actors[0].nextRunAt, 11000);
  f.time(11000); f.scheduler.tick(); await flush(); assert.equal(f.calls.length, 2);
  assert.match(f.calls[1].instruction, /hurt/);
});

test('provider failures back off exponentially, retain triggers, and cannot be bypassed by new events', async t => {
  const f = fixture({ intervalMs: 1000, errorBackoffMs: 10000, maxErrorBackoffMs: 30000 });
  t.after(() => f.cleanup()); f.actors.splice(1);
  f.scheduler.wake('A', { id: 'trigger', type: 'heard', speaker: 'Human', message: '保留这个目标' });
  f.scheduler.start(); await flush();
  f.calls[0].pending.reject(new Error('provider unavailable')); await flush();
  assert.equal(f.scheduler.status().actors[0].failures, 1);
  assert.equal(f.scheduler.status().actors[0].nextRunAt, 11000);
  f.time(9000); f.scheduler.wake('A', { type: 'danger', message: '新的世界事件' });
  f.scheduler.tick(); await flush(); assert.equal(f.calls.length, 1);
  f.time(11000); f.scheduler.tick(); await flush();
  assert.ok(f.calls[1].instruction.includes('保留这个目标'));
  f.calls[1].pending.resolve({ status: 'incomplete' }); await flush();
  assert.equal(f.scheduler.status().actors[0].nextRunAt, 31000);
  f.time(31000); f.scheduler.tick(); await flush();
  f.calls[2].pending.reject(new Error('provider unavailable')); await flush();
  assert.equal(f.scheduler.status().actors[0].nextRunAt, 61000);
  f.time(61000); f.scheduler.tick(); await flush();
  f.calls[3].pending.resolve({ status: 'completed' }); await flush();
  assert.equal(f.scheduler.status().actors[0].failures, 0);
  assert.equal(f.scheduler.status().actors[0].nextRunAt, 62000);
});

test('timeouts abort and cancel once, and a cancellation-resistant task cannot overlap a replacement', async t => {
  const cancellation = deferred<void>();
  const cancelled: string[] = [];
  const f = fixture({ taskTimeoutMs: 15, cancel(name) { cancelled.push(name); return cancellation.promise; } });
  t.after(async () => { cancellation.resolve(); await f.cleanup(); }); f.actors.splice(1);
  f.scheduler.start(); await flush();
  await delay(35);
  assert.equal(f.calls[0].signal?.aborted, true);
  assert.deepEqual(cancelled, ['A']);
  f.time(999999); f.scheduler.tick(); await flush();
  assert.equal(f.calls.length, 1);
  f.calls[0].pending.resolve({ status: 'completed' }); await flush();
  assert.equal(f.scheduler.status().activeTasks, 1, 'Async cancellation also owns the actor until settled.');
  cancellation.resolve(); await flush();
  assert.equal(f.scheduler.status().activeTasks, 0);
  assert.equal(f.scheduler.status().actors[0].failures, 1);
  assert.ok(f.errors[0].includes('timed out'));
});

test('a reasoning timeout cancels only the turn, preserves body authorization, and drains before another turn', async t => {
  const cancellation = deferred<void>();
  const turnCancelled: string[] = [];
  let bodyAuthorized = true;
  const f = fixture({ taskTimeoutMs: 15,
    cancelTurn(name) { turnCancelled.push(name); return cancellation.promise; },
    cancel(name) { f.cancelled.push(name); bodyAuthorized = false; },
  });
  t.after(async () => { cancellation.resolve(); await f.cleanup(); }); f.actors.splice(1);
  f.scheduler.start(); await flush();
  await delay(35);
  assert.equal(f.calls[0].signal?.aborted, true);
  assert.deepEqual(turnCancelled, ['A']);
  assert.deepEqual(f.cancelled, []);
  assert.equal(bodyAuthorized, true);
  f.calls[0].pending.resolve({ status: 'cancelled' }); await flush();
  f.time(999999); f.scheduler.tick(); await flush();
  assert.equal(f.calls.length, 1, 'A delayed turn cancellation must not hit a replacement task.');
  cancellation.resolve(); await flush();
  assert.equal(f.scheduler.status().activeTasks, 0);
  assert.equal(bodyAuthorized, true);
  await f.scheduler.stop();
  assert.deepEqual(f.cancelled, ['A']);
  assert.equal(bodyAuthorized, false, 'Explicit stop revokes the persistent body even with no active turn.');
});

test('full stop does not wait for a pending turn cancellation before revoking the body', async t => {
  const turnCancellation = deferred<void>();
  const f = fixture({ taskTimeoutMs: 15, cancelTurn: () => turnCancellation.promise });
  t.after(async () => { turnCancellation.resolve(); await f.cleanup(); }); f.actors.splice(1);
  f.scheduler.start(); await flush(); await delay(35);
  assert.deepEqual(f.cancelled, []);
  await f.scheduler.stop();
  assert.deepEqual(f.cancelled, ['A']);
  assert.equal(f.scheduler.status().phase, 'stopped');
});

test('legacy timeout cancellation is not duplicated by a concurrent full stop', async t => {
  const cancellation = deferred<void>();
  const f = fixture({ taskTimeoutMs: 15, cancel(name) { f.cancelled.push(name); return cancellation.promise; } });
  t.after(async () => { cancellation.resolve(); await f.cleanup(); }); f.actors.splice(1);
  f.scheduler.start(); await flush(); await delay(35);
  assert.deepEqual(f.cancelled, ['A']);
  await f.scheduler.stop(); await f.scheduler.stop();
  assert.deepEqual(f.cancelled, ['A']);
});

test('stop cancels each known body once even before any reasoning task was dispatched', async () => {
  const f = fixture();
  f.actors[0].busy = true; f.actors[1].ready = false;
  await Promise.all([f.scheduler.stop(), f.scheduler.stop()]);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.cancelled.sort(), ['A', 'B', 'C', 'D']);
  assert.equal(f.scheduler.status().phase, 'stopped');
});

test('bounded stop retains the body drain barrier even when there was no reasoning task', async t => {
  const cancellation = deferred<void>();
  const f = fixture({ cancel: () => cancellation.promise }); f.actors.splice(1);
  t.after(async () => { cancellation.resolve(); await f.cleanup(); });
  await f.scheduler.stop();
  assert.equal(f.scheduler.status().activeTasks, 0);
  assert.throws(() => f.scheduler.start(), /Previous NPC tasks or bodies/);
  cancellation.resolve(); await flush();
  f.scheduler.start(); await flush();
  assert.equal(f.calls.length, 1);
});

test('stop is bounded even if a provider and cancellation never settle; no more work can launch', async () => {
  const f = fixture({ stopWaitMs: 15, cancel: () => new Promise(() => {}) });
  f.actors.splice(1); f.scheduler.start(); await flush();
  const before = Date.now();
  await f.scheduler.stop();
  assert.ok(Date.now() - before < 1000, 'Stop must not deadlock on an uncooperative provider.');
  assert.equal(f.scheduler.status().phase, 'stopped');
  assert.equal(f.calls[0].signal?.aborted, true);
  f.time(999999); f.scheduler.wake('A', { type: 'heard', speaker: 'Human', message: '不要重新启动' });
  f.scheduler.tick(); await flush();
  assert.equal(f.calls.length, 1);
  assert.throws(() => f.scheduler.start(), /Previous NPC tasks/);
  f.calls[0].pending.resolve({ status: 'completed' });
});

test('authoritative world completion cancels every NPC and reports completion exactly once', async t => {
  let completed = 0;
  const f = fixture({ onComplete() { completed += 1; } }); t.after(() => f.cleanup());
  f.scheduler.start(); await flush();
  f.done(); f.scheduler.tick();
  assert.equal(f.scheduler.status().phase, 'completed');
  assert.ok(f.calls.every(call => call.signal?.aborted));
  for (const call of f.calls) call.pending.resolve({ status: 'cancelled' });
  await f.scheduler.stop(); await flush();
  assert.deepEqual(f.cancelled.sort(), ['A', 'B', 'C', 'D']);
  assert.equal(completed, 1);
  f.scheduler.tick(); f.scheduler.wake('A', { type: 'heard', speaker: 'Human', message: '再试' });
  await flush(); assert.equal(f.calls.length, 4); assert.equal(completed, 1);
});

test('completion stops idle bodies and previously known actors omitted from the latest roster', async t => {
  let completed = 0;
  const f = fixture({ onComplete() { completed += 1; } }); t.after(() => f.cleanup());
  f.scheduler.start(); await flush();
  for (const call of f.calls) call.pending.resolve({ status: 'completed' });
  await flush();
  assert.equal(f.scheduler.status().activeTasks, 0);
  f.actors.splice(0, 1);
  f.done(); f.scheduler.tick();
  await f.scheduler.stop(); await flush();
  assert.deepEqual(f.cancelled.sort(), ['A', 'B', 'C', 'D']);
  assert.equal(completed, 1);
  assert.equal(f.calls.length, 4);
});

test('body telemetry never wakes the brain but terminal intent events obey merge and event cooldowns', async t => {
  const f = fixture(); t.after(() => f.cleanup()); f.actors.splice(1);
  f.scheduler.start(); await flush();
  f.calls[0].pending.resolve({ status: 'completed' }); await flush();
  f.time(1200);
  for (let i = 0; i < 100; i++) {
    f.scheduler.wake('A', { id: `tick-${i}`, type: 'body-tick' });
    f.scheduler.wake('A', { id: `progress-${i}`, type: 'skill-progress' });
  }
  assert.equal(f.scheduler.status().pendingEvents, 0);
  assert.equal(f.scheduler.status().actors[0].nextRunAt, 13000);
  f.scheduler.wake('A', { id: 'completed-goal', type: 'intent-finished', status: 'completed' });
  f.scheduler.wake('A', { id: 'completed-goal', type: 'intent-finished', status: 'completed' });
  f.scheduler.wake('A', { id: 'blocked-goal', type: 'intent-blocked', reason: 'no-route' });
  assert.equal(f.scheduler.status().pendingEvents, 2);
  assert.equal(f.scheduler.status().actors[0].nextRunAt, 5000);
  f.time(4999); f.scheduler.tick(); await flush(); assert.equal(f.calls.length, 1);
  f.time(5000); f.scheduler.tick(); await flush(); assert.equal(f.calls.length, 2);
  assert.match(f.calls[1].instruction, /intent-finished/);
  assert.match(f.calls[1].instruction, /intent-blocked/);
  assert.doesNotMatch(f.calls[1].instruction, /body-tick|skill-progress/);
  assert.equal(f.scheduler.status().pendingEvents, 0);
});

test('externally busy or disconnected actors are skipped, and a limited concurrency slot is fair', async t => {
  const f = fixture({ maxConcurrent: 1, intervalMs: 1000 }); t.after(() => f.cleanup());
  f.actors[0].busy = true; f.actors[1].ready = false;
  f.scheduler.start(); await flush(); assert.deepEqual(f.calls.map(call => call.name), ['C']);
  f.calls[0].pending.resolve({ status: 'completed' }); await flush();
  f.scheduler.tick(); await flush(); assert.equal(f.calls[1].name, 'D');
  f.calls[1].pending.resolve({ status: 'completed' }); await flush();
  f.actors[0].busy = false; f.actors[1].ready = true;
  f.scheduler.tick(); await flush(); assert.equal(f.calls[2].name, 'A');
});

test('stop immediately after start prevents even the first queued model request', async () => {
  const f = fixture();
  f.scheduler.start(); await f.scheduler.stop(); await flush();
  assert.equal(f.calls.length, 0);
  assert.equal(f.scheduler.status().activeTasks, 0);
  assert.equal(f.scheduler.status().phase, 'stopped');
});

test('pending perceptions have a fixed bound under an event burst', async t => {
  const f = fixture(); t.after(() => f.cleanup()); f.actors.splice(1);
  for (let index = 0; index < 60; index += 1) f.scheduler.wake('A', { type: 'heard', speaker: 'Human', message: `事件 ${index}` });
  assert.equal(f.scheduler.status().pendingEvents, 24);
  assert.equal(f.scheduler.status().actors[0].droppedEvents, 36);
});

test('a normal bounded reasoning budget is a turn boundary rather than a provider failure', async t => {
  const f = fixture(); t.after(() => f.cleanup()); f.actors.splice(1);
  f.scheduler.start(); await flush();
  f.calls[0].pending.resolve({ status: 'incomplete', reason: 'budget' }); await flush();
  assert.equal(f.scheduler.status().actors[0].failures, 0);
  assert.equal(f.scheduler.status().actors[0].nextRunAt, 13000);
  assert.equal(f.errors.length, 0);
  f.time(13000); f.scheduler.tick(); await flush();
  assert.equal(f.calls.length, 2);
  f.calls[1].pending.resolve({ status: 'incomplete', reason: 'budget', error: 'provider failure' }); await flush();
  assert.equal(f.scheduler.status().actors[0].failures, 1, 'A provider error still takes precedence over its budget label.');
});

test('death interruptions wait for respawn without accumulating provider failure backoff', async t => {
  const f = fixture(); t.after(() => f.cleanup()); f.actors.splice(1);
  f.scheduler.start(); await flush();
  f.actors[0].ready = false;
  f.scheduler.wake('A', { type: 'death' });
  f.calls[0].pending.resolve({ status: 'cancelled', reason: 'world-change' }); await flush();
  assert.equal(f.scheduler.status().actors[0].failures, 0);
  assert.equal(f.errors.length, 0);
  f.time(10000); f.scheduler.tick(); await flush();
  assert.equal(f.calls.length, 1, 'A dead character must not spend tokens on a stale body.');
  f.actors[0].ready = true; f.scheduler.wake('A', { type: 'spawn' });
  f.scheduler.tick(); await flush();
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[1].instruction, /death/);
  assert.match(f.calls[1].instruction, /spawn/);
});

test('idle planning, finished, and blocked goals continue on a real deadline timer without waiting for polling', async t => {
  const f = fixture({ now: Date.now, pollMs: 60000 }); t.after(() => f.cleanup()); f.actors.splice(1);
  f.scheduler.start(); await eventually(() => f.calls.length === 1, 'The real clock may initialize a new actor after the first tick timestamp.');
  assert.equal(f.scheduler.status().continuityCooldownMs, 250);
  for (const type of ['planning-needed', 'goal-finished', 'goal-blocked']) {
    const previous = f.calls.length;
    f.calls[previous - 1].pending.resolve({ status: 'completed' }); await flush();
    f.scheduler.wake('A', { id: type, type, intentVersion: previous });
    assert.equal(f.calls.length, previous, 'wake only queues the event; it never starts a model synchronously.');
    assert.ok(f.scheduler.status().actors[0].nextRunInMs <= 250);
    await eventually(() => f.calls.length === previous + 1, `${type} must dispatch before the 60-second poll.`);
    assert.match(f.calls[previous].instruction, new RegExp(type));
    assert.equal(f.scheduler.status().activeTasks, 1);
  }
  assert.deepEqual(f.cancelled, [], 'A continuation does not revoke body authorization.');
});

test('an active turn retains one planning hint through a chat burst and yields to the next short continuation', async t => {
  const f = fixture(); t.after(() => f.cleanup()); f.actors.splice(1);
  f.scheduler.start(); await flush();
  for (let index = 0; index < 100; index += 1) f.scheduler.wake('A', {
    id: `planning-${index}`, type: 'planning-needed', intentVersion: 1, stepIndex: 2,
  });
  assert.equal(f.scheduler.status().pendingEvents, 1, 'Repeated hints for the same remaining plan are coalesced.');
  for (let index = 0; index < 60; index += 1) f.scheduler.wake('A', {
    type: 'heard', speaker: 'Human', message: `聊天 ${index}`,
  });
  assert.equal(f.scheduler.status().pendingEvents, 24);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].signal?.aborted, false);
  assert.deepEqual(f.cancelled, []);
  f.calls[0].pending.resolve({ status: 'incomplete', reason: 'budget' }); await flush();
  assert.equal(f.scheduler.status().actors[0].nextRunAt, 1250);
  f.time(1249); f.scheduler.tick(); await flush(); assert.equal(f.calls.length, 1);
  f.time(1250); f.scheduler.tick(); await flush(); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].instruction.match(/planning-needed/gu)?.length, 1);
  assert.match(f.calls[1].instruction, /聊天 59/);
  f.scheduler.wake('A', { type: 'goal-blocked', intentVersion: 1, receiptId: 7 });
  f.calls[1].pending.resolve({ status: 'cancelled', reason: 'body-replan' }); await flush();
  assert.equal(f.scheduler.status().actors[0].failures, 0);
  assert.equal(f.scheduler.status().actors[0].nextRunAt, 1500);
  assert.deepEqual(f.errors, []);
  f.time(1500); f.scheduler.tick(); await flush(); assert.equal(f.calls.length, 3);
  assert.match(f.calls[2].instruction, /goal-blocked/);
});

test('real continuation timers respect the active lock, available slots, and due-date fairness', async t => {
  const f = fixture({ now: Date.now, pollMs: 60000, maxConcurrent: 1, continuityCooldownMs: 20 });
  t.after(() => f.cleanup()); f.actors.splice(2);
  f.scheduler.start(); await eventually(() => f.calls.length === 1, 'The first real-time dispatch may cross a clock tick.');
  assert.equal(f.calls[0].name, 'A');
  f.scheduler.wake('A', { type: 'planning-needed', intentVersion: 1 });
  await delay(40);
  assert.equal(f.calls.length, 1, 'The same NPC cannot overlap even after the continuation deadline.');
  f.calls[0].pending.resolve({ status: 'completed' }); await flush();
  await eventually(() => f.calls.length === 2, 'A freed slot starts the actor already waiting longest.');
  assert.equal(f.calls[1].name, 'B');
  await delay(40); assert.equal(f.calls.length, 2, 'A due continuation cannot exceed maxConcurrent.');
  f.calls[1].pending.resolve({ status: 'completed' }); await flush();
  await eventually(() => f.calls.length === 3, 'The pending continuation receives the next available slot.');
  assert.equal(f.calls[2].name, 'A');
  assert.match(f.calls[2].instruction, /planning-needed/);
  assert.equal(f.scheduler.status().activeTasks, 1);
});

test('stopping clears real continuation deadlines and a late active result cannot restart work', async t => {
  const f = fixture({ now: Date.now, pollMs: 60000, continuityCooldownMs: 20 });
  t.after(() => f.cleanup()); f.actors.splice(1);
  f.scheduler.start(); await eventually(() => f.calls.length === 1, 'Wait for the real dispatch before resolving its result.');
  f.calls[0].pending.resolve({ status: 'completed' }); await flush();
  f.scheduler.wake('A', { type: 'goal-finished', intentVersion: 1 });
  await f.scheduler.stop();
  await delay(50);
  assert.equal(f.calls.length, 1, 'A due timer must not outlive stop.');
  f.scheduler.start(); await eventually(() => f.calls.length === 2, 'The restarted real-time scheduler dispatches once.');
  assert.equal(f.calls.length, 2);
  f.scheduler.wake('A', { type: 'goal-blocked', intentVersion: 2 });
  await f.scheduler.stop();
  f.calls[1].pending.resolve({ status: 'cancelled', reason: 'body-replan' }); await flush();
  f.scheduler.wake('A', { type: 'planning-needed', intentVersion: 2 });
  await delay(50);
  assert.equal(f.calls.length, 2, 'A late result and new event cannot revive a stopped scheduler.');
  assert.equal(f.scheduler.status().phase, 'stopped');
});

test('continuation events preserve provider backoff and a body-replan label cannot hide a provider error', async t => {
  const f = fixture({ intervalMs: 1000, errorBackoffMs: 10000 }); t.after(() => f.cleanup()); f.actors.splice(1);
  f.scheduler.start(); await flush();
  f.scheduler.wake('A', { type: 'goal-blocked', intentVersion: 1, receiptId: 7 });
  f.calls[0].pending.reject(new Error('provider unavailable')); await flush();
  assert.equal(f.scheduler.status().actors[0].nextRunAt, 11000);
  f.time(2000); f.scheduler.wake('A', { type: 'planning-needed', intentVersion: 1 });
  f.scheduler.tick(); await flush(); assert.equal(f.calls.length, 1);
  assert.equal(f.scheduler.status().actors[0].nextRunAt, 11000);
  f.time(11000); f.scheduler.tick(); await flush();
  assert.match(f.calls[1].instruction, /goal-blocked/);
  assert.match(f.calls[1].instruction, /planning-needed/);
  f.calls[1].pending.resolve({ status: 'cancelled', reason: 'body-replan', error: 'provider failure' }); await flush();
  assert.equal(f.scheduler.status().actors[0].failures, 2);
  assert.equal(f.scheduler.status().actors[0].nextRunAt, 31000);
});

test('the same-code baseline ignores planning hints and retains ordinary goal, chat, and heartbeat waits', async t => {
  const f = fixture({ continuityEnabled: false, intervalMs: 10000 }); t.after(() => f.cleanup()); f.actors.splice(1);
  f.scheduler.start(); await flush();
  f.calls[0].pending.resolve({ status: 'completed' }); await flush();
  assert.equal(f.scheduler.status().actors[0].nextRunAt, 11000);
  f.time(1200); f.scheduler.wake('A', { type: 'planning-needed', intentVersion: 1 });
  assert.equal(f.scheduler.status().pendingEvents, 0);
  assert.equal(f.scheduler.status().actors[0].nextRunAt, 11000);
  f.scheduler.wake('A', { type: 'goal-finished', intentVersion: 1 });
  f.scheduler.wake('A', { type: 'goal-blocked', intentVersion: 1, receiptId: 7 });
  assert.equal(f.scheduler.status().actors[0].nextRunAt, 5000);
  f.time(4999); f.scheduler.tick(); await flush(); assert.equal(f.calls.length, 1);
  f.time(5000); f.scheduler.tick(); await flush(); assert.equal(f.calls.length, 2);
  f.scheduler.wake('A', { type: 'heard', speaker: 'Human', message: '继续' });
  f.calls[1].pending.resolve({ status: 'completed' }); await flush();
  assert.equal(f.scheduler.status().actors[0].nextRunAt, 13000);
  f.time(13000); f.scheduler.tick(); await flush(); assert.equal(f.calls.length, 3);
  f.calls[2].pending.resolve({ status: 'completed' }); await flush();
  assert.equal(f.scheduler.status().actors[0].nextRunAt, 23000);
});

test('continuity keeps human chat, ordinary heartbeat, and intent expiry on their existing cadence', async t => {
  const f = fixture({ intervalMs: 10000 }); t.after(() => f.cleanup()); f.actors.splice(1);
  f.scheduler.start(); await flush();
  f.scheduler.wake('A', { type: 'heard', speaker: 'Human', message: '继续' });
  f.calls[0].pending.resolve({ status: 'completed' }); await flush();
  assert.equal(f.scheduler.status().actors[0].nextRunAt, 9000);
  f.time(9000); f.scheduler.tick(); await flush();
  f.calls[1].pending.resolve({ status: 'completed' }); await flush();
  assert.equal(f.scheduler.status().actors[0].nextRunAt, 19000);
  f.scheduler.wake('A', { type: 'intent-expired', intentVersion: 1 });
  assert.equal(f.scheduler.status().actors[0].nextRunAt, 13000, 'Expiry is an ordinary perception, never fresh authorization.');
  assert.deepEqual(f.cancelled, []);
});

test('terminal work completion uses ordinary event cooldown and is still delivered on the next scheduled turn', async t => {
  const f = fixture({ intervalMs: 10000 }); t.after(() => f.cleanup()); f.actors.splice(1);
  f.scheduler.start(); await flush();
  f.calls[0].pending.resolve({ status: 'completed' }); await flush();
  f.time(1100); f.scheduler.wake('A', { type: 'goal-finished', terminal: true, intentVersion: 1 });
  assert.equal(f.scheduler.status().pendingEvents, 1);
  assert.equal(f.scheduler.status().actors[0].nextRunAt, 5000);
  f.time(1350); f.scheduler.tick(); await flush(); assert.equal(f.calls.length, 1);
  f.time(4999); f.scheduler.tick(); await flush(); assert.equal(f.calls.length, 1);
  f.time(5000); f.scheduler.tick(); await flush(); assert.equal(f.calls.length, 2);
  assert.match(f.calls[1].instruction, /goal-finished/); assert.match(f.calls[1].instruction, /terminal/);
  assert.deepEqual(f.cancelled, []);
});

test('terminal completion queued during active thinking cannot force an immediate continuation after that turn', async t => {
  const f = fixture({ intervalMs: 10000 }); t.after(() => f.cleanup()); f.actors.splice(1);
  f.scheduler.start(); await flush();
  f.time(1100); f.scheduler.wake('A', { type: 'goal-finished', terminal: true, intentVersion: 1 });
  f.time(1500); f.calls[0].pending.resolve({ status: 'completed' }); await flush();
  assert.equal(f.scheduler.status().actors[0].nextRunAt, 5500);
  f.time(1750); f.scheduler.tick(); await flush(); assert.equal(f.calls.length, 1);
  f.time(5500); f.scheduler.tick(); await flush(); assert.equal(f.calls.length, 2);
});

for (const type of ['planning-needed', 'goal-blocked', 'hurt']) {
  test(`a terminal completion cannot delay a subsequent important ${type} event`, async t => {
    const f = fixture({ intervalMs: 10000 }); t.after(() => f.cleanup()); f.actors.splice(1);
    f.scheduler.start(); await flush(); f.calls[0].pending.resolve({ status: 'completed' }); await flush();
    f.time(1100); f.scheduler.wake('A', { type: 'goal-finished', terminal: true, intentVersion: 1 });
    f.time(1200); f.scheduler.wake('A', { type, intentVersion: 1, receiptId: 2, healthBefore: 20, health: 18 });
    const due = f.scheduler.status().actors[0].nextRunAt;
    assert.ok(due <= 2200, 'The important event keeps its own bounded cooldown/merge rule.');
    f.time(due); f.scheduler.tick(); await flush(); assert.equal(f.calls.length, 2);
    assert.match(f.calls[1].instruction, new RegExp(type)); assert.match(f.calls[1].instruction, /goal-finished/);
    assert.deepEqual(f.cancelled, []);
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { WorldMemory } from '../packages/npc-core/src/world-memory.ts';
import { loadWorldPersona } from '../packages/npc-core/src/world-persona.ts';
import { runWorldAgent, type WorldAgentPort, type WorldPerceptionEvent } from '../packages/pi-runtime/src/world-agent.ts';

const call = (name: string, args: any) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
const done = () => fauxAssistantMessage(fauxText('继续当前工作。'), { stopReason: 'stop' });
const append = (expectedVersion: number) => ({ expectedVersion, steps: [{ type: 'wait', ms: 100 }] });
const remember = () => call('remember', { text: '根据当前身体进度准备后续工作。', category: 'note' });
function runtime(responses: any[]) {
  const models = createModels(), faux = fauxProvider(); models.setProvider(faux.provider); faux.setResponses(responses);
  return { models, model: faux.getModel(), apiKey: undefined as any, source: 'test' };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function flush() { for (let index = 0; index < 12; index++) await Promise.resolve(); }
function requestState(context: any) {
  const block = /<本次请求身体状态>\n([\s\S]*?)\n<\/本次请求身体状态>/u.exec(context.systemPrompt)?.[1];
  assert.ok(block);
  return JSON.parse(block.split('\n').find(line => line.startsWith('{'))!);
}
function userMessages(context: any) { return context.messages.filter((message: any) => message.role === 'user'); }
function runningControl(version = 1) {
  return { version, stopped: false, disposed: false, phase: 'running', planningNeeded: false, remainingSteps: 3,
    intent: { id: 'same-intent', version, expiresAt: Date.now() + 60000,
      goal: { steps: [{ type: 'wait', ms: 100 }] }, allowedReactions: ['surface'] },
    current: { id: 10, intentId: 'same-intent', intentVersion: version, phase: 'running', action: 'wait' } };
}
function failure(version = 1, receiptId = 7) {
  return { intentVersion: version, stepIndex: 0, receiptId, code: 'no_path', reason: '本次路径尝试受阻。' };
}
const blockedEvent = (overrides: any = {}) => ({ type: 'goal-blocked', npcId: 'Sheldon', intentId: 'same-intent', ...failure(), ...overrides });
const planningEvent = (overrides: any = {}) => ({ type: 'planning-needed', npcId: 'Sheldon', intentId: 'same-intent', intentVersion: 1,
  remainingSteps: 1, planningNeeded: true, reason: 'steps-low', ...overrides });

async function fixture(t: any, initial: any = runningControl()) {
  const root = await mkdtemp(join(tmpdir(), 'anima-continuity-'));
  t.after(async () => { assert.ok(root.startsWith(join(tmpdir(), 'anima-continuity-'))); await rm(root, { recursive: true, force: true }); });
  const memory = await WorldMemory.open(root, 'Sheldon', 'sheldon'), persona = await loadWorldPersona(root, 'sheldon');
  let live = structuredClone(initial), readStatus = () => structuredClone(live), reads = 0, interrupts = 0;
  const submitted: any[] = [], appended: any[] = [], cancelled: number[] = [], executed: any[] = [];
  const listeners = new Set<(event: WorldPerceptionEvent) => void>();
  const port: WorldAgentPort = { name: 'Sheldon', persona: 'test', roleId: 'sheldon',
    observe: () => ({ health: 20, food: 20, inventory: [], recentEvents: [], control: structuredClone(live) }),
    execute: async action => { executed.push(action); return { id: `direct-${executed.length}`, status: 'completed', action }; },
    interruptAction: () => { interrupts++; },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    body: {
      status: () => { reads++; return readStatus(); },
      submit: request => { submitted.push(structuredClone(request)); return { accepted: true, version: live.version }; },
      append: request => {
        appended.push(structuredClone(request));
        if (request.expectedVersion !== live.version) return { accepted: false, version: live.version, reason: 'stale_version' };
        if (live.stopped) return { accepted: false, version: live.version, reason: 'stopped' };
        live = { ...live, version: live.version + 1,
          intent: { ...live.intent, version: live.version + 1, goal: { ...live.intent.goal, steps: [...live.intent.goal.steps, ...request.steps] } } };
        return { accepted: true, version: live.version, control: structuredClone(live) };
      },
      cancel: version => { cancelled.push(version); return { accepted: true, version: live.version }; },
    },
  };
  return { memory, persona, port, goalReview: false, instruction: '结合自身实际执行进度继续工作。', timeoutMs: 3000,
    submitted, appended, cancelled, executed,
    setControl: (control: any) => { live = structuredClone(control); }, control: () => live,
    setStatus: (read: () => any) => { readStatus = read; }, reads: () => reads, interrupts: () => interrupts,
    emit: (event: any) => { for (const listener of listeners) listener(event); }, subscriptions: () => listeners.size };
}

test('body_append uses the request-observed version, then a later request may append at the acknowledged version', async t => {
  const f = await fixture(t);
  const result = await runWorldAgent({ ...f, runtime: runtime([
    (context: any) => {
      assert.ok(context.tools.some((tool: any) => tool.name === 'body_append'));
      assert.equal(requestState(context).control.version, 1);
      return fauxAssistantMessage([fauxToolCall('body_append', append(1)), fauxToolCall('body_append', append(2))], { stopReason: 'toolUse' });
    },
    (context: any) => { assert.equal(requestState(context).control.version, 2); return call('body_append', append(2)); }, done(),
  ]) });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.toolTrace.map(row => row.status), ['accepted', 'rejected', 'accepted']);
  assert.deepEqual(f.appended.map(request => request.expectedVersion), [1, 2], 'A guessed version in the first batch never reaches the authority.');
  assert.equal(f.control().current.id, 10); assert.equal(f.control().current.intentVersion, 1);
  assert.equal(f.control().intent.id, 'same-intent');
  assert.deepEqual(f.submitted, []); assert.deepEqual(f.cancelled, []); assert.deepEqual(f.executed, []);
});

for (const expectedVersion of [1, 2]) test(`body_append rejects ${expectedVersion === 1 ? 'stale' : 'unobserved future'} authorization after a generation-time version change`, async t => {
  const f = await fixture(t);
  const result = await runWorldAgent({ ...f, runtime: runtime([
    () => { f.setControl({ ...runningControl(2), stopped: true, phase: 'stopped' }); return call('body_append', append(expectedVersion)); }, done(),
  ]) });
  assert.equal(result.toolTrace[0].status, 'rejected');
  assert.deepEqual(f.appended.map(request => request.expectedVersion), expectedVersion === 1 ? [1] : []);
  assert.equal(f.control().stopped, true); assert.deepEqual(f.cancelled, []);
});

test('body_append never coerces fractional or string ownership versions', async t => {
  const f = await fixture(t);
  const result = await runWorldAgent({ ...f, runtime: runtime([
    fauxAssistantMessage([fauxToolCall('body_append', { ...append(1), expectedVersion: 1.5 }),
      fauxToolCall('body_append', { ...append(1), expectedVersion: '1' })], { stopReason: 'toolUse' }), done(),
  ]) });
  assert.equal(result.status, 'completed'); assert.deepEqual(f.appended, []); assert.equal(f.control().version, 1);
});

test('a planning hint is coalesced into one steering message without aborting generation or the body', async t => {
  const f = await fixture(t); let requests = 0;
  const result = await runWorldAgent({ ...f, runtime: runtime([
    async (_context: any, options: any) => {
      requests++; f.setControl({ ...f.control(), planningNeeded: true, remainingSteps: 1 });
      for (let i = 0; i < 40; i++) f.emit(planningEvent({ id: `planning-${i}` }));
      await flush(); assert.equal(options.signal.aborted, false); return done();
    },
    (context: any, options: any) => {
      requests++; assert.equal(userMessages(context).length, 2);
      assert.equal(requestState(context).control.planningNeeded, true);
      assert.equal(options.signal.aborted, false);
      f.emit(planningEvent({ id: 'same-hint-later' })); return done();
    },
  ]) });
  assert.equal(result.status, 'completed'); assert.equal(requests, 2); assert.equal(result.turns, 2);
  assert.deepEqual(f.cancelled, []); assert.equal(f.interrupts(), 0); assert.deepEqual(f.appended, []);
  assert.equal(f.subscriptions(), 0);
});

test('distinct planning hints have a fixed steering limit within one reasoning task', async t => {
  const f = await fixture(t); let requests = 0;
  const result = await runWorldAgent({ ...f, runtime: runtime(Array.from({ length: 8 }, () => () => {
    requests++;
    const remainingSteps = 12 - requests;
    f.setControl({ ...f.control(), planningNeeded: true, remainingSteps });
    f.emit(planningEvent({ remainingSteps, reason: 'lease-low' })); return done();
  })) });
  assert.equal(result.status, 'completed'); assert.equal(requests, 5, 'At most four hints may extend one task.');
  assert.deepEqual(f.appended, []); assert.deepEqual(f.cancelled, []);
});

for (const stale of ['version', 'stopped', 'expired', 'no-intent']) test(`a planning hint cannot steer a ${stale} authorization`, async t => {
  const f = await fixture(t);
  const result = await runWorldAgent({ ...f, runtime: runtime([
    () => {
      const control: any = { ...f.control(), planningNeeded: true, remainingSteps: 1 };
      if (stale === 'version') control.version = 2;
      if (stale === 'stopped') control.stopped = true;
      if (stale === 'expired') control.intent.expiresAt = Date.now() - 1;
      if (stale === 'no-intent') delete control.intent;
      f.setControl(control); f.emit(planningEvent()); return done();
    },
  ]) });
  assert.equal(result.status, 'completed'); assert.equal(result.turns, 1);
  assert.deepEqual(f.submitted, []); assert.deepEqual(f.appended, []); assert.deepEqual(f.cancelled, []);
});

test('a new verified body failure yields only reasoning after its async status read confirms the receipt', async t => {
  const f = await fixture(t), gate = deferred<any>(); let checked = 0;
  const result = await runWorldAgent({ ...f, runtime: runtime([
    async (_context: any, options: any) => {
      const blocked = { ...f.control(), replanRequired: failure() }; f.setControl(blocked);
      f.setStatus(() => { checked++; return gate.promise; });
      f.emit(blockedEvent()); f.emit(blockedEvent({ id: 'duplicate' }));
      await flush(); assert.equal(checked, 1); assert.equal(options.signal.aborted, false);
      gate.resolve(blocked); await flush(); assert.equal(options.signal.aborted, true); return done();
    },
  ]) });
  assert.equal(result.status, 'cancelled'); assert.equal(result.reason, 'body-replan'); assert.equal(result.error, undefined);
  assert.deepEqual(result.bodyReplan, { intentVersion: 1, receiptId: 7, code: 'no_path' });
  assert.deepEqual(f.cancelled, []); assert.equal(f.interrupts(), 0); assert.equal(f.control().stopped, false);
  assert.equal(f.subscriptions(), 0);
});

for (const mismatch of ['actor', 'version', 'receipt', 'intent', 'stopped']) test(`a goal-blocked event with a mismatched ${mismatch} cannot abort the current brain`, async t => {
  const f = await fixture(t);
  const result = await runWorldAgent({ ...f, runtime: runtime([
    async (_context: any, options: any) => {
      f.setControl({ ...f.control(), replanRequired: failure(), ...(mismatch === 'stopped' ? { stopped: true } : {}) });
      f.emit(blockedEvent(mismatch === 'actor' ? { npcId: 'Sherlock' } : mismatch === 'version' ? { intentVersion: 0 }
        : mismatch === 'receipt' ? { receiptId: 6 } : mismatch === 'intent' ? { intentId: 'other-intent' } : {}));
      await flush(); assert.equal(options.signal.aborted, false); return done();
    },
  ]) });
  assert.equal(result.status, 'completed'); assert.deepEqual(f.cancelled, []); assert.equal(result.bodyReplan, undefined);
});

test('a previously observed failure leaves its repair reasoning active', async t => {
  const f = await fixture(t, { ...runningControl(), replanRequired: failure() });
  const result = await runWorldAgent({ ...f, runtime: runtime([
    async (context: any, options: any) => {
      assert.equal(requestState(context).control.replanRequired.receiptId, 7);
      f.emit(blockedEvent()); await flush(); assert.equal(options.signal.aborted, false); return done();
    },
  ]) });
  assert.equal(result.status, 'completed'); assert.equal(result.bodyReplan, undefined); assert.deepEqual(f.cancelled, []);
});

test('an old asynchronous failure snapshot cannot abort a newer already-observed authorization', async t => {
  const f = await fixture(t), gate = deferred<any>(); let delayed = true;
  const oldBlocked = { ...runningControl(), replanRequired: failure() };
  const result = await runWorldAgent({ ...f, runtime: runtime([
    async () => {
      f.setStatus(() => { if (delayed) { delayed = false; return gate.promise; } return structuredClone(f.control()); });
      f.emit(blockedEvent()); await flush(); f.setControl(runningControl(2)); return remember();
    },
    async (context: any, options: any) => {
      assert.equal(requestState(context).control.version, 2);
      gate.resolve(oldBlocked); await flush(); assert.equal(options.signal.aborted, false); return done();
    },
  ]) });
  assert.equal(result.status, 'completed'); assert.equal(result.bodyReplan, undefined); assert.equal(f.control().version, 2);
  assert.deepEqual(f.cancelled, []);
});

test('cancellation does not wait for a pending planning-notice status refresh', async t => {
  const f = await fixture(t), entered = deferred<void>(), gate = deferred<any>(), controller = new AbortController();
  let requests = 0, settled = false;
  const running = runWorldAgent({ ...f, signal: controller.signal, runtime: runtime([
    () => {
      requests++; f.setControl({ ...f.control(), planningNeeded: true, remainingSteps: 1 });
      f.setStatus(() => { entered.resolve(); return gate.promise; });
      f.emit(planningEvent()); return done();
    },
    () => { requests++; return done(); },
  ]) }).finally(() => { settled = true; });
  await entered.promise; controller.abort();
  await Promise.race([running, delay(250)]);
  const drainedBeforeRead = settled;
  gate.resolve(f.control());
  const result = await running;
  assert.equal(drainedBeforeRead, true, 'Stopping a brain must not wait for an unavailable body.status reader.');
  assert.equal(result.status, 'cancelled'); assert.equal(requests, 1);
  assert.deepEqual(f.cancelled, []); assert.equal(f.subscriptions(), 0);
});

for (const disabled of ['baseline', 'serial', 'unsupported']) test(`${disabled} ports omit body_append and preserve existing event behavior`, async t => {
  const f = await fixture(t);
  if (disabled === 'serial') f.port.body!.executionMode = 'serial';
  if (disabled === 'unsupported') delete f.port.body!.append;
  const result = await runWorldAgent({ ...f, ...(disabled === 'baseline' ? { continuity: false } : {}), runtime: runtime([
    async (context: any, options: any) => {
      assert.equal(context.tools.some((tool: any) => tool.name === 'body_append'), false);
      if (disabled !== 'unsupported') {
        f.setControl({ ...f.control(), planningNeeded: true, remainingSteps: 1, replanRequired: failure() });
        f.emit(planningEvent()); f.emit(blockedEvent()); await flush(); assert.equal(options.signal.aborted, false);
      }
      return done();
    },
  ]) });
  assert.equal(result.status, 'completed'); assert.equal(result.turns, 1); assert.deepEqual(f.appended, []); assert.deepEqual(f.cancelled, []);
});

for (const urgent of ['planningNeeded', 'replanRequired']) test(`initial ${urgent} skips a due goal review and immediately reasons about the body`, async t => {
  const f = await fixture(t, { ...runningControl(), [urgent]: urgent === 'planningNeeded' ? true : failure() });
  for (let i = 0; i < 3; i++) await f.memory.recordProgress(`earlier-${i}`, {
    version: 1, start: { health: 20 }, end: { health: 20 }, actions: {}, checks: [], failures: [],
    blockChanges: 0, inventoryChanges: [], situationChanges: [],
  });
  assert.equal(f.memory.goalReviewDue(), true); let requests = 0;
  const result = await runWorldAgent({ ...f, goalReview: true, runtime: runtime([
    (context: any) => {
      requests++; assert.equal(context.tools.some((tool: any) => tool.name === 'submit_goal_review'), false);
      assert.ok(context.tools.some((tool: any) => tool.name === 'body_append'));
      assert.ok(requestState(context).control[urgent]); return done();
    },
  ]) });
  assert.equal(result.status, 'completed'); assert.equal(result.goalReview, undefined); assert.equal(requests, 1);
  assert.equal(f.memory.goalReviewDue(), true, 'Skipping a review must not consume its checkpoint.');
});

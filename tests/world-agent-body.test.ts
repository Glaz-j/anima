import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { BodyController } from '../packages/bridge/src/body-controller.ts';
import { WorldMemory } from '../packages/npc-core/src/world-memory.ts';
import { loadWorldPersona } from '../packages/npc-core/src/world-persona.ts';
import { compactBodyControl, compactObservation, currentBodyContext, runWorldAgent, type WorldAgentPort } from '../packages/pi-runtime/src/world-agent.ts';
import { describeBuild } from '../adapters/minecraft/src/build-blueprints.ts';

function runtime(responses: any[]) {
  const models = createModels(), faux = fauxProvider(); models.setProvider(faux.provider); faux.setResponses(responses);
  return { models, model: faux.getModel(), apiKey: undefined as any, source: 'test' };
}
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'anima-body-brain-'));
  t.after(async () => { assert.ok(root.startsWith(join(tmpdir(), 'anima-body-brain-'))); await rm(root, { recursive: true, force: true }); });
  const memory = await WorldMemory.open(root, 'Sheldon', 'sheldon'), persona = await loadWorldPersona(root, 'sheldon');
  const submitted: any[] = [], cancelled: number[] = [], actions: any[] = [], started: any[] = [];
  let listener: ((event: any) => void) | undefined, interrupts = 0, completed = false;
  const body = new BodyController<any, any, any>({
    readState: () => ({}), tickMs: 5, switchDelayMs: 0, minRunMs: 0,
    select: (_state, intent) => completed ? { kind: 'complete' } : intent.goal.steps.length
      ? { kind: 'run', key: `skill-${intent.version}`, action: intent.goal.steps[0], priority: 1 } : { kind: 'wait' },
    execute: (action, signal) => {
      const call = { action, signal, finished: false, resolve: (_value: any) => {} }; started.push(call);
      return new Promise(resolve => {
        call.resolve = result => { if (!call.finished) { call.finished = true; resolve(result); } };
        signal.addEventListener('abort', () => call.resolve({ status: 'cancelled' }), { once: true });
      });
    }, halt: () => {},
  });
  body.start(); t.after(() => body.dispose());
  const port: WorldAgentPort = { name: 'Sheldon', persona: 'test', roleId: 'sheldon',
    observe: () => ({ position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, recentEvents: [], control: body.snapshot() }),
    subscribe: callback => { listener = callback; return () => { listener = undefined; }; },
    interruptAction: () => { interrupts++; },
    execute: async action => { actions.push(action); return { status: 'completed', action }; },
    body: {
      status: () => body.snapshot(),
      submit: request => {
        submitted.push(structuredClone(request));
        if (request.expectedVersion !== body.snapshot().version) return { accepted: false, version: body.snapshot().version, reason: 'stale_version' };
        const intent = { version: request.expectedVersion + 1, goal: { steps: request.steps, label: request.label, policy: request.policy },
          allowedReactions: request.reactions ?? [], expiresAt: Date.now() + (request.ttlMs ?? 120000) };
        const result = request.resume ? body.resume(intent) : body.submit(intent); body.tick();
        return { ...result, control: body.snapshot() };
      },
      cancel: version => {
        cancelled.push(version);
        if (version !== body.snapshot().version) return { accepted: false, version: body.snapshot().version, reason: 'stale_version' };
        return body.cancel(version + 1);
      },
    },
  };
  return { root, memory, persona, port, goalReview: false, body, submitted, cancelled, actions, started,
    hurt: () => listener?.({ id: `hurt-${Date.now()}`, type: 'hurt', healthBefore: 20, health: 18 }), interrupts: () => interrupts,
    finish: () => { completed = true; for (const call of started) call.resolve({ status: 'completed' }); },
  };
}
const plan = (expectedVersion = 0) => ({ expectedVersion, label: '去采集木头', steps: [{ type: 'gather', block: 'oak_log', count: 4 }],
  ttlMs: 30000, reactions: ['surface', 'eat'], policy: { retreatHealth: 7, chaseRange: 4 } });
const call = (name: string, args: any) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
const done = () => fauxAssistantMessage(fauxText('继续工作。'), { stopReason: 'stop' });

test('construction blueprint query is read-only and the brain can authorize persistent build work',async t=>{
  const f=await fixture(t);let queries=0;
  f.port.constructionPlan=args=>{queries++;return describeBuild(args);};
  const step={type:'build',blueprint:'village-house',origin:{x:0,y:64,z:0},rotation:90,palette:'spruce'};
  const result=await runWorldAgent({...f,instruction:'建造村屋',runtime:runtime([
    call('construction_plan',{blueprint:step.blueprint,origin:step.origin,rotation:step.rotation,palette:step.palette}),call('body_plan',{...plan(),steps:[step]}),done()])});
  assert.equal(queries,1);
  assert.equal(f.actions.length,0);assert.deepEqual(f.submitted[0].steps,[step]);
  assert.equal(f.started[0].signal.aborted,false);assert.equal(result.actions.length,0);
});

test('compacted building receipts retain partial coverage and outstanding materials',()=>{
  const compact=compactBodyControl({version:1,recentReceipts:[{id:3,status:'failed',result:{action:{type:'build'},
    details:{placed:12,matched:105,total:229,reached:false,stoppedReason:'build_missing_material',missingMaterials:{oak_planks:113}}}}]});
  assert.equal(compact.recentReceipts[0].details.matched,105);
  assert.equal(compact.recentReceipts[0].details.reached,false);
  assert.deepEqual(compact.recentReceipts[0].details.missingMaterials,{oak_planks:113});
});

test('body_plan acknowledges immediately and persistent execution survives the completed reasoning turn', async t => {
  const f = await fixture(t);
  const result = await runWorldAgent({ ...f, instruction: '采集木头', runtime: runtime([call('body_plan', plan()), done()]) });
  assert.equal(result.status, 'completed'); assert.equal(result.toolTrace[0].status, 'accepted');
  assert.equal(f.submitted.length, 1); assert.equal(f.started.length, 1);
  assert.equal(f.started[0].signal.aborted, false); assert.equal(f.started[0].finished, false);
  assert.equal(f.body.snapshot().current?.phase, 'running'); assert.equal(f.actions.length, 0);
  assert.equal(result.actions.length, 0, 'A plan acknowledgment is not a completed world action.');
  assert.ok(f.memory.entries.some(entry => entry.kind === 'intent' && entry.text.includes('接收不代表完成')));
  assert.ok(!f.memory.entries.some(entry => entry.kind === 'fact' && entry.text.includes('自己提交了身体目标')));
});

test('pi body_plan exposes bounded bridge targets and material budget without privileged origin fields', async t => {
  const f = await fixture(t), step = { type: 'bridge', x: 2.5, z: .5, item: 'cobblestone', maxBlocks: 2 };
  const result = await runWorldAgent({ ...f, instruction: '用两块圆石搭桥抵达看见的平台。',
    runtime: runtime([call('body_plan', { ...plan(), steps: [step] }), done()]) });
  assert.equal(result.toolTrace[0].status, 'accepted'); assert.deepEqual(f.submitted[0].steps, [step]);
  assert.equal(f.started[0].signal.aborted, false);
});

test('planner compaction retains cumulative bridge spending and uncertainty while dropping excess details', () => {
  const compact = compactBodyControl({ version: 2, bridgeProgress: [{ step: 0, spent: 2, inventoryConfirmed: false,
    exhausted: true, origin: { x: 1, y: 64, z: 0 }, unused: 'large diagnostic' }] });
  assert.deepEqual(compact.bridgeProgress, [{ step: 0, spent: 2, inventoryConfirmed: false, exhausted: true }]);
});

test('a model timeout and hurt notifications cannot cancel the independently running body', async t => {
  const f = await fixture(t);
  const result = await runWorldAgent({ ...f, instruction: '采集', timeoutMs: 50,
    runtime: runtime([call('body_plan', plan()), async () => { f.hurt(); await delay(100); return done(); }]) });
  assert.equal(result.status, 'cancelled'); assert.equal(result.reason, 'timeout');
  assert.equal(f.started.length, 1); assert.equal(f.started[0].signal.aborted, false);
  assert.equal(f.interrupts(), 0); assert.deepEqual(f.cancelled, []);
  assert.ok(f.body.snapshot().metrics.ticks > 2, 'The actual quick controller runs while the model waits.');
});

test('reasoning budget exhaustion leaves the last accepted goal running', async t => {
  const f = await fixture(t);
  const result = await runWorldAgent({ ...f, instruction: '采集', runtime: runtime([
    call('body_plan', plan()), ...Array.from({ length: 8 }, () => call('body_status', {})),
  ]) });
  assert.equal(result.status, 'incomplete'); assert.equal(result.reason, 'budget');
  assert.equal(f.started[0].signal.aborted, false); assert.equal(f.body.snapshot().intent?.version, 1);
});

test('a delayed plan cannot resurrect an operator-stopped body even with resume=true', async t => {
  const f = await fixture(t);
  const result = await runWorldAgent({ ...f, instruction: '继续', runtime: runtime([async () => {
    await f.body.stop('Operator stopped while the model was thinking.');
    return call('body_plan', { ...plan(), resume: true });
  }, done()]) });
  assert.equal(result.toolTrace[0].status, 'rejected');
  assert.equal(f.submitted[0].expectedVersion, 0, 'Do not silently substitute the fresh version.');
  assert.equal(f.body.snapshot().stopped, true); assert.equal(f.started.length, 0);
});

test('a model cannot guess the version produced by an unseen stop and resume the body', async t => {
  const f = await fixture(t);
  const result = await runWorldAgent({ ...f, instruction: '继续', runtime: runtime([async () => {
    await f.body.stop('Operator stop not observed by this model request.');
    return call('body_plan', { ...plan(1), resume: true });
  }, done()]) });
  assert.equal(result.toolTrace[0].status, 'rejected');
  assert.equal(f.submitted.length, 0); assert.equal(f.body.snapshot().stopped, true);
});

test('a newly observed stopped body can be explicitly resumed by a later informed request', async t => {
  const f = await fixture(t); await f.body.stop('Stopped before this task begins.');
  const result = await runWorldAgent({ ...f, instruction: '重新开始', runtime: runtime([
    call('body_status', {}), call('body_plan', { ...plan(1), resume: true }), done(),
  ]) });
  assert.equal(result.toolTrace[1].status, 'accepted'); assert.equal(f.body.snapshot().stopped, false);
  assert.equal(f.started.length, 1); assert.equal(f.started[0].signal.aborted, false);
});

test('versioned cancellation can revoke its own goal but an old cancellation cannot revoke a newer one', async t => {
  const f = await fixture(t);
  const result = await runWorldAgent({ ...f, instruction: '先采集再撤销', runtime: runtime([
    call('body_plan', plan()), call('cancel_body', { expectedVersion: 0 }),
    call('cancel_body', { expectedVersion: 1 }), done(),
  ]) });
  assert.deepEqual(result.toolTrace.map(row => row.status), ['accepted', 'rejected', 'accepted']);
  assert.equal(f.body.snapshot().version, 2); assert.equal(f.body.snapshot().intent, undefined);
  assert.equal(f.started[0].signal.aborted, true);
});

test('legacy physical actions are single-step intents and a queued old batch cannot overwrite its first accepted step', async t => {
  const f = await fixture(t);
  const result = await runWorldAgent({ ...f, instruction: '行动', runtime: runtime([
    fauxAssistantMessage([fauxToolCall('action', { type: 'equip', item: 'iron_sword' }),
      fauxToolCall('action', { type: 'attack', entityId: 10 })], { stopReason: 'toolUse' }), done(),
  ]) });
  assert.deepEqual(result.toolTrace.map(row => row.status), ['accepted', 'rejected']);
  assert.deepEqual(f.submitted.map(request => request.expectedVersion), [0, 0]);
  assert.equal(f.body.snapshot().intent?.goal.steps[0].type, 'equip');
  assert.equal(f.actions.length, 0);
});

test('read-only queries and speech still use the action port while a persistent skill keeps running', async t => {
  const f = await fixture(t);
  const result = await runWorldAgent({ ...f, instruction: '行动', runtime: runtime([
    call('body_plan', plan()),
    fauxAssistantMessage([fauxToolCall('action', { type: 'recipes', item: 'stick' }),
      fauxToolCall('action', { type: 'say', message: '我在做。' })], { stopReason: 'toolUse' }), done(),
  ]) });
  assert.equal(result.status, 'completed'); assert.deepEqual(f.actions.map(action => action.type), ['recipes', 'say']);
  assert.equal(f.started[0].signal.aborted, false); assert.equal(f.submitted.length, 1);
});

test('malformed and over-budget plans cannot bypass validation or update the body indefinitely', async t => {
  const f = await fixture(t);
  const requests = [call('body_plan', { ...plan(), expectedVersion: .5 }), call('body_plan', { ...plan(), steps: [{ type: 'say', message: '错误' }] }),
    ...Array.from({ length: 7 }, (_, index) => call('body_plan', { ...plan(index), steps: [] }))];
  const result = await runWorldAgent({ ...f, instruction: '行动', runtime: runtime(requests) });
  assert.equal(result.toolTrace[0].status, 'error'); assert.equal(result.toolTrace[1].status, 'error');
  assert.ok(f.submitted.length <= 6); assert.ok(f.submitted.every(request => Number.isInteger(request.expectedVersion)));
});

test('bounded observation and starting context retain ownership version, active goal and skill phase', () => {
  const control = { version: 9, stopped: false, phase: 'running', completedSteps: [0, 1], workCompleted: true, goalStatus: 'completed',
    intent: { id: 'goal', version: 9, expiresAt: 12345, goal: { label: '上岸后采集', steps: Array.from({ length: 12 }, () => ({ type: 'gather', block: 'oak_log', count: 1 })),
      policy: { retreatHealth: 5, eatBelow: 12, chaseRange: 3, threatRange: 6 } }, allowedReactions: ['surface', 'eat'] },
    current: { id: 20, intentVersion: 9, phase: 'draining', skill: { action: { native: { type: 'combat' } }, reaction: 'defend' } },
    recentReceipts: Array.from({ length: 40 }, (_, id) => ({ id, status: 'failed', result: { action: { type: 'gather' }, huge: 'x'.repeat(10000) } })),
    metrics: { raw: 'x'.repeat(100000) } };
  const observation = compactObservation({ control, recentEvents: [] });
  assert.equal(observation.control.version, 9); assert.equal(observation.control.intent.label, '上岸后采集');
  assert.equal(observation.control.intent.stepCount, 12); assert.equal(observation.control.intent.steps.length, 3);
  assert.equal(observation.control.current.action, 'combat'); assert.equal(observation.control.current.phase, 'draining');
  assert.equal(observation.control.recentReceipts.length, 2);
  assert.equal(observation.control.workCompleted, true); assert.equal(observation.control.goalStatus, 'completed');
  assert.ok(Buffer.byteLength(JSON.stringify(observation)) < 4400);
  const context = currentBodyContext(observation, undefined);
  assert.match(context, /"version":9/); assert.match(context, /上岸后采集/); assert.doesNotMatch(context, /xxxxx/);
  assert.deepEqual(compactBodyControl(observation.control), observation.control);
});

function failedLaterStepControl() {
  return { version: 4, stopped: false, phase: 'waiting', workCompleted: false, goalStatus: 'working',
    completedSteps: [0, 1, 2, 3, 4, 5, 6],
    intent: { id: 'long-plan', version: 4, expiresAt: 123456, allowedReactions: ['surface'],
      goal: { label: '根据真实落点继续移动', steps: Array.from({ length: 12 }, (_, index) => index === 7
        ? { type: 'jump_to', x: 10.5, y: 66, z: 2.5, durationMs: 5000 } : { type: 'wait', ms: 100 }),
      policy: { retreatHealth: 6 } } },
    recentReceipts: [
      { id: 20, intentVersion: 4, status: 'cancelled', reason: 'Preempted by emergency.',
        result: { action: { type: 'bridge' }, details: { reached: false, spent: 2, placed: 2, inventoryConfirmed: false,
          unrelatedDebug: 'do-not-include-private-diagnostics'.repeat(500) } } },
      { id: 21, intentVersion: 4, status: 'failed', finishedAt: 1234,
        result: { action: { type: 'jump_to' }, error: '此技能只接受3.6格内且高差不超过1格的单跳。' + '附加诊断'.repeat(1000),
          details: { stoppedReason: 'jump_out_of_range', reached: false, landed: false, shoreReached: false,
            killConfirmed: false, spent: 0, inventoryConfirmed: true,
            unrelatedDebug: 'do-not-include-private-diagnostics'.repeat(500) } } },
    ] };
}

test('compacted receipts preserve native failure reasons and actual results through repeated observation compression', () => {
  const raw = failedLaterStepControl();
  const control = compactBodyControl(raw), observation = compactObservation({ control: raw, recentEvents: [] });
  assert.deepEqual(control, observation.control);
  assert.deepEqual(compactBodyControl(control), control, 'Repeated context construction must not erase flattened native errors.');
  assert.equal(control.recentReceipts[0].reason, 'Preempted by emergency.');
  assert.deepEqual(control.recentReceipts[0].details, { reached: false, inventoryConfirmed: false, spent: 2, placed: 2 });
  const failed = control.recentReceipts[1];
  assert.match(failed.error, /高差不超过1格/); assert.ok(failed.error.length <= 180);
  assert.equal(failed.stoppedReason, 'jump_out_of_range');
  assert.deepEqual(failed.details, { reached: false, landed: false, shoreReached: false, killConfirmed: false,
    inventoryConfirmed: true, spent: 0 });
  assert.ok(Buffer.byteLength(JSON.stringify(observation)) < 4400);
  const context = currentBodyContext(observation, undefined);
  assert.match(context, /jump_out_of_range/); assert.match(context, /高差不超过1格/);
  assert.doesNotMatch(context, /do-not-include-private-diagnostics/);
});

test('the next incomplete original step survives a long plan prefix and repeated context compression', () => {
  const raw = failedLaterStepControl(), compact = compactBodyControl(raw);
  assert.equal(compact.intent.steps.length, 3); assert.equal(compact.intent.stepCount, 12);
  assert.deepEqual(compact.intent.nextStep, { index: 7, action: raw.intent.goal.steps[7] });
  const again = compactObservation({ control: compact, recentEvents: [] }).control;
  assert.deepEqual(again.intent.nextStep, compact.intent.nextStep);
  assert.deepEqual(again, compact);
  assert.match(currentBodyContext({ control: again }, undefined), /"nextStep":\{"index":7/);
  assert.equal(compactBodyControl({ ...raw, completedSteps: Array.from({ length: 12 }, (_, index) => index),
    workCompleted: true, goalStatus: 'completed' }).intent.nextStep, undefined);
});

test('the actual body_status model exchange includes failed native work, current pending step and bounded skill contracts', async t => {
  const f = await fixture(t), control = failedLaterStepControl();
  f.port.body!.status = () => control;
  f.port.observe = () => ({ position: { x: 8.5, y: 64, z: 2.5 }, health: 20, food: 20, control, recentEvents: [] });
  let checked = false;
  const result = await runWorldAgent({ ...f, instruction: '先检查失败原因，再判断下一步。', runtime: runtime([
    (context: any) => {
      const tool = context.tools.find((entry: any) => entry.name === 'body_plan');
      assert.match(tool.description, /水平距离≤3\.6格/); assert.match(tool.description, /垂直高差绝对值≤1格/);
      const skills = tool.parameters.properties.steps.items.anyOf;
      const jump = skills.find((schema: any) => schema.properties?.type?.const === 'jump_to');
      const bridge = skills.find((schema: any) => schema.properties?.type?.const === 'bridge');
      assert.match(jump.description, /脚部落点/); assert.match(jump.description, /支撑和身体空间/);
      assert.match(bridge.description, /同高度水平目标/); assert.match(bridge.description, /不会造楼梯或爬升/);
      return call('body_status', {});
    },
    (context: any) => {
      const receipt = context.messages.findLast((message: any) => message.role === 'toolResult');
      const body = JSON.parse(receipt.content.find((part: any) => part.type === 'text').text).control;
      assert.equal(body.intent.nextStep.index, 7); assert.equal(body.intent.nextStep.action.y, 66);
      assert.equal(body.recentReceipts[1].status, 'failed');
      assert.match(body.recentReceipts[1].error, /高差不超过1格/);
      assert.equal(body.recentReceipts[1].stoppedReason, 'jump_out_of_range');
      assert.equal(body.recentReceipts[1].details.reached, false);
      checked = true; return done();
    },
  ]) });
  assert.equal(result.status, 'completed'); assert.equal(checked, true);
  assert.equal(f.submitted.length, 0, 'Observing the failure must not replay or rewrite the body plan.');
});

function actualBodyReceipt(id: string, type: string, details: any, extra: any = {}) {
  return { id: 1, key: 'intent:step-0:action', intentId: 'original-body-goal', intentVersion: 1,
    status: 'completed', startedAt: 10, finishedAt: 20,
    result: { id, status: 'completed', action: { type }, details }, ...extra };
}

test('async body results reach the next model request and persistent progress once across all delivery paths and restart', async t => {
  const f = await fixture(t);
  const receipt = actualBodyReceipt('bridge-real-uuid', 'bridge', { placed: 2, spent: 2, reached: true,
    inventoryConfirmed: true, inventoryDelta: [{ item: 'cobblestone', change: -2 }] });
  let listener: ((event: any) => void) | undefined;
  const control: any = { version: 1, phase: 'watching', recentReceipts: [] };
  const event = { id: 'body-event-1', type: 'skill-finished', npcId: 'Sheldon', controlEvent: { receipt } };
  let events: any[] = [];
  f.port.subscribe = receive => { listener = receive; return () => { listener = undefined; }; };
  f.port.body!.status = () => control;
  f.port.observe = () => ({ position: { x: 2, y: 64, z: 0 }, health: 20, food: 20,
    inventory: [{ name: 'cobblestone', count: 3 }], control, recentEvents: events });
  let checked = false;
  const result = await runWorldAgent({ ...f, instruction: '核对实际工作', runtime: runtime([
    () => { control.recentReceipts = [receipt]; events = [event]; listener?.(event); listener?.(event); return call('body_status', {}); },
    (context: any) => {
      assert.match(context.systemPrompt, /<新接收的身体执行回执>/);
      assert.match(context.systemPrompt, /"blockChanges":2/);
      assert.match(context.systemPrompt, /bridge-real-uuid/);
      checked = true; return call('observe', {});
    }, done(),
  ]) });
  assert.equal(result.status, 'completed'); assert.equal(checked, true); assert.equal(result.actions.length, 1);
  const progress = f.memory.recentProgress(1)[0];
  assert.deepEqual(progress.actions, { bridge: 1 }); assert.equal(progress.blockChanges, 2);
  assert.deepEqual(progress.inventoryChanges, [{ item: 'cobblestone', change: -2 }]);
  assert.equal(progress.end.inventory?.cobblestone, 3, 'A delayed delta must not be applied twice to an already current observation.');
  assert.equal(progress.actionReceipts?.length, 1); assert.equal(progress.actionReceipts![0].intentVersion, 1);
  assert.equal(f.memory.entries.filter(entry => entry.sourceId === 'action:bridge-real-uuid').length, 1);
  const memory = await WorldMemory.open(f.root, 'Sheldon', 'sheldon');
  const second = await runWorldAgent({ ...f, memory, instruction: '重新观察', runtime: runtime([done()]) });
  assert.equal(second.actions.length, 0); assert.equal(memory.recentProgress(1)[0].blockChanges, 0);
  assert.equal(memory.entries.filter(entry => entry.sourceId === 'action:bridge-real-uuid').length, 1);
  assert.equal(listener, undefined);
});

test('cancelled old-version work preserves confirmed partial effects and failure cause without progressing a new goal', async t => {
  const f = await fixture(t);
  await f.memory.rememberIntent('现在先恢复体力', 'goal');
  const originalGoal = f.memory.currentIntent().goal;
  const partial = actualBodyReceipt('cancelled-old-bridge', 'bridge', {}, { status: 'cancelled', intentVersion: 3,
    reason: 'Intent replaced.', result: { id: 'cancelled-old-bridge', action: { type: 'bridge' }, status: 'cancelled',
      error: '旧授权已撤销，保留实际放置', details: { placed: 2, reached: false, inventoryConfirmed: false,
        inventoryDelta: [{ item: 'cobblestone', change: -9 }], stoppedReason: 'cancelled' } } });
  const mined = actualBodyReceipt('cancelled-old-gather', 'gather', {}, { status: 'cancelled', intentVersion: 3,
    reason: 'Intent replaced.', result: { id: 'cancelled-old-gather', action: { type: 'gather' }, status: 'completed',
      details: { minedBlocks: 1, inventoryConfirmed: true, inventoryDelta: [{ item: 'oak_log', change: 1 }] } } });
  const control = { version: 4, phase: 'running', completedSteps: [], workCompleted: false,
    intent: { id: 'new-body-goal', version: 4, goal: { steps: [{ type: 'eat' }] }, allowedReactions: [] },
    recentReceipts: [partial, mined] };
  f.port.body!.status = () => control;
  f.port.observe = () => ({ health: 20, food: 12, inventory: [{ name: 'oak_log', count: 1 }], control, recentEvents: [] });
  const result = await runWorldAgent({ ...f, instruction: '检查身体进度', runtime: runtime([done()]) });
  assert.equal(result.status, 'completed');
  const progress = f.memory.recentProgress(1)[0];
  assert.equal(progress.blockChanges, 3, 'Confirmed terrain changes remain real despite cancellation and unknown inventory.');
  assert.deepEqual(progress.inventoryChanges, [{ item: 'oak_log', change: 1 }]);
  assert.equal(progress.actionReceipts?.length, 2);
  assert.ok(progress.actionReceipts!.every(row => row.intentVersion === 3 && row.status === 'cancelled'));
  assert.equal(progress.actionReceipts![1].nativeStatus, 'completed');
  assert.equal(result.actions[1].status, 'completed'); assert.equal(result.actions[1].bodyIntent.controlStatus, 'cancelled');
  const lateFact = f.memory.entries.find(entry => entry.sourceId === 'action:cancelled-old-gather')!;
  assert.match(lateFact.text, /"controlStatus":"cancelled"/); assert.match(lateFact.text, /不表示当前目标或步骤完成/);
  assert.match(progress.failures.join('\n'), /旧授权已撤销/);
  assert.equal(f.memory.currentIntent().goal?.id, originalGoal?.id);
  assert.equal(control.workCompleted, false); assert.deepEqual(control.completedSteps, []);
  assert.deepEqual(f.submitted, []); assert.deepEqual(f.cancelled, []);
});

test('serial submit control returns a genuine failed skill to progress while the command acknowledgment stays uncompleted', async t => {
  const f = await fixture(t); f.port.body!.executionMode = 'serial';
  const failed = actualBodyReceipt('serial-failed-jump', 'jump_to', {}, { status: 'failed',
    result: { id: 'serial-failed-jump', status: 'failed', action: { type: 'jump_to' }, error: '实际落点没有支撑',
      details: { stoppedReason: 'landing_unavailable', reached: false, landed: false } } });
  f.port.body!.submit = () => ({ accepted: true, version: 2,
    control: { version: 2, phase: 'idle', recentReceipts: [failed] } });
  let checked = false;
  const result = await runWorldAgent({ ...f, instruction: '尝试自己选择的动作', runtime: runtime([
    (context: any) => {
      assert.match(context.systemPrompt, /失败撤销剩余步骤交回规划/);
      assert.match(context.tools.find((tool: any) => tool.name === 'body_plan').description, /完成、失败、授权到期或取消/);
      return call('body_plan', { ...plan(), steps: [{ type: 'jump_to', x: 1, y: 64, z: 0 }], reactions: [] });
    },
    (context: any) => {
      const value = JSON.parse(context.messages.findLast((message: any) => message.role === 'toolResult').content[0].text);
      assert.equal(value.accepted, true); assert.equal(value.completed, false);
      assert.match(context.systemPrompt, /landing_unavailable/); assert.match(context.systemPrompt, /实际落点没有支撑/);
      checked = true; return done();
    },
  ]) });
  assert.equal(result.status, 'completed'); assert.equal(checked, true);
  assert.deepEqual(f.memory.recentProgress(1)[0].actions, { jump_to: 1 });
  assert.equal(f.memory.recentProgress(1)[0].actionReceipts![0].status, 'failed');
});

test('goal review sees newly caught-up body results before this reasoning turn is persisted', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 3; i++) await f.memory.recordProgress(`idle-${i}`, { version: 1,
    start: { inventory: {} }, end: { inventory: {} }, actions: {}, checks: [], failures: [], blockChanges: 0,
    inventoryChanges: [], situationChanges: [] });
  const placed = actualBodyReceipt('between-turn-bridge', 'bridge', { placed: 5, spent: 5, reached: true, inventoryConfirmed: true });
  const failed = actualBodyReceipt('between-turn-jump', 'jump_to', {}, { status: 'failed',
    result: { id: 'between-turn-jump', status: 'failed', action: { type: 'jump_to' }, error: '高差超过技能限制',
      details: { stoppedReason: 'jump_out_of_range', reached: false, landed: false } } });
  f.port.observe = () => ({ health: 20, food: 20, inventory: [], control: { version: 2, recentReceipts: [], phase: 'running',
    remainingWorkMs: 60000, planningHorizonMs: 15000, planningNeeded: false,
    intent: { id: 'buffered-work', version: 2, expiresAt: Date.now() + 120000,
      goal: { steps: [{ type: 'gather', block: 'oak_log', count: 16 }] }, allowedReactions: [] } },
    recentEvents: [placed, failed].map((receipt, index) => ({ id: `caught-up-${index}`, type: 'skill-finished',
      npcId: 'Sheldon', controlEvent: { receipt } })) });
  let reviewed = false;
  const result = await runWorldAgent({ ...f, goalReview: true, instruction: '核对进展并自主判断目标', runtime: runtime([
    (context: any) => {
      const input = JSON.parse(context.messages[0].content[0].text);
      assert.match(input.recentSixTurnFacts, /"blockChanges":5/);
      assert.match(input.recentSixTurnFacts, /jump_out_of_range/);
      assert.doesNotMatch(input.recentSixTurnFacts, /连续3轮没有记录到背包新增/);
      reviewed = true; return call('submit_goal_review', { decision: 'keep', reason: '先核对实际地形变化和失败条件。' });
    }, done(),
  ]) });
  assert.equal(result.goalReview?.status, 'completed'); assert.equal(reviewed, true);
  assert.equal(f.memory.recentProgress(1)[0].blockChanges, 5);
  assert.equal(f.memory.recentProgress(1)[0].actionReceipts?.length, 2);
});

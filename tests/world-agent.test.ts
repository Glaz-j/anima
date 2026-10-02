import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { WorldMemory, compactMemory, worldMemoryNamespace, progressState } from '../packages/npc-core/src/world-memory.ts';
import { loadWorldPersona, DEFAULT_WORLD_NPCS } from '../packages/npc-core/src/world-persona.ts';
import { budgetWorldMessages, boundedToolJson, compactObservation, currentBodyContext, HURT_ACTION_WINDOW_MS, runWorldAgent, type WorldAgentPort, type WorldPerceptionEvent } from '../packages/pi-runtime/src/world-agent.ts';
import { MinecraftWorld } from '../adapters/minecraft/src/world.ts';

function runtime(responses: any[]) {
  const models = createModels(), faux = fauxProvider(); models.setProvider(faux.provider); faux.setResponses(responses);
  return { models, model: faux.getModel(), apiKey: undefined as any, source: 'test' };
}
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'anima-world-test-'));
  t.after(async () => { assert.ok(root.startsWith(join(tmpdir(), 'anima-world-test-'))); await rm(root, { recursive: true, force: true }); });
  const memory = await WorldMemory.open(root, 'Sheldon', 'sheldon');
  const persona = await loadWorldPersona(root, 'sheldon');
  const actions: any[] = [];
  const port: WorldAgentPort = { name: 'Sheldon', persona: 'test', roleId: 'sheldon',
    observe: () => ({ position: { x: 0, y: 64, z: 0 }, recentEvents: [] }),
    execute: async (action) => { actions.push(action); return { id: `receipt-${actions.length}`, action, status: 'completed' }; } };
  return { root, memory, persona, port, actions, goalReview: false };
}

test('Minecraft observation reports only a confirmed overworld day phase and preserves its native clock', async t => {
  const f = await fixture(t);
  const world = new MinecraftWorld({ host: 'unused', port: 0, version: '1.21.4', logDirectory: f.root });
  const bot: any = { entity: { id: 1, position: { x: 0, y: 64, z: 0 } }, entities: {}, health: 20, food: 20,
    game: { dimension: 'overworld', gameMode: 'survival' }, time: {}, inventory: { items: () => [], slots: [] }, findBlocks: () => [] };
  world.bots.set('Sheldon', { name: 'Sheldon', persona: 'test', bot, ready: true, events: [] });
  for (const [dimension, isDay, timeOfDay, expected] of [
    ['overworld', true, 998, 'day'], ['minecraft:overworld', false, 18000, 'night'],
    ['overworld', false, 998, 'night'], // Trust isDay, not a second numeric classification.
    ['overworld', null, 998, undefined], ['overworld', 'true', 998, undefined],
    ['overworld', true, undefined, undefined], ['overworld', true, NaN, undefined],
    ['the_nether', true, 998, undefined], ['the_end', true, 998, undefined],
    ['minecraft:the_nether', false, 18000, undefined], [undefined, true, 998, undefined],
    ['custom:overworld', true, 998, undefined],
  ]) {
    bot.game.dimension = dimension; bot.time = { isDay, timeOfDay };
    const observed = world.observe('Sheldon');
    assert.equal(observed.dayPhase, expected, `${dimension}/${String(isDay)}/${timeOfDay}`);
    assert.equal(Object.hasOwn(observed, 'dayPhase'), expected !== undefined);
    assert.equal(observed.timeOfDay, timeOfDay);
    const compact = compactObservation(observed);
    assert.equal(compact.dayPhase, expected);
    assert.equal(compact.inventoryConfirmed, true, 'A synchronized empty inventory is positively known, not waiting for confirmation.');
    const context = currentBodyContext(compact, progressState(observed));
    const body = JSON.parse(/\n(\{[^\n]+\})\n<\/本轮起点身体状态>$/u.exec(context)![1]);
    assert.equal(body.dayPhase, expected);
    assert.equal(body.inventoryConfirmed, true);
    assert.equal(Object.hasOwn(body, 'dayPhase'), expected !== undefined);
  }
});

test('observation and body compaction keep explicit daylight without claiming enemies have disappeared', () => {
  const inventory = Array.from({ length: 64 }, (_, i) => ({ name: `item_${i}_${'x'.repeat(45)}`, count: 1 }));
  const raw = { dimension: 'overworld', timeOfDay: 998, dayPhase: 'day', inventory,
    nearbyEntities: [{ id: 10, name: 'zombie', type: 'zombie', health: 20, position: { x: 2, y: 64, z: 2 } }] };
  const compact = compactObservation(raw, 2000);
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) <= 2000);
  assert.ok(compact.omitted.inventory > 0); assert.equal(compact.dayPhase, 'day'); assert.equal(compact.timeOfDay, 998);
  assert.equal(compact.nearbyEntities[0].name, 'zombie');
  const context = currentBodyContext(compact, progressState(raw));
  const body = JSON.parse(/\n(\{[^\n]+\})\n<\/本轮起点身体状态>$/u.exec(context)![1]);
  assert.equal(body.dayPhase, 'day'); assert.equal(body.timeOfDay, 998); assert.ok(body.inventoryOmitted > 0);
  assert.match(context, /当前昼夜信息覆盖旧聊天和计划/);
  assert.match(context, /白天不表示附近敌对生物已经消失/);
  assert.equal(Object.hasOwn(compactObservation({ timeOfDay: 998 }), 'dayPhase'), false, 'A raw clock alone does not invent a day phase.');
  assert.equal(Object.hasOwn(compactObservation({ dayPhase: 'unknown' }), 'dayPhase'), false);
});

test('NPC observation preserves visible interaction state including false eye and zero fluid level', () => {
  const blocks = [
    { name: 'end_portal_frame', x: 1, y: 64, z: 1, properties: { eye: false, facing: 'north' } },
    { name: 'end_portal_frame', x: 2, y: 64, z: 1, properties: { eye: true, facing: 'north' } },
    { name: 'water', x: 3, y: 64, z: 1, properties: { level: 0 } },
    { name: 'water', x: 4, y: 64, z: 1, properties: { level: 1 } },
    { name: 'furnace', x: 5, y: 64, z: 1, properties: { lit: false, nbt: { privateContents: 'must-not-copy' }, invalid: NaN } },
    { name: 'stone', x: 6, y: 64, z: 1 },
  ];
  const compact = compactObservation({ nearbyBlocks: blocks });
  assert.deepEqual(compact.nearbyBlocks.slice(0, 4).map((block: any) => block.properties), blocks.slice(0, 4).map(block => block.properties));
  assert.deepEqual(compact.nearbyBlocks[4].properties, { lit: false });
  assert.equal(Object.hasOwn(compact.nearbyBlocks[5], 'properties'), false);
  assert.doesNotMatch(JSON.stringify(compact), /privateContents|must-not-copy|invalid/);
});

test('body and observation retain zero oxygen and explicit water posture through compaction without inventing a countdown', () => {
  const raw = { health: 8, inventory: [], locomotion: { inWater: true, inLava: false, onGround: false, privateField: 'omit' },
    oxygen: { level: 0, max: 20, unit: 'native-oxygen', privateField: 'omit' },
    posture: { mode: 'tread_water', active: true, suspended: false, remainingMs: 45000 },
    nearbyBlocks: Array.from({ length: 18 }, (_, i) => ({ name: 'stone', x: i, y: 60, z: 0 })) };
  const compact = compactObservation(raw, 1400);
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) <= 1400);
  assert.deepEqual(compact.locomotion, { inWater: true, inLava: false, onGround: false });
  assert.deepEqual(compact.oxygen, { level: 0, max: 20, unit: 'native-oxygen' });
  const body = JSON.parse(/\n(\{[^\n]+\})\n<\/本轮起点身体状态>$/u.exec(currentBodyContext(compact, progressState(raw)))![1]);
  assert.deepEqual(body.oxygen, compact.oxygen); assert.deepEqual(body.locomotion, compact.locomotion);
  assert.deepEqual(body.posture, raw.posture);
  assert.equal(Object.hasOwn(compactObservation({ locomotion: { inWater: true } }), 'oxygen'), false);
  assert.equal(Object.hasOwn(compactObservation({ oxygen: { level: NaN, max: 20, unit: 'native-oxygen' } }), 'oxygen'), false);
  assert.equal(Object.hasOwn(compactObservation({}), 'locomotion'), false);
});

test('explicit pursuit and floating posture survive the pi tool schema and reach only the actor body', async t => {
  const f = await fixture(t);
  const proposals = [{ type: 'posture', mode: 'tread_water', durationMs: 60000 },
    { type: 'attack', entityId: 42, durationMs: 6000, follow: true }, { type: 'posture', mode: 'none' }];
  const result = await runWorldAgent({ ...f, instruction: '自行选择动作', runtime: runtime([
    fauxAssistantMessage(proposals.map(proposal => fauxToolCall('action', proposal)), { stopReason: 'toolUse' }),
    fauxAssistantMessage('已经实际尝试。'),
  ]) });
  assert.equal(result.status, 'completed'); assert.deepEqual(f.actions, proposals);
});

test('pi dispatches explicit public speech within its limit and rejects oversized broadcasts before the body', async t => {
  const f = await fixture(t), chosen = { type: 'broadcast', message: '声'.repeat(240) };
  const result = await runWorldAgent({ ...f, instruction: '自行选择沟通方式', runtime: runtime([
    fauxAssistantMessage([fauxToolCall('action', chosen),
      fauxToolCall('action', { type: 'broadcast', message: '声'.repeat(241) })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('只依据实际收信判断对方的反应。'),
  ]) });
  assert.deepEqual(f.actions, [chosen]);
  assert.equal(result.actions.length, 1);
  assert.equal(result.toolTrace.filter(entry => entry.status === 'error').length, 1);
  assert.deepEqual(result.emergencyBudget, { actionsUsed: 0, modelTurnsUsed: 0 });
});

test('public speech and capability survive bounded observation without adding remote body facts', () => {
  const communication = { mode: 'local', radius: 16, distance: 'euclidean-3d', sentDoesNotConfirmHearing: true,
    broadcast: { available: true, scope: 'server', action: 'broadcast' } };
  const raw = { communication, recentEvents: [
    { id: 'public', type: 'heard', speaker: 'Sherlock', message: '我有食物。', channel: 'broadcast',
      position: { x: 1234, y: 64, z: 5678 }, inventory: [{ name: 'secret_food', count: 20 }] },
    { id: 'nearby', type: 'heard', speaker: 'HuYifei', message: '我在观察。', channel: 'local' },
    { id: 'legacy', type: 'heard', speaker: 'Deadpool', message: '等一下。', channel: 'invented' },
  ] };
  const compact = compactObservation(raw, 1400);
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) <= 1400);
  assert.deepEqual(compact.communication, communication);
  assert.equal(compact.recentEvents[0].channel, 'broadcast');
  assert.equal(compact.recentEvents[1].channel, 'local');
  assert.equal(Object.hasOwn(compact.recentEvents[2], 'channel'), false);
  assert.doesNotMatch(JSON.stringify(compact), /1234|5678|secret_food/);
  for (const broadcast of [{ available: false, scope: 'server', action: 'broadcast' },
    { available: true, scope: 'private', action: 'broadcast' }, { available: true, scope: 'server', action: 'say' }]) {
    assert.equal(Object.hasOwn(compactObservation({ communication: { ...communication, broadcast } }).communication, 'broadcast'), false);
  }
});

test('pi dispatches one selected fishing attempt but rejects missing water, fractional cells and excessive waits', async t => {
  const f = await fixture(t), chosen = { type: 'fish', position: { x: -12, y: 63, z: 4 }, durationMs: 45000 };
  const invalid = [{ type: 'fish' }, { ...chosen, position: { x: -12.5, y: 63, z: 4 } },
    { ...chosen, durationMs: 45001 }, { ...chosen, durationMs: 0 }, { ...chosen, repeat: true }];
  const result = await runWorldAgent({ ...f, instruction: '根据观察自主选择动作', runtime: runtime([
    fauxAssistantMessage([chosen, ...invalid].map(proposal => fauxToolCall('action', proposal)), { stopReason: 'toolUse' }),
    fauxAssistantMessage('等实际结果再判断。'),
  ]) });
  assert.deepEqual(f.actions, [chosen]);
  assert.equal(result.toolTrace.filter(entry => entry.status === 'error').length, invalid.length);
  assert.equal(result.actions.length, 1);
});

test('long fishing yields before casting when remaining time cannot cover the requested wait and cleanup', async t => {
  const f = await fixture(t), chosen = { type: 'fish', position: { x: 2, y: 63, z: 0 }, durationMs: 30000 };
  await f.memory.rememberIntent('获取可实际吃到的食物。', 'goal', { completionCondition: '实际进食。' });
  await f.memory.rememberIntent('从岸上尝试钓鱼，观察收获后再决定。', 'plan');
  const active = f.memory.currentIntent(); let modelCalls = 0;
  const result = await runWorldAgent({ ...f, timeoutMs: 5000, instruction: '自主继续生存', runtime: runtime([
    () => { modelCalls++; return fauxAssistantMessage([
      fauxToolCall('observe', {}),
      fauxToolCall('action', chosen),
      fauxToolCall('action', { type: 'dig', x: 1, y: 64, z: 0 }),
      fauxToolCall('remember', { category: 'goal', goalStatus: 'completed', text: '这个旧批次不应写成功。' }),
      fauxToolCall('observe', {}),
    ], { stopReason: 'toolUse' }); },
    () => { modelCalls++; return fauxAssistantMessage('不应为了预算交接再调用模型。'); },
  ]) });
  assert.equal(result.status, 'incomplete'); assert.equal(result.reason, 'budget'); assert.equal(result.error, undefined);
  assert.equal(result.turns, 1); assert.equal(modelCalls, 1); assert.deepEqual(f.actions, []); assert.deepEqual(result.actions, []);
  assert.deepEqual(result.emergencyBudget, { actionsUsed: 0, modelTurnsUsed: 0 });
  assert.deepEqual(result.budgetYield?.action, chosen); assert.equal(result.budgetYield?.requiredMs, 36000);
  assert.ok(result.budgetYield!.remainingMs <= 5000);
  assert.equal(result.toolTrace[0].status, 'completed');
  assert.ok(result.toolTrace.slice(1).every(row => row.status === 'deferred' && !row.error));
  assert.deepEqual(f.memory.currentIntent(), active, 'A deferred cast neither replaces the goal nor completes its plan.');
  assert.deepEqual(f.memory.recentProgress(1)[0].actions, {});
  assert.deepEqual(f.memory.recentProgress(1)[0].failures, []);
  const note = f.memory.entries.find(entry => entry.sourceId === `deferred-action:${result.taskId}`)!;
  assert.equal(note.kind, 'intent'); assert.equal(note.topic, 'note'); assert.match(note.text, /尚未执行/);
  assert.ok(!f.memory.entries.some(entry => entry.sourceId?.startsWith('action:')));
});

test('a deferred cast survives restart as an intention and a fresh NPC decision can resume it', async t => {
  const f = await fixture(t), chosen = { type: 'fish', position: { x: 2, y: 63, z: 0 } };
  await f.memory.rememberIntent('为自己获得食物。', 'goal');
  await runWorldAgent({ ...f, timeoutMs: 5000, instruction: '持续目标', runtime: runtime([
    fauxAssistantMessage(fauxToolCall('action', chosen), { stopReason: 'toolUse' }),
  ]) });
  const restored = await WorldMemory.open(f.root, 'Sheldon', 'sheldon');
  const result = await runWorldAgent({ ...f, memory: restored, instruction: '持续目标', runtime: runtime([
    (context: any) => {
      assert.match(context.systemPrompt, /自己选择的动作尚未执行/);
      assert.match(context.systemPrompt, /为自己获得食物/);
      assert.match(context.systemPrompt, /不自动执行/);
      assert.deepEqual(f.actions, [], 'Merely restoring memory must not replay the cast.');
      return fauxAssistantMessage(fauxToolCall('action', chosen), { stopReason: 'toolUse' });
    },
    fauxAssistantMessage('根据新的实际结果继续判断。'),
  ]) });
  assert.equal(result.status, 'completed'); assert.equal(result.budgetYield, undefined);
  assert.deepEqual(f.actions, [chosen]);
});

test('execution time is refreshed last in each model request and tool receipt without widening the context', async t => {
  const f = await fixture(t); let firstRemaining = 0;
  const readBudget = (context: any) => {
    assert.ok(context.systemPrompt.length <= 24000);
    assert.ok(context.systemPrompt.endsWith('</本轮执行预算>'));
    assert.ok(context.systemPrompt.indexOf('<本轮执行预算>') > context.systemPrompt.indexOf('</本轮起点身体状态>'));
    return JSON.parse(/<本轮执行预算>\n([^\n]+)/u.exec(context.systemPrompt)![1]);
  };
  const result = await runWorldAgent({ ...f, timeoutMs: 5000, persona: { ...f.persona, prompt: '人格'.repeat(20000) },
    instruction: '自行决定', runtime: runtime([
      async (context: any) => {
        firstRemaining = readBudget(context).remainingMs;
        await delay(25);
        return fauxAssistantMessage(fauxToolCall('action', { type: 'wait', ms: 0 }), { stopReason: 'toolUse' });
      },
      (context: any) => {
        const budget = readBudget(context);
        assert.ok(budget.remainingMs < firstRemaining); assert.equal(budget.actionsRemaining, 5);
        const receipt = context.messages.findLast((message: any) => message.role === 'toolResult');
        const body = JSON.parse(receipt.content[0].text);
        assert.ok(body.executionBudget.remainingMs < firstRemaining);
        assert.equal(body.executionBudget.actionsRemaining, 5);
        return fauxAssistantMessage('已完成一次短行动。');
      },
    ]) });
  assert.equal(result.status, 'completed'); assert.equal(result.error, undefined);
});

test('short actions and a long posture lease are not refused by fishing time admission', async t => {
  const f = await fixture(t);
  const proposals = [{ type: 'posture', mode: 'tread_water', durationMs: 120000 },
    { type: 'attack', entityId: 9, durationMs: 8000, follow: true }, { type: 'equip', item: 'cod' },
    { type: 'consume' }, { type: 'fish', position: { x: 2, y: 63, z: 0 }, durationMs: 1000 }];
  const result = await runWorldAgent({ ...f, timeoutMs: 5000, instruction: '自主选择行动', runtime: runtime([
    fauxAssistantMessage(proposals.map(proposal => fauxToolCall('action', proposal)), { stopReason: 'toolUse' }),
    fauxAssistantMessage('按实际回执决定。'),
  ]) });
  assert.equal(result.status, 'completed'); assert.equal(result.budgetYield, undefined); assert.deepEqual(f.actions, proposals);
});

test('yielding a newly informed long cast does not spend the reserved seventh body action', async t => {
  const f = await fixture(t), events = livePerception(f.port); let health = 20;
  f.port.observe = () => ({ health, food: 17, recentEvents: [] });
  f.port.execute = async action => {
    f.actions.push(action);
    if (f.actions.length === 6) { health = 18; events.emit({ id: 'before-budget-handoff', type: 'hurt', healthBefore: 20, health }); }
    return { status: 'completed', action };
  };
  const result = await runWorldAgent({ ...f, timeoutMs: 5000, instruction: '自己选择新伤情后的反应', runtime: runtime([
    fauxAssistantMessage(Array.from({ length: 6 }, () => fauxToolCall('action', { type: 'wait', ms: 0 })), { stopReason: 'toolUse' }),
    (context: any) => {
      assert.equal(liveMessages(context).length, 1);
      return fauxAssistantMessage(fauxToolCall('action', { type: 'fish', position: { x: 2, y: 63, z: 0 }, durationMs: 10000 }), { stopReason: 'toolUse' });
    },
  ]) });
  assert.equal(result.reason, 'budget'); assert.equal(result.actions.length, 6); assert.equal(result.turns, 2);
  assert.equal(result.emergencyBudget.actionsUsed, 0); assert.equal(events.count, 0);
  assert.equal(result.budgetYield?.requiredMs, 16000);
});

test('failed handoff persistence still yields without launching the body or retrying the model', async t => {
  const f = await fixture(t), add = f.memory.add.bind(f.memory);
  f.memory.add = async (...args) => { if (String(args[2]).startsWith('deferred-action:')) throw new Error('disk failure'); return add(...args); };
  const result = await runWorldAgent({ ...f, timeoutMs: 5000, instruction: '自主选择', runtime: runtime([
    fauxAssistantMessage(fauxToolCall('action', { type: 'fish', position: { x: 2, y: 63, z: 0 } }), { stopReason: 'toolUse' }),
  ]) });
  assert.equal(result.reason, 'budget'); assert.equal(result.turns, 1); assert.equal(result.error, undefined);
  assert.deepEqual(f.actions, []); assert.ok(result.perceptionErrors.some(error => error.includes('Deferred intention persistence failed')));
});

test('death or parent cancellation while writing a handoff remains cancellation and cannot launch a queued action', async t => {
  const f = await fixture(t), controller = new AbortController(), add = f.memory.add.bind(f.memory);
  f.memory.add = async (...args) => {
    if (String(args[2]).startsWith('deferred-action:')) controller.abort(new Error('death'));
    return add(...args);
  };
  const result = await runWorldAgent({ ...f, signal: controller.signal, timeoutMs: 5000, instruction: '自主选择', runtime: runtime([
    fauxAssistantMessage([fauxToolCall('action', { type: 'fish', position: { x: 2, y: 63, z: 0 } }),
      fauxToolCall('action', { type: 'attack', entityId: 9 })], { stopReason: 'toolUse' }),
  ]) });
  assert.equal(result.status, 'cancelled'); assert.equal(result.reason, 'cancelled'); assert.equal(result.turns, 1);
  assert.deepEqual(f.actions, []); assert.equal(result.emergencyBudget.actionsUsed, 0);
});

test('unconfirmed crafting predictions remain qualified and do not become resource progress', async t => {
  const f = await fixture(t);
  let reads = 0;
  f.port.observe = () => ({ position: { x: 0, y: 64, z: 0 }, recentEvents: [],
    ...(reads++ === 0 ? { inventory: [{ name: 'oak_log', count: 3 }] }
      : { inventoryConfirmed: false, inventory: [{ name: 'oak_planks', count: 99 }] }) });
  f.port.execute = async action => ({ id: 'unsynced-craft', action, status: 'failed', error: 'window synchronization unavailable',
    details: { inventoryConfirmed: false, inventoryDelta: [{ item: 'oak_log', change: -1 }, { item: 'oak_planks', change: 4 }] } });
  const result = await runWorldAgent({ ...f, instruction: '根据实际结果继续决定', runtime: runtime([
    fauxAssistantMessage(fauxToolCall('action', { type: 'craft', item: 'oak_planks', count: 4 }), { stopReason: 'toolUse' }),
    (context: any) => {
      const receipt = context.messages.findLast((message: any) => message.role === 'toolResult');
      const body = JSON.parse(receipt.content.find((part: any) => part.type === 'text').text);
      assert.equal(body.details.inventoryConfirmed, false);
      assert.match(body.reflection, /不能将客户端预测当作实际产物/);
      return fauxAssistantMessage('这批产物尚未确认。');
    },
  ]) });
  assert.equal(result.status, 'completed');
  assert.deepEqual(f.memory.recentProgress(1)[0].inventoryChanges, []);
  assert.equal(f.memory.recentProgress(1)[0].end.inventory, undefined);
  assert.ok(!f.memory.entries.filter(entry => entry.sourceId?.startsWith('observation:')).some(entry => entry.text.includes('99')),
    'A later observation must not launder the predicted inventory into a factual snapshot.');
  assert.match(f.memory.entries.find(entry => entry.sourceId === 'action:unsynced-craft')!.text, /尚未得到服务器确认/);
  const compact = compactObservation({ recentEvents: [{ type: 'action', action: { type: 'craft' },
    details: { inventoryConfirmed: false, inventoryDelta: [{ item: 'oak_planks', change: 4 }] } }] });
  assert.equal(compact.recentEvents[0].details.inventoryConfirmed, false);
});

test('unconfirmed observed inventory is unknown in compact context, body facts and progress', () => {
  const raw = { inventoryConfirmed: false, inventory: [{ name: 'diamond', count: 64 }],
    equipment: { hand: { name: 'diamond_sword', count: 1 } }, health: 18 };
  const compact = compactObservation(raw);
  assert.equal(compact.inventoryConfirmed, false);
  assert.deepEqual(compact.inventory, []);
  assert.deepEqual(compact.equipment, {});
  assert.equal(progressState(raw).inventory, undefined);
  const context = currentBodyContext(compact, { health: 18, inventory: { diamond: 64 } });
  assert.match(context, /"inventoryConfirmed":false/);
  assert.doesNotMatch(context, /diamond|"inventory":/);
  assert.match(context, /"health":18/);
});

function livePerception(port: WorldAgentPort) {
  const listeners = new Set<(event: WorldPerceptionEvent) => void>();
  let cleanups = 0;
  port.subscribe = listener => { listeners.add(listener); return () => { if (listeners.delete(listener)) cleanups++; }; };
  return { emit(event: WorldPerceptionEvent) { for (const listener of listeners) listener(event); },
    get count() { return listeners.size; }, get cleanups() { return cleanups; } };
}
function liveMessages(context: any) {
  return context.messages.filter((message: any) => message.role === 'user' && JSON.stringify(message.content).includes('<身体即时事件>'));
}

test('world memory survives restart and isolates NPC, role, provenance and repeated events', async t => {
  const f = await fixture(t);
  const heard = { id: 'heard-1', time: '2026-10-02T01:00:00Z', type: 'heard', speaker: 'Sherlock', message: '我声称已经打败末影龙。' };
  await f.memory.ingestEvents([heard, heard]);
  await f.memory.add('intent', '明天去寻找出口');
  const receipt = { id: 'r1', action: { type: 'say', message: '你好' }, status: 'completed' };
  await f.memory.recordAction(receipt);
  await f.memory.ingestEvents([{ type: 'action', ...receipt }]);
  assert.equal(f.memory.entries.length, 3);
  const restored = await WorldMemory.open(f.root, 'Sheldon', 'sheldon');
  assert.equal(restored.entries[0].kind, 'hearsay');
  assert.match(restored.entries[2].text, /不证明别人听见/);
  assert.equal((await WorldMemory.open(f.root, 'Sherlock', 'sherlock')).entries.length, 0);
  assert.equal((await WorldMemory.open(f.root, 'Sheldon', 'sherlock')).entries.length, 0);
  await assert.rejects(() => WorldMemory.open(f.root, '../bad', 'sheldon'));
});

test('public claims remain hearsay across memory reload and own broadcasts only record sending', async t => {
  const f = await fixture(t);
  const heard = { id: 'public-claim', type: 'heard', channel: 'broadcast', speaker: 'Sherlock',
    message: '我已经有钻石了。', position: { x: 999, y: 64, z: 888 }, inventory: ['private_inventory'] };
  await f.memory.ingestEvents([heard, heard]);
  await f.memory.recordAction({ id: 'public-send', action: { type: 'broadcast', message: '说一下位置。' },
    status: 'completed', details: { channel: 'broadcast', sent: true, deliveryConfirmed: false } });
  const restored = await WorldMemory.open(f.root, 'Sheldon', 'sheldon');
  assert.equal(restored.entries.length, 2);
  assert.equal(restored.entries[0].kind, 'hearsay');
  assert.equal(restored.entries[0].text, 'Sherlock通过世界频道说：我已经有钻石了。');
  assert.doesNotMatch(restored.entries[0].text, /999|888|private_inventory/);
  assert.equal(restored.entries[1].kind, 'fact');
  assert.match(restored.entries[1].text, /不证明别人听见、相信或记住/);
  assert.equal((await WorldMemory.open(f.root, 'Sherlock', 'sherlock')).entries.length, 0);
});

test('older memories are recalled by keywords with provenance, and compaction only extracts', async t => {
  const f = await fixture(t);
  await f.memory.add('hearsay', 'Sherlock说钻石在石桥旁边。');
  for (let i = 0; i < 20; i++) await f.memory.add('intent', `打算观察日落 ${i}`);
  const context = f.memory.context('钻石石桥', 1200);
  assert.match(context, /Sherlock说钻石在石桥旁边/);
  assert.match(context, /hearsay/);
  assert.ok(context.length <= 1300);
  assert.ok(compactMemory(f.memory.entries, 150).length <= 150);
  assert.deepEqual(f.memory.recall('从未提及的蓝鲸'), []);
});

test('public starter personas require no private data and malformed local profiles do not silently fall back', async t => {
  const f = await fixture(t);
  assert.deepEqual(DEFAULT_WORLD_NPCS.map(p => p.roleId), ['sheldon', 'sherlock', 'deadpool', 'huyifei']);
  assert.equal(f.persona.source, 'starter');
  await mkdir(join(f.root, 'data/roles'), { recursive: true });
  await writeFile(join(f.root, 'data/roles/catalogue.json'), JSON.stringify([{ id: 'sheldon' }]));
  await assert.rejects(() => loadWorldPersona(f.root, 'sheldon'));
});

test('standalone persona/self files load in memory with checked source identity and evidence IDs', async t => {
  const f = await fixture(t);
  const roleFolder = join(f.root, 'data/roles/sheldon'), skillFolder = join(f.root, '.claude/skills/sheldon');
  await mkdir(roleFolder, { recursive: true }); await mkdir(skillFolder, { recursive: true });
  const source = { dataset: 'fictional-fixture', revision: 'test-revision' };
  await writeFile(join(f.root, 'data/roles/catalogue.json'), JSON.stringify([
    { id: 'sheldon', name: '测试人物', work: 'fixture', seed: '', source },
    { id: 'unrelated', name: '未准备的人物' },
  ]));
  await writeFile(join(roleFolder, 'corpus.jsonl'), JSON.stringify({ id: 'source1', roleId: 'sheldon', groupId: 'g1', text: 'Seat by the window.', messages: [] }) + '\n');
  await writeFile(join(skillFolder, 'persona.md'), '只属于此人物的人格规则');
  await writeFile(join(skillFolder, 'self.md'), '此人物既有关系');
  await writeFile(join(skillFolder, 'evidence.json'), JSON.stringify([{ id: 'source1', situation: '座位', interpretation: '尊重边界' }]));
  const meta = { name: '测试人物', fictional: true, roleId: 'someone-else', source,
    memory_sources: ['data/roles/sheldon/corpus.jsonl'], impression: 'test', tags: { personality: [] } };
  await writeFile(join(skillFolder, 'meta.json'), JSON.stringify(meta));
  await assert.rejects(() => loadWorldPersona(f.root, 'sheldon'), /identity\/source mismatch/);
  meta.roleId = 'sheldon'; await writeFile(join(skillFolder, 'meta.json'), JSON.stringify(meta));
  const loaded = await loadWorldPersona(f.root, 'sheldon');
  assert.equal(loaded.source, 'local-profile');
  assert.match(loaded.prompt, /只属于此人物的人格规则/); assert.match(loaded.prompt, /此人物既有关系/);
  assert.equal(loaded.index?.search('座位')[0]?.id, 'source1');
  // No generated profile is written, and the missing unrelated role never gets loaded.
  const { access } = await import('node:fs/promises');
  await assert.rejects(() => access(join(roleFolder, 'profile.json')));
});

test('pi uses the local persona/self profile and evidence index while preserving intent vs world facts', async t => {
  const f = await fixture(t);
  const directory = join(f.root, 'data/roles/sheldon'); await mkdir(directory, { recursive: true });
  await writeFile(join(f.root, 'data/roles/catalogue.json'), JSON.stringify([{ id: 'sheldon', name: '测试人格', work: 'test', seed: 'observe' }]));
  await writeFile(join(directory, 'profile.json'), JSON.stringify({ roleId: 'sheldon', personaMarkdown: '专属人格规则', selfMarkdown: '专属原作关系', evidenceNotes: [{ id: 'seat', situation: '座位', pattern: '边界', keywords: 'seat' }] }));
  await writeFile(join(directory, 'corpus.jsonl'), JSON.stringify({ id: 'seat', roleId: 'sheldon', groupId: 's1', text: 'My seat is by the window.', source: 'test', language: 'en', messages: [] }) + '\n');
  f.persona = await loadWorldPersona(f.root, 'sheldon');
  f.port.observe = () => ({ recentEvents: [{ id: 'h1', type: 'heard', speaker: 'Other', message: '门已经打开了。' }] });
  f.port.execute = async action => ({ status: 'failed', action, error: '障碍挡路' });
  const result = await runWorldAgent({ ...f, instruction: '帮我看看座位附近的门', runtime: runtime([
    (context: any) => {
      for (const required of ['专属人格规则', '专属原作关系', '击败末影龙可以帮助大家逃出这个世界', '私下知道自己是合成人格']) assert.ok(context.systemPrompt.includes(required));
      return fauxAssistantMessage([fauxToolCall('recall_character', { query: 'seat' }), fauxToolCall('remember', { text: '我打算去门口' }), fauxToolCall('action', { type: 'goto', x: 1, y: 64, z: 1 })], { stopReason: 'toolUse' });
    },
    (context: any) => {
      assert.ok(JSON.stringify(context.messages).includes('My seat is by the window.'));
      assert.ok(JSON.stringify(context.messages).includes('障碍挡路'));
      return fauxAssistantMessage(fauxText('<think>internal</think>门口有障碍，我还没有过去。'));
    },
  ]) });
  assert.equal(result.status, 'completed'); assert.equal(result.turns, 2);
  assert.equal(result.reply, '门口有障碍，我还没有过去。');
  assert.equal(result.actions[0].status, 'failed');
  assert.ok(f.memory.entries.some(entry => entry.kind === 'intent' && entry.text === '我打算去门口'));
  assert.ok(f.memory.entries.some(entry => entry.kind === 'hearsay' && entry.text.includes('门已经打开')));
  assert.ok(!f.memory.entries.some(entry => entry.kind === 'fact' && entry.text.includes('门已经打开')));
  assert.ok(!f.memory.entries.some(entry => entry.text === result.reply));
  assert.equal(typeof result.usage.totalTokens, 'number');
});

test('at most six real actions execute even when a model submits a larger tool batch', async t => {
  const f = await fixture(t);
  const result = await runWorldAgent({ ...f, instruction: '等待', runtime: runtime([
    fauxAssistantMessage(Array.from({ length: 9 }, () => fauxToolCall('action', { type: 'wait', ms: 1 })), { stopReason: 'toolUse' }),
    fauxAssistantMessage('这一轮结束。'),
  ]) });
  assert.equal(f.actions.length, 6); assert.equal(result.actions.length, 6);
});

test('shoot accepts a root entity ID and persists unconfirmed-damage details without inventing a kill', async t => {
  const f = await fixture(t);
  f.port.execute = async action => {
    f.actions.push(action);
    return { id: 'arrow-1', status: 'completed', action, details: { shot: true, damageConfirmed: false } };
  };
  const result = await runWorldAgent({ ...f, instruction: '向水晶射一箭', runtime: runtime([
    (context: any) => {
      assert.ok(context.systemPrompt.includes('nearbyEntities[].id根实体ID'));
      return fauxAssistantMessage(fauxToolCall('action', { type: 'shoot', entityId: 42 }), { stopReason: 'toolUse' });
    },
    fauxAssistantMessage('已经射出，尚未确认命中。'),
  ]) });
  assert.deepEqual(f.actions[0], { type: 'shoot', entityId: 42 });
  assert.equal(result.actions[0].details.damageConfirmed, false);
  const memory = f.memory.entries.find(entry => entry.sourceId === 'action:arrow-1');
  assert.ok(memory?.text.includes('"damageConfirmed":false'));
  assert.ok(memory?.text.includes('不是命中或击杀证据'));
});

test('eight model turns terminate as a normal budget boundary without scheduler error', async t => {
  const f = await fixture(t);
  const result = await runWorldAgent({ ...f, instruction: '观察', runtime: runtime(Array.from({ length: 10 }, () => fauxAssistantMessage(fauxToolCall('observe', {}), { stopReason: 'toolUse' }))) });
  assert.equal(result.turns, 8); assert.equal(result.status, 'incomplete'); assert.equal(result.reason, 'budget'); assert.equal(result.error, undefined);
});

test('cancellation before a turn makes no model or world calls', async t => {
  const f = await fixture(t);
  f.port.observe = () => { throw new Error('should not observe'); };
  const result = await runWorldAgent({ ...f, instruction: '取消', signal: AbortSignal.abort(), runtime: runtime([]) });
  assert.equal(result.status, 'cancelled'); assert.equal(result.turns, 0); assert.equal(f.actions.length, 0); assert.equal(f.memory.entries.length, 0);
});

test('deadline reaches the executing body and records cancellation, never success', async t => {
  const f = await fixture(t); let bodyAborted = false;
  f.port.execute = (_action, _taskId, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { bodyAborted = true; reject(new Error('身体动作取消')); }, { once: true });
  });
  const result = await runWorldAgent({ ...f, instruction: '等待', timeoutMs: 100, runtime: runtime([fauxAssistantMessage(fauxToolCall('action', { type: 'wait', ms: 1 }), { stopReason: 'toolUse' })]) });
  assert.ok(bodyAborted); assert.equal(result.status, 'cancelled'); assert.equal(result.reason, 'timeout');
  assert.equal(result.actions[0]?.status, 'cancelled');
});

test('context budgeting removes whole tool exchanges instead of orphaning results', () => {
  const messages: any[] = [{ role: 'user', content: 'goal', timestamp: 1 }];
  for (let i = 0; i < 10; i++) {
    messages.push({ role: 'assistant', content: [{ type: 'toolCall', id: `t${i}`, name: 'observe', arguments: {} }] });
    messages.push({ role: 'toolResult', toolCallId: `t${i}`, content: [{ type: 'text', text: 'x'.repeat(300) }] });
  }
  const selected = budgetWorldMessages(messages, 1800);
  assert.ok(JSON.stringify(selected).length <= 1800);
  assert.equal(selected[0], messages[0]);
  for (let i = 1; i < selected.length; i += 2) {
    assert.equal(selected[i].role, 'assistant'); assert.equal(selected[i + 1].role, 'toolResult');
  }
});

test('an oversized latest tool batch keeps every call/result while shortening result text', () => {
  const calls = Array.from({ length: 12 }, (_, i) => ({ type: 'toolCall', id: `call${i}`, name: 'observe', arguments: {} }));
  const messages: any[] = [{ role: 'user', content: 'goal' }, { role: 'assistant', content: calls },
    ...calls.map(call => ({ role: 'toolResult', toolCallId: call.id, content: [{ type: 'text', text: 'evidence '.repeat(1000) }] }))];
  const selected = budgetWorldMessages(messages, 6000);
  assert.equal(selected.length, 14);
  assert.ok(JSON.stringify(selected).length <= 6000);
  assert.equal(selected[1].role, 'assistant');
  for (let i = 0; i < calls.length; i++) assert.equal((selected[i + 2] as any).toolCallId, calls[i].id);
});

test('world namespaces isolate restarts and reject traversal or misfiled memories', async t => {
  const f = await fixture(t);
  for (const value of ['../old-world', 'x/y', 'x\\y', 'C:world', 'CON', 'aux', '', ' world']) assert.throws(() => worldMemoryNamespace(value));
  assert.equal(worldMemoryNamespace(), 'minecraft');
  const first = await WorldMemory.open(join(f.root, 'survival-a'), 'Sheldon', 'sheldon', 'survival-a');
  await first.add('fact', '只在旧世界发现过此地点。');
  const second = await WorldMemory.open(join(f.root, 'survival-b'), 'Sheldon', 'sheldon', 'survival-b');
  assert.equal(second.entries.length, 0);
  assert.equal((await WorldMemory.open(join(f.root, 'survival-a'), 'Sheldon', 'sheldon', 'survival-a')).entries.length, 1);
  await assert.rejects(() => WorldMemory.open(join(f.root, 'survival-a'), 'Sheldon', 'sheldon', 'survival-b'), /mismatch/);
});

test('current goal and teammate statements survive many newer observations without becoming facts', async t => {
  const f = await fixture(t);
  await f.memory.rememberIntent('我要寻找适合休息的地方。', 'goal');
  await f.memory.rememberIntent('等同伴回应后商量分工。', 'coordination');
  await f.memory.ingestEvents([{ id: 'coordination', type: 'heard', speaker: 'HuYifei', message: '我愿意负责这边，你先歇一下。' }]);
  for (let i = 0; i < 30; i++) await f.memory.add('fact', `观察其他状态 ${i}`);
  const restarted = await WorldMemory.open(f.root, 'Sheldon', 'sheldon');
  const context = restarted.context('下一步');
  assert.match(context, /寻找适合休息/); assert.match(context, /我愿意负责这边/);
  assert.equal(restarted.entries.find(entry => entry.topic === 'goal')?.kind, 'intent');
  assert.ok(!restarted.entries.some(entry => entry.kind === 'fact' && entry.text.includes('我愿意负责')));
});

test('compact observation excludes diagnostic chatter and arrows while retaining actionable actors and equipment as valid JSON', () => {
  const raw = { name: 'Sheldon', dimension: 'minecraft:overworld', position: { x: 0.123456, y: 64, z: 2 }, health: 17, food: 10,
    inventory: [{ name: 'wooden_pickaxe', count: 1 }], equipment: { hand: { name: 'wooden_pickaxe', count: 1 } },
    nearbyEntities: [...Array.from({ length: 80 }, (_, i) => ({ id: i, name: 'arrow', type: 'arrow' })),
      { id: 123, name: 'ender_dragon', type: 'ender_dragon', position: { x: 5, y: 70, z: 2 }, health: 200,
        phase: 6, phaseName: 'SITTING_SCANNING', projectileImmune: true },
      { id: 124, name: 'Crystal', type: 'end_crystal', position: { x: 10, y: 80, z: 10 } },
      { id: 125, name: 'HuYifei', type: 'player', kind: 'player', position: { x: 3, y: 64, z: 2 } }],
    nearbyBlocks: Array.from({ length: 20 }, (_, i) => ({ x: i, y: 64, z: 2, name: 'stone' })),
    recentEvents: [{ type: 'task-started', instruction: 'PRIVATE-DIAGNOSTIC'.repeat(1000) },
      { id: 'hear', type: 'heard', speaker: 'HuYifei', message: '我在这里。', time: 'now' }] };
  const compact = compactObservation(raw);
  const encoded = JSON.stringify(compact);
  assert.ok(Buffer.byteLength(encoded, 'utf8') <= 4400);
  assert.equal(JSON.parse(encoded).equipment.hand.name, 'wooden_pickaxe');
  assert.ok(compact.nearbyEntities.some((entry: any) => entry.id === 123));
  const dragon = compact.nearbyEntities.find((entry: any) => entry.id === 123);
  assert.equal(dragon.phase, 6); assert.equal(dragon.phaseName, 'SITTING_SCANNING'); assert.equal(dragon.projectileImmune, true);
  assert.ok(compact.nearbyEntities.some((entry: any) => entry.id === 125));
  assert.ok(!compact.nearbyEntities.some((entry: any) => entry.name === 'arrow'));
  assert.equal(compact.equipment.hand.name, 'wooden_pickaxe');
  assert.ok(!encoded.includes('PRIVATE-DIAGNOSTIC')); assert.match(encoded, /我在这里/);
  const crowded = compactObservation({ ...raw, inventory: Array.from({ length: 36 }, (_, i) => ({ name: `item_${i}`, count: 64 })) });
  assert.equal(crowded.inventory.length + crowded.omitted.inventory, 36);
  assert.match(crowded.scope, /不能断言没有未展示物品/);
});

test('large recipe or scan tool payloads remain valid bounded JSON', () => {
  const value = { status: 'completed', action: { type: 'recipes', item: 'chest' }, details: { recipes: Array.from({ length: 40 }, (_, i) => ({ id: i, description: '很多资料'.repeat(1000) })) } };
  const encoded = boundedToolJson(value);
  assert.ok(Buffer.byteLength(encoded, 'utf8') <= 4500);
  const decoded = JSON.parse(encoded);
  assert.equal(decoded.truncated, true); assert.equal(decoded.result.status, 'completed');
});

test('repeated observe calls persist only a meaningful boundary snapshot and ingest heard events', async t => {
  const f = await fixture(t); let reads = 0;
  f.port.observe = () => ({ position: { x: 0, y: 64, z: 0 }, health: 20, inventory: [],
    nearbyEntities: [{ id: 1, name: 'cow', type: 'cow', position: { x: ++reads, y: 64, z: 0 }, health: 10 }],
    recentEvents: [{ id: 'heard-once', type: 'heard', speaker: 'Other', message: '我会再回来。' }] });
  const result = await runWorldAgent({ ...f, instruction: '听听同伴的话', runtime: runtime([
    fauxAssistantMessage(Array.from({ length: 6 }, () => fauxToolCall('observe', {})), { stopReason: 'toolUse' }), fauxAssistantMessage('知道了。'),
  ]) });
  assert.equal(result.toolTrace.length, 6);
  assert.equal(f.memory.entries.filter(entry => entry.sourceId?.startsWith('observation:')).length, 1);
  assert.equal(f.memory.entries.filter(entry => entry.kind === 'hearsay').length, 1);
});

test('tool trace captures schema failures before execution and bounds diagnostics', async t => {
  const f = await fixture(t);
  const result = await runWorldAgent({ ...f, instruction: '测试', runtime: runtime([
    fauxAssistantMessage([fauxToolCall('action', { type: 'not-a-real-action', message: 'x'.repeat(3000) }), fauxToolCall('missing_tool', {})], { stopReason: 'toolUse' }),
    fauxAssistantMessage('工具参数不合适。'),
  ]) });
  assert.equal(result.actions.length, 0); assert.equal(result.toolTrace.length, 2);
  assert.ok(result.toolTrace.every(entry => entry.status === 'error' && entry.error && entry.error.length <= 500 && entry.args.length <= 350));
  assert.ok(!f.memory.entries.some(entry => entry.text.includes('missing_tool')));
});

test('fractional scan and gather ranges are rejected before world dispatch like the adapter contract', async t => {
  const f = await fixture(t);
  const result = await runWorldAgent({ ...f, instruction: '核对范围', runtime: runtime([
    fauxAssistantMessage([
      fauxToolCall('action', { type: 'scan', maxDistance: 1.5 }),
      fauxToolCall('action', { type: 'gather', block: 'oak_log', maxDistance: 1.5 }),
    ], { stopReason: 'toolUse' }), fauxAssistantMessage('需要整数范围。'),
  ]) });
  assert.deepEqual(f.actions, []); assert.equal(result.actions.length, 0);
  assert.equal(result.toolTrace.length, 2);
  assert.ok(result.toolTrace.every(entry => entry.status === 'error' && entry.error));
});

test('survival action schemas pass through the pi loop without scripted progression', async t => {
  const f = await fixture(t);
  const proposals = [
    { type: 'scan', name: 'oak', kind: 'blocks', maxDistance: 24, count: 4 },
    { type: 'recipes', item: 'crafting_table' },
    { type: 'craft', item: 'oak_planks', count: 4 },
    { type: 'gather', block: 'oak_log', count: 2, maxDistance: 16 },
    { type: 'smelt', input: 'raw_iron', fuel: 'coal', count: 1, position: { x: 1, y: 64, z: 1 } },
    { type: 'container', position: { x: 1, y: 64, z: 1 }, operation: 'list' },
  ];
  const result = await runWorldAgent({ ...f, instruction: '观察并按自己的判断行事', runtime: runtime([
    (context: any) => {
      assert.ok(context.systemPrompt.includes('没有预设的角色分工或固定通关步骤'));
      return fauxAssistantMessage(proposals.map(action => fauxToolCall('action', action)), { stopReason: 'toolUse' });
    }, fauxAssistantMessage('这轮先到这里。'),
  ]) });
  assert.deepEqual(f.actions, proposals);
  assert.ok(result.toolTrace.every(entry => !entry.error));
  const sleep = await runWorldAgent({ ...f, instruction: '休息', runtime: runtime([
    fauxAssistantMessage(fauxToolCall('action', { type: 'sleep', position: { x: 2, y: 64, z: 1 } }), { stopReason: 'toolUse' }), fauxAssistantMessage('结束。'),
  ]) });
  assert.equal(sleep.actions[0].action.type, 'sleep');
});

test('pi dispatches approach for a block or entity and rejects ambiguous or fractional block targets', async t => {
  const f = await fixture(t);
  const valid = [{ type: 'approach', position: { x: 5, y: 64, z: -2 } }, { type: 'approach', entityId: 17 }];
  const invalid = [{ type: 'approach', position: { x: 5.5, y: 64, z: -2 } },
    { type: 'approach', position: { x: 5, y: 64, z: -2 }, entityId: 17 }, { type: 'approach', x: 5, y: 64, z: -2 }];
  const result = await runWorldAgent({ ...f, instruction: '根据观察选择接近目标', runtime: runtime([
    (context: any) => {
      assert.match(context.systemPrompt, /approach只移动/);
      return fauxAssistantMessage([...valid, ...invalid].map(proposal => fauxToolCall('action', proposal)), { stopReason: 'toolUse' });
    }, fauxAssistantMessage('只接近已选择的对象。'),
  ]) });
  assert.deepEqual(f.actions, valid);
  assert.equal(result.toolTrace.filter(entry => entry.status === 'error').length, invalid.length);
  assert.equal(result.actions.length, valid.length);
});

test('pi exposes horizontal travel without accepting an invented target height', async t => {
  const f = await fixture(t), chosen = { type: 'travel', x: 12, z: -4 };
  const result = await runWorldAgent({ ...f, instruction: '自主选择新的观察地点', runtime: runtime([
    (context: any) => {
      assert.match(context.systemPrompt, /不需要事先证明完整路线/);
      return fauxAssistantMessage([fauxToolCall('action', chosen), fauxToolCall('action', { ...chosen, y: 65 })], { stopReason: 'toolUse' });
    }, fauxAssistantMessage('我选择了目的区域。'),
  ]) });
  assert.deepEqual(f.actions, [chosen]); assert.equal(result.toolTrace.filter(entry => entry.error).length, 1);
});

async function seedReview(memory: WorldMemory, prefix = 'before-review', count = 3) {
  for (let i = 0; i < count; i++) await memory.recordProgress(`${prefix}-${i}`, {
    version: 1, start: { health: 10, food: 17, inventory: { cobblestone: 30 + i } },
    end: { health: 10, food: 17, inventory: { cobblestone: 31 + i } }, actions: { gather: 1 },
    checks: [], failures: [], blockChanges: 1, inventoryChanges: [{ item: 'cobblestone', change: 1 }], situationChanges: [],
  });
}
const revisedGoal = { decision: 'replace', reason: '继续重复当前动作尚未消除新的行动限制。',
  goal: '找到另一个实际可到达的观察位置', successCondition: '实际到达另一处并取得新的观察', nextHypothesis: '验证自己选择的东侧区域能否到达。' };

test('goal review cadence survives restart and bookkeeping never enters NPC history', async t => {
  const f = await fixture(t);
  await seedReview(f.memory); assert.equal(f.memory.goalReviewDue(), true);
  await f.memory.checkpointGoalReview('checkpoint');
  let reopened = await WorldMemory.open(f.root, 'Sheldon', 'sheldon');
  assert.equal(reopened.goalReviewDue(), false);
  assert.doesNotMatch(reopened.context('目标审议'), /内部目标审议周期检查点/);
  assert.deepEqual(reopened.recall('内部目标审议周期检查点'), []);
  await seedReview(reopened, 'after', 2); assert.equal(reopened.goalReviewDue(), false);
  await seedReview(reopened, 'last', 1);
  reopened = await WorldMemory.open(f.root, 'Sheldon', 'sheldon'); assert.equal(reopened.goalReviewDue(), true);
});

test('periodic goal review changes only intent and refreshed execution chooses the actual body action', async t => {
  const f = await fixture(t); await seedReview(f.memory);
  await f.memory.rememberIntent('放置炉子', 'goal');
  await f.memory.rememberIntent('炉子已放置，结束这项打算', 'goal', { goalStatus: 'completed' });
  await f.memory.rememberIntent('再获取一批同种资源', 'goal', { completionCondition: '背包增加' });
  let reads = 0;
  f.port.observe = () => ({ health: 10, food: 17, inventory: [{ name: 'cobblestone', count: ++reads === 1 ? 33 : 34 }], recentEvents: [] });
  const result = await runWorldAgent({ ...f, goalReview: true, instruction: '自主协作完成长期世界目标', runtime: runtime([
    (context: any) => {
      assert.deepEqual(context.tools.map((tool: any) => tool.name), ['submit_goal_review']);
      assert.match(JSON.stringify(context.messages), /cobblestone/); assert.equal(f.actions.length, 0);
      const input = JSON.parse(context.messages[0].content[0].text);
      assert.equal(input.currentGoal.text, '再获取一批同种资源');
      assert.match(input.recentGoalHistory, /"status":"completed"/);
      assert.match(input.recentGoalHistory, /炉子已放置/);
      return fauxAssistantMessage(fauxToolCall('submit_goal_review', revisedGoal), { stopReason: 'toolUse' });
    },
    (context: any) => {
      assert.match(context.systemPrompt, /找到另一个实际可到达的观察位置/);
      assert.match(context.systemPrompt, /"cobblestone":34/);
      return fauxAssistantMessage(fauxToolCall('action', { type: 'travel', x: 12, z: 0 }), { stopReason: 'toolUse' });
    }, fauxAssistantMessage('我自行选择了新的行动。'),
  ]) });
  assert.equal(result.goalReview?.status, 'completed'); assert.equal(result.goalReview?.applied, true);
  assert.equal(result.goalReview?.turns, 1); assert.equal(result.turns, 2);
  assert.deepEqual(f.actions, [{ type: 'travel', x: 12, z: 0 }]);
  assert.equal(f.memory.currentIntent().goal?.text, revisedGoal.goal);
  assert.equal(f.memory.entries.find(entry => entry.text === revisedGoal.goal)?.kind, 'intent');
  assert.equal(f.memory.goalReviewDue(), false);
});

test('a recent injury skips review without consuming its cadence checkpoint', async t => {
  const f = await fixture(t); await seedReview(f.memory);
  f.port.observe = () => ({ health: 8, food: 17, recentEvents: [{ id: 'recent-review-injury', type: 'hurt',
    time: new Date().toISOString(), healthBefore: 10, health: 8 }] });
  const result = await runWorldAgent({ ...f, goalReview: true, instruction: '自主应对当前情况', runtime: runtime([
    (context: any) => { assert.ok(context.tools.some((tool: any) => tool.name === 'action')); return fauxAssistantMessage('先处理当下。'); },
  ]) });
  assert.equal(result.goalReview, undefined); assert.equal(f.memory.goalReviewDue(), true);
  assert.ok(!f.memory.entries.some(entry => entry.sourceId?.startsWith('goal-review-checkpoint:')));
});

test('new injury cancels goal deliberation, discards its old answer and reaches the execution agent', async t => {
  const f = await fixture(t), events = livePerception(f.port); await seedReview(f.memory);
  await f.memory.rememberIntent('原先目标', 'goal'); let health = 20;
  f.port.observe = () => ({ health, food: 20, recentEvents: [] });
  const result = await runWorldAgent({ ...f, goalReview: true, instruction: '自主决策', runtime: runtime([
    () => {
      health = 18; events.emit({ id: 'review-injury', type: 'hurt', healthBefore: 20, health });
      return fauxAssistantMessage(fauxToolCall('submit_goal_review', revisedGoal), { stopReason: 'toolUse' });
    },
    (context: any) => {
      assert.equal(liveMessages(context).length, 1); assert.match(context.systemPrompt, /"health":18/);
      return fauxAssistantMessage(fauxToolCall('action', { type: 'wait', ms: 0 }), { stopReason: 'toolUse' });
    }, fauxAssistantMessage('已处理新伤情。'),
  ]) });
  assert.equal(result.goalReview?.status, 'cancelled'); assert.equal(result.status, 'completed');
  assert.equal(f.memory.currentIntent().goal?.text, '原先目标'); assert.equal(f.actions.length, 1);
  assert.equal(f.memory.goalReviewDue(), false); assert.equal(events.count, 0);
});

test('an invalid review consumes one cadence interval and falls through to normal execution', async t => {
  const f = await fixture(t); await seedReview(f.memory);
  const result = await runWorldAgent({ ...f, goalReview: true, instruction: '自主决策', runtime: runtime([
    fauxAssistantMessage('没有结构。'), fauxAssistantMessage('仍没有结构。'),
    fauxAssistantMessage(fauxToolCall('action', { type: 'wait', ms: 0 }), { stopReason: 'toolUse' }), fauxAssistantMessage('继续。'),
  ]) });
  assert.equal(result.goalReview?.status, 'invalid'); assert.equal(result.status, 'completed');
  assert.equal(f.actions.length, 1); assert.equal(f.memory.goalReviewDue(), false);
});

for (const cause of ['hurt', 'parent-cancel']) test(`goal review stops subsequent stale intent writes during ${cause}`, async t => {
  const f = await fixture(t), events = livePerception(f.port), controller = new AbortController();
  await seedReview(f.memory); let health = 20;
  f.port.observe = () => ({ health, food: 20, recentEvents: [] });
  const remember = f.memory.rememberIntent.bind(f.memory);
  t.mock.method(f.memory, 'rememberIntent', async (...args: Parameters<WorldMemory['rememberIntent']>) => {
    const result = await remember(...args);
    if (args[1] === 'goal') {
      if (cause === 'hurt') { health = 18; events.emit({ id: 'review-write-injury', type: 'hurt', healthBefore: 20, health }); }
      else controller.abort();
    }
    return result;
  });
  const result = await runWorldAgent({ ...f, goalReview: true, signal: controller.signal, instruction: '自主决策', runtime: runtime([
    fauxAssistantMessage(fauxToolCall('submit_goal_review', revisedGoal), { stopReason: 'toolUse' }),
    fauxAssistantMessage('我根据新情况再判断。'),
  ]) });
  assert.equal(result.goalReview?.applied, false); assert.equal(result.goalReview?.partialApplied, true);
  assert.ok(!f.memory.entries.some(entry => entry.text === revisedGoal.nextHypothesis));
  assert.ok(!f.memory.entries.some(entry => entry.text.startsWith('目标审议（自己的判断')));
  assert.equal(f.actions.length, 0); assert.equal(result.status, cause === 'hurt' ? 'completed' : 'cancelled');
});

test('the overall decision deadline includes goal review and cannot launch a late body loop', async t => {
  const f = await fixture(t); await seedReview(f.memory);
  const result = await runWorldAgent({ ...f, goalReview: true, timeoutMs: 20, instruction: '自主决策', runtime: runtime([
    async () => { await delay(35); return fauxAssistantMessage(fauxToolCall('submit_goal_review', revisedGoal), { stopReason: 'toolUse' }); },
  ]) });
  assert.equal(result.status, 'cancelled'); assert.equal(result.reason, 'timeout');
  assert.equal(result.turns, 0); assert.equal(f.actions.length, 0);
  assert.ok(!f.memory.entries.some(entry => entry.text === revisedGoal.goal));
});

test('only actual scan coordinates become discovered places; model location notes stay intent', async t => {
  const f = await fixture(t);
  f.port.execute = async action => ({ status: 'completed', action, details: { dimension: 'minecraft:overworld', blocks: [{ name: 'furnace', position: { x: 7, y: 65, z: -2 } }] } });
  await runWorldAgent({ ...f, instruction: '看一下周围', runtime: runtime([
    fauxAssistantMessage([fauxToolCall('action', { type: 'scan', name: 'furnace' }), fauxToolCall('remember', { category: 'place', text: '我猜远处还有一个地点。' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('记住了眼前炉子的位置。'),
  ]) });
  const places = f.memory.entries.filter(entry => entry.topic === 'place');
  assert.ok(places.some(entry => entry.kind === 'fact' && entry.text.includes('"x":7') && entry.text.includes('minecraft:overworld')));
  assert.ok(places.some(entry => entry.kind === 'intent' && entry.text.includes('我猜')));
});

test('repeated information queries survive restart without becoming resource progress or overwriting goals', async t => {
  const f = await fixture(t);
  await f.memory.rememberIntent('我想找到一种继续前进的办法。', 'goal');
  f.port.observe = () => ({ position: { x: 1, y: 64, z: 1 }, health: 20, food: 20, inventory: [] });
  f.port.execute = async action => ({ status: 'completed', action, details: { dimension: 'overworld', origin: { x: 1, y: 64, z: 1 }, blocks: [], entities: [], searchIncomplete: true } });
  for (let round = 0; round < 3; round++) {
    await runWorldAgent({ ...f, instruction: '看看周围', runtime: runtime([
      fauxAssistantMessage([fauxToolCall('action', { type: 'scan', name: 'stone' }), fauxToolCall('action', { type: 'say', message: '看看周围。' })], { stopReason: 'toolUse' }),
      (context: any) => {
        if (round === 2) assert.match(JSON.stringify(context.messages), /同一查询已至少3次返回相同信息/);
        return fauxAssistantMessage('这一轮结束。');
      },
    ]) });
  }
  const restarted = await WorldMemory.open(f.root, 'Sheldon', 'sheldon');
  assert.equal(restarted.recentProgress().length, 3);
  assert.match(restarted.progressContext(), /连续3轮没有记录到背包新增或方块改动/);
  assert.match(restarted.progressContext(), /移动\/扫描\/聊天次数不等于资源进展/);
  assert.equal(restarted.entries.filter(entry => entry.topic === 'goal').length, 1);
  assert.equal(restarted.entries.find(entry => entry.topic === 'goal')?.kind, 'intent');
  assert.ok(!restarted.recall('本轮执行统计').some(entry => entry.progress));
  assert.equal((await WorldMemory.open(f.root, 'Sherlock', 'sherlock')).recentProgress().length, 0);
  // A later observed gain is a real state change; saying success never was one.
  let collected = false;
  f.port.observe = () => ({ position: { x: 1, y: 64, z: 1 }, inventory: collected ? [{ name: 'dirt', count: 1 }] : [] });
  f.port.execute = async action => { collected = true; return { status: 'completed', action, details: { minedBlocks: 1, inventoryDelta: [{ item: 'dirt', change: 1 }] } }; };
  await runWorldAgent({ ...f, instruction: '按自己的判断做一件事', runtime: runtime([
    fauxAssistantMessage(fauxToolCall('action', { type: 'gather', block: 'dirt', count: 1 }), { stopReason: 'toolUse' }), fauxAssistantMessage('结束。'),
  ]) });
  const latest = f.memory.recentProgress(1)[0];
  assert.equal(latest.blockChanges, 1); assert.equal(latest.end.inventory?.dirt, 1);
  assert.ok(!f.memory.progressContext().includes('连续4轮没有记录到背包新增'));
});

test('hurt receipts and death/respawn are physical changes that trigger goal review without inferring an attacker', async t => {
  const f = await fixture(t);
  await f.memory.rememberIntent('继续之前的探索目标。', 'goal');
  let damaged = false;
  const hurt = { id: 'hurt-new', type: 'hurt', healthBefore: 20, health: 7, food: 17, loss: 13 };
  f.port.observe = () => ({ health: damaged ? 7 : 20, food: damaged ? 17 : 20, inventory: [{ name: 'wooden_pickaxe', count: 1 }], recentEvents: damaged ? [hurt] : [] });
  f.port.execute = async action => { damaged = true; return { status: 'failed', action, error: '被打断', details: { vitals: { healthBefore: 20, health: 7, food: 17 } } }; };
  await runWorldAgent({ ...f, instruction: '自主继续', runtime: runtime([
    fauxAssistantMessage(fauxToolCall('action', { type: 'wait', ms: 1 }), { stopReason: 'toolUse' }),
    (context: any) => {
      assert.match(JSON.stringify(context.messages), /身体状况已改变/);
      assert.match(JSON.stringify(context.messages), /生命20→7|生命下降：20→7/);
      return fauxAssistantMessage('重新判断眼下的事。');
    },
  ]) });
  const injured = f.memory.recentProgress(1)[0];
  assert.equal(injured.end.health, 7); assert.equal(injured.end.food, 17);
  assert.ok(injured.situationChanges.some(change => change.includes('生命下降')));
  assert.ok(f.memory.entries.some(entry => entry.kind === 'fact' && entry.text.includes('"type":"hurt"')));
  assert.ok(!JSON.stringify(injured).includes('Skeleton'));
  f.port.observe = () => ({ health: 20, food: 20, inventory: [], recentEvents: [hurt, { id: 'death-new', type: 'death' }, { id: 'respawn-new', type: 'respawn' }] });
  await runWorldAgent({ ...f, instruction: '自主继续', runtime: runtime([
    (context: any) => {
      assert.match(context.systemPrompt, /重大情境变化/); assert.match(context.systemPrompt, /世界事件：death/);
      assert.match(context.systemPrompt, /自主复核旧goal\/plan是否还适用/);
      return fauxAssistantMessage('先看看现在的身体。');
    },
  ]) });
  const last = f.memory.recentProgress(1)[0];
  assert.deepEqual(last.end.inventory, {});
  assert.ok(last.situationChanges.includes('世界事件：respawn'));
  assert.equal(f.memory.entries.filter(entry => entry.sourceId === 'event:hurt-new').length, 1);
  assert.equal(f.memory.entries.filter(entry => entry.topic === 'goal').length, 1);
});

test('compact observations preserve terrain tuples, immediate hurt/death and identified drops ahead of grass detail', () => {
  const raw = { health: 4, food: 17, inventory: [{ name: 'wooden_pickaxe', count: 1 }],
    nearbyEntities: [{ id: 10, name: 'item', droppedItem: { name: 'crafting_table', count: 1 } }],
    nearbyBlocks: Array.from({ length: 100 }, (_, i) => ({ name: 'grass_block', x: i, y: 64, z: i })),
    localTerrain: { scope: 'visible-loaded-local', origin: [0, 65, 0], radius: 3, routeUnverified: true,
      standable: Array.from({ length: 6 }, (_, i) => ({ feet: [i + 0.5, 65, 0.5], deltaY: 0, support: 'grass_block' })),
      placeable: Array.from({ length: 6 }, (_, i) => ({ target: [i, 65, 1], reference: [i, 64, 1], face: [0, 1, 0] })),
      hazards: [{ position: [1, 64, 2], name: 'lava' }, { position: [2, 64, 2], name: 'fire' }, { position: [3, 64, 2], name: 'cactus' }] },
    recentEvents: [{ id: 'hurt-critical', type: 'hurt', healthBefore: 20, health: 4, food: 17, loss: 16 }, { id: 'dead-critical', type: 'death' },
      ...Array.from({ length: 20 }, (_, i) => ({ id: `heard-${i}`, type: 'heard', speaker: 'Friend', message: '普通聊天'.repeat(100) }))] };
  const compact = compactObservation(raw, 3000);
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) <= 3000);
  assert.equal(compact.localTerrain.routeUnverified, true);
  assert.ok(compact.localTerrain.standable.length > 0 && compact.localTerrain.standable.length <= 3);
  assert.ok(compact.localTerrain.placeable.length > 0 && compact.localTerrain.placeable.length <= 3);
  assert.deepEqual(compact.localTerrain.standable[0].feet, [0.5, 65, 0.5]);
  assert.deepEqual(compact.localTerrain.placeable[0].target, [0, 65, 1]);
  assert.ok(compact.recentEvents.some((event: any) => event.type === 'hurt'));
  assert.ok(compact.recentEvents.some((event: any) => event.type === 'death'));
  assert.equal(compact.nearbyEntities[0].droppedItem.name, 'crafting_table');
  // Progress uses complete real inventory even if the presentation was shortened.
  assert.equal(progressState({ inventory: [{ name: 'dirt', count: 1 }, { name: 'dirt', count: 2 }] }).inventory?.dirt, 3);
});

test('pi supports air-use and block-face interaction and rejects conflicting aim or entity faces before execution', async t => {
  const f = await fixture(t);
  const valid = [
    { type: 'use_item', item: 'ender_eye', direction: { x: 0, y: 1, z: 1 }, durationMs: 0 },
    { type: 'use_item', hand: 'off', position: { x: 1, y: 65, z: 2 }, durationMs: 100 },
    { type: 'interact', x: 1, y: 64, z: 2, direction: { x: 0, y: 1, z: 0 } },
  ];
  const invalid = [
    { type: 'use_item', position: { x: 1, y: 1, z: 1 }, direction: { x: 0, y: 1, z: 0 } },
    { type: 'interact', x: 1, y: 64, z: 2, direction: { x: 1, y: 1, z: 0 } },
    { type: 'interact', entityId: 10, direction: { x: 0, y: 1, z: 0 } },
  ];
  const result = await runWorldAgent({ ...f, instruction: '接口测试', runtime: runtime([
    fauxAssistantMessage([...valid, ...invalid].map(action => fauxToolCall('action', action)), { stopReason: 'toolUse' }),
    fauxAssistantMessage('测试结束。'),
  ]) });
  assert.deepEqual(f.actions, valid);
  assert.equal(result.toolTrace.filter(trace => trace.status === 'error').length, invalid.length);
});

test('automatic history keeps useful places but excludes stale intent and temporary states without erasing explicit recall', async t => {
  const f = await fixture(t);
  await f.memory.add('fact', 'audit-furnace：过去发现的炉子位置，需要重访核实。', 'place:audit-furnace', undefined, 'place');
  await f.memory.rememberIntent('audit-old-plan：背包还空，等别人把材料带来。', 'plan');
  const goal = 'audit-goal：我想制作木镐，这是此前未复核的意图。';
  await f.memory.rememberIntent(goal, 'goal');
  await f.memory.add('fact', '本角色亲眼观察：audit-old-inventory：当时背包为空。', 'observation:old-snapshot:old-turn');
  await f.memory.recordAction({ id: 'old-action', action: { type: 'craft', item: 'wooden_pickaxe' }, status: 'failed', error: 'audit-old-receipt：当时材料不足。' });
  await f.memory.add('hearsay', 'audit-old-rumour：队友当时声称我还没有工具。');
  for (let i = 0; i < 25; i++) await f.memory.add('fact', `unrelated historical event ${i}`);
  const plan = '最新计划：已有工具，接下来先复核当前情况。' + '细节保留。'.repeat(95);
  await f.memory.rememberIntent(plan, 'plan');
  for (let i = 0; i < 3; i++) await f.memory.add('hearsay', `最近的同伴原话 ${i}：` + '我有一些新观察。'.repeat(65));
  await f.memory.add('fact', '本角色亲眼观察：audit-new-inventory：现有木镐1、圆石9。', 'observation:new-snapshot:new-turn');
  const before = JSON.stringify(f.memory.entries);
  const context = f.memory.context('audit');
  assert.ok(context.length <= 4500);
  assert.ok(context.includes(plan), 'the complete latest plan must get priority over long teammate prose');
  assert.ok(context.indexOf(plan) < context.indexOf(goal));
  assert.ok(context.includes(goal)); assert.match(context, /当前有效目标/);
  assert.match(context, /audit-furnace/); assert.match(context, /audit-new-inventory/);
  for (const old of ['audit-old-plan', 'audit-old-inventory', 'audit-old-receipt', 'audit-old-rumour']) {
    assert.ok(!context.includes(old), `${old} must not be automatically revived`);
    assert.ok(f.memory.recall(old, 100).some(entry => entry.text.includes(old)), `${old} remains explicitly retrievable`);
  }
  assert.equal(JSON.stringify(f.memory.entries), before, 'context construction may not rewrite any goal or historical entry');
});

test('goal replacement and completion stop old plans while legacy records and explicit recall remain intact', async t => {
  const f = await fixture(t);
  // These are the pre-lifecycle JSONL shape, with neither status nor goalId.
  await f.memory.add('intent', 'legacy-goal：寻找一个休息地点。', undefined, undefined, 'goal');
  await f.memory.add('intent', 'legacy-plan：先查看石桥。', undefined, undefined, 'plan');
  const original = await readFile(f.memory.file, 'utf8');
  const restored = await WorldMemory.open(f.root, 'Sheldon', 'sheldon');
  assert.match(restored.context('下一步'), /legacy-goal/); assert.match(restored.context('下一步'), /legacy-plan/);
  const goal = await restored.rememberIntent('replacement-goal：和同伴确认新的约定。', 'goal', { completionCondition: '听到对方明确答复。' });
  const plan = await restored.rememberIntent('replacement-plan：提出问题并等答复。', 'plan');
  assert.equal(goal!.goalId, goal!.id); assert.equal(plan!.goalId, goal!.id);
  const active = restored.context('legacy-goal legacy-plan');
  assert.doesNotMatch(active.split('最近目标变更')[0], /legacy-goal|legacy-plan/); assert.match(active, /replacement-plan/);
  assert.match(active, /"status":"replaced"/); assert.doesNotMatch(active, /legacy-plan/);
  assert.match(active, /听到对方明确答复/);
  await restored.rememberIntent('closed-judgment：我认为这个约定已确认。', 'goal', { goalStatus: 'completed', goalId: goal!.id });
  const restarted = await WorldMemory.open(f.root, 'Sheldon', 'sheldon');
  const context = restarted.context('legacy replacement closed-judgment');
  assert.doesNotMatch(context, /legacy-plan|replacement-plan/);
  assert.match(context, /closed-judgment/); assert.match(context, /"status":"completed"/);
  assert.match(context.split('最近目标变更')[0], /当前没有有效goal或plan/);
  assert.ok(restarted.recall('legacy-plan', 20).some(entry => entry.text.includes('legacy-plan')));
  assert.ok(restarted.recall('replacement-plan', 20).some(entry => entry.text.includes('replacement-plan')));
  assert.equal(restarted.entries.at(-1)!.kind, 'intent'); assert.equal(restarted.entries.at(-1)!.goalStatus, 'completed');
  assert.equal((await readFile(f.memory.file, 'utf8')).startsWith(original), true, 'Legacy history is untouched, not migrated or rewritten.');
  assert.equal(restarted.entries.length, 5);
});

test('completed furnace intent stays visible after restart ahead of an older unfinished review note', async t => {
  const f = await fixture(t);
  await f.memory.rememberIntent('在工作台旁合成并放置炉子。', 'goal', { completionCondition: '炉子实际放置成功。' });
  await f.memory.rememberIntent('旧放炉计划：拿出背包里的炉子寻找放置点。', 'plan');
  await f.memory.rememberIntent('旧审议理由：炉子还在背包，放置条件尚未满足。', 'note');
  await f.memory.rememberIntent('最新结束判断：炉子已在(-178,66,-106)放好。', 'goal', { goalStatus: 'completed' });
  const before = await readFile(f.memory.file, 'utf8');
  const restored = await WorldMemory.open(f.root, 'Sheldon', 'sheldon');
  const history = restored.goalHistoryContext();
  assert.match(history, /"status":"completed"/); assert.match(history, /最新结束判断/);
  assert.doesNotMatch(history, /旧放炉计划|旧审议理由/);
  assert.equal(restored.currentIntent().goal, undefined);
  await runWorldAgent({ ...f, memory: restored, instruction: '结合现在的情况继续决定', runtime: runtime([
    (context: any) => {
      const memory = /<独立世界记忆>\n([\s\S]*?)\n<\/独立世界记忆>/u.exec(context.systemPrompt)![1];
      assert.match(memory, /当前没有有效goal或plan/);
      assert.ok(memory.indexOf('最新结束判断') < memory.indexOf('旧审议理由'));
      assert.match(memory, /结束\/替换记录覆盖旧审议note/);
      assert.doesNotMatch(memory, /旧放炉计划/);
      return fauxAssistantMessage('已结束的局部目标仅作历史，接下来结合当前身体作决定。');
    },
  ]) });
  assert.equal(restored.entries.filter(entry => entry.kind === 'intent').length, 4);
  assert.equal((await readFile(f.memory.file, 'utf8')).startsWith(before), true);
});

test('goal history keeps only recent transitions, ignores same-goal revisions, and stays bounded without writes', async t => {
  const f = await fixture(t);
  await f.memory.add('intent', '最早的旧版目标', undefined, undefined, 'goal');
  await f.memory.rememberIntent('第二个目标', 'goal');
  const third = await f.memory.rememberIntent('第三个目标', 'goal');
  await f.memory.rememberIntent('第三个目标的修订', 'goal', { goalId: third!.id });
  await f.memory.rememberIntent('放弃第三个目标：依赖已改变', 'goal', { goalStatus: 'abandoned' });
  await f.memory.rememberIntent('第四个目标', 'goal');
  await f.memory.rememberIntent('完成第四个目标：已观察到预期结果', 'goal', { goalStatus: 'completed' });
  const active = await f.memory.rememberIntent('当前探索目标', 'goal');
  await f.memory.rememberIntent('完整当前计划：' + '保留自主选择。'.repeat(65), 'plan');
  const before = await readFile(f.memory.file, 'utf8');
  const history = f.memory.goalHistoryContext();
  const rows = history.split('\n').slice(1).map(line => JSON.parse(line));
  assert.equal(rows.length, 3); assert.deepEqual(rows.map(row => row.status), ['completed', 'abandoned', 'replaced']);
  assert.equal(rows[0].goal, '第四个目标'); assert.equal(rows[1].goal, '第三个目标的修订');
  assert.equal(rows[2].goal, '第二个目标');
  assert.ok(rows.every(row => row.kind === 'intent' && row.goalId !== active!.id));
  assert.doesNotMatch(history, /最早的旧版目标|当前探索目标|完整当前计划/);
  const context = f.memory.context('目标');
  assert.ok(context.length <= 4500);
  assert.ok(context.indexOf('完整当前计划') < context.indexOf('最近目标变更'));
  assert.match(context.split('最近目标变更')[0], /当前探索目标/);
  for (const budget of [0, 100, 500, 800, 1100]) {
    const bounded = f.memory.goalHistoryContext(budget);
    assert.ok(bounded.length <= budget);
    for (const line of bounded.split('\n').slice(1)) assert.doesNotThrow(() => JSON.parse(line));
  }
  assert.equal(await readFile(f.memory.file, 'utf8'), before, 'History projection never appends synthetic replacement entries.');
});

test('goal revisions clear stale plans, abandonment does not resume older goals, and invalid links are rejected', async t => {
  const f = await fixture(t);
  const first = await f.memory.rememberIntent('first-goal', 'goal');
  await f.memory.rememberIntent('first-plan', 'plan');
  const current = await f.memory.rememberIntent('current-goal', 'goal', { completionCondition: '自己选的观察条件' });
  await f.memory.rememberIntent('before-revision-plan', 'plan');
  await f.memory.rememberIntent('revised-goal', 'goal', { goalId: current!.id, goalStatus: 'active' });
  const revised = f.memory.context('plan goal');
  assert.match(revised, /revised-goal/); assert.match(revised, /自己选的观察条件/);
  assert.doesNotMatch(revised.split('最近目标变更')[0], /first-goal|first-plan|before-revision-plan/);
  assert.doesNotMatch(revised, /first-plan|before-revision-plan/);
  await assert.rejects(f.memory.rememberIntent('stale association', 'plan', { goalId: first!.id }), /不是当前有效目标/);
  await assert.rejects(f.memory.rememberIntent('not a goal', 'plan', { goalStatus: 'completed' }), /只能用于/);
  await f.memory.rememberIntent('abandon-current', 'goal', { goalStatus: 'abandoned' });
  const abandoned = f.memory.context('goal plan');
  assert.doesNotMatch(abandoned.split('最近目标变更')[0], /first-goal|revised-goal|before-revision-plan/);
  assert.match(abandoned, /"status":"abandoned"/); assert.doesNotMatch(abandoned, /before-revision-plan/);
  await assert.rejects(f.memory.rememberIntent('close twice', 'goal', { goalStatus: 'completed' }), /没有可完成或放弃/);
  const independent = await f.memory.rememberIntent('new-unbound-plan', 'plan');
  assert.equal(independent!.goalId, null); assert.match(f.memory.context('下一步'), /new-unbound-plan/);
  await f.memory.rememberIntent('next-goal', 'goal');
  assert.doesNotMatch(f.memory.context('下一步'), /new-unbound-plan/);
});

test('pi remember accepts optional goal criteria and completion remains intent, never world victory', async t => {
  const f = await fixture(t);
  const result = await runWorldAgent({ ...f, instruction: '自己判断一个局部目标', runtime: runtime([
    fauxAssistantMessage(fauxToolCall('remember', { category: 'goal', text: '我想确认附近的声音来源。',
      completionCondition: '亲耳听到对方说明。' }), { stopReason: 'toolUse' }),
    (context: any) => {
      const saved = JSON.parse(context.messages.findLast((message: any) => message.role === 'toolResult').content[0].text);
      assert.equal(saved.kind, 'intent'); assert.equal(saved.goalStatus, 'active'); assert.equal(saved.goalId, saved.id);
      return fauxAssistantMessage(fauxToolCall('remember', { category: 'plan', text: '先问一句。', goalId: saved.goalId }), { stopReason: 'toolUse' });
    },
    fauxAssistantMessage(fauxToolCall('remember', { category: 'goal', text: '我认为这个局部目标已完成。', goalStatus: 'completed' }), { stopReason: 'toolUse' }),
    (context: any) => {
      const saved = JSON.parse(context.messages.findLast((message: any) => message.role === 'toolResult').content[0].text);
      assert.equal(saved.kind, 'intent'); assert.equal(saved.goalStatus, 'completed');
      assert.equal(saved.completionCondition, '亲耳听到对方说明。');
      return fauxAssistantMessage('局部判断已记下。');
    },
  ]) });
  assert.equal(result.status, 'completed'); assert.equal(result.actions.length, 0);
  assert.equal(f.memory.entries.filter(entry => entry.kind === 'intent').length, 3);
  const context = f.memory.context('声音 先问 局部目标');
  assert.doesNotMatch(context, /先问一句/); assert.match(context, /我认为这个局部目标已完成/);
  assert.match(context, /历史意图判断，不是活动目标或世界事实/);
  assert.ok(!f.memory.entries.some(entry => entry.kind === 'fact' && entry.text.includes('这个局部目标已完成')));
});

test('progress keeps death and retained resource losses visible despite pickups and legacy event records', async t => {
  const f = await fixture(t);
  const report = (start: any, end: any, inventoryChanges: any[] = []) => ({ version: 1 as const, start, end,
    actions: { goto: 1 }, checks: [], failures: [], blockChanges: 0, inventoryChanges, situationChanges: [] });
  const before = { health: 4, inventory: { cobblestone: 9, wooden_pickaxe: 1 } };
  const dying = { health: 0, inventory: { ...before.inventory, stick: 1 } };
  // The legacy event has no eventType field; re-ingestion must not count it twice.
  await f.memory.add('fact', '本角色收到世界事件：{"type":"death"}', 'event:death-retention');
  await f.memory.recordProgress('dying-pickup', report(before, dying, [{ item: 'stick', change: 1 }]));
  await f.memory.ingestEvents([{ id: 'death-retention', type: 'death' }]);
  await f.memory.recordProgress('respawn-pickup', report({ health: 20, inventory: {} }, { health: 20, inventory: { oak_sapling: 1 } }, [{ item: 'oak_sapling', change: 1 }]));
  const restored = await WorldMemory.open(f.root, 'Sheldon', 'sheldon');
  const context = restored.progressContext(undefined, [], 5000);
  const retention = JSON.parse(context.split('\n')[0].split('近期死亡与资源保有：')[1]);
  assert.equal(retention.deathEvents, 1); assert.equal(retention.inventoryComparisonKnown, true);
  assert.deepEqual(retention.netRetainedDelta, [{ item: 'cobblestone', change: -9 }, { item: 'oak_sapling', change: 1 }, { item: 'wooden_pickaxe', change: -1 }]);
  assert.ok(retention.observedInventoryDecreases.some((item: any) => item.item === 'stick' && item.change === -1));
  assert.match(context, /零星拾取或方块改动不抵消死亡与背包减少/);
  assert.match(context, /"receiptInventoryDelta":\[{"item":"stick","change":1}\]/, 'The original pickup is still visible.');
  assert.match(context, /不推断原因或资源价值/);
  for (let i = 0; i < 7; i++) await restored.recordProgress(`later-${i}`, report({ inventory: {} }, { inventory: {} }));
  const later = JSON.parse(restored.progressContext().split('\n')[0].split('近期死亡与资源保有：')[1]);
  assert.equal(later.deathEvents, 0, 'Death counts cover the same recent window as the six progress reports.');
});

test('unknown inventory never turns into a confirmed retained loss', async t => {
  const f = await fixture(t);
  await f.memory.recordProgress('unsynced-holdings', { version: 1, start: { inventory: { oak_log: 9 } }, end: {},
    actions: { craft: 1 }, checks: [], failures: [], blockChanges: 0, inventoryChanges: [], situationChanges: [] });
  const context = f.memory.progressContext({ inventory: undefined });
  const retention = JSON.parse(context.split('\n')[0].split('近期死亡与资源保有：')[1]);
  assert.equal(retention.inventoryComparisonKnown, false); assert.deepEqual(retention.netRetainedDelta, []);
  assert.deepEqual(retention.observedInventoryDecreases, []); assert.equal(retention.unknownTransitions, 2);
});

test('current body summary survives a large system prompt and later physical receipts retain temporal priority', async t => {
  const f = await fixture(t);
  await f.memory.rememberIntent('旧目标声称背包为空、木镐尚未制作。', 'goal');
  f.persona.prompt = '人格参考。'.repeat(6000);
  let health = 14;
  f.port.observe = () => ({ time: '2026-10-02T01:00:00Z', dimension: 'overworld', timeOfDay: 998, dayPhase: 'day', position: { x: 1, y: 64, z: 2 }, health, food: 17,
    inventory: [{ name: 'wooden_pickaxe', count: 1 }, { name: 'oak_log', count: 2 }, { name: 'cobblestone', count: 9 }],
    equipment: { hand: { name: 'wooden_pickaxe', count: 1 } } });
  f.port.execute = async action => { health = 5; return { status: 'completed', action, details: { vitals: { healthBefore: 14, health: 5, food: 17 } } }; };
  await runWorldAgent({ ...f, instruction: '自主决定下一步', runtime: runtime([
    (context: any) => {
      assert.ok(context.systemPrompt.length <= 24000);
      assert.ok(context.systemPrompt.endsWith('</本轮执行预算>'));
      const body = JSON.parse(/\n(\{[^\n]+\})\n<\/本轮起点身体状态>/u.exec(context.systemPrompt)![1]);
      assert.deepEqual(body.inventory, { cobblestone: 9, oak_log: 2, wooden_pickaxe: 1 });
      assert.equal(body.health, 14); assert.equal(body.equipment.hand.name, 'wooden_pickaxe');
      assert.equal(body.dayPhase, 'day'); assert.equal(body.timeOfDay, 998);
      assert.match(context.systemPrompt, /覆盖旧记忆、旧goal\/plan/);
      assert.match(context.systemPrompt, /后续更新的observe和执行回执优先/);
      return fauxAssistantMessage(fauxToolCall('action', { type: 'wait', ms: 1 }), { stopReason: 'toolUse' });
    },
    (context: any) => {
      assert.ok(JSON.stringify(context.messages).includes('\\"health\\":5'), 'new action vitals remain visible even while the start-of-turn summary stays fixed');
      return fauxAssistantMessage('先重新判断身体状况。');
    },
  ]) });
  assert.equal(f.memory.entries.filter(entry => entry.topic === 'goal').length, 1);
  assert.equal(f.memory.recentProgress(1)[0].end.health, 5);
});

test('body summary distinguishes unknown, empty and partially displayed inventory', () => {
  const decode = (text: string) => JSON.parse(/\n(\{[^\n]+\})\n<\/本轮起点身体状态>$/u.exec(text)![1]);
  assert.equal(Object.hasOwn(decode(currentBodyContext({}, {})), 'inventory'), false);
  assert.deepEqual(decode(currentBodyContext({}, { inventory: {} })).inventory, {});
  const inventory = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`item_${String(i).padStart(3, '0')}_${'x'.repeat(50)}`, i + 1]));
  const summary = currentBodyContext({ equipment: {} }, { health: 20, food: 20, inventory });
  const body = decode(summary);
  assert.ok(body.inventoryOmitted > 0);
  assert.equal(Object.keys(body.inventory).length + body.inventoryOmitted, 100);
  assert.match(summary, /未列物品不能视为没有/);
  assert.ok(summary.length < 2000);
  assert.equal(Object.keys(inventory).length, 100);
});

for (const failed of [false, true]) test(`newly consumed injury permits just one reserved physical attempt after six actions (${failed ? 'failed attempt' : 'successful attempt'})`, async t => {
  const f = await fixture(t), events = livePerception(f.port); let health = 20, requests = 0;
  f.port.observe = () => ({ health, food: 17, recentEvents: [] });
  f.port.execute = async action => {
    f.actions.push(action);
    if (f.actions.length === 6) {
      health = 18; events.emit({ id: 'quota-hit', type: 'hurt', healthBefore: 20, health });
    }
    if (action.type === 'goto') {
      health = 16; events.emit({ id: 'second-quota-hit', type: 'hurt', healthBefore: 18, health });
      if (failed) throw new Error('physical obstruction');
    }
    return { status: 'completed', action };
  };
  const result = await runWorldAgent({ ...f, instruction: '自主行动', runtime: runtime([
    () => { requests++; return fauxAssistantMessage(Array.from({ length: 7 }, () => fauxToolCall('action', { type: 'wait', ms: 1 })), { stopReason: 'toolUse' }); },
    (context: any) => {
      requests++; assert.equal(liveMessages(context).length, 1);
      assert.match(JSON.stringify(liveMessages(context)), /普通预算已到边界/);
      return fauxAssistantMessage([
        fauxToolCall('action', { type: 'scan', kind: 'blocks', name: 'stone' }),
        fauxToolCall('action', { type: 'say', message: '现在重新考虑。' }),
        fauxToolCall('action', { type: 'broadcast', message: '我受到伤害。' }),
        fauxToolCall('action', { type: 'goto', x: 1, y: 64, z: 0 }),
        fauxToolCall('action', { type: 'goto', x: 2, y: 64, z: 0 }),
      ], { stopReason: 'toolUse' });
    },
    () => { assert.fail('A used emergency reserve must not refill after another injury.'); },
  ]) });
  assert.equal(requests, 2); assert.equal(result.turns, 2);
  assert.deepEqual(f.actions.map(action => action.type), [...Array(6).fill('wait'), 'goto']);
  assert.equal(result.actions.at(-1).status, failed ? 'failed' : 'completed');
  assert.deepEqual(result.emergencyBudget, { actionsUsed: 1, modelTurnsUsed: 0 });
  assert.ok(result.toolTrace.some(row => row.error?.includes('此前排定的身体动作未执行')));
  assert.equal(events.count, 0);
});

test('hurt queued at the end of the eighth model turn gets one consumed ninth response, never a tenth', async t => {
  const f = await fixture(t), events = livePerception(f.port); let health = 20;
  f.port.observe = () => ({ health, food: 17, recentEvents: [] });
  const result = await runWorldAgent({ ...f, instruction: '自主行动', runtime: runtime([
    ...Array.from({ length: 7 }, () => fauxAssistantMessage(fauxToolCall('observe', {}), { stopReason: 'toolUse' })),
    () => {
      health = 18; events.emit({ id: 'last-ordinary-turn', type: 'hurt', healthBefore: 20, health });
      return fauxAssistantMessage(fauxToolCall('action', { type: 'goto', x: 99, y: 64, z: 0 }), { stopReason: 'toolUse' });
    },
    (context: any) => {
      assert.equal(liveMessages(context).length, 1, 'Enqueued alone is insufficient: the ninth request must receive it.');
      health = 16; events.emit({ id: 'last-reserved-turn', type: 'hurt', healthBefore: 18, health });
      return fauxAssistantMessage([
        fauxToolCall('observe', {}),
        fauxToolCall('action', { type: 'goto', x: 1, y: 64, z: 0 }),
        fauxToolCall('action', { type: 'goto', x: 2, y: 64, z: 0 }),
      ], { stopReason: 'toolUse' });
    },
    () => { assert.fail('Repeated damage cannot extend to ten model requests.'); },
  ]) });
  assert.equal(result.turns, 9); assert.equal(result.reason, 'budget');
  assert.deepEqual(f.actions.map(action => action.x), [99, 1], 'turn eight uses an ordinary generation window; only consumed steering unlocks turn nine');
  assert.deepEqual(result.emergencyBudget, { actionsUsed: 1, modelTurnsUsed: 1 });
  assert.equal(events.count, 0);
});

test('already consumed or duplicate hurt cannot extend the eighth turn or grant a later seventh action', async t => {
  const f = await fixture(t), events = livePerception(f.port);
  const injury = { id: 'old-consumed-hit', type: 'hurt', healthBefore: 20, health: 18 };
  f.port.observe = () => ({ health: 18, food: 17, recentEvents: [] });
  const result = await runWorldAgent({ ...f, instruction: '自主行动', runtime: runtime([
    () => { events.emit(injury); return fauxAssistantMessage(fauxToolCall('observe', {}), { stopReason: 'toolUse' }); },
    () => fauxAssistantMessage(Array.from({ length: 6 }, () => fauxToolCall('action', { type: 'wait', ms: 1 })), { stopReason: 'toolUse' }),
    ...Array.from({ length: 5 }, () => fauxAssistantMessage(fauxToolCall('observe', {}), { stopReason: 'toolUse' })),
    () => { events.emit(injury); return fauxAssistantMessage(fauxToolCall('action', { type: 'goto', x: 9, y: 64, z: 0 }), { stopReason: 'toolUse' }); },
    () => { assert.fail('An old notice is not an emergency extension.'); },
  ]) });
  assert.equal(result.turns, 8); assert.equal(f.actions.length, 6);
  assert.deepEqual(result.emergencyBudget, { actionsUsed: 0, modelTurnsUsed: 0 });
});

test('ordinary tool quota cannot strand a newly informed physical response or hide it behind a rejected query', async t => {
  const f = await fixture(t), events = livePerception(f.port); let reads = 0;
  f.port.observe = () => {
    if (++reads === 25) events.emit({ id: 'tool-quota-hit', type: 'hurt', healthBefore: 20, health: 18 });
    return { health: reads >= 25 ? 18 : 20, food: 17, recentEvents: [] };
  };
  const result = await runWorldAgent({ ...f, instruction: '自主行动', runtime: runtime([
    fauxAssistantMessage(Array.from({ length: 24 }, () => fauxToolCall('observe', {})), { stopReason: 'toolUse' }),
    (context: any) => {
      assert.equal(liveMessages(context).length, 1);
      return fauxAssistantMessage([
        fauxToolCall('observe', {}),
        fauxToolCall('action', { type: 'goto', x: 1, y: 64, z: 0 }),
        fauxToolCall('action', { type: 'goto', x: 2, y: 64, z: 0 }),
      ], { stopReason: 'toolUse' });
    },
  ]) });
  assert.equal(result.turns, 2); assert.equal(f.actions.length, 1);
  assert.deepEqual(result.emergencyBudget, { actionsUsed: 1, modelTurnsUsed: 0 });
  assert.equal(result.toolTrace.length, 25);
  assert.ok(result.toolTrace.some(row => row.name === 'action' && row.status === 'completed' && row.args.includes('"x":1')));
});

for (const speech of ['say', 'broadcast']) test(`${speech} in an informed response does not spend the physical injury window`, async t => {
  const f = await fixture(t), events = livePerception(f.port); let health = 20;
  f.port.observe = () => ({ health, food: 17, recentEvents: [] });
  f.port.execute = async action => {
    f.actions.push(action);
    if (action.type === speech) { health = 16; events.emit({ id: 'hit-during-speech', type: 'hurt', healthBefore: 18, health }); }
    return { status: 'completed', action };
  };
  const result = await runWorldAgent({ ...f, instruction: '自主行动', runtime: runtime([
    () => { health = 18; events.emit({ id: 'before-speech', type: 'hurt', healthBefore: 20, health }); return fauxAssistantMessage(fauxToolCall('observe', {}), { stopReason: 'toolUse' }); },
    fauxAssistantMessage([fauxToolCall('action', { type: speech, message: '我需要移动。' }), fauxToolCall('action', { type: 'goto', x: 1, y: 64, z: 0 })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('继续观察。'),
  ]) });
  assert.deepEqual(f.actions.map(action => action.type), [speech, 'goto']);
  assert.equal(result.emergencyBudget.actionsUsed, 0);
});

test('death cancellation still ends an executing reserved action without a replacement', async t => {
  const f = await fixture(t), events = livePerception(f.port), controller = new AbortController();
  f.port.execute = async (action, _id, signal) => {
    f.actions.push(action);
    if (f.actions.length === 6) events.emit({ id: 'before-last-action', type: 'hurt', healthBefore: 20, health: 18 });
    if (action.type === 'goto') {
      controller.abort(); assert.equal(signal.aborted, true);
      return { status: 'cancelled', action };
    }
    return { status: 'completed', action };
  };
  const result = await runWorldAgent({ ...f, signal: controller.signal, instruction: '自主行动', runtime: runtime([
    fauxAssistantMessage(Array.from({ length: 6 }, () => fauxToolCall('action', { type: 'wait', ms: 1 })), { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxToolCall('action', { type: 'goto', x: 1, y: 64, z: 0 }), fauxToolCall('action', { type: 'goto', x: 2, y: 64, z: 0 })], { stopReason: 'toolUse' }),
  ]) });
  assert.equal(result.status, 'cancelled'); assert.equal(f.actions.length, 7);
  assert.equal(result.emergencyBudget.actionsUsed, 1); assert.equal(events.count, 0);
});

test('hurt interrupts a long body action, blocks its queued stale action and permits a newly informed decision', async t => {
  const f = await fixture(t), events = livePerception(f.port);
  let health = 20, interrupts = 0, firstSignal: AbortSignal | undefined;
  let finishBody: (() => void) | undefined;
  f.port.observe = () => ({ health, food: 17, position: { x: 0, y: 64, z: 0 }, recentEvents: [] });
  f.port.interruptAction = () => { interrupts++; finishBody?.(); };
  f.port.execute = async (action, _id, signal) => {
    f.actions.push(action);
    if (f.actions.length > 1) return { status: 'completed', action };
    firstSignal = signal;
    return new Promise(resolve => {
      finishBody = () => resolve({ status: 'cancelled', action, error: '身体行动因新感知中断', details: { vitals: { healthBefore: 20, health: 16, food: 17 } } });
      queueMicrotask(() => {
        health = 18;
        const first = { id: 'live-hit-1', type: 'hurt', healthBefore: 20, health, food: 17, loss: 2 };
        events.emit(first); events.emit(first);
        health = 16; events.emit({ id: 'live-hit-2', type: 'hurt', healthBefore: 18, health, food: 17, loss: 2 });
      });
    });
  };
  const result = await runWorldAgent({ ...f, instruction: '自主行动', runtime: runtime([
    fauxAssistantMessage([fauxToolCall('action', { type: 'wait', ms: 5000 }),
      fauxToolCall('action', { type: 'goto', x: 9, y: 64, z: 9 }), fauxToolCall('observe', {})], { stopReason: 'toolUse' }),
    (context: any) => {
      assert.equal(liveMessages(context).length, 1);
      const alert = JSON.stringify(liveMessages(context));
      assert.match(alert, /原因未确认/); assert.ok(alert.includes('\\"health\\":16')); assert.ok(alert.includes('\\"count\\":2'));
      assert.ok(JSON.stringify(context.messages).includes('此前排定的身体动作未执行'));
      assert.equal(firstSignal?.aborted, false, 'body interruption must not abort the pi task');
      return fauxAssistantMessage(fauxToolCall('action', { type: 'wait', ms: 1 }), { stopReason: 'toolUse' });
    },
    fauxAssistantMessage('依据现在的身体状态继续决定。'),
  ]) });
  assert.equal(result.status, 'completed'); assert.equal(result.turns, 3); assert.equal(interrupts, 1);
  assert.deepEqual(f.actions.map(action => action.type), ['wait', 'wait']);
  assert.equal(result.actions[0].status, 'cancelled'); assert.equal(result.actions[1].status, 'completed');
  assert.ok(result.toolTrace.some(trace => trace.status === 'error' && trace.error?.includes('身体动作未执行')));
  assert.equal(f.memory.entries.filter(entry => entry.sourceId === 'event:live-hit-1').length, 1);
  assert.ok(f.memory.entries.some(entry => entry.kind === 'fact' && entry.sourceId?.startsWith('event:live-hurt:')));
  assert.equal(events.count, 0); assert.equal(events.cleanups, 1);
  events.emit({ id: 'after-end', type: 'hurt', healthBefore: 16, health: 15 });
  assert.equal(interrupts, 1);
});

test('hurt arriving during model generation still blocks resource-changing actions until the next informed response', async t => {
  const f = await fixture(t), events = livePerception(f.port); let health = 20, interrupts = 0;
  f.port.observe = () => ({ health, food: 17, recentEvents: [] });
  f.port.interruptAction = () => { interrupts++; };
  const result = await runWorldAgent({ ...f, instruction: '自主行动', runtime: runtime([
    () => {
      health = 18; events.emit({ id: 'while-thinking', type: 'hurt', healthBefore: 20, health, food: 17 });
      return fauxAssistantMessage(fauxToolCall('action', { type: 'place', item: 'stone', x: 1, y: 64, z: 1 }), { stopReason: 'toolUse' });
    },
    (context: any) => { assert.equal(liveMessages(context).length, 1); return fauxAssistantMessage('身体状态已更新。'); },
  ]) });
  assert.equal(result.status, 'completed'); assert.equal(result.turns, 2);
  assert.equal(f.actions.length, 0); assert.equal(interrupts, 0); assert.equal(events.count, 0);
});

for (const durationMs of [undefined, 1800]) test(`a generation-time hit permits only the first short attack (${durationMs ?? 'native default'} ms) without consuming steering`, async t => {
  const f = await fixture(t), events = livePerception(f.port); let health = 20;
  f.port.observe = () => ({ health, recentEvents: [] });
  const result = await runWorldAgent({ ...f, instruction: '自主选择行动', runtime: runtime([
    (context: any) => {
      assert.equal(liveMessages(context).length, 0);
      health = 18; events.emit({ id: 'generation-first-hit', type: 'hurt', healthBefore: 20, health });
      return fauxAssistantMessage([
        fauxToolCall('action', { type: 'attack', entityId: 29, ...(durationMs === undefined ? {} : { durationMs }) }),
        fauxToolCall('action', { type: 'look', x: 1, y: 64, z: 0 }),
      ], { stopReason: 'toolUse' });
    },
    (context: any) => {
      assert.equal(liveMessages(context).length, 1, 'the injury is still delivered, not falsely marked as consumed by execution');
      return fauxAssistantMessage('现在收到了受伤情况。');
    },
  ]) });
  assert.equal(result.status, 'completed'); assert.equal(result.turns, 2);
  assert.deepEqual(f.actions.map(action => action.type), ['attack']);
  assert.deepEqual(result.toolTrace[0].generationHurtWindow, { requestRevision: 0, replyRevision: 1, maxDurationMs: 2000 });
  assert.match(result.toolTrace[1].error!, /此前排定的身体动作未执行/);
  assert.deepEqual(result.emergencyBudget, { actionsUsed: 0, modelTurnsUsed: 0 });
  assert.equal(events.count, 0);
});

for (const generationHit of [false, true]) test(`hurt after reply completion blocks its first queued short action (generation hit: ${generationHit})`, async t => {
  const f = await fixture(t), events = livePerception(f.port); let health = 20, hitOnObserve = false, hits = 0;
  const hit = () => { const healthBefore = health; health--; events.emit({ id: `queued-hit-${++hits}`, type: 'hurt', healthBefore, health }); };
  f.port.observe = () => { if (hitOnObserve) { hitOnObserve = false; hit(); } return { health, recentEvents: [] }; };
  const result = await runWorldAgent({ ...f, instruction: '自主选择行动', runtime: runtime([
    () => {
      if (generationHit) hit();
      hitOnObserve = true;
      return fauxAssistantMessage([fauxToolCall('observe', {}), fauxToolCall('action', { type: 'goto', x: 1, y: 64, z: 0 })], { stopReason: 'toolUse' });
    },
    (context: any) => { assert.equal(liveMessages(context).length, 1); return fauxAssistantMessage('重新收到身体变化。'); },
  ]) });
  assert.equal(result.status, 'completed'); assert.equal(f.actions.length, 0);
  assert.match(result.toolTrace.find(row => row.name === 'action')!.error!, /此前排定的身体动作未执行/);
  assert.ok(result.toolTrace.every(row => !row.generationHurtWindow));
});

for (const first of [{ type: 'gather', block: 'oak_log', count: 4 }, { type: 'attack', entityId: 29, durationMs: 3000 }]) {
  test(`generation injury permission does not transfer past a first ${first.type} operation outside the short-action allowance`, async t => {
    const f = await fixture(t), events = livePerception(f.port);
    f.port.observe = () => ({ health: 18, recentEvents: [] });
    const result = await runWorldAgent({ ...f, instruction: '自主选择行动', runtime: runtime([
      () => {
        events.emit({ id: 'not-short-first', type: 'hurt', healthBefore: 20, health: 18 });
        return fauxAssistantMessage([fauxToolCall('action', first), fauxToolCall('action', { type: 'attack', entityId: 29, durationMs: 1000 })], { stopReason: 'toolUse' });
      }, fauxAssistantMessage('重新考虑。'),
    ]) });
    assert.equal(f.actions.length, 0); assert.equal(result.toolTrace.filter(row => row.status === 'error').length, 2);
    assert.deepEqual(result.emergencyBudget, { actionsUsed: 0, modelTurnsUsed: 0 });
  });
}

for (const movement of [
  { type: 'goto', x: 1, y: 64, z: 0 },
  { type: 'travel', x: 1, z: 0 },
  { type: 'approach', entityId: 29 },
]) test(`a generation-time ${movement.type} is bounded to two seconds even without another hit and does not abort the reasoning task`, async t => {
  const f = await fixture(t), events = livePerception(f.port); let health = 20, started = 0, ended = 0, interrupts = 0;
  f.port.observe = () => ({ health, recentEvents: [] });
  f.port.interruptAction = () => { interrupts++; };
  f.port.execute = (action, _id, signal) => new Promise(resolve => {
    f.actions.push(action); started = performance.now();
    signal.addEventListener('abort', () => { ended = performance.now(); resolve({ status: 'cancelled', action, error: String(signal.reason) }); }, { once: true });
  });
  const result = await runWorldAgent({ ...f, instruction: '自主移动', timeoutMs: 6000, runtime: runtime([
    () => {
      health = 18; events.emit({ id: 'generation-goto-hit', type: 'hurt', healthBefore: 20, health });
      return fauxAssistantMessage(fauxToolCall('action', movement), { stopReason: 'toolUse' });
    },
    (context: any) => { assert.equal(liveMessages(context).length, 1); return fauxAssistantMessage('动作时间到了，我重新判断。'); },
  ]) });
  assert.equal(result.status, 'completed'); assert.equal(result.actions[0].status, 'cancelled'); assert.equal(interrupts, 1);
  assert.deepEqual(f.actions, [movement]);
  assert.deepEqual(result.toolTrace[0].generationHurtWindow, { requestRevision: 0, replyRevision: 1, maxDurationMs: 2000 });
  assert.ok(ended - started >= HURT_ACTION_WINDOW_MS - 30); assert.ok(ended - started < HURT_ACTION_WINDOW_MS + 1000);
  assert.equal(events.count, 0); assert.equal(events.cleanups, 1);
});

for (const quota of ['actions', 'tools']) test(`generation injury permission cannot exceed the ordinary ${quota} budget without consumed steering`, async t => {
  const f = await fixture(t), events = livePerception(f.port); let health = 20;
  f.port.observe = () => ({ health, recentEvents: [] });
  const result = await runWorldAgent({ ...f, instruction: '自主选择行动', runtime: runtime([
    fauxAssistantMessage(Array.from({ length: quota === 'actions' ? 6 : 24 }, () => quota === 'actions'
      ? fauxToolCall('action', { type: 'wait', ms: 1 }) : fauxToolCall('observe', {})), { stopReason: 'toolUse' }),
    (context: any) => {
      assert.equal(liveMessages(context).length, 0);
      health = 18; events.emit({ id: 'generation-at-quota', type: 'hurt', healthBefore: 20, health });
      return fauxAssistantMessage(fauxToolCall('action', { type: 'attack', entityId: 29, durationMs: 1000 }), { stopReason: 'toolUse' });
    }, fauxAssistantMessage('到达边界。'),
  ]) });
  assert.equal(f.actions.length, quota === 'actions' ? 6 : 0);
  assert.ok(f.actions.every(action => action.type === 'wait'));
  assert.deepEqual(result.emergencyBudget, { actionsUsed: 0, modelTurnsUsed: 0 });
  assert.ok(result.toolTrace.every(row => !row.generationHurtWindow));
});

for (const duringAction of [false, true]) test(`death cancellation cannot borrow a generation-time short-action window (${duringAction ? 'executing' : 'queued'})`, async t => {
  const f = await fixture(t), events = livePerception(f.port), controller = new AbortController(); let health = 20, cancelOnObserve = false;
  const die = () => { const healthBefore = health; health = 0; events.emit({ id: 'generation-fatal', type: 'hurt', healthBefore, health }); controller.abort({ type: 'world-event', event: 'death' }); };
  f.port.observe = () => { if (cancelOnObserve) { cancelOnObserve = false; die(); } return { health, recentEvents: [] }; };
  f.port.execute = (action, _id, signal) => new Promise(resolve => {
    f.actions.push(action);
    signal.addEventListener('abort', () => resolve({ status: 'cancelled', action }), { once: true });
    queueMicrotask(die);
  });
  const result = await runWorldAgent({ ...f, signal: controller.signal, instruction: '自主选择行动', runtime: runtime([
    () => {
      health = 18; events.emit({ id: 'generation-before-fatal', type: 'hurt', healthBefore: 20, health });
      cancelOnObserve = !duringAction;
      return fauxAssistantMessage([
        ...(!duringAction ? [fauxToolCall('observe', {})] : []),
        fauxToolCall('action', { type: 'goto', x: 1, y: 64, z: 0 }),
        fauxToolCall('action', { type: 'goto', x: 2, y: 64, z: 0 }),
      ], { stopReason: 'toolUse' });
    }, () => { assert.fail('Death must not launch a replacement model request.'); },
  ]) });
  assert.equal(result.status, 'cancelled'); assert.equal(result.turns, 1); assert.equal(f.actions.length, duringAction ? 1 : 0);
  assert.deepEqual(result.emergencyBudget, { actionsUsed: 0, modelTurnsUsed: 0 });
  assert.equal(events.count, 0); assert.equal(events.cleanups, 1);
});

test('hurt bursts coalesce into one bounded notification and preserve facts without copying unsupported causes', async t => {
  const f = await fixture(t), events = livePerception(f.port); let health = 20;
  f.port.observe = () => ({ health, food: 17, recentEvents: [] });
  const result = await runWorldAgent({ ...f, instruction: '观察身体', runtime: runtime([
    () => {
      events.emit({ id: 'other-actor', npcId: 'Other', type: 'hurt', healthBefore: 20, health: 1 });
      events.emit({ id: 'not-hurt', type: 'hurt', healthBefore: 18, health: 20 });
      for (let i = 0; i < 40; i++) {
        const before = health; health = Number((health - .1).toFixed(1));
        events.emit({ id: `burst-${i}`, type: 'hurt', healthBefore: before, health, food: 17, attacker: 'UNVERIFIED_CAUSE' } as WorldPerceptionEvent);
      }
      return fauxAssistantMessage('刚才的身体状态是旧信息。');
    },
    (context: any) => {
      const notices = liveMessages(context); assert.equal(notices.length, 1);
      const text = notices[0].content[0].text;
      assert.ok(text.length < 2000); assert.match(text, /"count":40/); assert.match(text, /"health":16/);
      assert.doesNotMatch(text, /UNVERIFIED_CAUSE|other-actor/);
      return fauxAssistantMessage('重新判断。');
    },
  ]) });
  assert.equal(result.turns, 2);
  assert.equal(f.memory.entries.filter(entry => entry.sourceId?.startsWith('event:burst-')).length, 16);
  const summary = f.memory.entries.find(entry => entry.sourceId?.startsWith('event:live-hurt:'));
  assert.ok(summary && summary.kind === 'fact'); assert.match(summary.text, /"count":40/);
  assert.doesNotMatch(JSON.stringify(f.memory.entries), /UNVERIFIED_CAUSE|other-actor/);
  assert.equal(events.cleanups, 1);
  for (let i = 0; i < 12; i++) await f.memory.add('fact', `Later unrelated observation ${i}`);
  assert.doesNotMatch(f.memory.context('受伤事件汇总'), /本角色受伤事件汇总/);
  assert.ok(f.memory.recall('受伤事件汇总', 100).some(entry => entry.id === summary.id));
});

test('cancelling an injured long action removes its subscription and does not launch a steering turn', async t => {
  const f = await fixture(t), events = livePerception(f.port), controller = new AbortController();
  let modelCalls = 0, interrupts = 0;
  f.port.interruptAction = () => { interrupts++; };
  f.port.execute = (action, _id, signal) => new Promise(resolve => {
    signal.addEventListener('abort', () => resolve({ action, status: 'cancelled' }), { once: true });
    queueMicrotask(() => {
      events.emit({ id: 'injured-before-cancel', type: 'hurt', healthBefore: 20, health: 18, food: 17 });
      controller.abort();
    });
  });
  const result = await runWorldAgent({ ...f, instruction: '等待', signal: controller.signal, runtime: runtime([
    () => { modelCalls++; return fauxAssistantMessage(fauxToolCall('action', { type: 'wait', ms: 5000 }), { stopReason: 'toolUse' }); },
    () => { modelCalls++; return fauxAssistantMessage('must not reach'); },
  ]) });
  assert.equal(result.status, 'cancelled'); assert.equal(modelCalls, 1); assert.equal(interrupts, 1);
  assert.equal(events.count, 0); assert.equal(events.cleanups, 1);
  assert.ok(f.memory.entries.some(entry => entry.sourceId === 'event:injured-before-cancel'));
});

test('subscription starts before initial observation and is removed even if initialization fails', async t => {
  const f = await fixture(t), events = livePerception(f.port); let reads = 0;
  f.port.observe = () => {
    assert.equal(events.count, 1);
    if (++reads === 1) events.emit({ id: 'initial-hit', type: 'hurt', healthBefore: 20, health: 19, food: 17 });
    return { health: 19, food: 17, recentEvents: [] };
  };
  const result = await runWorldAgent({ ...f, instruction: '观察', runtime: runtime([
    (context: any) => {
      assert.equal(liveMessages(context).length, 1);
      return fauxAssistantMessage(fauxToolCall('action', { type: 'wait', ms: 1 }), { stopReason: 'toolUse' });
    }, fauxAssistantMessage('完成。'),
  ]) });
  assert.equal(result.status, 'completed'); assert.equal(f.actions.length, 1); assert.equal(events.cleanups, 1);
  f.port.observe = () => { throw new Error('observation unavailable'); };
  await assert.rejects(runWorldAgent({ ...f, instruction: '观察', runtime: runtime([]) }), /observation unavailable/);
  assert.equal(events.count, 0); assert.equal(events.cleanups, 2);
});

test('continuous hits during every model decision allow one newly informed goto rather than starving all movement', async t => {
  const f = await fixture(t), events = livePerception(f.port); let health = 20, hits = 0, interrupts = 0;
  const hit = () => { const before = health; health--; events.emit({ id: `continuous-${++hits}`, type: 'hurt', healthBefore: before, health, food: 17 }); };
  f.port.observe = () => ({ health, food: 17, recentEvents: [] });
  f.port.interruptAction = () => { interrupts++; };
  f.port.execute = async action => {
    f.actions.push(action); hit(); await delay(10);
    return { status: 'completed', action, after: { x: action.x, y: 64, z: 0 } };
  };
  const deciding = (x: number) => (context: any) => {
    if (x > 0) assert.ok(liveMessages(context).length > 0);
    hit();
    return fauxAssistantMessage([
      fauxToolCall('action', { type: 'goto', x, y: 64, z: 0 }),
      fauxToolCall('action', { type: 'goto', x: 99, y: 64, z: 0 }),
    ], { stopReason: 'toolUse' });
  };
  const result = await runWorldAgent({ ...f, instruction: '自行决定怎样应对当前情况', runtime: runtime([
    deciding(0), deciding(1), deciding(2), fauxAssistantMessage('我已经实际移动。'),
  ]) });
  assert.equal(result.status, 'completed'); assert.equal(result.turns, 4);
  assert.deepEqual(f.actions.map(action => action.x), [0, 1, 2], 'generation-time injury allows one short action, then each newly informed response gets one chosen action');
  assert.equal(interrupts, 0, 'additional hits cannot instantly cancel the short, newly informed action');
  assert.ok(result.toolTrace.filter(trace => trace.status === 'error').length >= 3, 'remaining stale calls in each batch stay blocked');
  assert.equal(events.count, 0); assert.equal(events.cleanups, 1);
});

test('an informed long action gets a fixed two-second opportunity then stops even without another hit', async t => {
  const f = await fixture(t), events = livePerception(f.port); let health = 20, hits = 0, interrupts = 0;
  let started = 0, interruptedAt = 0, finishBody: (() => void) | undefined;
  const hit = () => { const before = health; health--; events.emit({ id: `bounded-${++hits}`, type: 'hurt', healthBefore: before, health, food: 17 }); };
  f.port.observe = () => ({ health, food: 17, recentEvents: [] });
  f.port.interruptAction = () => { interrupts++; interruptedAt = performance.now(); finishBody?.(); };
  f.port.execute = (action, _id, signal) => {
    f.actions.push(action); started = performance.now();
    return new Promise(resolve => {
      finishBody = () => resolve({ status: 'cancelled', action, error: 'hurt-window-ended' });
      signal.addEventListener('abort', finishBody, { once: true });
      // Only one hit while executing. The deadline must proactively interrupt;
      // waiting for a further hit would let a 45-second gather ignore this one.
      queueMicrotask(hit);
    });
  };
  const result = await runWorldAgent({ ...f, instruction: '自主选择一个行动', timeoutMs: 8000, runtime: runtime([
    () => { hit(); return fauxAssistantMessage(fauxToolCall('observe', {}), { stopReason: 'toolUse' }); },
    async (context: any) => {
      assert.equal(liveMessages(context).length, 1); hit();
      // Model latency exceeds the action window: its opportunity must start at
      // body execution, not expire while the request is still generating.
      await delay(HURT_ACTION_WINDOW_MS + 30);
      assert.equal(interrupts, 0);
      return fauxAssistantMessage(fauxToolCall('action', { type: 'gather', block: 'oak_log', count: 16 }), { stopReason: 'toolUse' });
    },
    fauxAssistantMessage('动作已经中断，我收到更新了。'),
  ]) });
  assert.equal(result.status, 'completed'); assert.equal(f.actions.length, 1); assert.equal(interrupts, 1);
  assert.equal(result.actions[0].status, 'cancelled');
  assert.ok(interruptedAt - started >= HURT_ACTION_WINDOW_MS - 30);
  assert.ok(interruptedAt - started < HURT_ACTION_WINDOW_MS + 1000);
  assert.equal(events.count, 0); assert.equal(events.cleanups, 1);
});

for (const follow of [false, true]) test(`an informed attack keeps its requested bounded bout through further hits (follow=${follow})`, async t => {
  const f = await fixture(t), events = livePerception(f.port); let health = 20, hitCount = 0, interrupts = 0;
  const hit = () => { const before = health; health--; events.emit({ id: `committed-${++hitCount}`, type: 'hurt', healthBefore: before, health }); };
  f.port.observe = () => ({ health, inventory: [], recentEvents: [] });
  f.port.interruptAction = () => { interrupts++; };
  f.port.execute = async (action) => {
    f.actions.push(action); hit();
    await delay(2250); // The old universal two-second cutoff would interrupt here.
    assert.equal(interrupts, 0);
    return { status: 'completed', action, details: { attempts: 4, damageConfirmed: false } };
  };
  const proposal = { type: 'attack', entityId: 29, durationMs: 2400, follow };
  const result = await runWorldAgent({ ...f, instruction: '自主选择行动', runtime: runtime([
    () => { hit(); return fauxAssistantMessage(fauxToolCall('observe', {}), { stopReason: 'toolUse' }); },
    (context: any) => {
      assert.equal(liveMessages(context).length, 1);
      return fauxAssistantMessage([fauxToolCall('action', proposal), fauxToolCall('action', { type: 'goto', x: 99, y: 64, z: 0 })], { stopReason: 'toolUse' });
    },
    fauxAssistantMessage('这一轮攻击结束，需要根据新状态再决定。'),
  ]) });
  assert.deepEqual(f.actions, [proposal]); assert.equal(result.status, 'completed');
  assert.ok(result.toolTrace.some(row => row.status === 'error'), 'The later queued movement cannot borrow the committed attack window.');
  const trace = result.toolTrace.find(row => row.informedAttackWindow)!;
  assert.deepEqual(trace.informedAttackWindow, { durationMs: 2400, interruptAfterMs: 2500 });
  assert.equal(trace.generationHurtWindow, undefined); assert.equal(events.count, 0);
});

test('an informed attack cannot extend its bounded window by receiving more hits', async t => {
  const f = await fixture(t), events = livePerception(f.port); let health = 20, count = 0, interrupts = 0, started = 0, ended = 0;
  let finish: (() => void) | undefined;
  const hit = () => { const before = health; health--; events.emit({ id: `attack-deadline-${++count}`, type: 'hurt', healthBefore: before, health }); };
  f.port.observe = () => ({ health, recentEvents: [] });
  f.port.interruptAction = () => { interrupts++; ended = performance.now(); finish?.(); };
  f.port.execute = (action, _id, signal) => new Promise(resolve => {
    started = performance.now(); finish = () => resolve({ status: 'cancelled', action });
    signal.addEventListener('abort', finish, { once: true });
    queueMicrotask(hit);
  });
  const result = await runWorldAgent({ ...f, instruction: '自主应对', timeoutMs: 5000, runtime: runtime([
    () => { hit(); return fauxAssistantMessage(fauxToolCall('observe', {}), { stopReason: 'toolUse' }); },
    fauxAssistantMessage(fauxToolCall('action', { type: 'attack', entityId: 29, durationMs: 2100, follow: true }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('收到实际停止结果。'),
  ]) });
  assert.equal(result.status, 'completed'); assert.equal(interrupts, 1);
  assert.ok(ended - started >= 2170); assert.ok(ended - started < 3500);
  assert.equal(events.count, 0);
});

test('death cancels an informed pursuit immediately instead of waiting for its chosen duration', async t => {
  const f = await fixture(t), events = livePerception(f.port), controller = new AbortController();
  let health = 20, elapsed = 0;
  f.port.observe = () => ({ health, recentEvents: [] });
  f.port.execute = (action, _id, signal) => new Promise(resolve => {
    const began = performance.now();
    signal.addEventListener('abort', () => { elapsed = performance.now() - began; resolve({ status: 'cancelled', action }); }, { once: true });
    queueMicrotask(() => { health = 0; events.emit({ id: 'committed-fatal', type: 'hurt', healthBefore: 18, health }); controller.abort({ type: 'world-event', event: 'death' }); });
  });
  const result = await runWorldAgent({ ...f, instruction: '自主应对', signal: controller.signal, runtime: runtime([
    () => { health = 18; events.emit({ id: 'committed-first', type: 'hurt', healthBefore: 20, health }); return fauxAssistantMessage(fauxToolCall('observe', {}), { stopReason: 'toolUse' }); },
    fauxAssistantMessage(fauxToolCall('action', { type: 'attack', entityId: 29, durationMs: 10000, follow: true }), { stopReason: 'toolUse' }),
  ]) });
  assert.equal(result.status, 'cancelled'); assert.ok(elapsed < 500); assert.equal(events.count, 0);
});

test('a later response cannot reuse an old hurt notification as a permanent action exemption', async t => {
  const f = await fixture(t), events = livePerception(f.port); let health = 20, hitId = 0, hitAfterReply = false;
  const hit = () => { const before = health; health--; events.emit({ id: `new-steer-${++hitId}`, type: 'hurt', healthBefore: before, health }); };
  f.port.observe = () => { if (hitAfterReply) { hitAfterReply = false; hit(); } return { health, recentEvents: [] }; };
  const result = await runWorldAgent({ ...f, instruction: '自主应对', runtime: runtime([
    () => { hit(); return fauxAssistantMessage(fauxToolCall('observe', {}), { stopReason: 'toolUse' }); },
    (context: any) => {
      assert.equal(liveMessages(context).length, 1);
      return fauxAssistantMessage(fauxToolCall('observe', {}), { stopReason: 'toolUse' });
    },
    (context: any) => {
      assert.equal(liveMessages(context).length, 1, 'no new steering was consumed by this request');
      hitAfterReply = true;
      return fauxAssistantMessage([fauxToolCall('observe', {}), fauxToolCall('action', { type: 'goto', x: 88, y: 64, z: 0 })], { stopReason: 'toolUse' });
    },
    (context: any) => {
      assert.equal(liveMessages(context).length, 2);
      return fauxAssistantMessage(fauxToolCall('action', { type: 'goto', x: 2, y: 64, z: 0 }), { stopReason: 'toolUse' });
    }, fauxAssistantMessage('已经执行新决定。'),
  ]) });
  assert.equal(result.status, 'completed'); assert.equal(result.turns, 5);
  assert.deepEqual(f.actions.map(action => action.x), [2]);
  assert.equal(result.toolTrace.filter(trace => trace.status === 'error').length, 1);
});

test('death cancellation bypasses an active hurt window and clears its timer and subscription', async t => {
  const f = await fixture(t), events = livePerception(f.port), controller = new AbortController();
  const windows = new Set<any>(); let createdWindows = 0, interrupts = 0, bodyAborted = false;
  const originalSetTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback: (...args: any[]) => void, ms: number, ...args: any[]) => {
    const handle = originalSetTimeout((...values) => { windows.delete(handle); callback(...values); }, ms, ...args);
    if (ms === HURT_ACTION_WINDOW_MS) { createdWindows++; windows.add(handle); }
    return handle;
  });
  t.mock.method(globalThis, 'clearTimeout', (handle: any) => { windows.delete(handle); originalClearTimeout(handle); });
  f.port.observe = () => ({ health: 18, recentEvents: [] });
  f.port.interruptAction = () => { interrupts++; };
  f.port.execute = (action, _id, signal) => new Promise(resolve => {
    assert.equal(windows.size, 1, 'the newly informed action has begun its execution window');
    signal.addEventListener('abort', () => { bodyAborted = true; resolve({ status: 'cancelled', action }); }, { once: true });
    queueMicrotask(() => {
      events.emit({ id: 'fatal-window-hit', type: 'hurt', healthBefore: 18, health: 0 });
      controller.abort({ type: 'world-event', event: 'death' });
    });
  });
  const result = await runWorldAgent({ ...f, instruction: '自主应对', signal: controller.signal, runtime: runtime([
    () => {
      events.emit({ id: 'before-window-death', type: 'hurt', healthBefore: 20, health: 18 });
      return fauxAssistantMessage(fauxToolCall('observe', {}), { stopReason: 'toolUse' });
    },
    fauxAssistantMessage(fauxToolCall('action', { type: 'gather', block: 'oak_log', count: 16 }), { stopReason: 'toolUse' }),
  ]) });
  assert.equal(result.status, 'cancelled'); assert.equal(result.turns, 2); assert.equal(bodyAborted, true);
  assert.equal(createdWindows, 1); assert.equal(windows.size, 0); assert.equal(interrupts, 0);
  assert.equal(events.count, 0); assert.equal(events.cleanups, 1);
});

test('hurt persistence failures do not lose steering or block informed actions and diagnostics stay bounded', async t => {
  const f = await fixture(t), events = livePerception(f.port);
  let health = 20, hits = 0, eventWrites = 0, summaryWrites = 0;
  f.port.observe = () => ({ health, food: 17, recentEvents: [] });
  const originalAdd = f.memory.add.bind(f.memory);
  t.mock.method(f.memory, 'add', async (...args: Parameters<WorldMemory['add']>) => {
    const sourceId = args[2] || '';
    if (sourceId.startsWith('event:disk-hit-')) eventWrites++;
    else if (sourceId.startsWith('event:live-hurt:')) summaryWrites++;
    else return originalAdd(...args);
    throw new Error('Simulated hurt-memory write failure: ' + 'x'.repeat(500));
  });
  const hit = () => {
    const healthBefore = health; health--;
    events.emit({ id: `disk-hit-${++hits}`, type: 'hurt', healthBefore, health, food: 17 });
  };
  const informedMove = (x: number) => (context: any) => {
    assert.equal(liveMessages(context).length, x, 'steering must be delivered despite both event and summary writes failing');
    hit();
    return fauxAssistantMessage(fauxToolCall('action', { type: 'goto', x, y: 64, z: 0 }), { stopReason: 'toolUse' });
  };
  const result = await runWorldAgent({ ...f, instruction: '自主决定行动', runtime: runtime([
    () => { hit(); return fauxAssistantMessage(fauxToolCall('observe', {}), { stopReason: 'toolUse' }); },
    informedMove(1), informedMove(2),
    (context: any) => { assert.equal(liveMessages(context).length, 3); return fauxAssistantMessage('新的决定已执行。'); },
  ]) });
  assert.equal(result.status, 'completed'); assert.equal(result.error, undefined);
  assert.deepEqual(f.actions.map(action => action.x), [1, 2]);
  assert.equal(eventWrites, 3); assert.equal(summaryWrites, 3);
  assert.equal(result.perceptionErrors.length, 4, 'six persistence errors must be capped at the latest four');
  assert.ok(result.perceptionErrors.every(error => error.length <= 240));
  assert.ok(result.perceptionErrors.some(error => error.startsWith('Hurt event persistence failed:')));
  assert.ok(result.perceptionErrors.some(error => error.startsWith('Hurt summary persistence failed:')));
  assert.equal(events.count, 0); assert.equal(events.cleanups, 1);
});

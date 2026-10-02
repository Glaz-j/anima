import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { GOAL_REVIEW_LIMITS, reviewGoal, type GoalReviewDecision } from '../packages/pi-runtime/src/goal-review.ts';

const output = (review: any) => fauxAssistantMessage(fauxToolCall('submit_goal_review', review), { stopReason: 'toolUse' });
const keep: GoalReviewDecision = { decision: 'keep', reason: '当前目标仍解决已观察到的缺口。', nextHypothesis: '测试现有能力能否接近选定对象。' };
function fixture(responses: any[]) {
  const models = createModels(), faux = fauxProvider(); models.setProvider(faux.provider); faux.setResponses(responses);
  const runtime = { models, model: faux.getModel(), apiKey: undefined as any, source: 'test' };
  const options = { runtime, personaPrompt: '直率、愿意尝试，也尊重同伴。', instruction: '与同伴自主完成长期世界任务。',
    observation: { dimension: 'test-world', health: 20, inventory: [{ name: 'material', count: 46 }] },
    currentGoal: { goalId: 'g1', text: '收集8件材料', completionCondition: '实际背包新增8件材料' },
    currentPlan: '先核实是否仍缺材料', recentProgress: '六轮净增加26件材料；没有死亡，尚未验证另一项依赖。',
    recentGoalHistory: '历史意图判断：此前“放置炉子”目标已 completed，不是当前任务。',
    teammateStatements: [{ text: '我可以试着帮忙，暂时还没动身。', time: '2026-10-02T00:00:00Z' }],
    capabilities: '身体可执行有界的方向探索，不必由你手工保证整条路线。' };
  return { options, faux };
}

for (const review of [keep,
  { decision: 'complete', reason: '当前局部完成条件已有实际证据；远期任务仍未完成。' },
  { decision: 'abandon', reason: '旧依赖长期没有兑现，继续等待不再合适。', nextHypothesis: '评估自己可检验的替代条件。' },
  { decision: 'replace', reason: '当前资产已足够，需要检验另一项缺口。', goal: '验证一个尚未解决的局部条件', successCondition: '取得该条件的实际观察结果', nextHypothesis: '从一个已观察地点做有限尝试。' },
] as GoalReviewDecision[]) test(`independent pi review submits ${review.decision} in one turn with no body tools`, async () => {
  const f = fixture([(context: any, request: any) => {
    assert.deepEqual(context.tools.map((tool: any) => tool.name), ['submit_goal_review']);
    assert.equal(request.maxRetries, 0); assert.equal(request.maxTokens, GOAL_REVIEW_LIMITS.maxTokens);
    assert.ok(request.timeoutMs > 0 && request.timeoutMs <= GOAL_REVIEW_LIMITS.timeoutMs);
    const input = JSON.parse(context.messages[0].content[0].text);
    assert.equal(input.currentObservation.inventory[0].count, 46);
    assert.equal(input.currentGoal.goalId, 'g1'); assert.equal(input.currentPlan, f.options.currentPlan);
    assert.equal(input.recentSixTurnFacts, f.options.recentProgress);
    assert.equal(input.recentGoalHistory, f.options.recentGoalHistory);
    assert.deepEqual(input.teammateStatements, f.options.teammateStatements);
    assert.equal(input.capabilities, f.options.capabilities);
    assert.match(context.systemPrompt, /原话仅证明有人这样说/);
    assert.match(context.systemPrompt, /直率/);
    return output(review);
  }]);
  const before = JSON.stringify(f.options.observation);
  const result = await reviewGoal({ ...f.options, timeoutMs: 100_000 });
  assert.equal(result.status, 'completed'); assert.deepEqual(result.review, review);
  assert.equal(result.turns, 1); assert.equal(f.faux.state.callCount, 1);
  assert.ok(result.usage.totalTokens > 0); assert.ok(result.durationMs >= 0);
  assert.equal(JSON.stringify(f.options.observation), before, 'Review cannot mutate observed assets.');
});

test('replace missing goal or criterion is rejected by real pi validation and cannot escape two turns', async () => {
  const f = fixture([
    output({ decision: 'replace', reason: '换目标', goal: '新目标缺少完成条件' }),
    (context: any) => {
      assert.ok(context.messages.some((message: any) => message.role === 'toolResult' && message.isError));
      return output({ decision: 'replace', reason: '换目标', successCondition: '条件存在但缺少目标' });
    },
    output(keep),
  ]);
  const result = await reviewGoal(f.options);
  assert.equal(result.status, 'invalid'); assert.equal(result.review, undefined);
  assert.equal(result.turns, 2); assert.equal(f.faux.state.callCount, 2);
  assert.equal(f.faux.getPendingResponseCount(), 1); assert.ok(result.error!.length <= 500);
});

test('invalid first output can be repaired once without another acknowledgement request', async () => {
  const f = fixture([output({ decision: 'replace', reason: '修订' }), output({ decision: 'replace', reason: '旧目标已无必要',
    goal: '尝试新的局部目标', successCondition: '观察到预先选定的结果' }), output(keep)]);
  const result = await reviewGoal(f.options);
  assert.equal(result.status, 'completed'); assert.equal(result.review?.decision, 'replace');
  assert.equal(result.turns, 2); assert.equal(f.faux.state.callCount, 2); assert.equal(f.faux.getPendingResponseCount(), 1);
});

test('plain prose gets at most one structured repair and is never interpreted as a decision', async () => {
  const f = fixture([fauxAssistantMessage('我决定继续。'), fauxAssistantMessage('{"decision":"keep","reason":"文本不算结构提交"}'), output(keep)]);
  const result = await reviewGoal(f.options);
  assert.equal(result.status, 'invalid'); assert.equal(result.review, undefined);
  assert.equal(result.turns, 2); assert.equal(f.faux.state.callCount, 2);
});

test('an attempted world action is an unknown tool and can only receive a structured repair', async () => {
  const f = fixture([fauxAssistantMessage(fauxToolCall('action', { type: 'dig', x: 1, y: 64, z: 1 }), { stopReason: 'toolUse' }),
    (context: any) => {
      assert.deepEqual(context.tools.map((tool: any) => tool.name), ['submit_goal_review']);
      const rejected = context.messages.find((message: any) => message.role === 'toolResult' && message.toolName === 'action');
      assert.equal(rejected.isError, true);
      return output(keep);
    }]);
  const result = await reviewGoal(f.options);
  assert.equal(result.status, 'completed'); assert.deepEqual(result.review, keep); assert.equal(result.turns, 2);
});

test('only the first valid structured submission in a batch is accepted', async () => {
  const f = fixture([fauxAssistantMessage([
    fauxToolCall('submit_goal_review', keep),
    fauxToolCall('submit_goal_review', { decision: 'abandon', reason: '不得覆盖第一次提交' }),
  ], { stopReason: 'toolUse' })]);
  const result = await reviewGoal(f.options);
  assert.equal(result.status, 'completed'); assert.deepEqual(result.review, keep); assert.equal(f.faux.state.callCount, 1);
});

for (const invalid of [
  { ...keep, reason: ' '.repeat(4) },
  { ...keep, reason: 'x'.repeat(GOAL_REVIEW_LIMITS.reasonChars + 1) },
  { ...keep, nextHypothesis: 'x'.repeat(GOAL_REVIEW_LIMITS.hypothesisChars + 1) },
  { ...keep, unexpectedAction: { type: 'attack' } },
]) test(`strict review schema rejects ${JSON.stringify(invalid).slice(0, 95)}`, async () => {
  const f = fixture([output(invalid), output(invalid)]);
  const result = await reviewGoal(f.options);
  assert.equal(result.status, 'invalid'); assert.equal(result.review, undefined); assert.equal(result.turns, 2);
});

test('provider failure is contained and consumes no retry or repair response', async () => {
  const f = fixture([fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'test provider unavailable' }), output(keep)]);
  const result = await reviewGoal(f.options);
  assert.equal(result.status, 'failed'); assert.match(result.error!, /provider unavailable/);
  assert.equal(f.faux.state.callCount, 1); assert.equal(result.review, undefined);
});

test('already cancelled reviews never start a model request', async () => {
  const f = fixture([output(keep)]);
  const result = await reviewGoal({ ...f.options, signal: AbortSignal.abort() });
  assert.equal(result.status, 'cancelled'); assert.equal(result.turns, 0); assert.equal(f.faux.state.callCount, 0);
});

for (const kind of ['timeout', 'external'] as const) test(`${kind} cancellation drains the actual pi provider before returning and never retries`, async () => {
  let requestStarted!: () => void, drained = false, returned = false;
  const began = new Promise<void>(resolve => { requestStarted = resolve; });
  const controller = new AbortController();
  const f = fixture([async (_context: any, request: any) => {
    const stopped = new Promise<void>(resolve => {
      if (request.signal.aborted) resolve(); else request.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    requestStarted(); await stopped; await delay(35); drained = true;
    return output(keep); // An answer finishing after cancellation must not be accepted.
  }, output(keep)]);
  const pending = reviewGoal({ ...f.options, signal: controller.signal, timeoutMs: kind === 'timeout' ? 25 : 1000 })
    .then(result => { returned = true; return result; });
  await began;
  if (kind === 'external') controller.abort();
  await delay(kind === 'external' ? 10 : 35);
  assert.equal(returned, false, 'Do not return while the provider is still draining.');
  const result = await pending;
  assert.equal(result.status, kind === 'timeout' ? 'timeout' : 'cancelled'); assert.equal(drained, true);
  assert.equal(result.review, undefined); assert.equal(f.faux.state.callCount, 1);
  await delay(15); assert.equal(f.faux.state.callCount, 1); assert.equal(f.faux.getPendingResponseCount(), 1);
});

test('oversized source material is bounded and observation truncation remains explicit JSON', async () => {
  const f = fixture([(context: any) => {
    assert.ok(context.systemPrompt.length < GOAL_REVIEW_LIMITS.personaChars + 1500);
    const input = JSON.parse(context.messages[0].content[0].text);
    assert.equal(input.currentObservation.truncated, true);
    assert.ok(input.currentObservation.excerpt.length <= GOAL_REVIEW_LIMITS.observationChars);
    assert.ok(input.recentSixTurnFacts.length <= GOAL_REVIEW_LIMITS.progressChars);
    assert.ok(input.recentGoalHistory.length <= GOAL_REVIEW_LIMITS.goalHistoryChars);
    assert.ok(input.longTermObjective.length <= GOAL_REVIEW_LIMITS.instructionChars);
    assert.equal(input.teammateStatements.length, 4);
    assert.ok(input.teammateStatements.every((entry: any) => entry.text.length <= 400));
    return output(keep);
  }]);
  const result = await reviewGoal({ ...f.options, personaPrompt: '人物资料'.repeat(5000), instruction: '远期'.repeat(2000),
    observation: { arbitraryObservedText: '观察'.repeat(5000) }, recentProgress: '近期事实'.repeat(2000),
    recentGoalHistory: '历史目标判断'.repeat(2000),
    teammateStatements: Array.from({ length: 10 }, () => ({ text: '同伴原话'.repeat(500) })) });
  assert.equal(result.status, 'completed');
});

test('bad input serialization becomes a contained failure before any model request', async () => {
  const f = fixture([output(keep)]), observation: any = {}; observation.self = observation;
  const result = await reviewGoal({ ...f.options, observation });
  assert.equal(result.status, 'failed'); assert.equal(f.faux.state.callCount, 0); assert.equal(result.review, undefined);
});

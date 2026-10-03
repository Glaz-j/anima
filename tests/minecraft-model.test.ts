import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadModel } from '../packages/pi-runtime/src/model.ts';
import { loadNpcModel, runTask } from '../adapters/minecraft/src/llm.ts';
import { DEFAULT_WORLD_NPCS } from '../packages/npc-core/src/world-persona.ts';

function environment(t: any, values: Record<string, string | undefined>) {
  const old = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of old) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}
function proxyEnvironment(t: any) {
  environment(t, {
    ANIMA_API_KEY: 'fixture-key-not-a-real-credential', ANIMA_PROVIDER: 'fixture-proxy',
    ANIMA_API: 'openai-completions', ANIMA_BASE_URL: 'http://fixture.invalid/v1', ANIMA_MODEL: 'gpt-6-luna',
    ANIMA_MC_MODEL_HUYIFEI: 'gpt-6.1-sol', ANIMA_MC_MODEL_SHELDON: undefined,
    ANIMA_MC_MODEL_SHERLOCK: undefined, ANIMA_MC_MODEL_DEADPOOL: undefined,
  });
}
async function directory(t: any) {
  const prefix = join(tmpdir(), 'anima-model-test-'), root = await mkdtemp(prefix);
  t.after(async () => { assert.ok(root.startsWith(prefix)); await rm(root, { recursive: true, force: true }); });
  return root;
}

test('concurrent NPC selection changes only HuYifei and leaves shared defaults untouched', async t => {
  proxyEnvironment(t);
  const actors = await Promise.all(DEFAULT_WORLD_NPCS.map(async actor => ({ name: actor.name, runtime: await loadNpcModel(actor.name) })));
  for (const { name, runtime } of actors) {
    const expected = name === 'HuYifei' ? 'gpt-6.1-sol' : 'gpt-6-luna';
    assert.equal(runtime.model.id, expected);
    assert.equal(runtime.models.getModel('fixture-proxy', expected)?.id, expected);
    assert.equal(runtime.model.baseUrl, 'http://fixture.invalid/v1');
  }
  assert.equal(process.env.ANIMA_MODEL, 'gpt-6-luna');
  assert.equal((await loadModel()).model.id, 'gpt-6-luna');
  assert.equal((await loadModel({ modelId: '  ' })).model.id, 'gpt-6-luna');
});

test('explicit model choice also preserves local pi model definitions and default selection', async t => {
  const root = await directory(t);
  environment(t, { ANIMA_API_KEY: undefined, PI_EXAMPLE_API_KEY: undefined,
    ANIMA_PI_CONFIG_DIR: root, ANIMA_PI_PROVIDER: 'fixture-pi', ANIMA_MODEL: 'default-model' });
  await writeFile(join(root, 'models.json'), JSON.stringify({ providers: {
    'fixture-pi': { api: 'openai-completions', baseUrl: 'http://fixture.invalid/v1', models: [
      { id: 'default-model', maxTokens: 900 }, { id: 'alternate-model', contextWindow: 12345, maxTokens: 1700 },
    ] },
  } }));
  await writeFile(join(root, 'auth.json'), JSON.stringify({ 'fixture-pi': { type: 'api_key', key: 'fixture-only' } }));
  const [normal, alternate] = await Promise.all([loadModel(), loadModel({ modelId: 'alternate-model' })]);
  assert.equal(normal.model.id, 'default-model');
  assert.equal(normal.model.maxTokens, 900);
  assert.equal(alternate.model.id, 'alternate-model');
  assert.equal(alternate.model.contextWindow, 12345);
  assert.equal(alternate.model.maxTokens, 1700);
  assert.equal(process.env.ANIMA_MODEL, 'default-model');
});

test('four concurrent Minecraft tasks send their selected model and persist actual metrics', async t => {
  proxyEnvironment(t);
  const root = await directory(t), worldId = 'model-selection-fixture';
  const requests: string[] = [], events: any[] = [], bodies: any[] = [];
  const modelCalls: { name: string; type: string; at: number; channel: string }[] = [];
  const providerCalls: { name: string; startedAt: number; returnedAt?: number }[] = [];
  let selectedCalls = 0;
  // Exercise the installed OpenAI-compatible serializer and tool loop, with no
  // network requests or real world execution. Any unexpected request fails here.
  t.mock.method(globalThis, 'fetch', async (input: any, init: any) => {
    assert.equal(String(input), 'http://fixture.invalid/v1/chat/completions');
    const body = JSON.parse(init.body), model = body.model;
    const prompt = body.messages.find((message: any) => message.role === 'system')?.content;
    const actor = DEFAULT_WORLD_NPCS.find(actor => prompt?.includes(`你是 Anima 世界中的居民 ${actor.name}。`));
    assert.ok(actor, 'Each actual provider request identifies the actor in its system context.');
    const providerCall = { name: actor.name, startedAt: Date.now(), returnedAt: undefined as number | undefined };
    providerCalls.push(providerCall);
    requests.push(model);
    await delay(4);
    const useTool = model === 'gpt-6.1-sol' && selectedCalls++ === 0;
    const delta = useTool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'fixture-wait', type: 'function',
      function: { name: 'action', arguments: JSON.stringify({ type: 'wait', ms: 1 }) } }] }
      : { role: 'assistant', content: '继续观察当前世界。' };
    const chunks = [
      { id: 'fixture-response', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason: null }] },
      { id: 'fixture-response', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: useTool ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 31, completion_tokens: 7, total_tokens: 38 } },
    ];
    providerCall.returnedAt = Date.now();
    return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const records = new Map(DEFAULT_WORLD_NPCS.map(actor => [actor.name, { ...actor, ready: true, task: undefined as any }]));
  const world: any = {
    memoryNamespace: worldId,
    get: (name: string) => records.get(name),
    observe: (name: string) => ({ name, time: new Date().toISOString(), position: { x: 0, y: 64, z: 0 },
      health: 20, food: 20, inventory: [], recentEvents: [] }),
    event: (record: any, type: string, data: any) => { events.push({ name: record.name, type, ...data }); },
    subscribe: () => () => {}, interruptAction: () => {},
    execute: async (name: string, action: any) => {
      bodies.push({ name, action }); return { id: 'fixture-body', action, status: 'completed' };
    },
  };
  const results = await Promise.all(DEFAULT_WORLD_NPCS.map(actor => runTask(world, actor.name, '依据当前情况行动。', root, {
    modelDelayMs: 6, onModelCall: event => modelCalls.push({ name: actor.name, ...event }),
  })));
  assert.equal(requests.filter(id => id === 'gpt-6-luna').length, 3);
  assert.equal(requests.filter(id => id === 'gpt-6.1-sol').length, 2);
  assert.deepEqual(bodies, [{ name: 'HuYifei', action: { type: 'wait', ms: 1 } }]);
  for (let i = 0; i < DEFAULT_WORLD_NPCS.length; i++) {
    const name = DEFAULT_WORLD_NPCS[i].name, result = results[i];
    const expected = `fixture-proxy/${name === 'HuYifei' ? 'gpt-6.1-sol' : 'gpt-6-luna'}`;
    assert.equal(result.status, 'completed');
    assert.equal(result.model, expected);
    const text = await readFile(join(root, 'var/minecraft/diagnostics', worldId, `${name}.jsonl`), 'utf8');
    const diagnostic = JSON.parse(text.trim());
    assert.equal(diagnostic.model, expected);
    assert.equal(diagnostic.turns, name === 'HuYifei' ? 2 : 1);
    assert.equal(diagnostic.actions, name === 'HuYifei' ? 1 : 0);
    assert.equal(diagnostic.usage.totalTokens, (name === 'HuYifei' ? 2 : 1) * 38);
    assert.ok(diagnostic.durationMs >= 4);
    const actualRequests = providerCalls.filter(call => call.name === name);
    assert.equal(diagnostic.modelRequests.length, actualRequests.length);
    assert.equal(new Set(diagnostic.modelRequests.map((row: any) => row.channel)).size, actualRequests.length);
    for (const [index, row] of diagnostic.modelRequests.entries()) {
      const actual = actualRequests[index];
      assert.deepEqual(Object.keys(row).sort(), ['channel', 'durationMs', 'finishedAt', 'injectedDelayMs', 'startedAt', 'status']);
      assert.equal(row.injectedDelayMs, 6);
      assert.ok(Number.isFinite(row.startedAt) && row.startedAt <= actual.startedAt);
      assert.ok(Number.isFinite(row.finishedAt) && row.finishedAt >= actual.returnedAt!);
      assert.equal(row.durationMs, row.finishedAt - row.startedAt); assert.ok(row.durationMs >= 4);
      assert.ok(['toolUse', 'stop'].includes(row.status));
      const pair = modelCalls.filter(call => call.name === name && call.channel === row.channel);
      assert.deepEqual(pair.map(call => call.type), ['model-start', 'model-end']);
      assert.ok(pair[0].at >= row.startedAt && pair[0].at <= actual.startedAt);
      assert.ok(pair[1].at >= row.finishedAt);
    }
    assert.equal(events.find(event => event.name === name && event.type === 'task-finished')?.model, expected);
    assert.equal(records.get(name)?.task, undefined);
    assert.doesNotMatch(text, /fixture-key-not-a-real-credential|apiKey|fixture\.invalid|你是 Anima 世界中的居民|依据当前情况行动/);
  }
  assert.equal(process.env.ANIMA_MODEL, 'gpt-6-luna');
});

test('cancellation during injected model latency closes the diagnostic request without sending provider data', async t => {
  proxyEnvironment(t);
  const root = await directory(t), worldId = 'model-abort-fixture', controller = new AbortController();
  const actor = DEFAULT_WORLD_NPCS[0], record = { ...actor, ready: true, task: undefined as any };
  const calls: any[] = [];
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('Cancellation before dispatch must not reach the provider.'); });
  const world: any = { memoryNamespace: worldId, get: () => record,
    observe: () => ({ name: actor.name, position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, inventory: [], recentEvents: [] }),
    event: () => {}, subscribe: () => () => {}, interruptAction: () => {}, execute: async () => assert.fail('No body command was authorized.') };
  const result = await runTask(world, actor.name, '先观察。', root, { signal: controller.signal, modelDelayMs: 50,
    onModelCall: event => { calls.push(event); if (event.type === 'model-start') controller.abort(); } });
  assert.equal(result.status, 'cancelled'); assert.deepEqual(calls.map(event => event.type), ['model-start', 'model-end']);
  const text = await readFile(join(root, 'var/minecraft/diagnostics', worldId, `${actor.name}.jsonl`), 'utf8');
  const diagnostic = JSON.parse(text.trim());
  assert.equal(diagnostic.modelRequests.length, 1);
  const row = diagnostic.modelRequests[0];
  assert.equal(row.channel, calls[0].channel); assert.equal(row.channel, calls[1].channel);
  assert.equal(row.status, 'aborted'); assert.equal(row.injectedDelayMs, 50);
  assert.ok(Number.isFinite(row.finishedAt)); assert.equal(row.durationMs, row.finishedAt - row.startedAt);
  assert.doesNotMatch(text, /fixture-key-not-a-real-credential|apiKey|fixture\.invalid|你是 Anima 世界中的居民/);
});

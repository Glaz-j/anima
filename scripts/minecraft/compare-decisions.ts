import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runWorldAgent } from '../../packages/pi-runtime/src/world-agent.ts';
import { loadModel } from '../../packages/pi-runtime/src/model.ts';
import { WorldMemory } from '../../packages/npc-core/src/world-memory.ts';
import { loadWorldPersona } from '../../packages/npc-core/src/world-persona.ts';
import { SurvivalScenario } from '../../adapters/minecraft/src/survival-scenario.ts';

// Compare the first decision on one frozen real observation. This script has
// GET-only access to the game and writes only isolated diagnostic memory copies.
// Proposed actions are recorded, NEVER executed. This is not a gameplay score.
const root = resolve(import.meta.dirname, '../..');
const name = process.argv[2] || 'Sheldon';
const modelIds = process.argv.slice(3);
if (!/^[A-Za-z0-9_]{1,16}$/u.test(name) || !modelIds.length || modelIds.length > 3) {
  throw new Error('Usage: node --env-file-if-exists=.env scripts/minecraft/compare-decisions.ts <npc> <model> [model] [model]');
}
const session = JSON.parse(await readFile(join(root, 'var/minecraft/api-session.json'), 'utf8'));
const get = async (path: string) => {
  const response = await fetch(session.baseUrl + path, { headers: { Authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Read-only snapshot ${path}: HTTP ${response.status}`);
  return response.json();
};
const [actors, experiment, observation] = await Promise.all([get('/api/bots'), get('/api/experiment'), get(`/api/bots/${name}/observe`)]);
const actor = actors.bots.find((entry: any) => entry.name === name);
if (!actor || experiment.scenario?.kind !== 'survival') throw new Error('An initialized survival actor is required.');
const worldId = experiment.scenario.worldId;
const directory = join(root, 'var/minecraft/decision-comparisons', randomUUID());
const memoryDirectory = join(directory, 'memory');
await mkdir(join(memoryDirectory, name), { recursive: true });
await copyFile(join(root, 'data/world-memory', worldId, name, `${actor.roleId}.jsonl`), join(memoryDirectory, name, `${actor.roleId}.jsonl`));
const memory = await WorldMemory.open(memoryDirectory, name, actor.roleId, worldId);
const persona = await loadWorldPersona(root, actor.roleId, actor.persona);
const scenario = new SurvivalScenario(directory, () => { throw new Error('Console commands are unavailable in a decision comparison.'); });
scenario.snapshot.worldId = worldId;
const base = await loadModel();
const controller = new AbortController();
let captured: any;
await runWorldAgent({
  instruction: experiment.scheduler.scenario.summary, memory, persona, signal: controller.signal, goalReview: false,
  port: { name, roleId: actor.roleId, persona: actor.persona, observe: () => structuredClone(observation),
    scenarioContext: () => scenario.publicContext(), execute: async () => { throw new Error('No body execution in a decision comparison.'); } },
  runtime: { ...base, models: { streamSimple: (_model: unknown, context: unknown) => {
    captured = JSON.parse(JSON.stringify(context));
    controller.abort(); throw new Error('Captured input without dispatching a model or action.');
  } } } as any,
});
if (!captured) throw new Error('Could not capture the real harness input.');
await writeFile(join(directory, 'input.json'), JSON.stringify({ time: new Date().toISOString(), name, worldId, observation, context: captured }, null, 2));
const results = [];
for (const id of modelIds) {
  process.env.ANIMA_MODEL = id;
  const runtime = await loadModel(), started = Date.now();
  try {
    const response = await runtime.models.completeSimple(runtime.model, captured, {
      apiKey: runtime.apiKey, maxTokens: 1100, signal: AbortSignal.timeout(45_000), maxRetryDelayMs: 1000,
    });
    const result = { model: id, durationMs: Date.now() - started, stopReason: response.stopReason,
      content: response.content.filter((entry: any) => entry.type !== 'thinking'), usage: response.usage,
      ...(response.errorMessage ? { error: response.errorMessage } : {}) };
    results.push(result); console.log(JSON.stringify(result));
  } catch (error: any) {
    const result = { model: id, durationMs: Date.now() - started, error: String(error.message).slice(0, 500) };
    results.push(result); console.log(JSON.stringify(result));
  }
}
await writeFile(join(directory, 'results.json'), JSON.stringify({ name, worldId, scope: 'first-decision-only; no actions executed', results }, null, 2));
console.log(JSON.stringify({ artifact: directory, noActionsExecuted: true, systemChars: captured.systemPrompt?.length }));

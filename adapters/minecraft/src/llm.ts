import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { WorldMemory, worldMemoryNamespace } from '../../../packages/npc-core/src/world-memory.ts';
import { loadWorldPersona } from '../../../packages/npc-core/src/world-persona.ts';
import { runWorldAgent } from '../../../packages/pi-runtime/src/world-agent.ts';
import { loadModel } from '../../../packages/pi-runtime/src/model.ts';
import { ApiError } from './validation.ts';
import type { MinecraftWorld } from './world.ts';

// Keep the shared provider/credentials; an optional per-actor ID changes only this runtime.
export function loadNpcModel(name: string) {
  return loadModel({ modelId: process.env[`ANIMA_MC_MODEL_${name.toUpperCase()}`] });
}

// Minecraft owns body/task locking; NPC code owns personality and memory.
export async function runTask(world: MinecraftWorld, name: string, instruction: string, root: string,
  options: { signal?: AbortSignal; context?: unknown; worldId?: string } = {}) {
  const record = world.get(name);
  if (!record.ready) throw new ApiError(503, '角色尚未进入世界。');
  if (record.task || record.actionController) throw new ApiError(409, '角色正在执行其他任务。');
  const task = { id: randomUUID(), controller: new AbortController() };
  const started = Date.now();
  record.task = task;
  const cancel = () => { task.controller.abort(); record.actionController?.abort(); };
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (options.signal?.aborted) cancel();
    const worldId = worldMemoryNamespace(options.worldId ?? (world as MinecraftWorld & { memoryNamespace?: string }).memoryNamespace ?? 'minecraft');
    const memory = await WorldMemory.open(join(root, 'data/world-memory', worldId), name, record.roleId, worldId);
    const persona = await loadWorldPersona(root, record.roleId, record.persona);
    const runtime = await loadNpcModel(name);
    world.event(record, 'task-started', { taskId: task.id, instruction, model: `${runtime.model.provider}/${runtime.model.id}` });
    const result = await runWorldAgent({
      taskId: task.id, instruction, memory, persona, runtime, signal: task.controller.signal, context: options.context,
      port: {
        name, persona: record.persona, roleId: record.roleId,
        observe: () => world.observe(name),
        subscribe: listener => world.subscribe(name, listener),
        interruptAction: () => world.interruptAction(name),
        scenarioContext: () => (world as MinecraftWorld & { scenarioContext?: (name: string) => unknown }).scenarioContext?.(name),
        async execute(action, taskId, signal) {
          const stop = () => record.actionController?.abort(signal.reason);
          signal.addEventListener('abort', stop, { once: true });
          try { if (signal.aborted) throw new Error('任务已取消。'); return await world.execute(name, action, taskId); }
          finally { signal.removeEventListener('abort', stop); }
        },
      },
    });
    if (result.status === 'cancelled' && task.controller.signal.reason?.type === 'world-event') {
      result.reason = 'world-change';
      result.error = undefined;
    }
    const durationMs = Date.now() - started;
    world.event(record, 'task-finished', { taskId: task.id, status: result.status, reason: result.reason, error: result.error,
      model: result.model, durationMs,
      reply: result.reply, actions: result.actions.length, turns: result.turns, usage: result.usage,
      toolCalls: result.toolTrace.length, toolErrors: result.toolTrace.filter(item => item.error).length, emergencyBudget: result.emergencyBudget,
      budgetYield: result.budgetYield,
      goalReview: result.goalReview ? { status: result.goalReview.status, applied: result.goalReview.applied, turns: result.goalReview.turns } : undefined });
    // Diagnostics do not enter heard/world event context or NPC autobiographical memory.
    const diagnosticDirectory = join(root, 'var/minecraft/diagnostics', worldId);
    try {
      await mkdir(diagnosticDirectory, { recursive: true });
      await appendFile(join(diagnosticDirectory, `${name}.jsonl`), JSON.stringify({ time: new Date().toISOString(),
        taskId: task.id, worldId, name, roleId: record.roleId, status: result.status, reason: result.reason,
        model: result.model, turns: result.turns, actions: result.actions.length, usage: result.usage, durationMs,
        toolTrace: result.toolTrace, emergencyBudget: result.emergencyBudget, goalReview: result.goalReview, budgetYield: result.budgetYield,
        ...(result.perceptionErrors?.length ? { perceptionErrors: result.perceptionErrors } : {}) }) + '\n', 'utf8');
    } catch (error: any) { world.event(record, 'diagnostic-write-failed', { taskId: task.id, error: String(error.message).slice(0, 200) }); }
    return result;
  } catch (error: any) {
    world.event(record, 'task-failed', { taskId: task.id, message: error.message });
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', cancel);
    if (record.task?.id === task.id) record.task = undefined;
  }
}

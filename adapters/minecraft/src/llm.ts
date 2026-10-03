import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { WorldMemory, worldMemoryNamespace } from '../../../packages/npc-core/src/world-memory.ts';
import { loadWorldPersona } from '../../../packages/npc-core/src/world-persona.ts';
import { runWorldAgent } from '../../../packages/pi-runtime/src/world-agent.ts';
import { loadModel } from '../../../packages/pi-runtime/src/model.ts';
import { ApiError, text } from './validation.ts';
import type { BodyActivationTicket, MinecraftWorld } from './world.ts';
import { describeBuild } from './build-blueprints.ts';

// Keep the shared provider/credentials; an optional per-actor ID changes only this runtime.
export function loadNpcModel(name: string) {
  return loadModel({ modelId: process.env[`ANIMA_MC_MODEL_${name.toUpperCase()}`] });
}

// Minecraft owns body/task locking; NPC code owns personality and memory.
export async function runTask(world: MinecraftWorld, name: string, instruction: string, root: string,
  options: { signal?: AbortSignal; context?: unknown; worldId?: string; bodyExecution?: 'serial' | 'parallel' | 'dual';
    newTask?: BodyActivationTicket;
    continuity?: boolean;
    throughputOptimizations?: boolean;
    liveObservation?: boolean;
    modelDelayMs?: number; onModelCall?: (event: { type: 'model-start' | 'model-end'; at: number; channel: string }) => void } = {}) {
  const record = world.get(name);
  instruction = text(instruction, 'instruction', options.newTask ? 3000 : 100000);
  if (!record.ready) throw new ApiError(503, '角色尚未进入世界。');
  if (record.task || (!record.body && record.actionController)) throw new ApiError(409, '角色正在执行其他任务。');
  // Body ablation is explicit and must precede any fresh authorization. Merely
  // entering a serial reasoning turn must not reconfigure an existing grant.
  if (options.throughputOptimizations !== undefined)
    record.body?.setThroughputOptimizations?.(options.throughputOptimizations);
  if (options.newTask) {
    if (options.newTask.record !== record || options.signal?.aborted) throw new ApiError(409, '新任务授权已失效。');
    world.authorizeTask(options.newTask, options.bodyExecution ?? 'dual');
  }
  if (record.operatorStopped) throw new ApiError(409, '角色已被操作者停止，请显式恢复。');
  const task = { id: randomUUID(), controller: new AbortController() };
  const started = Date.now();
  record.task = task;
  const cancel = () => { task.controller.abort(); if (!record.body) record.actionController?.abort(); };
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (options.signal?.aborted) cancel();
    const throughput = options.continuity !== false && options.throughputOptimizations !== false && options.bodyExecution !== 'serial';
    if (record.body && record.body.snapshot().version === 0 && !task.controller.signal.aborted) {
      const control = record.body.snapshot();
      record.body.submit({ expectedVersion: control.version, steps: [], ttlMs: 120000,
        label: '等待规划时保持生存', reactions: !options.bodyExecution || options.bodyExecution === 'dual' ? ['surface', 'eat', 'defend', 'flee'] : [] }, control.stopped);
    }
    const worldId = worldMemoryNamespace(options.worldId ?? (world as MinecraftWorld & { memoryNamespace?: string }).memoryNamespace ?? 'minecraft');
    const memory = await WorldMemory.open(join(root, 'data/world-memory', worldId), name, record.roleId, worldId);
    const persona = await loadWorldPersona(root, record.roleId, record.persona);
    const runtime = await loadNpcModel(name);
    const modelRequests: { channel: string; startedAt: number; finishedAt?: number; durationMs?: number; status?: string; injectedDelayMs: number }[] = [];
    {
      const stream = runtime.models.streamSimple.bind(runtime.models);
      runtime.models.streamSimple = (async (model: any, context: any, streamOptions: any) => {
        const channel = randomUUID();
        const row: (typeof modelRequests)[number] = { channel, startedAt: Date.now(), injectedDelayMs: options.modelDelayMs ?? 0 };
        if (modelRequests.length < 32) modelRequests.push(row);
        const report = (type: 'model-start' | 'model-end') => {
          try { options.onModelCall?.({ type, at: Date.now(), channel }); } catch { /* diagnostic only */ }
        };
        const finish = (status: string) => {
          if (row.finishedAt !== undefined) return;
          row.finishedAt = Date.now(); row.durationMs = row.finishedAt - row.startedAt; row.status = status;
          report('model-end');
        };
        report('model-start');
        try {
          if (options.modelDelayMs) await delay(options.modelDelayMs, undefined, { signal: streamOptions?.signal ?? task.controller.signal });
          const response = stream(model, context, streamOptions);
          void response.result().then(result => finish(result.stopReason ?? 'finished'), () => finish('error'));
          return response;
        } catch (error) { finish(streamOptions?.signal?.aborted ? 'aborted' : 'error'); throw error; }
      }) as typeof runtime.models.streamSimple;
    }
    world.event(record, 'task-started', { taskId: task.id, instruction, model: `${runtime.model.provider}/${runtime.model.id}` });
    const result = await runWorldAgent({
      taskId: task.id, instruction, memory, persona, runtime, signal: task.controller.signal, context: options.context, continuity: options.continuity,
      throughputOptimizations: throughput,
      liveObservation: options.liveObservation,
      port: {
        name, persona: record.persona, roleId: record.roleId,
        observe: () => world.observe(name),
        constructionPlan: options => describeBuild(options),
        subscribe: listener => world.subscribe(name, listener),
        interruptAction: () => { if (!record.body) world.interruptAction(name); },
        ...(record.body ? { body: {
          executionMode: options.bodyExecution || 'dual',
          status: () => record.body!.snapshot(),
          append: (request: any) => record.body!.append(request),
          recordPlanningLatency: milliseconds => record.body!.recordPlanningLatency(milliseconds),
          submit: async (request: any) => {
            const input = !options.bodyExecution || options.bodyExecution === 'dual' ? request : { ...request, reactions: [] };
            const lastReceiptId = record.body!.snapshot().recentReceipts.at(-1)?.id ?? -1;
            const result = record.body!.submit(input, input.resume === true);
            if (!result.accepted || options.bodyExecution !== 'serial') return result;
            // Experimental serial baseline uses the same skill executor/schema,
            // but reasoning waits for completion and grants no reflex autonomy.
            try {
              while (true) {
                task.controller.signal.throwIfAborted();
                const state = record.body!.snapshot();
                if (state.version !== result.version || !state.intent || state.workCompleted)
                  return { ...result, waitedForBody: true, control: state };
                // A serial ReAct baseline must receive failures too. Otherwise a
                // permanent local error keeps its planner waiting until the whole
                // lease expires, unfairly disabling correction in this condition.
                const failed = state.recentReceipts.find(receipt => receipt.id > lastReceiptId
                  && receipt.intentVersion === result.version && receipt.intentId === result.intentId
                  && receipt.status !== 'completed');
                if (failed) {
                  const cancelled = record.body!.cancel(result.version);
                  if (cancelled.accepted) await record.body!.controller.whenIdle();
                  return { ...result, waitedForBody: true, reason: 'body_failed', failedReceipt: failed,
                    control: record.body!.snapshot() };
                }
                await delay(50, undefined, { signal: task.controller.signal });
              }
            } catch (error) {
              const cancelled = record.body!.cancel(result.version);
              if (cancelled.accepted) await record.body!.controller.whenIdle();
              throw error;
            }
          },
          cancel: (expectedVersion: number) => record.body!.cancel(expectedVersion),
        } } : {}),
        scenarioContext: () => (world as MinecraftWorld & { scenarioContext?: (name: string) => unknown }).scenarioContext?.(name),
        async execute(action, taskId, signal) {
          const stop = () => { if (!record.body) record.actionController?.abort(signal.reason); };
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
        toolTrace: result.toolTrace, modelRequests, bodyReplan: result.bodyReplan, firstPlan: result.firstPlan,
        emergencyBudget: result.emergencyBudget, goalReview: result.goalReview, budgetYield: result.budgetYield,
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

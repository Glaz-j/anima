import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { MinecraftWorld } from '../src/world.ts';
import { runTask, loadNpcModel } from '../src/llm.ts';
import { ExamReactionObserver } from './reaction-observer.ts';
import type { ExamExecutor } from './types.ts';

/** Candidate-side adapter. It receives no RCON access, task geometry, judge state,
 * hidden perturbations or success flags. Skill mode uses an explicit reference
 * plan compiled from the public instruction; agent mode delegates planning to pi. */
export async function createExamExecutor(options: { root: string; host: string; port: number; version: string; actor: string; architecture?: 'serial' | 'parallel' | 'dual' }) {
  const world = new MinecraftWorld({ host: options.host, port: options.port, version: options.version,
    logDirectory: join(options.root, 'var/minecraft/skill-exam/candidate-events'), dualLoop: true });
  world.memoryNamespace = `skill-exam-${Date.now()}`;
  const record = world.add(options.actor, '你是一名参加技能考场的Minecraft居民。只使用自己实际观察到的信息，诚实报告进展。');
  const until = Date.now() + 30000;
  while (!record.ready || !record.inventorySynced) {
    if (record.error || Date.now() > until) { world.close(); throw new Error(record.error || 'Candidate did not spawn.'); }
    await delay(100);
  }
  const executor: ExamExecutor = {
    async start(context) {
      world.memoryNamespace = `skill-exam-${context.taskId}-${Date.now()}`;
      const body = record.body!, own = new AbortController();
      const signal = AbortSignal.any([own.signal, context.signal]);
      const reactions = new ExamReactionObserver(record.bot,
        () => body.snapshot().current?.skill.action.native, event => context.emit(event));
      world.onControlMetric = (_actor, event) => {
        // Candidate policy instrumentation is not a comparable danger baseline:
        // disabled reflexes must still have their missed hazards measured.
        if (event.type !== 'hazard-observed' && event.type !== 'reaction') context.emit(event);
        if (event.type === 'input') reactions.input(event);
      };
      reactions.start();
      const stop = () => { own.abort(); void world.stop(record); };
      context.signal.addEventListener('abort', stop, { once: true });
      const submit = (steps: any[], reactions = ['surface', 'eat', 'defend', 'flee']) => {
        signal.throwIfAborted();
        const state = body.snapshot();
        const result = body.submit({ expectedVersion: state.version, steps,
          reactions: !options.architecture || options.architecture === 'dual' ? reactions : [], ttlMs: 240000,
          label: context.instruction, policy: { threatRange: 7, chaseRange: 12, retreatHealth: 5 } }, state.stopped);
        if (!result.accepted) throw new Error(`Body rejected goal: ${result.reason}`);
        return result;
      };
      const finished = async () => {
        while (!signal.aborted) {
          const state = body.snapshot();
          if (!state.intent && !state.current) return;
          await delay(100, undefined, { signal });
        }
        signal.throwIfAborted();
      };
      const job = (async () => {
        // Server initialization has completed, allow ordinary update packets to arrive.
        await delay(200, undefined, { signal });
        if (context.mode === 'agent') {
          record.operatorStopped = false;
          while (!signal.aborted && record.ready) {
            const result = await runTask(world, record.name, context.instruction, options.root, { signal,
              bodyExecution: options.architecture || 'dual',
              modelDelayMs: context.modelDelayMs, onModelCall: event => context.emit(event),
              context: { purpose: '独立技能考场，世界实时运行。保持当前有效身体目标；只有目标无效、失败或需要改变时才替换。' } });
            if (result.reason === 'error') { context.fail('模型请求失败，无法有效评测该次Agent运行。'); return; }
            await delay(2000, undefined, { signal });
          }
          return;
        }
        // These are reference plans, not claims of model reasoning ability.
        const category = context.category, text = context.instruction;
        if (category === 'combat-single' || category === 'combat-multiple') {
          submit([]); return; // Reactive policy chooses only currently visible threats.
        }
        if (category === 'gather' || category === 'eat-resume' || category === 'interrupt-resume') {
          const count = Number(/(\d+)\s*根/u.exec(text)?.[1]);
          if (!count) throw new Error('Public instruction needs a resource count.');
          submit([{ type: 'gather', block: 'oak_log', count, maxDistance: 16 }]); return;
        }
        if (category === 'craft') {
          const scan: any = await world.execute(record.name, { type: 'scan', name: 'crafting_table', radius: 16, count: 5 });
          const table = scan.details?.blocks?.find((b: any) => b.name === 'crafting_table')?.position;
          if (!table) throw new Error('No visible crafting table.');
          submit([{ type: 'craft', item: 'oak_planks', count: 8 }, { type: 'craft', item: 'stick', count: 4 },
            { type: 'craft', item: 'wooden_pickaxe', count: 1, table }]); return;
        }
        if (category === 'parkour-empty') {
          const xs = [...text.matchAll(/x=(\d+(?:\.\d+)?)/gu)].map(m => Number(m[1]));
          if (!xs.length) throw new Error('Public instruction needs landing points.');
          const { y, z } = record.bot.entity.position;
          submit(xs.flatMap(x => [{ type: 'jump_to', x, y: Math.round(y), z, durationMs: 5000 }, { type: 'wait', ms: 500 }]), []); return;
        }
        if (category === 'navigate') {
          const points = [...text.matchAll(/x=(\d+(?:\.\d+)?),z=(\d+(?:\.\d+)?)/gu)]
            .map(m => ({ type: 'travel', x: Number(m[1]), z: Number(m[2]) }));
          if (!points.length) throw new Error('Public instruction needs waypoints.');
          submit(points); return;
        }
        if (category === 'water-rescue') {
          const m = /x=(\d+(?:\.\d+)?),y=(\d+(?:\.\d+)?),z=(\d+(?:\.\d+)?)/u.exec(text);
          if (!m) throw new Error('Public instruction needs a shore point.');
          submit([{ type: 'surface', target: { x: +m[1], y: +m[2], z: +m[3] }, durationMs: 10000 }], ['surface']); return;
        }
        if (category === 'parkour-items') {
          const points = [...text.matchAll(/x=(\d+(?:\.\d+)?),y=(\d+(?:\.\d+)?)/gu)].map(m => ({ x: +m[1], y: +m[2] }));
          if (points.length !== 2) throw new Error('Public instruction needs bridge and upper landing points.');
          // Only the public destination and current local position enter the skill.
          // The bounded bridge controller discovers support and spends real blocks.
          submit([{ type: 'bridge', x: points[0].x, z: record.bot.entity.position.z,
            item: 'cobblestone', maxBlocks: 8 }, { type: 'wait', ms: 500 }], []);
          await finished();
          const p = record.bot.entity.position, z = Math.floor(p.z);
          const wallX = Math.floor(points[1].x) - 1;
          submit([{ type: 'place', x: wallX - 1, y: Math.round(p.y), z, item: 'cobblestone' },
            { type: 'goto', x: wallX - .5, y: Math.round(p.y) + 1, z: z + .5 },
            { type: 'goto', x: points[1].x, y: points[1].y, z: z + .5 }], []); return;
        }
        throw new Error(`No reference skill plan for ${category}.`);
      })().catch(error => {
        if (signal.aborted) return;
        if (context.mode === 'agent') context.fail('Agent运行发生未处理异常，未能完成有效评测。');
        else context.emit({ type: 'note', at: Date.now(), message: `Candidate error: ${error.message}` });
      });
      return { async stop() {
        reactions.stop();
        own.abort(); await world.stop(record); await job;
        context.signal.removeEventListener('abort', stop); world.onControlMetric = undefined;
      } };
    },
  };
  let model: { provider: string; id: string } | undefined;
  try { const runtime = await loadNpcModel(options.actor); model = { provider: runtime.model.provider, id: runtime.model.id }; }
  catch { /* Model-free skill trials do not require provider configuration. */ }
  return { executor, metadata: { ...(model ? { model } : {}), controller: 'minecraft-body' },
    async close() {
      await world.stop(record); await record.body?.dispose();
      // Repeated trials create fresh brains/bodies. Wait for the old connection
      // to end before another client uses the same identity.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ended = new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); record.bot.removeListener('end', done); resolve(); };
        record.bot.once('end', done); timer = setTimeout(done, 3000);
      });
      world.close(); await ended;
    } };
}

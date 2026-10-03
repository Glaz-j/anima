/** Real-server correction probe; not a phase-one score.
 * The trusted fixture seeds one deliberately invalid work step. A real pi
 * agent must inspect its failure and reach the public destination. No model
 * sees RCON, the referee snapshots, or a reference route.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { MinecraftWorld } from '../src/world.ts';
import { runTask, loadNpcModel } from '../src/llm.ts';
import { loadExamServer } from './server.ts';
import { VanillaExamAdapter } from './adapter.ts';
import { getExamTask } from './tasks.ts';
import { captureExamSource } from './runner.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const distance = (a: any, b: any) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
async function main() {
  if (!process.argv.includes('--run')) {
    console.log('node --env-file-if-exists=.env adapters/minecraft/benchmark/replan-probe.ts --run [--delay=10000]'); return;
  }
  const modelDelayMs = Number(process.argv.find(value => value.startsWith('--delay='))?.slice(8) ?? 0);
  assert.ok(Number.isInteger(modelDelayMs) && modelDelayMs >= 0 && modelDelayMs <= 10000);
  const config = await loadExamServer(root);
  assert.equal(config.kind, 'anima-skill-exam'); assert.equal(config.gamePort, 25575); assert.equal(config.rconPort, 25585);
  assert.equal(resolve(config.directory), resolve(root, 'var/minecraft/skill-exam/server'));
  const source = await captureExamSource(root), actor = 'ReplanProbe';
  const model = await loadNpcModel(actor);
  const output = join(root, 'var/minecraft/skill-exam/replanning', new Date().toISOString().replace(/[:.]/gu, '-'));
  const controller = new AbortController(), signal = controller.signal;
  const timer = setTimeout(() => controller.abort(new Error('Correction probe deadline.')), 180000);
  const interrupt = () => controller.abort(new Error('Interrupted.')); process.once('SIGINT', interrupt);
  const world = new MinecraftWorld({ host: '127.0.0.1', port: config.gamePort, version: config.version,
    logDirectory: join(output, 'candidate-events'), dualLoop: true });
  world.memoryNamespace = `replan-probe-${randomUUID()}`;
  const referee = new VanillaExamAdapter(config), events: any[] = [], checks: string[] = [];
  const record = world.add(actor, '独立技能考场的测试角色；根据自己的观察完成任务。');
  let job: Promise<unknown> | undefined, error: string | undefined, phase = 'setup', owners = 0, maxOwners = 0;
  let initialVersion = -1, pendingModels = 0, originalFailures = 0, overlappingFailureSamples = 0;
  let firstFailureAt: number | undefined, firstCorrectionAt: number | undefined, reachedAt: number | undefined;
  const execute = world.executeOwned.bind(world);
  world.executeOwned = async (name, action, ownerSignal) => {
    owners++; maxOwners = Math.max(maxOwners, owners);
    events.push({ at: Date.now(), phase, type: 'native-start', action, version: record.body?.snapshot().version });
    try { return await execute(name, action, ownerSignal); }
    finally { owners--; events.push({ at: Date.now(), phase, type: 'native-end' }); }
  };
  world.onEvent = (_record, event) => {
    if (!['skill-finished', 'goal-blocked', 'intent-accepted', 'control-error'].includes(event.type)) return;
    events.push({ at: Date.now(), phase, type: 'body-event', event, pendingModels });
    if (event.type === 'skill-finished' && event.controlEvent?.receipt?.intentVersion === initialVersion
      && event.controlEvent.receipt.status === 'failed') { originalFailures++; firstFailureAt ??= Date.now(); }
    if (phase === 'agent' && event.type === 'intent-accepted') firstCorrectionAt ??= Date.now();
  };
  const until = async (predicate: () => boolean, timeout = 20000) => {
    const deadline = Date.now() + timeout;
    while (!predicate()) { signal.throwIfAborted(); assert.ok(Date.now() < deadline, `Timeout in ${phase}`); await delay(50, undefined, { signal }); }
  };
  const destination = { x: 4.5, y: 64, z: .5 };
  try {
    await until(() => record.ready && record.inventorySynced === true);
    const fixture = structuredClone(getExamTask('navigate-01'));
    fixture.terrain = [{ from: { x: 2, y: 64, z: 0 }, to: { x: 2, y: 65, z: 0 }, block: 'bedrock' }];
    fixture.inventory = []; fixture.enemies = [];
    await referee.prepare(fixture, actor, signal);
    await until(() => record.bot.entity.onGround === true && distance(record.bot.entity.position, { x: .5, y: 64, z: .5 }) < .4);
    phase = 'seeded-invalid-step';
    const body = record.body!;
    const seed = body.submit({ expectedVersion: body.snapshot().version, label: '需要复核的旧站位',
      steps: [{ type: 'goto', x: 2.5, y: 64, z: .5 }], reactions: ['surface', 'defend'], ttlMs: 120000 });
    assert.equal(seed.accepted, true); initialVersion = seed.version;
    await until(() => body.snapshot().replanRequired?.code === 'target_blocked');
    await delay(3500, undefined, { signal });
    assert.equal(originalFailures, 1); assert.equal(body.snapshot().current, undefined);
    assert.equal(body.snapshot().goalStatus, 'blocked'); checks.push('One invalid attempt, no automatic replay after backoff');
    phase = 'agent';
    job = (async () => {
      while (!signal.aborted) {
        const result = await runTask(world, actor,
          '抵达主世界人物脚部坐标 x=4.5,y=64,z=0.5，并在地面停稳。旧工作步骤刚刚失败；先结合当前观察决定下一步。禁止破坏或放置方块。',
          root, { signal, worldId: world.memoryNamespace, bodyExecution: 'dual', modelDelayMs,
            context: { purpose: '真实执行失败后的规划纠正测试；没有参考路线。' },
            onModelCall: event => {
              pendingModels += event.type === 'model-start' ? 1 : -1;
              events.push({ ...event, pendingModels });
            } });
        events.push({ at: Date.now(), type: 'brain-finished', status: result.status, reason: result.reason, turns: result.turns });
        if (result.reason === 'error') throw new Error('Model request failed.');
        await delay(1000, undefined, { signal });
      }
    })().catch(cause => { if (!signal.aborted) { error = String(cause?.message ?? cause); controller.abort(); } });
    let stableSince = 0;
    while (!reachedAt) {
      signal.throwIfAborted();
      const evidence = await referee.sample(signal); events.push({ at: Date.now(), type: 'server-evidence', evidence });
      assert.ok(evidence.actor.health > 0, 'Actor stays alive');
      const control = body.snapshot();
      if (control.version === initialVersion && pendingModels > 0) overlappingFailureSamples++;
      if (evidence.actor.onGround && distance(evidence.actor.position, destination) < .55) {
        stableSince ||= Date.now(); if (Date.now() - stableSince >= 300) reachedAt = Date.now();
      } else stableSince = 0;
      if (!reachedAt) await delay(200, undefined, { signal });
    }
    assert.equal(originalFailures, 1); assert.ok(firstCorrectionAt && firstFailureAt && reachedAt > firstCorrectionAt);
    assert.equal(maxOwners, 1); assert.ok(overlappingFailureSamples > 0);
    checks.push('Suspended step does not repeat while actual model request is pending',
      'Real pi planner submits a new version and reaches the destination confirmed by the server', 'One native owner throughout');
  } catch (cause: any) { error ??= String(cause?.message ?? cause); }
  finally {
    controller.abort(); clearTimeout(timer); process.removeListener('SIGINT', interrupt);
    const cleanupErrors: string[] = [];
    const clean = async (name: string, operation: () => unknown) => {
      try { await operation(); } catch (cause: any) { cleanupErrors.push(`${name}: ${String(cause?.message ?? cause)}`); }
    };
    // A cleanup failure must neither mask the original error nor skip closing
    // the remaining connections and preserving the evidence.
    await clean('body stop', () => world.stop(record));
    await clean('brain drain', () => job);
    await clean('body dispose', () => record.body?.dispose());
    await clean('referee cleanup', () => referee.cleanup());
    await clean('RCON close', () => referee.close());
    await clean('world close', () => world.close());
    if (cleanupErrors.length) error ??= 'Probe cleanup was not fully confirmed.';
    const result = { status: error ? 'failed' : 'passed', checks, error, cleanupErrors, source,
      model: { provider: model.model.provider, id: model.model.id }, modelDelayMs,
      originalFailures, maxNativeOwners: maxOwners, overlappingFailureSamples, firstFailureAt, firstCorrectionAt, reachedAt,
      correctionLatencyMs: firstCorrectionAt && firstFailureAt ? firstCorrectionAt - firstFailureAt : null,
      scope: 'real-server-pi-correction-of-fixture-seeded-invalid-work-not-phase-one-score',
      limitations: ['The invalid initial goal is injected by the fixture, not chosen by the model.',
        'One small fixed layout does not prove general replanning or sustained survival.'] };
    await mkdir(output, { recursive: true });
    await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    await writeFile(join(output, 'events.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n');
    console.log(JSON.stringify({ ...result, output }, null, 2)); process.exitCode = error ? 1 : 0;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

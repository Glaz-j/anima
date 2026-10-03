/** Real isolated-arena ownership probe. No model or API credential is used.
 * Run only after other arena trials have disconnected:
 *   node adapters/minecraft/benchmark/ownership-probe.ts --run
 * Trusted fixture setup loads the exam marker and resets gather-01 via RCON.
 * The tested MinecraftWorld/Body receives only the public game connection.
 * Tests: movement -> operator stop -> old-version rejection -> explicit resume,
 * equivalent renewal, explicit restart, replacement without overlapping native
 * owners, and TTL expiry rejecting an old plan. Actual movement/stopping is
 * checked using referee-only server NBT as well as native control events.
 * Output: var/minecraft/skill-exam/ownership/<timestamp>/result.json + events.jsonl.
 * This is a correctness probe, not a scored skill-trial result.
 * Running without --run prints usage and never connects.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { MinecraftWorld, type BotRecord } from '../src/world.ts';
import { loadExamServer } from './server.ts';
import { VanillaExamAdapter } from './adapter.ts';
import { getExamTask } from './tasks.ts';

const distance = (a: any, b: any) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export async function runOwnershipProbe(world: MinecraftWorld, record: BotRecord,
  sampleServer: () => Promise<any>, signal: AbortSignal) {
  const body = record.body!;
  assert.ok(body, 'dual loop must be enabled');
  const events: any[] = [], checks: string[] = [], violations: string[] = [];
  let phase = 'setup', nextOwner = 0, maxOwners = 0;
  const owners = new Map<number, AbortSignal>();
  const execute = world.executeOwned.bind(world), priorEvent = world.onEvent;
  world.onEvent = (actor, event) => {
    priorEvent?.(actor, event);
    if (actor === record) events.push({ at: Date.now(), phase, type: 'world-event', event });
  };
  world.executeOwned = async (name, action, ownerSignal) => {
    const id = ++nextOwner; owners.set(id, ownerSignal); maxOwners = Math.max(maxOwners, owners.size);
    if (owners.size > 1) violations.push(`overlapping native owners: ${[...owners.keys()].join(',')}`);
    events.push({ at: Date.now(), phase, type: 'native-start', id, action });
    try { return await execute(name, action, ownerSignal); }
    finally { events.push({ at: Date.now(), phase, type: 'native-end', id, aborted: ownerSignal.aborted }); owners.delete(id); }
  };
  const until = async (condition: () => boolean, label: string, timeoutMs = 6000) => {
    const deadline = Date.now() + timeoutMs;
    while (!condition() && Date.now() < deadline) { signal.throwIfAborted(); await delay(20, undefined, { signal }); }
    assert.ok(condition(), label);
  };
  const sample = async () => {
    const evidence = await sampleServer();
    events.push({ at: Date.now(), phase, type: 'server-evidence', evidence });
    assert.equal(evidence.actor.name, record.name); assert.ok(evidence.actor.health > 0);
    return evidence.actor.position;
  };
  const plan = (steps: any[], extra: any = {}) => ({ expectedVersion: body.snapshot().version,
    label: 'ownership probe', steps, reactions: [], ttlMs: 12000, ...extra });
  const moving = [{ type: 'goto', x: -5.5, y: 64, z: .5 }];
  const stopped = async () => {
    await until(() => !record.actionController && !body.snapshot().current && !owners.size, 'native owner drains');
    for (const key of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) assert.equal(record.bot.getControlState(key), false, `${key} released`);
    await delay(500, undefined, { signal });
    const before = await sample(); await delay(350, undefined, { signal });
    assert.ok(distance(before, await sample()) < .08, 'server confirms a stationary body after momentum settles');
  };
  const passed = (name: string) => { checks.push(name); events.push({ at: Date.now(), phase, type: 'check-passed', name }); };
  let error: string | undefined;
  try {
    await until(() => record.ready && record.inventorySynced === true && record.bot.entity.onGround, 'actor settles after referee setup');
    const initial = await sample(); assert.ok(distance(initial, { x: .5, y: 64, z: .5 }) < .4, 'requires fresh gather-01 fixture');
    phase = 'operator-stop';
    const walking = body.submit(plan(moving), body.snapshot().stopped); assert.equal(walking.accepted, true);
    record.operatorStopped = false;
    await until(() => !!record.actionController && distance(record.bot.entity.position, initial) > .2, 'native walking actually starts');
    assert.ok(distance(initial, await sample()) > .1, 'server confirms movement before stop');
    assert.ok(record.actionController, 'walking owner is still active when operator stop is issued');
    const oldVersion = body.snapshot().version;
    await world.stop(record); await stopped();
    assert.equal(record.operatorStopped, true); assert.equal(body.snapshot().stopped, true);
    assert.equal(body.submit(plan(moving, { expectedVersion: oldVersion, resume: true }), true).accepted, false);
    assert.equal(body.cancel(oldVersion).accepted, false); passed('operator stop drains and rejects old plan/cancel');

    phase = 'explicit-resume';
    const fresh = body.snapshot().version;
    assert.equal(body.submit(plan(moving, { expectedVersion: fresh })).accepted, false, 'stopped body requires explicit resume');
    const resumed = body.submit(plan(moving, { expectedVersion: fresh, resume: true }), true);
    assert.equal(resumed.accepted, true); record.operatorStopped = false;
    await until(() => !!body.snapshot().current && !!record.actionController, 'fresh resume starts a native owner');
    passed('explicit fresh-version resume');

    phase = 'renew-restart-replace';
    const current = body.snapshot().current!, version = body.snapshot().version;
    const renewed = body.submit(plan(moving, { ttlMs: 14000 }));
    assert.equal(renewed.accepted, true); assert.equal(renewed.unchanged, true);
    assert.equal(body.snapshot().version, version); assert.equal(body.snapshot().current?.id, current.id);
    passed('equivalent renewal keeps version and running skill');
    const restarted = body.submit(plan(moving, { restart: true })); assert.equal(restarted.accepted, true);
    assert.ok(restarted.version > version);
    await until(() => body.snapshot().current?.intentVersion === restarted.version && !!record.actionController, 'restart waits for previous owner to drain');
    const replacement = body.submit(plan([{ type: 'goto', x: -5.5, y: 64, z: 4.5 }]));
    assert.equal(replacement.accepted, true);
    await until(() => body.snapshot().current?.intentVersion === replacement.version && !!record.actionController, 'replacement starts under its own version');
    assert.equal(body.cancel(restarted.version).accepted, false, 'old cancel cannot interrupt replacement');
    await delay(150, undefined, { signal });
    assert.equal(maxOwners, 1); assert.deepEqual(violations, []);
    passed('restart and replacement never overlap native owners');
    assert.equal(body.cancel(body.snapshot().version).accepted, true); await stopped();

    phase = 'ttl-expiry';
    // A short walking lease expires before its five-second input command ends.
    const lease = body.submit(plan([{ type: 'move', controls: ['forward'], ms: 5000 }], { ttlMs: 1000 }));
    assert.equal(lease.accepted, true);
    await until(() => !!record.actionController, 'TTL skill starts');
    await until(() => body.snapshot().goalStatus === 'expired' && !body.snapshot().current, 'TTL cancels and drains actual skill', 3500);
    await stopped(); assert.ok(body.snapshot().version > lease.version, 'expiry invalidates old model observation');
    assert.equal(body.submit(plan(moving, { expectedVersion: lease.version })).accepted, false, 'late plan cannot restore expired authorization');
    passed('TTL expiry stops body and rejects the old version');
    assert.equal(maxOwners, 1); assert.deepEqual(violations, []);
  } catch (cause: any) { error = String(cause?.stack || cause); }
  finally {
    phase = 'cleanup'; await world.stop(record); await body.controller.whenIdle();
    world.executeOwned = execute; world.onEvent = priorEvent;
  }
  return { status: error ? 'failed' : 'passed', checks, maxNativeOwners: maxOwners, violations, error,
    scope: 'real-server-ownership-correctness-not-skill-score', events };
}

async function main() {
  if (!process.argv.includes('--run')) {
    console.log('Run only with an idle isolated arena: node adapters/minecraft/benchmark/ownership-probe.ts --run'); return;
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const config = await loadExamServer(root), actor = 'OwnershipProbe';
  const output = join(root, 'var/minecraft/skill-exam/ownership', new Date().toISOString().replace(/[:.]/gu, '-'));
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(new Error('Ownership probe deadline.')), 45000);
  process.once('SIGINT', () => controller.abort(new Error('Interrupted.')));
  const world = new MinecraftWorld({ host: '127.0.0.1', port: config.gamePort, version: config.version,
    logDirectory: join(output, 'candidate-events'), dualLoop: true });
  const record = world.add(actor, '独立控制权测试角色。');
  const referee = new VanillaExamAdapter(config);
  try {
    const deadline = Date.now() + 20000;
    while (!record.ready || !record.inventorySynced) {
      controller.signal.throwIfAborted(); if (record.error || Date.now() > deadline) throw new Error(record.error || 'Probe actor did not connect.');
      await delay(100, undefined, { signal: controller.signal });
    }
    // Privileged setup stays entirely in this trusted runner. It is never
    // passed into the tested World/Body, model prompt or skill executor.
    await referee.prepare(getExamTask('gather-01'), actor, controller.signal);
    await delay(350, undefined, { signal: controller.signal });
    const { events, ...result } = await runOwnershipProbe(world, record, () => referee.sample(controller.signal), controller.signal);
    await mkdir(output, { recursive: true });
    await writeFile(join(output, 'events.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n');
    await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ ...result, output }, null, 2)); process.exitCode = result.status === 'passed' ? 0 : 1;
  } finally {
    clearTimeout(timer); await world.stop(record); await record.body?.dispose();
    await referee.cleanup(); referee.close(); world.close();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

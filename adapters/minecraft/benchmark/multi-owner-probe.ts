/** Four real bodies, one isolated arena; no model calls or skill score.
 *   node adapters/minecraft/benchmark/multi-owner-probe.ts --run
 * Without --run this prints usage and does not read credentials or connect.
 * Requires the existing marked Java 1.21.4 exam server on 25575, capacity >=4,
 * and no online players. The trusted runner builds four flat, separate lanes.
 * Only this runner receives RCON; candidate World receives an ordinary login.
 * Existing players are never kicked/killed. A foreign join aborts the probe.
 * Stop/drain, stale reply, explicit resume and replacement target actor A;
 * server positions and unchanged leases prove B/C/D continue independently.
 * Native owner counts and observed control ticks are recorded per actor.
 * This does not test model latency, memory isolation or social cooperation.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { MinecraftWorld, type BotRecord } from '../src/world.ts';
import { loadExamServer } from './server.ts';
import { LocalRcon, parseSnbt } from './rcon.ts';

type Vec = { x: number; y: number; z: number };
type ActorEvidence = { name: string; sampledAt: number; position: Vec; health: number; onGround: boolean };
type ServerSample = { source: 'vanilla-rcon'; sampledAt: number; actors: Record<string, ActorEvidence> };
const LANE_Z = [-12.5, -4.5, 4.5, 12.5];
const START_X = -12.5, END_X = 12.5;
const distance = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export function parseOnlinePlayers(response: string) {
  const match = /^There are (\d+) of a max of (\d+) players online:\s*(.*)$/u.exec(response.trim());
  if (!match) throw new Error('Cannot establish isolated arena player list/capacity.');
  const names = match[3] ? match[3].split(/,\s*/u) : [];
  if (names.length !== Number(match[1]) || names.some(name => !/^[A-Za-z0-9_]{1,16}$/u.test(name)))
    throw new Error('Invalid server player list.');
  return { names, capacity: Number(match[2]) };
}

export function controlTickSummary(ticks: number[], from: number, to: number) {
  const values = ticks.filter(at => at >= from && at <= to).sort((a, b) => a - b);
  const gaps = values.slice(1).map((at, i) => at - values[i]).sort((a, b) => a - b);
  return { samples: values.length, windowMs: to - from,
    p95GapMs: gaps.length ? gaps[Math.ceil(gaps.length * .95) - 1] : null,
    maxGapMs: gaps.length ? gaps.at(-1)! : null,
    leadingGapMs: values.length ? values[0] - from : to - from,
    trailingGapMs: values.length ? to - values.at(-1)! : to - from };
}

/** World/records carry no privileged referee connection. sampleServer is
 * read-only evidence for assertions, never provided to a skill or controller. */
export async function runMultiOwnerProbe(world: MinecraftWorld, records: BotRecord[],
  sampleServer: () => Promise<ServerSample>, signal: AbortSignal) {
  assert.equal(records.length, 4); assert.equal(new Set(records.map(record => record.name)).size, 4);
  for (const record of records) assert.ok(record.body, 'all four actors require independent bodies');
  const events: any[] = [], checks: string[] = [], violations: string[] = [];
  const phases: { name: string; from: number; to?: number }[] = [];
  const owners = new Map(records.map(record => [record.name, new Set<number>()]));
  const maximum = new Map(records.map(record => [record.name, 0]));
  const ticks = new Map(records.map(record => [record.name, [] as number[]]));
  const originalExecute = world.executeOwned, priorEvent = world.onEvent, priorMetric = world.onControlMetric;
  let phase = 'settling', ownerSequence = 0, simultaneousOwners = 0;
  const push = (event: any) => events.push({ at: Date.now(), phase, ...event });
  const enter = (name: string) => {
    if (phases.length) phases.at(-1)!.to = Date.now();
    phase = name; phases.push({ name, from: Date.now() }); push({ type: 'phase' });
  };
  world.onEvent = (record, event) => { priorEvent?.(record, event); if (owners.has(record.name)) push({ type: 'world-event', actor: record.name, event }); };
  world.onControlMetric = (record, event) => {
    priorMetric?.(record, event);
    if (!owners.has(record.name)) return;
    if (event.type === 'control-tick') ticks.get(record.name)!.push(event.at);
    if (event.type === 'control-tick' || event.type === 'input') push({ type: 'control-metric', actor: record.name, metric: event });
  };
  world.executeOwned = async (name, action, ownerSignal) => {
    const active = owners.get(name);
    assert.ok(active, 'probe World must contain only its own four actors');
    const id = ++ownerSequence; active.add(id);
    maximum.set(name, Math.max(maximum.get(name)!, active.size));
    simultaneousOwners = Math.max(simultaneousOwners, [...owners.values()].filter(set => set.size > 0).length);
    if (active.size > 1) violations.push(`${name}: overlapping native owners ${[...active].join(',')}`);
    push({ type: 'native-start', actor: name, id, action });
    try { return await originalExecute.call(world, name, action, ownerSignal); }
    finally {
      if (name !== records[0].name && phase !== 'cleanup' && ownerSignal.aborted)
        violations.push(`${name}: peer native owner was cancelled during ${phase}`);
      push({ type: 'native-end', actor: name, id, aborted: ownerSignal.aborted }); active.delete(id);
    }
  };
  const until = async (test: () => boolean, message: string, timeoutMs = 6000) => {
    const deadline = Date.now() + timeoutMs;
    while (!test()) {
      signal.throwIfAborted();
      assert.ok(Date.now() < deadline, message);
      for (const record of records) assert.ok(record.ready && !record.error, record.error || `${record.name} disconnected`);
      await delay(25, undefined, { signal });
    }
  };
  const sample = async () => {
    signal.throwIfAborted(); const result = await sampleServer(); signal.throwIfAborted();
    for (const record of records) {
      const actor = result.actors[record.name]; assert.equal(actor?.name, record.name);
      assert.ok(actor.health > 0, `${record.name} must be alive`);
      assert.ok(Math.abs(actor.position.z - LANE_Z[records.indexOf(record)]) < 1.3 && Math.abs(actor.position.y - 64) < .2,
        `${record.name} remains on its own flat lane`);
    }
    push({ type: 'server-evidence', evidence: result }); return result;
  };
  const submit = (record: BotRecord, steps: any[], extra: any = {}, resume = false) => record.body!.submit({
    expectedVersion: record.body!.snapshot().version, label: 'four-body ownership probe', steps, reactions: [], ttlMs: 90000, ...extra }, resume);
  const goto = (i: number, x: number) => ({ type: 'goto', x, y: 64, z: LANE_Z[i] });
  const passed = (name: string) => { checks.push(name); push({ type: 'check-passed', name }); };
  const [actorA, ...peers] = records;
  const peerLeases = new Map<string, { version: number; intentId: string | undefined }>();
  const peerIntegrity = () => {
    for (const record of peers) {
      const state = record.body!.snapshot(), lease = peerLeases.get(record.name)!;
      assert.equal(state.stopped, false, `${record.name} was not stopped with A`);
      assert.equal(record.operatorStopped, false);
      assert.equal(state.version, lease.version, `${record.name} retains its original version`);
      assert.equal(state.intent?.id, lease.intentId, `${record.name} retains its original intent`);
    }
    assert.deepEqual(violations, []);
  };
  const peersMoved = (before: ServerSample, after: ServerSample, minimum = .2) => {
    peerIntegrity();
    for (const record of peers) assert.ok(distance(before.actors[record.name].position, after.actors[record.name].position) > minimum,
      `${record.name} continues moving on server while A changes control`);
  };
  let error: string | undefined;
  try {
    enter('four-moving');
    await until(() => records.every(record => record.ready && record.inventorySynced && record.bot.entity.onGround), 'all actors settle');
    const initial = await sample();
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      assert.ok(distance(initial.actors[record.name].position, { x: START_X, y: 64, z: LANE_Z[i] }) < .35, 'trusted lane start position');
      assert.ok(!record.body!.snapshot().intent && !record.body!.snapshot().current && !record.task, 'probe begins idle');
      const steps = Array.from({ length: i === 0 ? 1 : 12 }, (_, step) => goto(i, step % 2 ? START_X : END_X));
      const accepted = submit(record, steps, {}, record.body!.snapshot().stopped);
      assert.equal(accepted.accepted, true); record.operatorStopped = false;
      if (i) peerLeases.set(record.name, { version: accepted.version, intentId: accepted.intentId });
    }
    await until(() => records.every(record => owners.get(record.name)!.size === 1 && distance(record.bot.entity.position, initial.actors[record.name].position) > .3), 'four native owners move concurrently');
    await delay(350, undefined, { signal });
    const moving = await sample();
    for (const record of records) assert.ok(distance(initial.actors[record.name].position, moving.actors[record.name].position) > .3, `${record.name} server confirms movement`);
    assert.equal(simultaneousOwners, 4); passed('four concurrent native owners and four actual server movements');

    enter('stop-a');
    const oldVersion = actorA.body!.snapshot().version, beforeStop = await sample();
    assert.equal(owners.get(actorA.name)!.size, 1, 'A is actively walking when stopped');
    await world.stop(actorA); await actorA.body!.controller.whenIdle();
    await until(() => !actorA.actionController && !actorA.body!.snapshot().current && !owners.get(actorA.name)!.size, 'A native owner drains');
    for (const key of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) assert.equal(actorA.bot.getControlState(key), false, `${key} released on A`);
    assert.equal(actorA.body!.snapshot().stopped, true); assert.equal(actorA.operatorStopped, true);
    await delay(450, undefined, { signal });
    const settled = await sample(); await delay(450, undefined, { signal }); const stopped = await sample();
    assert.ok(distance(settled.actors[actorA.name].position, stopped.actors[actorA.name].position) < .08, 'server confirms A stationary after drain');
    peersMoved(beforeStop, stopped); passed('operator stop drains A while B/C/D continue their original plans');

    enter('stale-a');
    const beforeStale = await sample();
    assert.equal(submit(actorA, [goto(0, END_X)], { expectedVersion: oldVersion, resume: true }, true).accepted, false, 'pre-stop late reply cannot resume A');
    assert.equal(actorA.body!.cancel(oldVersion).accepted, false, 'old cancellation rejected');
    assert.equal(submit(actorA, [goto(0, END_X)]).accepted, false, 'fresh version alone cannot implicitly resume');
    await delay(400, undefined, { signal }); const afterStale = await sample();
    assert.ok(distance(stopped.actors[actorA.name].position, afterStale.actors[actorA.name].position) < .08);
    peersMoved(beforeStale, afterStale); passed('late A plan/cancel rejected without stopping peers');

    enter('resume-a');
    const beforeResume = await sample(), resumed = submit(actorA, [goto(0, END_X)], { resume: true }, true);
    assert.equal(resumed.accepted, true); actorA.operatorStopped = false;
    await until(() => actorA.body!.snapshot().current?.intentVersion === resumed.version && owners.get(actorA.name)!.size === 1, 'fresh explicit resume owns A');
    await delay(450, undefined, { signal }); const afterResume = await sample();
    assert.ok(afterResume.actors[actorA.name].position.x - beforeResume.actors[actorA.name].position.x > .2, 'server confirms A resumes towards target');
    peersMoved(beforeResume, afterResume); passed('explicit fresh-version A resume preserves peer movement');

    enter('replace-a');
    const beforeReplace = await sample(), replacement = submit(actorA, [goto(0, START_X)]);
    assert.equal(replacement.accepted, true);
    assert.equal(actorA.body!.cancel(resumed.version).accepted, false, 'prior A owner cannot cancel replacement');
    await until(() => actorA.body!.snapshot().current?.intentVersion === replacement.version && owners.get(actorA.name)!.size === 1, 'replacement waits for A old owner to drain');
    await delay(600, undefined, { signal }); const afterReplace = await sample();
    assert.ok(beforeReplace.actors[actorA.name].position.x - afterReplace.actors[actorA.name].position.x > .2, 'server confirms replacement reverses A');
    peersMoved(beforeReplace, afterReplace);
    for (const record of records) assert.equal(maximum.get(record.name), 1, `${record.name} native execution never overlaps`);
    passed('A replacement drains old owner; all four retain max native owners = 1');
  } catch (cause: any) { error = String(cause?.stack || cause); }
  finally {
    enter('cleanup');
    await Promise.allSettled(records.map(async record => { await world.stop(record); await record.body!.controller.whenIdle(); }));
    phases.at(-1)!.to = Date.now();
    world.executeOwned = originalExecute; world.onEvent = priorEvent; world.onControlMetric = priorMetric;
  }
  const perActor = Object.fromEntries(records.map(record => [record.name, {
    maxNativeOwners: maximum.get(record.name), controllerMetrics: record.body!.snapshot().metrics,
    tickGapsByPhase: Object.fromEntries(phases.filter(window => window.name !== 'cleanup').map(window =>
      [window.name, controlTickSummary(ticks.get(record.name)!, window.from, window.to!)])),
  }]));
  return { status: error ? 'failed' : 'passed', checks, error, violations, simultaneousNativeActors: simultaneousOwners,
    perActor, scope: 'real-server-four-body-ownership-isolation-not-skill-score', modelsCalled: 0,
    limitations: ['No model-latency or private-memory isolation claim.', 'Control telemetry reports active readState checks; intentional A stop/drain gaps are not scheduler stalls.', 'RCON actor samples are sequential, not an atomic four-player snapshot.'], events };
}

async function main() {
  if (!process.argv.includes('--run')) {
    console.log('Idle isolated exam only: node adapters/minecraft/benchmark/multi-owner-probe.ts --run\nRequires 25575, matching exam marker, capacity >=4 and no online players.'); return;
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), config = await loadExamServer(root);
  assert.equal(config.gamePort, 25575); assert.equal(config.rconPort, 25585); assert.equal(config.version, '1.21.4');
  assert.equal(resolve(config.directory), resolve(root, 'var/minecraft/skill-exam/server'));
  const suffix = randomBytes(3).toString('hex'), names = ['A', 'B', 'C', 'D'].map(letter => `MOwner${letter}_${suffix}`);
  const output = join(root, 'var/minecraft/skill-exam/multi-ownership', new Date().toISOString().replace(/[:.]/gu, '-'));
  const controller = new AbortController(), signal = controller.signal, rcon = new LocalRcon();
  const records: BotRecord[] = []; let world: MinecraftWorld | undefined, monitor: ReturnType<typeof setInterval> | undefined, checking = false;
  const timer = setTimeout(() => controller.abort(new Error('Four-body probe deadline.')), 60000);
  const interrupted = () => controller.abort(new Error('Interrupted.')); process.once('SIGINT', interrupted);
  const allowed = new Set<string>();
  const checkPlayers = async (requireAll = false) => {
    signal.throwIfAborted(); const online = parseOnlinePlayers(await rcon.command('list')); signal.throwIfAborted();
    assert.ok(online.capacity >= 4, 'Exam server needs capacity >=4; change only its max-players and restart it while idle.');
    assert.ok(online.names.every(name => allowed.has(name)), 'Arena occupied by another player; abort without kicking or killing anyone.');
    if (requireAll) assert.deepEqual([...online.names].sort(), [...names].sort(), 'all four own actors remain online');
    return online;
  };
  const command = async (text: string) => {
    await checkPlayers(); signal.throwIfAborted(); const response = await rcon.command(text); signal.throwIfAborted();
    assert.ok(!/Unknown or incomplete command|Incorrect argument|Expected |Invalid |No player was found|No entity was found|Could not |Unable to |Cannot /u.test(response), `Fixture command failed (${text.split(' ')[0]}): ${response.slice(0, 200)}`);
    return response;
  };
  const sampleServer = async (): Promise<ServerSample> => {
    await checkPlayers(true); const actors: Record<string, ActorEvidence> = {};
    for (const name of names) {
      const response = await rcon.command(`data get entity ${name}`), offset = response.indexOf('{');
      signal.throwIfAborted(); assert.ok(offset >= 0, 'Server entity NBT required'); const nbt = parseSnbt(response.slice(offset));
      assert.ok(Array.isArray(nbt.Pos) && nbt.Pos.length === 3 && nbt.Pos.every(Number.isFinite)); assert.ok(Number.isFinite(nbt.Health));
      actors[name] = { name, sampledAt: Date.now(), position: { x: nbt.Pos[0], y: nbt.Pos[1], z: nbt.Pos[2] },
        health: nbt.Health, onGround: nbt.OnGround === 1 || nbt.OnGround === true };
    }
    return { source: 'vanilla-rcon', sampledAt: Date.now(), actors };
  };
  try {
    await rcon.connect(config.rconPort, config.rconPassword); await checkPlayers();
    monitor = setInterval(() => {
      if (checking || signal.aborted) return; checking = true;
      void checkPlayers().catch(error => controller.abort(error)).finally(() => { checking = false; });
    }, 300);
    // Fixture privilege ends before any tested plan starts. No kill/kick/op,
    // no candidate teleport, and no change to production or persisted files.
    for (const text of ['tick unfreeze', 'tick rate 20', 'difficulty peaceful', 'gamerule doMobSpawning false',
      'gamerule doDaylightCycle false', 'gamerule doWeatherCycle false', 'time set day', 'weather clear',
      'fill -16 64 -16 16 71 16 minecraft:air', 'fill -16 63 -16 16 63 16 minecraft:bedrock']) await command(text);
    for (const z of LANE_Z) for (const wallZ of [Math.floor(z) - 2, Math.floor(z) + 2])
      await command(`fill -16 64 ${wallZ} 16 65 ${wallZ} minecraft:bedrock`);
    world = new MinecraftWorld({ host: '127.0.0.1', port: config.gamePort, version: config.version,
      logDirectory: join(output, 'candidate-events'), dualLoop: true });
    for (let i = 0; i < names.length; i++) {
      await checkPlayers(); allowed.add(names[i]); const record = world.add(names[i], '独立身体控制隔离测试角色。'); records.push(record);
      const deadline = Date.now() + 12000;
      while (!record.ready || !record.inventorySynced) {
        signal.throwIfAborted(); assert.ok(!record.error && Date.now() < deadline, record.error || 'Own probe actor did not join.');
        await delay(50, undefined, { signal });
      }
      for (const text of [`gamemode creative ${record.name}`, `clear ${record.name}`, `effect clear ${record.name}`,
        `tp ${record.name} ${START_X} 64 ${LANE_Z[i]} -90 0`, `gamemode survival ${record.name}`,
        `effect give ${record.name} minecraft:instant_health 1 10 true`, `effect give ${record.name} minecraft:saturation 1 10 true`]) await command(text);
    }
    await delay(300, undefined, { signal });
    for (const name of names) await command(`effect clear ${name}`);
    await checkPlayers(true);
    const { events, ...result } = await runMultiOwnerProbe(world, records, sampleServer, signal);
    await mkdir(output, { recursive: true });
    await writeFile(join(output, 'events.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n');
    await writeFile(join(output, 'result.json'), JSON.stringify({ ...result, actors: names, gamePort: config.gamePort }, null, 2) + '\n');
    console.log(JSON.stringify({ ...result, actors: names, output }, null, 2)); process.exitCode = result.status === 'passed' ? 0 : 1;
  } finally {
    clearTimeout(timer); if (monitor) clearInterval(monitor); process.removeListener('SIGINT', interrupted);
    await Promise.allSettled(records.map(async record => { await world?.stop(record); await record.body?.dispose(); }));
    world?.close(); rcon.close();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

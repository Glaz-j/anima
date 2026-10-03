import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { getExamTask, STAGE_ONE_TASKS } from '../adapters/minecraft/benchmark/tasks.ts';
import { SkillExamReferee } from '../adapters/minecraft/benchmark/referee.ts';
import { measureExam } from '../adapters/minecraft/benchmark/metrics.ts';
import { LocalRcon, parseSnbt } from '../adapters/minecraft/benchmark/rcon.ts';
import { runSkillExam, safeCandidateMetadata, summarizeExams, UnsupportedExam } from '../adapters/minecraft/benchmark/runner.ts';
import { loadExamServer, prepareExamServer } from '../adapters/minecraft/benchmark/server.ts';
import { VanillaExamAdapter } from '../adapters/minecraft/benchmark/adapter.ts';
import type { ExamAdapter, ExamEvent, ExamResult, ExamTask, ServerEvidence } from '../adapters/minecraft/benchmark/types.ts';

function evidence(task = getExamTask('gather-01')): ServerEvidence {
  return { source: 'fixture', sequence: 1, sampledAt: Date.now(), serverTick: 100,
    actor: { name: 'ExamBot', position: { ...task.spawn }, health: 20, food: task.initialFood ? 8 : 20, air: 300, onGround: true,
      inventory: Object.fromEntries(task.inventory.map(item => [item.item, item.count])) },
    statistics: { deaths: 0, damage: 0, jump: 0, placed_cobblestone: 0, killed_zombie: 0, killed_skeleton: 0, crafted_pickaxe: 0, mined_oak: 0, ate_beef: 0 },
    enemies: task.enemies.map(enemy => ({ ...enemy, alive: true, health: 20 })),
  };
}
function advance(previous: ServerEvidence, elapsed = 300): ServerEvidence {
  return { ...structuredClone(previous), sequence: previous.sequence + 1, sampledAt: previous.sampledAt + elapsed, serverTick: previous.serverTick + Math.round(elapsed / 50) };
}
function setupNbt(task: ExamTask, overrides: Record<string, unknown> = {}) {
  return `ExamBot has the following entity data: ${JSON.stringify({ Health: 20, foodLevel: 20, foodSaturationLevel: 20,
    playerGameType: 0, abilities: { invulnerable: 0, flying: 0, mayfly: 0 }, active_effects: [],
    HurtTime: 0, DeathTime: 0, FallDistance: 0, Fire: -20, Air: 300, OnGround: 1,
    Pos: [task.spawn.x, task.spawn.y, task.spawn.z], Motion: [0, 0, 0], Inventory: [], ...overrides })}`;
}

test('stage one covers all requested skills in independent versioned cases', () => {
  assert.equal(STAGE_ONE_TASKS.length, 10); assert.equal(new Set(STAGE_ONE_TASKS.map(task => task.id)).size, 10);
  for (const task of STAGE_ONE_TASKS) { assert.equal(task.stage, 1); assert.ok(task.required.includes('server-statistics')); assert.ok(task.timeoutMs > 0); }
  const copy = getExamTask('gather-01'); copy.inventory[0].count = 99; assert.equal(getExamTask('gather-01').inventory[0].count, 1);
});
test('parkour courses have tall side walls so walking around a gap cannot substitute for the task', () => {
  for (const id of ['parkour-empty-01', 'parkour-items-01']) {
    const task = getExamTask(id);
    for (const z of [-2, 2]) assert.ok(task.terrain.some(fill => fill.block === 'bedrock' && fill.from.z === z && fill.to.z === z && fill.from.x <= -1 && fill.to.x >= 11 && fill.to.y >= 68));
  }
});
test('entity disappearance is never sufficient proof of actor victory', () => {
  const task = getExamTask('combat-multiple-01'), initial = evidence(task), referee = new SkillExamReferee(task, initial);
  let next = advance(initial); next.enemies.forEach(enemy => { enemy.alive = false; });
  assert.equal(referee.update(next).status, 'running');
  next = advance(next); next.statistics.killed_zombie = 1;
  assert.equal(referee.update(next).status, 'running');
  next = advance(next); next.statistics.killed_zombie = 2;
  assert.equal(referee.update(next).status, 'passed');
});
test('combat cannot begin without proof that all designated enemies existed alive', () => {
  const task = getExamTask('combat-single-01'), initial = evidence(task); initial.enemies = [];
  assert.throws(() => new SkillExamReferee(task, initial), /not observed alive/u);
});
test('combat preparation captures full-health evidence before activating any opponent', async () => {
  const task = getExamTask('combat-multiple-01'), initial = evidence(task), calls: string[] = [];
  const adapter = new VanillaExamAdapter({ kind: 'anima-skill-exam', gamePort: 25575, rconPort: 25585 } as any);
  (adapter as any).connected = true;
  (adapter as any).rcon = { command: async (command: string) => {
    calls.push(command);
    return command === 'list' ? 'There are 1 of a max of 2 players online: ExamBot'
      : command === 'data get entity ExamBot' ? setupNbt(task) : 'ok';
  } };
  adapter.sample = async () => {
    calls.push('INITIAL_SNAPSHOT');
    assert.equal(calls.filter(command => command.startsWith('summon') && command.includes('NoAI:1b')).length, 2);
    assert.equal(calls.some(command => command.includes('NoAI:0b')), false);
    return initial;
  };
  const snapshot = await adapter.prepare(task, 'ExamBot', new AbortController().signal);
  const baselineAt = calls.indexOf('INITIAL_SNAPSHOT');
  assert.equal(calls.filter((command, i) => i > baselineAt && command.includes('NoAI:0b')).length, 2);
  assert.equal(snapshot.sampledAt, initial.sampledAt); assert.ok(snapshot.opponentsActivatedAt! >= snapshot.sampledAt);
  const injured = evidence(task); injured.actor.health = 13;
  assert.throws(() => new SkillExamReferee(task, injured), /full health/u);
});
test('hunger setup polls through remaining saturation and clears the effect only after food really falls', async () => {
  const task = getExamTask('eat-resume-01'), initial = evidence(task), calls: string[] = [], foodReadings = [20, 20, 11];
  let hungry = false, food = 20, lastHungerReading = -1;
  initial.actor.food = 11;
  const adapter = new VanillaExamAdapter({ kind: 'anima-skill-exam', gamePort: 25575, rconPort: 25585 } as any);
  (adapter as any).connected = true;
  (adapter as any).rcon = { command: async (command: string) => {
    calls.push(command);
    if (command === 'list') return 'There are 1 of a max of 2 players online: ExamBot';
    if (command.includes('effect give ExamBot minecraft:hunger')) hungry = true;
    if (command === 'effect clear ExamBot minecraft:hunger') hungry = false;
    if (command === 'data get entity ExamBot') {
      if (hungry) { food = foodReadings.shift()!; lastHungerReading = calls.length - 1; }
      return setupNbt(task, { foodLevel: food });
    }
    return 'ok';
  } };
  adapter.sample = async () => initial;
  const snapshot = await adapter.prepare(task, 'ExamBot', new AbortController().signal);
  assert.equal(snapshot.actor.food, 11); assert.equal(foodReadings.length, 0);
  assert.ok(calls.filter(command => command === 'data get entity ExamBot').length > 3, 'Hunger is rechecked during the unbuffed stable interval.');
  assert.ok(calls.indexOf('effect clear ExamBot minecraft:hunger') > lastHungerReading);
  assert.equal(calls.some(command => command.includes('data merge entity ExamBot')), false);
});

test('pre-score late fall injury is repaired with a bounded retry and full evidence is checked again before activating enemies', async t => {
  const task = getExamTask('combat-single-01'), calls: string[] = [];
  let now = 10000, repairs = 0, cleared = false, samples = 0, stableReads = 0;
  t.mock.method(Date, 'now', () => now);
  const adapter = new VanillaExamAdapter({ kind: 'anima-skill-exam', gamePort: 25575, rconPort: 25585 } as any);
  (adapter as any).connected = true;
  (adapter as any).rcon = { command: async (command: string) => {
    calls.push(command);
    if (command === 'list') return 'There are 1 of a max of 2 players online: ExamBot';
    if (command.includes('effect give ExamBot minecraft:instant_health')) { repairs++; cleared = false; stableReads = 0; }
    if (command === 'effect clear ExamBot' && repairs) cleared = true;
    if (command === 'data get entity ExamBot') {
      now += 250;
      if (cleared) stableReads++;
      // First: a late fall packet after effects were removed. Second: another
      // packet while collecting the full scoreboard/entity snapshot.
      const lateInjury = cleared && ((repairs === 1 && stableReads >= 2) || (repairs === 2 && samples === 1));
      return setupNbt(task, { Health: lateInjury ? 15 : 20, HurtTime: lateInjury ? 8 : 0 });
    }
    return 'ok';
  } };
  adapter.sample = async () => { samples++; calls.push('FULL_SNAPSHOT'); return evidence(task); };
  const initial = await adapter.prepare(task, 'ExamBot', new AbortController().signal);
  assert.equal(repairs, 3); assert.equal(samples, 2); assert.equal(initial.actor.health, 20);
  assert.ok(calls.findIndex(command => command.includes('NoAI:0b')) > calls.lastIndexOf('FULL_SNAPSHOT'));
  assert.equal(calls.some(command => command.includes('data merge entity ExamBot')), false);
  // Returning the baseline closes the recovery phase. Later evidence is not
  // treated as another opportunity to restore the player's health.
  const before = calls.length;
  adapter.sample = async () => { const injured = evidence(task); injured.actor.health = 15; return injured; };
  assert.equal((await adapter.sample(new AbortController().signal)).actor.health, 15);
  assert.equal(calls.length, before);
});

test('residual effects cannot pass initialization even at full health, and recovery attempts are finite', async t => {
  const task = getExamTask('combat-single-01'); let now = 10000, repairs = 0, samples = 0;
  const commands: string[] = []; t.mock.method(Date, 'now', () => now);
  const adapter = new VanillaExamAdapter({ kind: 'anima-skill-exam', gamePort: 25575, rconPort: 25585 } as any);
  (adapter as any).connected = true;
  (adapter as any).rcon = { command: async (command: string) => {
    commands.push(command);
    if (command === 'list') return 'There are 1 of a max of 2 players online: ExamBot';
    if (command.includes('effect give ExamBot minecraft:instant_health')) repairs++;
    if (command === 'data get entity ExamBot') { now += 1000; return setupNbt(task, { active_effects: [{ id: 'minecraft:resistance', amplifier: 4, duration: 999 }] }); }
    return 'ok';
  } };
  adapter.sample = async () => { samples++; return evidence(task); };
  await assert.rejects(adapter.prepare(task, 'ExamBot', new AbortController().signal), /did not stabilize.*status effects remain/u);
  assert.equal(repairs, 3); assert.equal(samples, 0); assert.equal(commands.some(command => command.includes('NoAI:0b')), false);
  assert.equal(commands.at(-1), 'effect clear ExamBot');
});

test('underwater setup permits grounded-false fluid motion and retains the actual underwater spawn', async t => {
  const task = getExamTask('water-rescue-01'); let now = 10000;
  const commands: string[] = []; t.mock.method(Date, 'now', () => now);
  const adapter = new VanillaExamAdapter({ kind: 'anima-skill-exam', gamePort: 25575, rconPort: 25585 } as any);
  (adapter as any).connected = true;
  (adapter as any).rcon = { command: async (command: string) => {
    commands.push(command);
    if (command === 'list') return 'There are 1 of a max of 2 players online: ExamBot';
    if (command === 'data get entity ExamBot') { now += 250; return setupNbt(task, { OnGround: 0, Motion: [0, -.04, 0], Pos: [.5, 61.12, .5], Air: 260 }); }
    return 'ok';
  } };
  adapter.sample = async () => { const initial = evidence(task); initial.actor.position.y = 61.12; initial.actor.onGround = false; initial.actor.air = 260; return initial; };
  const initial = await adapter.prepare(task, 'ExamBot', new AbortController().signal);
  assert.equal(initial.actor.position.y, 61.12); assert.equal(initial.actor.onGround, false); assert.equal(initial.actor.health, 20);
  assert.ok(commands.includes('tp ExamBot 0.5 61 0.5 -90 0')); assert.equal(commands.some(command => command.includes('water_breathing')), false);
});
test('crafting requires actual server craft statistic and actual new inventory', () => {
  const task = getExamTask('craft-01'), initial = evidence(task), referee = new SkillExamReferee(task, initial);
  let next = advance(initial); next.actor.inventory.wooden_pickaxe = 1;
  assert.equal(referee.update(next).status, 'running');
  next = advance(next); next.actor.inventory.wooden_pickaxe = 0; next.statistics.crafted_pickaxe = 1;
  assert.equal(referee.update(next).status, 'running');
  next = advance(next); next.actor.inventory.wooden_pickaxe = 1;
  assert.equal(referee.update(next).status, 'passed');
});
test('gathering cannot pass on broken blocks whose drops have not been picked up', () => {
  const task = getExamTask('gather-01'), initial = evidence(task), referee = new SkillExamReferee(task, initial);
  let next = advance(initial); next.statistics.mined_oak = 6;
  assert.equal(referee.update(next).status, 'running');
  next = advance(next); next.actor.inventory.oak_log = 6;
  assert.equal(referee.update(next).status, 'passed');
});
test('parkour checkpoints are ordered and require stable grounded arrivals', () => {
  const task = getExamTask('parkour-empty-01'), initial = evidence(task), referee = new SkillExamReferee(task, initial);
  let next = advance(initial); next.actor.position = task.checkpoints[1].center; next.statistics.jump = 2;
  assert.equal(referee.update(next).status, 'running'); assert.equal(referee.checkpointsReached, 0);
  next = advance(next); next.actor.position = task.checkpoints[0].center; next.actor.onGround = false;
  referee.update(next); next = advance(next); next.actor.onGround = true; referee.update(next);
  next = advance(next); referee.update(next); assert.equal(referee.checkpointsReached, 1);
  next = advance(next); next.actor.position = task.checkpoints[1].center; referee.update(next);
  next = advance(next); assert.equal(referee.update(next).status, 'passed');
});
test('item parkour requires actual placements and enforces the finite material budget', () => {
  const task = getExamTask('parkour-items-01'), initial = evidence(task), referee = new SkillExamReferee(task, initial);
  let next = advance(initial);
  for (const checkpoint of task.checkpoints) { next.actor.position = checkpoint.center; referee.update(next); next = advance(next); referee.update(next); next = advance(next); }
  assert.equal(referee.update(next).status, 'running');
  next = advance(next); next.statistics.placed_cobblestone = 9;
  assert.equal(referee.update(next).status, 'failed');
});
test('water rescue requires standing on the shore, not just holding jump', () => {
  const task = getExamTask('water-rescue-01'), initial = evidence(task), referee = new SkillExamReferee(task, initial);
  let next = advance(initial); next.actor.position = { x: 0.5, y: 63.5, z: 0.5 }; next.actor.onGround = false;
  assert.equal(referee.update(next).status, 'running');
  next = advance(next); next.actor.position = task.checkpoints[0].center; next.actor.onGround = true; referee.update(next);
  next = advance(next); assert.equal(referee.update(next).status, 'passed');
});
test('eat-resume checks consumption, food recovery, then additional task progress', () => {
  const task = getExamTask('eat-resume-01'), initial = evidence(task), referee = new SkillExamReferee(task, initial);
  let next = advance(initial); next.actor.inventory.oak_log = 1; next.statistics.mined_oak = 1; referee.update(next);
  next = advance(next); next.statistics.ate_beef = 1; next.actor.food = 16; next.actor.inventory.cooked_beef = 2;
  assert.equal(referee.update(next).status, 'running');
  next = advance(next); next.actor.inventory.oak_log = 2; next.statistics.mined_oak = 2;
  assert.equal(referee.update(next).status, 'passed');
  const invalid = evidence(task); invalid.actor.food = 20;
  assert.throws(() => new SkillExamReferee(task, invalid), /Hunger precondition/u);
});
test('interrupt-resume must observe the injected threat and progress again after resolving it', () => {
  const task = getExamTask('interrupt-resume-01'), initial = evidence(task), referee = new SkillExamReferee(task, initial);
  let next = advance(initial); next.actor.inventory.oak_log = 1; next.statistics.mined_oak = 1; referee.update(next);
  assert.equal(referee.perturbationReady(), true); referee.injected(next.sampledAt);
  next = advance(next); next.enemies.push({ tag: task.perturbation!.enemy.tag, type: 'zombie', alive: true, health: 20 }); referee.update(next);
  next = advance(next); next.enemies[0].alive = false; next.statistics.killed_zombie = 1;
  assert.equal(referee.update(next).status, 'running');
  next = advance(next); next.actor.inventory.oak_log = 8; next.statistics.mined_oak = 8;
  assert.equal(referee.update(next).status, 'passed');
});
test('death overrides other success evidence and stale/unknown server truth is rejected', () => {
  const task = getExamTask('gather-01'), initial = evidence(task), referee = new SkillExamReferee(task, initial);
  assert.throws(() => referee.update(initial), /Stale/u);
  const invalid = advance(initial); delete invalid.statistics.damage;
  assert.throws(() => referee.update(invalid), /Missing server statistic/u);
  const next = advance(initial); next.actor.inventory.oak_log = 6; next.statistics.mined_oak = 6; next.statistics.deaths = 1;
  assert.equal(referee.update(next).status, 'failed');
});
test('APM counts changed inputs and discrete actions, not repeated writes or tick evaluations', () => {
  const initial = evidence(), final = advance(initial, 1000), at = initial.sampledAt;
  const events: ExamEvent[] = [
    ...Array.from({ length: 20 }, (_, i): ExamEvent => ({ type: 'input', at: at + i * 50, channel: 'forward', value: true })),
    ...Array.from({ length: 20 }, (_, i): ExamEvent => ({ type: 'control-tick', at: at + i * 50 })),
    { type: 'input', at: at + 400, channel: 'attack', discrete: true }, { type: 'input', at: at + 800, channel: 'attack', discrete: true },
    { type: 'hazard-observed', at: at + 100, hazardId: 'enemy' }, { type: 'reaction', at: at + 250, hazardId: 'enemy' },
    { type: 'model-start', at: at + 100 }, { type: 'model-end', at: at + 900 },
  ];
  const metrics = measureExam(events, initial, final);
  assert.equal(metrics.rawInputCalls, 22); assert.equal(metrics.effectiveInputs, 3); assert.equal(metrics.effectiveApm, 180);
  assert.equal(metrics.controlGapP95Ms, 50); assert.equal(metrics.reactionP95Ms, 150); assert.equal(metrics.modelWaitMs, 800); assert.equal(metrics.realtimeRatio, 1);
});
test('SNBT parser accepts real vanilla nested and typed values, fails closed on truncation', () => {
  const data = parseSnbt('{Health:20.0f,Pos:[0.5d,64.0d,-1.5d],Air:300s,OnGround:1b,UUID:[I;1,-2,3,4],Inventory:[{id:"minecraft:oak_log",count:6,Slot:0b}],Name:"a\\\"b"}');
  assert.equal(data.Health, 20); assert.equal(data.Inventory[0].count, 6); assert.deepEqual(data.Pos, [0.5, 64, -1.5]); assert.equal(data.Name, 'a"b');
  assert.throws(() => parseSnbt('{Health:20.0f,Inventory:['));
});

test('fixture runs remain excluded from real results and executor gets no private task/answer', async () => {
  const task = getExamTask('gather-01'); let state = evidence(task), stopped = false, cleaned = false;
  const adapter: ExamAdapter = { mode: 'fixture', capabilities: new Set(task.required),
    prepare: async () => state,
    sample: async () => { state = advance(state, 1); state.actor.inventory.oak_log = 6; state.statistics.mined_oak = 6; return state; },
    cleanup: async () => { cleaned = true; },
  };
  const result = await runSkillExam({ taskId: task.id, actor: 'ExamBot', adapter, executor: { start: async context => {
    assert.equal('task' in context, false); assert.equal('perturbation' in context, false); assert.equal(context.instruction, task.instruction);
    return { stop: async () => { stopped = true; } };
  } } });
  assert.equal(result.status, 'passed'); assert.equal(result.realScore, false); assert.equal(stopped, true); assert.equal(cleaned, true);
  const summary = summarizeExams([result, result]); assert.equal(summary.validTrials, 0); assert.equal(summary.excluded.fixture, 1); assert.equal(summary.phaseTwoEligible, false);
});
test('unsupported capabilities never become failures or real passes', async () => {
  let prepared = false;
  const adapter: ExamAdapter = { mode: 'real-server', capabilities: new Set(), prepare: async () => { prepared = true; return evidence(); }, sample: async () => evidence(), cleanup: async () => {} };
  const result = await runSkillExam({ taskId: 'gather-01', actor: 'ExamBot', adapter, executor: { start: async () => { throw new Error('Must not run'); } } });
  assert.equal(prepared, false); assert.equal(result.status, 'unsupported'); assert.equal(result.realScore, false);
});
test('executor unsupported reports and failed stop acknowledgements are preserved', async () => {
  const task = getExamTask('gather-01'), state = evidence(task);
  const adapter: ExamAdapter = { mode: 'fixture', capabilities: new Set(task.required), prepare: async () => state, sample: async () => { const next = advance(state); next.statistics.mined_oak = 6; next.actor.inventory.oak_log = 6; return next; }, cleanup: async () => {} };
  const unsupported = await runSkillExam({ taskId: task.id, actor: 'ExamBot', adapter, executor: { start: async () => { throw new UnsupportedExam('Skill is not implemented.'); } } });
  assert.equal(unsupported.status, 'unsupported');
  const broken = await runSkillExam({ taskId: task.id, actor: 'ExamBot', adapter, executor: { start: async () => ({ stop: async () => { throw new Error('Still owns controls'); } }) } });
  assert.equal(broken.status, 'infra-error'); assert.match(broken.reason, /failed to stop/u);
});
test('cleanup errors append to the original failure instead of hiding the root cause', async () => {
  const task = getExamTask('gather-01');
  const adapter: ExamAdapter = { mode: 'fixture', capabilities: new Set(task.required), prepare: async () => { throw new Error('Original setup failure'); }, sample: async () => evidence(), cleanup: async () => { throw new Error('Already disconnected'); } };
  const result = await runSkillExam({ taskId: task.id, actor: 'ExamBot', adapter, executor: { start: async () => { throw new Error('Must not start'); } } });
  assert.equal(result.status, 'infra-error'); assert.match(result.reason, /Original setup failure; Arena cleanup failed: Already disconnected/u);
});
test('confirmed provider failure aborts promptly and remains infrastructure error rather than an ability score', async () => {
  const task = getExamTask('craft-01'), state = evidence(task); state.source = 'vanilla-rcon'; let stopped = false;
  const adapter: ExamAdapter = { mode: 'real-server', capabilities: new Set(task.required), prepare: async () => state, sample: async () => { throw new Error('No polling after provider failure'); }, cleanup: async () => {} };
  const result = await runSkillExam({ taskId: task.id, actor: 'ExamBot', adapter, architecture: 'parallel', mode: 'agent', executor: { start: async context => {
    assert.equal(context.architecture, 'parallel'); context.fail('Provider unavailable; token=fixture-secret');
    return { stop: async () => { stopped = true; } };
  } } });
  assert.equal(result.status, 'infra-error'); assert.equal(result.realScore, false); assert.equal(result.architecture, 'parallel');
  assert.match(result.reason, /Provider unavailable/u); assert.doesNotMatch(result.reason, /fixture-secret/u); assert.equal(stopped, true);
});
test('candidate attribution allowlists model identity and never serializes arbitrary provider config', () => {
  const metadata = safeCandidateMetadata({ model: { id: 'test-model', provider: 'test-provider', apiKey: 'secret' }, controller: 'body-v2', password: 'secret' } as any);
  assert.deepEqual(metadata, { model: { id: 'test-model', provider: 'test-provider' }, controller: 'body-v2' });
});
test('phase gate does not combine skill/agent, architectures, models, source versions or old task revisions', () => {
  const source = { gitHead: 'fixture-head', dirty: true, workingTreeId: 'fixture-tree', capturedAt: 'fixture-time' };
  const metrics = { ...measureExam([], evidence(), advance(evidence())), uninstrumented: false };
  function rows(mode: 'skill' | 'agent', architecture: 'serial' | 'parallel' | 'dual', count = 5): ExamResult[] {
    return STAGE_ONE_TASKS.flatMap(task => Array.from({ length: count }, (_, i) => ({
      schemaVersion: 2, runId: `${mode}-${architecture}-${task.id}-${i}`, taskId: task.id, taskRevision: task.revision,
      stage: 1, actor: 'Fixture', mode, architecture, execution: 'real-server', realScore: true, status: 'passed', reason: 'Gate unit-test fixture only',
      startedAt: 'fixture-time', modelDelayMs: 0, metrics, checkpointsReached: 0, evidenceCount: 2, perturbationInjected: false,
      candidate: { model: { id: 'fixture-model' } }, source,
    })));
  }
  const skill = rows('skill', 'dual');
  assert.equal(summarizeExams(skill).groups[0].phaseOnePassed, true);
  assert.equal(summarizeExams(skill).phaseTwoEligible, false, '50 skill passes do not establish agent planning.');
  assert.equal(summarizeExams(rows('agent', 'serial')).phaseTwoEligible, false, 'Serial performance does not establish dual performance.');
  assert.equal(summarizeExams([...rows('skill', 'dual', 3), ...rows('agent', 'dual', 2)]).phaseTwoEligible, false);
  assert.equal(summarizeExams([...rows('agent', 'parallel', 3), ...rows('agent', 'dual', 2)]).phaseTwoEligible, false);
  const dual = rows('agent', 'dual'); assert.equal(summarizeExams(dual).phaseTwoEligible, true);
  const mixedModels = dual.map((row, i) => i % 5 < 3 ? row : { ...row, candidate: { model: { id: 'other-model' } } });
  assert.equal(summarizeExams(mixedModels).phaseTwoEligible, false);
  const mixedSources = dual.map((row, i) => i % 5 < 3 ? row : { ...row, source: { ...source, workingTreeId: 'other-tree' } });
  assert.equal(summarizeExams(mixedSources).phaseTwoEligible, false);
  assert.equal(summarizeExams(dual.map(row => ({ ...row, taskRevision: 0 }))).phaseTwoEligible, false);
  assert.equal(summarizeExams(dual.map(row => ({ ...row, architecture: undefined }))).phaseTwoEligible, false);
});

test('RCON reconstructs split response frames and serialized multiline results', async t => {
  const sockets = new Set<import('node:net').Socket>();
  const frame = (id: number, type: number, text: string) => { const content = Buffer.from(text), packet = Buffer.alloc(content.length + 14); packet.writeInt32LE(content.length + 10); packet.writeInt32LE(id, 4); packet.writeInt32LE(type, 8); content.copy(packet, 12); return packet; };
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); let buffer = Buffer.alloc(0);
    socket.on('data', bytes => { buffer = Buffer.concat([buffer, bytes]); while (buffer.length >= 4 && buffer.length >= buffer.readInt32LE(0) + 4) {
      const length = buffer.readInt32LE(0), id = buffer.readInt32LE(4), type = buffer.readInt32LE(8), command = buffer.subarray(12, length + 2).toString(); buffer = buffer.subarray(length + 4);
      if (type === 3) socket.write(frame(id, 2, ''));
      else if (!command) socket.write(frame(id, 0, ''));
      else { const a = frame(id, 0, 'part-one\n'), b = frame(id, 0, 'part-two'); socket.write(a.subarray(0, 3)); socket.write(Buffer.concat([a.subarray(3), b])); }
    } });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new LocalRcon();
  t.after(async () => { client.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string'); await client.connect(address.port, 'fixture-password');
  assert.deepEqual(await Promise.all([client.command('first'), client.command('second')]), ['part-one\npart-two', 'part-one\npart-two']);
});
test('RCON waits for a response before sending the barrier, matching vanilla packet-reader constraints', async t => {
  const sockets = new Set<import('node:net').Socket>(); let pipelined = false;
  const frame = (id: number, type: number, text: string) => { const content = Buffer.from(text), packet = Buffer.alloc(content.length + 14); packet.writeInt32LE(content.length + 10); packet.writeInt32LE(id, 4); packet.writeInt32LE(type, 8); content.copy(packet, 12); return packet; };
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); let buffer = Buffer.alloc(0), awaitingResponse = false;
    socket.on('data', bytes => { buffer = Buffer.concat([buffer, bytes]); while (buffer.length >= 4 && buffer.length >= buffer.readInt32LE(0) + 4) {
      const length = buffer.readInt32LE(0), id = buffer.readInt32LE(4), type = buffer.readInt32LE(8), command = buffer.subarray(12, length + 2).toString(); buffer = buffer.subarray(length + 4);
      if (awaitingResponse) { pipelined = true; socket.destroy(); return; }
      awaitingResponse = true;
      setTimeout(() => { awaitingResponse = false; if (!socket.destroyed) socket.write(frame(id, type === 3 ? 2 : 0, command && type !== 3 ? 'ok' : '')); }, 2);
    } });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const client = new LocalRcon();
  t.after(async () => { client.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string'); await client.connect(address.port, 'fixture');
  assert.equal(await client.command('first'), 'ok'); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(await client.command('second'), 'ok'); assert.equal(pipelined, false);
});

test('server preparation is isolated and refuses an unmarked existing world', async t => {
  const parent = resolve(tmpdir()), root = await mkdtemp(join(parent, 'anima-skill-exam-test-'));
  t.after(async () => { assert.equal(dirname(root), parent); assert.ok(root.startsWith(join(parent, 'anima-skill-exam-test-'))); await rm(root, { recursive: true, force: true }); });
  const runtime = join(root, 'var/minecraft'), install = join(runtime, 'installed'); await mkdir(install, { recursive: true });
  await writeFile(join(runtime, 'runtime.json'), JSON.stringify({ version: '1.21.4', java: 'fixture-java', serverJar: join(install, 'server.jar') }));
  await writeFile(join(install, 'eula.txt'), 'eula=true\n');
  await assert.rejects(prepareExamServer(root, { gamePort: 25565 }), /never the survival port/u);
  const config = await prepareExamServer(root); assert.equal(config.gamePort, 25575); assert.equal(config.rconPort, 25585);
  assert.equal((await loadExamServer(root)).serverId, config.serverId);
  const properties = await readFile(join(config.directory, 'server.properties'), 'utf8'); assert.match(properties, /level-name=exam-world/u); assert.match(properties, /server-ip=127\.0\.0\.1/u);
  assert.equal((await prepareExamServer(root)).serverId, config.serverId, 'Resume preserves credential/world identity.');
  const other = join(root, 'other'); await mkdir(join(other, 'var/minecraft/skill-exam/server'), { recursive: true });
  await mkdir(join(other, 'var/minecraft'), { recursive: true }); await writeFile(join(other, 'var/minecraft/runtime.json'), await readFile(join(runtime, 'runtime.json')));
  await writeFile(join(other, 'var/minecraft/skill-exam/server/level.dat'), 'existing-user-world');
  await assert.rejects(prepareExamServer(other), /nonempty unmarked/u);
});

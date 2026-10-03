import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parseContinuityArgs, assertArenaPlayers, assertContinuityIsolation, RouteReferee, PUBLIC_ROUTE } from '../adapters/minecraft/benchmark/continuity-probe.ts';
import { measureContinuity } from '../adapters/minecraft/benchmark/continuity-metrics.ts';
import type { ExamServerConfig } from '../adapters/minecraft/benchmark/server.ts';
import type { ServerEvidence } from '../adapters/minecraft/benchmark/types.ts';
import { resolve } from 'node:path';

test('probe is opt-in and supports both argument styles with bounded options', () => {
  assert.equal(parseContinuityArgs([]).run, false);
  assert.deepEqual(parseContinuityArgs(['--run', '--mode=agent', '--variant', 'baseline', '--task=obstacle', '--repeat', '2']),
    { run: true, mode: 'agent', variant: 'baseline', task: 'obstacle', repeat: 2, plannerDelayMs: 2000, timeoutMs: 180000, model: 'gpt-6.1-sol' });
  for (const argv of [['--mode=unknown'], ['--repeat=0'], ['--timeout-ms=NaN'], ['--planner-delay-ms=-1'], ['--port=25565']])
    assert.throws(() => parseContinuityArgs(argv));
});

test('default CLI prints usage without loading the arena or model', () => {
  const child = spawnSync(process.execPath, ['adapters/minecraft/benchmark/continuity-probe.ts'], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /No --run: usage only/);
});

test('isolation fails closed on foreign worlds, ports, and unexpected players', () => {
  const root = resolve(import.meta.dirname, '..');
  const config = { kind: 'anima-skill-exam', gamePort: 25575, rconPort: 25585, version: '1.21.4',
    directory: resolve(root, 'var/minecraft/skill-exam/server') } as ExamServerConfig;
  assertContinuityIsolation(config, root);
  assert.throws(() => assertContinuityIsolation({ ...config, gamePort: 25565 }, root));
  assert.throws(() => assertContinuityIsolation({ ...config, directory: resolve(root, 'worlds') }, root));
  assertArenaPlayers('There are 0 of a max of 8 players online: ', []);
  assertArenaPlayers('There are 1 of a max of 8 players online: ContinuityProbe', ['ContinuityProbe']);
  assert.throws(() => assertArenaPlayers('There are 2 of a max of 8 players online: ContinuityProbe, Human', ['ContinuityProbe']));
  assert.throws(() => assertArenaPlayers('Unknown command', []));
  assert.throws(() => assertArenaPlayers('There are 1 of a max of 8 players online: ', []));
});

test('checkpoint authority requires ordered live grounded server arrivals and final stability', () => {
  const referee = new RouteReferee(PUBLIC_ROUTE.slice(0, 2));
  const evidence = (index: number, at: number, onGround = true): ServerEvidence => ({ source: 'vanilla-rcon', sequence: at,
    sampledAt: at, serverTick: at / 50, actor: { name: 'A', position: PUBLIC_ROUTE[index], health: 20, food: 20,
      air: 300, inventory: {}, onGround }, statistics: {}, enemies: [] });
  assert.equal(referee.observe(evidence(1, 100)), false); assert.equal(referee.reached, 0);
  assert.equal(referee.observe(evidence(0, 200, false)), false); assert.equal(referee.reached, 0);
  referee.observe(evidence(0, 300)); assert.equal(referee.reached, 1);
  assert.equal(referee.observe(evidence(1, 500)), false);
  assert.equal(referee.observe(evidence(1, 799)), false);
  assert.equal(referee.observe(evidence(1, 800)), true); assert.equal(referee.reached, 2);
});

test('metrics separate real model spans, scripted delay, native idle, and replan latency', () => {
  const metrics = measureContinuity([
    { at: 100, type: 'planner-delay-start', id: 1 }, { at: 500, type: 'planner-delay-end', id: 1 },
    { at: 600, type: 'native-start', id: 1 }, { at: 1000, type: 'native-end', id: 1 },
    { at: 900, type: 'model-start', channel: 'a' }, { at: 1600, type: 'model-end', channel: 'a' },
    { at: 1050, type: 'goal-blocked' }, { at: 1250, type: 'planner-start' },
    { at: 1600, type: 'plan-accepted', operation: 'append' },
    { at: 1700, type: 'native-start', id: 2 }, { at: 2000, type: 'native-end', id: 2 },
  ], 0, 2200);
  assert.equal(metrics.modelWaitMs, 700); assert.equal(metrics.scriptedPlannerDelayMs, 400);
  assert.equal(metrics.nativeWorkMs, 700); assert.equal(metrics.noNativeWorkMs, 1500);
  assert.equal(metrics.interSkillNoWorkMs, 700); assert.equal(metrics.startupNoWorkMs, 600); assert.equal(metrics.tailNoWorkMs, 200);
  assert.equal(metrics.modelNativeWorkOverlapMs, 100); assert.equal(metrics.acceptedAppends, 1);
  assert.equal(metrics.noWorkDuringModelMs, 600); assert.equal(metrics.noWorkDuringScriptedDelayMs, 400);
  assert.equal(metrics.otherNoWorkMs, 500);
  assert.equal(metrics.noWorkDuringModelMs + metrics.noWorkDuringScriptedDelayMs + metrics.otherNoWorkMs, metrics.noNativeWorkMs);
  assert.deepEqual(metrics.interSkillGaps[0], { from: 1000, to: 1700, durationMs: 700,
    noWorkDuringModelMs: 600, noWorkDuringScriptedDelayMs: 0, otherNoWorkMs: 100 });
  assert.deepEqual(metrics.blocked, [{ at: 1050, plannerStartedAfterMs: 200, planAcceptedAfterMs: 550, workResumedAfterMs: 650 }]);
});

test('overlapping calls are unioned and pending intervals are right censored', () => {
  const metrics = measureContinuity([
    { at: -10, type: 'model-start', channel: 'a' }, { at: 10, type: 'model-start', channel: 'b' },
    { at: 30, type: 'model-end', channel: 'a' }, { at: 70, type: 'model-end', channel: 'b' },
    { at: 80, type: 'native-start', id: 1 }, { at: 150, type: 'native-end', id: 1 },
  ], 0, 100);
  assert.equal(metrics.modelWaitMs, 70); assert.equal(metrics.nativeWorkMs, 20); assert.equal(metrics.tailNoWorkMs, 0);
  assert.equal(measureContinuity([{ at: 10, type: 'model-start', channel: 'open' }], 0, 100).modelWaitMs, 90);
  assert.throws(() => measureContinuity([], 10, 1));
});

test('idle partition never double counts a scripted delay overlapping model calls or work', () => {
  const metrics = measureContinuity([
    { at: 0, type: 'planner-delay-start', id: 1 }, { at: 100, type: 'planner-delay-end', id: 1 },
    { at: 30, type: 'model-start', channel: 'a' }, { at: 80, type: 'model-end', channel: 'a' },
    { at: 60, type: 'native-start', id: 1 }, { at: 90, type: 'native-end', id: 1 },
  ], 0, 120);
  assert.equal(metrics.nativeWorkMs, 30); assert.equal(metrics.noWorkDuringModelMs, 30);
  assert.equal(metrics.noWorkDuringScriptedDelayMs, 40); assert.equal(metrics.otherNoWorkMs, 20);
  assert.equal(metrics.nativeWorkMs + metrics.noWorkDuringModelMs + metrics.noWorkDuringScriptedDelayMs + metrics.otherNoWorkMs, metrics.elapsedMs);
});

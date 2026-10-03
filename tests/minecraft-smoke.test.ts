import test from 'node:test';
import assert from 'node:assert/strict';
import { smokeAction, smokeLive, type SmokeApi } from '../adapters/minecraft/scripts/smoke.ts';

const action = { type: 'goto', x: 3, y: 64, z: 0 };
const receipt = (version = 4, id = 'own') => ({ id: 10, intentId: id, intentVersion: version, status: 'completed',
  result: { status: 'completed', action, before: { x: 0, y: 64, z: 0 }, after: { x: 3, y: 64, z: 0 } } });
function fixture(states: any[], disabled = false) {
  let reads = 0; const calls: { path: string; input?: any }[] = [];
  const call: SmokeApi = async (path, input) => {
    calls.push({ path, input });
    if (path === 'bots') return { bots: [{ name: 'LinChe', ready: true, busy: false }] };
    if (path.endsWith('/control')) return disabled ? { enabled: false } : states[Math.min(reads++, states.length - 1)];
    if (path.endsWith('/actions')) return receipt().result;
    if (path.endsWith('/intent')) return { accepted: true, version: 4, intentId: 'own' };
    throw new Error(`Unexpected fixture call: ${path}`);
  };
  return { call, calls };
}

test('dual smoke awaits its exact native receipt and intent retirement, not acceptance or another lease receipt', async () => {
  const f = fixture([{ version: 3 },
    { version: 4, intent: { version: 4 }, recentReceipts: [receipt(2, 'old')] },
    { version: 4, intent: { version: 4 }, recentReceipts: [receipt()] },
    { version: 5, recentReceipts: [receipt()] }]);
  const result = await smokeAction(f.call, 'LinChe', action, { timeoutMs: 200, pollMs: 1 });
  assert.equal(result.status, 'completed'); assert.deepEqual(result.after, { x: 3, y: 64, z: 0 });
  assert.equal(result.ownership.intentVersion, 4);
  assert.equal(f.calls.filter(call => call.path.endsWith('/control')).length, 4);
  const submitted = f.calls.find(call => call.input)!;
  assert.equal(submitted.path, 'bots/LinChe/intent'); assert.equal(submitted.input.expectedVersion, 3);
  assert.deepEqual(submitted.input.steps, [action]);
});

test('legacy smoke still invokes physical actions when dual loop is disabled', async () => {
  const f = fixture([], true);
  assert.equal((await smokeAction(f.call, 'LinChe', action)).status, 'completed');
  assert.deepEqual(f.calls.filter(call => call.input), [{ path: 'bots/LinChe/actions', input: action }]);
});

test('smoke refuses to replace an existing goal, including an idle reaction lease', async () => {
  const f = fixture([{ version: 3, intent: { version: 3, goal: { steps: [] } } }]);
  await assert.rejects(smokeAction(f.call, 'LinChe', action), /idle body/);
  assert.equal(f.calls.filter(call => call.input).length, 0);
});

test('replacement or timeout only attempts cleanup with the original owned version and never calls stop', async () => {
  for (const state of [{ version: 8, intent: { version: 8 }, recentReceipts: [receipt(8, 'someone-else')] },
    { version: 4, intent: { version: 4 }, recentReceipts: [] }]) {
    const f = fixture([{ version: 3 }, state]);
    await assert.rejects(smokeAction(f.call, 'LinChe', action, { timeoutMs: 0 }), /replaced|Timed out/);
    const writes = f.calls.filter(call => call.input);
    assert.equal(writes.length, 2); assert.equal(writes[1].input.expectedVersion, 4);
    assert.deepEqual(writes[1].input.steps, []); assert.equal(writes[1].input.resume, undefined);
    assert.ok(f.calls.every(call => !call.path.endsWith('/stop')));
  }
});

test('a cancelled controller receipt cannot be credited as a completed native action', async () => {
  const f = fixture([{ version: 3 }, { version: 4, recentReceipts: [{ ...receipt(), status: 'cancelled' }] }]);
  await assert.rejects(smokeAction(f.call, 'LinChe', action, { timeoutMs: 0 }), /cancelled/);
});

function liveFixture(completed: boolean, initialVersion = 4) {
  let observationReads = 0; const calls: any[] = [];
  const state: any = { control: { version: initialVersion, recentReceipts: [] }, hostPreservedPreparation: false };
  const call: SmokeApi = async (path, input) => {
    calls.push({ path, input });
    if (path === 'bots') return { bots: [{ name: 'LinChe', ready: true, busy: false }] };
    if (path.endsWith('/control')) return structuredClone(state.control);
    if (path.endsWith('/observe')) return { position: { x: observationReads++ && completed ? 3 : 0, y: 64, z: 0 } };
    if (path.endsWith('/intent')) {
      if (input.expectedVersion !== state.control.version) return { accepted: false, reason: 'stale_version' };
      const version = state.control.version + 1, intentId = input.label === 'smoke cleanup' ? 'cleanup' : 'prepared-own';
      state.control = { version, intent: { id: intentId, version, expiresAt: Date.now() + input.ttlMs,
        goal: { steps: input.steps, label: input.label }, allowedReactions: input.reactions }, recentReceipts: [] };
      return { accepted: true, version, intentId };
    }
    if (path.endsWith('/tasks')) {
      // Mirrors the documented host boundary: admission preserves an already
      // authorized, unexpired preparation instead of granting a new standby.
      assert.equal(state.control.intent.id, 'prepared-own');
      assert.deepEqual(state.control.intent.goal.steps, []); assert.deepEqual(state.control.intent.allowedReactions, []);
      assert.ok(state.control.intent.expiresAt > Date.now());
      const preparedVersion = state.control.version;
      assert.ok(input.instruction.includes(`control.intent.id=prepared-own`));
      assert.ok(input.instruction.includes(`expectedVersion=${preparedVersion}`));
      state.hostPreservedPreparation = true;
      const label = /label=([^，]+)/u.exec(input.instruction)![1];
      const moveVersion = preparedVersion + 1;
      state.control = completed ? { version: moveVersion + 1, recentReceipts: [receipt(moveVersion, 'owned-move')] }
        : { version: moveVersion, intent: { id: 'owned-move', version: moveVersion }, recentReceipts: [] };
      return { status: 'completed', actions: [{ status: 'completed', action: { type: 'say', message: '你好。' } }],
        toolTrace: [{ name: 'body_plan', status: 'accepted', args: JSON.stringify({ expectedVersion: preparedVersion, label,
          restart: true, ttlMs: 30000, reactions: [], steps: [action] }) }] };
    }
    throw new Error(`Unexpected fixture call: ${path}`);
  };
  return { call, calls, state };
}

test('live smoke owns a finite preparation that host admission preserves, including initial version zero', async () => {
  for (const initialVersion of [0, 4]) {
    const f = liveFixture(true, initialVersion), result = await smokeLive(f.call, 'LinChe', { timeoutMs: 0 });
    assert.equal(result.task.actions.length, 1); assert.equal(result.movement.action.type, 'goto');
    assert.equal(result.movement.ownership.intentVersion, initialVersion + 2); assert.equal(result.after.position.x, 3);
    assert.deepEqual(result.preparation, { version: initialVersion + 1, intentId: 'prepared-own' });
    assert.equal(f.state.hostPreservedPreparation, true);
    const prepare = f.calls.find(call => call.path.endsWith('/intent'));
    assert.equal(prepare.input.expectedVersion, initialVersion); assert.equal(prepare.input.ttlMs, 120000);
    assert.deepEqual(prepare.input.steps, []); assert.deepEqual(prepare.input.reactions, []);
    assert.equal(prepare.input.resume, undefined);
  }
});

test('live smoke cannot pass with an accepted plan and unchanged world', async () => {
  const f = liveFixture(false);
  await assert.rejects(smokeLive(f.call, 'LinChe', { timeoutMs: 0 }), /Timed out/);
  const cleanup = f.calls.find(call => call.input?.label === 'smoke cleanup');
  assert.equal(cleanup.input.expectedVersion, 6, 'accepted exact trace proves this movement version');
});

test('live smoke does not attribute a newer ownership version or clean up an unowned plan', async () => {
  const f = liveFixture(true);
  const call: SmokeApi = async (path, input) => {
    const result = await f.call(path, input);
    if (path.endsWith('/tasks')) {
      assert.match(input.instruction, /expectedVersion=5/);
      const args = JSON.parse(result.toolTrace[0].args);
      args.expectedVersion = 7;
      result.toolTrace[0].args = JSON.stringify(args);
    }
    return result;
  };
  await assert.rejects(smokeLive(call, 'LinChe', { timeoutMs: 0 }), /attributable/);
  const writes = f.calls.filter(call => call.path.endsWith('/intent'));
  assert.deepEqual(writes.map(call => call.input.expectedVersion), [4, 5], 'only proven preparation may be cleaned up');
  assert.ok(f.calls.every(call => !call.path.endsWith('/stop')));
});

test('live smoke rejects extra accepted plans and unexpected retained reactions', async () => {
  for (const extraPlan of [false, true]) {
    const f = liveFixture(true);
    const call: SmokeApi = async (path, input) => {
      const result = await f.call(path, input);
      if (path.endsWith('/tasks')) {
        if (extraPlan) result.toolTrace.push({ ...result.toolTrace[0] });
        else {
          const args = JSON.parse(result.toolTrace[0].args);
          args.reactions = ['flee'];
          result.toolTrace[0].args = JSON.stringify(args);
        }
      }
      return result;
    };
    await assert.rejects(smokeLive(call, 'LinChe', { timeoutMs: 0 }), /attributable|exactly one/);
    assert.deepEqual(f.calls.filter(call => call.path.endsWith('/intent')).map(call => call.input.expectedVersion), [4, 5]);
    assert.ok(f.calls.every(call => !call.path.endsWith('/stop')));
  }
});

test('foreign replacement of preparation is rejected before starting a model task', async () => {
  const f = liveFixture(true), foreign = { version: 6, intent: { id: 'foreign', version: 6,
    expiresAt: Date.now() + 120000, goal: { steps: [action] }, allowedReactions: [] } };
  const call: SmokeApi = async (path, input) => {
    const result = await f.call(path, input);
    if (input?.label?.endsWith('-prepare')) f.state.control = structuredClone(foreign);
    return result;
  };
  await assert.rejects(smokeLive(call, 'LinChe'), /preparation lease was replaced/);
  assert.equal(f.calls.some(call => call.path.endsWith('/tasks')), false);
  assert.deepEqual(f.state.control, foreign);
  assert.equal(f.calls.at(-1).input.expectedVersion, 5, 'cleanup never borrows foreign version 6');
});

test('same version but wrong intentId cannot impersonate the preparation lease', async () => {
  const f = liveFixture(true);
  const call: SmokeApi = async (path, input) => {
    const result = await f.call(path, input);
    if (input?.label?.endsWith('-prepare')) f.state.control.intent.id = 'not-the-receipted-owner';
    return result;
  };
  await assert.rejects(smokeLive(call, 'LinChe'), /preparation lease was replaced/);
  assert.equal(f.calls.some(call => call.path.endsWith('/tasks')), false);
  assert.equal(f.calls.filter(call => call.path.endsWith('/intent')).length, 1, 'contradictory identity is not cleaned up');
  assert.equal(f.state.control.intent.id, 'not-the-receipted-owner');
});

test('unknown task timeout cleans only acknowledged preparation, never guesses the next owner', async () => {
  for (const replaced of [false, true]) {
    const f = liveFixture(false);
    const call: SmokeApi = async (path, input) => {
      if (path.endsWith('/tasks')) {
        f.calls.push({ path, input });
        if (replaced) f.state.control = { version: 6, intent: { id: 'foreign', version: 6 }, recentReceipts: [] };
        throw new Error('Task HTTP timeout; outcome unknown');
      }
      return f.call(path, input);
    };
    await assert.rejects(smokeLive(call, 'LinChe'), /outcome unknown/);
    const cleanup = f.calls.filter(call => call.input?.label === 'smoke cleanup');
    assert.equal(cleanup.length, 1); assert.equal(cleanup[0].input.expectedVersion, 5);
    if (replaced) assert.equal(f.state.control.intent.id, 'foreign');
    else assert.equal(f.state.control.intent.id, 'cleanup');
    assert.ok(f.calls.every(call => !call.path.endsWith('/stop')));
  }
});

test('unknown preparation POST outcome is left to its finite TTL, without guessing an owner', async () => {
  const f = liveFixture(false);
  const call: SmokeApi = async (path, input) => {
    const result = await f.call(path, input);
    if (input?.label?.endsWith('-prepare')) throw new Error('Preparation HTTP timeout');
    return result;
  };
  await assert.rejects(smokeLive(call, 'LinChe'), /Preparation HTTP timeout/);
  assert.equal(f.calls.filter(call => call.path.endsWith('/intent')).length, 1);
  assert.equal(f.calls.some(call => call.path.endsWith('/tasks')), false);
  assert.ok(f.state.control.intent.expiresAt <= Date.now() + 120000);
});

test('live legacy smoke performs no preparation and verifies the completed native action', async () => {
  const f = liveFixture(true);
  const call: SmokeApi = async (path, input) => {
    if (path.endsWith('/control')) { f.calls.push({ path, input }); return { enabled: false }; }
    if (path.endsWith('/tasks')) {
      f.calls.push({ path, input });
      return { status: 'completed', actions: [{ status: 'completed', action: { type: 'say', message: '你好。' } }, receipt().result] };
    }
    return f.call(path, input);
  };
  const result = await smokeLive(call, 'LinChe'); assert.equal(result.movement.status, 'completed');
  assert.equal(result.preparation, undefined); assert.equal(f.calls.some(call => call.path.endsWith('/intent')), false);
});

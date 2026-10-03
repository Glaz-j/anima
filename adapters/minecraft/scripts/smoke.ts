import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

export type SmokeApi = (path: string, input?: any) => Promise<any>;
type WaitOptions = { timeoutMs?: number; pollMs?: number };
const physical = (action: any) => !['say', 'broadcast', 'scan', 'recipes'].includes(action.type);
const sameAction = (actual: any, expected: any) => actual?.type === expected.type
  && Object.entries(expected).every(([key, value]) => JSON.stringify(actual[key]) === JSON.stringify(value));
const distance = (a: any, b: any) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export async function smokeIdleControl(call: SmokeApi, name: string) {
  const { bots } = await call('bots'), actor = bots.find((bot: any) => bot.name === name);
  assert.ok(actor?.ready, `${name} must be ready`);
  assert.ok(!actor.taskId && !actor.brainBusy && !actor.busy, `${name} is busy; smoke must not replace another task`);
  const control = await call(`bots/${name}/control`);
  if (control.enabled !== false) {
    assert.ok(Number.isSafeInteger(control.version), 'Body control version is required');
    assert.ok(!control.stopped && !control.disposed, 'Smoke does not implicitly resume a stopped body');
    assert.ok(!control.intent && !control.current, 'Smoke requires an idle body without another authorized goal');
  }
  return control;
}

/** Revoke only OUR observed version. A replacement, expiry or stop makes this
 * CAS fail; never fetch a newer version and never invoke the unversioned /stop. */
export async function revokeSmokeIntent(call: SmokeApi, name: string, ownedVersion: number) {
  try {
    await call(`bots/${name}/intent`, { expectedVersion: ownedVersion, label: 'smoke cleanup',
      steps: [], reactions: [], ttlMs: 1000 });
  } catch { /* A changed owner is deliberately left alone. The original lease is finite. */ }
}

/** Accepted is not completion. Match the native receipt to this exact lease. */
export async function waitSmokeReceipt(call: SmokeApi, name: string, owner: { version: number; intentId?: string },
  expected: any, options: WaitOptions = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 35000);
  while (true) {
    const control = await call(`bots/${name}/control`);
    const receipts = (control.recentReceipts || []).filter((receipt: any) => receipt.intentVersion === owner.version
      && (!owner.intentId || receipt.intentId === owner.intentId) && sameAction(receipt.result?.action, expected));
    const completed = receipts.find((receipt: any) => receipt.status === 'completed' && receipt.result?.status === 'completed');
    // The native receipt precedes the next controller tick retiring this
    // single-step intent. Wait through that handoff before another smoke step.
    if (completed && control.intent?.version !== owner.version && control.current?.intentVersion !== owner.version)
      return { ...completed.result, ownership: { intentVersion: owner.version, intentId: completed.intentId, receiptId: completed.id } };
    const failure = receipts.find((receipt: any) => ['failed', 'cancelled'].includes(receipt.status));
    if (!completed && failure) throw new Error(`Smoke ${expected.type} ${failure.status}: ${failure.reason || failure.result?.error || 'native skill did not complete'}`);
    if (control.stopped || (control.version !== owner.version && control.current?.intentVersion !== owner.version))
      throw new Error('Smoke intent was replaced, stopped, expired or finished without the required native receipt');
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for the real ${expected.type} receipt`);
    await delay(options.pollMs ?? 100);
  }
}

export async function smokeAction(call: SmokeApi, name: string, action: any, options: WaitOptions = {}) {
  if (!physical(action)) return call(`bots/${name}/actions`, action);
  const control = await smokeIdleControl(call, name);
  if (control.enabled === false) return call(`bots/${name}/actions`, action);
  const accepted = await call(`bots/${name}/intent`, { expectedVersion: control.version,
    label: `smoke ${action.type}`, steps: [action], reactions: [], ttlMs: 30000 });
  assert.equal(accepted.accepted, true, 'Body must explicitly accept this smoke intent');
  assert.ok(Number.isSafeInteger(accepted.version), 'Accepted intent must have an ownership version');
  try { return await waitSmokeReceipt(call, name, accepted, action, options); }
  catch (error) { await revokeSmokeIntent(call, name, accepted.version); throw error; }
}

export async function smokeLive(call: SmokeApi, name: string, options: WaitOptions = {}) {
  const control = await smokeIdleControl(call, name), before = await call(`bots/${name}/observe`);
  const target = { type: 'goto', x: Number((before.position.x + 3).toFixed(1)),
    y: Number(before.position.y.toFixed(1)), z: Number(before.position.z.toFixed(1)) };
  const label = `smoke-live-${randomUUID()}`, dual = control.enabled !== false;
  let preparation: { version: number; intentId: string } | undefined, movementVersion: number | undefined;
  let preparationCleanupSafe = true;
  try {
    if (dual) {
      // /tasks may grant a new host survival lease when the body is empty.
      // Create our own explicit, finite reservation first so task admission
      // preserves this exact owner instead of changing the planning version.
      const accepted = await call(`bots/${name}/intent`, { expectedVersion: control.version,
        label: `${label}-prepare`, steps: [], reactions: [], ttlMs: 120000 });
      assert.equal(accepted.accepted, true, 'Body must accept the smoke preparation lease');
      assert.ok(Number.isSafeInteger(accepted.version) && typeof accepted.intentId === 'string' && accepted.intentId.length,
        'Preparation must return its definite version and intentId');
      preparation = { version: accepted.version, intentId: accepted.intentId };
      const current = await call(`bots/${name}/control`);
      // Versions are monotonic within a service. If its identity contract is
      // violated, even a numerically equal version is no longer proof of ours.
      if (current.version === preparation.version && current.intent?.id !== preparation.intentId) preparationCleanupSafe = false;
      assert.ok(current.version === preparation.version && current.intent?.version === preparation.version
        && current.intent?.id === preparation.intentId && current.intent.expiresAt > Date.now()
        && current.intent.goal?.steps?.length === 0 && current.intent.allowedReactions?.length === 0
        && !current.stopped && !current.disposed && !current.current,
      'Smoke preparation lease was replaced, expired or stopped before task admission');
    }
    const task = await call(`bots/${name}/tasks`, { instruction: '这是一次真实控制验证。先通过action say向小雨简短打招呼。'
      + (preparation ? `然后读取body_status：本次测试已明确建立准备授权，只有control.version=${preparation.version}、control.intent.id=${preparation.intentId}、intent.version=${preparation.version}、stepCount=0、allowedReactions=[]且没有current/stopped时，才允许把这份确切授权转为一次body_plan：expectedVersion=${preparation.version}，label=${label}，restart=true，ttlMs=30000，reactions=[]，steps=${JSON.stringify([target])}。任何版本、id或占用状态变化都直接结束；不能只按label认领目标，不能使用更新版本覆盖别人，不要cancel_body或resume。`
        : `然后通过action调用${JSON.stringify(target)}。`)
      + '只做这次打招呼和移动，提交后可以结束思考，不要重新提交目标或做其他事。' });
    let movement: any;
    if (preparation) {
      // Only a returned, accepted, exact tool trace proves that restart advanced
      // OUR preparation by one. A timeout or missing trace never proves v+1 is ours.
      const acceptedPlans = (task.toolTrace || []).filter((trace: any) => trace.name === 'body_plan' && trace.status === 'accepted');
      assert.equal(acceptedPlans.length, 1, 'Model must accept exactly one body plan during the smoke task');
      const submissions = acceptedPlans
        .flatMap((trace: any) => { try { return [JSON.parse(trace.args)]; } catch { return []; } })
        .filter((args: any) => args.label === label && args.restart === true && args.ttlMs === 30000
          && args.expectedVersion === preparation!.version && Array.isArray(args.reactions) && args.reactions.length === 0
          && args.steps?.length === 1 && sameAction(args.steps[0], target));
      assert.equal(submissions.length, 1, 'Model must submit exactly one attributable smoke body plan');
      movementVersion = preparation.version + 1;
    }
    assert.equal(task.status, 'completed');
    assert.ok(task.actions?.some((a: any) => a.action?.type === 'say' && a.status === 'completed'), 'Real model must actually send say');
    if (movementVersion !== undefined) movement = await waitSmokeReceipt(call, name, { version: movementVersion }, target, options);
    else movement = task.actions?.find((a: any) => a.status === 'completed' && sameAction(a.action, target));
    assert.ok(movement?.after, 'Model action must have a real completed movement receipt');
    assert.ok(distance(before.position, movement.after) > 1, 'Real model must cause actual movement');
    assert.ok(distance(movement.after, target) < .9, 'Completed model movement must reach the requested point');
    const after = await call(`bots/${name}/observe`);
    assert.ok(distance(after.position, target) < .9, 'Current world observation must confirm model arrival');
    return { task, movement, before, after, ...(preparation ? { preparation, ownershipScope: 'explicit-preparation-to-model-goto' } : {}) };
  } catch (error) {
    // On an unknown /tasks outcome, only the preparation receipt is proven.
    // Its CAS will fail if a model/other operator has already replaced it. Do
    // not fetch a newer owner or guess that the next version belongs to us.
    const ownedVersion = movementVersion ?? (preparationCleanupSafe ? preparation?.version : undefined);
    if (ownedVersion !== undefined) await revokeSmokeIntent(call, name, ownedVersion);
    throw error;
  }
}

async function main() {
  const session = JSON.parse(await readFile(resolve('var/minecraft/api-session.json'), 'utf8'));
  const call: SmokeApi = async (path, input) => {
    const response = await fetch(session.baseUrl + '/api/' + path, { method: input === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + session.token, 'Content-Type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(110000) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || `API status ${response.status}`); return data;
  };
  let ready = false;
  for (let i = 0; i < 60; i++) {
    const { bots } = await call('bots');
    if (['LinChe', 'XiaoYu'].every(name => bots.some((bot: any) => bot.name === name && bot.ready))) { ready = true; break; }
    await delay(1000);
  }
  assert.ok(ready, 'LinChe and XiaoYu must join the actual server');
  const initial = await call('bots/LinChe/observe');
  const movement = await smokeAction(call, 'LinChe', { type: 'goto', x: initial.position.x + 3, y: initial.position.y, z: initial.position.z });
  assert.equal(movement.status, 'completed');
  assert.ok(distance(movement.after, initial.position) > 1, 'Actual position must change');
  const approach = await smokeAction(call, 'XiaoYu', { type: 'goto', x: movement.after.x, y: movement.after.y, z: movement.after.z + 2 });
  assert.equal(approach.status, 'completed');
  const message = '你好小雨，我们已经真实进入 Minecraft 世界。';
  assert.equal((await smokeAction(call, 'LinChe', { type: 'say', message })).status, 'completed');
  await delay(800);
  const heard = await call('bots/XiaoYu/observe');
  assert.ok(heard.recentEvents.some((e: any) => e.type === 'heard' && e.speaker === 'LinChe' && e.message === message), 'Nearby bot must hear chat');
  const placeTarget = { x: Math.floor(movement.after.x) + 2, y: Math.floor(movement.after.y), z: Math.floor(movement.after.z) };
  const placed = await smokeAction(call, 'LinChe', { type: 'place', ...placeTarget, item: 'cobblestone' });
  assert.equal(placed.status, 'completed', 'Place a real block');
  const dug = await smokeAction(call, 'LinChe', { type: 'dig', ...placeTarget });
  assert.equal(dug.status, 'completed', 'Remove the real block');
  const evidence: any = { time: new Date().toISOString(), initial, movement, approach, chat: { message, heard: true }, placed, dug };
  if (process.argv.includes('--live')) evidence.llm = await smokeLive(call, 'LinChe');
  await writeFile(resolve('var/minecraft/smoke-result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ passed: true, actualMovement: movement.after, llmTested: Boolean(evidence.llm), evidence: 'var/minecraft/smoke-result.json' }, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

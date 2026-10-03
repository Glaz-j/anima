import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { trackInputs } from '../adapters/minecraft/src/input-telemetry.ts';

function fixture(getter = true) {
  let time = 1000;
  const controls: Record<string, boolean> = {}, events: any[] = [], packets: any[] = [];
  const bot: any = { quickBarSlot: 0, _client: {
    write(name: string, params: any) { packets.push({ name, params }); return 42; },
  }, setControlState(name: string, value: boolean) { controls[name] = value; return 'changed'; },
  clearControlStates() { for (const name of Object.keys(controls)) this.setControlState(name, false); } };
  if (getter) bot.getControlState = (name: string) => controls[name] ?? false;
  const originalControl = bot.setControlState, originalWrite = bot._client.write;
  const telemetry = trackInputs(bot, event => events.push(event), () => time);
  return { bot, telemetry, events, packets, originalControl, originalWrite, time(value: number) { time = value; } };
}

test('held-key rewrites and physics packets never inflate issued-input counts', () => {
  const f = fixture();
  for (let i = 0; i < 100; i += 1) {
    f.bot.setControlState('forward', true);
    f.bot._client.write('position', { x: i, y: 64, z: 0, onGround: true });
  }
  assert.equal(f.telemetry.snapshot().issuedInputs, 1);
  f.bot.clearControlStates(); f.bot.clearControlStates();
  assert.equal(f.telemetry.snapshot().issuedInputs, 2);
  assert.deepEqual(f.events.map(event => event.value), [true, false]);
  f.telemetry.dispose();
});

test('a wrapper without getControlState still deduplicates held-key rewrites', () => {
  const f = fixture(false);
  for (let i = 0; i < 100; i += 1) f.bot.setControlState('forward', true);
  assert.equal(f.telemetry.snapshot().issuedInputs, 1);
  f.bot.setControlState('forward', false);
  assert.equal(f.telemetry.snapshot().issuedInputs, 2);
  f.telemetry.dispose();
});

test('aim noise and yaw wraparound are suppressed without suppressing real accumulated turns', () => {
  const f = fixture();
  const aim = (yaw: number, pitch = 0) => f.bot._client.write('look', { yaw, pitch });
  aim(179.8); aim(-179.8); aim(-179.3);
  assert.equal(f.telemetry.snapshot().counts.aim, 1, 'Crossing the signed yaw boundary is less than one degree.');
  aim(-178.8);
  assert.equal(f.telemetry.snapshot().counts.aim, 2);
  aim(-178.8, 2);
  assert.equal(f.telemetry.snapshot().counts.aim, 3);
  f.telemetry.dispose();
});

test('only actual discrete interactions and changed hotbar selections are counted', () => {
  const f = fixture();
  f.bot._client.write('held_item_slot', { slotId: 0 });
  f.bot._client.write('held_item_slot', { slotId: 1 });
  f.bot._client.write('held_item_slot', { slotId: 1 });
  f.bot._client.write('block_dig', { status: 0 });
  f.bot._client.write('block_dig', { status: 1 });
  f.bot._client.write('block_dig', { status: 2 });
  for (const name of ['use_entity', 'block_place', 'use_item', 'window_click']) f.bot._client.write(name, {});
  f.bot._client.write('keep_alive', {});
  assert.equal(f.telemetry.snapshot().issuedInputs, 6);
  assert.equal(f.telemetry.snapshot().counts['dig-start'], 1);
  assert.equal(f.telemetry.snapshot().counts.held_item_slot, 1);
  assert.equal(f.telemetry.snapshot().scope, 'issued-inputs-not-successful-effects');
  f.telemetry.dispose();
});

test('APM is normalized by actual elapsed time; last-minute counts expire without new inputs', () => {
  const f = fixture();
  for (let i = 0; i < 120; i += 1) f.bot._client.write('use_entity', {});
  f.time(61000);
  assert.equal(f.telemetry.snapshot().inputApm, 120);
  assert.equal(f.telemetry.snapshot().lastMinuteInputs, 120);
  f.time(61001);
  assert.equal(f.telemetry.snapshot().lastMinuteInputs, 0);
  assert.equal(f.telemetry.snapshot().issuedInputs, 120);
  const snapshot = f.telemetry.snapshot(); snapshot.counts.use_entity = 999;
  assert.equal(f.telemetry.snapshot().counts.use_entity, 120);
  f.telemetry.dispose();
});

test('dispose restores methods and later inputs no longer enter the old recorder', () => {
  const f = fixture();
  f.telemetry.dispose(); f.telemetry.dispose();
  assert.equal(f.bot.setControlState, f.originalControl); assert.equal(f.bot._client.write, f.originalWrite);
  assert.equal(f.bot.setControlState('forward', true), 'changed');
  assert.equal(f.bot._client.write('use_entity', {}), 42);
  assert.equal(f.telemetry.snapshot().issuedInputs, 0);
});

test('telemetry failure and incomplete packets do not prevent sending native inputs', () => {
  const bot: any = { _client: { write: () => 7 } };
  const telemetry = trackInputs(bot, () => { throw new Error('Logging unavailable.'); });
  assert.equal(bot._client.write('use_entity', {}), 7);
  for (const name of ['block_dig', 'held_item_slot', 'look', 'position_look']) assert.equal(bot._client.write(name, undefined), 7);
  assert.equal(telemetry.snapshot().issuedInputs, 1);
  telemetry.dispose();
});

test('failed native writes are not counted as issued inputs', () => {
  const bot: any = { _client: { write() { throw new Error('Disconnected.'); } } };
  const telemetry = trackInputs(bot);
  assert.throws(() => bot._client.write('use_entity', {}), /Disconnected/);
  assert.equal(telemetry.snapshot().issuedInputs, 0);
  telemetry.dispose();
});

test('dispose preserves later wrappers while disabling recorder callbacks retained inside them', () => {
  const f = fixture(), inner = f.bot._client.write;
  const external = function (this: any, name: string, params: unknown) { return inner.call(this, name, params); };
  f.bot._client.write = external; f.telemetry.dispose();
  assert.equal(f.bot._client.write, external);
  assert.equal(f.bot._client.write('use_entity', {}), 42);
  assert.equal(f.telemetry.snapshot().issuedInputs, 0);
});

test('late physics injection followed by spawn instruments key presses and clearControlStates releases', () => {
  const bot: any = new EventEmitter(); bot._client = { write() {} };
  const telemetry = trackInputs(bot);
  const controls: Record<string, boolean> = {};
  const native = (name: string, value: boolean) => { controls[name] = value; };
  bot.setControlState = native;
  bot.getControlState = (name: string) => controls[name] ?? false;
  bot.clearControlStates = () => { for (const name of Object.keys(controls)) bot.setControlState(name, false); };
  bot.emit('spawn');
  bot.setControlState('jump', true); bot.setControlState('forward', true);
  for (let i = 0; i < 50; i++) bot.setControlState('forward', true);
  bot.clearControlStates();
  assert.deepEqual(telemetry.snapshot().counts, { 'key:jump': 2, 'key:forward': 2 });
  telemetry.dispose();
  assert.equal(bot.setControlState, native);
  assert.equal(bot.listenerCount('spawn'), 0); assert.equal(bot.listenerCount('inject_allowed'), 0);
});

test('the injection event also instruments controls before the first spawn', async () => {
  const bot: any = new EventEmitter();
  const telemetry = trackInputs(bot);
  // Other injection listeners may run after the instrumentation listener.
  const controls: Record<string, boolean> = {};
  bot.on('inject_allowed', () => {
    bot.setControlState = (name: string, value: boolean) => { controls[name] = value; };
    bot.getControlState = (name: string) => controls[name] ?? false;
  });
  bot.emit('inject_allowed'); await Promise.resolve();
  bot.setControlState('jump', true);
  assert.equal(telemetry.snapshot().counts['key:jump'], 1);
  telemetry.dispose();
});

test('repeated spawns and explicit installs do not stack recorders or duplicate native calls', () => {
  const bot: any = new EventEmitter(), controls: Record<string, boolean> = {};
  let calls = 0;
  bot.setControlState = (name: string, value: boolean) => { calls++; controls[name] = value; };
  bot.getControlState = (name: string) => controls[name] ?? false;
  const telemetry = trackInputs(bot), once = bot.setControlState;
  for (let i = 0; i < 20; i++) { bot.emit('spawn'); telemetry.install(); }
  assert.equal(bot.setControlState, once);
  bot.setControlState('forward', true);
  assert.equal(calls, 1); assert.equal(telemetry.snapshot().issuedInputs, 1);
  telemetry.dispose();
});

test('a later plugin wrapper and control replacement remain counted once after reinstallation', () => {
  const bot: any = new EventEmitter(), controls: Record<string, boolean> = {};
  let calls = 0;
  bot.setControlState = (name: string, value: boolean) => { calls++; controls[name] = value; };
  bot.getControlState = (name: string) => controls[name] ?? false;
  const telemetry = trackInputs(bot), previous = bot.setControlState;
  bot.setControlState = function (this: any, name: string, value: boolean) { return previous.call(this, name, value); };
  bot.emit('spawn'); bot.setControlState('forward', true);
  assert.equal(calls, 1); assert.equal(telemetry.snapshot().issuedInputs, 1);
  const replacement = (name: string, value: boolean) => { calls++; controls[name] = value; };
  bot.setControlState = replacement;
  telemetry.install(); bot.setControlState('forward', false);
  assert.equal(calls, 2); assert.equal(telemetry.snapshot().issuedInputs, 2);
  telemetry.dispose(); assert.equal(bot.setControlState, replacement);
});

test('disposal before deferred plugin injection prevents later reattachment', async () => {
  const bot: any = new EventEmitter(), telemetry = trackInputs(bot);
  bot.emit('inject_allowed'); telemetry.dispose();
  const native = () => {}; bot.setControlState = native;
  await Promise.resolve(); bot.emit('spawn'); telemetry.install();
  assert.equal(bot.setControlState, native);
  assert.equal(bot.listenerCount('spawn'), 0); assert.equal(bot.listenerCount('inject_allowed'), 0);
});

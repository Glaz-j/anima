import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import registryFactory from 'prismarine-registry';
import protocol from 'minecraft-protocol';
import installPhysics from '../node_modules/mineflayer/lib/plugins/physics.js';
import { installSneakProtocolCompat } from '../adapters/minecraft/src/sneak-compat.ts';
import { trackInputs } from '../adapters/minecraft/src/input-telemetry.ts';

function fixture(t: any, version = '1.21.4', serialize = true) {
  const registry = registryFactory(version), writes: any[] = [], wire: any[] = [];
  const serializer = serialize ? protocol.createSerializer({ version, state: 'play', isServer: false }) : undefined;
  const parser = serialize ? protocol.createDeserializer({ version, state: 'play', isServer: true }) : undefined;
  const bot: any = Object.assign(new EventEmitter(), {
    version, registry, supportFeature: registry.supportFeature,
    entity: { id: 17, position: new Vec3(.5, 64, .5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0,
      eyeHeight: 1.62, onGround: true, effects: {}, attributes: {} },
    game: { gameMode: 'survival' }, inventory: { slots: [] }, blockAt: () => null,
    _client: Object.assign(new EventEmitter(), { state: 'play' }),
  });
  bot._client.write = (name: string, params: any) => {
    writes.push({ name, params });
    if (serializer && parser) wire.push(parser.parsePacketBuffer(serializer.createPacketBuffer({ name, params })).data);
  };
  // Install real controls without login: no connection or physics interval starts.
  installPhysics(bot, { physicsEnabled: false });
  t.after(() => { bot.emit('end'); serializer?.destroy(); parser?.destroy(); });
  return { bot, writes, wire };
}

test('1.21.4 sneak transitions send the required legacy action over the real serializer', t => {
  const f = fixture(t);
  assert.equal(f.bot.supportFeature('newPlayerInputPacket'), true);
  assert.equal(f.bot.supportFeature('sneakUsesEntityAction'), true);
  installSneakProtocolCompat(f.bot);
  f.bot.setControlState('sneak', true);
  f.bot.setControlState('sneak', false);
  assert.deepEqual(f.wire.filter(packet => packet.name === 'entity_action').map(packet => packet.params), [
    { entityId: 17, actionId: 'start_sneaking', jumpBoost: 0 },
    { entityId: 17, actionId: 'stop_sneaking', jumpBoost: 0 },
  ]);
  assert.deepEqual(f.wire.filter(packet => packet.name === 'player_input').map(packet => packet.params.inputs.shift), [true, false]);
});

test('compatibility is idempotent and native clearControlStates releases sneak exactly once', t => {
  const f = fixture(t), feature = f.bot.supportFeature;
  installSneakProtocolCompat(f.bot); const installed = f.bot.setControlState;
  for (let i = 0; i < 10; i++) installSneakProtocolCompat(f.bot);
  assert.equal(f.bot.setControlState, installed); assert.equal(f.bot.supportFeature, feature);
  f.bot.setControlState('sneak', true); f.bot.setControlState('sneak', true);
  assert.equal(f.bot.getControlState('sneak'), true);
  f.bot.clearControlStates(); f.bot.clearControlStates();
  assert.equal(f.bot.getControlState('sneak'), false);
  assert.deepEqual(f.wire.map(packet => packet.name), ['player_input', 'entity_action', 'player_input', 'entity_action']);
  assert.deepEqual(f.wire.filter(packet => packet.name === 'entity_action').map(packet => packet.params.actionId),
    ['start_sneaking', 'stop_sneaking']);
});

test('other controls retain their native packets and queued jump behavior', t => {
  const original = fixture(t), patched = fixture(t); installSneakProtocolCompat(patched.bot);
  for (const f of [original, patched]) {
    for (const control of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) f.bot.setControlState(control, true);
    assert.equal(f.bot.jumpQueued, true);
    f.bot.clearControlStates();
  }
  assert.deepEqual(patched.wire, original.wire);
  assert.deepEqual(patched.wire.map(packet => packet.params.actionId), ['start_sprinting', 'stop_sprinting']);
});

for (const version of ['1.21.2', '1.21.6']) {
  test(`compatibility leaves ${version} native controls and wire unchanged`, t => {
    // Installed minecraft-data has no exact 1.21.2 protocol (768 vs returned 767).
    // For that excluded version check native method identity and writes, not a substituted wire format.
    const f = fixture(t, version, version !== '1.21.2'), control = f.bot.setControlState;
    installSneakProtocolCompat(f.bot); assert.equal(f.bot.setControlState, control);
    f.bot.setControlState('sneak', true); f.bot.clearControlStates();
    if (version === '1.21.2') {
      assert.deepEqual(f.writes.map(packet => packet.name), ['entity_action', 'entity_action']);
      assert.deepEqual(f.writes.map(packet => packet.params.actionId), [0, 1]);
    } else {
      assert.deepEqual(f.wire.map(packet => packet.name), ['player_input', 'player_input']);
      assert.deepEqual(f.wire.map(packet => packet.params.inputs.shift), [true, false]);
    }
  });
}

for (const disabled of ['newPlayerInputPacket', 'sneakUsesEntityAction']) {
  test(`compatibility requires ${disabled} without changing the bot feature function`, t => {
    const f = fixture(t), nativeFeature = f.bot.supportFeature, control = f.bot.setControlState;
    f.bot.supportFeature = (feature: string) => feature === disabled ? false : nativeFeature(feature);
    const feature = f.bot.supportFeature;
    installSneakProtocolCompat(f.bot);
    assert.equal(f.bot.setControlState, control); assert.equal(f.bot.supportFeature, feature);
    assert.deepEqual(f.writes, []);
  });
}

test('compatibility respects mapped action names when the feature requests them', t => {
  const f = fixture(t), nativeFeature = f.bot.supportFeature;
  f.bot.supportFeature = (feature: string) => feature === 'entityActionUsesStringMapper' || nativeFeature(feature);
  installSneakProtocolCompat(f.bot);
  f.bot.setControlState('sneak', true); f.bot.setControlState('sneak', false);
  assert.deepEqual(f.writes.filter(packet => packet.name === 'entity_action').map(packet => packet.params.actionId),
    ['start_sneaking', 'stop_sneaking']);
  assert.deepEqual(f.wire.filter(packet => packet.name === 'entity_action').map(packet => packet.params.actionId),
    ['start_sneaking', 'stop_sneaking']);
});

test('original errors and failed supplemental writes propagate without extra control retries', t => {
  const f = fixture(t), originalError = new Error('original input failed');
  const original = f.bot.setControlState;
  f.bot.setControlState = (control: string, state: boolean) => {
    if (control === 'sneak' && state) throw originalError;
    return original(control, state);
  };
  installSneakProtocolCompat(f.bot);
  assert.throws(() => f.bot.setControlState('sneak', true), error => error === originalError);
  assert.equal(f.bot.getControlState('sneak'), false); assert.deepEqual(f.writes, []);

  const writeFailure = fixture(t), writeError = new Error('supplemental transport failed'), write = writeFailure.bot._client.write;
  installSneakProtocolCompat(writeFailure.bot);
  let attempts = 0;
  writeFailure.bot._client.write = (name: string, params: any) => {
    if (name === 'entity_action') { attempts++; throw writeError; }
    write(name, params);
  };
  assert.throws(() => writeFailure.bot.setControlState('sneak', true), error => error === writeError);
  assert.equal(attempts, 1); assert.equal(writeFailure.bot.getControlState('sneak'), true);
  assert.deepEqual(writeFailure.wire.map(packet => packet.name), ['player_input']);
});

test('a successful original call without a sneak change sends no supplemental packet and preserves its return', t => {
  const f = fixture(t), returned = {};
  f.bot.setControlState = () => returned;
  installSneakProtocolCompat(f.bot);
  assert.equal(f.bot.setControlState('sneak', true), returned);
  assert.deepEqual(f.writes, []); assert.equal(f.bot.getControlState('sneak'), false);
});

for (const order of ['telemetry first', 'compatibility first']) {
  test(`input telemetry and compatibility can stack without duplicate packets: ${order}`, t => {
    const f = fixture(t);
    if (order === 'compatibility first') installSneakProtocolCompat(f.bot);
    const telemetry = trackInputs(f.bot); t.after(() => telemetry.dispose());
    if (order === 'telemetry first') installSneakProtocolCompat(f.bot);
    for (let i = 0; i < 3; i++) { telemetry.install(); installSneakProtocolCompat(f.bot); f.bot.emit('spawn'); }
    f.bot.setControlState('sneak', true); f.bot.setControlState('sneak', true); f.bot.clearControlStates();
    assert.deepEqual(telemetry.snapshot().counts, { 'key:sneak': 2 });
    assert.deepEqual(f.wire.map(packet => packet.name), ['player_input', 'entity_action', 'player_input', 'entity_action']);
  });
}

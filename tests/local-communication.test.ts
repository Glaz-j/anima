import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mineflayer from 'mineflayer';
import registryFactory from 'prismarine-registry';
import installChat from '../node_modules/mineflayer/lib/plugins/chat.js';
import { Vec3 } from 'vec3';
import { MinecraftWorld } from '../adapters/minecraft/src/world.ts';
import { action } from '../adapters/minecraft/src/validation.ts';
import { BROADCAST_PREFIX, NPC_COMMUNICATION } from '../adapters/minecraft/src/communication.ts';
import { compactObservation } from '../packages/pi-runtime/src/world-agent.ts';

async function fixture(t: any, names = ['Listener']) {
  const sent: string[] = [], registry = registryFactory('1.21.4');
  const bots = new Map<string, any>();
  for (const [index, name] of names.entries()) {
    const bot: any = Object.assign(new EventEmitter(), {
    _client: new EventEmitter(), entity: { id: index + 1, position: new Vec3(0, 64, 0) },
    registry, supportFeature: registry.supportFeature,
    players: {}, entities: {}, inventory: { items: () => [], slots: [] },
    health: 20, food: 20, game: { dimension: 'overworld', gameMode: 'survival' },
    time: { timeOfDay: 1000, isDay: true }, blockAt: () => null, findBlocks: () => [],
    clearControlStates: () => {}, stopDigging: () => {}, quit: () => {},
    });
    bot._client.chat = (message: string) => sent.push(message);
    installChat(bot, {}); bots.set(name, bot);
  }
  t.mock.method(mineflayer, 'createBot', (options: any) => bots.get(options.username));
  const world = new MinecraftWorld({ host: '127.0.0.1', port: 25565, version: '1.21.4',
    logDirectory: await mkdtemp(join(tmpdir(), 'anima-chat-')) });
  for (const name of names) { world.add(name, 'test'); bots.get(name).emit('spawn'); }
  t.after(() => world.close());
  return { world, record: world.get(names[0]), bot: bots.get(names[0]), sent, bots };
}

function receive(bot: any, speaker: string, message: string) {
  // Actual installed chat plugin parses the server's native chat presentation
  // into a chat event. No test calls world.event or writes another bot's log.
  bot._client.emit('systemChat', { formattedMessage: JSON.stringify({ text: `<${speaker}> ${message}` }), positionId: 1 });
}

test('NPC hearing uses the advertised three-dimensional local range and actual loaded speakers', async t => {
  const { world, record, bot } = await fixture(t);
  const communication = world.observe('Listener').communication;
  assert.equal(communication.radius, 16);
  const hear = (speaker: string, position?: Vec3) => {
    if (position) bot.players[speaker] = { entity: { position } };
    bot.emit('chat', speaker, speaker);
  };
  hear('Boundary', new Vec3(16, 64, 0));
  hear('Far', new Vec3(16.001, 64, 0));
  hear('Above', new Vec3(0, 80, 0));
  hear('TooHigh', new Vec3(0, 80.001, 0));
  hear('Diagonal', new Vec3(12, 76, 0));
  hear('Unknown');
  hear('Listener', new Vec3(0, 64, 0));
  record.ready = false;
  hear('DisconnectedListener', new Vec3(1, 64, 0));
  assert.deepEqual(record.events.filter((e: any) => e.type === 'heard').map((e: any) => e.speaker), ['Boundary', 'Above']);
});

test('local range reaches the model and a successful say receipt does not claim delivery', async t => {
  const { world, record, sent } = await fixture(t);
  const raw = world.observe('Listener');
  const compact = compactObservation({ ...raw,
    inventory: Array.from({ length: 36 }, (_, i) => ({ name: `item_${i}`, count: 64 })),
    nearbyEntities: Array.from({ length: 40 }, (_, i) => ({ id: i, name: 'cow', type: 'cow', position: { x: i, y: 64, z: 0 } })) });
  assert.deepEqual(compact.communication, raw.communication);
  assert.ok(Buffer.byteLength(JSON.stringify(compact), 'utf8') <= 4400);
  const receipt = await world.execute('Listener', { type: 'say', message: '我这里有木料。' });
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.details.sent, true);
  assert.deepEqual(receipt.details.communication, compact.communication);
  assert.equal(receipt.details.deliveryConfirmed, false);
  assert.equal(receipt.details.channel, 'local');
  assert.deepEqual(sent, ['我这里有木料。']);
  assert.equal(record.events.filter((e: any) => e.type === 'heard').length, 0);
  assert.equal(compactObservation({}).communication, undefined, 'Other worlds do not inherit Minecraft hearing rules.');
});

test('broadcast schema is bounded ordinary text and say cannot impersonate its reserved channel', () => {
  assert.deepEqual(action({ type: 'broadcast', message: '  需要木镐，请报位置。  ' }), { type: 'broadcast', message: '需要木镐，请报位置。' });
  assert.equal(action({ type: 'broadcast', message: '字'.repeat(240) }).message.length, 240);
  assert.equal(action({ type: 'say', message: '字'.repeat(250) }).message.length, 250);
  for (const type of ['say', 'broadcast']) {
    for (const message of ['', ' ', '/give A dirt', ' /stop', 'hi\n/op A', 'x\rhi', 'a\u0000b', 'a\tstop', '§ahello',
      '[世界]', '[世界] ', '[世界]hello', ' [世界] hi', BROADCAST_PREFIX + 'hello']) {
      assert.throws(() => action({ type, message }), undefined, `${type} ${JSON.stringify(message)}`);
    }
  }
  assert.throws(() => action({ type: 'broadcast', message: '字'.repeat(241) }));
  assert.throws(() => action({ type: 'say', message: '字'.repeat(251) }));
});

test('broadcast sends one real prefixed chat and only actual receiver chat events produce heard', async t => {
  const { world, bots, sent } = await fixture(t, ['Sender', 'Far', 'OtherWorld', 'Unloaded']);
  const far = bots.get('Far'), other = bots.get('OtherWorld'), unloaded = bots.get('Unloaded');
  far.entity.position = new Vec3(2000, 64, 0);
  other.game.dimension = 'the_nether'; other.entity.position = new Vec3(-500, 40, 900);
  far.players.Sender = { entity: { position: new Vec3(0, 64, 0) } };
  // Neither other-dimensional nor unloaded listeners have a sender entity.
  const message = '我在石坑里，需要木镐。';
  const receipt = await world.execute('Sender', { type: 'broadcast', message });
  assert.deepEqual(sent, [BROADCAST_PREFIX + message]);
  assert.equal(receipt.status, 'completed'); assert.equal(receipt.details.sent, true);
  assert.equal(receipt.details.channel, 'broadcast'); assert.equal(receipt.details.deliveryConfirmed, false);
  assert.deepEqual(receipt.details.communication, NPC_COMMUNICATION);
  assert.deepEqual(world.observe('Far').communication.broadcast, { available: true, scope: 'server', action: 'broadcast' });
  for (const record of world.bots.values()) assert.equal(record.events.filter(e => e.type === 'heard').length, 0);
  receive(far, 'Sender', BROADCAST_PREFIX + message);
  assert.equal(world.get('OtherWorld').events.filter(e => e.type === 'heard').length, 0, 'One client event cannot inject into other clients.');
  receive(other, 'Sender', BROADCAST_PREFIX + message); receive(unloaded, 'Sender', BROADCAST_PREFIX + message);
  receive(bots.get('Sender'), 'Sender', BROADCAST_PREFIX + message);
  assert.equal(world.get('Sender').events.filter(e => e.type === 'heard').length, 0, 'Self echo is ignored.');
  for (const name of ['Far', 'OtherWorld', 'Unloaded']) {
    const heard = world.get(name).events.filter(e => e.type === 'heard'); assert.equal(heard.length, 1);
    const { id, npcId, time, type, ...payload } = heard[0];
    assert.deepEqual(payload, { speaker: 'Sender', channel: 'broadcast', message });
  }
  receive(far, 'Sender', '普通本地说话'); receive(unloaded, 'Sender', '普通本地说话');
  assert.equal(world.get('Far').events.filter(e => e.type === 'heard').length, 1);
  assert.equal(world.get('Unloaded').events.filter(e => e.type === 'heard').length, 1);
  await world.execute('Sender', { type: 'broadcast', message: '字'.repeat(240) });
  assert.equal(sent.length, 2, 'The maximum body plus prefix still fits one native chat packet.');
  assert.equal(sent[1], BROADCAST_PREFIX + '字'.repeat(240));
});

test('native human channel input rejects malformed or oversized bodies without creating fake hearing', async t => {
  const { world, bot, record } = await fixture(t);
  bot.players.Human = { entity: { position: new Vec3(1, 64, 0) } };
  for (const message of ['[世界]', '[世界] ', '[世界]   ', '[世界]missing-space', ' [世界] hi',
    BROADCAST_PREFIX + 'a'.repeat(241), BROADCAST_PREFIX + '/stop', BROADCAST_PREFIX + '[世界] nested',
    BROADCAST_PREFIX + 'hello\nworld']) {
    receive(bot, 'Human', message);
    assert.equal(record.events.filter(e => e.type === 'heard').length, 0, JSON.stringify(message));
  }
  // Prismarine ChatMessage removes NUL before emitting chat. If a plugin does
  // deliver a control character in the chat event itself, our boundary rejects it.
  bot.emit('chat', 'Human', BROADCAST_PREFIX + 'hello\u0000world');
  assert.equal(record.events.filter(e => e.type === 'heard').length, 0);
  record.ready = false; receive(bot, 'Human', BROADCAST_PREFIX + '稍后集合');
  assert.equal(record.events.filter(e => e.type === 'heard').length, 0);
  record.ready = true; receive(bot, 'Human', BROADCAST_PREFIX + '等我  两分钟。');
  const heard = record.events.filter(e => e.type === 'heard');
  assert.equal(heard.length, 1); assert.equal(heard[0].channel, 'broadcast');
  assert.equal(heard[0].message, '等我  两分钟。', 'Preserve the actual content after the one transport prefix.');
});

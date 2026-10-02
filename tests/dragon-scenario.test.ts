import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DragonScenario, DRAGON_ROSTER, prepareDragonServer } from '../adapters/minecraft/src/dragon-scenario.ts';

function score(key: string, value: number) {
  return `[12:34:56] [Server thread/INFO]: ${key} has ${value} [anima_lab]\n`;
}
async function fixture(t: TestContext) {
  const parent = resolve(tmpdir());
  const directory = await mkdtemp(join(parent, 'anima-dragon-test-'));
  const commands: string[] = [];
  const scenario = new DragonScenario(directory, command => { commands.push(command); });
  await scenario.restore(); scenario.start(); await scenario.persistence;
  t.after(async () => {
    await scenario.persistence;
    // Only the fresh directory owned by this test may be removed recursively.
    assert.equal(dirname(resolve(directory)), parent);
    assert.ok(resolve(directory).startsWith(join(parent, 'anima-dragon-test-')));
    await rm(directory, { recursive: true, force: true });
  });
  return { scenario, commands, directory };
}

test('victory requires all three facts: a previously living dragon, a participant advancement, and disappearance', async t => {
  for (const observed of [false, true]) for (const advancement of [false, true]) for (const absent of [false, true]) {
    const { scenario } = await fixture(t);
    scenario.console(score('dragon_hp', observed ? 20000 : 0));
    scenario.console(score('dragon_present', absent ? 0 : 1));
    scenario.console(score('victory_Sheldon', advancement ? 1 : 0));
    assert.equal(scenario.status().complete, observed && advancement && absent,
      JSON.stringify({ observed, advancement, absent }));
  }
});

test('disconnects and an unloaded or unseen dragon do not count as victory', async t => {
  const { scenario } = await fixture(t);
  scenario.console(score('dragon_hp', 20000) + score('dragon_present', 1));
  for (const actor of DRAGON_ROSTER) scenario.event(actor.name, { type: 'disconnected' });
  scenario.console(score('dragon_present', 0));
  assert.equal(scenario.status().complete, false);
  assert.deepEqual(scenario.status().victories, []);
});

test('player chat, unrelated loggers, and unknown player advancements cannot create completion evidence', async t => {
  const { scenario } = await fixture(t);
  // The parser must classify the source before treating a metric as authoritative.
  const metric = score('dragon_hp', 20000).replace(': dragon_hp', ': <Participant> dragon_hp');
  scenario.console(metric);
  scenario.console(score('dragon_hp', 20000).replace('Server thread/INFO', 'Worker thread/INFO'));
  assert.equal(scenario.status().observedDragon, false);
  scenario.console(score('dragon_hp', 20000) + score('dragon_present', 0));
  scenario.console(score('victory_NotInRoster', 1));
  assert.equal(scenario.status().complete, false);
  assert.deepEqual(scenario.status().victories, []);
});

test('console chunk boundaries preserve metrics without accepting a partial line', async t => {
  const { scenario } = await fixture(t);
  const line = score('dragon_hp', 12550);
  scenario.console(line.slice(0, 31));
  assert.equal(scenario.status().observedDragon, false);
  scenario.console(line.slice(31, -1));
  assert.equal(scenario.status().observedDragon, false);
  scenario.console('\n' + score('crystal_count', 6) + score('dragon_phase', 5));
  assert.equal(scenario.status().dragonHealth, 125.5);
  assert.equal(scenario.status().crystals, 6);
  assert.equal(scenario.status().dragonPhase, 5);
});

test('late metrics do not change an explicitly stopped experiment into a victory', async t => {
  const { scenario } = await fixture(t);
  scenario.console(score('dragon_hp', 20000));
  await scenario.stop();
  scenario.console(score('victory_Sheldon', 1) + score('dragon_present', 0));
  assert.equal(scenario.status().phase, 'stopped');
  assert.equal(scenario.status().complete, false);
});

test('administrator setup rejects direct damage, Health mutation, forced advancement, and multiline commands', async t => {
  const { scenario, commands } = await fixture(t);
  const forbidden = [
    'kill @e[type=minecraft:ender_dragon]',
    'execute in minecraft:the_end run damage @e[type=minecraft:ender_dragon,limit=1] 200',
    'data merge entity @e[type=minecraft:ender_dragon,limit=1] {Health:0f}',
    'data modify entity @e[type=minecraft:ender_dragon,limit=1] Health set value 0f',
    'advancement grant Sheldon only minecraft:end/kill_dragon',
    'time set day\nweather clear',
  ];
  for (const command of forbidden) assert.throws(() => scenario.command(command));
  assert.deepEqual(commands, []);
  scenario.setup(); scenario.provision('Sheldon', 0);
  await scenario.persistence;
  assert.ok(commands.some(command => command === 'gamemode survival Sheldon'));
  assert.ok(commands.some(command => command.startsWith('give Sheldon minecraft:bow')));
  assert.ok(commands.every(command => !/\b(?:kill|damage)\s|\bHealth\b|\badvancement\s+grant\b/iu.test(command)));
});

test('polling is read-only and never changes the dragon or grants success', async t => {
  const { scenario, commands } = await fixture(t);
  scenario.poll(); await scenario.persistence;
  assert.ok(commands.length > 0);
  assert.ok(commands.every(command => command.startsWith('execute ') || command.startsWith('scoreboard players get ')));
  assert.ok(commands.some(command => command.includes('data get entity') && command.includes(' Health 100')));
  assert.ok(commands.some(command => command.includes('advancements={minecraft:end/kill_dragon=true}')));
  assert.ok(commands.every(command => !/\brun (?:data (?:modify|merge|remove)|kill|damage|advancement grant)\b/iu.test(command)));
  await scenario.stop(); commands.length = 0; scenario.poll();
  assert.deepEqual(commands, []);
});

test('real action receipts and deaths persist separately from any claim of success', async t => {
  const { scenario, directory } = await fixture(t);
  scenario.event('Sheldon', { type: 'action', action: { type: 'shoot' }, status: 'completed' });
  scenario.event('Sheldon', { type: 'action', action: { type: 'attack' }, status: 'failed' });
  scenario.event('Sheldon', { type: 'action', action: { type: 'goto' }, status: 'completed' });
  scenario.event('Sheldon', { type: 'death' });
  scenario.event('Sheldon', { type: 'task-finished', reply: 'I won.', status: 'completed' });
  scenario.command('difficulty easy'); await scenario.persist();
  const saved = JSON.parse(await readFile(join(directory, 'run.json'), 'utf8'));
  assert.equal(saved.actions.Sheldon, 3);
  assert.equal(saved.attacks.Sheldon, 1);
  assert.equal(saved.deaths.Sheldon, 1);
  assert.equal(saved.phase, 'running');
  assert.deepEqual(saved.victories, []);
  const audit = (await readFile(join(directory, 'admin.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(audit[0].command, 'difficulty easy');
  const restored = new DragonScenario(directory, () => {}); await restored.restore();
  assert.equal(restored.status().runId, saved.runId);
  assert.equal(restored.status().actions.Sheldon, 3);
  assert.equal(restored.status().phase, 'preparing');
});

test('confirmed victory is saved and stays complete after a service restart', async t => {
  const { scenario, directory } = await fixture(t);
  scenario.console(score('dragon_hp', 8000) + score('victory_HuYifei', 1) + score('dragon_present', 0));
  await scenario.persistence;
  const saved = JSON.parse(await readFile(join(directory, 'run.json'), 'utf8'));
  assert.equal(saved.phase, 'victory'); assert.ok(saved.wonAt);
  const restored = new DragonScenario(directory, () => {}); await restored.restore();
  assert.equal(restored.status().runId, saved.runId);
  assert.equal(restored.status().complete, true);
  await restored.stop(); assert.equal(restored.status().complete, true);
});

test('the trial server gets a separate survival save and loopback-only configuration', async t => {
  const { directory } = await fixture(t);
  const server = join(directory, 'server');
  await prepareDragonServer(server, 25565);
  const settings = await readFile(join(server, 'server.properties'), 'utf8');
  for (const required of ['server-ip=127.0.0.1', 'gamemode=survival', 'difficulty=easy', 'level-name=world', 'enable-rcon=false', 'enable-command-block=false']) {
    assert.ok(settings.split('\n').includes(required));
  }
});

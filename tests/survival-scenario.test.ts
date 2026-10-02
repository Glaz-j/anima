import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { SurvivalScenario, SURVIVAL_ROSTER, SURVIVAL_OBJECTIVE, prepareSurvivalServer } from '../adapters/minecraft/src/survival-scenario.ts';

function score(key: string, value: number) { return `[12:34:56] [Server thread/INFO]: ${key} has ${value} [anima_survival]\n`; }
async function fixture(t: TestContext, verify = true) {
  const parent = resolve(tmpdir()), directory = await mkdtemp(join(parent, 'anima-survival-test-'));
  const commands: string[] = [];
  const scenario = new SurvivalScenario(directory, command => { commands.push(command); });
  await scenario.restore();
  if (verify) {
    for (const actor of SURVIVAL_ROSTER) scenario.observe(actor.name, { inventory: [], dimension: 'overworld', health: 20, food: 20 });
    scenario.start();
  }
  await scenario.persistence;
  t.after(async () => {
    await scenario.persistence;
    assert.equal(dirname(resolve(directory)), parent);
    assert.ok(resolve(directory).startsWith(join(parent, 'anima-survival-test-')));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, scenario, commands };
}

test('unconfirmed observed inventory proves neither an empty start nor a resource milestone', async t => {
  const { scenario } = await fixture(t, false);
  scenario.observe('Sheldon', { inventoryConfirmed: false, inventory: [] });
  assert.equal(scenario.status().progress.initialInventory.Sheldon, undefined);
  for (const actor of SURVIVAL_ROSTER) scenario.observe(actor.name, { inventory: [] });
  scenario.start();
  scenario.observe('Sheldon', { inventoryConfirmed: false, inventory: [{ name: 'diamond', count: 64 }] });
  assert.equal(scenario.status().progress.milestones.resources, undefined);
  assert.deepEqual(scenario.status().progress.actors.Sheldon.inventory, []);
});

test('normal survival server uses a blank random seed and keeps natural survival mechanics', async t => {
  const { directory, scenario } = await fixture(t);
  const server = join(directory, 'server');
  await prepareSurvivalServer(server, 25565, scenario.status().worldId);
  const lines = (await readFile(join(server, 'server.properties'), 'utf8')).split('\n');
  for (const required of ['level-seed=', 'level-type=minecraft:normal', 'gamemode=survival', 'force-gamemode=true', 'difficulty=easy', 'generate-structures=true', 'spawn-monsters=true', 'spawn-animals=true', 'allow-nether=true', 'server-ip=127.0.0.1']) assert.ok(lines.includes(required));
  const marker = JSON.parse(await readFile(join(server, 'anima-survival-server.json'), 'utf8'));
  assert.equal(marker.worldId, scenario.status().worldId);
  assert.equal(scenario.status().rules.keepInventory, false);
  assert.equal(scenario.status().rules.hunger, true);
  assert.equal(scenario.status().rules.deathDrops, true);
});

test('setup only restores ordinary rules and never supplies resources or removes survival costs', async t => {
  const { scenario, commands } = await fixture(t);
  scenario.setup(); await scenario.persistence;
  for (const required of ['gamerule keepInventory false', 'gamerule doMobSpawning true', 'gamerule doDaylightCycle true', 'gamerule doWeatherCycle true', 'gamerule fallDamage true', 'gamerule spawnRadius 4']) assert.ok(commands.includes(required));
  assert.ok(commands.every(command => /^(?:difficulty easy|gamerule [A-Za-z]+ (?:true|false|4)|scoreboard objectives add anima_survival dummy)$/u.test(command)));
  assert.equal(scenario.status().rules.suppliedEquipment, false);
  assert.equal(scenario.status().rules.suppliedEffects, false);
});

test('administrator entry point refuses every shortcut, nested shortcut, and nonallowlisted command', async t => {
  const { scenario, commands } = await fixture(t);
  for (const command of [
    'give Sheldon diamond 64', 'tp Sheldon 0 80 0', 'teleport Sheldon 0 80 0',
    'execute in minecraft:the_end run tp Sheldon 0 72 0',
    'kill @e[type=minecraft:ender_dragon]', 'damage Sheldon 2',
    'locate structure minecraft:stronghold', 'locate biome minecraft:plains',
    'effect give Sheldon minecraft:resistance infinite 1', 'gamemode creative Sheldon',
    'data merge entity @e[type=minecraft:ender_dragon,limit=1] {Health:0f}',
    'advancement grant Sheldon only minecraft:end/kill_dragon',
    'time set day', 'weather clear', 'gamerule doMobSpawning false',
    'gamerule keepInventory true', 'gamerule doDaylightCycle false',
    'fill 0 0 0 1 1 1 minecraft:air', 'setblock 0 70 0 minecraft:end_portal',
    'difficulty peaceful', 'difficulty easy\ngive Sheldon stone',
  ]) assert.throws(() => scenario.command(command), /forbidden/u);
  assert.deepEqual(commands, []);
});

test('fresh runs require real empty inventory observations for all four NPCs', async t => {
  const { scenario } = await fixture(t, false);
  assert.throws(() => scenario.start(), /empty inventories/u);
  scenario.observe('Sheldon', { health: 20 });
  assert.equal(scenario.status().progress.initialInventory.Sheldon, undefined);
  for (const actor of SURVIVAL_ROSTER.slice(0, 3)) scenario.observe(actor.name, { inventory: [] });
  assert.equal(scenario.status().progress.initialEmptyVerified, false);
  assert.throws(() => scenario.start(), /empty inventories/u);
  scenario.observe(SURVIVAL_ROSTER[3].name, { inventory: [] });
  scenario.start(); await scenario.persistence;
  assert.equal(scenario.status().progress.initialEmptyVerified, true);
  assert.equal(scenario.status().phase, 'running');
});

test('a nonempty first inventory cannot later be relabeled as an empty-handed start', async t => {
  const { scenario } = await fixture(t, false);
  for (const actor of SURVIVAL_ROSTER) scenario.observe(actor.name, { inventory: actor.name === 'Sheldon' ? [{ name: 'diamond_sword', count: 1 }] : [] });
  scenario.observe('Sheldon', { inventory: [] });
  assert.equal(scenario.status().progress.initialInventory.Sheldon.empty, false);
  assert.equal(scenario.status().progress.initialInventory.Sheldon.itemCount, 1);
  assert.throws(() => scenario.start(), /empty inventories/u);
});

test('armor outside the main inventory still disqualifies an allegedly empty-handed spawn', async t => {
  const { scenario } = await fixture(t, false);
  for (const actor of SURVIVAL_ROSTER) scenario.observe(actor.name, {
    inventory: [], fullInventory: actor.name === 'Sheldon' ? [{ name: 'netherite_helmet', count: 1 }] : [],
  });
  assert.equal(scenario.status().progress.initialInventory.Sheldon.source, 'fullInventory');
  assert.equal(scenario.status().progress.initialInventory.Sheldon.empty, false);
  assert.equal(scenario.status().progress.initialEmptyVerified, false);
  assert.throws(() => scenario.start(), /empty inventories/u);
});

test('milestones report evidence without directing tactics or replacing the full objective', async t => {
  const { scenario, commands } = await fixture(t);
  scenario.observe('Sheldon', { inventory: [{ name: 'oak_log', count: 4 }], dimension: 'overworld' });
  assert.equal(scenario.status().progress.stage, 'resources');
  scenario.console(score('smelting_Sherlock', 1));
  assert.equal(scenario.status().progress.stage, 'smelting');
  scenario.observe('Deadpool', { inventory: [], dimension: 'minecraft:the_nether' });
  assert.equal(scenario.status().progress.stage, 'nether');
  scenario.observe('HuYifei', { inventory: [], dimension: 'minecraft:the_end' });
  assert.equal(scenario.status().progress.stage, 'end');
  assert.equal(scenario.publicContext().objective, SURVIVAL_OBJECTIVE);
  assert.equal(scenario.status().complete, false);
  assert.deepEqual(commands, [], 'Observed milestones never execute a plan or change the world.');
  assert.equal('progress' in scenario.publicContext(), false, 'NPC context must not disclose another actor’s private observations.');
});

test('before a naturally observed End visit, polling never queries a dragon or locates a route', async t => {
  const { scenario, commands } = await fixture(t);
  scenario.poll(); await scenario.persistence;
  assert.ok(commands.length > 0);
  assert.ok(commands.every(command => !command.includes('execute in minecraft:the_end')));
  assert.ok(commands.every(command => !/\b(?:locate|give|tp|teleport|kill|damage|effect|fill|setblock)\s/iu.test(command)));
  assert.ok(commands.some(command => command.includes('advancements={minecraft:story/enter_the_nether=true}')));
  commands.length = 0;
  scenario.observe('Sheldon', { inventory: [], dimension: 'the_end' });
  scenario.poll(); await scenario.persistence;
  assert.ok(commands.some(command => command.includes('data get entity') && command.includes(' Health 100')));
  assert.ok(commands.every(command => !/\b(?:data (?:modify|merge|remove)|advancement grant)\b/iu.test(command)));
});

test('natural victory still requires advancement, a once-living dragon, and disappearance', async t => {
  for (const observed of [false, true]) for (const advancement of [false, true]) for (const absent of [false, true]) {
    const { scenario } = await fixture(t);
    scenario.observe('Sheldon', { inventory: [], dimension: 'the_end' });
    scenario.console(score('dragon_hp', observed ? 20000 : 0) + score('victory_Sheldon', advancement ? 1 : 0) + score('dragon_present', absent ? 0 : 1));
    assert.equal(scenario.status().complete, observed && advancement && absent);
  }
});

test('claims, disconnects, missing dragons, chat-shaped logs, and old-trial metrics cannot win', async t => {
  const { scenario } = await fixture(t);
  scenario.event('Sheldon', { type: 'task-finished', reply: 'We defeated the dragon.' });
  scenario.event('Sheldon', { type: 'disconnected' });
  scenario.console(score('dragon_hp', 20000).replace(': dragon_hp', ': <Player> dragon_hp'));
  scenario.console(score('dragon_hp', 20000).replace('[anima_survival]', '[anima_lab]'));
  scenario.console(score('dragon_present', 0) + score('victory_NotInRoster', 1));
  assert.equal(scenario.status().observedDragon, false);
  assert.equal(scenario.status().complete, false);
  assert.deepEqual(scenario.status().victories, []);
  await scenario.stop();
  scenario.console(score('dragon_hp', 20000) + score('victory_Sheldon', 1));
  assert.equal(scenario.status().phase, 'stopped');
});

test('new worlds are isolated and an existing old-trial directory is never overwritten', async t => {
  const first = await fixture(t), second = await fixture(t);
  assert.notEqual(first.scenario.status().runId, second.scenario.status().runId);
  assert.notEqual(first.scenario.status().worldId, second.scenario.status().worldId);
  const oldDirectory = join(first.directory, 'old-server'); await mkdir(oldDirectory);
  const oldSettings = 'level-seed=8675309\ngamemode=creative\n';
  await writeFile(join(oldDirectory, 'server.properties'), oldSettings);
  await assert.rejects(prepareSurvivalServer(oldDirectory, 25565), /existing world/u);
  assert.equal(await readFile(join(oldDirectory, 'server.properties'), 'utf8'), oldSettings);
  const oldRunDirectory = join(first.directory, 'old-run'); await mkdir(oldRunDirectory);
  const oldRun = JSON.stringify({ runId: 'old-dragon', phase: 'victory', rules: {} });
  await writeFile(join(oldRunDirectory, 'run.json'), oldRun);
  await assert.rejects(new SurvivalScenario(oldRunDirectory, () => {}).restore(), /not a from-scratch/u);
  assert.equal(await readFile(join(oldRunDirectory, 'run.json'), 'utf8'), oldRun);
});

test('run identity, initial evidence, progress, actions and death records survive restart', async t => {
  const { scenario, directory } = await fixture(t);
  scenario.observe('Sheldon', { inventory: [{ name: 'oak_log', count: 3 }], dimension: 'overworld', health: 17, food: 12 });
  scenario.event('Sheldon', { type: 'action', action: { type: 'dig' }, status: 'completed' });
  scenario.event('Deadpool', { type: 'death' });
  scenario.setup(); await scenario.persist();
  const before = scenario.status();
  const resumed = new SurvivalScenario(directory, () => {}); await resumed.restore();
  const after = resumed.status();
  assert.equal(after.worldId, before.worldId); assert.equal(after.runId, before.runId);
  assert.equal(after.phase, 'preparing'); assert.equal(after.progress.stage, 'resources');
  assert.equal(after.progress.initialEmptyVerified, true);
  assert.equal(after.progress.actors.Sheldon.food, 12);
  assert.equal(after.actions.Sheldon, 1); assert.equal(after.deaths.Deadpool, 1);
  resumed.start(); await resumed.persistence;
  assert.equal(resumed.status().phase, 'running');
  assert.ok((await readFile(join(directory, 'admin.jsonl'), 'utf8')).includes('gamerule keepInventory false'));
});

test('the confirmed complete outcome survives restart and public snapshots cannot mutate it', async t => {
  const { scenario, directory } = await fixture(t);
  scenario.observe('Sheldon', { inventory: [], dimension: 'the_end' });
  scenario.console(score('dragon_hp', 15000) + score('victory_Sheldon', 1) + score('dragon_present', 0));
  await scenario.persistence;
  const status = scenario.status(); status.progress.stage = 'starting'; status.victories.length = 0;
  assert.equal(scenario.status().progress.stage, 'victory');
  assert.equal(scenario.status().victories.length, 1);
  const resumed = new SurvivalScenario(directory, () => {}); await resumed.restore();
  assert.equal(resumed.status().complete, true);
  assert.ok(resumed.status().wonAt);
});

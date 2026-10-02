import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { PlayClient, type PlayClientMode } from '../adapters/minecraft/src/play-client.ts';

async function fixture(t: any, mode: PlayClientMode = 'native') {
  const prefix = join(tmpdir(), 'anima-play-test-'), root = await mkdtemp(prefix);
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(prefix))); await rm(root, { recursive: true, force: true }); });
  const runtimeDirectory = join(root, 'var/minecraft');
  const launcherDirectory = join(runtimeDirectory, 'launcher');
  const gameDirectory = join(launcherDirectory, 'instances/Anima-Local-1.21.4');
  const versionDirectory = join(gameDirectory, 'versions/Anima-Local-1.21.4');
  const clientDirectory = join(runtimeDirectory, 'client');
  const java = join(runtimeDirectory, 'java/bin/java.exe'), jar = join(launcherDirectory, 'HMCL-3.16.3.jar');
  const natives = join(clientDirectory, 'natives'), assets = join(clientDirectory, 'assets');
  const libraries = [join(clientDirectory, 'libraries/fixture.jar'), join(clientDirectory, 'client.jar')];
  for (const dir of [versionDirectory, join(runtimeDirectory, 'java/bin'), natives, join(assets, 'indexes'), join(clientDirectory, 'libraries')]) await mkdir(dir, { recursive: true });
  for (const file of [java, jar, join(versionDirectory, 'Anima-Local-1.21.4.jar'), ...libraries, join(assets, 'indexes/19.json')]) await writeFile(file, 'fixture');
  const launcher = { java, jar, directory: launcherDirectory, instance: 'Anima-Local-1.21.4', mode: 'normal', demo: false };
  const runtime = { version: '1.21.4', java, client: { classpath: libraries.join(delimiter), natives, assets, assetIndex: '19', mainClass: 'net.minecraft.client.main.Main' } };
  const metadataPath = join(versionDirectory, 'Anima-Local-1.21.4.json');
  await writeFile(metadataPath, JSON.stringify({ id: launcher.instance, mainClass: runtime.client.mainClass, arguments: { game: ['--quickPlayMultiplayer', '127.0.0.1:25565'] } }));
  await writeFile(join(runtimeDirectory, 'runtime.json'), JSON.stringify(runtime));
  await writeFile(join(runtimeDirectory, 'launcher.json'), JSON.stringify(launcher));
  // Deliberately absent accounts.json: launching must not need to read credentials.
  const calls: any[] = [], processes: any[] = [];
  let child: any;
  const dependencies = {
    platform: 'win32' as const,
    listProcesses: async () => processes,
    spawn: (file: string, args: string[], options: any) => {
      calls.push({ file, args, options });
      child = new EventEmitter() as any;
      Object.assign(child, { pid: 23456, exitCode: null, signalCode: null, unref: () => {} });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  };
  return { root, runtimeDirectory, gameDirectory, java, jar, calls, processes, dependencies, runtime, launcher, metadataPath,
    client: new PlayClient({ root, mode }, dependencies), getChild: () => child };
}

test('status prepares nothing and launches nothing; native launch has fixed local arguments and shell:false', async t => {
  const f = await fixture(t);
  assert.equal((await f.client.status()).state, 'ready');
  assert.equal(f.calls.length, 0);
  assert.ok(!(await readdir(f.runtimeDirectory)).includes('play-client.log'));
  const result = await f.client.launch();
  assert.equal(result.state, 'starting');
  assert.equal(result.started, true);
  assert.equal(result.connection, 'unverified');
  const call = f.calls[0];
  assert.equal(call.file, f.java);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.detached, true);
  assert.equal(call.options.cwd, f.gameDirectory);
  const value = (flag: string) => call.args[call.args.indexOf(flag) + 1];
  assert.equal(value('--gameDir'), f.gameDirectory);
  assert.equal(value('--username'), 'AnimaObserver');
  // Independently recompute launcher.py's RFC 4122 UUIDv5(DNS, 'anima-' + player).
  const hash = createHash('sha1').update(Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex')).update('anima-' + value('--username')).digest().subarray(0, 16);
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  assert.equal(value('--uuid'), hash.toString('hex'));
  assert.match(await readFile(new URL('../scripts/minecraft/launcher.py', import.meta.url), 'utf8'), /uuid\.uuid5\(uuid\.NAMESPACE_DNS, 'anima-' \+ player\)/u);
  assert.equal(value('--quickPlayMultiplayer'), '127.0.0.1:25565');
  assert.ok(!call.args.includes('--demo'));
  assert.equal(JSON.stringify(result).includes('accessToken'), false);
  assert.match(await readFile(result.logPath!, 'utf8'), /requested native Anima-Local-1.21.4/u);
  assert.equal((await f.client.status()).state, 'starting');
});

test('concurrent button clicks across controllers create only one window and subsequent clicks deduplicate', async t => {
  const f = await fixture(t), other = new PlayClient({ root: f.root, mode: 'native' }, f.dependencies);
  const results = await Promise.all([f.client.launch(), f.client.launch(), other.launch()]);
  assert.equal(f.calls.length, 1);
  assert.equal(results.filter(row => row.started).length, 1);
  assert.equal(results.filter(row => row.alreadyRunning).length, 2);
  assert.equal((await f.client.launch()).alreadyRunning, true);
  assert.equal(f.calls.length, 1);
});

test('existing external client takes precedence over launcher; no duplicate and no false connection claim', async t => {
  const f = await fixture(t);
  f.processes.push({ pid: 88, kind: 'launcher' }, { pid: 99, kind: 'client' });
  const result = await f.client.launch();
  assert.equal(result.state, 'client-running');
  assert.equal(result.pid, 99);
  assert.equal(result.alreadyRunning, true);
  assert.equal(result.started, false);
  assert.equal(result.connection, 'unverified');
  assert.equal(f.calls.length, 0);
});

test('existing HMCL avoids a second window and explicitly requires its launch click', async t => {
  const f = await fixture(t);
  f.processes.push({ pid: 88, kind: 'launcher' });
  const result = await f.client.launch();
  assert.equal(result.state, 'launcher-open');
  assert.match(result.message, /其中启动/u);
  assert.equal(f.calls.length, 0);
});

test('HMCL fallback uses its existing isolated directory with no invented CLI launch flags', async t => {
  const f = await fixture(t, 'hmcl');
  const result = await f.client.launch();
  assert.equal(result.started, true);
  assert.match(result.message, /其中点击启动/u);
  assert.deepEqual(f.calls[0].args, ['-jar', f.jar]);
  assert.equal(f.calls[0].options.cwd, f.launcher.directory);
});

test('process inventory failure is closed: do not launch blindly or expose command-line errors', async t => {
  const f = await fixture(t);
  const client = new PlayClient({ root: f.root, mode: 'native' }, { ...f.dependencies,
    listProcesses: async () => { throw new Error('sensitive process command --accessToken secret'); } });
  const result = await client.launch();
  assert.equal(result.state, 'unavailable');
  assert.equal(result.started, false);
  assert.equal(f.calls.length, 0);
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('missing resources and version mismatch stay unavailable without installation or account edits', async t => {
  const f = await fixture(t);
  const wrongVersion = new PlayClient({ root: f.root, version: '1.20.1', mode: 'native' }, f.dependencies);
  assert.equal((await wrongVersion.launch()).state, 'unavailable');
  await rm(f.java);
  assert.equal((await f.client.launch()).state, 'unavailable');
  assert.equal(f.calls.length, 0);
  assert.equal(await readFile(join(f.runtimeDirectory, 'launcher.json'), 'utf8'), JSON.stringify(f.launcher));
});

test('constructor rejects remote host and injected version/port; config cannot point outside the runtime', async t => {
  const f = await fixture(t);
  assert.throws(() => new PlayClient({ root: f.root, host: 'evil.invalid' }));
  assert.throws(() => new PlayClient({ root: f.root, version: '../escape' }));
  assert.throws(() => new PlayClient({ root: f.root, port: 25565.1 }));
  assert.throws(() => new PlayClient({ root: f.root, host: '127.0.0.1;calc' }));
  f.runtime.java = join(f.root, 'outside/java.exe');
  await writeFile(join(f.runtimeDirectory, 'runtime.json'), JSON.stringify(f.runtime));
  assert.equal((await f.client.launch()).state, 'unavailable');
  assert.equal(f.calls.length, 0);
});

test('native configured server port is passed as one argument; HMCL mismatch never mutates its metadata', async t => {
  const f = await fixture(t);
  const original = await readFile(f.metadataPath, 'utf8');
  const fallback = new PlayClient({ root: f.root, port: 25570, mode: 'hmcl' }, f.dependencies);
  assert.equal((await fallback.launch()).state, 'unavailable');
  const native = new PlayClient({ root: f.root, port: 25570, mode: 'native' }, f.dependencies);
  assert.equal((await native.launch()).started, true);
  assert.equal(f.calls[0].args.at(-1), '127.0.0.1:25570');
  assert.equal(await readFile(f.metadataPath, 'utf8'), original);
});

test('spawn error and native early exit are visible as failures without leaking raw errors', async t => {
  const f = await fixture(t);
  const bad = new PlayClient({ root: f.root, mode: 'native' }, { ...f.dependencies, spawn: () => {
    const child = new EventEmitter() as any;
    queueMicrotask(() => child.emit('error', new Error('private details')));
    return child;
  } });
  const failure = await bad.launch();
  assert.equal(failure.state, 'failed');
  assert.equal(failure.available, true, 'a failed launch can be retried after resources/processes are checked again');
  assert.equal(failure.started, false);
  assert.ok(!JSON.stringify(failure).includes('private details'));
  await f.client.launch();
  assert.equal((await f.client.status()).state, 'starting');
  const child = f.getChild();
  child.exitCode = 1;
  child.emit('exit', 1, null);
  assert.equal((await f.client.status()).state, 'failed');
});

test('status merges parallel reads and caches CIM for 10 seconds while returning independent values', async t => {
  const f = await fixture(t);
  let now = 1000, queries = 0;
  const client = new PlayClient({ root: f.root, mode: 'native' }, { ...f.dependencies, now: () => now,
    listProcesses: async () => { queries++; return f.processes; } });
  const statuses = await Promise.all([client.status(), client.status(), client.status()]);
  assert.equal(queries, 1);
  statuses[0].state = 'failed';
  now += 2500;
  assert.equal((await client.status()).state, 'ready');
  now = 10999;
  assert.equal((await client.status()).state, 'ready');
  assert.equal(queries, 1);
  f.processes.push({ pid: 99, kind: 'client' });
  now = 11000;
  assert.equal((await client.status()).state, 'client-running');
  assert.equal(queries, 2);
  assert.equal(f.calls.length, 0);
});

test('status caches resource validation too, but launch rechecks changed files immediately', async t => {
  const f = await fixture(t);
  assert.equal((await f.client.status()).state, 'ready');
  await rm(f.java);
  assert.equal((await f.client.status()).state, 'ready', 'polling result remains cached briefly');
  assert.equal((await f.client.launch()).state, 'unavailable', 'click must not rely on stale resource availability');
  assert.equal(f.calls.length, 0);
});

test('launch bypasses cached ready and cached running to detect external client starts and exits', async t => {
  const f = await fixture(t);
  let queries = 0;
  const client = new PlayClient({ root: f.root, mode: 'native' }, { ...f.dependencies,
    listProcesses: async () => { queries++; return f.processes; } });
  assert.equal((await client.status()).state, 'ready');
  f.processes.push({ pid: 99, kind: 'client' });
  assert.equal((await client.launch()).alreadyRunning, true);
  assert.equal(queries, 2);
  assert.equal(f.calls.length, 0);
  assert.equal((await client.status()).state, 'client-running');
  f.processes.length = 0;
  assert.equal((await client.launch()).started, true);
  assert.equal(f.calls.length, 1);
  assert.equal((await client.status()).state, 'starting');
});

test('old in-flight status cannot overwrite the state after an explicit launch', async t => {
  const f = await fixture(t);
  let unblock!: () => void, queries = 0;
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const waiting = new Promise<void>(resolve => { unblock = resolve; });
  const client = new PlayClient({ root: f.root, mode: 'native' }, { ...f.dependencies, listProcesses: async () => {
    queries++;
    if (queries === 1) { began(); await waiting; return [{ pid: 1, kind: 'launcher' }]; }
    return [];
  } });
  const oldStatus = client.status();
  await started;
  assert.equal((await client.launch()).started, true);
  unblock();
  assert.equal((await oldStatus).state, 'launcher-open');
  assert.equal((await client.status()).state, 'starting');
  assert.equal(queries, 3);
});

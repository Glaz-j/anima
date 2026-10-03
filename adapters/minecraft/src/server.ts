import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { MinecraftWorld } from './world.ts';
import { runTask } from './llm.ts';
import { ApiError, text, botName, allowedOrigin } from './validation.ts';
import { DragonScenario, DRAGON_ROSTER, prepareDragonServer } from './dragon-scenario.ts';
import { SurvivalScenario, SURVIVAL_ROSTER, prepareSurvivalServer } from './survival-scenario.ts';
import { survivalActorsReady, captureInitialSurvivalState } from './survival-readiness.ts';
import { NpcScheduler } from '../../../packages/bridge/src/npc-scheduler.ts';
import { startViewerService } from './viewer.ts';
import { PlayClient } from './play-client.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const runtimeDirectory = join(root, 'var/minecraft');
const publicDirectory = join(root, 'adapters/minecraft/public');
const port = Number(process.env.ANIMA_MC_API_PORT || 18791);
const token = process.env.ANIMA_MC_API_TOKEN || randomBytes(32).toString('hex');
let child: ChildProcess | undefined;
let closing = false;
let initialized = false;
let monitor: ReturnType<typeof setInterval> | undefined;
if (process.argv.includes('--dragon') && process.argv.includes('--survival')) throw new Error('只能同时选择一个世界模式。');
const scenarioName = process.argv.includes('--survival') ? 'survival' : process.argv.includes('--dragon') ? 'dragon-easy' : process.env.ANIMA_MC_SCENARIO || 'survival';
if (!['survival', 'dragon-easy', 'sandbox'].includes(scenarioName)) throw new Error('未知的 Minecraft 世界模式。');
const dragonEnabled = scenarioName === 'dragon-easy', survivalEnabled = scenarioName === 'survival';
const runtime = JSON.parse(await readFile(join(runtimeDirectory, 'runtime.json'), 'utf8').catch(() => { throw new Error('请先运行 npm run minecraft:setup。'); }));
const host = process.env.ANIMA_MC_HOST || '127.0.0.1';
if (!['127.0.0.1', 'localhost'].includes(host)) throw new Error('第一版只支持本机 Minecraft 服务器。');
const gamePort = Number(process.env.ANIMA_MC_PORT || 25565);
const world = new MinecraftWorld({ host, port: gamePort, version: process.env.ANIMA_MC_VERSION || runtime.version, logDirectory: join(runtimeDirectory, 'events'),
  dualLoop: process.env.ANIMA_MC_DUAL_LOOP !== 'false' });
const playClient = new PlayClient({ root, host, port: gamePort, version: world.version, mode: 'native' });
let viewer: Awaited<ReturnType<typeof startViewerService>> | undefined;
let viewerError = '';
const playerConnected = () => [...world.bots.values()].some(record => record.ready && Boolean(record.bot.players?.AnimaObserver));
const playStatus = async () => ({ ...await playClient.status(), connected: playerConnected() });
const botSummary = (record: any) => ({ ...world.summary(record), viewer: viewer?.urlFor(record.name) });
const sendConsole = (command: string) => {
  if (!child?.stdin?.writable || child.exitCode !== null) throw new Error('试炼要求 Anima 自己管理 Minecraft 进程。');
  child.stdin.write(command + '\n');
};
const dragon = dragonEnabled ? new DragonScenario(join(runtimeDirectory, 'dragon-lab'), sendConsole) : undefined;
const survival = survivalEnabled ? new SurvivalScenario(join(runtimeDirectory, 'survival-lab'), sendConsole) : undefined;
const scenario = survival || dragon;
const objective = survival ? '四人从随机主世界空手开始，通力协作准备生存资源，探索前往末地，最终击败末影龙。击败末影龙可以帮助大家逃出这个世界。根据当前处境自主安排工作、沟通和调整计划。' : '四人共同协作，击败末影龙可以帮助大家逃出这个世界。';
const scheduler = scenario ? new NpcScheduler({
  getActors: () => [...world.bots.values()].map(r => ({ name: r.name, ready: r.ready && !r.operatorStopped, busy: Boolean(r.task || (!r.body && r.actionController)) })),
  run: (name, instruction, signal) => runTask(world, name, instruction, root, { signal, worldId: world.memoryNamespace }),
  cancel: name => world.stop(world.get(name)),
  cancelTurn: name => { const record = world.get(name); record.task?.controller.abort(); if (!record.body) record.actionController?.abort(); },
  scenarioStatus: () => ({ complete: scenario.status().complete, summary: objective }),
  objective,
  intervalMs: 10000, taskTimeoutMs: 100000,
  onError: (error, name) => console.error(`NPC ${name || 'scheduler'}: ${String(error)}`),
  onComplete: () => { world.endAutonomy(); console.log(`${scenarioName}: authoritative victory verified.`); },
}) : undefined;
const provisioned = new Set<string>(), respawning = new Set<string>();
(world as any).scenarioContext = () => scenario?.publicContext();
world.onEvent = (record, event) => {
  scenario?.event(record.name, event);
  if (event.type === 'death') respawning.add(record.name);
  scheduler?.wake(record.name, event);
};
world.onSpawn = record => {
  if (dragon && (!provisioned.has(record.name) || respawning.has(record.name))) {
    const index = DRAGON_ROSTER.findIndex(actor => actor.name === record.name);
    if (index < 0) return;
    const respawn = provisioned.has(record.name);
    provisioned.add(record.name); respawning.delete(record.name);
    // Mark before teleport: changing dimension also emits spawn.
    setTimeout(() => { if (!closing && record.ready) dragon.provision(record.name, index, respawn); }, 600);
  } else if (!scenario && child) {
    child.stdin?.write(`give ${record.name} minecraft:cobblestone 64\ngive ${record.name} minecraft:iron_pickaxe 1\n`);
  }
};

function observeSurvival() {
  if (!survival) return;
  for (const record of world.bots.values()) {
    if (!record.ready) continue;
    const observation = world.observe(record.name);
    const fullInventory = record.bot.inventory.slots.filter(Boolean).map((item: any) => ({ name: item.name, count: item.count }));
    survival.observe(record.name, { ...observation, fullInventory });
  }
}

function listening(host: string, port: number) {
  return new Promise<boolean>(resolve => {
    const socket = createConnection({ host, port });
    const done = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.setTimeout(700); socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.once('timeout', () => done(false));
  });
}

function authorized(request: any) {
  const provided = Buffer.from(String(request.headers.authorization || '').replace(/^Bearer /u, ''));
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

async function body(request: any) {
  if (!String(request.headers['content-type'] || '').startsWith('application/json')) throw new ApiError(415, '请使用 application/json。');
  let data = '';
  for await (const chunk of request) { data += chunk; if (Buffer.byteLength(data) > 16000) throw new ApiError(413, '请求体过大。'); }
  try { return JSON.parse(data); } catch { throw new ApiError(400, '无效 JSON。'); }
}

const server = createServer(async (request, response) => {
  const send = (status: number, data: any) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(data)); };
  try {
    const requestHost = request.headers.host;
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(requestHost || '')) throw new ApiError(403, '无效 Host。');
    if (!allowedOrigin(request.headers.origin, port)) throw new ApiError(403, '只允许本机同源请求。');
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
    if (request.method === 'GET' && url.pathname === '/api/health') return send(200, { service: 'anima-minecraft', version: runtime.version, game: `${host}:${gamePort}`, scenario: scenarioName, initialized, readyBots: [...world.bots.values()].filter(b => b.ready).length });
    if (request.method === 'GET' && url.pathname === '/api/session') return send(200, { token });
    if (url.pathname.startsWith('/api/')) {
      if (!authorized(request)) throw new ApiError(401, '缺少有效 Bearer token。');
      if (request.method === 'GET' && url.pathname === '/api/experience') return send(200, {
        version: world.version, serverAddress: `${host}:${gamePort}`,
        viewer: { url: viewer?.url, error: viewerError || undefined }, play: await playStatus(),
      });
      if (request.method === 'POST' && url.pathname === '/api/play/launch') {
        await body(request);
        if (!initialized || closing) throw new ApiError(409, '世界正在启动或保存，请稍后进入。');
        const result = await playClient.launch();
        return send(result.available ? 200 : 503, { ...result, connected: playerConnected(), ...(result.available ? {} : { error: result.message }) });
      }
      if (request.method === 'GET' && url.pathname === '/api/experiment') return send(200, { scenario: scenario?.status(), scheduler: scheduler?.status() });
      if (request.method === 'POST' && url.pathname === '/api/experiment/stop') { world.endAutonomy(); await scheduler?.stop(); await scenario?.stop(); return send(200, { stopped: true }); }
      if (request.method === 'POST' && url.pathname === '/api/experiment/start') {
        if (!scenario || !scheduler) throw new ApiError(409, '请通过 minecraft:survival 启动完整生存实验。');
        if (!initialized) throw new ApiError(409, '世界和初始背包还在同步，请稍后再开始。');
        if (world.bots.size !== 4 || [...world.bots.values()].some(r => !r.ready) || (dragon && provisioned.size !== 4)) throw new ApiError(409, '四位角色尚未准备好。');
        if (survival) captureInitialSurvivalState(world, survival);
        world.startAutonomy(() => { scenario.start(); scheduler.start(); });
        return send(200, { started: true });
      }
      if (request.method === 'GET' && url.pathname === '/api/bots') return send(200, { bots: [...world.bots.values()].map(botSummary) });
      if (request.method === 'POST' && url.pathname === '/api/bots') {
        if (!initialized) throw new ApiError(409, '世界尚未完成初始化。');
        const input = await body(request);
        const name = botName(input.name), persona = text(input.persona || '友好、好奇，愿意与他人合作。', 'persona', 8000);
        const roleId = input.roleId ? text(input.roleId, 'roleId', 80) : undefined;
        if (roleId && !/^[a-z0-9_-]+$/u.test(roleId)) throw new ApiError(400, '无效角色档案 ID。');
        return send(201, botSummary(world.add(name, persona, roleId)));
      }
      const match = /^\/api\/bots\/([A-Za-z0-9_]+)\/(observe|actions|tasks|stop|control|intent)$/u.exec(url.pathname);
      if (match) {
        const [, name, endpoint] = match;
        if (request.method === 'GET' && endpoint === 'observe') return send(200, world.observe(name));
        if (request.method === 'GET' && endpoint === 'control') return send(200, world.get(name).body?.snapshot() || { enabled: false });
        if (request.method === 'POST' && endpoint === 'intent') {
          const record = world.get(name), input = await body(request);
          if (!record.body) throw new ApiError(409, '双循环未启用。');
          const result = record.body.submit(input, input.resume === true);
          if (result.accepted && input.resume === true) world.acknowledgeExplicitResume(record);
          return send(result.accepted ? 202 : 409, result);
        }
        if (request.method === 'POST' && ['actions', 'tasks'].includes(endpoint) && !initialized) throw new ApiError(409, '世界尚未完成初始化。');
        if (request.method === 'POST' && endpoint === 'actions') return send(200, await world.execute(name, await body(request)));
        if (request.method === 'POST' && endpoint === 'tasks') {
          const newTask = world.captureActivation(world.get(name));
          const input = await body(request);
          return send(200, await runTask(world, name, text(input.instruction, 'instruction', 3000), root, { worldId: world.memoryNamespace, newTask }));
        }
        if (request.method === 'POST' && endpoint === 'stop') { await world.stop(world.get(name)); return send(200, { stopped: true }); }
      }
      if (request.method === 'POST' && url.pathname === '/api/shutdown') { send(200, { stopping: true }); void shutdown(); return; }
      throw new ApiError(404, '接口不存在。');
    }
    if (request.method !== 'GET') throw new ApiError(405, '不支持这个方法。');
    const files: Record<string, [string, string]> = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/camera-session.js': ['camera-session.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/experience.css': ['experience.css', 'text/css'] };
    const file = files[url.pathname];
    if (!file) throw new ApiError(404, '页面不存在。');
    response.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; frame-src http://127.0.0.1:*; style-src 'self'; script-src 'self'; connect-src 'self'" });
    response.end(await readFile(join(publicDirectory, file[0])));
  } catch (error: any) { if (!response.headersSent) send(error instanceof ApiError ? error.status : 500, { error: error.message }); }
});
server.requestTimeout = 120000;

async function shutdown() {
  if (closing) return;
  closing = true; if (monitor) clearInterval(monitor);
  initialized = false;
  world.endAutonomy(); await scheduler?.stop(); await scenario?.stop(); await viewer?.close(); world.close(); server.close();
  if (child?.exitCode === null) {
    child.stdin?.write('stop\n');
    await Promise.race([new Promise<void>(resolve => child!.once('exit', () => resolve())), delay(10000)]);
    if (child.exitCode === null) child.kill();
  }
  process.exit(0);
}
process.on('SIGINT', () => void shutdown()); process.on('SIGTERM', () => void shutdown());

await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
await mkdir(runtimeDirectory, { recursive: true });
await writeFile(join(runtimeDirectory, 'api-session.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${port}`, token, pid: process.pid }, null, 2));
console.log(`Minecraft API: http://127.0.0.1:${port}`);
try {
  try { viewer = await startViewerService({ port: Number(process.env.ANIMA_MC_VIEWER_PORT || port + 1), apiPort: port, getRecord: name => world.bots.get(name) }); }
  catch (error: any) { viewerError = '实时画面服务启动失败，请检查画面端口是否被占用。'; console.error(viewerError, error.message); }
  if (scenario) {
    if (await listening(host, gamePort)) throw new Error('实验使用独立存档，当前端口已有服务器，请先停掉原有实验室。');
    await scenario.restore();
    const directory = join(runtimeDirectory, survival ? 'survival-lab' : 'dragon-lab');
    runtime.serverDirectory = join(directory, 'server');
    world.memoryNamespace = survival ? survival.status().worldId : `dragon-${dragon!.status().runId}`;
    world.logDirectory = join(directory, 'events', world.memoryNamespace);
    if (survival) await prepareSurvivalServer(runtime.serverDirectory, gamePort, world.memoryNamespace);
    else await prepareDragonServer(runtime.serverDirectory, gamePort);
  }
  if (!(await listening(host, gamePort))) {
    if (gamePort !== 25565) throw new Error('自定义端口的世界必须先自行启动，再启动适配器。');
    let ready: (() => void) | undefined, fail: ((error: Error) => void) | undefined, output = '';
    const booted = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; });
    child = spawn(runtime.java, ['-Xms512M', '-Xmx2G', '-jar', runtime.serverJar, 'nogui'], { cwd: runtime.serverDirectory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const log = (chunk: Buffer) => {
      const line = chunk.toString(); output = (output + line).slice(-5000);
      void appendFile(join(runtimeDirectory, 'server-console.log'), line);
      scenario?.console(line);
      if (output.includes('Done (')) ready?.();
    };
    child.stdout?.on('data', log); child.stderr?.on('data', log);
    child.once('error', error => fail?.(error));
    child.once('exit', code => {
      if (closing) return;
      const error = new Error(`Minecraft server exited: ${code}; 查看 server-console.log。`);
      fail?.(error); console.error(error.message);
      initialized = false;
      // A dead world must not leave four agents spending tokens on stale observations.
      world.endAutonomy(); void scheduler?.stop();
      if (monitor) clearInterval(monitor);
      void scenario?.stop();
      world.close();
    });
    await Promise.race([booted, delay(120000).then(() => { throw new Error('Minecraft 服务器启动超过120秒。'); })]);
    if (scenario) scenario.setup();
    else child.stdin?.write('gamerule doDaylightCycle false\ngamerule doMobSpawning false\ntime set day\nweather clear\nsetworldspawn 0 -60 0\n');
  }
  if (!closing) {
    if (survival) {
      for (const actor of SURVIVAL_ROSTER) { world.add(actor.name, actor.persona, actor.roleId); await delay(500); }
      const until = Date.now() + 60000;
      while (Date.now() < until && !survivalActorsReady(world.bots.values())) await delay(500);
      if (!survivalActorsReady(world.bots.values())) throw new Error('四位 NPC 尚未完成进服与背包同步。');
      // Full inventory packets have arrived; observe armor and hand slots as well.
      captureInitialSurvivalState(world, survival); survival.start(); survival.poll();
      monitor = setInterval(() => {
        try { observeSurvival(); survival.poll(); }
        catch (error: any) { console.error(error.message); world.endAutonomy(); void scheduler?.stop(); }
      }, 5000);
      if (process.env.ANIMA_MC_AUTORUN !== 'false') world.startAutonomy(() => scheduler?.start());
      console.log(`Survival ready: ${world.memoryNamespace}; initial empty-handed start verified, current progress restored.`);
    } else if (dragon) {
      for (const actor of DRAGON_ROSTER) { world.add(actor.name, actor.persona, actor.roleId); await delay(500); }
      const until = Date.now() + 60000;
      while (Date.now() < until && [...world.bots.values()].some(r => !r.ready || !String(r.bot.game.dimension).includes('end'))) await delay(500);
      if ([...world.bots.values()].some(r => !r.ready || !String(r.bot.game.dimension).includes('end'))) throw new Error('四位 NPC 未能进入末地。');
      await delay(3000);
      dragon.openCages(world.bots.values()); dragon.start(); dragon.poll();
      monitor = setInterval(() => {
        try { dragon.poll(); dragon.openCages(world.bots.values()); }
        catch (error: any) { console.error(error.message); world.endAutonomy(); void scheduler?.stop(); }
      }, 5000);
      if (process.env.ANIMA_MC_AUTORUN !== 'false') world.startAutonomy(() => scheduler?.start());
      console.log('Dragon trial ready: four native Mineflayer NPCs, CLIProxyAPI, persistent memories.');
    } else {
      world.add('LinChe', '林澈：温和、简短、重视承诺，喜欢安静探索，遇到困难会先观察再行动。');
      await delay(1200);
      world.add('XiaoYu', '小雨：活泼、好奇，愿意主动打招呼和合作，尊重别人的安排。');
      console.log('Bots connecting: LinChe, XiaoYu');
    }
    initialized = true;
  }
} catch (error: any) { console.error(error.message); await shutdown(); }

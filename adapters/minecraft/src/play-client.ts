import { spawn, execFile, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { promisify } from 'node:util';
import { open, readFile, stat, mkdir, appendFile } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute, basename, delimiter } from 'node:path';

export type PlayClientMode = 'native' | 'hmcl';
export interface PlayClientOptions {
  root: string;
  host?: string;
  port?: number;
  version?: string;
  /** Native reuses this lab's already prepared, local-only client. HMCL opens its UI. */
  mode?: PlayClientMode;
}
export interface PlayClientStatus {
  state: 'ready' | 'starting' | 'client-running' | 'launcher-open' | 'unavailable' | 'failed';
  available: boolean;
  mode: PlayClientMode;
  instance: string;
  serverAddress: string;
  connection: 'unverified';
  message: string;
  pid?: number;
  logPath?: string;
}
export interface PlayClientLaunch extends PlayClientStatus {
  started: boolean;
  alreadyRunning: boolean;
}
interface RunningProcess { pid: number; kind: 'client' | 'launcher' }
interface ProcessScope { gameDirectory: string; launcherJar: string }
export interface PlayClientDependencies {
  listProcesses?: (scope: ProcessScope) => Promise<RunningProcess[]>;
  spawn?: (file: string, args: string[], options: SpawnOptions) => ChildProcess;
  platform?: NodeJS.Platform;
  now?: () => number;
}
interface PreparedClient extends ProcessScope { executable: string; args: string[]; cwd: string }

// Exactly the local lab identity already provisioned by scripts/minecraft/launcher.py.
// No account store is opened, no credentials are copied, and authentication is not changed.
const OBSERVER = 'AnimaObserver';
const OBSERVER_UUID = '9b797b28c1dd553e9ab2f17ae44732f2';
const pendingLaunches = new Map<string, Promise<PlayClientLaunch>>();
const execFileAsync = promisify(execFile);
const STATUS_CACHE_MS = 10_000;

function inside(directory: string, target: unknown): string {
  if (typeof target !== 'string' || !isAbsolute(target) || /[\r\n\0]/u.test(target)) throw new Error('本地运行文件路径无效。');
  const normalized = resolve(target), rel = relative(resolve(directory), normalized);
  if (!rel || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) throw new Error('运行文件必须位于隔离 Minecraft 目录内。');
  return normalized;
}
async function jsonFile(path: string) {
  if ((await stat(path)).size > 256_000) throw new Error('本地运行配置过大。');
  return JSON.parse(await readFile(path, 'utf8'));
}
async function exists(path: string, directory = false) {
  const entry = await stat(path);
  if (directory ? !entry.isDirectory() : !entry.isFile()) throw new Error('本地客户端资源不完整。');
}

/** Only PID/kind leave PowerShell; command lines can contain launcher credentials. */
async function windowsProcesses(scope: ProcessScope): Promise<RunningProcess[]> {
  const script = [
    '$ErrorActionPreference = "Stop";',
    '$result = @(Get-CimInstance Win32_Process -Filter "Name = \'java.exe\' OR Name = \'javaw.exe\'" | ForEach-Object {',
    '  $line = $_.CommandLine;',
    '  if ($line -and $line.IndexOf($env:ANIMA_PLAY_GAME_DIR, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $line.Contains("net.minecraft.client.main.Main")) {',
    '    [pscustomobject]@{pid=[int]$_.ProcessId;kind="client"}',
    '  } elseif ($line -and $line.IndexOf($env:ANIMA_PLAY_LAUNCHER_JAR, [StringComparison]::OrdinalIgnoreCase) -ge 0) {',
    '    [pscustomobject]@{pid=[int]$_.ProcessId;kind="launcher"}',
    '  }',
    '}); ConvertTo-Json -InputObject $result -Compress',
  ].join('\n');
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await execFileAsync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, shell: false, timeout: 7000, maxBuffer: 16_384,
    env: { ...process.env, ANIMA_PLAY_GAME_DIR: scope.gameDirectory, ANIMA_PLAY_LAUNCHER_JAR: scope.launcherJar },
  });
  const rows = JSON.parse(stdout.trim() || '[]');
  if (!Array.isArray(rows)) throw new Error('无法确认已有客户端进程。');
  return rows.filter(row => Number.isInteger(row.pid) && row.pid > 0 && ['client', 'launcher'].includes(row.kind));
}

/** Construction/status never start a game or launcher. Only explicitly called launch() does. */
export class PlayClient {
  readonly root: string;
  readonly mode: PlayClientMode;
  readonly version: string;
  readonly serverAddress: string;
  readonly instance: string;
  readonly logPath: string;
  private dependencies: PlayClientDependencies;
  private child?: ChildProcess;
  private lastFailure = '';
  private key: string;
  private statusCache?: { value: PlayClientStatus; until: number };
  private statusPending?: Promise<PlayClientStatus>;
  private statusRevision = 0;

  constructor(options: PlayClientOptions, dependencies: PlayClientDependencies = {}) {
    const host = options.host || '127.0.0.1', port = options.port ?? 25565;
    if (!['127.0.0.1', 'localhost'].includes(host)) throw new Error('客户端按钮只允许连接本机服务器。');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Minecraft 端口无效。');
    this.version = options.version || '1.21.4';
    if (!/^\d+\.\d+(?:\.\d+)?$/u.test(this.version)) throw new Error('Minecraft 版本无效。');
    this.mode = options.mode || 'hmcl';
    if (!['native', 'hmcl'].includes(this.mode)) throw new Error('客户端启动方式无效。');
    this.root = resolve(options.root);
    this.instance = `Anima-Local-${this.version}`;
    this.serverAddress = `${host}:${port}`;
    this.logPath = join(this.root, 'var/minecraft/play-client.log');
    this.key = join(this.root, 'var/minecraft/launcher', this.instance).toLowerCase();
    this.dependencies = dependencies;
  }

  private view(state: PlayClientStatus['state'], message: string, pid?: number): PlayClientStatus {
    return { state, available: state !== 'unavailable', mode: this.mode,
      instance: this.instance, serverAddress: this.serverAddress, connection: 'unverified', message,
      ...(pid ? { pid } : {}), logPath: this.logPath };
  }

  private async prepare(): Promise<PreparedClient> {
    if ((this.dependencies.platform || process.platform) !== 'win32') throw new Error('当前预装客户端启动入口仅支持 Windows。');
    const runtimeDirectory = join(this.root, 'var/minecraft');
    const launcher = await jsonFile(join(runtimeDirectory, 'launcher.json'));
    const runtime = await jsonFile(join(runtimeDirectory, 'runtime.json'));
    if (launcher.instance !== this.instance || launcher.mode !== 'normal' || launcher.demo !== false || runtime.version !== this.version) {
      throw new Error('请先准备与服务器版本一致的 Anima-Local 普通客户端实例。');
    }
    const launcherDirectory = join(runtimeDirectory, 'launcher');
    if (resolve(String(launcher.directory)) !== launcherDirectory) throw new Error('启动器必须使用已有隔离目录。');
    const executable = inside(runtimeDirectory, launcher.java);
    if (executable !== inside(runtimeDirectory, runtime.java) || !/^javaw?\.exe$/iu.test(basename(executable))) throw new Error('便携 Java 路径无效。');
    const launcherJar = inside(launcherDirectory, launcher.jar);
    if (!/^HMCL-[\d.]+\.jar$/u.test(basename(launcherJar))) throw new Error('HMCL 路径无效。');
    const gameDirectory = join(launcherDirectory, 'instances', this.instance);
    const versionDirectory = join(gameDirectory, 'versions', this.instance);
    const metadata = await jsonFile(join(versionDirectory, `${this.instance}.json`));
    if (metadata.id !== this.instance || metadata.mainClass !== 'net.minecraft.client.main.Main' || metadata.inheritsFrom) throw new Error('该入口仅支持已准备的原生客户端。');
    await Promise.all([exists(executable), exists(launcherJar), exists(gameDirectory, true), exists(join(versionDirectory, `${this.instance}.jar`))]);
    if (this.mode === 'hmcl') {
      const gameArgs = metadata.arguments?.game;
      const index = Array.isArray(gameArgs) ? gameArgs.indexOf('--quickPlayMultiplayer') : -1;
      if (index < 0 || gameArgs[index + 1] !== this.serverAddress) throw new Error('HMCL 实例自动进服地址与当前服务器不一致；不会自动修改实例。');
      return { executable, args: ['-jar', launcherJar], cwd: launcherDirectory, gameDirectory, launcherJar };
    }
    const client = runtime.client;
    if (!client || client.mainClass !== 'net.minecraft.client.main.Main' || !/^\d+$/u.test(String(client.assetIndex))) throw new Error('现有客户端运行配置不完整。');
    const clientDirectory = join(runtimeDirectory, 'client');
    const natives = inside(clientDirectory, client.natives), assets = inside(clientDirectory, client.assets);
    if (typeof client.classpath !== 'string') throw new Error('客户端类路径缺失。');
    const libraries = client.classpath.split(delimiter).map((path: string) => inside(clientDirectory, path));
    if (!libraries.length || libraries.length > 256 || libraries.some((path: string) => !path.endsWith('.jar'))) throw new Error('客户端类路径无效。');
    await Promise.all([exists(natives, true), exists(assets, true), exists(join(assets, 'indexes', `${client.assetIndex}.json`)), ...libraries.map((path: string) => exists(path))]);
    const args = ['-Xms512M', '-Xmx2G', `-Djava.library.path=${natives}`, `-Djna.tmpdir=${natives}`,
      `-Dorg.lwjgl.system.SharedLibraryExtractPath=${natives}`, '-Dminecraft.launcher.brand=AnimaLocal', '-Dminecraft.launcher.version=0.1',
      '-cp', libraries.join(delimiter), client.mainClass, '--username', OBSERVER, '--version', this.instance,
      '--gameDir', gameDirectory, '--assetsDir', assets, '--assetIndex', String(client.assetIndex),
      '--uuid', OBSERVER_UUID, '--accessToken', '0', '--userType', 'legacy', '--versionType', 'release',
      '--width', '1280', '--height', '720', '--quickPlayMultiplayer', this.serverAddress];
    return { executable, args, cwd: gameDirectory, gameDirectory, launcherJar };
  }

  private async inspect(prepared: PreparedClient): Promise<PlayClientStatus> {
    let processes: RunningProcess[];
    try { processes = await (this.dependencies.listProcesses || windowsProcesses)(prepared); }
    catch { return this.view('unavailable', '无法确认已有客户端进程，暂不启动第二个窗口。'); }
    const client = processes.find(item => item.kind === 'client');
    if (client) return this.view('client-running', '本地客户端已在运行；请在游戏窗口确认进服情况。', client.pid);
    const launcher = processes.find(item => item.kind === 'launcher');
    if (launcher) return this.view('launcher-open', 'HMCL 已打开，请在其中启动 Anima-Local 实例；不会重复开窗口。', launcher.pid);
    if (this.child?.pid && this.child.exitCode === null && this.child.signalCode === null) return this.view('starting', '已发起启动，正在等待原生窗口；尚未确认进服。', this.child.pid);
    if (this.lastFailure) return this.view('failed', this.lastFailure);
    return this.view('ready', this.mode === 'native' ? '客户端资源已就绪，点击后尝试连接本地服务器。' : 'HMCL 已就绪；打开后需在其中点击启动游戏。');
  }

  private invalidateStatus() {
    this.statusRevision++;
    this.statusCache = undefined;
    this.statusPending = undefined;
  }

  private async freshStatus(): Promise<PlayClientStatus> {
    try { return await this.inspect(await this.prepare()); }
    catch (error) {
      const known = error instanceof Error && !('code' in error) && !(error instanceof SyntaxError);
      return this.view('unavailable', known ? error.message : '本地客户端资源缺失或配置不可读；不会自动下载或修改账户。');
    }
  }

  /** UI polling shares one read and caches its result; launch() always bypasses it. */
  async status(): Promise<PlayClientStatus> {
    const now = this.dependencies.now || Date.now;
    if (this.statusCache && now() < this.statusCache.until) return { ...this.statusCache.value };
    if (this.statusPending) return { ...await this.statusPending };
    const revision = this.statusRevision;
    const request = this.freshStatus().then(value => {
      // A late read started before launch/exit must not restore the old cached state.
      if (revision === this.statusRevision) this.statusCache = { value, until: now() + STATUS_CACHE_MS };
      return value;
    }).finally(() => { if (this.statusPending === request) this.statusPending = undefined; });
    this.statusPending = request;
    return { ...await request };
  }

  launch(): Promise<PlayClientLaunch> {
    const pending = pendingLaunches.get(this.key);
    if (pending) return pending.then(status => ({ ...status, started: false, alreadyRunning: ['starting', 'client-running', 'launcher-open'].includes(status.state) }));
    const request = this.start().finally(() => { if (pendingLaunches.get(this.key) === request) pendingLaunches.delete(this.key); });
    pendingLaunches.set(this.key, request);
    return request;
  }

  private async start(): Promise<PlayClientLaunch> {
    this.invalidateStatus();
    const current = await this.freshStatus();
    if (!['ready', 'failed'].includes(current.state)) return { ...current, started: false, alreadyRunning: ['starting', 'client-running', 'launcher-open'].includes(current.state) };
    this.lastFailure = '';
    let log: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const prepared = await this.prepare();
      await mkdir(join(this.root, 'var/minecraft'), { recursive: true });
      log = await open(this.logPath, 'a');
      await log.write(`\n[${new Date().toISOString()}] requested ${this.mode} ${this.instance} ${this.serverAddress}\n`);
      const child = (this.dependencies.spawn || spawn)(prepared.executable, prepared.args, {
        cwd: prepared.cwd, shell: false, windowsHide: true, detached: true, stdio: ['ignore', log.fd, log.fd],
      });
      this.child = child;
      child.once('error', () => { this.lastFailure = '客户端启动失败，请查看本地运行日志。'; this.invalidateStatus(); });
      child.once('exit', (code, signal) => {
        if (code !== 0 || signal) this.lastFailure = '客户端进程已退出，请查看本地运行日志。';
        this.invalidateStatus();
        void appendFile(this.logPath, `[${new Date().toISOString()}] exited code=${code} signal=${signal}\n`).catch(() => {});
      });
      await new Promise<void>((done, reject) => { child.once('spawn', done); child.once('error', reject); });
      child.unref();
      this.invalidateStatus();
      return { ...this.view('starting', this.mode === 'native' ? '已发起客户端启动并请求连接本地服务器；尚未确认进服。' : '已发起 HMCL 启动；请在其中点击启动 Anima-Local 实例。', child.pid), started: true, alreadyRunning: false };
    } catch {
      this.lastFailure = '客户端启动失败，请查看本地运行日志。';
      this.invalidateStatus();
      return { ...this.view('failed', this.lastFailure), started: false, alreadyRunning: false };
    } finally { await log?.close().catch(() => {}); }
  }
}

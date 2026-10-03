import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export interface ExamServerConfig {
  kind: 'anima-skill-exam'; serverId: string; directory: string; gamePort: number; rconPort: number;
  /** Local server credential; never serialize this object into benchmark results or console output. */
  rconPassword: string; version: string; java: string; serverJar: string;
}
export async function prepareExamServer(root: string, options: { gamePort?: number; rconPort?: number } = {}): Promise<ExamServerConfig> {
  const gamePort = options.gamePort ?? 25575, rconPort = options.rconPort ?? 25585;
  if ([gamePort, rconPort].some(port => !Number.isInteger(port) || port < 1024 || port > 65535 || port === 25565) || gamePort === rconPort) throw new Error('Choose separate isolated exam ports; never the survival port 25565.');
  const examRoot = resolve(root, 'var/minecraft/skill-exam'), directory = join(examRoot, 'server');
  const markerPath = join(directory, 'anima-skill-exam.json');
  const runtime = JSON.parse(await readFile(join(root, 'var/minecraft/runtime.json'), 'utf8'));
  if (runtime.version !== '1.21.4') throw new Error('These arenas are pinned to Minecraft Java 1.21.4.');
  const acceptedEula = await readFile(join(dirname(runtime.serverJar), 'eula.txt'), 'utf8');
  if (!/^eula=true\s*$/mu.test(acceptedEula)) throw new Error('The installed Minecraft runtime has no accepted EULA.');
  await mkdir(directory, { recursive: true });
  let config: ExamServerConfig;
  try {
    config = JSON.parse(await readFile(markerPath, 'utf8'));
    if (config.kind !== 'anima-skill-exam' || resolve(config.directory) !== directory || config.gamePort !== gamePort || config.rconPort !== rconPort) throw new Error('Existing exam directory does not match requested isolation.');
    return config;
  } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  if ((await readdir(directory)).length) throw new Error('Refusing to initialize a nonempty unmarked server directory.');
  config = { kind: 'anima-skill-exam', serverId: randomUUID(), directory, gamePort, rconPort, rconPassword: randomBytes(32).toString('hex'), version: runtime.version, java: runtime.java, serverJar: runtime.serverJar };
  await writeFile(markerPath, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await writeFile(join(directory, 'eula.txt'), 'eula=true\n');
  await writeFile(join(directory, 'server.properties'), [
    'server-ip=127.0.0.1', `server-port=${gamePort}`, 'online-mode=false', 'enforce-secure-profile=false',
    'motd=Anima isolated skill exam', 'gamemode=survival', 'force-gamemode=true', 'difficulty=normal',
    'max-players=8', 'spawn-protection=0', 'view-distance=5', 'simulation-distance=5',
    'level-name=exam-world', 'level-type=minecraft:flat', 'level-seed=184391', 'generate-structures=false',
    'generator-settings={"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:dirt","height":2},{"block":"minecraft:grass_block","height":1}],"biome":"minecraft:plains"}',
    'spawn-animals=false', 'spawn-monsters=false', 'spawn-npcs=false', 'allow-nether=false',
    'enable-rcon=true', `rcon.port=${rconPort}`, `rcon.password=${config.rconPassword}`, 'broadcast-rcon-to-ops=false',
    'enable-query=false', 'enable-command-block=false', 'pause-when-empty-seconds=-1', 'pvp=false', '',
  ].join('\n'), { mode: 0o600 });
  return config;
}
export async function loadExamServer(root: string): Promise<ExamServerConfig> {
  const base = resolve(root, 'var/minecraft/skill-exam');
  const config: ExamServerConfig = JSON.parse(await readFile(join(base, 'server/anima-skill-exam.json'), 'utf8'));
  const rel = relative(base, resolve(config.directory));
  if (config.kind !== 'anima-skill-exam' || !rel || rel.startsWith('..') || isAbsolute(rel) || config.gamePort === 25565 || config.rconPort === 25565) throw new Error('Exam marker failed isolation check.');
  return config;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const config = await prepareExamServer(root);
  console.log(JSON.stringify({ prepared: true, directory: config.directory, gamePort: config.gamePort, rconPort: config.rconPort, version: config.version, started: false }, null, 2));
}

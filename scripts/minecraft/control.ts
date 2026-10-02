import { readFile, mkdir, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = join(root, 'var/minecraft');
const baseUrl = `http://127.0.0.1:${Number(process.env.ANIMA_MC_API_PORT || 18791)}`;
const dragon = process.argv.includes('--dragon');
const survival = process.argv.includes('--survival');
if (dragon && survival) throw new Error('Select one scenario.');
const requestedScenario = survival ? 'survival' : dragon ? 'dragon-easy' : process.env.ANIMA_MC_SCENARIO || 'survival';
async function health() {
  try {
    const response = await fetch(baseUrl + '/api/health', { signal: AbortSignal.timeout(1500) });
    const result = await response.json();
    if (result.service !== 'anima-minecraft') throw new Error('Port is used by another service.');
    return result;
  } catch (error: any) {
    if (error.message === 'Port is used by another service.') throw error;
    return undefined;
  }
}
function processAlive(pid: unknown) {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}
if (process.argv.includes('--stop')) {
  if (!await health()) { console.log('Minecraft lab is already stopped.'); }
  else {
    const session = JSON.parse(await readFile(join(runtime, 'api-session.json'), 'utf8'));
    const response = await fetch(session.baseUrl + '/api/shutdown', {
      method: 'POST', headers: { Authorization: 'Bearer ' + session.token }, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('Shutdown failed: ' + response.status);
    // The API closes before Java finishes saving. Wait for its owning Node
    // process to finish too, so a mode switch cannot race the old game port.
    for (let i = 0; i < 25 && (processAlive(session.pid) || await health()); i++) await delay(1000);
    if (processAlive(session.pid) || await health()) throw new Error('Minecraft shutdown is still in progress; check var/minecraft/api-console.log.');
    console.log('Minecraft lab stopped. HMCL and its demo window are separate.');
  }
} else {
  const existing = await health();
  if (existing && existing.scenario !== requestedScenario) throw new Error('先运行 npm run minecraft:stop，再切换世界模式。');
  if (!existing) {
    await readFile(join(runtime, 'runtime.json')).catch(() => { throw new Error('Run npm run minecraft:setup first.'); });
    await mkdir(runtime, { recursive: true });
    const log = await open(join(runtime, 'api-console.log'), 'a');
    const child = spawn(process.execPath, ['--env-file-if-exists=' + join(root, '.env'), join(root, 'adapters/minecraft/src/server.ts'), ...(survival ? ['--survival'] : dragon ? ['--dragon'] : [])], {
      cwd: root, env: process.env, detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
    });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref(); await log.close();
    console.log('Starting Minecraft lab…');
  }
  let ready = false;
  for (let i = 0; i < 120; i++) {
    const state = await health();
    if (state?.initialized === true && state.readyBots >= (requestedScenario === 'sandbox' ? 2 : 4)) { ready = true; break; }
    await delay(1000);
  }
  if (!ready) throw new Error('Bots did not become ready. Check var/minecraft/api-console.log.');
  console.log('Minecraft lab ready: ' + baseUrl);
}

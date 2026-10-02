import { readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const session = JSON.parse(await readFile(join(root, 'var/minecraft/api-session.json'), 'utf8'));
async function get(path: string) {
  const response = await fetch(session.baseUrl + '/api/' + path, { headers: { Authorization: 'Bearer ' + session.token }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json();
}
const [experiment, { bots }] = await Promise.all([get('experiment'), get('bots')]);
const observations = await Promise.all(bots.map(async (bot: any) => {
  const observation = bot.ready ? await get(`bots/${bot.name}/observe`) : {};
  return {
    name: bot.name, position: bot.position, health: bot.health, ready: bot.ready, busy: bot.busy,
    entities: observation.nearbyEntities?.filter((e: any) => ['ender_dragon', 'end_crystal'].includes(e.name)).map((e: any) => ({ id: e.id, name: e.name, health: e.health, distance: e.distance })),
    recent: observation.recentEvents?.filter((e: any) => ['said', 'action', 'task-finished', 'task-failed'].includes(e.type)).slice(-6)
      .map((e: any) => ({ time: e.time, type: e.type, action: e.action, status: e.status, reason: e.reason, message: e.message, reply: e.reply, error: e.error, details: e.details })),
  };
}));
console.log(JSON.stringify({ time: new Date().toISOString(), ...experiment, bots: observations }, null, 2));

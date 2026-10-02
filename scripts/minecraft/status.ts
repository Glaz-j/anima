import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Read-only, bounded operator report. The local API credential is never printed.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const session = JSON.parse(await readFile(join(root, 'var/minecraft/api-session.json'), 'utf8'));
async function get(path: string) {
  const response = await fetch(session.baseUrl + path, { headers: { Authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Minecraft status ${path}: HTTP ${response.status}`);
  return response.json();
}
const [health, experiment, actors] = await Promise.all([get('/api/health'), get('/api/experiment'), get('/api/bots')]);
const observations = await Promise.all(actors.bots.map(async (actor: any) => {
  const observation = actor.ready ? await get(`/api/bots/${actor.name}/observe`) : undefined;
  return { name: actor.name, ready: actor.ready, busy: actor.busy, dimension: actor.dimension, health: actor.health, food: actor.food,
    position: actor.position, inventory: actor.inventory, inventoryConfirmed: actor.inventoryConfirmed,
    locomotion: observation?.locomotion, oxygen: observation?.oxygen, posture: observation?.posture,
    timeOfDay: observation?.timeOfDay, dayPhase: observation?.dayPhase, error: actor.error,
    events: observation?.recentEvents?.filter((event: any) => ['action', 'said', 'heard', 'task-finished', 'hurt', 'death', 'error'].includes(event.type)).slice(-6)
      .map((event: any) => ({ time: event.time, type: event.type, action: event.action, status: event.status, error: event.error, details: event.details,
        speaker: event.speaker, message: event.message, reply: event.reply, model: event.model, durationMs: event.durationMs,
        actions: event.actions, toolErrors: event.toolErrors,
        healthBefore: event.healthBefore, health: event.health, loss: event.loss })) };
}));
console.log(JSON.stringify({ health, scenario: { kind: experiment.scenario?.kind, worldId: experiment.scenario?.worldId,
  phase: experiment.scenario?.phase, complete: experiment.scenario?.complete, stage: experiment.scenario?.progress?.stage,
  initialEmptyVerified: experiment.scenario?.progress?.initialEmptyVerified, milestones: experiment.scenario?.progress?.milestones,
  deaths: experiment.scenario?.deaths }, scheduler: experiment.scheduler, actors: observations }, null, 2));

import mineflayer from 'mineflayer';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApiError, action, botName } from './validation.ts';
import { checkSignal, entityHealth, entityVisible, haltNative, meleeTarget, runNativeAction } from './native-actions.ts';
import { localPerception } from './local-perception.ts';
import { droppedItemSummary } from './entity-observation.ts';
import { blockProperties } from './block-observation.ts';
import { inventorySessionUsable } from './craft-sync.ts';
import { bodyEnvironment, trackBodyEnvironment } from './body-observation.ts';
import { IdleWaterPosture } from './idle-water-posture.ts';
import { NPC_COMMUNICATION, parseChatChannel } from './communication.ts';
export { NPC_COMMUNICATION } from './communication.ts';

export type BotRecord = {
  name: string; persona: string; roleId?: string; bot: any; ready: boolean; inventorySynced?: boolean;
  events: any[]; error?: string; actionController?: AbortController;
  waterPosture?: IdleWaterPosture;
  task?: { id: string; controller: AbortController }; viewer?: { url: string; close: () => void };
};

export class MinecraftWorld {
  bots = new Map<string, BotRecord>();
  private listeners = new Map<string, Set<(event: any) => void>>();
  host: string; port: number; version: string; logDirectory: string;
  memoryNamespace = 'minecraft';
  onSpawn?: (record: BotRecord) => void;
  onEvent?: (record: BotRecord, event: any) => void;
  constructor(options: { host: string; port: number; version: string; logDirectory: string }) {
    Object.assign(this, options);
    this.host = options.host; this.port = options.port; this.version = options.version; this.logDirectory = options.logDirectory;
  }

  add(name: string, persona: string, roleId?: string) {
    name = botName(name);
    if (this.bots.has(name)) throw new ApiError(409, '角色名已经存在。');
    if (this.bots.size >= 4) throw new ApiError(409, '第一版最多同时运行4个角色。');
    const bot = mineflayer.createBot({ host: this.host, port: this.port, version: this.version, username: name, auth: 'offline', hideErrors: true });
    trackBodyEnvironment(bot);
    const record: BotRecord = { name, persona, roleId, bot, ready: false, inventorySynced: false, events: [], waterPosture: new IdleWaterPosture(bot) };
    this.bots.set(name, record);
    bot._client?.on('window_items', (packet: any) => {
      if (packet.windowId !== 0) return;
      // Run after Mineflayer has applied the whole player-inventory packet.
      // An allocated empty slots array alone is not proof of an empty inventory.
      queueMicrotask(() => { record.inventorySynced = true; });
    });
    bot.on('spawn', () => {
      record.ready = true;
      this.event(record, 'spawn', { position: { ...bot.entity.position }, dimension: bot.game.dimension });
      this.onSpawn?.(record);
    });
    let lastHealth: number | undefined;
    bot.on('health', () => {
      const health = Number(bot.health);
      if (record.ready && Number.isFinite(lastHealth) && health < lastHealth!) {
        this.event(record, 'hurt', { healthBefore: lastHealth, health, food: bot.food, loss: lastHealth! - health });
      }
      lastHealth = Number.isFinite(health) ? health : undefined;
    });
    for (const type of ['death', 'respawn'] as const) bot.on(type, () => {
      record.ready = false; this.stop(record, type);
      this.event(record, type, { position: bot.entity?.position ? { ...bot.entity.position } : undefined, dimension: bot.game.dimension });
    });
    bot.on('chat', (speaker: string, message: string) => {
      if (speaker === name || !record.ready || typeof speaker !== 'string' || !/^[A-Za-z0-9_]{1,16}$/u.test(speaker)) return;
      const parsed = parseChatChannel(message);
      if (!parsed) return;
      if (parsed.channel === 'local') {
        const entity = bot.players[speaker]?.entity;
        if (!entity || entity.position.distanceTo(bot.entity.position) > NPC_COMMUNICATION.radius) return;
      }
      this.event(record, 'heard', { speaker, ...parsed });
    });
    bot.on('error', (error: Error) => { record.error = error.message; this.event(record, 'error', { message: error.message }); });
    bot.on('kicked', (reason: any) => {
      record.ready = false; this.stop(record, 'disconnected');
      record.error = typeof reason === 'string' ? reason : JSON.stringify(reason);
      this.event(record, 'kicked', { reason: record.error });
    });
    bot.on('end', () => {
      record.ready = false; this.stop(record, 'disconnected');
      record.viewer?.close(); record.viewer = undefined;
      this.event(record, 'disconnected', {});
    });
    return record;
  }

  event(record: BotRecord, type: string, data: any) {
    const event = { id: randomUUID(), npcId: record.name, time: new Date().toISOString(), type, ...data };
    record.events.push(event);
    if (record.events.length > 100) record.events.shift();
    void mkdir(this.logDirectory, { recursive: true }).then(() => appendFile(join(this.logDirectory, `${record.name}.jsonl`), JSON.stringify(event) + '\n')).catch(() => {});
    try { this.onEvent?.(record, event); } catch (error: any) { record.error = `事件回调失败：${error.message}`; }
    for (const listener of this.listeners.get(record.name) || []) {
      try { listener(event); } catch (error: any) { record.error = `感知订阅失败：${error.message}`; }
    }
    return event;
  }

  subscribe(name: string, listener: (event: any) => void) {
    this.get(name);
    let listeners = this.listeners.get(name);
    if (!listeners) { listeners = new Set(); this.listeners.set(name, listeners); }
    listeners.add(listener);
    return () => {
      listeners!.delete(listener);
      if (!listeners!.size && this.listeners.get(name) === listeners) this.listeners.delete(name);
    };
  }

  interruptAction(name: string) {
    const record = this.get(name);
    // An urgent perception interrupts the body while preserving the ongoing
    // reasoning turn and task lock. execute() still drains native completion.
    record.actionController?.abort({ type: 'perception', event: 'hurt' });
    record.waterPosture?.suspend();
    haltNative(record.bot);
    if (!record.actionController) record.waterPosture?.resume();
  }

  get(name: string): BotRecord {
    const record = this.bots.get(name);
    if (!record) throw new ApiError(404, '角色不存在。');
    return record;
  }

  summary(record: BotRecord) {
    const inventoryConfirmed = inventorySessionUsable(record.bot);
    return { name: record.name, ready: record.ready, inventorySynced: record.inventorySynced, persona: record.persona, roleId: record.roleId,
      position: record.ready ? record.bot.entity.position : null, health: record.bot.health, food: record.bot.food, dimension: record.bot.game?.dimension,
      inventoryConfirmed,
      inventory: inventoryConfirmed ? record.bot.inventory?.items().map((item: any) => ({ name: item.name, count: item.count })) || [] : undefined,
      busy: Boolean(record.actionController || record.task), taskId: record.task?.id,
      viewer: record.viewer?.url, error: record.error };
  }

  observe(name: string) {
    const record = this.get(name), bot = record.bot;
    if (!record.ready) throw new ApiError(503, '角色尚未进入世界。');
    const position = bot.entity.position;
    const entities = Object.values(bot.entities).filter((e: any) => {
      if (e.id === bot.entity.id || !e.position || e.position.distanceTo(position) > 96) return false;
      // Embedded arrows are abundant during combat and otherwise crowd out actors.
      if (['arrow', 'spectral_arrow', 'experience_orb'].includes(e.name)) return false;
      return entityVisible(bot, e);
    })
      .map((e: any) => ({ id: e.id, name: e.username || e.name || e.displayName, type: e.name || e.type, kind: e.type,
        position: e.position, distance: Number(e.position.distanceTo(position).toFixed(2)), health: entityHealth(bot, e),
        ...(['item', 'Item', 'item_stack'].includes(e.name) ? { droppedItem: droppedItemSummary(e) } : {}),
        ...(e.name === 'ender_dragon' ? (() => {
          const key = (bot.registry?.entitiesByName?.ender_dragon?.metadataKeys || []).indexOf('phase');
          const phase = e.metadata?.[key];
          const names = ['holding_pattern', 'strafing', 'landing_approach', 'landing', 'taking_off', 'perched_breathing', 'perched_scanning', 'perched_attacking', 'charging', 'dying', 'hovering'];
          return { phase, phaseName: names[phase], projectileImmune: typeof phase === 'number' ? [5, 6, 7].includes(phase) : null };
        })() : {}),
        ...(e.name === 'ender_dragon' && bot.version === '1.21.4' ? { meleeTarget: (() => {
          const target = meleeTarget(bot, e); return { entityId: target.id, part: 'body', position: target.position };
        })() } : {}) }))
      .sort((a, b) => a.distance - b.distance).slice(0, 40);
    const blocks = bot.findBlocks({ matching: (b: any) => b.name !== 'air' && b.boundingBox === 'block', maxDistance: 6, count: 18 })
      .flatMap((p: any) => {
        const block = bot.blockAt(p);
        if (!block || !bot.canSeeBlock(block)) return [];
        const properties = blockProperties(block);
        return [{ ...p, name: block.name, ...(properties ? { properties } : {}) }];
      });
    const compactItem = (item: any) => item ? { name: item.name, count: item.count } : null;
    const inventoryConfirmed = inventorySessionUsable(bot);
    // Mineflayer's confirmed clock supplies the phase; other dimensions do not
    // inherit overworld daylight merely because they expose the same clock.
    const dayPhase = ['overworld', 'minecraft:overworld'].includes(bot.game.dimension)
      && typeof bot.time?.isDay === 'boolean' && Number.isFinite(bot.time?.timeOfDay)
      ? (bot.time.isDay ? 'day' : 'night') : undefined;
    return { name, npcId: name, time: new Date().toISOString(), position, dimension: bot.game.dimension, health: bot.health, food: bot.food,
      ...bodyEnvironment(bot),
      ...(record.waterPosture ? { posture: record.waterPosture.snapshot() } : {}),
      gameMode: bot.game.gameMode, timeOfDay: bot.time?.timeOfDay, ...(dayPhase ? { dayPhase } : {}),
      communication: { ...NPC_COMMUNICATION },
      inventoryConfirmed,
      inventory: inventoryConfirmed ? bot.inventory.items().map((i: any) => ({ name: i.name, count: i.count })) : undefined,
      equipment: inventoryConfirmed ? { hand: compactItem(bot.heldItem), offHand: compactItem(bot.inventory.slots[45]),
        head: compactItem(bot.inventory.slots[5]), torso: compactItem(bot.inventory.slots[6]),
        legs: compactItem(bot.inventory.slots[7]), feet: compactItem(bot.inventory.slots[8]) } : undefined,
      localTerrain: localPerception(bot), nearbyEntities: entities, nearbyBlocks: blocks, recentEvents: record.events.slice(-20) };
  }

  stop(record: BotRecord, worldEvent?: 'death' | 'respawn' | 'disconnected') {
    const reason = worldEvent ? { type: 'world-event', event: worldEvent } : undefined;
    record.waterPosture?.disable();
    record.actionController?.abort(reason); record.task?.controller.abort(reason);
    haltNative(record.bot);
  }

  async execute(name: string, raw: any, taskId?: string) {
    const proposal = action(raw);
    const record = this.get(name), bot = record.bot;
    if (proposal.type === 'stop') {
      record.waterPosture?.disable();
      if (taskId && record.task?.id === taskId) {
        // A character choosing to stop walking is still allowed to finish its
        // reasoning turn. Only the operator's stop cancels the entire task.
        record.actionController?.abort(); haltNative(bot);
        const result = { id: randomUUID(), status: 'completed', action: proposal, details: { movementStopped: true } };
        this.event(record, 'action', result); return result;
      }
      this.stop(record); return { status: 'completed', type: 'stop' };
    }
    if (!record.ready) throw new ApiError(503, '角色尚未进入世界。');
    if (record.actionController || (record.task && record.task.id !== taskId)) throw new ApiError(409, '角色正在执行行动或 LLM 任务。');
    const controller = new AbortController();
    record.actionController = controller;
    record.waterPosture?.suspend();
    const abort = () => controller.abort(record.task?.controller.signal.reason);
    record.task?.controller.signal.addEventListener('abort', abort, { once: true });
    if (record.task?.controller.signal.aborted) abort();
    const inventoryCounts = () => {
      const totals = new Map<string, number>();
      for (const item of bot.inventory.items()) totals.set(item.name, (totals.get(item.name) || 0) + item.count);
      return totals;
    };
    const id = randomUUID(), before = { ...bot.entity.position }, started = Date.now(), healthBefore = bot.health;
    const inventoryBefore = inventoryCounts();
    const withVitals = (details: any) => {
      const inventoryAfter = inventoryCounts();
      const inventoryDelta = [...new Set([...inventoryBefore.keys(), ...inventoryAfter.keys()])]
        .map(item => ({ item, change: (inventoryAfter.get(item) || 0) - (inventoryBefore.get(item) || 0) }))
        .filter(entry => entry.change !== 0);
      // Deltas describe this action's time interval, not ownership of a drop or
      // causation: a nearby teammate may have dropped the item being picked up.
      const result = { inventoryDelta, ...details, vitals: { healthBefore, health: bot.health, food: bot.food } };
      if (!inventorySessionUsable(bot) || details?.inventoryConfirmed === false) {
        result.inventoryConfirmed = false;
        result.unconfirmedInventoryDelta ??= inventoryDelta;
        result.inventoryDelta = [];
      }
      return result;
    };
    const cancel = () => haltNative(bot);
    controller.signal.addEventListener('abort', cancel, { once: true });
    const actionTimeout = proposal.type === 'fish' ? proposal.durationMs + 8000
      : ['gather', 'craft', 'smelt', 'container'].includes(proposal.type) ? 45000 : 15000;
    const timer = setTimeout(() => controller.abort(), actionTimeout);
    try {
      checkSignal(controller.signal);
      let details: any;
      if (proposal.type === 'posture') {
        record.waterPosture ??= new IdleWaterPosture(bot);
        record.waterPosture.suspend();
        const posture = proposal.mode === 'none' ? record.waterPosture.disable() : record.waterPosture.enable(proposal.durationMs);
        details = { posture, note: '姿态授权已更新，当前动作释放身体后才可生效；active只表示正在按跳跃，不证明已换气或到达水面。' };
      } else details = await runNativeAction(bot, proposal, controller.signal, (type, data) => this.event(record, type, data));
      if (proposal.type === 'say' || proposal.type === 'broadcast') details = { ...details, communication: { ...NPC_COMMUNICATION },
        channel: proposal.type === 'broadcast' ? 'broadcast' : 'local', deliveryConfirmed: false,
        note: proposal.type === 'broadcast' ? '已通过服务器聊天发出世界广播；发出不证明任何同伴收到或同意，须由实际回应确认。'
          : '已发出本地说话，NPC听觉范围为同维度16格（含高差）；发出不证明任何同伴收到或同意，须由实际回应确认。' };
      checkSignal(controller.signal);
      const result = { id, status: 'completed', action: proposal, before, after: { ...bot.entity.position }, durationMs: Date.now() - started, details: withVitals(details) };
      this.event(record, 'action', result);
      return result;
    } catch (error: any) {
      const result = { id, status: controller.signal.aborted ? 'cancelled' : 'failed', action: proposal, before, after: { ...bot.entity.position }, error: error.message, details: withVitals(error.details), durationMs: Date.now() - started };
      this.event(record, 'action', result);
      if (error instanceof ApiError) throw error;
      return result;
    } finally {
      // Drain the native operation before releasing this lock: no orphaned action can
      // finish later and interfere with the next task after Promise.race returns.
      haltNative(bot);
      clearTimeout(timer); controller.signal.removeEventListener('abort', cancel);
      record.task?.controller.signal.removeEventListener('abort', abort);
      record.actionController = undefined;
      record.waterPosture?.resume();
    }
  }

  close() { for (const record of this.bots.values()) { this.stop(record); record.waterPosture?.dispose(); record.viewer?.close(); record.bot.quit(); } this.listeners.clear(); }
}

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
import { installSneakProtocolCompat } from './sneak-compat.ts';
import { MinecraftBody, NON_BODY_ACTIONS, validateBodyAction, bodyActionTimeoutMs } from './minecraft-body.ts';
import { runContinuousSkill } from './continuous-skills.ts';
import { NPC_COMMUNICATION, parseChatChannel } from './communication.ts';
export { NPC_COMMUNICATION } from './communication.ts';

export type BotRecord = {
  name: string; persona: string; roleId?: string; bot: any; ready: boolean; inventorySynced?: boolean;
  events: any[]; error?: string; actionController?: AbortController;
  waterPosture?: IdleWaterPosture;
  body?: MinecraftBody;
  operatorStopped?: boolean;
  task?: { id: string; controller: AbortController }; viewer?: { url: string; close: () => void };
};

export type BodyExecutionMode = 'serial' | 'parallel' | 'dual';
// A host admission ticket is captured before asynchronous request parsing. It
// cannot turn an older request into a resume after a newer stop or plan.
export type BodyActivationTicket = { record: BotRecord; epoch: number; version?: number };
type HostAuthorization = { epoch: number; session?: number; mode: BodyExecutionMode; faulted: boolean;
  respawn?: { ticket: BodyActivationTicket; session: number; drained: Promise<void> } };

export class MinecraftWorld {
  bots = new Map<string, BotRecord>();
  private listeners = new Map<string, Set<(event: any) => void>>();
  private hostAuthorization = new WeakMap<BotRecord, HostAuthorization>();
  private autonomousSession = 0;
  private autonomousActive = false;
  host: string; port: number; version: string; logDirectory: string;
  memoryNamespace = 'minecraft';
  dualLoop: boolean;
  onControlMetric?: (record: BotRecord, event: any) => void;
  onSpawn?: (record: BotRecord) => void;
  onEvent?: (record: BotRecord, event: any) => void;
  constructor(options: { host: string; port: number; version: string; logDirectory: string; dualLoop?: boolean }) {
    Object.assign(this, options);
    this.host = options.host; this.port = options.port; this.version = options.version; this.logDirectory = options.logDirectory;
    this.dualLoop = options.dualLoop === true;
  }

  add(name: string, persona: string, roleId?: string) {
    name = botName(name);
    if (this.bots.has(name)) throw new ApiError(409, '角色名已经存在。');
    if (this.bots.size >= 4) throw new ApiError(409, '第一版最多同时运行4个角色。');
    const bot = mineflayer.createBot({ host: this.host, port: this.port, version: this.version, username: name, auth: 'offline', hideErrors: true });
    bot.loadPlugin(installSneakProtocolCompat);
    trackBodyEnvironment(bot);
    const record: BotRecord = { name, persona, roleId, bot, ready: false, inventorySynced: false, events: [], waterPosture: new IdleWaterPosture(bot) };
    this.bots.set(name, record);
    if (this.dualLoop) record.body = new MinecraftBody(this, record, event => this.onControlMetric?.(record, event));
    bot._client?.on('window_items', (packet: any) => {
      if (packet.windowId !== 0) return;
      // Run after Mineflayer has applied the whole player-inventory packet.
      // An allocated empty slots array alone is not proof of an empty inventory.
      queueMicrotask(() => { record.inventorySynced = true; });
    });
    bot.on('spawn', () => this.spawned(record));
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
    if (type === 'control-error' && String(data?.controlEvent?.reason).startsWith('Body halt failed:')) {
      const authorization = this.authorization(record);
      authorization.faulted = true;
      this.revokeHostAuthorization(record);
      record.operatorStopped = true;
      record.task?.controller.abort();
    }
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

  private authorization(record: BotRecord): HostAuthorization {
    let authorization = this.hostAuthorization.get(record);
    if (!authorization) {
      authorization = { epoch: 0, mode: 'dual', faulted: false };
      this.hostAuthorization.set(record, authorization);
    }
    return authorization;
  }

  captureActivation(record: BotRecord): BodyActivationTicket {
    return { record, epoch: this.authorization(record).epoch, version: record.body?.snapshot().version };
  }

  private activationCurrent(ticket: BodyActivationTicket) {
    return this.bots.get(ticket.record.name) === ticket.record
      && this.authorization(ticket.record).epoch === ticket.epoch
      && ticket.record.body?.snapshot().version === ticket.version;
  }

  private revokeHostAuthorization(record: BotRecord) {
    const authorization = this.authorization(record);
    authorization.epoch++; authorization.session = undefined; authorization.respawn = undefined;
  }

  private checkAdmission(ticket: BodyActivationTicket, mode: BodyExecutionMode) {
    const record = ticket.record, control = record.body?.snapshot();
    if (!this.activationCurrent(ticket)) throw new ApiError(409, '恢复请求已失效，请重新发起任务。');
    if (!record.ready || !(record.bot.health > 0)) throw new ApiError(503, '角色尚未进入世界。');
    if (record.task) throw new ApiError(409, '角色正在执行其他任务。');
    if (this.authorization(record).faulted) throw new ApiError(409, '身体停止失败，需要检查执行器后显式恢复控制。');
    if (control?.current?.phase === 'draining' || control?.current && (control.stopped || !control.intent)
      || record.actionController && !control?.current) throw new ApiError(409, '身体上一动作仍在收尾。');
    if (mode !== 'dual' && control?.intent?.allowedReactions.length)
      throw new ApiError(409, '无反应对照不能继承已有自保授权，请先停止当前计划。');
  }

  private grantSurvival(ticket: BodyActivationTicket, mode: BodyExecutionMode) {
    const record = ticket.record, authorization = this.authorization(record);
    if (!this.activationCurrent(ticket) || authorization.faulted || !record.ready || !(record.bot.health > 0)) return false;
    const control = record.body?.snapshot();
    // An explicit new host session does not replace work that is still valid.
    if (control && !(control.intent && !control.stopped && control.intent.expiresAt > Date.now())) {
      if (control.current || record.actionController) return false;
      const result = record.body!.submit({ expectedVersion: ticket.version, steps: [], ttlMs: 120000,
        label: '宿主授权：等待规划时保持生存', reactions: mode === 'dual' ? ['surface', 'eat', 'defend', 'flee'] : [] }, control.stopped);
      if (!result.accepted) return false; // A failed CAS is never retried using a newer version.
    }
    if (authorization.epoch !== ticket.epoch || authorization.faulted) return false;
    record.operatorStopped = false;
    return true;
  }

  /** Explicit host task admission only; ordinary reasoning turns never call it. */
  authorizeTask(ticket: BodyActivationTicket, mode: BodyExecutionMode = 'dual') {
    this.checkAdmission(ticket, mode);
    if (!this.grantSurvival(ticket, mode)) throw new ApiError(409, '身体授权已变化，本次恢复未执行。');
    this.authorization(ticket.record).mode = mode;
  }

  /** startHost must be synchronous: scheduler admission happens before unlocking
   * actors, and its deferred model work starts after these one-shot grants. */
  startAutonomy(startHost: () => void, mode: BodyExecutionMode = 'dual') {
    if (this.autonomousActive) { startHost(); return; }
    const tickets = [...this.bots.values()].map(record => this.captureActivation(record));
    for (const ticket of tickets) this.checkAdmission(ticket, mode);
    startHost(); // Rejected scheduler/drain admission must leave every stop latch intact.
    const session = ++this.autonomousSession;
    this.autonomousActive = true;
    for (const ticket of tickets) {
      const authorization = this.authorization(ticket.record);
      if (!this.grantSurvival(ticket, mode)) {
        this.endAutonomy();
        throw new ApiError(409, '身体授权已变化，自主恢复未完成。');
      }
      authorization.session = session; authorization.mode = mode;
    }
  }

  /** Revoke respawn authority synchronously, before scheduler shutdown awaits. */
  endAutonomy() {
    this.autonomousActive = false; this.autonomousSession++;
    for (const record of this.bots.values()) this.revokeHostAuthorization(record);
  }

  /** Shared by the real Mineflayer spawn event and local wiring tests. A spawn
   * alone is never authorization; only the preceding live-session ticket is. */
  spawned(record: BotRecord) {
    record.ready = true;
    this.event(record, 'spawn', { position: { ...record.bot.entity.position }, dimension: record.bot.game.dimension });
    this.onSpawn?.(record);
    const authorization = this.authorization(record), pending = authorization.respawn;
    authorization.respawn = undefined;
    if (!pending) return;
    void pending.drained.then(() => {
      if (!this.autonomousActive || authorization.session !== this.autonomousSession || pending.session !== this.autonomousSession
        || record.operatorStopped || authorization.faulted) return;
      this.grantSurvival(pending.ticket, authorization.mode);
    }).catch(() => { /* Failed physical drain never grants new control. */ });
  }

  acknowledgeExplicitResume(record: BotRecord) {
    // Only used after a caller's explicit, versioned body resume was accepted.
    if (record.body?.snapshot().stopped) return;
    this.revokeHostAuthorization(record);
    this.authorization(record).faulted = false;
    record.operatorStopped = false;
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
      ...(record.body ? { control: record.body.snapshot(), brainBusy: Boolean(record.task), bodyBusy: Boolean(record.actionController) } : {}),
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
      ...(record.body ? { control: record.body.snapshot() } : {}),
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
    const authorization = this.authorization(record);
    authorization.epoch++; authorization.respawn = undefined;
    if (!worldEvent || worldEvent === 'disconnected') {
      authorization.session = undefined;
      if (!worldEvent) record.operatorStopped = true;
    }
    const drained = record.body?.stop(worldEvent || 'operator-stop');
    record.actionController?.abort(reason); record.task?.controller.abort(reason);
    haltNative(record.bot);
    if ((worldEvent === 'death' || worldEvent === 'respawn') && this.autonomousActive
      && authorization.session === this.autonomousSession && !record.operatorStopped && !authorization.faulted) {
      authorization.respawn = { ticket: this.captureActivation(record), session: this.autonomousSession,
        drained: drained ?? Promise.resolve() };
    }
    return drained ?? Promise.resolve();
  }

  async execute(name: string, raw: any, taskId?: string) {
    const record = this.get(name);
    if (record.body && NON_BODY_ACTIONS.has(raw?.type)) {
      if (!record.ready) throw new ApiError(503, '角色尚未进入世界。');
      const proposal = action(raw), started = Date.now();
      const details = await runNativeAction(record.bot, proposal, new AbortController().signal,
        (type, data) => this.event(record, type, data));
      const receipt = { id: randomUUID(), status: 'completed', action: proposal, details, durationMs: Date.now() - started };
      this.event(record, 'action', receipt); return receipt;
    }
    if (record.body && raw?.type !== 'stop') throw new ApiError(409, '双循环模式请通过body_plan提交身体目标；查询与说话仍可使用action。');
    return this.perform(name, raw, taskId);
  }

  /** Only the single-owner controller invokes this; model turn cancellation is not its signal. */
  async executeOwned(name: string, raw: any, signal: AbortSignal) {
    return this.perform(name, raw, undefined, signal);
  }

  private async perform(name: string, raw: any, taskId?: string, bodySignal?: AbortSignal) {
    const proposal = bodySignal ? validateBodyAction(raw) : action(raw);
    const record = this.get(name), bot = record.bot;
    if (proposal.type === 'stop') {
      record.waterPosture?.disable();
      if (record.body && taskId) throw new ApiError(409, '身体停止需要cancel_body和已观察的expectedVersion。');
      if (taskId && record.task?.id === taskId) {
        // A character choosing to stop walking is still allowed to finish its
        // reasoning turn. Only the operator's stop cancels the entire task.
        record.actionController?.abort(); haltNative(bot);
        const result = { id: randomUUID(), status: 'completed', action: proposal, details: { movementStopped: true } };
        this.event(record, 'action', result); return result;
      }
      await this.stop(record); return { status: 'completed', type: 'stop' };
    }
    if (!record.ready) throw new ApiError(503, '角色尚未进入世界。');
    if (record.actionController || (!bodySignal && record.task && record.task.id !== taskId)) throw new ApiError(409, '角色正在执行行动或 LLM 任务。');
    const controller = new AbortController();
    record.actionController = controller;
    record.waterPosture?.suspend();
    const ownerSignal = bodySignal ?? record.task?.controller.signal;
    const abort = () => controller.abort(ownerSignal?.reason);
    ownerSignal?.addEventListener('abort', abort, { once: true });
    if (ownerSignal?.aborted) abort();
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
    const actionTimeout = bodySignal ? bodyActionTimeoutMs(proposal) : proposal.type === 'fish' ? proposal.durationMs + 8000
      : ['gather', 'craft', 'smelt', 'container'].includes(proposal.type) ? 45000 : 15000;
    const timer = setTimeout(() => controller.abort(), actionTimeout);
    let details: any;
    try {
      checkSignal(controller.signal);
      if (proposal.type === 'posture') {
        record.waterPosture ??= new IdleWaterPosture(bot);
        record.waterPosture.suspend();
        const posture = proposal.mode === 'none' ? record.waterPosture.disable() : record.waterPosture.enable(proposal.durationMs);
        details = { posture, note: '姿态授权已更新，当前动作释放身体后才可生效；active只表示正在按跳跃，不证明已换气或到达水面。' };
      } else details = bodySignal
        ? await runContinuousSkill(bot, proposal, controller.signal, (type, data) => this.event(record, type, data))
        : await runNativeAction(bot, proposal, controller.signal, (type, data) => this.event(record, type, data));
      if (proposal.type === 'say' || proposal.type === 'broadcast') details = { ...details, communication: { ...NPC_COMMUNICATION },
        channel: proposal.type === 'broadcast' ? 'broadcast' : 'local', deliveryConfirmed: false,
        note: proposal.type === 'broadcast' ? '已通过服务器聊天发出世界广播；发出不证明任何同伴收到或同意，须由实际回应确认。'
          : '已发出本地说话，NPC听觉范围为同维度16格（含高差）；发出不证明任何同伴收到或同意，须由实际回应确认。' };
      checkSignal(controller.signal);
      const result = { id, status: 'completed', action: proposal, before, after: { ...bot.entity.position }, durationMs: Date.now() - started, details: withVitals(details) };
      this.event(record, 'action', result);
      return result;
    } catch (error: any) {
      const result = { id, status: controller.signal.aborted ? 'cancelled' : 'failed', action: proposal, before, after: { ...bot.entity.position }, error: error.message, details: withVitals(error.details ?? details), durationMs: Date.now() - started };
      this.event(record, 'action', result);
      if (error instanceof ApiError) throw error;
      return result;
    } finally {
      // Drain the native operation before releasing this lock: no orphaned action can
      // finish later and interfere with the next task after Promise.race returns.
      haltNative(bot);
      clearTimeout(timer); controller.signal.removeEventListener('abort', cancel);
      ownerSignal?.removeEventListener('abort', abort);
      record.actionController = undefined;
      if (!record.body) record.waterPosture?.resume();
    }
  }

  close() { this.endAutonomy(); for (const record of this.bots.values()) { this.stop(record); void record.body?.dispose(); record.waterPosture?.dispose(); record.viewer?.close(); record.bot.quit(); } this.listeners.clear(); }
}

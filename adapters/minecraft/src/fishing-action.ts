import { Vec3 } from 'vec3';
import { synchronizeServerQueue } from './craft-sync.ts';

// Compatibility implementation for Mineflayer 4.39.0 / Java 1.21.4. bot.fish()
// has no cancellation API and selects the first bobber regardless of owner.
// Keep native equip/lookAt/activateItem; own only this one cast's event wait.
// Official FishingHook.getAddEntityPacket uses owner.getId(), NOT id + 1.
// The registry's `biting` metadata is owner-specific, unlike public particles.
const unusable = new WeakSet<object>();
export const FISHING_LIMITS = Object.freeze({ range: 10, cleanupMs: 6000, spawnDrainMs: 800, pickupObservationMs: 1500 });

function counts(bot: any) {
  const result = new Map<string, number>();
  for (const item of bot.inventory.items()) result.set(item.name, (result.get(item.name) || 0) + item.count);
  return result;
}

function waterTarget(bot: any, position: any) {
  const cell = new Vec3(position.x, position.y, position.z), aim = cell.offset(.5, .9, .5);
  const eye = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0), ray = aim.minus(eye), distance = ray.norm();
  if (distance > FISHING_LIMITS.range) throw new Error('钓鱼水点超出眼位10格范围；未读取远处内容。');
  const block = bot.blockAt(cell);
  if (!block || block.name !== 'water' || !bot.canSeeBlock(block)) throw new Error('钓鱼目标必须是当前已加载且可见的实际水方块。');
  // Mineflayer raycast skips unloaded cells. Check this short sight line first.
  for (let d = 0; d <= distance; d += .15) if (!bot.blockAt(eye.plus(ray.scaled(distance ? d / distance : 0)).floored()))
    throw new Error('钓鱼水点视线经过未加载区域。');
  if (distance > .05 && bot.world.raycast(eye, ray.scaled(1 / distance), distance - .05)) throw new Error('钓鱼水点被方块遮挡。');
  return aim;
}

export async function fishOnce(bot: any, proposal: any, signal: AbortSignal) {
  if (bot.version !== '1.21.4') throw new Error('单次钓鱼目前仅验证 Java 1.21.4 的浮标归属和咬钩状态。');
  if (unusable.has(bot)) throw new Error('上次鱼钩收尾未确认，本连接不能再次钓鱼；请重新连接。');
  const bobberType = bot.registry.entitiesByName.fishing_bobber, bitingIndex = bobberType?.metadataKeys?.indexOf('biting');
  if (!(bitingIndex >= 0)) throw new Error('当前注册表没有已验证的鱼钩咬钩状态。');
  const owner = bot.entity, durationMs = proposal.durationMs ?? 30000, before = counts(bot);
  const details: any = { target: { ...proposal.position }, castSent: false, biteDetected: false, reelSent: false,
    hookId: null, hookRemoved: false, inventoryDelta: [], inventoryConfirmed: true, catchConfirmed: false,
    note: '只尝试一竿；咬钩和收线不等于入包，inventoryDelta是本次期间实际背包变化，不能排除附近其它拾取。' };
  let expired = false, disconnected = false, endedBody = false, outcome: string | undefined, operationError: any;
  let finishWait: (() => void) | undefined;
  const changes = new Set<() => void>(), changed = () => { for (const listener of [...changes]) listener(); };
  const finish = (reason: string) => { outcome ??= reason; finishWait?.(); changed(); };
  const onAbort = () => finish('cancelled');
  const onEnd = () => { disconnected = true; finish('disconnected'); };
  const onBodyEnd = () => { endedBody = true; finish('body_changed'); };
  const timer = setTimeout(() => { expired = true; finish('timeout'); }, durationMs);
  const check = () => {
    if (signal.aborted || expired || disconnected || endedBody || bot.entity !== owner || bot.health <= 0)
      throw new Error(expired ? '单次钓鱼已超时，未确认捕获。' : '单次钓鱼已取消或身体状态改变。');
  };
  const onSpawn = (packet: any) => {
    if (!details.castSent || details.hookId !== null || packet.type !== bobberType.id || packet.objectData !== owner.id) return;
    details.hookId = packet.entityId; changed();
  };
  const onMetadata = (packet: any) => {
    if (outcome || packet.entityId !== details.hookId) return;
    if (packet.metadata?.some((entry: any) => entry.key === bitingIndex && entry.value === true)) {
      details.biteDetected = true; finish('bite');
    }
  };
  const onDestroy = (packet: any) => {
    if (details.hookId !== null && packet.entityIds?.includes(details.hookId)) {
      details.hookRemoved = true; finish('hook_removed');
    }
  };
  const waitFor = (predicate: () => boolean, timeoutMs: number) => new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    const dispose = () => { clearTimeout(timeout); changes.delete(update); };
    const update = () => {
      if (predicate()) { dispose(); resolve(); }
      else if (disconnected) { dispose(); reject(new Error('钓鱼收尾期间连接关闭。')); }
    };
    timeout = setTimeout(() => { dispose(); reject(new Error('未等到服务器确认鱼钩状态。')); }, timeoutMs);
    changes.add(update); update();
  });
  signal.addEventListener('abort', onAbort, { once: true });
  bot._client.on('end', onEnd); bot.on('death', onBodyEnd); bot.on('respawn', onBodyEnd);
  bot._client.on('spawn_entity', onSpawn); bot._client.on('entity_metadata', onMetadata); bot._client.on('entity_destroy', onDestroy);
  try {
    check(); waterTarget(bot, proposal.position);
    const rod = bot.heldItem?.name === 'fishing_rod' ? bot.heldItem : bot.inventory.items().find((item: any) => item.name === 'fishing_rod');
    if (!rod) throw new Error('背包没有 fishing_rod。');
    if (bot.heldItem?.name !== 'fishing_rod') { await bot.equip(rod, 'hand'); check(); }
    await bot.lookAt(waterTarget(bot, proposal.position), true);
    check(); waterTarget(bot, proposal.position);
    if (bot.heldItem?.name !== 'fishing_rod' || !(bot.heldItem.count > 0)) throw new Error('等待期间主手鱼竿发生变化，未抛竿。');
    // Mark before the native synchronous write; listeners are already installed.
    details.castSent = true; bot.activateItem();
    if (!outcome) await new Promise<void>(resolve => { finishWait = resolve; });
    if (outcome !== 'bite') throw new Error(outcome === 'timeout' ? '单次钓鱼等待已超时，没有检测到自身鱼钩咬钩。' : '钓鱼已中止，未确认捕获。');
  } catch (error) { operationError = error; }
  finally {
    clearTimeout(timer);
    if (details.castSent) {
      const end = Date.now() + FISHING_LIMITS.cleanupMs;
      const remaining = () => {
        const ms = end - Date.now(); if (ms <= 0) throw new Error('鱼钩收尾超过时限。'); return ms;
      };
      try {
        if (disconnected) throw new Error('连接已关闭，鱼钩收尾未确认。');
        // Drain a late spawn before deciding whether another right-click would
        // reel our hook in. Never blindly toggle, since it could cast a new one.
        if (details.hookId === null) {
          await synchronizeServerQueue(bot, Math.min(5000, remaining()));
          if (details.hookId === null) await waitFor(() => details.hookId !== null, Math.min(FISHING_LIMITS.spawnDrainMs, remaining()));
        }
        if (!details.hookRemoved) {
          if (endedBody || bot.entity !== owner || bot.health <= 0) {
            await waitFor(() => details.hookRemoved, remaining());
          } else {
            if (bot.heldItem?.name !== 'fishing_rod') throw new Error('鱼竿不在主手，不能确认收线。');
            details.reelSent = true; bot.activateItem();
            const budget = remaining();
            const cleanup = await Promise.allSettled([
              waitFor(() => details.hookRemoved, budget),
              synchronizeServerQueue(bot, Math.min(5000, budget)),
            ]);
            const failure = cleanup.find((result): result is PromiseRejectedResult => result.status === 'rejected');
            if (failure) throw failure.reason;
          }
        }
        // A retrieved item still flies toward the player after hook removal.
        // Observe actual storage changes briefly; a stats barrier cannot advance
        // those future physics ticks. This wait never moves or starts a new cast.
        if (details.biteDetected && details.reelSent && !operationError && !signal.aborted && !endedBody) {
          const started = Date.now(), budget = Math.min(FISHING_LIMITS.pickupObservationMs, Math.max(0, end - started));
          const gain = () => [...counts(bot)].some(([item, count]) => count > (before.get(item) || 0));
          const status = await new Promise<string>(resolve => {
            let timeout: ReturnType<typeof setTimeout>;
            const finish = (status: string) => {
              clearTimeout(timeout); bot.inventory.removeListener('updateSlot', update); changes.delete(update); resolve(status);
            };
            const update = () => {
              if (signal.aborted || disconnected || endedBody) finish('interrupted');
              else if (gain()) finish('inventory_gain_observed');
            };
            timeout = setTimeout(() => finish('no_gain_observed_in_window'), budget);
            bot.inventory.on('updateSlot', update); changes.add(update); update();
          });
          details.pickupObservation = { status, waitMs: Date.now() - started, maxWaitMs: budget };
        }
      } catch (error: any) {
        unusable.add(bot); details.inventoryConfirmed = false;
        details.cleanupError = error.message; operationError ??= error;
      }
    }
    if (disconnected || endedBody || bot.entity !== owner) {
      details.inventoryConfirmed = false;
      operationError ??= new Error('钓鱼收尾期间连接或身体状态改变，当前结果未确认。');
    }
    signal.removeEventListener('abort', onAbort); bot._client.removeListener('end', onEnd);
    bot.removeListener('death', onBodyEnd); bot.removeListener('respawn', onBodyEnd);
    bot._client.removeListener('spawn_entity', onSpawn); bot._client.removeListener('entity_metadata', onMetadata); bot._client.removeListener('entity_destroy', onDestroy);
    finishWait = undefined;
    const after = counts(bot), delta = [...new Set([...before.keys(), ...after.keys()])]
      .map(item => ({ item, change: (after.get(item) || 0) - (before.get(item) || 0) })).filter(item => item.change !== 0);
    if (details.inventoryConfirmed) details.inventoryDelta = delta;
    else details.unconfirmedInventoryDelta = delta;
    details.outcome = outcome ?? (operationError ? 'failed_before_cast' : 'unknown');
    details.partial = details.castSent;
  }
  if (signal.aborted && !operationError) operationError = new Error('钓鱼已取消；已等待鱼钩收尾。');
  if (operationError) { operationError.details = details; throw operationError; }
  return details;
}

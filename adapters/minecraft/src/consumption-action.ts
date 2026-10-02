import { assertInventorySessionUsable, synchronizeServerQueue } from './craft-sync.ts';

export const CONSUMPTION_LIMITS = Object.freeze({ confirmationMs: 1000, queueMs: 3000 });
function counts(bot: any) {
  const result = new Map<string, number>();
  for (const item of bot.inventory.items()) result.set(item.name, (result.get(item.name) || 0) + item.count);
  return result;
}

/** Native consume may finish on entity_status=9 before its trailing inventory /
 * health packets, or on any heldItemChanged. Its promise alone proves neither a
 * consumed item nor nutrition. Keep one native use and confirm real state. */
export async function consumeHeldItem(bot: any, signal: AbortSignal) {
  if (signal.aborted) throw new Error('食用已取消。');
  assertInventorySessionUsable(bot);
  const selected = bot.heldItem;
  if (!selected) throw new Error('请先在主手装备食物。');
  const owner = bot.entity, before = counts(bot), edible = Boolean(bot.registry?.foodsByName?.[selected.name]);
  const details: any = { item: selected.name, nativeFinished: false, useCompleted: false, consumptionConfirmed: false,
    inventoryConfirmed: false, inventoryDelta: [], foodBefore: bot.food, food: bot.food, healthBefore: bot.health, health: bot.health,
    note: '原生使用结束不等于已吃掉；确认依据自身使用完成状态和真实物品减少，食物另等待饥饿回包，不等待回血。差异仅描述本次期间实际背包变化。' };
  let disconnected = false, bodyChanged = false, foodAfterUse = false, operationError: any, changed = () => {};
  let useInvoked = false, retracted = false;
  const stop = () => {
    if (!useInvoked || retracted || disconnected || bodyChanged || bot.entity !== owner) return;
    // inventory.js clears usingHeldItem even on another entity's status packet.
    // Retract this call once without trusting that local flag.
    retracted = true;
    try { bot.deactivateItem(); } catch { /* A closed connection cannot retract use. */ }
  };
  const abort = () => { stop(); changed(); };
  const end = () => { disconnected = true; changed(); };
  const bodyEnd = () => { bodyChanged = true; stop(); changed(); };
  const useStatus = (packet: any) => {
    if (packet.entityId === owner.id && packet.entityStatus === 9) { details.useCompleted = true; changed(); }
  };
  const health = () => { if (details.useCompleted) foodAfterUse = true; changed(); };
  const slot = () => changed();
  const confirmed = () => details.useCompleted && (counts(bot).get(selected.name) || 0) < (before.get(selected.name) || 0)
    && (!edible || foodAfterUse || bot.food !== details.foodBefore);
  signal.addEventListener('abort', abort, { once: true }); bot._client.on('end', end);
  bot.on('death', bodyEnd); bot.on('respawn', bodyEnd); bot._client.on('entity_status', useStatus);
  bot._client.on('update_health', health); bot.inventory.on('updateSlot', slot);
  try {
    try { useInvoked = true; await bot.consume(); details.nativeFinished = true; } catch (error) { operationError = error; }
    // No race releases the body early. Installed consume itself has a 2.5s
    // timeout; cancellation retracts use immediately and still drains it.
    stop();
    if (disconnected) throw new Error('食用期间连接关闭，库存结果未确认。');
    await synchronizeServerQueue(bot, CONSUMPTION_LIMITS.queueMs);
    details.inventoryConfirmed = true;
    if (!operationError && !signal.aborted && !bodyChanged && bot.entity === owner) {
      const started = Date.now();
      const status = await new Promise<string>(resolve => {
        let timer: ReturnType<typeof setTimeout>;
        const finish = (status: string) => { clearTimeout(timer); changed = () => {}; resolve(status); };
        changed = () => {
          if (signal.aborted || disconnected || bodyChanged || bot.entity !== owner) finish('interrupted');
          else if (confirmed()) finish('confirmed');
        };
        timer = setTimeout(() => finish('not_confirmed_in_window'), CONSUMPTION_LIMITS.confirmationMs); changed();
      });
      details.confirmation = { status, waitMs: Date.now() - started };
      if (disconnected) { details.inventoryConfirmed = false; throw new Error('等待食用结果期间连接关闭。'); }
    }
    details.consumptionConfirmed = details.inventoryConfirmed && !bodyChanged && confirmed();
    if (signal.aborted || bodyChanged || bot.entity !== owner) operationError ??= new Error('食用已取消或身体状态改变；原生操作已收尾。');
    if (!details.consumptionConfirmed) operationError ??= new Error('原生使用已结束，但未确认所持物品被食用及对应状态更新；请重新观察。');
  } catch (error) { details.inventoryConfirmed = false; operationError ??= error; }
  finally {
    stop(); changed = () => {};
    signal.removeEventListener('abort', abort); bot._client.removeListener('end', end);
    bot.removeListener('death', bodyEnd); bot.removeListener('respawn', bodyEnd); bot._client.removeListener('entity_status', useStatus);
    bot._client.removeListener('update_health', health); bot.inventory.removeListener('updateSlot', slot);
    const after = counts(bot), delta = [...new Set([...before.keys(), ...after.keys()])]
      .map(item => ({ item, change: (after.get(item) || 0) - (before.get(item) || 0) })).filter(item => item.change !== 0);
    if (details.inventoryConfirmed) details.inventoryDelta = delta; else details.unconfirmedInventoryDelta = delta;
    details.food = bot.food; details.health = bot.health;
  }
  if (operationError) { operationError.details = details; throw operationError; }
  return details;
}

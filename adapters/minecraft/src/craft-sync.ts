// Compatibility boundary for the installed Mineflayer 4.39.0 on Java 1.21.4.
// _syncWindow waits for ANY full-window packet. An older full packet can resolve
// it while this request and the final craft clicks are still on the server queue.
// Official 1.21.4 ServerGamePacketListenerImpl handles REQUEST_STATS on the same
// main thread as container clicks; ServerStatsCounter always sends its response.
// No Mineflayer/protocol plugin on this connection requests statistics in parallel.
const unusable = new WeakSet<object>();
const active = new WeakSet<object>();

export function inventorySessionUsable(bot: any): boolean { return !unusable.has(bot); }

export function craftWindowState(bot: any) {
  const item = (value: any) => value ? { item: value.name, count: value.count } : null;
  return {
    inputs: [1, 2, 3, 4].map(slot => ({ slot, stack: item(bot.inventory.slots?.[slot]) })),
    result: item(bot.inventory.slots?.[0]), cursor: item(bot.inventory.selectedItem),
  };
}

export function assertInventorySessionUsable(bot: any) {
  if (unusable.has(bot)) throw new Error('上次库存/窗口同步未完成，迟到回包不能确认新操作；需要重新连接后再操作库存。');
}

export function quarantineInventorySession(bot: any) { unusable.add(bot); }

export function synchronizeCraftInventory(bot: any, timeoutMs = 5000) {
  return synchronize(bot, true, timeoutMs);
}

// Same ordered, non-overlapping statistics request as crafting, without a
// window-0 request while a container is still the active server menu.
export function synchronizeServerQueue(bot: any, timeoutMs = 5000) {
  return synchronize(bot, false, timeoutMs);
}

async function synchronize(bot: any, inventory: boolean, timeoutMs: number) {
  assertInventorySessionUsable(bot);
  if (active.has(bot)) throw new Error('已有库存/窗口同步正在等待服务器。');
  if (bot.version !== '1.21.4' || typeof bot._syncWindow !== 'function' || !bot._client?.on || !bot._client?.write) {
    throw new Error('当前连接没有已验证的 1.21.4 库存/窗口同步能力。');
  }
  active.add(bot);
  const client = bot._client;
  let timer: ReturnType<typeof setTimeout>, cleanup = () => {}, fail = (_error: unknown) => {};
  const barrier = new Promise<void>((resolve, reject) => {
    const finished = () => { cleanup(); resolve(); };
    const disconnected = () => { cleanup(); reject(new Error('库存/窗口同步期间连接已关闭。')); };
    fail = (error: unknown) => { cleanup(); reject(error); };
    cleanup = () => { clearTimeout(timer); client.removeListener('statistics', finished); client.removeListener('end', disconnected); };
    client.on('statistics', finished); client.on('end', disconnected);
    timer = setTimeout(() => { cleanup(); reject(new Error('库存/窗口队列屏障超时；本连接不再重试库存操作。')); }, timeoutMs);
  });
  // Keep both promises under the body lock even on cancellation. A request has no
  // correlation ID; if it times out, quarantine this bot for the connection's
  // lifetime instead of allowing a late statistics packet to confirm a retry.
  let native: Promise<any> = Promise.resolve();
  try {
    if (inventory) native = Promise.resolve(bot._syncWindow(bot.inventory));
    client.write('client_command', { actionId: 'request_stats' });
  } catch (error) {
    fail(error);
  }
  const outcomes = await Promise.allSettled([native, barrier]);
  active.delete(bot);
  const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
  if (failure) { unusable.add(bot); throw failure.reason; }
}

import { assertInventorySessionUsable, quarantineInventorySession, synchronizeCraftInventory, synchronizeServerQueue } from './craft-sync.ts';

function ready(window: any) {
  // Installed inventory.prepareWindow adds these only after initial contents
  // have been applied. closeWindow copies its storage slots back to inventory.
  return typeof window?.deposit === 'function' && typeof window?.withdraw === 'function';
}

/** A body-owned scope: normal interactions release menus; managed actions keep
 * theirs until their native operation settles. No delay guesses or fake slots. */
async function scope<T>(bot: any, operation: () => Promise<T>, managed: boolean): Promise<T> {
  assertInventorySessionUsable(bot);
  let operating = true, closed = 0, managedClosed = false, cleanupError: unknown, unconfirmed = false;
  const closing: Promise<unknown>[] = [], seen = new WeakSet<object>();
  const close = (window: any) => {
    if (!window || seen.has(window) || bot.currentWindow !== window) return;
    seen.add(window); closed++;
    try { closing.push(Promise.resolve(bot.closeWindow(window)).catch(error => { cleanupError = error; })); }
    catch (error) { cleanupError = error; }
  };
  const onOpen = (window: any) => { if (!managed || !operating) close(window); };
  const onClose = () => { managedClosed = true; };
  const remove = () => { bot.removeListener('windowOpen', onOpen); bot.removeListener('windowClose', onClose); bot._client.removeListener('end', remove); };
  bot.on('windowOpen', onOpen); bot.on('windowClose', onClose); bot._client.once('end', remove);
  let value: T | undefined, operationError: unknown;
  try { value = await operation(); } catch (error) { operationError = error; }
  operating = false;
  try {
    // activateBlock resolves after writing, BEFORE open_window/window_items.
    // Their vanilla responses precede this barrier, even when no GUI opens.
    await synchronizeServerQueue(bot);
    const window = bot.currentWindow;
    if (window) {
      if (!ready(window)) throw new Error('容器初始内容尚未同步，不能复制空窗口覆盖背包；需要重新连接。');
      close(window);
    }
    await Promise.all(closing);
    if (cleanupError) throw cleanupError;
    // A close sent by onOpen may be behind the first stats request. Native
    // window-0 sync + the same barrier drains the close and trailing contents.
    if (closed || managedClosed) await synchronizeCraftInventory(bot);
    remove();
  } catch (error) {
    quarantineInventorySession(bot);
    unconfirmed = true;
    // Keep only this guarded cleanup listener until disconnect. If a timed-out
    // open arrives late, windowOpen guarantees its contents are ready; no later
    // inventory operation can start on this quarantined connection.
    if (!operationError) operationError = error;
  }
  if (operationError) {
    if (unconfirmed) {
      const error: any = operationError instanceof Error ? operationError : new Error(String(operationError));
      error.inventoryUnconfirmed = true;
      error.details = { ...error.details, inventoryConfirmed: false, inventoryDelta: [],
        note: '窗口关闭或库存同步尚未确认，不能把客户端预测视为已获得、消耗或丢失物品。' };
      throw error;
    }
    throw operationError;
  }
  return value as T;
}

export async function releaseUnmanagedWindow(bot: any) {
  assertInventorySessionUsable(bot);
  if (bot.currentWindow) await scope(bot, async () => {}, false);
}

export async function windowlessInteraction<T>(bot: any, signal: AbortSignal, operation: () => Promise<T>) {
  await releaseUnmanagedWindow(bot);
  if (signal.aborted) throw new Error('行动已取消或超时。');
  const value = await scope(bot, operation, false);
  if (signal.aborted) throw new Error('行动已取消或超时。');
  return value;
}

export async function managedWindowOperation<T>(bot: any, operation: () => Promise<T>) {
  await releaseUnmanagedWindow(bot);
  return scope(bot, operation, true);
}

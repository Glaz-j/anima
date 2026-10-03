const installed = new WeakSet<object>();

/** Mineflayer currently uses the newer input packet too early for 1.21.4 sneak. */
export function installSneakProtocolCompat(bot: any): void {
  if (installed.has(bot) || bot.version !== '1.21.4'
    || !bot.supportFeature?.('newPlayerInputPacket') || !bot.supportFeature?.('sneakUsesEntityAction')
    || typeof bot.setControlState !== 'function' || typeof bot.getControlState !== 'function') return;
  const setControlState = bot.setControlState, getControlState = bot.getControlState;
  const stringActions = bot.supportFeature('entityActionUsesStringMapper');
  bot.setControlState = function (this: any, control: string, state: boolean) {
    const before = control === 'sneak' ? getControlState.call(this, control) : undefined;
    const result = setControlState.call(this, control, state);
    if (control === 'sneak') {
      const after = getControlState.call(this, control);
      if (before !== after) bot._client.write('entity_action', {
        entityId: bot.entity.id,
        actionId: stringActions ? (after ? 'start_sneaking' : 'stop_sneaking') : (after ? 0 : 1),
        jumpBoost: 0,
      });
    }
    return result;
  };
  installed.add(bot);
}

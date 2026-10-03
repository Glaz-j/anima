/** Counts issued input changes, never physics ticks or repeated held-key writes.
 * These are control inputs, not proof of a hit, pickup, or successful placement. */
export function trackInputs(bot: any, emit: (event: any) => void = () => {}, now = Date.now) {
  const started = now(), times: number[] = [], counts: Record<string, number> = {};
  const restores: (() => void)[] = [];
  let total = 0, active = true;
  const record = (channel: string, value: unknown, discrete = true) => {
    if (!active) return;
    const at = now(); total++; counts[channel] = (counts[channel] || 0) + 1; times.push(at);
    while (times.length && times[0] < at - 60_000) times.shift();
    try { emit({ type: 'input', at, channel, value, discrete }); } catch { /* telemetry cannot control the body */ }
  };
  let installedControl: unknown, controlDepth = 0;
  const knownControls = new Map<string, boolean>();
  const installControls = () => {
    const control = bot.setControlState;
    if (!active || typeof control !== 'function' || control === installedControl) return;
    knownControls.clear();
    const wrapped = function (this: any, name: string, value: boolean) {
      // A later plugin can wrap the old decorated method. Reinstallation must
      // still record only the outermost invocation, not both layers of wrappers.
      if (controlDepth) return control.call(this, name, value);
      const before = this.getControlState?.(name) ?? knownControls.get(name) ?? false;
      controlDepth++;
      try {
        const result = control.call(this, name, value);
        knownControls.set(name, value);
        if (before !== value) record(`key:${name}`, value, false);
        return result;
      } finally { controlDepth--; }
    };
    installedControl = wrapped;
    bot.setControlState = wrapped;
    restores.push(() => { if (bot.setControlState === wrapped) bot.setControlState = control; });
  };
  // createBot injects physics asynchronously. Decorating only at construction
  // silently misses every key input on a real connection. Mineflayer's native
  // clearControlStates delegates to bot.setControlState, so releases are covered
  // by this same wrapper and must not receive a second recorder.
  const install = () => installControls();
  const afterInject = () => { install(); queueMicrotask(install); };
  bot.on?.('spawn', install);
  bot.on?.('inject_allowed', afterInject);
  install();
  // Count actual outgoing interaction packets. Position/physics packets are deliberately excluded.
  const client = bot._client, write = client?.write;
  let lastYaw: number | undefined, lastPitch: number | undefined;
  let lastSlot: number | undefined = Number.isInteger(bot.quickBarSlot) ? bot.quickBarSlot : undefined;
  if (typeof write === 'function') {
    const wrapped = function (this: any, name: string, params: any) {
      const result = write.call(this, name, params);
      if (['use_entity', 'block_place', 'use_item', 'window_click'].includes(name)) record(name, name);
      if (name === 'held_item_slot' && Number.isInteger(params?.slotId) && params.slotId !== lastSlot) {
        record(name, name); lastSlot = params.slotId;
      }
      if (name === 'block_dig' && params?.status === 0) record('dig-start', 'start');
      if (name === 'look' || name === 'position_look') {
        // One-degree changes suppress serialization noise, retaining meaningful aim adjustments.
        // Yaw wraps around 360 degrees; crossing the boundary is not a full turn.
        if (Number.isFinite(params?.yaw) && Number.isFinite(params?.pitch)
          && (lastYaw === undefined || Math.abs(((params.yaw - lastYaw) % 360 + 540) % 360 - 180) >= 1 || Math.abs(params.pitch - lastPitch!) >= 1)) {
          record('aim', 'changed'); lastYaw = params.yaw; lastPitch = params.pitch;
        }
      }
      return result;
    };
    client.write = wrapped;
    restores.push(() => { if (client.write === wrapped) client.write = write; });
  }
  return {
    /** Re-attach after explicitly replacing a control plugin between spawns. */
    install,
    snapshot() {
      const at = now(); while (times.length && times[0] < at - 60_000) times.shift();
      return { issuedInputs: total, inputApm: total * 60_000 / Math.max(1000, at - started),
        lastMinuteInputs: times.length, counts: { ...counts }, scope: 'issued-inputs-not-successful-effects' };
    },
    dispose() {
      active = false;
      bot.removeListener?.('spawn', install);
      bot.removeListener?.('inject_allowed', afterInject);
      for (const restore of restores.splice(0).reverse()) restore();
    },
  };
}

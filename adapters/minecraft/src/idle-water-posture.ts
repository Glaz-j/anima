import { Vec3 } from 'vec3';

export const WATER_POSTURE_MAX_MS = 120000;
const WATER = new Set(['water', 'flowing_water', 'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant', 'bubble_column']);
const END_EVENTS = ['death', 'respawn', 'end', 'kicked'] as const;

/** Only inspect the player's current water-contact volume, never nearby routes. */
function touchingWater(bot: any): boolean {
  const p = bot.entity?.position;
  if (!p || ![p.x, p.y, p.z].every(Number.isFinite) || bot.entity.isInWater !== true
    || bot.entity.isInLava === true || !(bot.health > 0) || typeof bot.blockAt !== 'function') return false;
  // Match the installed native player's contracted fluid-contact box. Checking
  // current cells also rejects a stale isInWater flag immediately after landing
  // or a server position correction, before the next physics step updates it.
  const half = .299, minY = p.y + .401, maxY = p.y + 1.399;
  let wet = false;
  try {
    for (let x = Math.floor(p.x - half); x <= Math.floor(p.x + half); x++) {
      for (let z = Math.floor(p.z - half); z <= Math.floor(p.z + half); z++) {
        for (let y = Math.floor(minY); y <= Math.floor(maxY); y++) {
          const block = bot.blockAt(new Vec3(x, y, z));
          if (!block) return false;
          const waterlogged = block.isWaterlogged === true;
          if (!WATER.has(block.name) && !waterlogged) continue;
          const flowing = ['water', 'flowing_water'].includes(block.name);
          const depth = flowing && Number.isInteger(block.metadata) && block.metadata >= 0 && block.metadata < 8 ? block.metadata : 0;
          const surface = y + 1 - (depth + 1) / 9;
          if (minY < surface && maxY > y) wet = true;
        }
      }
    }
    return wet;
  } catch { return false; }
}

/**
 * An explicit, expiring input lease, not an autonomous survival policy.
 * The owner MUST suspend before lending the body to an action, and resume only
 * after that action has drained and cleared its controls. A task/LLM turn alone
 * is not body ownership. This class never writes position, velocity or oxygen.
 */
export class IdleWaterPosture {
  private bot: any;
  private expires = 0;
  private suspended = false;
  private ownsJump = false;
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly tick = () => this.update();
  private readonly end = () => { this.disable(); };

  constructor(bot: any) {
    this.bot = bot;
    bot.on('physicsTick', this.tick);
    bot.on('forcedMove', this.tick);
    for (const event of END_EVENTS) bot.on(event, this.end);
  }

  enable(durationMs = 60000) {
    if (this.disposed) throw new Error('Floating posture has been disposed.');
    if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > WATER_POSTURE_MAX_MS)
      throw new Error('Floating posture duration must be an integer from 1 to 120000 milliseconds.');
    clearTimeout(this.timer);
    this.expires = Date.now() + durationMs;
    this.timer = setTimeout(() => { this.disable(); }, durationMs);
    this.timer.unref?.();
    this.update();
    return this.snapshot();
  }

  disable() {
    clearTimeout(this.timer); this.timer = undefined; this.expires = 0;
    this.releaseJump();
    return this.snapshot();
  }

  suspend() {
    this.suspended = true;
    this.releaseJump();
    return this.snapshot();
  }

  resume() {
    this.suspended = false;
    this.update();
    return this.snapshot();
  }

  snapshot() {
    const remainingMs = Math.max(0, this.expires - Date.now());
    return { mode: remainingMs > 0 ? 'tread_water' as const : 'none' as const,
      active: this.ownsJump && remainingMs > 0, suspended: this.suspended,
      expiresAt: remainingMs > 0 ? new Date(this.expires).toISOString() : null, remainingMs };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.disable();
    this.bot.removeListener('physicsTick', this.tick);
    this.bot.removeListener('forcedMove', this.tick);
    for (const event of END_EVENTS) this.bot.removeListener(event, this.end);
  }

  private releaseJump() {
    if (!this.ownsJump) return;
    this.ownsJump = false;
    try { this.bot.setControlState('jump', false); } catch { /* disconnected */ }
    // Mineflayer's false control write does not clear its one-tick jump queue.
    // This queue is ours only while holding the input lease, before another
    // action can acquire it via suspend(). Never clear an active action's queue.
    this.bot.jumpQueued = false;
  }

  private update() {
    if (this.disposed) return;
    if (this.expires && Date.now() >= this.expires) { this.disable(); return; }
    if (!this.expires || this.suspended || !touchingWater(this.bot)) { this.releaseJump(); return; }
    try {
      if (!this.ownsJump) {
        // Do not adopt an existing jump/queued pulse that belongs to an action.
        if (this.bot.getControlState('jump') || this.bot.jumpQueued === true) return;
        this.ownsJump = true;
      }
      this.bot.setControlState('jump', true);
    } catch { this.disable(); }
  }
}

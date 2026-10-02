// Own the iframe lifetime separately from API polling and NPC selection rendering.
export class CameraSession {
  constructor({ mount, onState, now = Date.now,
    schedule = (callback, ms) => setTimeout(callback, ms), unschedule = timer => clearTimeout(timer) }) {
    Object.assign(this, { mount, onState, now, schedule, unschedule });
    this.sequence = 0;
    this.current = null;
  }

  select(base, npc, { force = false } = {}) {
    const key = base && npc ? `${base}|${npc}` : '';
    if (!force && key === this.key && (this.current || !key)) return;
    this.key = key;
    this.release();
    if (!key) { this.onState('error', '画面服务尚未就绪。'); return; }
    this.base = base; this.npc = npc;
    this.start(0);
  }

  start(attempt) {
    this.release();
    const sessionId = `${++this.sequence}-${this.now()}`;
    const url = new URL(this.base);
    url.searchParams.set('npc', this.npc);
    url.searchParams.set('sessionId', sessionId);
    const session = this.current = { sessionId, npc: this.npc, attempt, origin: url.origin,
      loadingAt: this.now(), updatedAt: this.now(), phase: 'connecting', frame: null };
    this.onState('connecting', attempt ? `正在重新连接画面（${attempt}/2）…` : '正在接收真实世界画面…');
    try { session.frame = this.mount(url.href, session.npc, sessionId); }
    catch { this.retry(session, '无法创建观察画面。'); return; }
    this.watch(session);
  }

  receive(event) {
    const session = this.current, data = event.data;
    if (!session?.frame || event.origin !== session.origin || event.source !== session.frame.window ||
      data?.type !== 'anima-viewer-status' || data.npc !== session.npc || data.sessionId !== session.sessionId) return false;
    if (!['connecting', 'loading', 'live', 'waiting', 'disconnected', 'error'].includes(data.status)) return false;
    if (['connecting', 'loading'].includes(data.status) && !['connecting', 'loading'].includes(session.phase)) session.loadingAt = this.now();
    session.phase = data.status; session.updatedAt = this.now();
    this.onState(data.status, typeof data.message === 'string' ? data.message.slice(0, 300) : undefined);
    if (data.status === 'error' || data.status === 'disconnected') this.retry(session, data.message);
    else if (data.status === 'live' || data.status === 'waiting') { session.retryPending = false; this.watch(session); }
    return true;
  }

  watch(session) {
    this.unschedule(this.timer);
    this.timer = this.schedule(() => {
      if (this.current !== session) return;
      const elapsed = this.now() - session.loadingAt, silence = this.now() - session.updatedAt;
      if (session.phase === 'live' && silence > 10000) this.retry(session, '画面同步已中断。');
      else if (['connecting', 'loading'].includes(session.phase) && elapsed > 25000) this.retry(session, '画面没有响应。');
      else this.watch(session);
    }, 1000);
  }

  retry(session, message) {
    if (this.current !== session || session.retryPending) return;
    session.retryPending = true;
    this.unschedule(this.timer);
    if (session.attempt >= 2) { this.onState('error', `${message || '画面连接失败。'} 请点击重新连接。`); return; }
    this.onState('connecting', `${message || '画面连接中断。'} 正在恢复…`);
    this.timer = this.schedule(() => { if (this.current === session) this.start(session.attempt + 1); }, 1000 * (session.attempt + 1));
  }

  release() {
    this.unschedule(this.timer);
    const session = this.current;
    this.current = null;
    if (!session?.frame) return;
    try { session.frame.window?.postMessage({ type: 'anima-viewer-dispose', npc: session.npc, sessionId: session.sessionId }, session.origin); } catch {}
    session.frame.remove();
  }
}

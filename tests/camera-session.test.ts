import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { CameraSession } from '../adapters/minecraft/public/camera-session.js';

function fixture({ visible = true } = {}) {
  let now = 1000, id = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const frames: any[] = [], states: any[] = [];
  const controller = new CameraSession({
    visible,
    now: () => now,
    schedule(callback: () => void, ms: number) { const key = ++id; timers.set(key, { at: now + ms, callback }); return key; },
    unschedule(key: number) { timers.delete(key); },
    mount(url: string, npc: string, sessionId: string) {
      const frame = { url, npc, sessionId, removed: false, messages: [] as any[],
        window: { postMessage(data: any, origin: string) { frame.messages.push({ data, origin }); } },
        remove() { frame.removed = true; },
      };
      frames.push(frame); return frame;
    },
    onState(status: string, message: string) { states.push({ status, message }); },
  });
  function advance(ms: number) {
    const end = now + ms;
    for (;;) {
      const entry = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      timers.delete(entry[0]); now = Math.max(now, entry[1].at); entry[1].callback();
    }
    now = end;
  }
  const select = (npc: string, force = false) => controller.select('http://127.0.0.1:18792', npc, { force });
  const message = (frame: any, status = 'live') => ({ origin: 'http://127.0.0.1:18792', source: frame.window,
    data: { type: 'anima-viewer-status', npc: frame.npc, sessionId: frame.sessionId, status } });
  const stall = (ms: number) => { now += ms; advance(0); };
  return { controller, frames, states, timers, advance, stall, select, message };
}

test('each NPC change removes the old browsing context and repeated API refresh does not reload it', () => {
  const f = fixture(); f.select('Sherlock'); const first = f.frames[0];
  f.select('Sherlock'); assert.equal(f.frames.length, 1);
  f.select('Deadpool');
  assert.equal(first.removed, true); assert.equal(f.frames.filter(frame => !frame.removed).length, 1);
  assert.equal(first.messages[0].data.type, 'anima-viewer-dispose');
  assert.equal(first.messages[0].data.sessionId, first.sessionId);
  assert.notEqual(f.frames[1].window, first.window);
  assert.equal(new URL(f.frames[1].url).searchParams.get('npc'), 'Deadpool');
});

test('old, foreign and same-NPC previous session messages cannot relabel the current camera', () => {
  const f = fixture(); f.select('Sherlock'); const old = f.frames[0]; f.select('Sherlock', true); const fresh = f.frames[1];
  assert.equal(f.controller.receive(f.message(old)), false);
  assert.equal(f.controller.receive({ ...f.message(fresh), origin: 'http://example.com' }), false);
  assert.equal(f.controller.receive({ ...f.message(fresh), data: { ...f.message(fresh).data, sessionId: old.sessionId } }), false);
  assert.equal(f.controller.receive(f.message(fresh)), true);
  assert.equal(f.states.at(-1).status, 'live');
});

test('a frame that never boots gets two bounded fresh-frame retries without API polling', () => {
  const f = fixture(); f.select('Deadpool'); f.advance(90000);
  assert.equal(f.frames.length, 3); assert.equal(f.states.at(-1).status, 'error');
  assert.equal(f.timers.size, 0); assert.equal(f.frames.filter(frame => !frame.removed).length, 1);
  f.select('Deadpool', true); assert.equal(f.frames.length, 4); assert.equal(f.states.at(-1).status, 'connecting');
});

test('rapid switches cancel pending retries; old NPCs never return after the last selection', () => {
  const f = fixture(); f.select('Sheldon'); f.controller.receive(f.message(f.frames[0], 'error'));
  for (const npc of ['Sherlock', 'Deadpool', 'HuYifei']) f.select(npc);
  f.controller.receive(f.message(f.frames.at(-1)));
  f.advance(4000);
  assert.equal(f.frames.length, 4); assert.equal(f.frames.at(-1).npc, 'HuYifei');
  assert.equal(f.frames.filter(frame => !frame.removed).length, 1);
});

test('live heartbeat keeps one context; loss of heartbeat recovers and a reconnect cancels pending retry', () => {
  const f = fixture(); f.select('Sheldon'); const frame = f.frames[0];
  for (let i = 0; i < 20; i++) { f.controller.receive(f.message(frame)); f.advance(2000); }
  assert.equal(f.frames.length, 1);
  f.controller.receive(f.message(frame, 'disconnected')); f.advance(500);
  f.controller.receive(f.message(frame)); f.advance(2000);
  assert.equal(f.frames.length, 1);
  f.advance(12000); assert.equal(f.frames.length, 2); assert.equal(frame.removed, true);
});

test('release is idempotent and cancels all further recovery and status messages', () => {
  const f = fixture(); f.select('HuYifei'); const frame = f.frames[0];
  f.controller.release(); f.controller.release(); f.advance(90000);
  assert.equal(frame.messages.length, 1); assert.equal(f.frames.length, 1); assert.equal(f.timers.size, 0);
  assert.equal(f.controller.receive(f.message(frame)), false);
  f.select('HuYifei'); assert.equal(f.frames.length, 2, 'Restoring a page can recreate its released camera.');
});

test('respawn after a long live session receives a fresh loading budget', () => {
  const f = fixture(); f.select('Sheldon'); const frame = f.frames[0];
  for (let i = 0; i < 40; i++) { f.controller.receive(f.message(frame)); f.advance(2000); }
  f.controller.receive(f.message(frame, 'waiting')); f.advance(4000);
  f.controller.receive(f.message(frame, 'loading')); f.advance(20000);
  assert.equal(f.frames.length, 1, 'Previous live time cannot expire a new dimension load.');
  f.controller.receive(f.message(frame)); assert.equal(f.states.at(-1).status, 'live');
});

test('default timers do not pass the controller as the browser native receiver', async () => {
  const source = await readFile(new URL('../adapters/minecraft/public/camera-session.js', import.meta.url), 'utf8');
  let scheduled = 0, cleared = 0;
  vm.runInNewContext(source.replace('export class CameraSession', 'class CameraSession') + `
    const camera = new CameraSession({ mount: () => ({ remove() {} }), onState() {} });
    camera.select('http://127.0.0.1:18792', 'Sheldon');
    camera.release();
  `, { URL, Date,
    setTimeout: function (this: unknown) { assert.equal(this, undefined); scheduled++; return 1; },
    clearTimeout: function (this: unknown) { assert.equal(this, undefined); cleared++; },
  });
  assert.equal(scheduled, 1); assert.ok(cleared > 0);
});

test('background time does not expire a live camera or a loading camera', () => {
  for (const phase of ['live', 'loading']) {
    const f = fixture(); f.select('Sherlock'); const frame = f.frames[0];
    f.controller.receive(f.message(frame, phase)); f.advance(3000);
    f.controller.setVisible(false); f.advance(5 * 60000);
    assert.equal(f.frames.length, 1); assert.equal(f.timers.size, 0);
    f.controller.setVisible(true); f.advance(9000);
    assert.equal(f.frames.length, 1, 'Restoring a tab preserves its existing renderer.');
    f.controller.receive(f.message(frame)); f.advance(2000);
    assert.equal(f.frames.length, 1); assert.equal(f.states.at(-1).status, 'live');
  }
});

test('a page opened in the background gets its full first loading budget when shown', () => {
  const f = fixture({ visible: false }); f.select('Deadpool'); f.advance(10 * 60000);
  assert.equal(f.frames.length, 1); assert.equal(f.timers.size, 0);
  f.controller.setVisible(true); f.advance(24000);
  assert.equal(f.frames.length, 1);
  f.controller.receive(f.message(f.frames[0])); f.advance(2000);
  assert.equal(f.states.at(-1).status, 'live'); assert.equal(f.frames.length, 1);
});

test('hiding cancels a queued retry and live recovery on return keeps the same frame', () => {
  const f = fixture(); f.select('Sheldon'); const frame = f.frames[0];
  f.controller.receive(f.message(frame, 'disconnected')); f.advance(500);
  f.controller.setVisible(false); f.advance(5 * 60000);
  assert.equal(f.frames.length, 1); assert.equal(f.timers.size, 0);
  f.controller.setVisible(true); f.advance(9000);
  assert.equal(f.frames.length, 1);
  f.controller.receive(f.message(frame)); f.advance(4000);
  assert.equal(f.frames.length, 1); assert.equal(f.states.at(-1).status, 'live');
});

test('errors received while hidden wait for visibility and a genuinely broken camera still has bounded retries', () => {
  const f = fixture({ visible: false }); f.select('HuYifei');
  f.controller.receive(f.message(f.frames[0], 'error')); f.advance(5 * 60000);
  assert.equal(f.frames.length, 1); assert.equal(f.timers.size, 0);
  f.controller.setVisible(true); f.advance(9000);
  assert.equal(f.frames.length, 1);
  f.advance(90000);
  assert.equal(f.frames.length, 3); assert.equal(f.states.at(-1).status, 'error');
  assert.equal(f.timers.size, 0);
});

test('visibility handshake is scoped to the authenticated child and follows viewport return without rebuilding', () => {
  const f = fixture({ visible: false }); f.select('Sherlock'); const frame = f.frames[0];
  assert.equal(frame.messages.length, 0, 'Mounting alone cannot assume the child document is ready.');
  const foreign = { ...f.message(frame, 'loading'), source: {} };
  assert.equal(f.controller.receive(foreign), false); assert.equal(frame.messages.length, 0);
  f.controller.receive(f.message(frame, 'loading'));
  assert.deepEqual(frame.messages[0], { origin: 'http://127.0.0.1:18792', data: {
    type: 'anima-viewer-visibility', npc: 'Sherlock', sessionId: frame.sessionId, visible: false,
  } });
  f.controller.receive(f.message(frame, 'loading')); assert.equal(frame.messages.length, 1, 'Do not reset a child on every heartbeat.');
  f.advance(60000); f.controller.setVisible(true);
  assert.equal(frame.messages.at(-1).data.visible, true); f.advance(20000);
  f.controller.receive(f.message(frame)); assert.equal(f.frames.length, 1);
  f.controller.setVisible(false); f.advance(60000); f.controller.setVisible(true);
  assert.deepEqual(frame.messages.map((row: any) => row.data.visible), [false, true, false, true]);
  f.controller.receive(f.message(frame)); f.advance(2000);
  assert.equal(f.frames.length, 1);
});

test('returning from computer sleep refreshes both clocks before testing live or loading timeouts', () => {
  for (const phase of ['live', 'loading']) {
    const f = fixture(); f.select('Deadpool'); const frame = f.frames[0];
    f.controller.receive(f.message(frame, phase)); f.stall(5 * 60000);
    assert.equal(f.frames.length, 1); assert.equal(frame.messages.at(-1).data.type, 'anima-viewer-visibility');
    assert.equal(frame.messages.at(-1).data.visible, true);
    f.advance(9000); f.controller.receive(f.message(frame)); f.advance(2000);
    assert.equal(f.frames.length, 1); assert.equal(f.states.at(-1).status, 'live');
  }
});

test('a retry timer delayed by sleep gives the old frame a chance to recover and still bounds genuine failure', () => {
  for (const recover of [true, false]) {
    const f = fixture(); f.select('Sheldon'); const frame = f.frames[0];
    f.controller.receive(f.message(frame, 'disconnected')); f.stall(5 * 60000);
    assert.equal(f.frames.length, 1); f.advance(9000); assert.equal(f.frames.length, 1);
    if (recover) {
      f.controller.receive(f.message(frame)); f.advance(2000);
      assert.equal(f.frames.length, 1); assert.equal(f.states.at(-1).status, 'live');
    } else {
      f.advance(90000); assert.equal(f.frames.length, 3);
      assert.equal(f.states.at(-1).status, 'error'); assert.equal(f.timers.size, 0);
    }
  }
});

test('a delayed disconnect arriving after visibility returns cannot skip the recovery grace', () => {
  for (const recover of [true, false]) {
    const f = fixture(); f.select('Sherlock'); const frame = f.frames[0];
    f.controller.receive(f.message(frame)); f.controller.setVisible(false); f.advance(5 * 60000);
    f.controller.setVisible(true); f.advance(500);
    f.controller.receive(f.message(frame, 'disconnected')); f.advance(8000);
    assert.equal(f.frames.length, 1, 'A newly delivered disconnect must allow fresh packets to recover.');
    if (recover) {
      f.controller.receive(f.message(frame)); f.advance(4000);
      assert.equal(f.frames.length, 1); assert.equal(f.states.at(-1).status, 'live');
    } else {
      f.advance(2500); assert.equal(f.frames.length, 2, 'A real disconnect still retries after the grace expires.');
      f.advance(90000); assert.equal(f.frames.length, 3); assert.equal(f.states.at(-1).status, 'error');
    }
  }
});

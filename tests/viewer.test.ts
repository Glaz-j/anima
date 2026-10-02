import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { attachViewerStream, startViewerService, viewerRequestAllowed } from '../adapters/minecraft/src/viewer.ts';
import { patchViewerBundle, replaceViewerEntry } from '../adapters/minecraft/src/viewer-assets.ts';

const require = createRequire(import.meta.url);
const { Vec3 } = require('vec3');
const { io } = require('socket.io-client');
const turn = () => new Promise(resolve => setImmediate(resolve));
function record(name = 'Sheldon') {
  const bot: any = new EventEmitter();
  bot.entity = { id: 1, position: new Vec3(0.5, -20, 0.5), yaw: 0 };
  bot.version = '1.21.4'; bot.world = { getColumnAt: async () => null };
  bot.entities = { 1: bot.entity }; bot.game = { dimension: 'overworld' }; bot.username = name;
  return { name, bot, ready: true, events: [] } as any;
}
class Socket extends EventEmitter {
  handshake = { auth: { npc: 'Sheldon' } }; output: any[] = [];
  emit(name: string, ...args: any[]) { this.output.push([name, ...args]); return super.emit(name, ...args); }
  disconnect() { this.emit('disconnect'); }
}
function waitEvent(socket: any, event: string) {
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Missing ${event}`)), 4000);
    socket.once(event, (value: any) => { clearTimeout(timer); resolve(value); });
  });
}

test('viewer isolates the selected bot and discards old-world async output on respawn', async () => {
  const selected = record(), other = record('Sherlock'), socket = new Socket(), views: any[] = [];
  const makeView = (bot: any, emitter: any) => {
    let done: () => void;
    const handler = () => emitter.emit('entity', { id: 8 });
    const view = { emitter, done: () => done(), listenToBot: () => bot.on('entityMoved', handler),
      removeListenersFromBot: () => bot.removeListener('entityMoved', handler),
      updatePosition: async () => {}, init: () => new Promise<void>(resolve => { done = resolve; }) };
    views.push(view); return view;
  };
  const close = attachViewerStream(socket, name => name === 'Sheldon' ? selected : other, makeView);
  assert.equal(selected.bot.listenerCount('move'), 1); assert.equal(other.bot.eventNames().length, 0);
  assert.equal(socket.output.find(row => row[0] === 'position')[1].pos.y, -20);
  assert.equal(socket.output.find(row => row[0] === 'position')[1].pitch, undefined);
  selected.ready = false; selected.bot.emit('respawn');
  const boundary = socket.output.length;
  views[0].emitter.emit('loadChunk', { marker: 'old world' }); views[0].done(); await turn();
  assert.equal(socket.output.length, boundary);
  selected.ready = true; selected.bot.world = {}; selected.bot.game.dimension = 'the_nether'; selected.bot.emit('spawn');
  assert.equal(views.length, 2); assert.equal(selected.bot.listenerCount('move'), 1);
  views[1].emitter.emit('loadChunk', { marker: 'new world' }); views[1].done(); await turn();
  assert.ok(socket.output.some(row => row[0] === 'loadChunk' && row[1].marker === 'new world'));
  assert.ok(socket.output.some(row => row[0] === 'viewer-world-ready'));
  socket.disconnect(); close();
  assert.equal(selected.bot.eventNames().length, 0); assert.equal(socket.listenerCount('disconnect'), 0);
});

test('not-ready/dead NPC has no chunk subscription until its real spawn', async () => {
  const actor = record(), socket = new Socket(); actor.ready = false;
  let reads = 0; actor.bot.world.getColumnAt = async () => { reads++; return null; };
  const close = attachViewerStream(socket, () => actor);
  await turn(); assert.equal(reads, 0);
  const ready = waitEvent(socket, 'viewer-world-ready');
  actor.ready = true; actor.bot.emit('spawn'); await ready;
  assert.ok(reads > 0);
  actor.ready = false; actor.bot.emit('death'); const count = reads;
  actor.bot.emit('move'); await turn(); assert.equal(reads, count);
  close(); assert.equal(actor.bot.listenerCount('chunkColumnLoad'), 0);
});

test('real viewer service streams actual negative-height chunks and entities; clients cannot act', async () => {
  const actor = record(), other = record('Sherlock');
  const Chunk = require('prismarine-chunk')('1.21.4');
  const chunk = new Chunk({ minY: -64, worldHeight: 384 });
  const data = require('minecraft-data')('1.21.4');
  chunk.setBlockStateId(new Vec3(0, -21, 0), data.blocksByName.stone.defaultState);
  actor.bot.world.getColumnAt = async (position: any) => position.x === 0 && position.z === 0 ? chunk : null;
  actor.bot.entities[2] = { id: 2, name: 'pig', position: new Vec3(1, -20, 1), width: 0.9, height: 0.9 };
  const service = await startViewerService({ port: 0, apiPort: 18791, getRecord: name => name === 'Sheldon' ? actor : name === 'Sherlock' ? other : undefined });
  const socket = io(service.url, { autoConnect: false, transports: ['websocket'], auth: { npc: 'Sheldon' }, extraHeaders: { Origin: 'http://127.0.0.1:18791' }, reconnection: false });
  try {
    const chunkEvent = waitEvent(socket, 'loadChunk'), entityEvent = waitEvent(socket, 'entity'), ready = waitEvent(socket, 'viewer-world-ready');
    socket.connect(); const [loaded, entity] = await Promise.all([chunkEvent, entityEvent, ready]);
    assert.equal(loaded.x, 0); assert.equal(loaded.z, 0);
    const restored = Chunk.fromJson(loaded.chunk);
    assert.equal(restored.getBlockStateId(new Vec3(0, -21, 0)), data.blocksByName.stone.defaultState);
    assert.equal(entity.id, 2); assert.equal(other.bot.eventNames().length, 0);
    socket.emit('mouseClick', { origin: { x: 0, y: -20, z: 0 }, direction: { x: 1, y: 0, z: 0 } });
    socket.emit('action', { type: 'dig', x: 0, y: -21, z: 0 });
    await turn(); assert.equal(actor.bot.listenerCount('mouseClick'), 0);
    const page = await fetch(service.url + '/?npc=Sheldon'); assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(page.headers.get('content-security-policy')!, /script-src 'self' 'unsafe-eval';/u);
    assert.match(page.headers.get('content-security-policy')!, /worker-src 'self';/u);
    assert.doesNotMatch(page.headers.get('content-security-policy')!, /unsafe-inline|https:|connect-src \*/u);
    assert.match(await page.text(), /anima-api-port.*18791/u);
    assert.equal((await fetch(service.url, { headers: { Origin: 'https://outside.invalid' } })).status, 403);
    const deniedHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(service.url, { headers: { Host: 'outside.invalid' } }, response => { response.resume(); resolve(response.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(deniedHost, 403);
    assert.equal((await fetch(service.url + '/actions', { method: 'POST' })).status, 405);
    const bundleResponse = await fetch(service.url + '/index.js');
    assert.match(bundleResponse.headers.get('content-type')!, /^(?:application|text)\/javascript\b/u);
    const workerResponse = await fetch(service.url + '/worker.js');
    assert.match(workerResponse.headers.get('content-type')!, /^(?:application|text)\/javascript\b/u);
    assert.equal(workerResponse.headers.get('content-security-policy'), page.headers.get('content-security-policy'));
    assert.match(workerResponse.headers.get('content-security-policy')!, /connect-src 'self' ws:\/\/127\.0\.0\.1:\d+ ws:\/\/localhost:\d+;/u);
    for (const [path, response] of [['index.js', bundleResponse], ['worker.js', workerResponse]] as const) {
      assert.equal(response.headers.get('cache-control'), 'no-cache');
      assert.ok(response.headers.get('etag'));
      // Node fetch adds request Cache-Control:no-cache to conditional requests;
      // use a normal HTTP revalidation, as the browser cache does for these URLs.
      const cached = await new Promise<{ status?: number; body: string }>((resolve, reject) => {
        const req = httpRequest(service.url + '/' + path, { headers: { 'If-None-Match': response.headers.get('etag')! } }, res => {
          let body = ''; res.on('data', part => { body += part; }); res.on('end', () => resolve({ status: res.statusCode, body }));
        }); req.on('error', reject); req.end();
      });
      assert.equal(cached.status, 304); assert.equal(cached.body, '');
    }
    const clientResponse = await fetch(service.url + '/viewer-client.js');
    assert.equal(clientResponse.headers.get('cache-control'), 'no-store'); await clientResponse.text();
    const bundled = await bundleResponse.text();
    assert.match(bundled, /window\.AnimaViewerStart/u); new vm.Script(bundled);
    socket.disconnect(); await turn();
  } finally { socket.disconnect(); await service.close(); }
  assert.equal(actor.bot.eventNames().length, 0);
});

test('viewer Host/Origin and socket NPC validation reject unrelated callers', async () => {
  assert.equal(viewerRequestAllowed('127.0.0.1:18792', 'http://localhost:18791', 18792, 18791), true);
  for (const origin of ['null', 'https://localhost:18791', 'http://127.0.0.1:8080', 'https://evil.test']) {
    assert.equal(viewerRequestAllowed('127.0.0.1:18792', origin, 18792, 18791), false);
  }
  const service = await startViewerService({ port: 0, apiPort: 18791, getRecord: () => undefined });
  const socket = io(service.url, { autoConnect: false, transports: ['websocket'], auth: { npc: 'Absent' }, reconnection: false });
  try { const rejected = waitEvent(socket, 'connect_error'); socket.connect(); assert.match((await rejected).message, /角色/u); }
  finally { socket.disconnect(); await service.close(); }
});

test('pinned bundle entry replacement is fail-closed and preserves height patches', async () => {
  const directory = dirname(require.resolve('prismarine-viewer/package.json'));
  const original = await readFile(join(directory, 'public/index.js'), 'utf8');
  const patched = replaceViewerEntry(patchViewerBundle('index.js', original));
  assert.equal((patched.match(/=-64;/gu) || []).length, 2);
  assert.match(patched, /WorldRenderer:class\{constructor\(t,e=2\)\{this\.sectionMeshs/u);
  assert.throws(() => patchViewerBundle('index.js', original.replace('WorldRenderer:class{constructor(t,e=4)', 'WorldRenderer:class{constructor(t,e=3)')), /worker constructor/u);
  new vm.Script(patched);
  assert.throws(() => replaceViewerEntry('upstream changed'));
});

test('third-person client follows real motion and cleans up scoped workers, async assets and WebGL on an authenticated dispose', async () => {
  const source = await readFile(new URL('../adapters/minecraft/viewer/viewer-client.js', import.meta.url), 'utf8');
  const THREE = require('three'); const socket = new EventEmitter(); (socket as any).disconnect = () => socket.emit('disconnect');
  const messages: any[] = [], callbacks: any = {}, frames: (() => void)[] = [], textureLoads: any[] = [], fetches: any[] = [];
  let view: any, control: any, disposed = 0, contextLoss = 0, viewCount = 0, now = 1000, raycasts = 0, renderError = false;
  const fakeThree = { ...THREE, DefaultLoadingManager: {},
    WebGLRenderer: class { domElement = { addEventListener() {}, removeEventListener() {}, remove() {} }; setPixelRatio() {} setSize() {} render() { if (renderError) throw new Error('render fixture failure'); } dispose() { disposed++; } forceContextLoss() { contextLoss++; } },
    OrbitControls: class { target = new THREE.Vector3(); object: any; constructor(camera: any) { control = this; this.object = camera; } update() {} dispose() { disposed++; } },
    Raycaster: class extends THREE.Raycaster { intersectObjects(...args: any[]) { raycasts++; return super.intersectObjects(...args); } },
    TextureLoader: class { load(url: string, ready: any, _progress: any, error: any) { textureLoads.push({ url, ready, error }); return new THREE.Texture(); } },
  };
  class Viewer {
    camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
    world: any = { workers: Array.from({ length: 2 }, () => ({ listeners: {} as any, sent: [] as any[], onmessage: () => {},
      addEventListener(name: string, fn: any) { this.listeners[name] = fn; }, removeEventListener(name: string) { delete this.listeners[name]; },
      postMessage(value: any) { this.sent.push(value); }, terminate() { disposed++; } })),
      material: new THREE.MeshLambertMaterial(), sectionsOutstanding: new Set(), sectionMeshs: {} as any };
    entities = { entities: {} as any }; scene = new THREE.Scene();
    constructor() { viewCount++; view = this; } resetAll() { throw new Error('cleanup must not post reset to terminated workers'); } setVersion() { return true; }
    updateEntity(e: any) { this.entities.entities[e.id] = { rotation: { y: e.yaw } }; }
    addColumn() {} removeColumn() {} setBlockStateId() {} update() {}
  }
  const label = { dataset: {}, textContent: '' };
  const window: any = { devicePixelRatio: 1, parent: { postMessage: (m: any, origin: string) => messages.push({ ...m, origin }) },
    addEventListener: (name: string, f: any) => { callbacks[name] = f; }, removeEventListener: (name: string) => { delete callbacks[name]; } };
  const context = { window, location: { search: '?npc=Sheldon&sessionId=camera-123' }, document: { referrer: 'http://localhost:18791/',
    querySelector: () => ({ content: '18791' }), getElementById: () => label, body: { appendChild() {} } },
    URL, URLSearchParams, AbortController, fetch: (url: string, options: any) => new Promise((resolve, reject) => { fetches.push({ url, options, resolve, reject }); }),
    innerWidth: 800, innerHeight: 600, requestAnimationFrame: (f: any) => { frames.push(f); return f; },
    cancelAnimationFrame: (f: any) => { const index = frames.indexOf(f); if (index >= 0) frames.splice(index, 1); }, Date: { now: () => now }, console };
  vm.runInNewContext(source, context);
  window.AnimaViewerStart({ THREE: fakeThree, Viewer, Vec3, TWEEN: { removeAll() {} }, io: () => socket });
  assert.equal(viewCount, 0, 'do not start workers only to discard them on the first reset');
  socket.emit('viewer-reset', { npc: 'Sheldon', generation: 1, version: '1.21.4' });
  assert.equal(viewCount, 1); assert.equal(disposed, 0);
  socket.emit('position', { npc: 'Sheldon', generation: 1, pos: { x: 0, y: -20, z: 0 }, yaw: 0 });
  socket.emit('loadChunk', { x: 0, z: 0, chunk: '{}' }); socket.emit('viewer-world-ready', { generation: 1 });
  frames.shift()!(); assert.equal(messages.at(-1).status, 'live'); assert.equal(messages.at(-1).origin, 'http://localhost:18791');
  assert.equal(messages.at(-1).sessionId, 'camera-123');
  control.object.position.set(8, -16.9, -2); // A user's orbit and zoom.
  socket.emit('position', { npc: 'Sheldon', generation: 1, pos: { x: 3, y: -19, z: -4 }, yaw: 0 });
  frames.shift()!(); assert.deepEqual(view.camera.position.toArray().map((v: number) => Math.round(v * 10) / 10), [11, -15.9, -6]);
  assert.deepEqual(control.target.toArray(), [3, -17.9, -4]);
  // A real rendered wall/leaf-volume between the NPC and the desired camera.
  const wall = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 1), new THREE.MeshBasicMaterial());
  wall.position.set(3, -17.9, -1); view.world.sectionMeshs = { wall };
  control.object.position.set(3, -17.9, 2); now = 1200; frames.shift()!();
  assert.ok(Math.abs(view.camera.position.z - (-1.7)) < 0.001); // Hit at 2.5m, stay 0.2m in front.
  assert.deepEqual(control.object.position.toArray(), [3, -17.9, 2]); // User's zoom is unchanged.
  assert.equal(view.entities.entities['anima:self'].visible, true);
  const casts = raycasts; now = 1250; frames.shift()!(); frames.shift()!(); assert.equal(raycasts, casts);
  view.entities.entities.other = { visible: true };
  wall.position.z = -2.8; now = 1400; frames.shift()!(); // Wall pushes the camera within the avatar's body.
  assert.ok(Math.abs(view.camera.position.z - (-3.5)) < 0.001);
  assert.equal(view.entities.entities['anima:self'].visible, false);
  assert.equal(view.entities.entities.other.visible, true);
  assert.deepEqual(control.object.position.toArray(), [3, -17.9, 2]);
  view.world.sectionMeshs = {}; now = 1600; frames.shift()!();
  assert.deepEqual(view.camera.position.toArray(), [3, -17.9, 2]); // Unblocked: return to chosen orbit.
  assert.equal(view.entities.entities['anima:self'].visible, true);
  assert.equal(view.entities.entities.other.visible, true);
  wall.geometry.dispose(); wall.material.dispose();
  const firstLiveCount = messages.filter(m => m.status === 'live').length;
  now = 3100;
  socket.emit('position', { npc: 'Sheldon', generation: 1, pos: { x: 3, y: -19, z: -4 }, yaw: 0 });
  frames.shift()!(); assert.equal(messages.filter(m => m.status === 'live').length, firstLiveCount + 1);
  now = 5200; frames.shift()!(); // No new real position packet: no repeated live heartbeat.
  assert.equal(messages.filter(m => m.status === 'live').length, firstLiveCount + 1);
  now = 8200; frames.shift()!(); assert.equal(messages.at(-1).status, 'disconnected');
  socket.emit('viewer-state', { npc: 'Sheldon', status: 'error', message: 'render failed' }); assert.equal(messages.at(-1).status, 'error');
  assert.equal(frames.length, 0, 'fatal errors stop animation rather than throwing every frame');
  socket.emit('disconnect'); assert.equal(messages.at(-1).status, 'disconnected');

  // A dimension reset invalidates all old worker errors and delayed asset results.
  const old = view, oldWorkers = [...view.world.workers], oldError = oldWorkers[0].listeners.error;
  old.world.updateTexturesData(); assert.equal(fetches.length, 1);
  socket.emit('viewer-reset', { npc: 'Sheldon', generation: 2, version: '1.21.4' });
  assert.equal(viewCount, 2); assert.equal(fetches[0].options.signal.aborted, true);
  assert.equal(oldWorkers[0].onmessage, null); assert.equal(oldWorkers[0].listeners.error, undefined);
  const resetMessages = messages.length;
  oldError({ message: 'late worker error' }); textureLoads[0].error(new Error('late texture error'));
  let lateDisposed = 0; const lateTexture = new THREE.Texture(); lateTexture.addEventListener('dispose', () => lateDisposed++);
  textureLoads[0].ready(lateTexture);
  fetches[0].resolve({ ok: true, json: async () => ({ marker: 'old dimension' }) }); await turn();
  assert.equal(lateDisposed, 1); assert.equal(old.world.material.map, null);
  assert.equal(oldWorkers[0].sent.length, 0); assert.equal(messages.length, resetMessages);
  // The current view still receives its own assets normally.
  view.world.updateTexturesData();
  const texture = new THREE.Texture(); let textureDisposals = 0; texture.addEventListener('dispose', () => textureDisposals++);
  textureLoads[1].ready(texture); fetches[1].resolve({ ok: true, json: async () => ({ marker: 'current dimension' }) }); await turn();
  assert.equal(view.world.material.map, texture); assert.equal(view.world.workers[0].sent[0].json.marker, 'current dimension');

  // A render exception is caught once; a fresh reset can recover without a loop.
  renderError = true; frames.shift()!(); assert.equal(frames.length, 0);
  assert.match(messages.at(-1).message, /render fixture failure/u); renderError = false;
  socket.emit('viewer-reset', { npc: 'Sheldon', generation: 3, version: '1.21.4' });
  assert.equal(textureDisposals, 1);
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshBasicMaterial({ map: new THREE.Texture() });
  let geometryDisposals = 0, materialDisposals = 0, mapDisposals = 0;
  geometry.addEventListener('dispose', () => geometryDisposals++); material.addEventListener('dispose', () => materialDisposals++);
  material.map.addEventListener('dispose', () => mapDisposals++);
  const entity = new THREE.Group(); entity.add(new THREE.Mesh(geometry, material)); view.scene.add(entity); view.entities.entities.npc = entity;
  // Shared resources and meshes present in multiple maps must be released once.
  view.world.sectionMeshs.duplicate = entity.children[0];
  const disposeMessage = { type: 'anima-viewer-dispose', npc: 'Sheldon', sessionId: 'camera-123' };
  const onMessage = callbacks.message, onPageHide = callbacks.pagehide, beforeClose = disposed;
  for (const invalid of [
    { source: {}, origin: 'http://localhost:18791', data: disposeMessage },
    { source: window.parent, origin: 'http://outside.invalid', data: disposeMessage },
    { source: window.parent, origin: 'http://localhost:18791', data: { ...disposeMessage, sessionId: 'old-session' } },
    { source: window.parent, origin: 'http://localhost:18791', data: { ...disposeMessage, npc: 'Deadpool' } },
  ]) onMessage(invalid);
  assert.equal(disposed, beforeClose);
  onMessage({ source: window.parent, origin: 'http://localhost:18791', data: disposeMessage });
  assert.equal(disposed - beforeClose, 4); assert.equal(contextLoss, 1); assert.equal(frames.length, 0);
  assert.equal(geometryDisposals, 1); assert.equal(materialDisposals, 1); assert.equal(mapDisposals, 1);
  assert.equal(socket.eventNames().length, 0); assert.deepEqual(Object.keys(callbacks), []);
  const afterCloseMessages = messages.length;
  onPageHide(); onMessage({ source: window.parent, origin: 'http://localhost:18791', data: disposeMessage });
  socket.emit('viewer-reset', { npc: 'Sheldon', generation: 4, version: '1.21.4' });
  assert.equal(viewCount, 3); assert.equal(disposed - beforeClose, 4); assert.equal(contextLoss, 1); assert.equal(messages.length, afterCloseMessages);
});

import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BotRecord } from './world.ts';
import { patchViewerBundle, replaceViewerEntry } from './viewer-assets.ts';

const require = createRequire(import.meta.url);
// Avoid the aggregate server import, which pulls in optional node-canvas.
const { WorldView } = require('prismarine-viewer/viewer/lib/worldView.js');
const express = require('express');
const { Server } = require('socket.io');
const clientDirectory = join(dirname(fileURLToPath(import.meta.url)), '../viewer');
type GetRecord = (name: string) => BotRecord | undefined;
type ViewFactory = (bot: any, emitter: EventEmitter) => any;

export function viewerRequestAllowed(host: unknown, origin: unknown, port: number, apiPort: number) {
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  return origin === undefined || [port, apiPort].some(p => origin === `http://127.0.0.1:${p}` || origin === `http://localhost:${p}`);
}

/** One socket subscribes to exactly one real bot. Client events never reach the bot. */
export function attachViewerStream(socket: any, getRecord: GetRecord,
  makeView: ViewFactory = (bot, emitter) => new WorldView(bot.world, 4, bot.entity.position, emitter)) {
  const name = socket.handshake?.auth?.npc;
  const record = typeof name === 'string' && /^[A-Za-z0-9_]{1,16}$/u.test(name) ? getRecord(name) : undefined;
  if (!record) { socket.emit('viewer-state', { status: 'error', message: '角色不存在。' }); socket.disconnect(true); return () => {}; }
  const bot = record.bot;
  let closed = false, generation = 0, view: any, move: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const sendState = (status: string, message?: string) => socket.emit('viewer-state', { npc: name, status, message });
  const clearView = () => {
    generation++;
    if (heartbeat) clearInterval(heartbeat); heartbeat = undefined;
    if (move) bot.removeListener('move', move); move = undefined;
    if (view) { view.removeListenersFromBot(bot); view = undefined; }
  };
  const waiting = () => { clearView(); sendState('waiting', '角色正在重生或切换世界…'); socket.emit('viewer-reset', { npc: name, generation }); };
  const start = async () => {
    clearView();
    if (closed) return;
    if (!record.ready || !bot.entity?.position || !bot.world) { sendState('waiting', '等待角色进入世界…'); return; }
    const revision = generation;
    sendState('loading', '正在加载此角色周围的真实区块…');
    socket.emit('viewer-reset', { npc: name, generation: revision, version: bot.version, dimension: bot.game?.dimension });
    // Delayed results from an old world cannot contaminate the next dimension.
    // This is deliberately not the socket: no incoming mouse/click commands.
    const outbound = new EventEmitter();
    outbound.emit = (event: string | symbol, ...args: any[]) => {
      if (!closed && generation === revision && ['loadChunk', 'unloadChunk', 'entity', 'blockUpdate'].includes(String(event))) socket.emit(event, ...args);
      return true;
    };
    try {
      const activeView = makeView(bot, outbound); view = activeView;
      activeView.listenToBot(bot);
      move = () => {
        if (closed || generation !== revision || !record.ready || !bot.entity?.position) return;
        socket.emit('position', { npc: name, generation: revision, pos: { ...bot.entity.position }, yaw: bot.entity.yaw, time: Date.now() });
        Promise.resolve(activeView.updatePosition(bot.entity.position)).catch(() => {
          if (!closed && generation === revision) sendState('error', '区块同步失败。');
        });
      };
      move(); bot.on('move', move);
      heartbeat = setInterval(move, 1000); heartbeat.unref?.();
      await activeView.init(bot.entity.position);
      if (!closed && generation === revision) socket.emit('viewer-world-ready', { npc: name, generation: revision });
    } catch {
      if (!closed && generation === revision) { clearView(); sendState('error', '无法加载角色画面。'); }
    }
  };
  const onSpawn = () => { void start(); };
  const onEnd = () => { clearView(); sendState('disconnected', '角色已断开游戏连接。'); socket.emit('viewer-reset', { npc: name, generation }); };
  const onError = () => { clearView(); sendState('error', '角色游戏连接异常。'); };
  const listeners = { spawn: onSpawn, respawn: waiting, death: waiting, end: onEnd, kicked: onEnd, error: onError };
  for (const [event, listener] of Object.entries(listeners)) bot.on(event, listener);
  const close = () => {
    if (closed) return;
    closed = true; clearView();
    for (const [event, listener] of Object.entries(listeners)) bot.removeListener(event, listener);
    socket.removeListener('disconnect', close);
  };
  socket.on('disconnect', close);
  void start();
  return close;
}

export async function startViewerService(options: { port: number; apiPort: number; getRecord: GetRecord }) {
  const { apiPort, getRecord } = options;
  const app = express();
  const packageDirectory = dirname(require.resolve('prismarine-viewer/package.json'));
  const [indexSource, workerSource, html] = await Promise.all([
    readFile(join(packageDirectory, 'public/index.js'), 'utf8'),
    readFile(join(packageDirectory, 'public/worker.js'), 'utf8'),
    readFile(join(clientDirectory, 'index.html'), 'utf8'),
  ]);
  const bundle = replaceViewerEntry(patchViewerBundle('index.js', indexSource));
  const worker = patchViewerBundle('worker.js', workerSource);
  const etag = (source: string) => `"${createHash('sha256').update(source).digest('hex')}"`;
  const bundleEtag = etag(bundle), workerEtag = etag(worker);
  let port = options.port;
  const allowed = (request: any) => viewerRequestAllowed(request.headers.host, request.headers.origin, port, apiPort);
  app.use((request: any, response: any, next: () => void) => {
    if (!allowed(request)) return response.status(403).end('Forbidden');
    if (!['GET', 'HEAD'].includes(request.method)) return response.status(405).end('Read-only viewer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    // The pinned renderer's AJV/ProtoDef chunk codecs compile local schemas.
    // Permit this only on the isolated viewer, never the strict control API.
    response.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}; worker-src 'self'; frame-ancestors http://127.0.0.1:${apiPort} http://localhost:${apiPort}`);
    next();
  });
  app.get('/', (_request: any, response: any) => response.type('html').send(html.replaceAll('__API_PORT__', String(apiPort))));
  // Revalidate the large pinned assets; HTML/client code remain no-store so a
  // camera reconnect sees local fixes immediately. ETags are hashed only once.
  app.get('/index.js', (_request: any, response: any) => response.set({ 'Cache-Control': 'no-cache', ETag: bundleEtag }).type('application/javascript').send(bundle));
  app.get('/worker.js', (_request: any, response: any) => response.set({ 'Cache-Control': 'no-cache', ETag: workerEtag }).type('application/javascript').send(worker));
  app.use(express.static(clientDirectory));
  app.use(express.static(join(packageDirectory, 'public'), { index: false }));
  const server = createServer(app);
  const io = new Server(server, { serveClient: false, maxHttpBufferSize: 4096,
    allowRequest: (request: any, done: any) => done(null, allowed(request)),
    cors: { origin: (origin: string | undefined, done: any) => done(null,
      viewerRequestAllowed(`127.0.0.1:${port}`, origin, port, apiPort)), methods: ['GET', 'POST'] },
  });
  io.use((socket: any, next: any) => {
    const name = socket.handshake.auth?.npc;
    if (typeof name !== 'string' || !/^[A-Za-z0-9_]{1,16}$/u.test(name) || !getRecord(name)) return next(new Error('角色不存在。'));
    next();
  });
  io.on('connection', (socket: any) => attachViewerStream(socket, getRecord));
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  port = (server.address() as any).port;
  const url = `http://127.0.0.1:${port}`;
  let closing: Promise<void> | undefined;
  return { url, urlFor: (name: string) => `${url}/?npc=${encodeURIComponent(name)}`,
    close: () => closing ||= new Promise<void>(resolve => io.close(() => resolve())) };
}

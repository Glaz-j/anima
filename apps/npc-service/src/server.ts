import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { loadRoles, publicRole } from "../../../packages/npc-core/src/roles.ts";
import { RoleIndex } from "../../../packages/npc-core/src/retrieval.ts";
import { ConversationStore } from "../../../packages/npc-core/src/conversations.ts";
import { loadModel } from "../../../packages/pi-runtime/src/model.ts";
import { chatWithRole } from "../../../packages/pi-runtime/src/role-chat.ts";

const roles = await loadRoles(resolve(process.env.ANIMA_ROLES_DIR || "data/roles"));
const indexes = new Map([...roles].map(([id, role]) => [id, new RoleIndex(role)]));
const store = new ConversationStore(resolve(process.env.ANIMA_SESSIONS_DIR || "var/role-chat/sessions"));
const runtime = await loadModel();
const port = Number(process.env.ANIMA_PORT || 18790);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid ANIMA_PORT.");
const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const publicDirectory = join(dirname(fileURLToPath(import.meta.url)), "../public");
const busy = new Set<string>();

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function session(req: IncomingMessage, res: ServerResponse): string {
  const cookie = req.headers.cookie?.split(";").map((c) => c.trim()).find((c) => c.startsWith("anima_session="))?.slice(14);
  if (cookie && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(cookie)) return cookie;
  const id = randomUUID();
  res.setHeader("Set-Cookie", `anima_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);
  return id;
}

async function body(req: IncomingMessage) {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new Error("请求需要 JSON 格式。");
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16000) throw new Error("输入过长，请分段发送。");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("无法读取输入。"); }
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  if (!hosts.has(req.headers.host || "")) return json(res, 403, { error: "仅接受本机访问。" });
  if (req.headers.origin && !origins.has(req.headers.origin)) return json(res, 403, { error: "来源不匹配。" });
  const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
  const assets: Record<string, [string, string]> = {
    "/": ["index.html", "text/html"], "/app.js": ["app.js", "text/javascript"], "/style.css": ["style.css", "text/css"],
  };
  if (req.method === "GET" && assets[url.pathname]) {
    const [filename, type] = assets[url.pathname];
    const content = await readFile(join(publicDirectory, filename));
    res.writeHead(200, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store" });
    return res.end(content);
  }
  if (req.method === "GET" && url.pathname === "/favicon.ico") { res.writeHead(204); return res.end(); }
  const sessionId = session(req, res);
  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    return json(res, 200, { roles: [...roles.values()].map(publicRole), model: runtime.model.id, mode: "live" });
  }
  const match = url.pathname.match(/^\/api\/roles\/([a-z][a-z0-9-]{0,39})\/(history|profile|chat|new)$/u);
  if (!match || !roles.has(match[1])) return json(res, 404, { error: "未找到这个角色。" });
  const [, roleId, action] = match;
  const role = roles.get(roleId)!;
  const key = `${sessionId}:${roleId}`;
  if (req.method === "GET" && action === "history") {
    return json(res, 200, await store.load(sessionId, roleId));
  }
  if (req.method === "GET" && action === "profile") {
    return json(res, 200, { ...publicRole(role), persona: role.profile.personaMarkdown, memory: role.profile.selfMarkdown,
      limitations: role.profile.limitations, sampledWindows: role.profile.analysisSampleCount,
      source: role.source, evidenceNotes: role.profile.evidenceNotes });
  }
  if (req.method !== "POST" || !["chat", "new"].includes(action)) return json(res, 405, { error: "不支持这个操作。" });
  if (busy.has(key)) return json(res, 409, { error: "这个角色正在回复，请稍等或先停止生成。" });
  let input: any;
  try { input = await body(req); } catch (error: any) { return json(res, 400, { error: error.message }); }
  if (action === "chat" && (typeof input.message !== "string" || !input.message.trim() || input.message.length > 2500)) {
    return json(res, 400, { error: "请输入 1 至 2500 个字符。" });
  }
  // Recheck after awaiting the body: another request may have claimed the same conversation.
  if (busy.has(key)) return json(res, 409, { error: "这个角色正在回复，请稍等。" });
  busy.add(key);
  try {
    const conversation = await store.load(sessionId, roleId);
    if (action === "new") {
      if (conversation.messages.length) await store.save({ ...conversation, id: randomUUID() });
      await store.save({ id: sessionId, roleId, messages: [] });
      return json(res, 200, { messages: [] });
    }
    if (conversation.messages.length >= 600) return json(res, 400, { error: "这段对话已经很长，请开始一段新对话，旧记录会归档保留。" });
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
    res.flushHeaders();
    const controller = new AbortController();
    res.on("close", () => { if (!res.writableEnded) controller.abort(); });
    const send = (value: unknown) => { if (!res.destroyed) res.write(`data: ${JSON.stringify(value)}\n\n`); };
    const heartbeat = setInterval(() => { if (!res.destroyed) res.write(": waiting\n\n"); }, 12000);
    try {
      const result = await chatWithRole({ role, index: indexes.get(roleId)!, runtime, history: conversation.messages,
        message: input.message.trim(), signal: controller.signal, emit: send });
      if (controller.signal.aborted) return;
      conversation.messages.push({ role: "user", text: input.message.trim(), timestamp: Date.now() },
        { role: "assistant", text: result.text, timestamp: Date.now() });
      await store.save(conversation);
      send({ type: "done", text: result.text, evidenceIds: result.evidenceIds });
    } catch {
      send({ type: "error", error: "回复未完成。这轮没有保存，请重试；若持续失败，请检查模型接口。" });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  } finally { busy.delete(key); }
}

const server = createServer((req, res) => {
  handle(req, res).catch(() => {
    if (!res.headersSent) json(res, 500, { error: "本地服务出错，请稍后重试。" });
    else res.end();
  });
server.listen(port, "127.0.0.1", () => {
  console.log(`Anima 角色会客室：http://127.0.0.1:${port}`);
  console.log(`真实模型：${runtime.model.provider}/${runtime.model.id}；${roles.size} 个角色已加载。`);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { RoleIndex } from "../packages/npc-core/src/retrieval.ts";
import { ConversationStore, recentMessages } from "../packages/npc-core/src/conversations.ts";
import type { Role } from "../packages/npc-core/src/roles.ts";
import { chatWithRole } from "../packages/pi-runtime/src/role-chat.ts";
import { visibleText } from "../packages/pi-runtime/src/visible-text.ts";

function fixture(id = "sheldon"): Role {
  return {
    id, name: id, englishName: id, work: "test fiction", version: "test", color: "#fff", mark: "T",
    seed: "test", language: "en", targetUtterances: 2, evidenceChunks: 2,
    profileStatus: "test", summary: "test", tags: [], source: { dataset: "test", revision: "test", url: "https://example.com" },
    profile: { personaMarkdown: "Keep personal boundaries.", selfMarkdown: "", limitations: [], generatedBy: "test", analysisSampleCount: 1,
      evidenceNotes: [{ id: `${id}:seat`, situation: "有人占用座位", pattern: "明确边界", keywords: "座位 seat chair spot" }] },
    evidence: [{ id: `${id}:seat`, roleId: id, groupId: "scene-1", text: "My seat is near the window.", source: "test", language: "en", messages: [] },
      { id: `${id}:tea`, roleId: id, groupId: "scene-2", text: "I offered a cup of tea.", source: "test", language: "en", messages: [] }],
  };
}
function runtime(responses: any[]) {
  const models = createModels(); const faux = fauxProvider(); models.setProvider(faux.provider); faux.setResponses(responses);
  return { models, model: faux.getModel(), apiKey: undefined as any, source: "test" };
}

test("bilingual scene annotations retrieve English source while unrelated queries return no hits", () => {
  const index = new RoleIndex(fixture());
  assert.equal(index.search("你对座位有什么要求")[0]?.id, "sheldon:seat");
  assert.equal(index.search("window seat")[0]?.id, "sheldon:seat");
  assert.deepEqual(index.search("quantum-bananas"), []);
});

test("retrieval is bound to one role and diversifies overlapping scene windows", () => {
  const role = fixture("holmes");
  role.evidence.push({ ...role.evidence[0], id: "holmes:seat-copy" });
  const results = new RoleIndex(role).search("seat tea", 5);
  assert.equal(results.length, 2);
  assert.ok(results.every((e) => e.roleId === "holmes"));
});

test("conversation storage isolates both browser session and character", async () => {
  const folder = await mkdtemp(join(tmpdir(), "anima-test-"));
  try {
    const store = new ConversationStore(folder); const id = randomUUID();
    await store.save({ id, roleId: "sheldon", messages: [{ role: "user", text: "My name is Pine.", timestamp: 1 }, { role: "assistant", text: "Hello Pine.", timestamp: 2 }] });
    assert.equal((await store.load(id, "sheldon")).messages.length, 2);
    const updated = await store.load(id, "sheldon");
    updated.messages.push({ role: "user", text: "Remember the name?", timestamp: 3 }, { role: "assistant", text: "Pine.", timestamp: 4 });
    await store.save(updated);
    assert.equal((await store.load(id, "sheldon")).messages.length, 4);
    assert.equal((await store.load(id, "holmes")).messages.length, 0);
    assert.equal((await store.load(randomUUID(), "sheldon")).messages.length, 0);
    await assert.rejects(() => store.load(id, "../sheldon"));
  } finally {
    assert.ok(folder.startsWith(join(tmpdir(), "anima-test-")), "Only remove the temporary folder created by this test.");
    await rm(folder, { recursive: true, force: true });
  }
});

test("context trimming preserves complete turns", () => {
  const history = ["old question", "old response", "new question", "new response"].map((text, index) => ({ role: (index % 2 ? "assistant" : "user") as "user" | "assistant", text, timestamp: index }));
  assert.deepEqual(recentMessages(history, 25), history.slice(2));
  assert.deepEqual(recentMessages(history, 2), []);
});

test("provider reasoning tags never become visible spoken content, even across partial tags", () => {
  for (const prefix of ["<", "<t", "<thin", "<think>", "<think>hidden", "<think>hidden</thi"]) assert.equal(visibleText(prefix), "");
  assert.equal(visibleText("<think>private reasoning</think>Hello"), "Hello");
  assert.equal(visibleText("<thinking>private reasoning</thinking>Hello"), "Hello");
});

test("pi loop can retrieve evidence, preserve user context, and return only final spoken text", async () => {
  const role = fixture(); const ids: string[] = [];
  const model = runtime([
    (context: any) => {
      assert.ok(context.systemPrompt.includes("sheldon"));
      assert.ok(JSON.stringify(context.messages).includes("Call me Pine"));
      return fauxAssistantMessage([fauxToolCall("recall_character", { query: "seat" })], { stopReason: "toolUse" });
    },
    (context: any) => {
      assert.ok(context.messages.some((m: any) => m.role === "toolResult" && JSON.stringify(m.content).includes("sheldon:seat")));
      return fauxAssistantMessage(fauxText("<think>hidden</think>Pine, that is my seat."));
    },
  ]);
  const result = await chatWithRole({ role, index: new RoleIndex(role), runtime: model, history: [], message: "Call me Pine. Which chair?", emit: (e) => { if (e.type === "evidence") ids.push(...e.ids); } });
  assert.equal(result.text, "Pine, that is my seat."); assert.equal(result.turns, 2); assert.ok(ids.includes("sheldon:seat"));
});

test("aborted requests do not generate or mutate the supplied transcript", async () => {
  const role = fixture(); const history: any[] = [];
  await assert.rejects(() => chatWithRole({ role, index: new RoleIndex(role), runtime: runtime([]), history, message: "hello", signal: AbortSignal.abort() }));
  assert.deepEqual(history, []);
});

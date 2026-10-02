import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface ChatMessage { role: "user" | "assistant"; text: string; timestamp: number }
export interface Conversation { id: string; roleId: string; messages: ChatMessage[] }

export class ConversationStore {
  private directory: string;
  constructor(directory: string) { this.directory = directory; }
  private path(sessionId: string, roleId: string) {
    if (!/^[0-9a-f-]{36}$/u.test(sessionId) || !/^[a-z][a-z0-9-]{0,39}$/u.test(roleId)) throw new Error("Invalid conversation key.");
    return join(this.directory, `${sessionId}.${roleId}.json`);
  }
  async load(sessionId: string, roleId: string): Promise<Conversation> {
    try {
      const saved = JSON.parse(await readFile(this.path(sessionId, roleId), "utf8"));
      if (saved.id !== sessionId || saved.roleId !== roleId || !Array.isArray(saved.messages)) throw new Error("Invalid conversation file.");
      return saved;
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      return { id: sessionId, roleId, messages: [] };
    }
  }
  async save(conversation: Conversation) {
    await mkdir(this.directory, { recursive: true });
    const target = this.path(conversation.id, conversation.roleId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(conversation, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, target);
  }
}

export function recentMessages(messages: ChatMessage[], characterBudget = 18000): ChatMessage[] {
  let start = messages.length;
  let used = 0;
  // Committed histories consist of complete user/assistant pairs.
  for (let i = messages.length - 2; i >= 0; i -= 2) {
    const cost = messages[i].text.length + messages[i + 1].text.length;
    if (used + cost > characterBudget) break;
    used += cost;
    start = i;
  }
  return messages.slice(start);
}

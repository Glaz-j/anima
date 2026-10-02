import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface Evidence {
  id: string;
  roleId: string;
  groupId: string;
  text: string;
  language: string;
  source: string;
  messages: { speaker: string; text: string; isTarget: boolean; kind: string }[];
}

export interface Role {
  id: string; name: string; englishName: string; work: string; version: string;
  color: string; mark: string; seed: string; language: string;
  targetUtterances: number; evidenceChunks: number; profileStatus: string;
  summary: string; tags: string[]; source: { dataset: string; revision: string; url: string };
  profile: {
    personaMarkdown: string; selfMarkdown: string; limitations: string[];
    generatedBy: string; analysisSampleCount: number;
    evidenceNotes: { id: string; situation: string; pattern: string; keywords: string }[];
  };
  evidence: Evidence[];
}

export async function loadRoles(directory: string, options: {
  ids?: readonly string[];
  profileOverrides?: ReadonlyMap<string, Role['profile'] & { roleId: string; summary?: string; tags?: string[] }>;
} = {}): Promise<Map<string, Role>> {
  const catalogue = JSON.parse(await readFile(join(directory, "catalogue.json"), "utf8"));
  const roles = new Map<string, Role>();
  for (const item of catalogue) {
    if (options.ids && !options.ids.includes(item.id)) continue;
    if (!/^[a-z][a-z0-9-]{0,39}$/u.test(item.id) || roles.has(item.id)) throw new Error("Invalid role catalogue ID.");
    const profile = options.profileOverrides?.get(item.id) || JSON.parse(await readFile(join(directory, item.id, "profile.json"), "utf8"));
    const evidence = (await readFile(join(directory, item.id, "corpus.jsonl"), "utf8"))
      .split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as Evidence);
    if (profile.roleId !== item.id || evidence.some((e) => e.roleId !== item.id)) throw new Error("Role evidence mismatch.");
    roles.set(item.id, { ...item, summary: profile.summary, tags: profile.tags, profile, evidence });
  }
  return roles;
}

export function publicRole(role: Role) {
  const { id, name, englishName, work, version, color, mark, summary, tags, targetUtterances, evidenceChunks } = role;
  return { id, name, englishName, work, version, color, mark, summary, tags, targetUtterances, evidenceChunks };
}

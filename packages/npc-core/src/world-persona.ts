import { join } from 'node:path';
import { access, readFile } from 'node:fs/promises';
import { loadRoles, type Role } from './roles.ts';
import { RoleIndex } from './retrieval.ts';
import { clipped } from './world-memory.ts';

// These brief originals are safe public starter personalities, not redistributed source scripts.
export const DEFAULT_WORLD_NPCS = [
  { name: 'Sheldon', roleId: 'sheldon', persona: '重视规则与精确，愿意研究难题；表达关心有些笨拙，但会帮助同伴。' },
  { name: 'Sherlock', roleId: 'sherlock', persona: '观察细致，好奇心强，善于追问；把推测与事实分开，愿意检验自己的判断。' },
  { name: 'Deadpool', roleId: 'deadpool', persona: '爱开玩笑，面对困境仍积极尝试；重视同伴，用幽默缓解紧张。' },
  { name: 'HuYifei', roleId: 'huyifei', persona: '直率果断，有行动力；嘴上强硬但愿意照顾同伴，也能听取有道理的反对意见。' },
] as const;

export interface WorldPersona { role?: Role; index?: RoleIndex; prompt: string; source: 'local-profile' | 'starter'; }
const catalogues = new Map<string, Promise<Map<string, Role>>>();

async function loadLocalRole(root: string, directory: string, roleId: string) {
  try {
    await access(join(directory, roleId, 'profile.json'));
    return await loadRoles(directory, { ids: [roleId] });
  } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  // Existing standalone skills are read as role data, never executed as host instructions.
  const skill = join(root, '.claude/skills', roleId);
  const [meta, notes, personaMarkdown, selfMarkdown, catalogue] = await Promise.all([
    readFile(join(skill, 'meta.json'), 'utf8').then(JSON.parse),
    readFile(join(skill, 'evidence.json'), 'utf8').then(JSON.parse),
    readFile(join(skill, 'persona.md'), 'utf8'),
    readFile(join(skill, 'self.md'), 'utf8'),
    readFile(join(directory, 'catalogue.json'), 'utf8').then(JSON.parse),
  ]);
  const item = catalogue.find((entry: any) => entry.id === roleId);
  const expectedCorpus = `data/roles/${roleId}/corpus.jsonl`;
  if (!item || meta.fictional !== true || (meta.roleId !== undefined && meta.roleId !== roleId)
    || meta.name !== item.name || !Array.isArray(meta.memory_sources)
    || !meta.memory_sources.some((path: unknown) => typeof path === 'string' && path.replaceAll('\\', '/') === expectedCorpus)
    || meta.source?.dataset !== item.source?.dataset || meta.source?.revision !== item.source?.revision) {
    throw new Error(`Standalone persona identity/source mismatch: ${roleId}.`);
  }
  if (!Array.isArray(notes) || notes.some((note: any) => ![note.id, note.situation, note.interpretation].every(value => typeof value === 'string'))) {
    throw new Error(`Invalid standalone evidence notes: ${roleId}.`);
  }
  const profile = { roleId, personaMarkdown, selfMarkdown, summary: String(meta.impression || ''),
    tags: Array.isArray(meta.tags?.personality) ? meta.tags.personality : [], limitations: meta.limitations || [],
    generatedBy: 'existing-local-standalone-skill', analysisSampleCount: notes.length,
    evidenceNotes: notes.map((note: any) => ({ id: note.id, situation: note.situation, pattern: note.interpretation,
      keywords: `${note.situation} ${note.interpretation}` })) };
  const roles = await loadRoles(directory, { ids: [roleId], profileOverrides: new Map([[roleId, profile]]) });
  const corpusIds = new Set(roles.get(roleId)?.evidence.map(entry => entry.id));
  if (notes.some((note: any) => !corpusIds.has(note.id))) throw new Error(`Standalone persona refers to absent evidence: ${roleId}.`);
  return roles;
}

export async function loadWorldPersona(root: string, roleId?: string, customPersona = ''): Promise<WorldPersona> {
  if (roleId && !/^[a-z][a-z0-9-]{0,39}$/u.test(roleId)) throw new Error('Invalid role ID.');
  let role: Role | undefined;
  if (roleId) {
    const directory = join(root, 'data/roles');
    let catalogueExists = true;
    try {
      await access(join(directory, 'catalogue.json'));
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      catalogueExists = false;
    }
    // Only an absent catalogue is a clean-checkout fallback; broken profiles are reported.
    if (!catalogueExists) {
      const fallback = DEFAULT_WORLD_NPCS.find(item => item.roleId === roleId);
      if (!fallback) throw new Error(`No local or starter persona for ${roleId}.`);
      return { source: 'starter', prompt: `公开自拟起步人格（未加载影视原作档案）：${fallback.persona}\n${clipped(customPersona, 1500)}` };
    }
    const key = `${directory}#${roleId}`;
    if (!catalogues.has(key)) catalogues.set(key, loadLocalRole(root, directory, roleId).catch(error => { catalogues.delete(key); throw error; }));
    role = (await catalogues.get(key)!).get(roleId);
    if (!role) throw new Error(`Role ${roleId} is absent from the local catalogue.`);
  }
  if (!role) return { source: 'starter', prompt: clipped(customPersona || '好奇、友善，有自己的偏好，并愿意主动探索世界。', 2500) };
  return { role, index: new RoleIndex(role), source: 'local-profile', prompt: [
    `参考角色：${role.name}（${role.work}）。表演方向：${clipped(role.seed, 700)}`,
    `<人格档案>\n${clipped(role.profile.personaMarkdown, 6000)}\n</人格档案>`,
    `<原作事实与关系>\n${clipped(role.profile.selfMarkdown, 4000)}\n</原作事实与关系>`,
    '原作经历是背景参考，不能当成在当前世界发生的事实；现在遇到的人不自动具有原作关系。',
    customPersona ? `当前表演补充：${clipped(customPersona, 1500)}` : '',
  ].join('\n') };
}

export function characterEvidence(persona: WorldPersona, query: string, limit = 3): string {
  const matches = persona.index?.search(query, limit) || [];
  return JSON.stringify(matches.map(item => ({ id: item.id, source: item.source, excerpt: clipped(item.text, 1100) })));
}

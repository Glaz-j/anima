import type { Role, Evidence } from "./roles.ts";

const stopWords = new Set("the a an to of and is are was were in on i you it that this me my your we he she have has do did be but so with for at not just really can would could should about from what how now then if yes no okay hi hello".split(" "));

export function terms(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z][a-z0-9']+|[\p{Script=Han}]+/gu) || [];
  return words.flatMap((word) => {
    if (/^[\p{Script=Han}]+$/u.test(word)) {
      return word.length === 1 ? [word] : Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2));
    }
    return stopWords.has(word) ? [] : [word.replace(/(?:ing|ed|s)$/u, "")];
  });
}

export class RoleIndex {
  private documents: { evidence: Evidence; counts: Map<string, number>; length: number }[];
  private frequencies = new Map<string, number>();
  private averageLength: number;

  constructor(role: Role) {
    const notes = new Map(role.profile.evidenceNotes.map((n) => [n.id, `${n.situation} ${n.pattern} ${n.keywords}`]));
    this.documents = role.evidence.map((evidence) => {
      const tokens = terms(`${notes.get(evidence.id) || ""}\n${evidence.text}`);
      const counts = new Map<string, number>();
      for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
      for (const token of counts.keys()) this.frequencies.set(token, (this.frequencies.get(token) || 0) + 1);
      return { evidence, counts, length: tokens.length };
    });
    this.averageLength = this.documents.reduce((sum, d) => sum + d.length, 0) / (this.documents.length || 1);
  }

  search(query: string, limit = 4): Evidence[] {
    const tokens = [...new Set(terms(query))];
    const ranked = this.documents.map((document) => {
      let score = 0;
      for (const token of tokens) {
        const tf = document.counts.get(token) || 0;
        if (!tf) continue;
        const df = this.frequencies.get(token) || 0;
        const idf = Math.log(1 + (this.documents.length - df + 0.5) / (df + 0.5));
        score += idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * document.length / (this.averageLength || 1)));
      }
      return { evidence: document.evidence, score };
    }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score);
    const selected: Evidence[] = [];
    const groups = new Set<string>();
    for (const row of ranked) {
      if (groups.has(row.evidence.groupId)) continue;
      groups.add(row.evidence.groupId);
      selected.push(row.evidence);
      if (selected.length >= limit) break;
    }
    return selected;
  }
}

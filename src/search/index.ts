import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { ManifestEntry, Config } from "../config.js";

interface SearchResult {
  name: string;
  description: string;
  category: string;
  has_sub_skills: boolean;
  score: number;
}

interface IndexEntry {
  entry: ManifestEntry;
  tokens: string[];
  leadingWords: string[];
  isSubSkill: boolean;
  termFreq: Map<string, number>;
  docLength: number;
}

const SYNONYMS: Record<string, string[]> = {
  "paper": ["论文", "paper"],
  "论文": ["论文", "paper"],
  "write": ["写", "写作", "write"],
  "写作": ["写", "写作", "write"],
  "ui": ["界面", "ui", "设计"],
  "前端": ["frontend", "前端"],
  "后端": ["backend", "后端"],
  "测试": ["test", "testing", "测试"],
  "部署": ["deploy", "deployment", "部署"],
  "架构": ["architecture", "架构"],
  "性能": ["performance", "性能"],
  "优化": ["optimize", "optimization", "优化"],
  "代码": ["code", "代码"],
  "数据库": ["database", "db", "数据库"],
};

export class SkillSearchEngine {
  private index: IndexEntry[] = [];
  private categories: Map<string, number> = new Map();
  private docFrequencies: Map<string, number> = new Map();
  private avgDocLength: number = 0;
  private totalDocs: number = 0;
  
  // BM25 parameters
  private readonly k1 = 1.5;
  private readonly b = 0.75;
  
  private usageFile?: string;
  private usageCount: Record<string, number> = {};

  constructor(manifest: ManifestEntry[], config?: Config) {
    if (config) {
      // Find cache dir path from config.manifestPath assuming it's in the root of cache
      this.usageFile = dirname(config.manifestPath) + "/usage.json";
      this.loadUsage();
    }
    this.buildIndex(manifest);
  }

  private loadUsage() {
    if (this.usageFile && existsSync(this.usageFile)) {
      try {
        this.usageCount = JSON.parse(readFileSync(this.usageFile, "utf-8"));
      } catch {
        this.usageCount = {};
      }
    }
  }

  public recordUsage(skillName: string) {
    if (!this.usageFile) return;
    this.usageCount[skillName] = (this.usageCount[skillName] || 0) + 1;
    try {
      writeFileSync(this.usageFile, JSON.stringify(this.usageCount, null, 2), "utf-8");
    } catch {
      // Ignore write errors
    }
  }

  private buildIndex(manifest: ManifestEntry[]): void {
    const categoryCounts = new Map<string, number>();
    let totalLength = 0;

    for (const entry of manifest) {
      if (entry.name === "00_codex_skills") continue;

      let leadingWords = this.extractLeadingWords(entry.description);
      // Fallback pseudo-leading words if missing
      if (leadingWords.length === 0) {
        leadingWords = [entry.name.toLowerCase(), entry.category.toLowerCase(), ...(entry.tags || []).map(t => t.toLowerCase())];
      }

      // Collect all searchable text
      const allText = [
        entry.name,
        entry.description,
        entry.category,
        entry.folder,
        ...(entry.tags || []),
        ...(entry.aliases || []),
      ].join(" ");
      
      const tokens = this.tokenize(allText);
      const termFreq = new Map<string, number>();
      for (const t of tokens) {
        termFreq.set(t, (termFreq.get(t) || 0) + 1);
      }

      const docLength = tokens.length;
      totalLength += docLength;

      // Document frequency for IDF
      for (const t of termFreq.keys()) {
        this.docFrequencies.set(t, (this.docFrequencies.get(t) || 0) + 1);
      }

      const pathSegments = entry.relative_path.split("/").filter(Boolean);
      const isSubSkill = pathSegments.length > 3;

      this.index.push({ entry, tokens, leadingWords, isSubSkill, termFreq, docLength });
      categoryCounts.set(entry.category, (categoryCounts.get(entry.category) || 0) + 1);
    }

    this.categories = categoryCounts;
    this.totalDocs = this.index.length;
    this.avgDocLength = this.totalDocs > 0 ? totalLength / this.totalDocs : 0;
  }

  private extractLeadingWords(description: string): string[] {
    const match = description.match(/Leading\s*Words?\s*[:：]\s*(.+)$/i);
    if (!match) return [];
    return match[1].split(/[,，、]/).map(w => w.trim().toLowerCase()).filter(Boolean);
  }

  private tokenize(text: string): string[] {
    const raw = text.toLowerCase().replace(/[^\w\u4e00-\u9fff\s-]/g, " ").split(/\s+/).filter(t => t.length > 0);
    const result: string[] = [];
    
    for (const token of raw) {
      if (token.length > 1 || /[\u4e00-\u9fff]/.test(token)) {
        result.push(token);
      }
      
      const cjkChars = token.match(/[\u4e00-\u9fff]/g);
      if (cjkChars && cjkChars.length >= 2) {
        const cjkStr = cjkChars.join("");
        for (let i = 0; i < cjkStr.length - 1; i++) {
          result.push(cjkStr.substring(i, i + 2));
        }
        for (const c of cjkChars) {
          result.push(c);
        }
      }
    }
    return result;
  }

  private levenshtein(a: string, b: string): number {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    const matrix = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
    for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + cost
        );
      }
    }
    return matrix[a.length][b.length];
  }

  private expandSynonyms(tokens: string[]): string[] {
    const expanded = new Set<string>();
    for (const t of tokens) {
      expanded.add(t);
      if (SYNONYMS[t]) {
        for (const syn of SYNONYMS[t]) expanded.add(syn);
      }
    }
    return Array.from(expanded);
  }

  search(query: string, options: { category?: string; limit?: number } = {}): SearchResult[] {
    const { category, limit = 10 } = options;
    const rawTokens = this.tokenize(query);
    if (rawTokens.length === 0) return [];
    
    const queryTokens = this.expandSynonyms(rawTokens);
    const results: SearchResult[] = [];

    for (const item of this.index) {
      if (category && item.entry.category !== category) continue;
      
      let bm25Score = 0;
      let exactNameMatch = false;
      let leadingMatch = false;
      let fuzzyBoost = 1;

      const nameLower = item.entry.name.toLowerCase();
      
      for (const qt of queryTokens) {
        // BM25
        const tf = item.termFreq.get(qt) || 0;
        if (tf > 0) {
          const df = this.docFrequencies.get(qt) || 1;
          const idf = Math.log(1 + (this.totalDocs - df + 0.5) / (df + 0.5));
          const num = tf * (this.k1 + 1);
          const den = tf + this.k1 * (1 - this.b + this.b * (item.docLength / this.avgDocLength));
          bm25Score += idf * (num / den);
        } else {
          // Fuzzy match for English tokens (length > 3)
          if (/^[a-z0-9-]{4,}$/.test(qt)) {
            // check aliases and name
            const targets = [nameLower, ...(item.entry.aliases || []).map(a => a.toLowerCase())];
            for (const target of targets) {
              if (this.levenshtein(qt, target) <= 2) {
                fuzzyBoost = Math.max(fuzzyBoost, 1.5);
                bm25Score += 2; // small constant boost for fuzzy match
                break;
              }
            }
          }
        }

        // Exact name
        if (nameLower === qt || nameLower.includes(qt)) exactNameMatch = true;
        // Leading word
        if (item.leadingWords.some(lw => lw.includes(qt) || qt.includes(lw))) leadingMatch = true;
      }

      if (bm25Score > 0 || exactNameMatch || leadingMatch || fuzzyBoost > 1) {
        // Compute final score
        let finalScore = bm25Score * fuzzyBoost;
        if (exactNameMatch) finalScore += 15;
        if (leadingMatch) finalScore += 5;
        
        // Personalization boost
        const usage = this.usageCount[item.entry.name] || 0;
        if (usage > 0) {
          finalScore *= (1 + 0.2 * Math.log(1 + usage));
        }

        if (item.isSubSkill) finalScore *= 0.7;

        results.push({
          name: item.entry.name,
          description: item.entry.description,
          category: item.entry.category,
          has_sub_skills: false,
          score: Math.round(finalScore * 100) / 100,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  getCategories(): { name: string; skill_count: number }[] {
    return Array.from(this.categories.entries())
      .map(([name, skill_count]) => ({ name, skill_count }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  findByName(name: string): ManifestEntry | undefined {
    const nameLower = name.toLowerCase();
    return this.index.find(item => item.entry.name.toLowerCase() === nameLower)?.entry;
  }
}

import type { ManifestEntry } from "../config.js";

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
}

/**
 * Lightweight keyword search engine with TF-IDF-like scoring.
 * No external dependencies — pure string matching with Leading Words boosting.
 */
export class SkillSearchEngine {
  private index: IndexEntry[] = [];
  private categories: Map<string, number> = new Map();

  constructor(manifest: ManifestEntry[]) {
    this.buildIndex(manifest);
  }

  private buildIndex(manifest: ManifestEntry[]): void {
    const categoryCounts = new Map<string, number>();

    for (const entry of manifest) {
      // Skip the router entry itself
      if (entry.name === "00_codex_skills") continue;

      // Extract Leading Words from description
      const leadingWords = this.extractLeadingWords(entry.description);

      // Tokenize all searchable fields
      const allText = [
        entry.name,
        entry.description,
        entry.category,
        entry.folder,
      ].join(" ");
      const tokens = this.tokenize(allText);

      // Detect if this is a sub-skill (path depth > 2 segments)
      const pathSegments = entry.relative_path.split("/").filter(Boolean);
      const isSubSkill = pathSegments.length > 3;

      this.index.push({ entry, tokens, leadingWords, isSubSkill });

      // Count categories
      const count = categoryCounts.get(entry.category) || 0;
      categoryCounts.set(entry.category, count + 1);
    }

    this.categories = categoryCounts;
  }

  /**
   * Extract Leading Words from description.
   * Format: "...。Leading Words: word1, word2, word3"
   */
  private extractLeadingWords(description: string): string[] {
    const match = description.match(/Leading\s*Words?\s*[:：]\s*(.+)$/i);
    if (!match) return [];
    return match[1]
      .split(/[,，、]/)
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean);
  }

  private tokenize(text: string): string[] {
    const raw = text
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fff\s-]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1);

    // Generate CJK bigrams for better Chinese matching
    const result = [...raw];
    for (const token of raw) {
      const cjkChars = token.match(/[\u4e00-\u9fff]/g);
      if (cjkChars && cjkChars.length >= 2) {
        // Generate bigrams: "前端性能" → ["前端", "端性", "性能"]
        const cjkStr = cjkChars.join("");
        for (let i = 0; i < cjkStr.length - 1; i++) {
          result.push(cjkStr.substring(i, i + 2));
        }
        // Also add individual chars for broader matching
        for (const c of cjkChars) {
          result.push(c);
        }
      }
    }

    return result;
  }

  /**
   * Search skills by query string.
   * Scoring: exact name match > Leading Words match > description token match
   */
  search(
    query: string,
    options: { category?: string; limit?: number } = {}
  ): SearchResult[] {
    const { category, limit = 10 } = options;
    const queryTokens = this.tokenize(query);

    if (queryTokens.length === 0) return [];

    const results: SearchResult[] = [];

    for (const item of this.index) {
      // Category filter
      if (category && item.entry.category !== category) continue;

      let score = 0;

      // 1. Exact name match (highest priority)
      const nameLower = item.entry.name.toLowerCase();
      for (const qt of queryTokens) {
        if (nameLower === qt || nameLower.includes(qt)) {
          score += 10;
        }
      }

      // 2. Leading Words match (high priority)
      for (const qt of queryTokens) {
        for (const lw of item.leadingWords) {
          if (lw.includes(qt) || qt.includes(lw)) {
            score += 5;
          }
        }
      }

      // 3. General token match
      for (const qt of queryTokens) {
        let tokenHits = 0;
        for (const token of item.tokens) {
          if (token.includes(qt) || qt.includes(token)) {
            tokenHits++;
          }
        }
        // Normalize by token count to avoid long descriptions always winning
        score += tokenHits > 0 ? 1 + Math.log(tokenHits) : 0;
      }

      // 4. Sub-skills get a slight penalty to prefer top-level skills
      if (item.isSubSkill) {
        score *= 0.7;
      }

      if (score > 0) {
        results.push({
          name: item.entry.name,
          description: item.entry.description,
          category: item.entry.category,
          has_sub_skills: false, // Will be enriched by loader
          score: Math.round(score * 100) / 100,
        });
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, limit);
  }

  /**
   * Get all categories with skill counts.
   */
  getCategories(): { name: string; skill_count: number }[] {
    return Array.from(this.categories.entries())
      .map(([name, skill_count]) => ({ name, skill_count }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Find a skill entry by exact name.
   */
  findByName(name: string): ManifestEntry | undefined {
    const nameLower = name.toLowerCase();
    return this.index.find(
      (item) => item.entry.name.toLowerCase() === nameLower
    )?.entry;
  }
}

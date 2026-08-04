import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { ManifestEntry, Config } from "../config.js";

interface SearchResult {
  name: string;
  description: string;
  category: string;
  has_sub_skills: boolean;
  score: number;
  /** Human-readable match provenance, e.g. ["论文(exact)", "paper(fuzzy)"] */
  matched_terms?: string[];
}

type FieldName =
  | "name"
  | "leading"
  | "description"
  | "category"
  | "folder"
  | "aliases"
  | "tags";

interface FieldBag {
  tokens: string[];
  termFreq: Map<string, number>;
}

interface IndexEntry {
  entry: ManifestEntry;
  leadingWords: string[];
  isSubSkill: boolean;
  fields: Record<FieldName, FieldBag>;
}

/**
 * Bilingual alias lexicon — dev-tree synonyms merged with the extended
 * domain lexicon from the search-optimization patch. Query tokens expand
 * both ways; expansions carry a lower boost so the literal query dominates.
 */
const SYNONYMS: Record<string, string[]> = {
  // Chinese -> English
  "文献": ["paper", "literature", "article", "reference"],
  "论文": ["paper", "thesis", "article"],
  "写作": ["writing", "write", "writer"],
  "写": ["write", "writing", "写作"],
  "检索": ["search", "retrieval", "query", "retrieve"],
  "搜索": ["search"],
  "科研": ["research", "academic", "scientific", "scholar"],
  "学术": ["academic", "scholar", "scientific"],
  "研究": ["research", "study"],
  "图表": ["figure", "plot", "chart", "visualization", "diagram"],
  "可视化": ["visualization", "plot", "chart"],
  "绘图": ["drawing", "plot", "diagram", "illustrator"],
  "原理图": ["schematic", "diagram"],
  "综述": ["review", "survey"],
  "引用": ["citation", "cite"],
  "下载": ["download", "downloader"],
  "实证": ["empirical", "causal", "regression"],
  "计量": ["econometric", "econometrics"],
  "因果": ["causal", "causality"],
  "推断": ["inference", "infer"],
  "统计": ["statistic", "statistics"],
  "数据": ["data", "dataset"],
  "分析": ["analysis", "analytics", "analyze"],
  "经济": ["economic", "economics"],
  "期刊": ["journal", "journals"],
  "投稿": ["submission", "submit"],
  "审稿": ["review", "reviewer", "referee"],
  "代码": ["code", "coding", "programming"],
  "部署": ["deploy", "deployment"],
  "开发": ["develop", "development", "developer"],
  "自动化": ["automation", "automatic", "auto"],
  "文档": ["document", "doc"],
  "视频": ["video", "videos"],
  "剪辑": ["edit", "editing", "cut"],
  "图片": ["image", "img"],
  "设计": ["design", "designer"],
  "界面": ["ui", "frontend", "界面"],
  "邮件": ["mail", "email"],
  "日历": ["calendar"],
  "任务": ["task", "todo"],
  "翻译": ["translate", "translation"],
  "排版": ["layout", "typesetting", "format"],
  "网页": ["web", "website", "html"],
  "爬虫": ["crawler", "crawl", "spider"],
  "智能体": ["agent", "agents"],
  "插件": ["plugin", "plugins"],
  "发票": ["invoice", "receipt"],
  "财务": ["finance", "financial"],
  "效率": ["productivity", "efficient"],
  "测试": ["test", "testing"],
  "调试": ["debug", "debugging"],
  "错误": ["error", "errors"],
  "日志": ["log", "logs", "logging"],
  "监控": ["monitor", "monitoring"],
  "同步": ["sync", "synchronize"],
  "备份": ["backup"],
  "安全": ["security", "secure"],
  "会议": ["meeting", "meetings"],
  "审批": ["approval", "approve"],
  "报告": ["report", "reports"],
  "发布": ["publish", "publishing", "release"],
  "生成": ["generate", "generation"],
  "摘要": ["summary", "summarize"],
  "校对": ["proofread", "proofreading"],
  "识别": ["ocr", "recognize", "recognition"],
  "解析": ["parse", "parser", "parsing"],
  "提取": ["extract", "extraction"],
  "公式": ["formula", "latex", "equation"],
  "数学": ["math", "mathematics", "sympy"],
  "符号": ["symbolic", "sympy"],
  "模型": ["model", "models", "llm"],
  "大模型": ["llm", "gpt"],
  "提示词": ["prompt", "prompting"],
  "工作流": ["workflow", "pipeline"],
  "流水线": ["pipeline", "workflow"],
  "法律": ["legal", "law"],
  "医疗": ["medical", "medicine", "health"],
  "生命科学": ["bio", "biology"],
  "生信": ["bioinformatics"],
  "化学": ["chemistry", "chemical"],
  "物理": ["physics", "physical"],
  "前端": ["frontend", "前端"],
  "后端": ["backend", "后端"],
  "架构": ["architecture", "架构"],
  "性能": ["performance", "性能"],
  "优化": ["optimize", "optimization", "优化"],
  "数据库": ["database", "db", "数据库"],
  // English -> Chinese
  "paper": ["文献", "论文"],
  "search": ["检索", "搜索"],
  "research": ["科研", "研究"],
  "academic": ["学术"],
  "figure": ["图表", "图"],
  "plot": ["图表", "绘图"],
  "visualization": ["可视化", "图表"],
  "writing": ["写作"],
  "write": ["写", "写作"],
  "review": ["综述", "审稿"],
  "citation": ["引用"],
  "download": ["下载"],
  "empirical": ["实证"],
  "causal": ["因果"],
  "statistics": ["统计"],
  "data": ["数据"],
  "analysis": ["分析"],
  "economics": ["经济"],
  "journal": ["期刊"],
  "code": ["代码"],
  "deploy": ["部署"],
  "automation": ["自动化"],
  "document": ["文档"],
  "video": ["视频"],
  "image": ["图片"],
  "design": ["设计"],
  "email": ["邮件"],
  "calendar": ["日历"],
  "task": ["任务"],
  "translate": ["翻译"],
  "agent": ["智能体"],
  "plugin": ["插件"],
  "invoice": ["发票"],
  "finance": ["财务"],
  "test": ["测试"],
  "debug": ["调试"],
  "monitor": ["监控"],
  "workflow": ["工作流"],
  "pipeline": ["流水线"],
  "llm": ["大模型"],
  "prompt": ["提示词"],
  "formula": ["公式"],
  "latex": ["公式"],
  "ocr": ["识别"],
  "parse": ["解析"],
  "extract": ["提取"],
  "meeting": ["会议"],
  "approval": ["审批"],
  "report": ["报告"],
  "publish": ["发布"],
  "generate": ["生成"],
  "summary": ["摘要"],
  "security": ["安全"],
  "ui": ["界面", "设计"],
  "frontend": ["前端", "界面"],
  "backend": ["后端"],
  "architecture": ["架构"],
  "performance": ["性能"],
  "optimize": ["优化", "optimization"],
  "database": ["数据库", "db"],
};

/** Library-noise words that carry no ranking signal. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "for", "to", "of", "in", "on", "with",
  "at", "by", "is", "are", "was", "be", "as", "it", "its", "this", "that",
  "from", "using", "use", "used", "via", "your", "you", "we", "our", "their",
  "how", "what", "when", "where", "which", "who", "can", "will", "should",
  "about", "into", "per", "etc", "e", "g",
  "skills", "skill", "tool", "tools",
  "的", "了", "和", "与", "及", "在", "是", "有", "用", "使用", "一个",
  "如何", "怎么", "怎样", "什么", "哪些", "工具", "技能", "相关", "进行",
  "需要", "可以", "支持", "以及", "或者", "用于", "通过", "提供",
]);

const FIELD_NAMES: FieldName[] = [
  "name",
  "leading",
  "description",
  "category",
  "folder",
  "aliases",
  "tags",
];
const FIELD_WEIGHTS: Record<FieldName, number> = {
  name: 4.0,
  leading: 2.0,
  description: 1.0,
  category: 0.4,
  folder: 0.3,
  aliases: 2.0,
  tags: 1.5,
};
const CJK_RE = /[\u4e00-\u9fff]/;
const NON_WORD_RE = /[^\w\u4e00-\u9fff\s]/g;

export class SkillSearchEngine {
  private index: IndexEntry[] = [];
  private categories: Map<string, number> = new Map();
  private docFrequencies: Map<string, number> = new Map();
  private avgFieldLen: Record<FieldName, number> = {
    name: 1,
    leading: 1,
    description: 1,
    category: 1,
    folder: 1,
    aliases: 1,
    tags: 1,
  };
  private totalDocs = 0;

  // BM25 parameters
  private readonly k1 = 1.5;
  private readonly b = 0.75;

  private usageFile?: string;
  private usageCount: Record<string, number> = {};

  constructor(manifest: ManifestEntry[], config?: Config) {
    if (config) {
      // Cache dir path lives next to the manifest
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
    const fieldTotals: Record<FieldName, number> = {
      name: 0,
      leading: 0,
      description: 0,
      category: 0,
      folder: 0,
      aliases: 0,
      tags: 0,
    };
    const fieldDocCounts: Record<FieldName, number> = {
      name: 0,
      leading: 0,
      description: 0,
      category: 0,
      folder: 0,
      aliases: 0,
      tags: 0,
    };

    for (const entry of manifest) {
      if (entry.name === "00_codex_skills") continue;

      let leadingWords = this.extractLeadingWords(entry.description);
      // Fallback pseudo-leading words if the description has none
      if (leadingWords.length === 0) {
        leadingWords = [
          entry.name.toLowerCase(),
          entry.category.toLowerCase(),
          ...(entry.tags || []).map((t) => t.toLowerCase()),
        ];
      }

      const fieldText: Record<FieldName, string> = {
        name: entry.name,
        leading: leadingWords.join(" "),
        description: entry.description.replace(/Leading\s*Words?\s*[:：].*$/i, ""),
        category: entry.category,
        folder: entry.folder,
        aliases: (entry.aliases || []).join(" "),
        tags: (entry.tags || []).join(" "),
      };

      const fields = {} as Record<FieldName, FieldBag>;
      for (const field of FIELD_NAMES) {
        const tokens = this.tokenize(fieldText[field]);
        const termFreq = new Map<string, number>();
        for (const t of tokens) {
          termFreq.set(t, (termFreq.get(t) || 0) + 1);
        }
        fields[field] = { tokens, termFreq };
        fieldTotals[field] += tokens.length;
        if (tokens.length > 0) fieldDocCounts[field] += 1;
      }

      // Document frequency = doc counts once if token appears in ANY field
      const seen = new Set<string>();
      for (const field of FIELD_NAMES) {
        for (const t of fields[field].termFreq.keys()) {
          if (!seen.has(t)) {
            seen.add(t);
            this.docFrequencies.set(t, (this.docFrequencies.get(t) || 0) + 1);
          }
        }
      }

      const pathSegments = entry.relative_path.split("/").filter(Boolean);
      const isSubSkill = pathSegments.length > 3;

      this.index.push({ entry, leadingWords, isSubSkill, fields });
      categoryCounts.set(entry.category, (categoryCounts.get(entry.category) || 0) + 1);
    }

    this.categories = categoryCounts;
    this.totalDocs = this.index.length;
    for (const field of FIELD_NAMES) {
      // Average over docs that actually carry this field — sparse fields like
      // aliases/tags would otherwise be crushed by a near-zero global average.
      this.avgFieldLen[field] =
        fieldDocCounts[field] > 0 ? fieldTotals[field] / fieldDocCounts[field] : 1;
    }
  }

  private extractLeadingWords(description: string): string[] {
    const match = description.match(/Leading\s*Words?\s*[:：]\s*(.+)$/i);
    if (!match) return [];
    return match[1]
      .split(/[,，、]/)
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean);
  }

  /**
   * Tokenize: English words pass through (hyphenated compounds split so
   * "paper-search" yields ["paper", "search"]); CJK runs become phrase +
   * bigram + single-char tokens (singles are down-weighted at scoring).
   */
  private tokenize(text: string): string[] {
    const raw = String(text)
      .toLowerCase()
      .replace(NON_WORD_RE, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1);
    const result: string[] = [];

    for (const token of raw) {
      if (CJK_RE.test(token)) {
        const cjkStr = (token.match(/[\u4e00-\u9fff]+/g) || []).join("");
        result.push(cjkStr); // full phrase
        for (let i = 0; i < cjkStr.length - 1; i++) {
          const bigram = cjkStr.substring(i, i + 2);
          if (!STOPWORDS.has(bigram)) result.push(bigram);
        }
        for (const c of cjkStr) result.push(c);
      } else if (!STOPWORDS.has(token)) {
        result.push(token);
      }
    }
    return result;
  }

  private levenshtein(a: string, b: string): number {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    const matrix: number[][] = Array.from({ length: a.length + 1 }, () =>
      new Array<number>(b.length + 1).fill(0)
    );
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

  /** Expand query tokens into [token, boost] pairs (synonyms weigh 0.75). */
  private expandQuery(tokens: string[]): { token: string; boost: number }[] {
    const out: { token: string; boost: number }[] = [];
    const seen = new Set<string>();
    for (const t of tokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      out.push({ token: t, boost: CJK_RE.test(t) && t.length === 1 ? 0.2 : 1.0 });
      for (const syn of SYNONYMS[t] || []) {
        if (!seen.has(syn)) {
          seen.add(syn);
          out.push({ token: syn, boost: 0.75 });
        }
      }
    }
    return out;
  }

  private idf(token: string): number {
    const df = this.docFrequencies.get(token) || 0;
    return Math.log(1 + (this.totalDocs - df + 0.5) / (df + 0.5)) + 1e-9;
  }

  search(query: string, options: { category?: string; limit?: number } = {}): SearchResult[] {
    const { category, limit = 10 } = options;
    let rawTokens = this.tokenize(query);

    // Single CJK character query ("图") would otherwise tokenize to nothing.
    if (rawTokens.length === 0 && /^[\u4e00-\u9fff]$/.test(String(query).trim())) {
      rawTokens = [String(query).trim()];
    }
    if (rawTokens.length === 0) return [];

    const queryTokens = this.expandQuery(rawTokens);
    const results: SearchResult[] = [];

    for (const item of this.index) {
      if (category && item.entry.category !== category) continue;

      let bm25Score = 0;
      let exactNameMatch = false;
      let leadingMatch = false;
      const matchedTerms: { token: string; kind: string }[] = [];
      const nameLower = item.entry.name.toLowerCase();
      const aliasTargets = [
        nameLower,
        ...(item.entry.aliases || []).map((a) => a.toLowerCase()),
      ];

      for (const q of queryTokens) {
        let fieldScore = 0;
        let kind: string | null = null;

        for (const field of FIELD_NAMES) {
          const tf = item.fields[field].termFreq.get(q.token) || 0;
          if (tf > 0) {
            const dl = item.fields[field].tokens.length;
            const idf = this.idf(q.token);
            const num = tf * (this.k1 + 1);
            const den =
              tf + this.k1 * (1 - this.b + (this.b * dl) / Math.max(this.avgFieldLen[field], 1e-9));
            fieldScore +=
              idf * (num / den) * FIELD_WEIGHTS[field] * q.boost;
            kind =
              kind ||
              (CJK_RE.test(q.token) && q.token.length === 1 ? "char" : "exact");
          }
        }

        if (fieldScore > 0) {
          bm25Score += fieldScore;
          matchedTerms.push({ token: q.token, kind: kind || "exact" });
        } else if (/^[a-z0-9]{4,}$/.test(q.token)) {
          // Cheap fuzzy fallback against the skill name / aliases only.
          for (const target of aliasTargets) {
            if (this.levenshtein(q.token, target) <= 2) {
              bm25Score += 2;
              matchedTerms.push({ token: q.token, kind: "fuzzy" });
              break;
            }
          }
        }

        if (nameLower === q.token || nameLower.includes(q.token)) exactNameMatch = true;
        if (
          item.leadingWords.some((lw) => lw.includes(q.token) || q.token.includes(lw))
        ) {
          leadingMatch = true;
        }
      }

      if (bm25Score > 0 || exactNameMatch || leadingMatch) {
        let finalScore = bm25Score;
        if (exactNameMatch) finalScore += 15;
        if (leadingMatch) finalScore += 5;

        // Personalization boost from usage history
        const usage = this.usageCount[item.entry.name] || 0;
        if (usage > 0) {
          finalScore *= 1 + 0.2 * Math.log(1 + usage);
        }

        if (item.isSubSkill) finalScore *= 0.7;

        results.push({
          name: item.entry.name,
          description: item.entry.description,
          category: item.entry.category,
          has_sub_skills: false,
          score: Math.round(finalScore * 100) / 100,
          matched_terms: matchedTerms.slice(0, 6).map((m) => `${m.token}(${m.kind})`),
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
    return this.index.find((item) => item.entry.name.toLowerCase() === nameLower)?.entry;
  }
}

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { ManifestEntry, Config } from "../config.js";

export type SearchMode = "auto" | "keyword" | "task";

export interface SearchOptions {
  category?: string;
  limit?: number;
  offset?: number;
  mode?: SearchMode;
}

export interface SearchResult {
  name: string;
  description: string;
  category: string;
  has_sub_skills: boolean;
  score: number;
  /** Human-readable match provenance, e.g. ["论文(exact)", "paper(fuzzy)"] */
  matched_terms?: string[];
  /** Why this candidate was retained, in user-facing language. */
  match_reasons?: string[];
  /** 0–1 absolute-ish confidence for quick agent triage; not a guarantee. */
  confidence?: number;
  confidence_label?: "high" | "medium" | "low";
  match_mode?: "keyword" | "task";
  size_bytes?: number;
  updated_at?: string;
}

interface UsageRecord {
  reads: number;
  failures: number;
  lastReadAt?: number;
}

export interface PopularSkill {
  entry: ManifestEntry;
  reads: number;
  failures: number;
  last_read_at: number | null;
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
  nameLower: string;
  aliasTargets: string[];
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

/**
 * Deliverable nouns are a high-signal part of an agent's task request. The
 * list is intentionally small and editable: it helps the task entry point
 * separate "make a PPT" from incidental words such as "boss asked me".
 */
const TASK_DELIVERABLES = [
  "ppt", "幻灯片", "演示文稿", "演示", "deck", "slides",
  "视频", "短片", "字幕", "音频", "配音", "翻译",
  "小红书", "公众号", "文章", "博客", "海报", "封面", "图片", "插图", "卡片", "长图",
  "表格", "excel", "电子表格", "数据表", "csv",
  "文档", "word", "pdf", "报告", "论文", "简历", "合同", "发票",
  "网页", "网站", "html", "前端", "小程序", "app",
  "代码", "脚本", "api", "mcp", "插件",
  "图表", "可视化", "数据看板", "仪表盘",
  "邮件", "会议", "纪要", "日程",
  "财务", "预算", "路演", "商业计划",
  "3d", "模型", "游戏", "动画",
];

const TASK_NOISE = new Set([
  "老板", "领导", "同事", "客户", "让我", "帮我", "帮忙", "我要", "我想",
  "需要", "请", "给我", "做个", "做一个", "做一份", "完成", "制作", "生成",
  "设计", "写", "整理", "处理", "搞", "弄", "一个", "一份", "这个", "那个",
  "一下", "怎么", "如何", "可以", "能不能", "把", "成", "并", "然后",
  "以及", "关于", "方面", "更好", "效果", "提升", "效率", "一份", "这个",
]);

const TASK_SIGNAL_RE = /帮我|帮忙|请|我要|我想|需要|给我|能不能|可以|把.+成|做成|做一份|做一个|做一|制作|生成|设计|整理|审查|分析|创建|搭建|发布|翻译成|转换成|提取|总结|写一|做一|季度|年度|汇报|方案|计划|项目|需求/;

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
  private butlerEntry?: ManifestEntry;
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
  private entriesByName = new Map<string, ManifestEntry>();
  private refreshInFlight?: Promise<boolean>;
  private refreshIsForced = false;

  // BM25 parameters
  private readonly k1 = 1.5;
  private readonly b = 0.75;

  private usageFile?: string;
  private usageCount: Record<string, number | UsageRecord> = {};
  private config?: Config;

  constructor(manifest: ManifestEntry[], config?: Config) {
    this.config = config;
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
        // Normalize the legacy `{ skill: count }` format.
        for (const key of Object.keys(this.usageCount)) {
          const value = this.usageCount[key];
          if (typeof value === "number") {
            this.usageCount[key] = { reads: value, failures: 0 };
          }
        }
      } catch {
        this.usageCount = {};
      }
    }
  }

  private getUsage(name: string): UsageRecord {
    const value = this.usageCount[name];
    if (value && typeof value === "object") {
      return {
        reads: value.reads || 0,
        failures: value.failures || 0,
        ...(typeof value.lastReadAt === "number" ? { lastReadAt: value.lastReadAt } : {}),
      };
    }
    if (typeof value === "number") {
      return { reads: value, failures: 0 };
    }
    return { reads: 0, failures: 0 };
  }

  private saveUsage(): void {
    if (!this.usageFile) return;
    try {
      writeFileSync(this.usageFile, JSON.stringify(this.usageCount, null, 2), "utf-8");
    } catch {
      // Ignore write errors
    }
  }

  /** Record a successful read (personalized search boost). */
  public recordUsage(skillName: string) {
    if (!this.usageFile) return;
    const cur = this.getUsage(skillName);
    this.usageCount[skillName] = {
      reads: cur.reads + 1,
      failures: cur.failures,
      lastReadAt: Date.now(),
    };
    this.saveUsage();
  }

  /** Record a failed read (search demotion for unreliable skills). */
  public recordFailure(skillName: string) {
    if (!this.usageFile) return;
    const cur = this.getUsage(skillName);
    this.usageCount[skillName] = {
      reads: cur.reads,
      failures: cur.failures + 1,
      ...(cur.lastReadAt !== undefined ? { lastReadAt: cur.lastReadAt } : {}),
    };
    this.saveUsage();
  }

  /** Read-only usage counters for presentation surfaces. */
  public usageFor(skillName: string): { reads: number; failures: number; last_read_at: number | null } {
    const usage = this.getUsage(skillName);
    return {
      reads: usage.reads,
      failures: usage.failures,
      last_read_at: usage.lastReadAt ?? null,
    };
  }

  private buildIndex(manifest: ManifestEntry[]): void {
    // Every rebuild replaces all corpus statistics, including removed entries.
    this.index = [];
    this.docFrequencies.clear();
    this.entriesByName.clear();
    this.butlerEntry = undefined;
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
      // The butler (00_codex_skills) is the library ENTRANCE, not searchable
      // content: keep it out of the BM25 index (search_skills unchanged),
      // but retain the manifest entry for pinned mention/resource surfaces.
      if (entry.name === "00_codex_skills") {
        this.butlerEntry = entry;
        continue;
      }

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

      const nameLower = entry.name.toLowerCase();
      this.entriesByName.set(nameLower, entry);
      this.index.push({ entry, nameLower, aliasTargets: [nameLower, ...(entry.aliases || []).map(a => a.toLowerCase())], leadingWords, isSubSkill, fields });
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
      // A mixed token such as "季度汇报PPT" must yield both its CJK bigrams
      // and the Latin deliverable. The previous branch treated the whole token
      // as CJK and silently dropped "PPT".
      const parts = token.match(/[\u4e00-\u9fff]+|[a-z0-9]+/g) || [];
      for (const part of parts) {
        if (CJK_RE.test(part)) {
          result.push(part); // full CJK phrase
          for (let i = 0; i < part.length - 1; i++) {
            const bigram = part.substring(i, i + 2);
            if (!STOPWORDS.has(bigram)) result.push(bigram);
          }
          for (const c of part) result.push(c);
        } else if (!STOPWORDS.has(part)) {
          result.push(part);
        }
      }
    }
    return result;
  }

  private levenshtein(a: string, b: string): number {
    // Fuzzy matching only accepts distance <= 2. Reject impossible pairs
    // before allocating, then use two rows instead of a quadratic matrix.
    if (Math.abs(a.length - b.length) > 2) return 3;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    let current = new Array<number>(b.length + 1);
    for (let i = 1; i <= a.length; i++) {
      current[0] = i;
      let minimum = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        current[j] = Math.min(
          previous[j] + 1,
          current[j - 1] + 1,
          previous[j - 1] + cost
        );
        minimum = Math.min(minimum, current[j]);
      }
      if (minimum > 2) return 3;
      [previous, current] = [current, previous];
    }
    return previous[b.length];
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

  private looksLikeTask(query: string): boolean {
    const text = String(query).trim();
    if (!text) return false;
    if (/[?？]/.test(text)) return true;
    if (TASK_SIGNAL_RE.test(text)) return true;
    return Array.from(text).length > 36;
  }

  private buildTaskQueries(query: string): { text: string; weight: number; label: string }[] {
    const text = String(query).trim();
    const lower = text.toLowerCase();
    const queries: { text: string; weight: number; label: string }[] = [
      // Keep the complete request as a low-weight signal for exact phrases,
      // but never let generic words such as "汇报" dominate a deliverable.
      { text, weight: 0.35, label: "完整任务描述" },
    ];
    const seen = new Set<string>([lower]);
    const add = (value: string, weight: number, label: string) => {
      const key = value.trim().toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      queries.push({ text: value.trim(), weight, label });
    };

    const deliverables = TASK_DELIVERABLES
      .filter((term) => lower.includes(term))
      .sort((a, b) => b.length - a.length)
      .slice(0, 4);
    for (const term of deliverables) add(term, 1.35, `交付物「${term}」`);
    for (const first of deliverables) {
      for (const second of deliverables) {
        if (first === second) continue;
        const phrase = `${first}${second}`;
        if (phrase.length <= 10 && lower.includes(phrase)) {
          add(phrase, 1.6, `组合「${phrase}」`);
        }
      }
    }

    const domainTokens = this.tokenize(text)
      .filter((token) => token.length >= 2 && !STOPWORDS.has(token) && !TASK_NOISE.has(token))
      .filter((token) => !deliverables.some((term) => token.includes(term) || term.includes(token)))
      .slice(0, 5);
    for (const token of domainTokens) add(token, 0.45, `关键词「${token}」`);
    return queries;
  }

  private confidence(score: number): number {
    return Math.round(Math.min(1, Math.max(0, score / (score + 8))) * 100) / 100;
  }

  private confidenceLabel(confidence: number): "high" | "medium" | "low" {
    return confidence >= 0.7 ? "high" : confidence >= 0.45 ? "medium" : "low";
  }

  search(query: string, options: SearchOptions = {}): SearchResult[] {
    return this.searchWithTotal(query, options).results;
  }

  /** Search once and retain the full match count for UI pagination. */
  searchWithTotal(query: string, options: SearchOptions = {}): { results: SearchResult[]; total: number } {
    const mode = options.mode ?? "auto";
    if (mode === "task" || (mode === "auto" && this.looksLikeTask(query))) {
      return this.searchTaskWithTotal(query, options);
    }
    return this.searchKeywordWithTotal(query, options);
  }

  /**
   * Keyword lookup used by the App search box and by agents that already know
   * the skill/name they want. Single-character hits alone are rejected for
   * multi-character queries so "合同" cannot be satisfied by "同" in an
   * unrelated finance skill.
   */
  private searchKeywordWithTotal(query: string, options: SearchOptions = {}): { results: SearchResult[]; total: number } {
    const { category, limit = 10, offset = 0 } = options;
    let rawTokens = this.tokenize(query);

    // Single CJK character query ("图") would otherwise tokenize to nothing.
    if (rawTokens.length === 0 && /^[\u4e00-\u9fff]$/.test(String(query).trim())) {
      rawTokens = [String(query).trim()];
    }
    const singleCharQuery = /^[\u4e00-\u9fff]$/.test(String(query).trim());
    if (rawTokens.length === 0) return { results: [], total: 0 };

    const queryTokens = this.expandQuery(rawTokens).map(q => ({ ...q, idf: this.idf(q.token) }));
    const results: SearchResult[] = [];

    for (const item of this.index) {
      if (category && item.entry.category !== category) continue;

      let bm25Score = 0;
      let exactNameMatch = false;
      let leadingMatch = false;
      let strongMatch = false;
      const matchedTerms: { token: string; kind: string }[] = [];
      const { nameLower, aliasTargets } = item;

      for (const q of queryTokens) {
        let fieldScore = 0;
        let kind: string | null = null;

        for (const field of FIELD_NAMES) {
          const tf = item.fields[field].termFreq.get(q.token) || 0;
          if (tf > 0) {
            const dl = item.fields[field].tokens.length;
            const idf = q.idf;
            const num = tf * (this.k1 + 1);
            const den =
              tf + this.k1 * (1 - this.b + (this.b * dl) / Math.max(this.avgFieldLen[field], 1e-9));
            fieldScore +=
              idf * (num / den) * FIELD_WEIGHTS[field] * q.boost;
            kind =
              kind ||
              (CJK_RE.test(q.token) && q.token.length === 1 ? "char" : "exact");
            if (!(CJK_RE.test(q.token) && q.token.length === 1)) strongMatch = true;
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
              strongMatch = true;
              matchedTerms.push({ token: q.token, kind: "fuzzy" });
              break;
            }
          }
        }

        const singleCharToken = CJK_RE.test(q.token) && q.token.length === 1;
        if (!singleCharToken && (nameLower === q.token || nameLower.includes(q.token))) {
          exactNameMatch = true;
        }
        if (
          !singleCharToken &&
          item.leadingWords.some((lw) => lw.includes(q.token) || q.token.includes(lw))
        ) {
          leadingMatch = true;
        }
      }

      if (!singleCharQuery && !strongMatch && !exactNameMatch && !leadingMatch) continue;

      if (bm25Score > 0 || exactNameMatch || leadingMatch) {
        let finalScore = bm25Score;
        if (exactNameMatch) finalScore += 15;
        if (leadingMatch) finalScore += 5;

        // Personalization from usage history: reads boost, failures demote.
        const usage = this.getUsage(item.entry.name);
        if (usage.reads > 0) {
          finalScore *= 1 + 0.2 * Math.log(1 + usage.reads);
        }
        if (usage.failures > 0) {
          finalScore *= Math.max(0.5, 1 - 0.3 * Math.log(1 + usage.failures));
        }

        if (item.isSubSkill) finalScore *= 0.7;

        results.push({
          name: item.entry.name,
          description: item.entry.description,
          category: item.entry.category,
          has_sub_skills: false,
          score: Math.round(finalScore * 100) / 100,
          matched_terms: matchedTerms.slice(0, 6).map((m) => `${m.token}(${m.kind})`),
          match_reasons: [
            ...matchedTerms
              .filter((m) => m.kind !== "char")
              .slice(0, 3)
              .map((m) => `关键词「${m.token}」`),
            ...(exactNameMatch ? ["技能名匹配"] : []),
            ...(leadingMatch ? ["推荐词匹配"] : []),
          ],
          match_mode: "keyword",
          ...(item.entry.file_index?.total_bytes !== undefined
            ? { size_bytes: item.entry.file_index.total_bytes }
            : {}),
          ...(item.entry.updated_at ? { updated_at: item.entry.updated_at } : {}),
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    for (const result of results) {
      const confidence = this.confidence(result.score);
      result.confidence = confidence;
      result.confidence_label = this.confidenceLabel(confidence);
    }
    return { results: results.slice(offset, offset + limit), total: results.length };
  }

  /**
   * Task-aware candidate retrieval. This is deliberately a deterministic
   * first pass (no LLM dependency): extract deliverable nouns, search several
   * short queries, merge by skill and return a shortlist with reasons and
   * confidence. The agent still decides whether to use any candidate.
   */
  private searchTaskWithTotal(query: string, options: SearchOptions = {}): { results: SearchResult[]; total: number } {
    const { category, limit = 10, offset = 0 } = options;
    const queries = this.buildTaskQueries(query);
    const totalWeight = queries.reduce((sum, q) => sum + q.weight, 0);
    const merged = new Map<string, {
      result: SearchResult;
      weighted: number;
      matchedWeight: number;
      matched: { label: string; weight: number }[];
    }>();

    for (const current of queries) {
      const page = this.searchKeywordWithTotal(current.text, { category, limit: 16 });
      for (const result of page.results) {
        const key = result.name.toLocaleLowerCase();
        const phraseMatch = current.text.length >= 2 && (
          result.name.toLocaleLowerCase().includes(current.text.toLocaleLowerCase()) ||
          result.description.toLocaleLowerCase().includes(current.text.toLocaleLowerCase())
        );
        const isCombinationQuery = current.label.startsWith("组合");
        const effectiveWeight = isCombinationQuery && !phraseMatch ? current.weight * 0.2 : current.weight;
        const includeLabel = !isCombinationQuery || phraseMatch;
        const contribution = result.score * effectiveWeight + (phraseMatch ? current.weight * 12 : 0);
        const phraseReason = phraseMatch ? `原文包含「${current.text}」` : undefined;
        const existing = merged.get(key);
        if (existing) {
          existing.weighted += contribution;
          existing.matchedWeight += effectiveWeight;
          if (includeLabel) existing.matched.push({ label: current.label, weight: effectiveWeight });
          existing.result.score = Math.max(existing.result.score, result.score);
          existing.result.match_reasons = Array.from(new Set([
            ...(existing.result.match_reasons ?? []),
            ...(result.match_reasons ?? []),
            ...(includeLabel ? [current.label] : []),
            ...(phraseReason ? [phraseReason] : []),
          ]));
          continue;
        }
        merged.set(key, {
          result: {
            ...result,
            match_reasons: Array.from(new Set([
              ...(result.match_reasons ?? []),
              ...(includeLabel ? [current.label] : []),
              ...(phraseReason ? [phraseReason] : []),
            ])),
          },
          weighted: contribution,
          matchedWeight: effectiveWeight,
          matched: includeLabel ? [{ label: current.label, weight: effectiveWeight }] : [],
        });
      }
    }

    const deliverableQueries = queries.filter((item) => item.label.startsWith("交付物")).length;
    const ranked = [...merged.values()].map(({ result, weighted, matchedWeight, matched }) => {
      const coverage = totalWeight > 0 ? matchedWeight / totalWeight : 0;
      const average = matchedWeight > 0 ? weighted / matchedWeight : 0;
      const matchedDeliverables = new Set(
        matched.filter((item) => item.label.startsWith("交付物")).map((item) => item.label),
      ).size;
      const deliverableCoverage = deliverableQueries > 0
        ? matchedDeliverables / deliverableQueries
        : 0;
      const score = weighted + coverage * 4 + deliverableCoverage * 8 + Math.min(3, average / 8);
      const confidence = Math.round(Math.min(1, Math.max(0, 0.2 + coverage * 0.55 + average / 100)) * 100) / 100;
      const deliverableMatch = matched.some((item) => item.label.startsWith("交付物"));
      const reasons = [
        ...result.match_reasons ?? [],
        ...(deliverableMatch ? ["与交付物直接相关"] : []),
      ];
      const reasonPriority = (reason: string) =>
        reason.startsWith("组合") ? 0
          : reason.startsWith("交付物") ? 1
            : reason.startsWith("原文包含") ? 1
            : reason.startsWith("关键词") ? 2
              : reason === "完整任务描述" ? 4
                : 3;
      return {
        ...result,
        score: Math.round(score * 100) / 100,
        confidence,
        confidence_label: this.confidenceLabel(confidence),
        match_reasons: Array.from(new Set(reasons))
          .sort((a, b) => reasonPriority(a) - reasonPriority(b))
          .slice(0, 8),
        match_mode: "task" as const,
      };
    }).sort((a, b) => b.score - a.score);

    return {
      results: ranked.slice(offset, offset + limit),
      total: ranked.length,
    };
  }

  getCategories(): { name: string; skill_count: number }[] {
    return Array.from(this.categories.entries())
      .map(([name, skill_count]) => ({ name, skill_count }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  findByName(name: string): ManifestEntry | undefined {
    return this.entriesByName.get(name.toLowerCase());
  }

  /**
   * The butler entry (00_codex_skills) — excluded from the search index by
   * design, but exposed for pinned mention/resource surfaces.
   */
  getButlerEntry(): ManifestEntry | undefined {
    return this.butlerEntry;
  }

  /**
   * All indexed skill entries (for MCP resources/list — the host builds its
   * resource registry from this, which is what makes @-mention references
   * resolvable in ChatGPT).
   */
  allSkills(): ManifestEntry[] {
    return this.index.map((item) => item.entry);
  }

  /**
   * Default suggestions for empty typeahead queries (e.g. the ChatGPT
   * composer @-mention picker opens with an empty query before the user
   * types): most-used skills first, freshest manifest updates next, stable
   * name order last. Returns plain manifest entries with name/description.
   */
  defaultSuggestions(limit: number): ManifestEntry[] {
    const entries = this.index.map((item) => item.entry);
    entries.sort((a, b) => {
      const ua = this.getUsage(a.name).reads;
      const ub = this.getUsage(b.name).reads;
      if (ua !== ub) return ub - ua;
      const ta = a.updated_at ? Date.parse(a.updated_at) : 0;
      const tb = b.updated_at ? Date.parse(b.updated_at) : 0;
      if (ta !== tb) return tb - ta;
      return a.name.localeCompare(b.name);
    });
    return entries.slice(0, limit);
  }

  /**
   * Most-used skills with observable frequency data for the App home.
   * Unused entries remain useful discovery fallbacks, but keep a true zero
   * read count so the UI never presents inferred usage as measured usage.
   */
  public popularSkills(limit: number): PopularSkill[] {
    const entries = this.index.map(({ entry }) => {
      const usage = this.getUsage(entry.name);
      return {
        entry,
        reads: usage.reads,
        failures: usage.failures,
        last_read_at: usage.lastReadAt ?? null,
      };
    });
    entries.sort((a, b) => {
      if (a.reads !== b.reads) return b.reads - a.reads;
      if (a.last_read_at !== b.last_read_at) {
        return (b.last_read_at ?? 0) - (a.last_read_at ?? 0);
      }
      const aUpdated = a.entry.updated_at ? Date.parse(a.entry.updated_at) : 0;
      const bUpdated = b.entry.updated_at ? Date.parse(b.entry.updated_at) : 0;
      if (aUpdated !== bUpdated) return bUpdated - aUpdated;
      return a.entry.name.localeCompare(b.entry.name);
    });
    return entries.slice(0, Math.max(0, limit));
  }

  /** Aggregate usage counters for the App activity strip. */
  public usageSummary(): { total_reads: number; used_skills: number; total_failures: number } {
    let total_reads = 0;
    let used_skills = 0;
    let total_failures = 0;
    for (const item of this.index) {
      const usage = this.getUsage(item.entry.name);
      total_reads += usage.reads;
      total_failures += usage.failures;
      if (usage.reads > 0) used_skills += 1;
    }
    return { total_reads, used_skills, total_failures };
  }

  /**
   * Throttled freshness check (conditional GET) before searches. When the poll
   * detects newer remote content it reloads the manifest and rebuilds this
   * index in place, so long-lived server processes also see new skills.
   * See docs/ARCHITECTURE.md.
   */
  async maybeRefreshManifest(): Promise<boolean> {
    if (!this.config || !this.config.isRemote) return false;
    if (this.refreshInFlight) return this.refreshInFlight;
    return this.runRefresh(false);
  }

  /** Share one refresh/rebuild across concurrent searches and HTTP sessions. */
  private runRefresh(force: boolean): Promise<boolean> {
    const operation = this.reloadManifest(force);
    this.refreshIsForced = force;
    this.refreshInFlight = operation;
    void operation.finally(() => {
      if (this.refreshInFlight === operation) this.refreshInFlight = undefined;
    });
    return operation;
  }

  private async reloadManifest(force: boolean): Promise<boolean> {
    try {
      const { refreshManifestIfStale, fetchManifest } = await import("../remote/github.js");
      const changed = force
        ? await fetchManifest(this.config!, true)
        : await refreshManifestIfStale(this.config!);
      if (!changed) return false;
      const { loadManifest } = await import("../config.js");
      const manifest = loadManifest(this.config!.manifestPath);
      this.buildIndex(manifest);
      return true;
    } catch (err) {
      console.error("[codex-skills-mcp] Freshness poll failed:", err);
      return false;
    }
  }

  /**
   * Forces a refresh of the remote manifest cache and rebuilds the search index.
   * Returns true if a refresh was attempted, false if running in local mode.
   */
  async refreshManifest(): Promise<boolean> {
    if (!this.config || !this.config.isRemote) return false;
    // Wait for an automatic poll before starting the explicitly forced read.
    if (this.refreshInFlight && this.refreshIsForced) return this.refreshInFlight;
    if (this.refreshInFlight) await this.refreshInFlight;
    return this.refreshInFlight ?? this.runRefresh(true);
  }
}

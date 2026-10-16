# 技能库分发迁移方案：GitHub → npm

> 版本：v1.0（2026-10-15）
> 状态：归档分发方案待评审；以下现状与实测保留 2026-10-15 基线
> 2026-10-16 更新：beta.5 已以 immutable catalog 消除常规路径的 GitHub Tree API 依赖，并让已知 SHA 文件更新直接走校验镜像。beta.6 开发版继续优化竞速与预览；逐文件请求数量仍是归档方案要解决的问题。详见 BETA-5-REVIEW.md、BETA-6-REVIEW.md。
> 前置调研：见 `/tmp/cn-direct-test/` 实测数据（直连环境，代理已关闭验证）

---

## 1. 背景与动机

### 1.1 现状架构

```
用户(MCP client) ──stdio──> codex-skills-mcp ──HTTPS──> GitHub
                                                ├── raw.githubusercontent.com（4节点竞速之一）
                                                ├── cdn.jsdelivr.net（gh 路由）
                                                ├── gh-proxy.com
                                                └── ghfast.top
                                                └── api.github.com（技能树列表，硬依赖）
```

- manifest 拉取：**直连优先 + 20s 超时**后回退镜像竞速（`src/remote/github.ts:713-724`）
- 技能内容刷新：**直连优先 + 30s 超时**（`src/remote/github.ts:247-272`）
- `read_skill`：先调 `api.github.com` 列目录树（2 次调用），再**逐文件**竞速下载（`src/tools/read-skill.ts:17`，仅 `name` 参数，无懒加载）

### 1.2 实测痛点（国内直连，2026-10-14/15）

| 痛点 | 实测证据 |
| --- | --- |
| raw.githubusercontent.com 基本不可用或被限速 | 一天 1/10 可达（8-25s 超时）；另一天 10/10 可达但仅 **0.10 MB/s**（15.6MB 文件 40s 只传 4MB） |
| 公共加速站大面积失效、不可控 | gh-proxy.com 次日直连 403（封禁）；gh.llkk.cc / raw.githack / statically / moeyy / gitmirror 直连全部不可用 |
| 逐文件下载是数量级瓶颈 | ars 技能 2281 文件 → 2281 次请求 × 1-2s 往返 ÷ 16 并发 ≈ **3-12 分钟**，撞穿 MCP 默认 60s 超时 |
| api.github.com 硬依赖 | 未认证 60 次/小时限流（实测 `x-ratelimit-remaining: 0`）；每次 `read_skill`/`list_skill_files` 消耗 2 次 |
| 冷启动串行白等 | manifest 直连死等 20s；npx 首次装包 45s + 20s = **66s > 60s 超时，initialize 直接失败** |
| 代理环境变量无效 | Node fetch（undici）忽略 `HTTP_PROXY`（实测死代理下照样成功），只能靠系统级 TUN |

### 1.3 npm 通道实测（国内直连，同机同期）

| 通道 | 延迟 | 吞吐 | 是否需要白名单 |
| --- | --- | --- | --- |
| `registry.npmmirror.com`（元数据） | **0.19-0.22s**（3/3 稳定） | — | 否 |
| `cdn.npmmirror.com`（tarball） | 0.5-0.7s 建连 | **3.2-4.2 MB/s** | **否**（已用未加白的 `codex-skills-mcp` 实测） |
| `registry.npmjs.org`（兜底） | 0.99s | 可用 | 否 |
| `cdn.jsdelivr.net/npm/<pkg>@<ver>/<path>` | 0.85s（缓存热）/ 2.3-6.5s（冷回源） | 3.46 MB/s | 否（已实测） |
| npmmirror unpkg 文件 API | 0.14s | 4.2 MB/s | **是**（`cnpm/unpkg-white-list`，6248 包在列；内容分发类有被拒风险，**不采用**） |

**结论：走 tarball（整包下载）+ npmmirror 通道，无需任何审批，且把 N 次请求压缩为 1 次——这是唯一数量级的提速。**

---

## 2. 目标与非目标

**目标**
1. 国内直连环境下：`read_skill` 任意技能 ≤ 15s（当前 3s-超时不等，ars 最长 12 分钟）
2. 彻底移除对 `api.github.com` / `raw.githubusercontent.com` / 公共加速站的运行时依赖
3. GitHub 仍是唯一开发源（开发者工作流不变），npm 只是分发通道
4. 缓存目录结构与现有格式兼容（切换 source 不需清缓存、`SkillLoader`/搜索索引零改动）
5. 保留 GitHub 模式作为可切换的 legacy 兜底

**非目标**
- 不做 npmmirror unpkg 白名单申请（政策风险 + 不减请求数）
- 不自建 CDN / OSS（npmmirror + npmjs 双源已够；OSS 留作未来扩展点）
- 不改本地模式（`--skills-dir` / `CODEX_SKILLS_DIR`）行为

---

## 3. 总体架构

```
┌──────────────┐   开发/CI 发布    ┌─────────────────────────────┐
│ GitHub 仓库   │ ───────────────> │ npm registry（npmjs.org）    │
│ (源码唯一真源) │  Actions 自动发包 │  @codex-skills/<slug>  ×290  │
└──────────────┘                  │  @codex-skills/index  ×1     │
                                  └──────────────┬──────────────┘
                                                 │ 自动同步（定时+按需）
                                                 v
                                  ┌─────────────────────────────┐
                                  │ npmmirror（阿里，国内直连）    │
                                  │  registry.npmmirror.com      │
                                  │  cdn.npmmirror.com (tarball) │
                                  └──────────────┬──────────────┘
                                                 │ ① HEAD dist-tags（0.2s）
                                                 │ ② GET tarball（1 次请求）
                                                 v
                                  ┌─────────────────────────────┐
                                  │ codex-skills-mcp（用户侧）    │
                                  │ registry: npmmirror → npmjs  │
                                  │ fallback；sha512 校验；解压   │
                                  │ 到 ~/.codex-skills-cache     │
                                  │（目录格式与 GitHub 模式相同）  │
                                  └─────────────────────────────┘
```

核心变化一句话：**"列树 + 逐文件竞速" 变成 "读索引 + 一次 tarball"**。

---

## 4. npm 包设计

### 4.1 粒度决策：按技能拆包（290+1）

| 方案 | 单包体积 | 更新成本 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| A. 整库一个包（几百 MB） | ❌ 巨大 | 任何改动全量重发 | npmmirror 超大包不同步（`allowLargePackages` 仅 103 包在列）；发布慢 | 否决 |
| B. 按分类拆 15 个包 | 单分类可达 200MB+ | 更新一个技能重发整分类 | 同样踩大包阈值 | 否决 |
| **C. 按技能拆 290 个 + 1 个索引包** | 中位数约 340KB，绝大多数 < 5MB | 只发变更的技能包（patch bump） | 单包小、天然避开大包限制；`read_skill` 一次一个 tarball 完美对齐 | **采用** |

### 4.2 命名与 scope

- npm organization：`codex-skills`（npmjs 免费创建一次）
- 技能包：`@codex-skills/<slug>`，**public access**（`publishConfig: {"access": "public"}`，scope 包默认 private）
- 索引包：`@codex-skills/index`

**slug 规则**（folder → 合法包名，CI 保证唯一并写入索引）：

```
slug = folder.toLowerCase()
       .replace(/[^a-z0-9-]+/g, '-')   // 非法字符(含中文/下划线/空格)→连字符
       .replace(/^-+|-+$/g, '')         // 去首尾连字符
冲突时追加 `-2`、`-3`；映射关系持久化在索引包里，MCP 侧只认索引给出的包名，绝不自行推导。
```

> 技能 `name`（如 "Scientific Agent Skills"）与 folder（如 `Humanizer-zh`）都可能不适合直接做包名，因此**一律以 folder 为 slug 来源，索引包记录 `name → package` 映射**。

### 4.3 技能包结构

tarball 内容 = 技能目录原样（**不含**分类中文前缀，落盘时由 manifest 的 `relative_path` 拼回）：

```
@codex-skills/ars-1.4.2.tgz
├── package.json          # 发布脚本生成的最小壳（见 4.6）
├── SKILL.md
├── scripts/…
├── references/…
└── …（技能原有全部文件，路径保持不变，含中文文件名——tar/gzip 原生支持 UTF-8）
```

要点：
- 用 `npm pack` 语义打包（自动排除 `.git`、`.DS_Store` 等）；`files` 字段设为技能全部内容
- 技能内如有 `node_modules` 或超大二进制，在打包脚本里显式排除/分级（见 4.7 体积策略）
- 解压侧用系统 `tar` 或 Node `tar` 库，落盘路径：`<cacheDir>/<relative_path>/`（例如 `~/.codex-skills-cache/00_全局大管家/12_学术论文与科研图表/ars/`）

### 4.4 索引包 `@codex-skills/index`

内容即增强版 `skills_manifest.json`（gzip 后预计 < 1MB；全库约 3-8 万文件条目，JSON 重复度高，压缩比 ~10:1）：

```jsonc
// skills_manifest.json（v2，向后兼容：新增字段均为可选）
[
  {
    // ── 现有字段，不动 ──
    "name": "academic-research-skills-codex",
    "description": "…",
    "category": "12_学术论文与科研图表",
    "folder": "ars",
    "relative_path": "00_全局大管家/12_学术论文与科研图表/ars",
    "aliases": ["ars-plan", "ars-reviewer"],
    "tags": ["学术论文"], "language": "python",
    "dependencies": ["…"], "updated_at": "2026-10-01",

    // ── npm 分发新增字段 ──
    "npm": {
      "package": "@codex-skills/ars",
      "version": "1.4.2",
      "integrity": "sha512-…",        // 来自 packument dist.integrity，下载后强制校验
      "unpackedSize": 37683200
    },
    "files": [                        // 全量文件清单（路径+大小）
      {"path": "SKILL.md", "size": 46986},
      {"path": "scripts/run.py", "size": 1204}
    ],
    "filesTotal": 2281,
    "contentHash": "sha256-…"         // 打包时对内容做 hash，用于增量检测
  }
]
```

**关键收益：`files` 清单进索引后，`list_skill_files` / `search` / `plan_workflow` / `skill_status` 全部纯离线，`api.github.com` 依赖彻底消失（连带解决 60 次/小时限流）。**

### 4.5 版本策略

| 对象 | 规则 |
| --- | --- |
| 单个技能包 | 内容变更（`contentHash` 变化）→ `patch` bump；技能内仅新增文件 → `minor`；（不使用 major，破坏性变更对内容库无意义） |
| 索引包 | 任何技能包发布后必然重发索引（`patch`），保证 index 版本 = 全库一致快照 |
| 首次发布 | 全部技能 `1.0.0`；索引 `1.0.0` |
| dist-tag | 默认 `latest`；灰度期发 `beta` tag，MCP 端 `--npm-tag beta` 可指定 |

### 4.6 技能包 `package.json` 模板（发布脚本生成）

```json
{
  "name": "@codex-skills/ars",
  "version": "1.4.2",
  "description": "academic-research-skills-codex — ARS 学术研究全流程套件（自动生成，勿手改）",
  "license": "SEE LICENSE IN ../LICENSE",   // 或仓库统一许可证
  "publishConfig": {"access": "public"},
  "codexSkill": {                             // 私有元数据，MCP/工具链读取
    "folder": "ars",
    "name": "academic-research-skills-codex",
    "relativePath": "00_全局大管家/12_学术论文与科研图表/ars",
    "contentHash": "sha256-…",
    "filesTotal": 2281
  }
}
```

### 4.7 体积策略与超大技能处理（重要风险项）

npmmirror 对**超大 tgz 有同步白名单**（`data/allowLargePackages.json`，仅 103 包，例：`aws-cdk-lib`）。阈值未公开，**Phase 0 必须实测**。

分级策略（决策树）：

```
单技能 tarball 体积
├── ≤ 30MB（默认安全区，覆盖 ~98% 技能）
│     → 正常发 @codex-skills/<slug>
├── 30-80MB（灰区，取决于 Phase 0 实测阈值 T）
│     → 若 T ≥ 80MB：正常发
│     → 否则：拆分 —— 主包(≤30MB, 文档+脚本) + 资产包 @codex-skills/<slug>-assets
│        MCP 侧：read_skill 先拉主包；资产包标记 lazy，load_skill_file 触及资产时再拉
└── > 80MB（目前已知：hand-drawn-styles ~70MB 在灰区；codegraph 22MB/15MB 文件正常）
      → 拆分为多个资产包；仍超则该技能保留 GitHub 模式兜底（--source github 按技能覆盖）
```

已知大技能清单（来自 `.category-trees.json` 统计，Phase 1 复核）：

| 技能 | 文件数 | 体积 |
| --- | --- | --- |
| hand-drawn-styles | 41 | 69.9MB |
| ppt-master | 367 | 37.6MB |
| last30days-skill | 256 | 28.7MB |
| codegraph（单文件 22.5MB） | — | — |
| ars | 2281 | 35.9MB |

> 注：tar.gz 对文档/文本压缩比高（ars 35.9MB unpacked → tarball 预计 8-15MB），**阈值判断以 tarball 实际体积为准**，上表是 unpacked 体积。Phase 0 打包后按真实 tarball 体积重新分级。

---

## 5. MCP server 改造设计

### 5.1 配置（`src/config.ts`）

新增 CLI/环境变量（与现有 `--github-*` 并存，`--skills-dir`/`CODEX_SKILLS_DIR` 本地模式优先级不变）：

| CLI | 环境变量 | 默认 | 说明 |
| --- | --- | --- | --- |
| `--source npm\|github` | `CODEX_SKILLS_SOURCE` | `npm`（v2 起；v1.x 保持 `github`） | 分发通道 |
| `--npm-scope` | — | `@codex-skills` | 索引与技能包 scope |
| `--npm-registry` | `CODEX_SKILLS_NPM_REGISTRY` | `https://registry.npmmirror.com` | 主 registry |
| `--npm-registry-fallback` | — | `https://registry.npmjs.org` | 兜底 registry |
| `--npm-tag` | `CODEX_SKILLS_NPM_TAG` | `latest` | dist-tag（灰度期用 `beta`） |

Config 接口扩展：

```ts
export interface Config {
  // …现有字段不动…
  source: "npm" | "github";
  npmScope: string;
  npmRegistry: string;
  npmRegistryFallback: string;
  npmTag: string;
}
```

### 5.2 新模块 `src/remote/npm.ts`（核心，~300 行）

实现与 `github.ts` 相同的三个入口函数，`src/index.ts` 按 `config.source` 选择实现（策略模式，工具层 `read-skill.ts` / `load-skill-file.ts` / `list-skill-files.ts` 调用点签名不变）：

```ts
// ① manifest：HEAD packument 比对版本 → 变了才拉索引 tarball
async function fetchManifestViaNpm(config): Promise<void> {
  // GET {registry}/@codex-skills%2Findex  (scoped 包名 URL 编码)
  //   → dist-tags[config.npmTag] = latestVersion
  //   若 本地 meta.indexVersion === latestVersion 且 manifest 存在 → 直接返回（0 请求开销）
  //   否则 GET {registry}/@codex-skills/index/-/index-{latestVersion}.tgz
  //   → 解压出 skills_manifest.json → 校验 JSON → 写 config.manifestPath
  //   → 写 meta {indexVersion: latestVersion, validatedAt: Date.now()}
  // 302 重定向（→cdn.npmmirror.com）由 fetch 默认跟随
}

// ② 技能下载：1 个 tarball + sha512 校验 + 原子解压
async function ensureSkillFetchedViaNpm(config, entry, onProgress?): Promise<void> {
  // 快路径与 github.ts 相同：TREE_CACHE_FILE 存在且 filesUpToDate → return（热读 0ms）
  // 1. GET {registry}/{pkg}/-/{name}-{version}.tgz（包名/版本/integrity 全部来自 manifest 条目）
  // 2. 校验 sha512（manifest.npm.integrity vs tarball 字节流）——防 CDN 污染/中间篡改
  // 3. 解压到 <cacheDir>/<relative_path>.tmp-{pid}/ → 全部成功后 rename 到正式目录（原子性，
  //    消除 GitHub 模式的"半成品缓存"状态；skill_status 不再出现 INCOMPLETE）
  // 4. 写 TREE_CACHE_FILE（files 清单来自索引 manifest，不再调 api.github.com 列树）
  //    → readSkillCacheState / skill_status / 搜索索引 全部兼容
  // onProgress：两阶段（下载 0-70%，解压 70-100%），保留 MCP notifications/progress，
  //            客户端 opt-in 后可防 60s 超时（现有机制不变）
}

// ③ 节流刷新：复用现有 5min 轮询思想，改为单请求 HEAD
async function refreshManifestIfStaleViaNpm(config): Promise<boolean> {
  // 距上次校验 < manifestPollMs → false
  // 否则 GET packument dist-tags（0.2s，npmmirror 实测）比对 indexVersion
  // 变了 → fetchManifestViaNpm；失败 → 静默节流（沿用现有容错语义）
}
```

**Registry fallback 逻辑**（所有请求共用）：

```
请求(registry=npmmirror)
├── 200/304 → 用
├── 404 且 registry≠fallback → 可能是 npmmirror 未同步（新版本延迟）
│     ├── 重试 1 次（间隔 2s，给按需同步留时间）
│     └── 仍 404 → 切 {npmRegistryFallback}（npmjs，直连实测 0.99s 可用）并在本轮记住
└── 网络错误 → 同上切换
```

### 5.3 缓存兼容性（关键设计约束）

| 项 | GitHub 模式 | npm 模式 | 兼容策略 |
| --- | --- | --- | --- |
| 技能落盘路径 | `<cache>/<relative_path>/…` | 相同 | ✅ 完全一致，`SkillLoader`（`src/loader/index.ts`）与搜索索引零改动 |
| `.codex-skills.tree.json` | 记录 files+sizes+source(github) | 记录 files+sizes+source(npm) | `sameSource()` 扩展：npm source 用 `scope+tag` 标识；**切 source 后首次 read 会因 source 不同而重拉一次**（可接受；或放宽为按 contentHash 比对则免重拉——Phase 2 决定，倾向后者） |
| `skills_manifest.json` | v1（无 npm 字段） | v2（npm 字段可选叠加） | v2 读代码向后兼容 v1；GitHub 模式读到 v2 忽略 npm 字段 |
| `.codex-skills.manifest.meta.json` | etag/lastModified | indexVersion | 新增字段，互不干扰 |

### 5.4 行为变化对照

| 场景 | 现状（GitHub） | 新（npm） |
| --- | --- | --- |
| 冷启动 manifest | 2.1s（直连通）/ 11.6s（快失败回退）/ **21s（死等 20s）** | **~1-2s**（HEAD 0.2s + 索引 tarball <1MB） |
| `search` / `list_categories` / `plan_workflow` | 0.01-0.03s（本地索引） | 不变（纯本地） |
| `read_skill` 冷读（p50，39 文件/341KB） | 13.7-18.1s | **~1-2s**（1 次请求+解压） |
| `read_skill` 冷读（ars，2281 文件/36MB） | 51.9s（opt-in progress）/ 60s 超时；实际 3-12 分钟 | **~11-13s**（36MB tar.gz ≈ 10MB @ 3.2MB/s + 解压；**且不再撞 60s 超时的结构性风险大幅降低**） |
| `read_skill` 热读 | 0.00-0.03s | 不变 |
| `list_skill_files`（未下载技能） | api.github.com 2 次调用 | **0 次网络请求**（索引内 files 清单） |
| 技能内容更新后首读 | 直连优先 30s 死等风险 | 版本比对 → 1 次 tarball |
| api.github.com 限流 | 60 次/小时（未认证） | **0 依赖** |
| 半成品缓存/断点续传 | 存在（需重试续传） | **消失**（原子解压） |

### 5.5 客户端配置示例

WorkBuddy / Claude Desktop / Cursor（`mcp.json`）：

```jsonc
{
  "mcpServers": {
    "codex-skills": {
      "command": "npx",
      "args": ["-y", "codex-skills-mcp@2.0.0-beta.1"]   // v2 默认 --source npm
      // 可选显式：
      // "args": ["-y","codex-skills-mcp@latest","--source","npm",
      //          "--npm-registry","https://registry.npmmirror.com"]
    }
  }
}
```

回滚（GitHub 模式）：

```json
"args": ["-y", "codex-skills-mcp@2.0.0-beta.1", "--source", "github"]
```

> npx 首次冷装 45s 撞 60s 超时的问题依旧存在（与分发通道无关），文档中继续建议"首次手动终端预热"。可选优化：v2 增加启动早期 `console.error` 进度提示，帮助用户识别这是 npm install 阶段。

---

## 6. 发布流水线（CI）

### 6.1 流程（GitHub Actions，`.github/workflows/publish-skills.yml`）

```
触发：push 到 main 且 codex-skills/** 有变更（或手动 workflow_dispatch）

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      1. checkout（full history，供 hash 对比）
      2. 安装 Node 20+
      3. node scripts/publish-skills.mjs --dry-run --diff   # 产出变更清单到 GITHUB_STEP_SUMMARY
      4. 若 dry-run 变更数为 0 → 跳过后续
      5. node scripts/publish-skills.mjs --publish          # 见下
      6. npm dist-tag add @codex-skills/index@<ver> beta（灰度期）

scripts/publish-skills.mjs 逻辑：
  a. 扫描 codex-skills/ 全部技能目录 → 计算 contentHash（排序后文件 SHA-256 Merkle）
  b. 拉上一个索引包版本 → 对比 contentHash
  c. 变更技能：生成/更新其 package.json（版本 bump 规则见 4.5）→ npm pack → npm publish
     - 限速：每 publish 间隔 ≥ 3s，批间 30s（npm 速率限制；首发 290 包分批约 20 分钟）
     - 失败重试 2 次；单包失败不阻塞其余，最后汇总
  d. 新技能：slug 生成 + 冲突检测 → 1.0.0 首发
  e. 移除技能：npm unpublish --force（72h 内）或 deprecate（超时），索引剔除
  f. 重新生成 skills_manifest.json v2（含 files 清单、npm 字段）→ 发布 @codex-skills/index
  g. 触发 npmmirror 同步（可选加速）：
     对每个新版本 GET https://registry.npmmirror.com/<pkg>/<version>
     （npmmirror 按需同步：未命中即触发后台同步，几十秒-几分钟内可用）
```

### 6.2 密钥与安全

- `NPM_TOKEN`：npmjs **granular token**，仅授权 `@codex-skills` scope + publish 权限，存 GitHub Actions Secrets
- 索引包即"全库信任根"：MCP 端对每个技能 tarball 做 sha512 校验（integrity 来自索引），CDN 层被污染也无法注入内容
- token 季度轮换；发布日志归档

### 6.3 npmmirror 同步延迟（已知的体验折损）

- npmmirror 对 popular 包定时同步，长尾包**按需同步**（首次访问触发）
- 影响：刚发布的新技能/新版本，国内用户首次请求可能 404 几十秒-几分钟
- 对策三层：① CI 发布后主动 GET npmmirror 触发同步（6.1-g）；② MCP fallback 到 npmjs（5.2）；③ `read_skill` 对"索引有但包 404"给出明确提示"镜像同步中，稍后重试或已自动走 npmjs"

---

## 7. 风险与对策总表

| # | 风险 | 概率 | 影响 | 对策 |
| --- | --- | --- | --- | --- |
| 1 | npmmirror 超大 tarball 不同步（阈值未知） | 中 | 大技能国内 404 | Phase 0 实测阈值；4.7 体积分级/拆分；fallback npmjs |
| 2 | npmmirror 新版本同步延迟 | 高（每次发布） | 低 | 触发同步 + fallback + 明确提示 |
| 3 | 首发批量 publish 触发 npm 限速 | 中 | 发布变慢 | 分批+间隔（6.1-c），一次性成本 |
| 4 | 包名 slug 冲突/不稳定 | 低 | 索引错乱 | slug 只来自 folder + 索引固化映射，MCP 不自行推导 |
| 5 | npmjs 账号/token 泄露 | 低 | 高 | granular token + scope 限制 + 轮换；sha512 校验兜底内容完整性 |
| 6 | npmjs 整体不可用（极端） | 低 | 高 | npmmirror 已有全量副本（分发不依赖 npmjs 在线）；新增发布受阻 |
| 7 | 技能内文件名特殊字符破坏 tar | 低 | 单技能失败 | Phase 1 全量 pack 演练（dry-run 全库打包本地校验）；UTF-8 文件名实测 |
| 8 | 用户侧 npm 通道也被墙（npmmirror+npmjs 同时不可达） | 极低 | 高 | `--source github` 一键回滚；此场景 GitHub 通道同样不可用，属整体断网 |
| 9 | 索引包膨胀（未来技能×文件数增长） | 低 | 启动稍慢 | gzip 压缩比高；>5MB 时拆 files 清单为按需接口 |
| 10 | 与 GitHub 模式缓存互踩 | 低 | 重拉一次 | source 标识入 tree 缓存；或 contentHash 比对免重拉（Phase 2 定） |

---

## 8. 测试与验收

### 8.1 Phase 0 验证项（先行，半天）

| # | 验证 | 方法 | 通过标准 |
| --- | --- | --- | --- |
| 0.1 | npmmirror 大包阈值 | 发布 30/50/80MB 三个测试 tarball（如 `@codex-skills/_probe-30m`），观察是否同步 | 确定阈值 T，写入 4.7 分级 |
| 0.2 | scoped 包发布+同步延迟 | 发 1 个真实技能包（如 ars），计时 npmmirror 可见性 | 首访触发同步后 ≤5 分钟可用 |
| 0.3 | 中文文件名 tar 兼容 | 打包含 `WPS拼图0.png` 的技能，解压 diff | 字节级一致 |
| 0.4 | 302 → cdn.npmmirror.com 直连可用性 | 已实测 ✅（0.5-0.7s，3.2-4.2MB/s） | — |

### 8.2 端到端验收（直连环境，代理关闭，参照本次实测方法）

冷缓存、无代理，各场景 3 次取中位：

| 用例 | 现状基线（实测） | 验收目标 |
| --- | --- | --- |
| 启动 + initialize | 2.1-21s | ≤ 3s |
| search_skills | 0.02s | 不劣化 |
| read_skill（6 文件技能） | 3.1-13.5s | ≤ 3s |
| read_skill（39 文件技能） | 13.7-18.1s | ≤ 3s |
| read_skill（304 文件技能） | 28.8-31.0s | ≤ 8s |
| read_skill（ars 2281 文件） | 51.9s ~ 12 分钟 | ≤ 20s |
| read_skill 热读 | 0.00-0.03s | 不劣化 |
| 全程 api.github.com 请求数 | ≥2/技能 | **0** |
| npm registry 请求总数（一次冷读） | — | ≤ 3（HEAD packument + tarball + 可选 fallback） |

### 8.3 回归测试

- `--source github` 全工具回归（现有 `test_mcp_smoke.mjs` 改造为双 source 参数化）
- `--skills-dir` 本地模式回归
- 缓存混用：npm 模式下载 → 切 github 模式 → 反向，观察 source 校验行为
- 索引 v1/v2 互读兼容

---

## 9. 实施计划

| 阶段 | 内容 | 产出 | 工作量 |
| --- | --- | --- | --- |
| **P0 探针验证** | 8.1 全部四项；创建 npm org `codex-skills`；发探针包 | 阈值结论 + go/no-go | 0.5 天 |
| **P1 打包发布脚本** | `scripts/publish-skills.mjs`（扫描/hash/slug/打包/发布/索引生成），全库 dry-run 演练 | 290+1 包就绪（本地 tarball + 变更清单） | 1 天 |
| **P2 MCP npm source** | `src/remote/npm.ts` + config 扩展 + 策略选择 + 原子解压 + integrity 校验 + fallback | `--source npm` 可用 | 1-1.5 天 |
| **P3 CI 接线** | publish workflow + secrets + 同步触发 + 灰度 tag | push 即发布 | 0.5 天 |
| **P4 验收灰度** | 8.2/8.3 全量；`@beta` tag 灰度；README/WorkBuddy/Claude/Cursor 配置文档 | 性能报告 + v2.0.0-beta.1 发布 | 0.5-1 天 |
| **P5 转正** | 默认 `--source npm`；GitHub 模式标记 legacy（保留 ≥2 个大版本） | v2.0.0 | — |

总计约 **4 天**。P0 未通过（阈值过低且拆分不可行）时回退评估 OSS 方案，不硬上。

---

## 10. 附录

### A. 与备选方案的最终对比（为什么是 npm tarball）

| 方案 | 请求数（ars） | 直连可用性 | 审批依赖 | 结论 |
| --- | --- | --- | --- | --- |
| **npm tarball（本方案）** | **1** | npmmirror 0.2s/3.2MB/s + npmjs 兜底 | 无 | ✅ |
| npmmirror unpkg 白名单 | 2281 | 最快（0.14s/文件） | 需人工审批，内容库有被拒先例（GKD） | ❌ |
| jsDelivr npm 路由逐文件 | 2281 | 0.85s 热缓存，冷回源 2-6s | 无 | 备选（仍受单请求延迟×N 限制） |
| 继续 GitHub + 换节点 | 2281 | 节点大面积失效/限速，gh-proxy 次日封禁 | 无 | ❌（本次实测否决） |
| 自建 gh-proxy / Gitee 镜像 | 2281 | Gitee 0.16MB/s；自建需运维 | 无 | 兜底，不解决请求数 |

### B. 现有代码接入点索引

| 文件 | 改动 |
| --- | --- |
| `src/config.ts` | +source/npm* 五个字段与解析（5.1） |
| `src/remote/npm.ts` | **新增**：fetchManifestViaNpm / ensureSkillFetchedViaNpm / refreshManifestIfStaleViaNpm |
| `src/remote/github.ts` | 不动（legacy）；`sameSource()` 类型扩展 |
| `src/index.ts` | 按 config.source 选择 remote 实现；启动横幅提示 source |
| `src/tools/*.ts` | **零改动**（依赖的 ensureSkillFetched/manifest 接口签名不变） |
| `src/loader/index.ts` | **零改动**（缓存目录结构不变） |
| `scripts/publish-skills.mjs` | **新增**（P1） |
| `.github/workflows/publish-skills.yml` | **新增**（P3） |

### C. 术语

- **packument**：`GET /<pkg>` 返回的包元数据 JSON（含 `dist-tags`、各版本 `dist.integrity`/`tarball`）
- **npmmirror**：registry.npmmirror.com（阿里，原淘宝镜像），tarball 实际落 cdn.npmmirror.com
- **TREE_CACHE_FILE**：`.codex-skills.tree.json`，技能级缓存清单（`src/remote/github.ts`），npm 模式复用以保持 skill_status 兼容

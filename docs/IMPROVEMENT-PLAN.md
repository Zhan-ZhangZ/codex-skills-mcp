# codex-skills-mcp Agent 行为修正迭代方案（v1.4.0）

> 状态：已定稿，作为本次所有代码改动的唯一依据。
> 背景：用户反馈 Agent 在使用本 MCP 时"很粗暴"——搜索到 skill 后只读一下 SKILL.md 就自以为掌握了，
> 既不完整缓存技能、也不按技能指令执行、更不做多技能编排。本方案定位根因并给出系统性修复。

---

## 1. 问题陈述

用户预期的标准使用流程（本 MCP 的设计初衷）：

1. **理解意图** → 2. **检索定位**（search_skills / plan_workflow）→ 3. **组合选型**（最小技能组合）→
4. **落盘缓存**（read_skill 触发完整下载到本地缓存目录，已缓存则秒回）→
5. **严格按 SKILL.md 执行**（从本地缓存路径运行脚本/遵循指令）→ 6. **验证与汇报**。

核心价值主张：**用户不需要一次性下载全部技能库；通过日常使用逐步把用过的技能缓存到本地。**

实际观察到的 Agent 行为（问题）：

- P1：search → read_skill 拿到 SKILL.md 文本后，**凭通用知识直接开做**，把 SKILL.md 当"参考资料"而非"必须遵守的执行合约"；
- P2：不知道（也不被告诉）read_skill 已经把**整个技能目录**下载到了本地磁盘，更不知道下载到哪，因此无从"从本地执行"；
- P3：不做多技能编排（plan_workflow 的结果被无视或只挑一个）；
- P4：不区分"已缓存/未缓存"，没有"缓存优先"的倾向；
- P5：整个过程不可审计——出了问题无法回溯 Agent 到底调用了什么、下载了什么、哪一步报错。

## 2. 现状复盘（v1.3.3 代码事实）

| # | 事实 | 出处 |
|---|------|------|
| F1 | 6 个工具的 description 全是"能力描述"（Search…/Read…/List…），**无一处 MUST/工作流约束** | src/tools/*.ts |
| F2 | read_skill 返回体**不含本地缓存路径、不含缓存状态**，结尾语是 "Use load_skill_file(…) to read any file"——把 Agent 引向"继续通过 MCP 读文件"而非"从本地执行" | src/tools/read-skill.ts L100 |
| F3 | 事实上 read_skill 内部已经调用 ensureSkillFetched **下载完整技能目录**（全部文件、断点续传、.codex-skills.tree.json 完成标记），但这个关键事实对 Agent 完全不可见 | src/loader/index.ts L86-89, src/remote/github.ts |
| F4 | MCP initialize 结果中**没有 server instructions**（McpServer 只传了 name/version） | src/index.ts L46-49 |
| F5 | 默认缓存目录 `~/.codex-skills-cache`（README 却写成"当前目录 .codex-skills-cache/"，文档与实现不一致） | src/config.ts L84 vs README L35 |
| F6 | 无任何持久化日志；所有日志走 stderr，在 stdio/HTTP 客户端里基本丢失 | 全局 |
| F7 | 无缓存状态查询、无诊断工具；search/plan 结果不带缓存标记 | 全局 |
| F8 | plan_workflow 输出只是"分组搜索结果"，不产出有序执行计划，也不强制"先把选定技能全部 read_skill" | src/tools/plan-workflow.ts |

## 3. 根因分析

- **R1（最关键）提示层缺少"行为合约"**：LLM Agent 对 MCP 的认知 100% 来自三个信号——server instructions、tool description、tool result 文本。三者都没有把"下载→严格按指令执行"定义为 MUST，Agent 自然走捷径（P1）。
- **R2 可执行性信息缺失**：技能已完整落盘这一事实被吞掉（F2/F3），Agent 没有本地路径就没有"执行入口"，只能退化为"我读了说明，我自己做"（P2）。
- **R3 死胡同式结尾语**：read_skill 的结尾指引指向 load_skill_file（继续读），而不是执行（F2），等于主动引导 Agent 偏航。
- **R4 状态不可见**：缓存状态（已缓存/未缓存/完整性）无任何工具暴露（F7），"缓存优先"无从谈起（P4），执行前也无法验证（P5）。
- **R5 不可审计**：无活动日志、无错误记录、无诊断出口（F6），用户无法证明 Agent 是否真的走了完整流程（P5）。
- **R6 编排产出太弱**：plan_workflow 不给有序计划、不给"先全部物化"的强制下一步（F8），多技能组合形同虚设（P3）。

**结论：不是 Agent"轻视"，是我们把关键事实（已完整下载、在哪、下一步该执行）藏在了实现里，且三个提示层面都没有签订行为合约。**

## 4. 设计原则

1. **提示即合约（Prompt-as-Contract）**：server instructions、每个 tool description、每个 tool result 尾部三处，用同一套措辞强化同一条 5 步协议（DISCOVER → SELECT → MATERIALIZE → EXECUTE → VERIFY）。措辞集中在 `src/lib/protocol.ts` 单点维护。
2. **让"已缓存、在哪、可执行"成为一等公民**：read_skill 返回体新增 Cache & Execution 段（状态、local_path、文件数、体积、setup 命令）；search/plan 结果带 `[cached]` 徽标。
3. **缓存优先**：搜索结果展示缓存徽标，instructions 明示"分数相近时优先选已缓存技能"。
4. **可审计、可诊断**：全工具调用落 JSONL 活动日志（含错误），新增 diagnostics 工具读取近期日志/错误/缓存统计。
5. **向后兼容**：不改变既有工具的入参 schema；只增不删（新增 2 个工具）；HTTP/stdio 双模式行为一致。

## 5. 改动清单（文件级）

| 文件 | 改动 | 对应根因 |
|------|------|----------|
| docs/AGENT-PROTOCOL.md | 新增：面向 Agent 的标准工作流合约（中英双语） | R1 |
| docs/IMPROVEMENT-PLAN.md | 本文档 | — |
| docs/CHANGELOG.md | 新增：每次改动 ↔ 文档映射 | 流程要求 |
| src/lib/protocol.ts | 新增：协议文案单点维护（server instructions 片段、各工具 NEXT STEP 尾部、禁令清单） | R1/R3 |
| src/lib/logger.ts | 新增：JSONL 活动日志（按天分文件、保留 14 天、best-effort 不抛错）、withToolLogging 包装器 | R5 |
| src/remote/github.ts | 导出 readSkillCacheState(config, entry)（深检：marker+逐文件大小核对）；下载事件接入日志 | R2/R4/R5 |
| src/loader/index.ts | 暴露 cacheState(entry)（轻检：marker+completedAt）与深检代理 | R2/R4 |
| src/tools/search-skills.ts | description 重写；结果带 [cached] 徽标；协议尾部 | R1/R4 |
| src/tools/plan-workflow.ts | description 重写；产出有序执行计划；带缓存徽标；"先全部物化"尾部 | R1/R6 |
| src/tools/read-skill.ts | description 重写；返回体新增 Cache & Execution 段（local_path 等）；执行导向尾部 | R1/R2/R3 |
| src/tools/load-skill-file.ts / list-skill-files.ts / list-categories.ts | description 与尾部对齐协议 | R1 |
| src/tools/skill-status.ts | 新增工具 skill_status：批量查询缓存完整性/本地路径/缺失文件 | R4 |
| src/tools/diagnostics.ts | 新增工具 diagnostics：近期调用、错误、缓存统计、配置摘要 | R5 |
| src/index.ts | McpServer 增加 instructions；注册新工具；日志初始化；注册数文案 | R1/R5 |
| README.md | 8 工具清单、Agent 标准工作流章节、日志与诊断章节、缓存目录说法修正（~/.codex-skills-cache） | F5 |
| package.json | version 1.4.0 | — |
| test/test_protocol.mjs | 新增：stdio 协议冒烟测试（断言见 §8.1） | 验证 |
| scripts/mcp-client.mjs | 新增：极简 stdio MCP 客户端 CLI，供 E2E/子代理验证用 | 验证 |

## 6. 新工具规格

### 6.1 skill_status
- 入参：`{ names: string }`（逗号分隔，1..20 个）
- 出参（每个技能）：found / cached / complete / local_path / files_total / files_missing[] / size_bytes / completed_at / error
- 轻检（marker+completedAt）快速返回，complete 字段做深检（逐文件大小核对）。
- 用途：执行前验证物化完整性；诊断半截下载。

### 6.2 diagnostics
- 入参：`{ include_log?: boolean, log_lines?: number }`（默认 true / 20）
- 出参：版本、模式(remote/local)、cache_dir、清单（技能数/年龄）、缓存统计（已缓存技能数/总体积）、最近错误（活动日志中 level=error 的最近 N 条）、最近调用（最近 N 条 tool_call）。
- 用途：报错诊断与行为审计。

## 7. 日志规格

- 位置：`<cacheDir>/logs/mcp-activity-YYYY-MM-DD.jsonl`（每行一条 JSON）。
- 事件：`tool_call`（含 duration_ms/ok/错误摘要）、`download_skill_start`、`download_skill_complete`、`server_start`。
- 字段：`{ts, level, event, tool?, skill?, duration_ms?, ok?, detail?, error?}`。
- 策略：append-only、按天分文件、保留最近 14 天；所有写失败静默吞掉（绝不影响主流程）；同时镜像关键事件到 stderr。
- 隐私：不记录完整工具入参，只记录摘要（query/skill 名等），避免大段内容写入日志。

## 8. 验证方案

### 8.1 协议冒烟测试（test/test_protocol.mjs，stdio 直连构建产物）
断言清单：
1. initialize 结果含非空 instructions，且包含 5 步协议关键词（MATERIALIZE/EXECUTE）；
2. tools/list 含 8 个工具；read_skill description 含 MUST/complete local cache 语义；
3. search_skills 返回尾部含 NEXT STEP 物化指引；
4. read_skill 返回体含 "Cache & Execution"、local_path 指向真实存在的目录；
5. skill_status 对刚读过的技能返回 complete=true；
6. diagnostics 返回近期 tool_call 与缓存统计；
7. 活动日志文件存在且含本次 tool_call 事件。

### 8.2 子代理端到端行为验证（黑盒）
方法：启动一个**不知情**子代理（只给任务与 scripts/mcp-client.mjs 用法，绝不告知协议内容），
让它完成一个真实小任务；随后审计活动日志 + 子代理自述，判定：
- 是否走了 search/plan → read_skill（触发下载）→ （可选 skill_status）→ 从 local_path 执行；
- read_skill 返回的 Cache & Execution 段是否被引用；
- 是否出现"不物化直接开做"的反模式。
通过标准：主链路全部成立，且子代理自述中明确"按 SKILL.md 执行而非自由发挥"。

## 9. 风险与回滚
- 文案变长会略增每次调用的 token 开销（尾部 ≤120 token，可接受）；
- 深检逐文件 stat 在超大技能上有开销 → 仅 skill_status 做深检，search 徽标用轻检；
- 回滚：本迭代全部为增量改动，revert 单个 commit 即可恢复 v1.3.3 行为。

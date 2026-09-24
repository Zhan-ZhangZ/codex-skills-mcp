# CHANGELOG

本文件记录每次改动 ↔ 文档的映射。一切改动需有文档跟随（docs/IMPROVEMENT-PLAN.md §5）。


### 测试逻辑制度化：不知情子代理 E2E 成为标准验收层（2026-09-24）

应技能库所有者要求，将四轮实战沉淀为可复用资产：

- `test/agent-e2e-template.md`：不知情子代理标准提示模板（占位符化任务/产物目录）+ 使用纪律（不知情红线、任务真实性/有界性/留痕、固定三问）+ 审计流程 + 四条通过标准 + 缺陷处置红线（不修上游技能本体）。
- `test/audit_protocol.py`：活动日志客观审计器——基线行数之后的事件流自动判定 DISCOVER→MATERIALIZE 顺序、冷下载事件、真实执行间隔（配对式，免疫多会话混合日志）、VERIFY 步骤，输出 PASS/FAIL。已用当日真实日志三场景验证：第三轮 PASS、第四轮 PASS、负控（纯手动刷新会话）FAIL，判定正确。
- 配套规范落点：codexproject 集成规则 06_e2e_verification.md 新增「步骤四：不知情子代理实测」，并将验收标准从"API 三步"升级为"步骤四四条全绿"。

### 验证结果 · 第四轮（真实网络采集 + 参数签名反哺，2026-09-24）

不知情子代理对 chubbyskills（已缓存，106 文件修复版）执行真实网络任务：采集用户提供的公众号文章 → 入库 → 检索 → 选题资料包。

- **协议链客观成立**：plan(02:43:43) → search×3 → read_skill(02:43:58) → load_skill_file×3（README→wechat 子技能→kb 子技能，正确走完包路由链）→ 2m50s 本地执行（env 检查→setup→init→**真实网络 ingest**→search×4→brief→健康检查）→ skill_status(02:47:08)。
- **采集真实有效**：文章《她的指尖，有图书馆守候的光》7322 字入 vault（schema v1 frontmatter 含 source/captured_at/run_id/source_hash）；审计者独立复检 `search "盲文"` 命中；brief 带证据编号/逐字摘录/行号/SHA-256；子代理还按 brief 内嵌任务生成了选题提案。
- **缺陷⑤（本仓库，已修）**：`mcp-client.mjs list` 只打印工具名不打印参数签名，两轮 E2E 中子代理均靠 zod 报错试参数（浪费 3 次调用）。现 list 输出 `tool(必填, [可选])` 签名。
- **缺陷⑥⑦（codexproject 技能侧，待修）**：`setup.sh` 在 Homebrew Python 下遇 PEP 668 直接失败、无 venv 回退；`chubby.py init` 不落 vault-template 骨架（子代理手动 `cp vault-template/.` 补齐）。

## v1.4.2 — 技能内容刷新走权威源（修复镜像滞后导致的"永久 missing"）

现场：codexproject 推送 chubbyskills 修复后，缓存刷新出现"missing 1/106"死循环。字节级取证：
GitHub 直连 12702B（新）vs jsDelivr 12336B（旧）vs 本地缓存 12336B（=镜像旧版）——
`downloadMissing` 对**更新型文件**也走四镜像竞速，滞后的 jsDelivr 在 CN 最快、反复把旧字节写回，
尺寸永与新树对齐不上。与 2026-09-24 清单事故 R4 同类（镜像污染），但发生在文件层。

修复（src/remote/github.ts）：
- 新增 `fetchRawDirectFirst`：直连 GitHub 优先（带鉴权/动态超时），直连不可用才退回镜像竞速，失败记 `refresh_direct_failed` 日志事件；
- `downloadMissing` 分流：本地已存在的文件（=尺寸不符的**刷新**）走权威直连优先；全新文件保留竞速抢速度——速度与正确性各得其所。

验证：live 复测 chubbyskills 刷新（当时镜像仍滞后），refresh 后本地字节=12702B 与权威一致，
skill_status complete；test_protocol.mjs 回归通过。

### 验证结果 · 第三轮（chubbyskills 全链路实测 + 缺陷反哺，2026-09-24）

不知情子代理对 chubbyskills（14 子技能路由包，冷缓存）执行真实知识库任务：建 vault → 导入本地文章 → 检索验证（含负对照）→ 生成证据简报。

- **协议链客观成立**：search(02:19:57) → plan(02:20:03) → read_skill(02:20:11) → **download 105/105 files(02:20:14)** → load_skill_file(子技能SKILL.md+README) → 2.5 分钟本地执行(init/import/search/brief) → skill_status(02:23:05)。
- **任务结果独立复核**：vault 笔记含 frontmatter+SHA-256；brief 带证据编号/逐字摘录/行号/哈希；审计者重跑 search 命中一致；负对照「量子计算」正确返回无匹配。
- **缺陷①（本仓库，已修）**：scripts/mcp-client.mjs 对 isError=true 的工具级失败仍 exit 0——校验错误是"成功的RPC+错误结果"，现按 exit 1 上抛（实测 bad-args=1 / good-args=0）。
- **缺陷②③④（codexproject 技能侧，待修）**：doctor 引用的 tools/check_env.py 缺失；chubby.py init 相对 --config 路径时运行时目录落进技能缓存目录；brief 原文链接为依赖 macOS 符号链接的怪异相对路径。
## v1.4.1 — 清单新鲜度修复：条件轮询 + read_skill 自愈

依据：docs/IMPROVEMENT-MANIFEST-FRESHNESS.md（2026-09-24 chubbyskills 集成事故，根因 R1–R5）

| 改动 | 文件 | 对应根因 |
|------|------|----------|
| 新鲜度轮询配置（`--manifest-poll` / env，默认 300s，0=关） | src/config.ts | R1 |
| meta 边车（etag/validatedAt）+ `refreshManifestIfStale()` 条件 GET（直连权威源、失败静默降级）+ `manifest_poll/refresh/poll_failed` 日志事件；镜像来源清单不带 etag，下次轮询自动纠偏 | src/remote/github.ts | R1/R4 |
| `maybeRefreshManifest()`：轮询命中变更时原位重建索引，长驻进程也能看到新技能 | src/search/index.ts | R2 |
| search_skills / plan_workflow 调用前轮询 | src/tools/search-skills.ts, plan-workflow.ts | R2/R3 |
| read_skill 查无此名 → 轮询复查一次 + 报错给出 force_refresh 指引 | src/tools/read-skill.ts | R5 |
| diagnostics 增列 last freshness check / etag / poll 配置 | src/tools/diagnostics.ts | 可观测 |
| 事故复现→自动恢复端到端测试（毒化清单） | test/test_freshness.mjs | 验证 |

验证：test_freshness.mjs 6/6（陈旧清单场景 search 命中、read_skill 自愈、日志留痕）；test_protocol.mjs 19/19 回归通过。

## v1.4.0 — Agent 行为修正：提示即合约 + 缓存可见 + 可审计

依据：docs/IMPROVEMENT-PLAN.md（根因 R1–R6）

| 改动 | 文件 | 文档 |
|------|------|------|
| 新增 Agent 工作流合约（本迭代纲领） | docs/AGENT-PROTOCOL.md | — |
| 协议文案单点维护（instructions/描述/尾部） | src/lib/protocol.ts | PLAN §4.1 |
| JSONL 活动日志（按天/保留 14 天/静默容错） | src/lib/logger.ts | PLAN §7 |
| 缓存状态读取（轻检/深检）+ 下载事件日志 | src/remote/github.ts, src/loader/index.ts | PLAN §5 |
| 6 个既有工具 description 与输出尾部重写 | src/tools/*.ts | PLAN §5, AGENT-PROTOCOL |
| read_skill 返回体新增 Cache & Execution 段（local_path 等） | src/tools/read-skill.ts | PLAN §5 (R2/R3) |
| search/plan 结果新增 [cached] 徽标 | src/tools/search-skills.ts, plan-workflow.ts | PLAN §5 (R4) |
| 新增 skill_status / diagnostics 工具 | src/tools/skill-status.ts, diagnostics.ts | PLAN §6 |
| server instructions 注入 + 注册新工具 | src/index.ts | PLAN §5 (R1) |
| README：8 工具、标准工作流、日志诊断章节、缓存目录修正 | README.md | PLAN §5 (F5) |
| stdio 协议冒烟测试 + 极简客户端 CLI | test/test_protocol.mjs, scripts/mcp-client.mjs | PLAN §8 |

### 验证结果（v1.4.0，2026-09-22）

**协议冒烟测试（test/test_protocol.mjs）：19/19 通过** —— initialize instructions 含 5 步协议；8 工具注册；read_skill 描述含 MANDATORY/COMPLETE；search 返回 STEP 3 尾部；read_skill 返回 Cache & Execution 段且 local_path 真实存在；skill_status 报告 complete；diagnostics 显示近期调用与缓存统计；活动日志落盘且记录 tool_call。

**子代理端到端黑盒验证（不知情代理，仅经 CLI 网关）：通过**
任务：用技能库写 500 字知乎短帖「程序员为什么应该写周报」。活动日志客观记录（17:40:47–17:44:28）：

1. DISCOVER：search_skills ×2 → plan_workflow ✅
2. SELECT：选定 human-writing（注意到 [cached] 徽标）✅
3. MATERIALIZE：动笔前 read_skill 完整物化，随后按 SKILL.md 顺序 load_skill_file（README → forum-prose → formats；revision.md 严格留到初稿后）✅
4. EXECUTE：从 local_path 运行 check_prose.py 两轮直至禁令清零（两段 ~80s 无 MCP 调用的间隙即本地执行）✅
5. VERIFY：skill_status 确认 1/1 complete ✅

子代理自述将行为归因于服务器指令原文（"MANDATORY 5-step protocol"、"NEVER improvise a substitute for a loaded skill"、反模式清单），而非自行判断 —— 提示层合约生效。

**已知限制**：客户端传入参数未通过 zod 校验的调用在 SDK 层被拒绝，不会进入活动日志（handler 未执行）；此类失败可在客户端侧观察。

### 验证结果 · 第二轮（冷缓存 + 执行留痕，2026-09-22）

第一轮未覆盖的两个盲区：① 子代理命中了已缓存技能，未验证真实冷下载；② 本地执行仅有自述佐证。第二轮针对性补测（测试前删除 human-writing 缓存、清空产物目录 /tmp/e2e2，日志基线 68 行）：

- **冷下载客观成立**：日志 17:50:34 `read_skill` → `download_skill_start skill=human-writing 13/13 files` → 17:50:35 `download_skill_complete`；磁盘 marker `completedAt` 从 17:38:21（旧）变为 17:50:35.550Z（新），13 文件 101374 字节与删除前一致。
- **协议顺序客观成立**：plan_workflow(17:50:21) → search_skills(17:50:29) → read_skill+下载(17:50:34) → 5 分 40 秒无 MCP 调用间隙（本地执行：读 README/references、联网核验材料、写作、跑检查脚本）→ skill_status(17:56:15)。
- **执行留痕独立复核**：/tmp/e2e2/ 留有 9 个产物（CLI 输出、read_skill 全文、check_prose.py 输出、成稿）；审计者独立重跑 check_prose.py 结果与子代理一致（汉字 829，12 项禁令计数全 0）；抽查引用来源真实（Google eng-practices 页面含 "overall code health"）。
- **行为细节**：本轮代理直接从 local_path 磁盘读取 references（未走 load_skill_file），说明"本地执行入口"按设计生效；且其先读 README、初稿后才读 revision.md，与 SKILL.md 的流程编排一致。

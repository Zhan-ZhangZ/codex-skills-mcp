# CHANGELOG

本文件记录每次改动 ↔ 文档的映射。一切改动需有文档跟随（docs/IMPROVEMENT-PLAN.md §5）。

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

# 清单新鲜度修复方案（v1.4.1）

> 事件：2026-09-24 01:34–01:46 UTC，技能仓库集成 chubbyskills v0.13.0 并推送后，
> 客户端 MCP 长达 12 分钟搜不到新技能，Agent 反复重试 read_skill 失败 4 次，
> 最终靠两次 force_refresh 才恢复（活动日志 mcp-activity-2026-09-24.jsonl 全程留痕）。

## 1. 事故时间线（活动日志还原）

| 时间(UTC) | 事件 |
|-----------|------|
| ~01:15 | 仓库合并 chubbyskills 并推送 GitHub |
| 01:34:17 | search「中文内容采集 个人知识库 chubbyskills」→ 部分命中，未见 chubby |
| 01:34:21–01:42:55 | read_skill("chubbyskills") ×4 → tool_error（陈旧索引查无此名） |
| 01:43:04–14 | 另一轮 search ×5 + plan_workflow + diagnostics，仍未命中 |
| 01:43:19 | search chubby **force_refresh:true** → 未恢复 |
| 01:44 | 清单终于被刷新（拿到含 chubby 的版本） |
| 01:46:36 | 再次 force_refresh → 命中；01:46:49 read_skill 成功下载 |

## 2. 根因（代码级）

- **R1 新鲜度=本地文件年龄**：`fetchManifest` 用 mtime vs TTL(默认24h) 决定是否刷新。
  TTL 窗口内的远端变更完全不可见，重启进程也没用（src/remote/github.ts）。
- **R2 索引只在进程启动时构建一次**：长驻服务（HTTP 模式、跨会话复用的 stdio）永不重读清单。
- **R3 自动刷新条件太窄**：仅 search_skills 且仅"零结果"时触发；部分命中的查询掩盖了新技能
  （本次事故正是此形态）；plan_workflow 完全没有刷新钩子（src/tools/search-skills.ts / plan-workflow.ts）。
- **R4 镜像陈旧污染**：直连 GitHub 失败时清单走镜像竞速，jsDelivr 可能返回数小时前的旧清单并**覆盖写入**；
  force_refresh 走同一条链，所以也可能失败（README FAQ 早已记载此现象）。
- **R5 read_skill 失败无自愈/无指引**：名字查不到只报 not found，Agent 只能瞎重试 12 分钟。

## 3. 设计：分层新鲜度（条件请求轮询）

原则：**清单是检索的入口，它的时效决定一切**；用最廉价的条件请求（304）把盲区从 24h 压到分钟级，
失败时静默降级，绝不阻塞检索。

1. **节流条件轮询**：search_skills / plan_workflow 调用时，若距上次校验超过 poll 间隔
   （默认 300s，`--manifest-poll <秒>` / `CODEX_SKILLS_MANIFEST_POLL_SECONDS`，0=关闭），
   对**权威直连 URL** 发条件 GET（If-None-Match/If-Modified-Since，meta 存于
   `.codex-skills.manifest.meta.json`）。304→只更新校验时间；200→校验后替换清单+重建索引，
   记 `manifest_refresh` 事件；失败→静默保留本地并更新校验时间（节流防打爆）。
   超时上限 4s，超时按失败处理。
2. **read_skill 自愈**：名字查不到时先执行一次同样的节流校验并复查；仍无则报错并明确提示
   「可能是清单陈旧，用 search_skills(query, force_refresh=true) 强刷」。
3. **三级刷新梯队**：节流条件轮询（每次检索，304 级开销）→ 零结果全量刷新（保留）→
   force_refresh 显式强刷（人工逃生门）。
4. **镜像污染标记**：经镜像拿到的清单在 meta 里不带 etag，下次轮询直连成功即以 200/etag 纠偏。
5. **可观测**：diagnostics 增列 last-validated / etag / poll 配置；活动日志新增
   `manifest_poll` / `manifest_refresh` / `manifest_poll_failed` 事件。

## 4. 改动清单

| 文件 | 改动 | 对应根因 |
|------|------|----------|
| docs/IMPROVEMENT-MANIFEST-FRESHNESS.md | 本文档 | — |
| src/config.ts | manifestPollMs 解析（CLI+env，默认300s） | R1 |
| src/remote/github.ts | meta 边车（etag/validatedAt）读写；fetchManifest 落 meta；refreshManifestIfStale() 条件轮询；manifest_* 日志事件 | R1/R4 |
| src/search/index.ts | maybeRefreshManifest()：轮询+变更时重载清单重建索引 | R2 |
| src/tools/search-skills.ts / plan-workflow.ts | 检索前 await maybeRefreshManifest() | R2/R3 |
| src/tools/read-skill.ts | not-found → 轮询复查一次 + 报错文案给 force_refresh 指引 | R5 |
| src/tools/diagnostics.ts | 增列清单校验状态与 poll 配置 | 可观测 |
| README.md / docs/CHANGELOG.md | 配置行、FAQ 重写、v1.4.1 条目 | — |
| test/test_freshness.mjs | 陈旧清单复现→自动恢复的端到端测试 | 验证 |
| package.json | 1.4.1 | — |

## 5. 验证标准

1. test_freshness.mjs：把本地清单替换为剔除 chubby 的旧版（mtime 设新，模拟 R1 场景），
   以 poll=1s 启动服务 → search「chubbyskills」应命中；活动日志应含 manifest_refresh；
   read_skill 直接调用（不经 search）也应自愈命中。测试后恢复现场。
2. test_protocol.mjs 全量回归通过。
3. 故障注入：直连不可达时 search 正常返回（静默降级），日志记 manifest_poll_failed。

## 6. 边界与风险

- 轮询只在检索时触发（惰性），空闲不产生流量；304 开销 ~数百字节。
- 竞态：多进程同时轮询无害（条件 GET 幂等，内容一致，末写者胜）。
- 回滚：全部增量改动，revert 即恢复 v1.4.0 行为。

# OpenAI MCP Extensions — Phase 1 (server-side)

> 分支：`feat/openai-mcp-extensions-phase1`
> 上游规范：https://github.com/openai/mcp-extensions (spec §Structured Settings, §Composer At-Mentions)
> SDK：[`@openai/mcp-extensions`](https://www.npmjs.com/package/@openai/mcp-extensions) `^0.1.0`

## 升级内容

本项目按 openai/mcp-extensions 规范新增了 **4 个工具 + 1 类资源 + 1 个能力声明**，全部通过 MCP 标准扩展机制（`_meta` / `capabilities.extensions` / `capabilities.experimental`）实现：

| 新增 | 名称 | 作用 |
|---|---|---|
| 工具 | `settings.read` | 返回设置 schema、当前值与布局（`SettingsReadResult`，带 outputSchema） |
| 工具 | `settings.update` | 接收 `{set: {...}}` 增量更新，校验、持久化并返回全部生效值 |
| 工具 | `refresh_skills_list` | 设置面板中的按钮型 tool action：立即刷新远端 manifest |
| 工具 | `search_mentions` | composer @提及搜索（`_meta["openai/extensions"]["mentions/search"]`，`visibility: ["app"]`） |
| 资源 | `skill://{name}` | 模板资源；`resources/read` 返回该技能的 SKILL.md（首读即物化到本地缓存） |
| 能力 | `openai/settings` | initialize 结果中同时声明于 `extensions` 与（旧协议回退）`experimental` |

### 可配置项（settings.read 暴露）

| 字段 | 类型 | 默认 | 对应 Config |
|---|---|---|---|
| `cn_mirror` | boolean | false | `useCnMirror` |
| `download_concurrency` | integer 1–64 | 16 | `downloadConcurrency` |
| `download_timeout_seconds` | integer 5–300 | 30 | `downloadTimeout` |
| `manifest_ttl_hours` | integer 0–168 | 24 | `manifestTTL`（0=永不自动刷新） |
| `manifest_poll_seconds` | integer 0–3600 | 300 | `manifestPollMs`（0=禁用轮询） |

所有配置项在 `Config` 对象上是**调用时读取**的，因此 `settings.update` 热生效、无需重启。持久化位置：`~/.codex-skills-mcp/settings.json`（原子写入；刻意不放技能库目录，与活动日志同策略）。启动时 `applyPersistedSettingsAtStartup` 在 remote init / manifest 拉取**之前**覆盖 CLI 默认值，重启后仍生效。

## 兼容性设计（与未升级共存）

- 非扩展宿主（DSH / Claude Desktop / Cursor / 任何标准 MCP client）会忽略未知 `_meta` 与 capability 字段；8 个核心工具行为不变。已由 `test/test_protocol.mjs`、`test_mcp_smoke.mjs`、`test/test_freshness.mjs` 回归验证。
- `search_mentions` 按 spec 要求 `visibility: ["app"]` —— 对模型隐藏，仅供宿主提及选择器调用。Codex CLI 实测确认：该工具从模型可见列表中消失，属**规范预期行为**（见下）。
- zod 由 ^3.25 升至 `4.4.3`（与 openai SDK 精确同版本，单一实例）。项目自身的 zod 用法仅 `z.string/number/boolean + optional/default/describe`，v4 全兼容。

## 实测记录（2026-10-01）

| 测试 | 结果 |
|---|---|
| `test_openai_extensions.mjs`（隔离 HOME） | 28 项全过：capability 双命名空间、4 工具注册、_meta 正确、read/update/持久化/越界拒绝、mentions 搜索、skill:// 读取、未知技能报错、刷新动作 |
| `test/test_protocol.mjs` | 24/24（含新增扩展断言） |
| `test_mcp_smoke.mjs` | 全过（8 核心工具零回归） |
| `test/test_freshness.mjs` | 6/6 |
| Codex CLI 0.147 E2E（`codex mcp add codex-skills-dev`） | `settings.read` 经真实 OpenAI 客户端调通；`search_mentions` 因 app-visibility 被正确隐藏 |

## 后续（Phase 2 候选，未实施）

- **MCP App 前端**（侧边栏技能库浏览器 / 线程面板 / 文件处理器）：需按 [ext-apps](https://github.com/modelcontextprotocol/ext-apps) 协议新建 UI 工程并走 ChatGPT 插件分发，是独立立项量级。
- **官方 `io.modelcontextprotocol/skills` 扩展**（`skills/list` + `skills/get` + manifest 摘要）：本次新增的 `skill://` 资源模板已是其 groundwork。
- OpenAI form elicitation（增强表单/缩略图选择）。

# ChatGPT 原生插件升级实施手册

> 从 v1.5.0-beta.1（MCP 服务器）升级到 ChatGPT 原生插件（MCP App + 侧边栏入口）
> 状态：待批准 · 日期 2026-10-06 · 基线 main@7ff4b1f（tag v1.5.0-beta.1，已上 npm beta）

---

## 一、研究资料库（全部一手材料与关键结论）

### 1.1 官方文档

| 材料 | 地址 | 关键结论 |
|---|---|---|
| MCP Extensions 规范 | github.com/openai/mcp-extensions `docs/spec.md` | 13 项扩展全定义：侧边栏入口靠工具 `_meta["openai/ui"].entrypoints` 声明；入口打开即调该工具，App 用首次结果渲染首帧；设置面板走 `openai/settings` 能力；@提及走 `mentions/search` |
| 插件打包（核心） | developers.openai.com/plugins/build/plugins（"Package your plugin"） | ① portable 格式：根 `plugin.json`(agent-plugins.org schema) + `mcp.json`(server 带 `type`)；`.codex-plugin/`+`.mcp.json` 仅兼容回退 ② 桌面 App 只读 `~/.agents/plugins/marketplace.json`（个人）或 `$REPO/.agents/plugins/`（仓库）③ 安装=重启 App→插件目录 UI 安装→落 `~/.codex/plugins/cache/<市场>/<插件>/local` ④ 插件级 MCP 启用层 `[plugins."名@市场".mcp_servers.<server>]` ⑤ ChatGPT 侧 app 型 MCP 走注册制（`.app.json` ↔ `plugin_asdk_app_*` ID），本地 stdio/http 属本地客户端能力 ⑥ 改动后须"更新插件目录内容+重启 App" |
| 插件创建向导 | learn.chatgpt.com/docs/build-plugins | 无代码流程，开发者参考意义有限，但确认 @ 选择器的用户入口 |
| TS SDK 使用 | mcp-extensions `typescript/README.md` | server 侧 `OpenAIExtensions` 门面；App 侧 `App` 类/`createAppTransport`；官方 styles.css 与主题变量 |

### 1.2 官方示例拆解（Bits & Bolts，CAD 零件库插件）

**打包层**（`scripts/build.mjs` + `build-app.mjs`）：

```
可安装插件目录（完全自包含，免装依赖）:
├── .codex-plugin/plugin.json   ← 清单（name/version/skills/mcpServers/interface）
├── .mcp.json                   ← { mcpServers: { x: { command:"node", args:["./dist/server.js"] } } }
├── dist/server.js              ← esbuild bundle 单文件
├── dist/app.html               ← Vite lib/IIFE 单文件，内联进 HTML 模板 <!-- APP_SCRIPT --> 锚点
├── skills/ · assets/ · README  ← 技能与图标
```

**server 接线层**（`src/server/register.ts`）——我们 Stage 1 的直接参照：

```ts
const UI = "ui://bits-and-bolts/app-v14";
const ui = (entrypoints) => ({ ui: { resourceUri: UI }, "openai/ui": { entrypoints } });
// 入口工具（返回 structuredContent 作 App 首帧）
server.registerTool("cad.library", { _meta: ui([{type:"global"}]), ... }, async () => view({...}));
server.registerTool("cad.tray",    { _meta: ui([{type:"thread"}]), ... }, async () => view({...}));
// App HTML 作为资源由 server 服务（registerAppResource, mimeType text/html;profile=mcp-app）
```

**前端层**（`src/app/index.html` + `controller.ts`）——MVP 无需 React：

- 主题跟随 = **宿主 CSS 变量 + 回退值**：`background: var(--color-background-primary, Canvas)`
- 通信 = `createAppTransport()`（`@openai/mcp-extensions/app/transport`），裸 `transport.request("resources/read", …)` / `notify`
- 纯 DOM 操作渲染，无框架依赖

**开发流程**（`scripts/dev.mjs`）：仅热重建（500ms 轮询 src/ 重跑 build），安装流程同上文档。

### 1.3 本机实证

- codex-app-tools 插件的 MCP 显式启用先例：app-server 启动参数带 `plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true`
- ChatGPT 桌面（26.924.x）与 codex 共用 `~/.codex/config.toml`，`app-server` 为其后端
- 我们 server 原生支持 `--http --port`（Streamable HTTP），portable `mcp.json` 的 `streamable-http` 类型可直接对接

### 1.4 上一版失败复盘（四根因，均有文档对应）

| # | 现象 | 根因 |
|---|---|---|
| 1 | 插件列表可见但侧边栏无图标 | 插件 MCP 从未被拉起（当日活动日志为空）→ 缺插件级启用层（§1.1-④） |
| 2 | MCP 未拉起 | 用了 CLI 安装流程而非"桌面 App 读个人市场 + UI 安装"（§1.1-②③） |
| 3 | 清单过时 | `.codex-plugin`+`.mcp.json` 兼容层当主力用，未用 portable 格式（§1.1-①） |
| 4 | 越界 | 未经批准给插件加了路由 skills（用户已明确撤销）——本手册范围红线由此立 |

---

## 二、机制解析（先学懂，再动手）

### 2.1 一个插件从文件到侧边栏的完整链路

```
~/.agents/plugins/marketplace.json        个人市场目录（桌面 App 启动时读取）
  └─ plugins[].source.path ──────────────→ 插件目录（portable 格式）
        plugin.json  → 身份 + extensions.com.openai（interface/图标/apps）
        mcp.json     → MCP server 声明（type: streamable-http | stdio 兼容）
重启 ChatGPT ──→ 插件目录 UI 出现该市场 ──→ 用户点安装
  ──→ 拷贝至 ~/.codex/plugins/cache/<市场>/<插件>/local
  ──→ 按 mcp.json 连接 server（必要时加插件级启用配置）
  ──→ server 的 tools/list 带 _meta["openai/ui"].entrypoints
  ──→ 宿主渲染侧边栏图标
点击图标 ──→ 调入口工具 ──→ structuredContent 首帧 + 读 ui:// 资源（app.html）
  ──→ iframe 加载 app.html ──→ App 经 transport 握手(ui/initialize) ──→ 交互
```

### 2.2 三个易错点（对应四根因）

1. **"安装了"≠"启用了 MCP"**：UI 安装后若 MCP 未连，需在 `~/.codex/config.toml` 补两层（以市场名 `codex-skills-local` 为例）：
   ```toml
   [plugins."codex-skills@codex-skills-local"]
   enabled = true
   [plugins."codex-skills@codex-skills-local".mcp_servers.codex-skills]
   enabled = true
   ```
2. **改动必须走"更新 + 重启"**：本地插件的宿主加载的是 cache 拷贝，改源码后要重装/刷新并重启 App
3. **App 入口靠 server 声明**：图标是否出现取决于 server 的 `tools/list` 元数据，与 plugin.json 无直接关系

---

## 三、架构与范围红线

### 3.1 增量设计（基线零改动承诺）

```
main (v1.5.0-beta.1, 不动)
└── feat/plugin-app 分支（全部改动集）
    ├── src/openai/app.ts        新增：ui:// 资源 + skills.library/tray 入口工具
    │                            （独立模块；index.ts 仅 +3 行挂载；可整体摘除）
    ├── assets/app.html          新增：占位前端 → Stage2 换 Vite 产物
    ├── app-src/                 Stage2 新增：前端源码（Vite 工程）
    ├── plugin/                  新增：portable 插件
    │   ├── plugin.json          根清单（无 skills/ 字段！）
    │   ├── mcp.json             streamable-http → http://127.0.0.1:3456/mcp
    │   └── assets/icon.svg      20×20 currentColor 单色
    └── scripts/                 辅助：市场组装/部署脚本
```

**红线（用户裁定）**：插件不携带任何 skills；12 个既有工具、@ 链路、管家、缓存机制零变更；不发 npm 新版本（另议）。

### 3.2 MCP 绑定形态：streamable-http localhost

理由：portable 格式一等公民；我们 server 原生支持 `--http`；免去 stdio 兼容层的不确定性。代价：需本机常驻 HTTP 实例（Stage 0 手动 `npm start -- --http --port 3456`，Stage 2 前可选 launchd 常驻）。

---

## 四、分阶段实施手册

> 每阶段独立验收；验收不过 → 弃改动回 main（回滚流程见 §五）。每阶段通过打 tag `plugin-stage-N`。

### Stage 0 — 插件管道打通（半天）

**目标**：官方路径装上插件，MCP 真正被拉起（上次未达成的里程碑）。

**步骤**：
1. 建分支 `feat/plugin-app`（自 main）
2. 写 `plugin/plugin.json`（portable + extensions.com.openai.interface，无 skills）、`plugin/mcp.json`（streamable-http）、图标
3. 写 `scripts/deploy-plugin.mjs`：拷贝 plugin/ → `~/.codex/plugins/codex-skills/`，并生成/合并 `~/.agents/plugins/marketplace.json`（name: `codex-skills-local`）
4. 启动常驻 server：`node dist/index.js --http --port 3456`（先手动，日志可查）
5. ⌘Q 重启 ChatGPT → 插件目录应出现 "Codex Skills Local" 市场 → **UI 安装** codex-skills
6. 若插件详情无 MCP 连接 → 补 §2.2-1 的两层启用配置 → 再重启
7. 开对话验证

**验收（三条硬证据）**：
- [ ] `~/.codex/plugins/cache/codex-skills-local/codex-skills/local/` 存在（UI 安装成功）
- [ ] 活动日志当日出现 `server_start`（HTTP 模式）——**MCP 被拉起的铁证**
- [ ] 对话中模型可调 `search_skills`（或插件详情显示 MCP 已连接、12 工具）

**回滚**：UI 卸载插件；删 `~/.agents/plugins/marketplace.json`；`git checkout main`。

### Stage 1 — 侧边栏入口渲染（半天，依赖 Stage 0）

**目标**：侧边栏出现"技能库"图标，点击渲染占位页。

**步骤**：
1. 从上一版（b9b7c90 已验证的实现）移植 `src/openai/app.ts`（review：纯新增、独立模块、app.html 缺失时自禁用）与 `assets/app.html` 占位
2. `index.ts` 挂载（+3 行）；`package.json` build 追加 copy app.html → dist/
3. 重建 dist；重跑 `deploy-plugin.mjs`（更新插件目录内容）+ **重启 App**（§2.2-2）
4. 验收 `tools/list` 为 14（12+skills.library+skills.tray）

**验收**：
- [ ] 左侧边栏出现技能库图标
- [ ] 点击全屏打开占位卡片页（"骨架已就位"文案）
- [ ] 全量回归：protocol（12→14 断言更新）、extensions、revalidation 三套全绿

**已知风险**：宿主或要求 App 完成握手才显示入口 → 占位页不会握手；若图标仍不出现，判定为此风险，直接进 Stage 2 用真前端验证（决策记录在案）。

**回滚**：同 Stage 0 + revert app.ts 挂载。

### Stage 2 — 真前端（2-3 天）

**目标**：侧边栏内可用的技能库浏览器 MVP。

**技术选型**（依据 §1.2 前端层拆解）：**Vanilla TS + createAppTransport + 宿主 CSS 变量**，不用 React（官方 controller.ts 同款轻量路线）；Vite lib/IIFE 单文件构建内联 HTML。

**功能范围**：
- 分类树（list_categories）→ 技能卡片列表（名称/描述/cached 徽标）→ 详情页（SKILL.md 预览，resources/read skill://）
- 顶部搜索框（callServerTool: search_skills）
- "加入对话"按钮（update-model-context 或复制 @ 提示）

**步骤**：
1. `app-src/` Vite 工程（index.html 模板带 `<!-- APP_SCRIPT -->` 锚点 + CSS 变量主题；controller.ts）
2. `scripts/build-app.mjs`（照抄官方：vite lib IIFE → 内联模板 → dist/app.html）
3. 构建 → deploy → 重启 → 侧边栏全流程手测
4. 断网/超时降级路径（transport 失败显示重试按钮）

**验收**：侧边栏内完成"浏览分类 → 搜索'视频' → 打开 KrillinAI 详情"全流程，全程不离开 ChatGPT。

### Stage 3 — 设置面板验证 + 发布决策（半天）

- [ ] 插件详情页渲染 settings.read 的 5 项原生控件（openai/settings 的最终兑现）
- [ ] 发布方案呈报（npm beta.2 + 市场源切换 npm/git；公共目录提交），**用户决策后另立计划执行**

---

## 五、版本管理与回溯纪律

1. main 恒为 beta 基线，工作只在 `feat/plugin-app`；每 Stage 通过即 tag `plugin-stage-N`（可逐级回溯）
2. 任一 Stage 失败：`git checkout main && git branch -D feat/plugin-app` + 物理清理（删个人市场文件、UI 卸载、清 cache 目录）——流程已在 10-06 回滚实操验证
3. `v1.5.0-beta.1` 为永久回滚锚点；`git checkout v1.5.0-beta.1 && npm run build` 即还原
4. 本手册随实施更新：每 Stage 完成后追加"实测记录"小节（现象/证据/偏差），保持文档与事实同步，作为可学习资产

## 六、风险清单

| 风险 | 概率 | 预案 |
|---|---|---|
| UI 安装后 MCP 不连 | 中 | §2.2-1 两层启用配置；再不行改试 stdio 兼容层（.mcp.json）对照排除 |
| 宿主要求 App 握手才显示入口 | 中 | 提前进入 Stage 2 真前端（其本身完成握手） |
| localhost HTTP 会被 App 沙箱拦截 | 低 | 官方 plugin-creator 本地测试同样用 URL 连接，预期可行；不行则 stdio 兼容层兜底 |
| App 版本差异（26.924 vs DevDay 特性） | 低 | Bits & Bolts Remote 插件目录装一个做对照实验 |

## 七、附录：关键文件模板

**plugin/plugin.json**（portable，无 skills）：
```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "codex-skills",
  "version": "0.1.0",
  "description": "Browse, search, and load 199+ on-demand expert skills.",
  "extensions": {
    "com.openai": {
      "interface": {
        "displayName": "Codex Skills 技能库",
        "shortDescription": "199+ 按需专家技能库",
        "developerName": "Zhan-ZhangZ",
        "category": "Productivity",
        "capabilities": ["Interactive", "Read"],
        "composerIcon": "./assets/icon.svg",
        "logo": "./assets/icon.svg"
      }
    }
  }
}
```

**plugin/mcp.json**（streamable-http）：
```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "codex-skills": { "type": "streamable-http", "url": "http://127.0.0.1:3456/mcp" }
  }
}
```

**~/.agents/plugins/marketplace.json**（个人市场，脚本生成）：
```json
{
  "name": "codex-skills-local",
  "interface": { "displayName": "Codex Skills Local" },
  "plugins": [{
    "name": "codex-skills",
    "source": { "source": "local", "path": "./.codex/plugins/codex-skills" },
    "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
    "category": "Productivity"
  }]
}
```

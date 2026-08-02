# codex-skills-mcp

> 🧠 Codex-Skills 技能库的 MCP (Model Context Protocol) Server — 让任意 AI 编程工具都能检索、阅读和使用 180+ 专业技能。

## 这是什么

一个独立的 MCP Server，为 [codex-skills](https://github.com/Zhan-ZhangZ/codex-skills) 技能库提供标准化的 AI 工具接入协议。

| 特性 | 说明 |
|------|------|
| **6 个 MCP Tools** | search_skills, read_skill, load_skill_file, list_skill_files, list_categories, plan_workflow |
| **三层渐进加载** | 检索(~500 tokens) → 阅读(~5K tokens) → 深入(按需) |
| **中文搜索优化** | CJK bigram 分词 + Leading Words 权重 |
| **零外部 AI 依赖** | 纯关键词搜索，不需要 embedding 模型 |
| **双传输模式** | stdio（本地）+ HTTP（远程，适配 ChatGPT 桌面端） |

## 快速开始

### 1. 远程模式（默认，零配置，推荐）

直接通过 npx 运行即可，无需安装、无需手动指定技能库路径：

```bash
npx -y codex-skills-mcp@latest
```

默认以远程模式启动：自动从 GitHub 拉取技能库清单（180+ 技能），技能文件按需下载，并内置「GitHub 直连 → jsDelivr → gh-proxy.com → ghfast.top」网络加速回退链，国内网络无需额外配置。技能内容缓存在当前目录的 `.codex-skills-cache/`，二次启动秒级加载，远端文件有更新时自动增量同步。

如需指定技能库来源，支持 `--github-repo` / `--github-branch` / `--github-path` 参数。

### 2. 本地安装（可选）

本地模式适用于离线开发或使用本地技能库副本：

```bash
cd codex-skills-mcp
npm install
npm run build
```

### 3. 配置客户端

---

#### ⭐ Codex 桌面端 / Claude Desktop / Cursor（stdio，推荐）

这些客户端支持本地 stdio 模式，无需隧道工具。以 Codex 桌面端为例，编辑 `~/.codex/config.toml`：

```toml
[mcp_servers.codex-skills]
command = "npx"
args = ["-y", "codex-skills-mcp@latest"]
```

> 上方配置让客户端以远程模式自动拉取技能库（推荐）。若本地已有技能库副本，也可改用本地模式：
> ```toml
> [mcp_servers.codex-skills]
> command = "node"
> args = ["/path/to/codex-skills-mcp/dist/index.js", "--skills-dir", "/path/to/codex-skills"]
> ```

Claude Desktop、Cursor、Windsurf / VS Code + Copilot 等客户端的配置示例见下文各小节（同样支持上面的远程 npx 写法）。

#### 🌐 需要远程 HTTP 连接的客户端（如 ChatGPT 桌面端集成场景）

如果你的客户端需要以远程 HTTP 地址接入 MCP，则以 HTTP 模式启动服务，并通过 ngrok 等隧道工具暴露为公网地址。

**Step 1：启动 HTTP 模式**

```bash
node dist/index.js --skills-dir /path/to/codex-skills --http --port 3456
```

> 远程模式下也可以不带 `--skills-dir` 直接启动：`node dist/index.js --http --port 3456`（自动拉取远端技能库）。

启动后会看到：
```
[codex-skills-mcp] HTTP server running at http://localhost:3456/mcp
[codex-skills-mcp] Health check: http://localhost:3456/health
```

**Step 2：用 ngrok 暴露到公网**

```bash
ngrok http 3456
```

会得到一个公网地址，如 `https://xxxx-xxxx.ngrok-free.app`

**Step 3：在 ChatGPT 桌面端添加 MCP Server**

1. 打开 ChatGPT 桌面端 → **Settings** → **Advanced** 或 **Connectors**
2. 找到 **MCP Servers** / **Apps** 区域
3. 点击 **Add Server**
4. 填入 URL：`https://xxxx-xxxx.ngrok-free.app/mcp`
5. 保存，完成

> **💡 提示**：ngrok 免费版每次重启会更换地址。如果需要固定地址，可以使用 ngrok 付费版或其他隧道工具（如 Cloudflare Tunnel）。

**验证是否正常运行：**

```bash
# 健康检查
curl http://localhost:3456/health

# 预期输出
{"status":"ok","name":"codex-skills-mcp","version":"1.0.6","skills":181}
```

---

#### Claude Desktop

编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "codex-skills": {
      "command": "node",
      "args": [
        "/path/to/codex-skills-mcp/dist/index.js",
        "--skills-dir",
        "/path/to/codex-skills"
      ]
    }
  }
}
```

---

#### Cursor

编辑项目根目录 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "codex-skills": {
      "command": "node",
      "args": [
        "/path/to/codex-skills-mcp/dist/index.js",
        "--skills-dir",
        "/path/to/codex-skills"
      ]
    }
  }
}
```

---

#### Windsurf / VS Code + Copilot

在 MCP 配置中添加同样的 command + args（stdio 模式）。

---

#### 环境变量方式

也可以通过环境变量指定技能库路径：

```bash
export CODEX_SKILLS_DIR=/path/to/codex-skills
# stdio 模式
node /path/to/codex-skills-mcp/dist/index.js
# HTTP 模式
node /path/to/codex-skills-mcp/dist/index.js --http --port 3456
```

## 两种运行模式

| 模式 | 启动方式 | 适用客户端 |
|------|---------|-----------|
| **远程 stdio**（默认） | `npx -y codex-skills-mcp@latest` | Codex 桌面端, Claude Desktop, Cursor, Windsurf, VS Code |
| **本地 stdio** | `node dist/index.js --skills-dir ...` | 离线开发 / 使用本地技能库副本 |
| **HTTP** | `node dist/index.js [--skills-dir ...] --http --port 3456` | 需要远程 HTTP 连接的客户端（如 ChatGPT 桌面端集成场景） |

## MCP Tools

### 🔍 search_skills
搜索技能库。Agent 的主入口。

```
input:  { query: "前端性能优化", category?: "01_代码工程与架构", limit?: 8 }
output: 按相关度排序的技能列表
```

### 📖 read_skill
读取技能的完整指令（SKILL.md）+ 文件结构 + 环境依赖。

```
input:  { name: "MediaCrawler" }
output: { instructions, structure, dependencies }
```

### 📂 load_skill_file
按需读取技能内的任意文件。

```
input:  { skill_name: "KrillinAI", file_path: "README.md" }
output: { content, size_bytes }
```

### 🗂️ list_skill_files
浏览技能的文件树（不读内容）。

```
input:  { skill_name: "remotion-skills", path?: "src", max_depth?: 3 }
output: 目录树
```

### 📋 list_categories
列出所有技能分类和数量。

```
input:  {}
output: 14 个分类 + 各自的技能数量
```

### 🔗 plan_workflow
给定任务描述，推荐可组合使用的技能。

```
input:  { task_description: "把技术博客做成小红书图文" }
output: 推荐技能列表 + 分类分组
```

## 使用流程

```
用户: "帮我把这个视频翻译成中文字幕"

Agent → search_skills("视频字幕翻译")
     → 命中: KrillinAI, videocut-skills, VideoClaw

Agent → read_skill("KrillinAI")
     → 获取 SKILL.md 指令，了解怎么用

Agent → load_skill_file("KrillinAI", "README.md")
     → 获取详细配置参数

Agent → 按 SKILL.md 指令执行任务
```

## 技术栈

- TypeScript + ESM
- `@modelcontextprotocol/sdk` v1.12+
- `express` (仅 HTTP 模式)
- `zod` 运行时 schema 验证
- Node.js 18+

## License

MIT

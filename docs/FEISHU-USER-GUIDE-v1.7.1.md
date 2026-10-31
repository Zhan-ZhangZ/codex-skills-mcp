<title>Codex Skills 技能库小白使用指南（v1.7.1）</title>

# 从安装到使用：Codex Skills 新手教程

## 这是什么

Codex Skills 是一个“随用随取”的专家技能库。技能不会在启动时全部下载，只有搜索、选择或读取某个技能时，才按需下载并缓存到本机。

你可以把它理解成给 Codex 安装了一个可搜索的专业能力书架，适合：

- 代码开发、代码审查和项目排查
- 写作、研究、翻译和内容改写
- PPT、文档、表格和数据分析
- 视频转录、图片处理和工作流自动化

当前版本：**1.7.1**

## 本次版本更新

### 1. 插件市场安装不再依赖本机 Node/npx

通过 Codex 内建插件市场安装后，插件会使用 Codex 自带的 Node 运行时。用户不需要提前安装 Node.js、npm 或 npx。

### 2. 增加匿名使用次数统计

默认开启，目的是维护技能库，识别低频或需要优先更新的技能。

升级到带统计功能的版本后：

- 首次启动会立即补齐 `usage.json` 中现有的各技能累计次数。
- 补齐只执行一次，并通过独立批次和完成标记防止重复。
- 后续只上传每天新增的成功使用次数。
- 本地累计调用和“已使用技能”记录不会被关闭开关破坏。

### 3. 增加维护者统计面板

维护者可以查看：

- 累计成功调用次数
- 使用过的技能数量
- 每日调用情况
- 高频技能
- 全部技能明细，并按每页 25 条分页

面板地址：`https://gh.251716.xyz/usage/`

## 推荐安装：Codex 插件市场

这是当前推荐方式，不需要本机安装 Node.js。

1. 打开 Codex。
2. 进入 **自定义 → 插件**。
3. 点击右上角 **添加插件市场**。
4. 按下表填写。

| 字段 | 填写内容 |
|---|---|
| 来源 | `https://github.com/Zhan-ZhangZ/codex-skills-mcp.git` |
| Git 引用 | `main` |
| 稀疏路径 | 留空 |

如果界面强制要求填写稀疏路径，填写以下两行：

```text
.agents/plugins
plugin
```

添加完成后：

1. 在市场 `codex-skills-marketplace` 中找到 `Codex Skills`。
2. 点击安装并启用。
3. 新建对话，或完整重启 Codex。
4. 侧边栏出现“技能库”，说明安装成功。

> 插件市场安装模式不需要执行 `npx`。Node.js 22+ 只用于下方的 npm/标准 MCP 兼容方式。

## npm / 标准 MCP 安装

普通 Codex Desktop 用户优先使用插件市场。以下方式适用于需要用 npm 固定版本，或接入其他标准 MCP 客户端的场景。

准备条件：

- Node.js 22 或更高版本
- npm 和 npx 可用

检查环境：

```bash
node --version
npm --version
```

安装当前稳定版：

```bash
codex mcp add codex-skills -- npx -y codex-skills-mcp@latest
```

也可以使用 beta 标签。当前 `latest` 和 `beta` 均指向 `1.7.1`：

```bash
codex mcp add codex-skills -- npx -y codex-skills-mcp@beta
```

如果已经存在同名配置：

```bash
codex mcp remove codex-skills
codex mcp add codex-skills -- npx -y codex-skills-mcp@latest
```

验证：

```bash
codex mcp list
```

## 更新与卸载

### 插件市场

插件市场升级会读取仓库最新的 `main` 分支。当前市场版本为 `1.7.1`。

也可以使用命令更新：

```bash
codex plugin marketplace upgrade codex-skills-marketplace
codex plugin add codex-skills@codex-skills-marketplace
```

### npm

使用 `@latest` 或 `@beta` 时，重新执行添加命令即可获取对应标签的新版本。若仍显示旧版，先移除再添加并重启 Codex：

```bash
codex mcp remove codex-skills
codex mcp add codex-skills -- npx -y codex-skills-mcp@latest
```

### 卸载

npm 模式：

```bash
codex mcp remove codex-skills
```

插件市场模式请在 Codex 插件管理页停用或移除 `Codex Skills`。

## 第一次打开技能库

重启 Codex 后，可以从侧边栏打开“技能库”，也可以在输入框中输入 `@` 选择 Codex Skills。

首页主要显示：

- 当前可用技能数量
- 本机“常用技能”
- 全部领域和分类

搜索时可以直接描述任务，例如：

```text
帮我把这个视频转成文字
帮我做一份季度汇报 PPT
检查这个项目的部署风险
```

## 怎么把技能带进对话

1. 在技能详情页点击“带入当前对话”，或通过 `@` 选择技能。
2. 描述具体任务。
3. Codex 读取技能说明并执行。
4. 可以要求 Codex 说明使用了哪个技能、生成或修改了哪些文件。

## 不知道选哪个技能

搜索 `00_codex_skills` 或“大管家”，直接描述完整任务。大管家会拆解目标，再从技能库中选择合适的能力组合。

如果你已经知道技能名称，直接搜索该名称通常更快。

## 缓存机制

- 技能清单启动时刷新，之后默认每 5 分钟检查远端更新。
- 技能文件只在首次打开时下载，后续优先使用本地缓存。
- 详情页可以清除单个技能的缓存。
- 清除技能缓存不会删除累计使用次数。

## 使用统计与隐私

### 上传哪些数据

统计只上传：

- 公开技能名称
- 成功使用次数
- UTC 日期
- 插件版本
- 用于重试去重的随机批次 ID

### 不上传哪些数据

- 用户任务和提示词
- 搜索关键词
- 本地文件路径
- 技能正文或用户文件
- 精确调用时间
- 用户名、GitHub 凭据或安装 ID
- 客户端 IP、Cookie 或 Authorization

### 上传时间

- 升级后的首次启动：立即补齐当时的各技能累计次数。
- 日常统计：UTC 日期结束后上传，对应北京时间每天 08:00。
- 程序在线时，08:00 后最多 15 分钟内执行。
- 程序离线时，下次启动插件后立即补传。
- 未上传的本地每日增量最多保留 14 天。

### 如何关闭

进入 Codex 插件设置，关闭 **匿名使用统计**。

关闭后：

- 立即停止网络上传。
- 本地累计调用和已使用记录继续更新。
- 不会影响技能搜索、下载和使用。

## 常见问题

| 问题 | 解决方法 |
|---|---|
| 输入 `@` 看不到 Codex Skills | 确认插件已启用，完整重启 Codex，再新建对话。 |
| 侧边栏没有技能库 | 确认使用的是支持插件和 MCP Apps 的 Codex Desktop 最新版本。 |
| 搜索不到新技能 | 等待约 5 分钟自动同步，或在设置中刷新技能清单。 |
| 首次打开技能较慢 | 该技能正在下载完整依赖和文件，完成一次后会使用本地缓存。 |
| 技能内容没有更新 | 等待自动同步，或清除当前技能缓存后重新打开。 |
| 统计面板暂时没有数据 | 首次补齐在升级后执行；日常数据在 UTC 日结后的北京时间 08:00 上传。 |
| 托盘的累计调用与服务器不完全一致 | 托盘只统计当前技能清单内存在的技能；已下架技能的历史次数仍保存在本机 `usage.json` 和服务器历史数据中。 |
| npm 版是否有上报 | 有。npm `1.7.1`、beta 和插件市场版使用同一套统计代码。 |
| DOCX、XLSX、PPTX、PDF 不能直接渲染 | 点击“在 Codex 中打开”交给 Codex 或对应技能处理。 |

## 维护者部署摘要

服务器：`103.197.26.53`

统一入口：

```text
https://gh.251716.xyz
├── /usage/                             统计面板
├── /api/skill-usage/v1/batch            匿名批次上报
└── 其他 GET/HEAD 路径                   GitHub raw 加速
```

服务：

- 服务名：`codex-skills-telemetry.service`
- 监听：`127.0.0.1:18990`
- 数据库：`/var/lib/codex-skills-telemetry/usage.sqlite3`
- 面板：Nginx Basic Auth
- 上报接口：只允许 POST、请求体最大 256 KiB、按 IP 限流
- 数据库不开放公网端口

SQLite 表：

| 表 | 用途 |
|---|---|
| `skill_usage` | `day + skill + count` 的每日技能聚合次数 |
| `batches` | `batch_id + day + plugin_version + received_at`，用于幂等去重 |

服务器每日技能记录和批次 ID 保留 90 天，过期清理在写入时执行。

## 发布状态

- Git 主分支：`main`
- 插件版本：`1.7.1`
- npm `latest`：`1.7.1`
- npm `beta`：`1.7.1`
- GitHub marketplace：`codex-skills-marketplace`

## 补充技能建议

如果需要增加或补充技能，请将技能名称、功能描述和使用场景发送到：

`sidian1025@163.com`

## 最短使用流程

安装并启用 → 重启 Codex → 打开技能库或输入 `@` → 搜索或交给大管家 → 选择技能 → 直接描述任务。

<title>Codex Skills 技能库小白使用指南</title>

# 从安装到使用：Codex Skills 新手教程

## 这是什么

Codex Skills 是一个“随用随取”的技能库。你不需要提前下载全部技能，也不需要手动整理技能目录。

可以把它理解成给 Codex 安装了一个可搜索的专业能力书架，适合：

- 代码开发、代码审查和项目排查
- 写作、研究、翻译和内容改写
- PPT、文档、表格和数据分析
- 视频转录、图片处理和工作流自动化

需要某个能力时，搜索并选择对应技能，Codex 会按需下载和使用。

## 选择安装方式

下面提供三种方式，任选一种即可：

| 方式 | 适合谁 | 是否需要终端 |
|---|---|---|
| 插件市场点击安装 | 大多数普通用户 | 不需要 |
| Codex 指令安装 | 熟悉终端的用户 | 需要 |
| 呼叫 AI 自动安装 | 不想手动填写的用户 | 不需要自己操作终端 |

三种方式安装的是同一个插件，不需要重复安装。

## 方式一：插件市场安装

这是最适合普通用户的方式，不需要安装 Node.js、npm 或 npx。

### 第一步：打开插件页面

进入 Codex 的 **自定义 → 插件**，点击右上角 **添加**，选择 **添加插件市场**。

![图 1：进入插件页面，选择添加插件市场](@./docs/feishu-media/01-open-plugin-marketplace.png)

### 第二步：打开添加市场窗口

点击后会看到“添加插件市场”窗口。

![图 2：添加插件市场窗口](@./docs/feishu-media/02-open-marketplace-form.png)

### 第三步：填写仓库信息

按照下表填写：

| 字段 | 填写内容 |
|---|---|
| 来源 | `https://github.com/Zhan-ZhangZ/codex-skills-mcp.git` |
| Git 引用 | `main` |
| 稀疏路径 | 留空 |

填写后的效果如下：

![图 3：填写 GitHub 仓库和 main 分支](@./docs/feishu-media/03-fill-marketplace.png)

如果界面强制要求填写稀疏路径，可以填写以下两行：

```text
.agents/plugins
plugin
```

填写完成后点击 **添加市场**。

### 第四步：安装插件

在市场 `codex-skills-marketplace` 中找到 **Codex Skills 技能库**，进入详情页后点击 **安装插件**。

![图 4：在插件详情页点击安装](@./docs/feishu-media/04-install-plugin.png)

### 第五步：确认安装并重启

安装完成后，`Codex Skills 技能库` 会出现在插件的“已安装”列表中。

![图 5：安装完成后可在插件列表和侧边栏看到技能库](@./docs/feishu-media/05-plugin-installed.png)

随后完整退出并重新打开 Codex。侧边栏出现“技能库”，就表示安装成功。

> 普通 Codex Desktop 用户不需要使用终端，也不需要安装 Node.js。

## 方式二：Codex 指令安装

适合熟悉终端或命令行的用户。需要本机已经安装 Codex CLI，但不需要额外安装 Node.js 来运行插件。

### 添加插件市场

```bash
codex plugin marketplace add \
  https://github.com/Zhan-ZhangZ/codex-skills-mcp.git \
  --ref main
```

如果网络环境只允许稀疏拉取，可以改成：

```bash
codex plugin marketplace add \
  https://github.com/Zhan-ZhangZ/codex-skills-mcp.git \
  --ref main \
  --sparse .agents/plugins \
  --sparse plugin
```

### 安装插件

```bash
codex plugin add codex-skills@codex-skills-marketplace
```

### 验证安装

```bash
codex plugin list
```

列表中应能看到：

```text
codex-skills@codex-skills-marketplace  installed, enabled
```

安装后完整重启 Codex，再新建对话。

### 已安装后如何更新

```bash
codex plugin marketplace upgrade codex-skills-marketplace
codex plugin add codex-skills@codex-skills-marketplace
```

如果提示市场已经存在，不需要重复执行 `marketplace add`，直接执行上面的升级命令。

## 方式三：呼叫 AI 自动安装

如果不想自己找按钮或输入命令，可以把下面整段提示词复制到 Codex 的新对话中：

```text
请帮我安装 Codex Skills 技能库插件。

要求：
1. 添加 GitHub 插件市场：
   https://github.com/Zhan-ZhangZ/codex-skills-mcp.git
2. 使用 main 分支，不设置稀疏路径。
3. 从 codex-skills-marketplace 安装并启用 codex-skills 插件。
4. 完成后执行 codex plugin list，确认插件已安装并启用。
5. 如果市场已经存在，请更新现有市场，不要创建重复市场。
6. 不要修改我的其他插件、MCP 配置和账号凭据。
7. 最后告诉我是否需要重启 Codex，以及如何打开技能库。
```

AI 开始执行后：

1. 如果出现终端命令授权，请确认命令与本页给出的安装命令一致后再允许。
2. 安装结束时，要求 AI 展示 `codex plugin list` 的结果。
3. 完整重启 Codex。
4. 新开对话，检查侧边栏是否有“技能库”。

AI 安装和手动点击安装使用的是同一个插件市场，成功后不需要再执行其他安装方式。

## 第一次打开

重启 Codex 后，可以从侧边栏打开“技能库”，也可以在输入框中输入 `@` 选择 Codex Skills。

首页主要显示：

- 当前可用技能数量
- 本机常用技能
- 全部领域和分类

![图 6：技能库首页。顶部可以搜索任务，中间显示技能数、累计调用和使用情况，下面按真实使用频率列出常用技能](@./docs/feishu-media/06-skill-library-home.jpg)

第一次进入首页时，可以按这个顺序操作：

1. 最上方搜索框：输入你要完成的任务。
2. 页面中部：查看当前技能数、累计调用和已使用技能数。
3. “常用技能”：查看你使用最多的技能，以及每个技能的调用次数。
4. 点击任意技能卡片：进入使用说明和文件详情。

第一次打开某个技能时可能需要下载文件，等待进度完成即可。

## 搜索技能

在顶部搜索框直接描述你要完成的任务，例如：

```text
帮我把这个视频转成文字
帮我做一份季度汇报 PPT
检查这个项目的部署风险
```

点击搜索结果即可查看技能说明。

技能详情页主要包含：

- **使用说明**：这个技能具体怎么完成任务
- **文件**：README、脚本、模板和参考资料
- **子技能**：大型技能包中的细分能力

## 把技能带进对话

1. 在详情页点击 **带入当前对话**，或通过 `@` 选择技能。
2. 直接描述你的具体任务。
3. Codex 会读取技能说明并开始执行。
4. 可以要求 Codex 说明使用了哪个技能、生成或修改了哪些文件。

## 不知道选哪个技能

搜索 `00_codex_skills` 或“大管家”，然后直接描述完整任务。

例如：

```text
下载这个视频、整理文字稿，再改写成自然一点的版本
```

大管家会先拆解目标，再从技能库中选择合适的能力组合。

如果你已经知道技能名称，直接搜索名称通常更快。

## 文件和图片怎么查看

- 文本、Markdown、JSON 和代码文件可以直接查看。
- PNG、JPEG、GIF、WebP 图片可以直接预览。
- DOCX、XLSX、PPTX、PDF 等文件可以交给 Codex 或对应技能打开。
- 无法直接打开时，可以复制完整文件路径。

![图 7：技能详情的“文件”页。可以查看技能文件、在 Codex 中打开 Office 文件、复制完整路径，也可以清除当前技能缓存](@./docs/feishu-media/07-office-file-handoff.jpg)

查看技能文件时：

1. 进入技能详情，点击 **文件**。
2. 在文件列表中打开 `SKILL.md`、`README.md`、脚本或参考资料。
3. DOCX、XLSX、PPTX、PDF 等文件点击 **在 Codex 中打开**。
4. 文件无法打开时，点击 **复制完整路径**，再交给 Codex 处理。
5. 文件较多时，可以使用文件搜索框按文件名或路径查找。

确认技能内容和文件都正常后，点击右上角 **带入当前对话**，再描述具体任务。

## 缓存是什么

第一次使用某个技能时，文件会下载到本地缓存，之后再打开会更快。

一般不需要手动管理。如果某个技能内容异常，可以在详情页清除这个技能的缓存。

清除缓存只会重新下载当前技能，不会删除累计使用记录。

## 使用统计与隐私

匿名使用统计默认开启，用于判断哪些技能使用较少，帮助维护和更新技能库。

仅统计：

- 技能名称
- 成功使用次数
- 统计日期

不会上传：

- 你的任务或提示词
- 搜索关键词
- 本地文件和工作路径
- 技能正文或用户文件
- 用户名、凭据或设备安装标识

如果不想上传，可以在插件设置中关闭 **匿名使用统计**。

关闭后只会停止上传，本机已有的累计调用和已使用记录仍然保留。

## 常见问题

| 问题 | 解决方法 |
|---|---|
| 输入 `@` 看不到 Codex Skills | 确认插件已安装并启用，完整重启 Codex，再新建对话。 |
| 侧边栏没有技能库 | 确认使用的是最新版 Codex Desktop，并完整退出后重新打开。 |
| 搜索不到新技能 | 等待几分钟自动同步，或在插件设置中刷新技能清单。 |
| 第一次打开技能较慢 | 首次使用需要下载文件，完成一次后会使用本地缓存。 |
| 技能内容没有更新 | 等待自动同步，或清除当前技能缓存后重新打开。 |
| DOCX、XLSX、PPTX、PDF 不能直接显示 | 这是正常设计，请交给 Codex 或对应技能处理。 |
| 不知道选哪个技能 | 搜索“大管家”或 `00_codex_skills`，直接描述完整任务。 |

## 更新或卸载

### 更新

在 Codex 插件管理中重新检查市场更新并重启 Codex。

### 卸载

在 Codex 插件管理中停用或移除 `Codex Skills`，然后完整重启 Codex。

## 补充技能建议

如果没有找到需要的技能，可以把技能名称、功能描述和使用场景发送到：

`sidian1025@163.com`

## 最短使用流程

安装并启用 → 重启 Codex → 打开技能库或输入 `@` → 搜索或交给大管家 → 选择技能 → 直接描述任务。

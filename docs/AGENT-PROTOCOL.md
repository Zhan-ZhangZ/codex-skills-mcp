# Agent 标准工作流合约（Agent Protocol）

> 本文件是 codex-skills-mcp 面向所有 Agent 客户端的行为合约。
> 同一套措辞通过 MCP server instructions、tool descriptions、tool result 尾部三处持续强化（见 src/lib/protocol.ts）。

## 核心理念

技能库按需取用：**无需预装全部技能**。每次 `read_skill` 都会把选中技能的**完整目录**（SKILL.md、脚本、配置、参考文件）下载并缓存到本地（默认 `~/.codex-skills-cache`，已缓存则秒回）。日常使用会逐步把常用技能沉淀为本地缓存 —— 已缓存技能优先使用。

## The 5-Step Protocol（必须按序执行）

1. **DISCOVER（检索）** — 用 `plan_workflow(task_description)` 获取组合建议，和/或 `search_skills(query)` 精确检索。结果中的 `[cached]` 徽标表示该技能已在本地缓存；**分数相近时优先选已缓存技能**。
2. **SELECT（选型）** — 选出**覆盖任务的最小技能组合**（可多个），明确各自分工与顺序。
3. **MATERIALIZE（物化，必做）** — 对**每一个**选定技能调用 `read_skill(name)`。该调用会把完整技能目录下载到本地磁盘，并返回 SKILL.md 指令、文件结构、依赖与 **local_path（本地执行入口）**。**任务开始前必须完成本步，一个都不能少。**
4. **EXECUTE（严格执行）** — **逐字遵循**已加载的 SKILL.md 指令执行任务；脚本从 **local_path** 直接运行（如需环境先执行其 Setup 命令）；需要补充文件时用 `load_skill_file`。**禁止**对已加载的技能用通用知识自行替代实现。
5. **VERIFY & REPORT（验证汇报）** — 用 `skill_status(names)` 确认缓存完整（可选）；汇报实际使用了哪些技能、哪些是新缓存的。出错时用 `diagnostics` 定位。

## Forbidden anti-patterns（禁止的反模式）

- ❌ 读了 SKILL.md 之后凭记忆/通用知识"自由发挥"完成任务（最常见错误）；
- ❌ 只物化部分选定技能就开始执行；
- ❌ 不从 local_path 执行脚本，而是自己重写脚本逻辑；
- ❌ 把 read_skill 当成"查资料"，读完就丢。

## 一图流

```
user intent
  └─ plan_workflow / search_skills   ← DISCOVER（[cached] 优先）
       └─ 选出最小技能组合            ← SELECT
            └─ read_skill × N         ← MATERIALIZE（完整下载+缓存，返回 local_path）
                 └─ 按 SKILL.md 执行   ← EXECUTE（脚本从 local_path 运行）
                      └─ skill_status / 汇报 ← VERIFY & REPORT
```

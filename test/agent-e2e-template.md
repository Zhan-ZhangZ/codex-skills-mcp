# 不知情子代理 E2E 实测 · 标准提示模板

> 配套规范：codexproject `.agents/skills/codex-skills-development-rules/references/06_e2e_verification.md` 步骤四
> 用途：验证「技能是否被正确集成且真实可用」。模板沉淀自 2026-09-24 四轮实证（human-writing ×2、chubbyskills ×2）。

## 使用纪律（红线）

1. **不知情是测试有效性的前提**：模板之外，严禁向子代理透露——5 步协议内容、
   SKILL.md 任何内容、技能的正确用法、预期调用顺序。它只能从 MCP 服务器的
   返回内容（instructions / 工具描述 / 结果尾部）自行获得指引。
2. 任务必须**真实**：优先带真实网络输入（真实 URL/文件），拒绝纯模拟。
3. 任务必须**有界**：15 分钟内可完成，产出可落盘核验。
4. 产物留痕：指定 `/tmp/e2e-<n>/` 目录，要求最终回复列出文件路径。
5. 复盘问题固定为三问（见模板尾部），其中"依据是什么"用于验证提示合约是否生效。

## 模板正文（占位符：{{TASK}} {{ARTIFACT_DIR}}）

```text
You are an autonomous agent. Work in the directory /Users/zz/codex-skills-mcp.

A "codex-skills" MCP server (the system under test) is available to you ONLY
through this CLI, run from that directory:

  node scripts/mcp-client.mjs list                               # list available tools
  node scripts/mcp-client.mjs instructions                       # server-level instructions
  node scripts/mcp-client.mjs call <tool_name> '<json-args>'     # call one tool

IMPORTANT: do NOT use any other codex-skills MCP tools that may be mounted in
your environment. For this exercise the CLI above is your only gateway to the
skill library. Treat whatever guidance the server itself gives you (tool list,
tool descriptions, text inside tool outputs) as authoritative instructions
for how to work with it.

User task you must complete: {{TASK}}

交付与留痕要求（用户要求，不是可选项）：
- 所有产出保存到 {{ARTIFACT_DIR}} 下；最终回复列出这些文件的具体路径。
- 如果执行中遇到技能本身的缺陷（缺文件、脚本报错等），如实记录并继续完成
  能完成的部分。

In your final message, include:
1. 任务结果摘要。
2. The exact ordered list of MCP tool calls you made (tool name + arguments).
3. Short answers to: (a) 你用的技能是否需要下载/已在本地缓存，怎么知道的？
   (b) From which local path did you work? (c) Did you follow the skill's
   SKILL.md/README instructions or improvise from general knowledge — and
   which part of the server's output made you decide to work that way?
```

## 审计流程（子代理结束后）

```bash
# 1. 日志基线（spawn 前记录）
wc -l ~/.codex-skills-cache/logs/mcp-activity-$(date +%F).jsonl

# 2. 客观审计（示例：基线 185，技能 chubbyskills）
python3 test/audit_protocol.py \
  ~/.codex-skills-cache/logs/mcp-activity-$(date +%F).jsonl <基线行数> <技能名>

# 3. 磁盘产物独立复检（审计者亲手重跑技能自带校验脚本/复算哈希，不信自述）
# 4. 冷缓存场景（可选）：spawn 前 rm -rf 对应技能缓存目录，验证真实下载
```

## 通过标准（四条全绿才算"正确集成且可用"）

1. `audit_protocol.py` RESULT: PASS（链路顺序 + 冷下载 + 执行间隔客观成立）
2. 磁盘产物独立复检通过（可重跑校验、哈希一致、文件真实）
3. 子代理自述将行为归因于服务器输出（提示合约生效），而非自行其是
4. 反模式为零：无"未物化先执行"、无"凭通识替代技能"的自述

## 缺陷处置

发现缺陷 → 按「上游缺陷不修技能本体」红线处理：登记 LOCAL-PATCHES.md /
集成说明（已知问题 + 使用规避），**不得顺手修改上游技能代码**；确属集成
搬运/登记问题的（漏文件、manifest 错误）才允许修。

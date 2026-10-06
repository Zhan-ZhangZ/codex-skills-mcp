# App 前端功能与设计研究（Stage 2+ 演进指南）

> 依据：openai/mcp-extensions spec 全文、官方 styles.css（npm 包内 338 行全文）、Bits & Bolts controller.ts（1133 行）与 register.ts、ext-apps App 类 API
> 日期：2026-10-06 · 配套：docs/PLUGIN-APP-PLAN.md

## 一、对话交互能力全谱（官方定义 × 示例实证）

### 已在用
- `ui/update-model-context`（"加入对话"）——spec 支持升级：`_meta["openai/title"]` 命名附件、`openai/thumbnail` 缩略图、`annotations.audience:["assistant"]` 隐藏式背景上下文、`structuredContent` 机器可读部分

### 高价值未用（按价值排序）
| 能力 | 官方依据 | 我们的用法 |
|---|---|---|
| **`ui/message`**（预填/发送） | spec §ui/message：`target:"new"/"active"`、`send` 可 false（仅预填不发送） | 详情页两个按钮：「用此技能开新对话」（new+send）、「填入当前输入框」（active+send:false 预填 `@技能名`） |
| **App 内设置页** | B&B controller 的 settings 面板 + 我们已有的 settings.read/update 5 项 | App 头部 ⚙ 入口：原生表单改 TTL/并发/镜像，热生效——把 openai/settings 与 App UI 统一 |
| **`sampling/createMessage`** | App 类 API：不经过用户消息直接问模型 | 搜索框旁「AI 帮我选」：自然语言描述任务 → 模型返回 plan_workflow 结果 |
| **quickAction** | spec §Global Entrypoint：侧边栏图标可挂快捷按钮 | 「搜索技能」快捷动作直达搜索态 |
| **深链** | spec §Deep Links：`chatgpt://plugins/<id>/app/<tool>?path=/detail?skill=X` + hostContext `openai/deepLink` | 技能详情页「复制分享链接」；App 启动时读 deepLink 直达该技能 |
| **`ui/open-link`** | App API | 详情页打开技能的 GitHub 源码页 |
| **`ui/download-file`** | App API | 导出 SKILL.md / 整技能 zip |
| **Plugin onboarding** | plugin.json `extensions.com.openai.onboardingSkill`（B&B 有 skills/onboarding） | 首次安装引导：选常用分类 → 生成个性化首页（注意：涉及 skills 捆绑，需用户授权红线） |
| **提及选择器缩略图/预览** | spec §Composer mentions：item 可带 `_meta["openai/thumbnail"]` 与 `openai/preview`（resource_link 预览目标） | search_mentions 返回项加首字母头像缩略图；选中项悬停预览 SKILL.md |
| **表单卡片选择** | spec §OpenAI form elicitation：`x-openai-thumbnail` 选项卡 | 服务端：模型问"用哪个技能"时弹图标卡（依赖 elicitInput，服务端改造） |
| **尺寸自适应** | controller `setupSizeChangedNotifications`（ResizeObserver → `ui/notifications/size-changed`） | inline 形态下正确报高（待宿主支持面板后启用） |
| **资源订阅** | `resources/subscribe` | 下载完成时徽标实时变绿（当前需刷新） |

### B&B 实证细节（值得照抄）
- 主题三件套：`hostcontextchanged` → `document.documentElement.dataset.theme` + `colorScheme` + 字体注入 `--font-sans` + `--cursor-interaction`（default/pointer 用户偏好）
- 返回库页时清空 model-context（`update-model-context` content:[] + structuredContent:{page}）——上下文状态机思维
- 状态显示只信 hostContext 回读（"Effective attached state is displayed only from hostContext"），不本地假设

## 二、前端功能路线图（优先级）

**P0 打磨现有**（1 天）：官方 styles.css 接入（见 §三）、主题/字体/光标同步、技能 letter-avatar 图标、加载骨架屏、空态文案
**P1 对话交互**（1 天）：加入对话升级（title+structured）、ui/message 双按钮、导出 SKILL.md、quickAction
**P2 深度整合**（1-2 天）：App 内设置页、AI 帮我选（sampling）、深链分享
**P3 视宿主解锁**：inline 自适应、资源订阅、表单卡片、onboarding（需授权）

## 三、UI 美化：官方规范提炼 + 我们的定制

### 基座：直接采用官方 styles.css（框架无关，338 行）
接入方式（README 明示 iframe CSP 禁外链，须内联）：`build-app.mjs` 在打包时读取 `node_modules/@openai/mcp-extensions/styles.css` 并 `<style>` 内联进 index.html，与 App 脚本同法。

它提供的完整变量桥（全部回落宿主变量+双主题默认值）：
`--background/--foreground/--card/--primary/--secondary/--muted-foreground/--accent/--destructive/--border/--input/--ring/--radius`，附 `data-theme` 明暗切换与 `body > *` 字体恢复（防沙箱改字体）。

组件类即拿即用：`.card`（12px 内边距、radius×1.6、**corner-shape: superellipse**——ChatGPT 标志性圆角）、`.btn/.btn-primary/.btn-ghost`（28px 高、hover 6% 前景混合）、`.form-control/.form-select/.form-check`、`.text-muted/.text-small`、`svg.lucide`（16px、1.6 描边）。

### 我们的定制层（变量之上，只加不改）
1. **技能 letter-avatar**：data-URI SVG（圆角方块 + 首字母），底色由技能名 hash 出 15 档主题友好色相（oklch 环），明暗自适应——零图标资源、视觉记忆点
2. **cached 徽标语义化**：已缓存=绿色描边（#3d9a50 系）、按需下载=灰描边 + 下载 icon
3. **分类色带**：分类名左侧 3px 竖条（同 hash 色系），列表扫读性
4. **评分微可视化**：搜索结果卡底部 40px 宽的 2px 评分条（BM25 分归一化），一瞥知相关度
5. **骨架屏**：卡片位灰色脉冲块（官方 --muted 变量），替代"加载中…"文本
6. **图标体系**：内联 SVG 字符串常量（lucide 风格 16px/1.6），搜索/返回/下载/分享/设置 8-10 个，esbuild 零依赖打包

### 反面清单（避免"AI 味"UI）
不用阴影堆叠（宿主扁平边框风）、不用渐变、不用 emoji 当功能图标（仅徽标文案）、间距遵循 4 的倍数、正文 14px/--radius 12.5 不自创。

## 四、落地顺序建议
P0（美化基座）先行——styles.css 接入是纯替换、无功能风险、视觉提升最大；随后 P1 对话交互（用户感知最强）；P2 按需。每步独立发版可回溯。

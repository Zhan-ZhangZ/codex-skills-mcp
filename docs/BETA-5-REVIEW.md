# 1.5.0-beta.5 源仓库静态索引联动记录

日期：2026-10-16（Asia/Shanghai）

`codex-skills-mcp@1.5.0-beta.4` 已发布。beta.5 的目标不是改变 MCP 工具面，而是把 `/Users/zz/codexproject` 技能源仓库变成可验证、低 API 依赖的发布源。

## 源仓库事实

- 清单包含 291 个入口：1 个根路由 `00_codex_skills`，290 个可下载技能。
- 磁盘约 108,657 个文件、3.0GB；Git 跟踪的技能内容为 102,737 个文件、2,891,756,911 字节。
- 全部 290 个非根入口均有 `SKILL.md`。
- 现有元数据覆盖：114 个技能有 aliases，29 个有 tags。
- 根路由保持单文件读取，不生成也不下载全库 catalog。

## 源仓库改动

- 新增 `scripts/build_file_indexes.py`：
  - 从 Git staging/index 生成 catalog，不扫描运行缓存；
  - 每个文件记录相对路径、大小、Git blob SHA-1 与 Git mode；
  - catalog 以内容 SHA-256 命名，输出到 `codex-skills/.catalog/`；
  - manifest 每项新增 `file_index` 引用；
  - 写入顺序为先 catalog 后 manifest，避免发布出悬空引用；
  - 校验 manifest 基础字段、重复名、路径、`SKILL.md`、未登记技能目录和未暂存内容。
- 新增 GitHub Actions 门禁：`python3 scripts/build_file_indexes.py --check`。
- 生成 290 个不可变 catalog，总计约 14MB。旧 catalog 后续保留，保证已 fetched 的旧 manifest 仍可校验。
- `.gitignore` 放行生成器与 CI，忽略技能运行产生的 `.cache/`。

## MCP 改动

- `ManifestEntry` 支持并严格校验 `file_index`：
  - catalog 路径必须为 `.catalog/<sha256>.json`；
  - SHA-256、文件数和总字节数必须有效；
  - 根路由禁止携带文件索引。
- 远程物化优先解析 immutable catalog：
  - catalog 先查本地缓存，未命中再经下载节点获取；
  - 完整正文受超时保护；
  - 校验 SHA-256、版本、`skill_path`、文件结构、入口文件和 manifest 元数据；
  - 校验通过后原子写入本地 `.catalog/`。
- catalog 缺失、损坏或拉取失败时，自动回退现有 category tree / GitHub Tree API，兼容旧源和临时故障。
- 新增回归覆盖：
  - manifest `file_index` 边界；
  - 正常 catalog 下载且零 GitHub API 调用；
  - 完整缓存二次读取零网络请求；
  - 本地 catalog 损坏后按 SHA 修复；
  - catalog 解析失败时 GitHub API 兜底。

## 预期影响

冷下载从“GitHub API 获取文件树 + N 个文件获取”变成“一次 catalog 获取 + N 个文件获取”。这里是逻辑获取次数；每次获取的镜像竞速可能发出多个 HTTP 请求。正常 catalog 路径不依赖 GitHub API，旧清单、catalog 故障与历史 blob 恢复仍可能使用 API。文件内容按 blob SHA 校验。

## 交接基线验证

- `codexproject`: `python3 scripts/build_file_indexes.py --check` 通过；生成 290 catalogs / 102,737 files；全部 catalog SHA 与 manifest 元数据复核通过。
- `codex-skills-mcp`: `npm test` 68/68 通过。
- 待源仓库推送到 GitHub 后，需要用隔离缓存执行真实远端 `fetchManifest → ensureSkillFetched` 冒烟，再发布 MCP beta.5。

## 发布顺序

1. 提交并推送 `codexproject`，确认 GitHub Actions catalog 门禁通过。
2. 使用包含 catalog 消费代码的 beta.5 构建，执行 `node scripts/check-remote-catalog.mjs --skill human-writing --skill webapp-testing`，确认完整远端链路、零 API 兜底及热缓存零请求。beta.4 不支持本项验收。
3. 发布 `codex-skills-mcp@1.5.0-beta.5 --tag beta`。
4. 抽测一个多文件技能和大技能，确认冷下载、二次读取与 `skill_status` 完整性。

## 接手复审与修正

结论：保留源库生成不可变 catalog、MCP 按需消费的分工。原提交的基本路径正确，但仅原有 68 项回归不足以覆盖版本切换和故障恢复。此次独立复现并修正了以下问题。

| 问题 | 修正后的行为 |
| --- | --- |
| 新清单已变，旧缓存仍受 TTL 保护；TTL=0 时可永不更新 | 已验证 marker 绑定 catalog SHA-256；摘要变化立即重新验证，旧 marker 自动迁移；等待中的请求重新检查自己的版本 |
| 新清单遇到旧的未完成 marker，继续下载已经删除的旧文件 | 按新 catalog 重新列文件并暂存替换，不沿用旧文件列表 |
| 第一次下载失败后，等长旧文件在重试时被标记为完整 | 未完成 marker 恢复时流式校验现有文件 Git blob SHA，复用通过校验的文件并重下错误内容 |
| 最快镜像返回损坏 catalog，健康节点被提前取消 | 32 MiB 上限及 SHA-256 校验在每个节点胜出前完成；catalog 强制提供每文件 SHA 和 mode |
| 旧分类树兜底被盖上新 catalog 摘要 | 只有通过 catalog 校验才记录摘要；兜底缓存显示未验证版本，按摘要退避并重试，不冒充当前完整版本 |
| 旧 catalog 对应文件已被 main 改写或删除 | raw 节点失败后按 Git blob SHA 获取历史内容，再校验长度和 SHA；正常路径保持零 API |
| catalog 记录了可执行权限，落盘却丢失 | POSIX 保留 100755 执行位；只丢权限时本地修复，无需重下；符号链接仍按目标文本落盘 |
| 已知文件 SHA 的更新仍先串行等待直连 | catalog 文件更新直接参与经 SHA 校验的镜像竞速，避免额外直连等待窗口 |
| App 预览迟到覆盖加入对话的成功/失败 | 附件状态使用独立可访问区域，详情重试保留状态，离开详情后忽略迟到结果 |
| 工具在未完成物化时仍提示完整并立即执行 | `read_skill` / `skill_status` 区分缺文件和当前 catalog 尚未验证，仅完整缓存给出执行指引 |

源库增加 `scripts/validate_manifest.py` 与离线测试，检查 metadata、路径唯一性、catalog 摘要/结构、计数、权限及符号链接边界。全库仍为 291 条目、290 catalogs、102,737 文件；内容与生成 catalog 未改写。现有两处悬空链接（phoenix、mcp-toolbox）保留为可见警告，上游内容保持原样。

## 发布前联合实测

可复现命令：

```bash
npm run build
node scripts/check-remote-catalog.mjs --metadata-dir /Users/zz/codexproject/codex-skills --skill human-writing --skill webapp-testing
```

该模式仅从本地源库提供 manifest/catalog，技能文件来自真实远端；隔离临时缓存在结束时删除，不影响日常缓存。每个文件复核大小、Git blob SHA 和执行位。

| 技能 | 文件/字节 | 可执行文件 | 冷下载 | 热读 | 冷下载实际 HTTP 尝试 |
| --- | --- | --- | --- | --- | --- |
| human-writing | 13 / 100,786 | 1 | 1,592.17 ms | 0.59 ms | 65 |
| webapp-testing | 6 / 22,518 | 1 | 763.36 ms | 0.37 ms | 30 |

两项正常下载均零 GitHub API、热读零请求。计时为同机单次样本，catalog 元数据本地读取；不代表完整公网链路延迟，也不直接与 beta.4 网络样本比较。镜像竞速最多五路，HTTP 尝试数包含被取消的请求。后续大技能主要优化空间仍是按技能归档下载与减少竞速放大。

历史 blob 接口另经真实网络验证：匿名请求返回 403，使用现有 GitHub 凭据后返回 200，15,199 字节且 SHA 匹配。这说明历史回取仍受 API 可用性和限流约束；保留旧 catalog 本身不能保证所有旧版本永久可下载。

复审初期 npm registry 为 `latest=1.4.2`、`beta=1.5.0-beta.4`；源仓库远端 main 为 `2e5772a3c`。后续推送与完整远端验证记录见下文；真实 ChatGPT 宿主视觉验收仍待执行。

## 最终本地验收

- MCP：`npm test` 90/90；`npm run build:plugin` 与 `npm run check:package` 通过；npm 包及插件入口各完成 2/2 stdio 验收。
- 依赖：`npm audit --omit=dev` 返回 0 vulnerabilities。
- 源库：Python 生成器/校验器回归 23/23；`validate_manifest.py` 全库通过（两项既有悬空链接警告）；builder `--check` 的 `catalogs_changed=0`、`manifest_changed=false`。
- 两仓 `git diff --check` 通过。测试环境为 Node 26.4.0、macOS arm64；Node 22/24 的 GitHub Actions 结果仍须在推送后确认。
- CI 改为浅克隆当前版本，校验只依赖索引和 blob，不再为此下载完整历史。源侧与 MCP 同时拒绝保留 marker `.codex-skills.tree.json` 及其子路径。

下一阶段优先评估每技能归档分发，减少大技能 N 个文件请求及镜像竞速放大；在设计完成和实测前不承诺“所有技能 15 秒以内”。metadata 的 aliases/tags 补齐可作为单独的检索质量迭代。

## 完整远端联动验证

用户已授权推送两个仓库，并在远端 CI 与冒烟通过后发布到 npm beta。源仓库 main 已推送到 `bd2ad1b9128b2145499022af2a7b408cf889adcd`。

执行 `node scripts/check-remote-catalog.mjs --skill human-writing --skill webapp-testing`，模式为 `fully-remote`，没有本地元数据覆盖；得到 291 条目、290 个 indexed skills。

| 技能 | 文件/字节 | 含 catalog 的冷读取 | 热读 | HTTP 尝试数 |
| --- | --- | --- | --- | --- |
| human-writing | 13 / 100,786 | 1,753.82 ms | 1.02 ms | 70 |
| webapp-testing | 6 / 22,518 | 1,395.79 ms | 0.55 ms | 35 |

正常链路零 GitHub API、热读零请求；所有文件长度、Git blob SHA、catalog SHA-256、执行权限均通过校验。上述为单次网络样本；HTTP 计数包含镜像竞速及取消尝试。源仓库门禁：[Codex Skills catalog](https://github.com/Zhan-ZhangZ/codexprojec/actions/runs/38923297457)。

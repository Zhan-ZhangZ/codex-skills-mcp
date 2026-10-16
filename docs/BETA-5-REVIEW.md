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

冷下载从“2 次 GitHub API 获取文件树 + N 个文件请求”变成“最多 1 个 catalog 请求 + N 个文件请求”。对匿名 GitHub API 的依赖从每次技能物化降低到仅旧清单或 catalog 故障兜底。文件内容仍按 blob SHA 校验，镜像可以加速传输但不能污染内容。

## 验证

- `codexproject`: `python3 scripts/build_file_indexes.py --check` 通过；生成 290 catalogs / 102,737 files；全部 catalog SHA 与 manifest 元数据复核通过。
- `codex-skills-mcp`: `npm test` 68/68 通过。
- 待源仓库推送到 GitHub 后，需要用隔离缓存执行真实远端 `fetchManifest → ensureSkillFetched` 冒烟，再发布 MCP beta.5。

## 发布顺序

1. 提交并推送 `codexproject`，确认 GitHub Actions catalog 门禁通过。
2. 用 MCP beta.4 或本地构建指向远端新 manifest，确认日志出现 `File catalog loaded` 且无 API 兜底。
3. 发布 `codex-skills-mcp@1.5.0-beta.5 --tag beta`。
4. 抽测一个多文件技能和大技能，确认冷下载、二次读取与 `skill_status` 完整性。

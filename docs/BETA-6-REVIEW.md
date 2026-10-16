# beta.6 性能迭代记录

日期：2026-10-16 至 17；开发版本 `1.5.0-beta.6`，插件 `0.3.6`。当前 npm `beta` 仍为已发布的 `1.5.0-beta.5`，`latest` 为 `1.4.2`。本记录不代表 beta.6 已发布。运行时代码已保存并推送为 `30c97b6`。

## 改动范围

保留源仓库生成 manifest/catalog、MCP 按需完整物化的分工。源仓库保持 `bd2ad1b91`，本轮没有修改技能源或 catalog；MCP 基线为 `a49358a`（运行时代码与 beta.5 发布包一致）。

- `SkillLoader.readInstructions` 与 `readSkill` 共用完整物化和根说明读取；`skill://` 资源只取说明，省去随后丢弃的目录树、子技能说明、依赖扫描。根路由、说明全文、Supporting files 指引、请求取消和 deadline 语义保持。
- 新增 `DownloadHedger`，把节点调度从传输与哈希校验中拆出。默认节点仍立即启动，已验证 winner 若不同则同时启动，其余节点最迟 400ms 加入；失败立即启动后备。关闭官方镜像或使用 `--no-hedge` 时仍立即启动所有节点。
- 仅完整 SHA 校验通过的响应更新路由；在同缓存/源/镜像配置范围内最多保存 32 条路由，五分钟过期，不存储凭据。目录索引能帮助后续文件选择节点。没有为减少请求而延长旧版任一节点的启动时间；这约束的是调度时机，不保证公网实际耗时。
- SHA 校验仍在节点胜出之前。取消的竞争请求不删除成功路由；真实失败仅删除其观察到的路由版本，避免较早请求的晚失败覆盖新成功；并发晚成功也不把不同的新路由覆盖回旧 winner。
- 单轮镜像竞速共用总 deadline，包含延后启动时间；超时清理计时器和在途请求。历史 Git blob 回退仍位于该轮之后，独立计时。

调度参考 [gRPC A6 hedging](https://github.com/grpc/proposal/blob/master/A6-client-retries.md) 的渐进尝试和总预算，以及 [Envoy circuit breaking](https://github.com/envoyproxy/envoy/blob/main/docs/root/intro/arch_overview/upstream/circuit_breaking.rst) 对额外并发预算的区分。这里只实现单轮预算与有界路由记忆，跨技能全局 HTTP 并发预算仍是后续工作。

## 可复现测量

先保存基线的 `dist` 及其上级 `package.json`（ESM）和依赖，再构建候选版本。

```bash
npm run build
node scripts/benchmark-loader.mjs --source-root /path/to/codexproject/codex-skills --baseline-dist /path/to/beta5/dist --samples 15 --output /tmp/loader.json
node scripts/benchmark-remote.mjs --baseline-dist /path/to/beta5/dist --branch bd2ad1b9128b2145499022af2a7b408cf889adcd --runs 3 --output /tmp/remote.json
```

热读测量使用真实 catalog 路径/大小/权限及 SKILL.md，其他文件为 sparse placeholder；不修改源库，测试后删除临时缓存。它覆盖热缓存的存在/大小/权限检查，不声称每次热读都重新哈希全部文件。网络下载和未完成缓存恢复继续验证 SHA。计时不含最终 JSON 序列化和传输。

公网测量按 AB/BA 交替启动独立进程，每次使用全新磁盘缓存和真实远端 manifest/catalog/文件。冷读计时从清单获取完成后开始，包含 catalog 和文件物化，不包含清单启动延迟。每份文件复核 SHA、长度及执行位，验证正常路径零 GitHub API 与热读零请求。HTTP 尝试包含被取消的竞争请求，不等于完整下载多份内容。三个或五个样本不足以给出可靠生产 P95，报告中只列中位数和样本最大值。

分阶段调度第一版三轮实测：human-writing 请求中位数 70 → 15，冷读 1,758 → 1,184ms；superpowers 请求 285 → 121，但冷读 4,207 → 5,078ms。第二版五轮仍不满足稳定提速：human-writing 中位数 2,164 → 2,572ms、最大值 3,199 → 8,073ms，superpowers 中位数 4,490 → 4,562ms、最大值 5,299 → 6,998ms。对应原始数据为 [第一版](benchmarks/beta6-progressive-first.json)、[第二版](benchmarks/beta6-progressive-second.json)。

因此最终移除分阶段延后后备与大小分桶延迟学习，采用保留旧启动时机的方案：默认节点 t=0，额外已验证 winner t=0，其他节点不晚于 t=400ms。无官方镜像时保留全部即时竞速。保留失败时立即推进、完整性验证、winner TTL 和并发记录保护；不把请求数下降单独当成延迟改善。

## 大技能预览实测

macOS arm64，Node 26.4.0；15 次采样、3 次预热；公网实验完成后独立运行。原始数据、I/O 计数及模块摘要保存在 [beta6-loader.json](benchmarks/beta6-loader.json)。随后仅调整下载调度及零字节网络响应校验，热读取路径保持。

| 技能 | 文件数 | beta.5 预览 p50 | beta.6 预览 p50 | 降幅 |
| --- | ---: | ---: | ---: | ---: |
| human-writing | 13 | 0.707ms | 0.227ms | 67.9% |
| x-cmd | 5,334 | 215.473ms | 70.594ms | 67.2% |
| Awesome-Journal-Skills | 10,851 | 810.446ms | 138.029ms | 83.0% |

Journal 预览同步目录读取 8,546 → 0，文件读取 4,168 → 2；单次定时器延迟观察为 839.712 → 138.855ms。完整 read_skill p50 为 945.869 → 943.646ms，基本不变；其结构与子技能扫描保留，下一轮继续处理。所有 fixture 热读零网络、最终完整。

## 保守调度公网结果

最终构建使用固定源提交 `bd2ad1b9128b2145499022af2a7b408cf889adcd`，两种构建各执行三轮交替对照；原始样本、运行时指纹和每节点尝试数保存在 [beta6-remote.json](benchmarks/beta6-remote.json)。两个版本使用同一远端源版本，所有文件 SHA/长度/执行位检查通过，正常路径零 API、热读零网络。

| 技能 | beta.5 冷物化 p50 / 最大值 | beta.6 冷物化 p50 / 最大值 | 请求中位数 |
| --- | ---: | ---: | ---: |
| human-writing（13 文件） | 2,656 / 2,692ms | 1,444 / 1,964ms | 70 → 43 |
| superpowers（56 文件） | 5,005 / 5,774ms | 2,720 / 3,140ms | 285 → 147 |

两项冷物化 p50 各改善约 46%，请求分别减少约 39% 和 48%。含清单获取的两阶段总耗时 p50 为 human-writing 4,115 → 2,439ms、superpowers 6,248 → 3,514ms；这两个总数同时受各次网络清单延迟影响，不能全部归因于文件调度。样本较少且源 ref 与前两次实验不同，只比较本轮成对数据，不把三轮结果当作稳定生产 P95 或跨网络承诺。

## 验证

- 全量构建和离线回归：123/123 通过，包括原 90 项、10 项 loader/resource 物化与取消回归、23 项调度及传输集成回归。
- 新调度测试使用确定性时钟，覆盖旧节点启动时机、最快/最后节点、已验证 winner 复用、TTL/容量、取消、共同 deadline、短预算、同步失败、并发晚失败、no-hedge 和凭据隔离。
- npm 包和 standalone plugin 构建与真实 stdio 验收通过，各 2/2。运行时提交 `30c97b6` 的 [Node 22/24 CI](https://github.com/Zhan-ZhangZ/codex-skills-mcp/actions/runs/38930445765) 已通过；本地 Node 22 临时运行时的包下载未完成，已终止该独立安装进程。
- 保守调度的 main 分支公网复测在首个 beta.5 基线样本前停止：直连清单 fetch failed，镜像返回 291 条目但 0 catalogs 的旧清单。验收脚本正确拒绝；[失败记录](benchmarks/beta6-main-unavailable.json) 保留。后续对照固定源提交，避免将不同清单版本混入下载调度比较。
- 补齐既有零字节边界：HTTP 204 等空正文成功响应也必须匹配空 Git blob SHA，正确零字节文件仍可物化。

## 保留的边界与后续工作

- `read_skill` 仍返回完整结构与子技能摘要，超大技能仍有同步目录扫描、重复 cacheState 检查和大输出成本。下一步是请求内状态复用、catalog 驱动目录结构和有界异步 I/O，再考虑输出预算。
- `skill_status` 保持显式逐文件检查。网络和恢复使用 SHA，已完成热缓存使用存在/大小/执行位检查；同长度的本地篡改不在本轮热检查覆盖范围内。
- 获胜节点复用旨在减少请求放大；所有后备节点仍可能同时在途，尚无跨技能全局 HTTP 并发限制。逐文件下载 N 的数量级瓶颈需单独评估技能归档分发。
- 资源预览沿用旧版本可用缓存行为；它尚未提供 `read_skill` 的 cached revision 状态提示。后续请求内物化结果复用应同时补齐该状态，不增加第二遍全树检查。
- 当前分支清单回退到旧镜像版本是新增实测发现；后续需评估权威元数据回退与清单版本标识，保持自定义旧源兼容，不能静默接受过时目录作为性能验收输入。
- 真实 ChatGPT 宿主视觉验收仍待执行；现有验收覆盖前端 DOM、MCP 协议和打包产物。

# beta.6 性能迭代记录

日期：2026-10-16 至 17；开发版本 `1.5.0-beta.6`，插件 `0.3.6`。当前 npm `beta` 仍为已发布的 `1.5.0-beta.5`，`latest` 为 `1.4.2`。本记录不代表 beta.6 已发布。第一轮运行时代码为 `30c97b6`；下方补充第二轮完整读取与清单刷新迭代。

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

## 第二轮：完整读取与权威清单

本轮比较基线为上一轮 beta.6（`14de9ec`，运行时与 `30c97b6` 相同），不是已发布的 beta.5。继续保留源库生成不可变 catalog、MCP 负责下载与消费的分工；没有重新设计源库格式，也没有恢复前轮已撤销的渐进延后调度。

- `ensureSkillFetched` 返回单次请求凭据，读取前 peek 取得文件列表，异步读取后 consume 校验。凭据绑定缓存目录、source、技能路径、catalog SHA、marker 的设备/inode/时间身份；有界 mutation epoch 使未改 marker 的修复也能使旧凭据失效。失配重试一次，避免跨版本拼接结果。每个新请求仍检查文件，不把某次成功检查永久缓存；`skill_status` 保留独立逐文件检查。
- 完整远端目录直接从已验证列表构建，保留显示深度、隐藏名称及子技能发现规则。目录描述源库登记文件，手动添加到远端缓存的额外文件、子技能、空目录不进入列表；`--skills-dir` 本地编辑模式仍扫描实际目录、反映新增/删除/修改。这是明确的远端缓存语义调整。
- 根说明、子技能读取使用每 loader 共用的八路文件 I/O 池；摘要缓存限制为 8,192 项、4 MiB。缓存键包含 source、文件 SHA 和本地 inode/size/mtime/ctime；同大小编辑、mtime 恢复、源或 catalog 改变均会失效。缓存满或单项过大只影响复用，不截断返回说明。
- `read_skill` 复用请求状态，`skill://` 预览使用同一结果提示未通过当前 catalog 校验的 cached revision；不为提示再扫描全树。
- 清单网络读取提取到独立模块。raw 立即启动；Contents API 最迟 800ms 加入（短预算提前），明确失败立即加入。两个权威端点共用完整响应 deadline：启动 20s，轮询 4s。候选必须读完整正文并通过 manifest 校验后胜出，API 的限流或错误不会取消仍在途的 raw。
- ETag/Last-Modified 绑定准确端点 URL 和正文 SHA-256；304 只复用实际发出匹配条件头的有效缓存。旧版未绑定 ETag 通过一次无条件权威请求迁移。合法同源缓存遇到全部权威失败时不查询镜像：自动启动继续用缓存，显式刷新报错。无合法缓存仍允许经过结构校验的镜像引导，兼容旧清单；这不能证明镜像新鲜度。后台轮询始终不用镜像。

HTTP 条件请求语义参考 [GitHub REST 最佳实践](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests-if-appropriate)；仅允许各端点复用自己签发的 validator。并发读取依据 [Node.js 文件系统 Promise API](https://nodejs.org/api/fs.html#promises-api) 使用异步 I/O，并在应用层限制并发，避免大量子技能同时提交无限制文件操作。

### 第二轮测量与验收

macOS arm64、Node 26.4.0；每项 15 次、3 次预热，测试期间无其他本任务的构建或网络基准。仍使用真实路径/大小/权限及 SKILL.md，其他文件为 sparse placeholder。原始样本和构建指纹见 [beta6-full-read.json](benchmarks/beta6-full-read.json)，与最终本地构建模块 SHA 一致。全部请求零网络、最终缓存完整；计时不含最终 JSON 序列化和传输。

| 技能 | 完整热读 p50：上轮 → 本轮 | 新 loader 首读 p50：上轮 → 本轮 | 预览 p50：上轮 → 本轮 |
| --- | ---: | ---: | ---: |
| human-writing | 0.880 → 0.351ms | 0.894 → 0.364ms | 0.254 → 0.282ms |
| x-cmd | 292.339 → 75.454ms | 313.205 → 75.691ms | 71.915 → 72.951ms |
| Awesome-Journal-Skills | 1,034.205 → 185.015ms | 979.120 → 286.937ms | 148.766 → 138.348ms |

“新 loader 首读”使用完整磁盘缓存，每个样本建立新 loader，内存摘要缓存为空；不是网络冷下载。Journal 完整热读改善 82.1%，首读改善 70.7%；预览基本维持上轮水平。小技能预览增加 0.028ms，不能描述为所有路径都变快。

Journal 完整热读同步目录调用 8,546 → 0、同步文件读取 4,169 → 1；新增 4,166 次异步 stat、1 次异步文件读取。摘要空缓存首读有 4,167 次异步文件读取，最高同时在途 8 个。输出仍为 2,067,915 字节，没有通过裁剪说明或摘要制造提速。单次定时器延迟 936.268 → 138.132ms，四个并发热读总耗时 3,861.177 → 696.566ms；这些是单次观测，不是生产延迟保证。

本地编辑模式 readSkill p50：human-writing 0.310 → 0.424ms（增加 0.114ms），x-cmd 98.727 → 44.051ms，Journal 474.264 → 314.238ms。每次仍从实际目录读取，未用跨请求缓存掩盖本地修改。

- 最终本地构建与回归 187/187；包括 17 项物化凭据、11 项 loader 集成、30 项清单网络边界、6 项清单持久化新增回归。
- npm 打包和 standalone plugin 各 2/2 真实 stdio 验收通过。Node 22/24 的验证由对应提交的 CI 执行。
- 真实 Contents API 故障回退验收记录见 [beta6-authoritative-smoke.json](benchmarks/beta6-authoritative-smoke.json)：主动阻断 raw 清单请求，使用已认证 API 获取正文，并与源库 main 的预期 SHA 比较；随后实际下载 human-writing 与 superpowers，验证文件 SHA、大小、执行位、常规文件零 API 和热读零网络。该记录是一次正确性冒烟，不是 A/B 性能比较；没有把凭据写入报告。

复现清单回退（需要可用的 GITHUB_TOKEN）：

```bash
node scripts/check-remote-catalog.mjs --force-manifest-raw-failure --expected-manifest-sha256 5b17d8ac3c80e73f0d00d9b85ace992089518a6275eef58e7801cba1d13ac56d --skill human-writing --skill superpowers
```

预期 SHA 对应源提交 `bd2ad1b91`；源库后续更新后应先确认新的源 SHA，旧值将按设计拒绝其他版本。

## 保留的边界与后续工作

- `read_skill` 仍返回完整结构与子技能摘要；超大输出的格式化、序列化和传输成本仍存在。已完成远端目录扫描消除、同请求状态复用和有界异步 I/O；后续评估分页/输出预算，同时保留说明可发现性。
- `skill_status` 保持显式逐文件检查。网络和恢复使用 SHA，已完成热缓存使用存在/大小/执行位检查；同长度的本地篡改不在本轮热检查覆盖范围内。
- 获胜节点复用旨在减少请求放大；所有后备节点仍可能同时在途，尚无跨技能全局 HTTP 并发限制。逐文件下载 N 的数量级瓶颈需单独评估技能归档分发。
- 热读仍有同步的逐文件存在/大小/权限检查。异步摘要读取改善响应让出执行权，但没有消除这段同步成本；小样本事件循环观测不是延迟上限保证。
- 已有有效同源清单的镜像降级问题已通过权威双通道与缓存保护处理；无有效缓存时的镜像引导仍可能旧。没有依据条目数、catalog 数量或时间戳猜测版本先后；未来版本标识仍需独立设计。
- 真实 ChatGPT 宿主视觉验收仍待执行；现有验收覆盖前端 DOM、MCP 协议和打包产物。


## 第三轮：有界导航、完整检索与共享 HTTP 预算

时间：2026-10-17。仍为 `1.5.0-beta.6` 开发版，未发布。基线是已推送的 `25f42d6` 构建；比较源库为本地 `codexproject/codex-skills`，客户端通过真实 stdio 传输调用同一个 `Awesome-Journal-Skills`。

### 行为变化

- `read_skill` 继续强制完整物化并原样返回根 `SKILL.md`；目录与子技能只返回有界预览。每页最多 100 项，且导航条目渲染预算为 12 KiB（标题、续页说明和结构化元数据不计入该预算）。
- `list_skill_files` 不新增工具，扩展 `view/path/query/limit/cursor`：`view=sub_skills` 会检索全部嵌套深度，query 先过滤完整名称、路径和完整描述，再分页；`view=files` 保持 `max_depth` 语义。
- 分页游标是进程内 HMAC 签名的偏移量，不保存快照。修订摘要绑定来源/缓存/技能、实际 catalog、路径、查询、深度和全部完整 rows；重启、换源、修订、过滤条件或本地内容变化都会要求从第一页重启。
- 子技能元数据改用成熟 YAML parser 仅解析 front matter，正确处理引号、folded/literal 描述，不再把正文标题或 `>`/`|` 标记当成描述。本地摘要缓存按 inode/size/mtime/ctime 绑定，避免每次重复解析，同时保留本地编辑失效。
- 文件、catalog/tree/Contents 元数据和 manifest 共享进程级 HTTP admission。默认总容量 88：数据请求上限 80，元数据保留 8，其中 manifest 专属保留 4；并发配置高于 16 时按最高有效并发扩容到最多 328，不把多个技能的容量相加。名额覆盖 fetch、完整 body 读取、取消和校验，排队时间计入原 deadline，并按技能/来源轮转。
- `diagnostics` 新增 HTTP admission 的容量、active/queued 和分类计数，只暴露计数，不暴露 URL、路径或凭据。

### 实测

| 指标（Awesome-Journal-Skills，真实 stdio） | `25f42d6` 基线 | 当前 | 变化 |
|---|---:|---:|---:|
| `read_skill` 首次结果 JSON | 2,067,825 B | 20,146 B | -99.0% |
| `read_skill` 首次耗时 | 543 ms | 436 ms | -19.7% |
| `read_skill` 热读中位数 | 273 ms | 209 ms | -23.4% |
| `list_skill_files` 文件页 JSON | 293,311 B | 3,217 B | -98.9% |
| `list_skill_files` 文件页中位耗时 | 38 ms | 40 ms | 基本持平 |
| 子技能完整检索结果 JSON | 不支持 | 13,105 B | 新能力 |

当前子技能检索中位 200 ms：它必须遍历 4,166 个嵌套 `SKILL.md` 并覆盖完整描述，基线的 `list_skill_files` 没有该能力，因此这不是同类耗时对比。根说明最大 63,979 B，全部保留；导航只截断名称/描述标签。

完整数据和基线摘要见 `docs/benchmarks/beta7-navigation-stdio.json`。新的只读源库审计脚本默认输出 25 个最大 payload 与全库汇总，当前跟踪报告约 64 KiB；`--full` 可按需生成全量 291 项报告。审计确认 8,346 个子技能可返回，旧深度/跳过规则遗漏为 0，YAML block/quote 伪描述为 0；报告见 `docs/benchmarks/skill-payload-audit.json`。

### 验证与边界

- 新增导航纯函数、loader 视图、工具接续、HTTP admission 单元/公共 API 集成回归。
- 验证了全部页无重复/漏项、12 KiB 预算、UTF-8 码点截断、末项查询、完整描述超出显示摘要仍可检索、篡改/过期 cursor、源/内容/filter/depth 失效、`read_skill` cursor 在 `list_skill_files` 继续、本地编辑失效和 16 个工具数量不变。
- 模拟传输下三个并发技能的峰值从 240 路数据请求降至 80；慢取消不会提前释放名额，SHA mismatch 会释放且不物化字节。
- 边界：101 个超过 500 KiB 的辅助文本文档仍需后续设计显式 chunk/range 读取；共享 HTTP 预算的真实公网耗时还未测量；本记录不代表 npm 发布。

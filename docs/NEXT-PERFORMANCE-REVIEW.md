# beta.5 后的性能迭代依据

基线：运行时代码 `89ed028`；2026-10-16，Node 26.4.0、macOS arm64。本记录保存 beta.5 基线。后续 beta.6 开发版已实现轻量资源预览及已验证下载节点复用；分阶段延后后备的实验未获稳定延迟收益，未采用，实测与尚未完成事项见 [BETA-6-REVIEW.md](BETA-6-REVIEW.md)；尚未发布。

## 下载请求放大

完整公网验证中，human-writing 的 13 个文件加 1 个 catalog 产生 70 次 HTTP 尝试，冷读 1,753.82ms。每个逻辑获取在官方加速节点超过 400ms 后同时启动四个后备；默认 16 文件并发可放大到 80 个在途请求。请求数包含取消尝试，不等同于完整传输了五份内容。

建议以分阶段 hedging 加短期优胜节点记忆降低放大；只学习经过完整 SHA 校验的响应，不记录 token，取消的 loser 不计失败。对小/大文件分别估计完成耗时；保留 no-hedge 的全竞速语义；所有节点故障仍须有界结束。

合成调度模型使用 100 个随机种子、独立 ±10% 延迟、8 文件 worker；不包含真实带宽竞争或连接成本，因此只用于策略选择：

| 场景 | 当前尝试数 | 分阶段 + 已验证 winner 记忆 + 动态延迟 |
| --- | ---: | ---: |
| 13 文件，首选 1,500ms、raw 150ms | 65 | 21 |
| 100 文件，首选 1,500ms、raw 150ms | 500 | 108 |
| 100 文件，节点均约 1 秒 | 500 | 136 |

单纯分阶段有代价：只有后部镜像有效时首批 P95 约增加 400ms。实现后必须同机交替比较请求数、总耗时和尾延迟，不能只以请求更少作为验收。

参考：[gRPC A6 retry/hedging](https://github.com/grpc/proposal/blob/master/A6-client-retries.md)、[Envoy circuit breaking](https://github.com/envoyproxy/envoy/blob/main/docs/root/intro/arch_overview/upstream/circuit_breaking.rst)。对应经验是渐进尝试、总 deadline、额外请求预算；文件 worker 上限不等同于 HTTP 请求上限。

## 大技能热读取

使用真实 catalog 路径、大小、mode 和 SKILL.md，在临时目录构造完整缓存；其他文件为 sparse placeholder。每项预热 3 次、测量 15 次，零网络请求，数据不代表生产 SLA。

| 技能 | 文件数 | read_skill p50 | App 预览 p50 | 结构扫描 p50 | 第二次 cacheState p50 |
| --- | ---: | ---: | ---: | ---: | ---: |
| human-writing | 13 | 0.668ms | 0.556ms | 0.302ms | 0.123ms |
| x-cmd | 5,334 | 285.567ms | 214.250ms | 144.613ms | 69.625ms |
| Awesome-Journal-Skills | 10,851 | 939.430ms | 798.905ms | 661.816ms | 139.132ms |

Journal 的一次读取调用约 80,771 次 lstatSync、24,878 次 statSync；子技能发现读取 4,166 份说明，工具响应 JSON 约 2.07MB。同步读取期间 setTimeout(0) 延迟约 938ms，四个并发调用共约 3,833ms。真实源目录的子技能发现 p50 约 402ms，占其结构扫描约 91%。

资源处理器最终只返回 instructions，却调用完整 readSkill，计算了随后丢弃的结构和依赖信息。前端的五分钟缓存能减少同实例重复调用，首次打开和新 iframe 仍承担全部代价。

## 实施顺序与验收

1. 将完整物化后的说明读取拆成轻量方法，资源预览省去结构/依赖扫描；保持 read_skill 的完整执行信息和缓存语义。测试缺失/损坏文件、取消与 deadline，实测大小技能预览耗时。
2. 同一请求复用物化验证结果，绑定 source、catalog SHA 和 marker generation；skill_status 继续显式深检查，失败和更新后不得复用过期结果。
3. 以已验证 catalog 构建目录和子技能路径，按内容摘要缓存说明；本地可编辑模式需独立失效策略。用有界异步 I/O 改善其他会话延迟，不能仅把同步扫描包进 Promise。
4. 给目录和子技能输出明确预算及继续获取入口，保留可发现性；评测大响应序列化和模型上下文成本。
5. 实现渐进下载调度并做真实小/大技能的重复 A/B 测量；按技能归档分发进一步降低 N 本身，独立于本轮调度优化。

每一步保持完整性验证、故障恢复和热读零网络的回归，不以宽松校验换取更小耗时。

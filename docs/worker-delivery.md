# Worker 交付与有限批次

[English](worker-delivery.en.md) | 中文

本页说明可选的交付收集与 batch 路径。日常一个 worker 仍用原有 `run` / `continue` /
`close`，每轮显式权限，不要求额外记录。共同角色契约让 worker 在已有范围内完成调查、
实施、自检、自修与收尾；遇到确切权限、能力或产品判断缺口时，保留成果并提出精确问题。

## 先让一次责任交付完整

实际 ACP 工单包含安装包中的共同 [worker contract](../plugins/worker-routing/skills/worker-routing/references/worker-contract.md)。
原生交接使用同一语义；[共同入口](../plugins/worker-routing/skills/worker-routing/SKILL.md)
负责责任和验收，[ACP 快速入口](../plugins/worker-routing/skills/acp-worker/SKILL.md)负责调用。
Dispatch、身份恢复和批量方法在具体触发时读取；无需为一次正常派工加载统计 schema。

普通检查失败应成为 worker 继续定位与修正的反馈，不自动结束责任。已有正确结果与有效
证据继续保留；达到既定条件就交付，不固定追加反思轮次。协调方提出的两次返修与 worker
内部测试迭代分别判断。主脑提供关键判断或处理一个受限操作后，可以将余下执行交回原
session；先停止重叠 writer，说明已固定内容，让 worker 重读受影响状态。

## 可选交付收集

复杂调查或一批结果可在 `run` / `continue` 加 `--deliver`。正文仍是小型、已授权的
工程工单；collector 负责保存报告，read worker 无需为写 JSON 获得 full。

```sh
node ENTRY run --config CONFIG --cwd WORKSPACE --file ORDER --permissions read --deliver
node ENTRY continue --config CONFIG --session UUID --file INCREMENT --permissions full --deliver
node ENTRY delivery --config CONFIG --session UUID --json
```

worker 按工单给出的有界 `cwr-delivery` JSON block 约定返回。交付可声明 `ready`、
`partial` 或 `needs_input`，并附简短结论、已满足条件、必要支持证据、可展开 artifact、
实际检查及精确问题。详细格式由入口生成；用户不必手写一份报告表单。

`ready` 是候选成果声明。runtime completed、报告完整、检查结果和协调验收是四个不同
事实。报告缺失、格式错误、超限或身份不匹配保持可见，不改写原 runtime receipt；不能
因此自动重放已经完成的写工单。结构化内容单独收集，不从有限文本 excerpt 猜测完成。

结果始终绑定实际 session/request。迟到旧结果不能替换新交付，重复不变成新责任。
worker 自述的检查保留 `worker_reported` 来源；只有受信执行路径观察到的事实才能标作
`runner_observed`。相关源码、测试或依赖变化会使受影响证据陈旧；dirty 内容不能仅用
HEAD 识别。可定位的文件引用不自动证明正文支持结论；报告内容也不授予执行其命令的权限。

## 展开有限批次

已明确、互不阻塞的责任可以使用安装包的 [swarm 方法](../plugins/worker-routing/skills/swarm/SKILL.md)。
批次先确定目标、有限清单、写入所有权与共享资源，再由运行器启动独立 CLI 子进程，
收集实际句柄、终态和报告。空闲 slot 可以执行清单内下一项；一个慢任务不阻塞所有无关
结果，但必需项缺失时批次只能 partial。

```sh
node ENTRY batch --config CONFIG --manifest BATCH_FILE --concurrency 2
```

manifest 由协调 agent 生成，schema 为 `cwr.acp.batch-manifest/1`。每项有稳定 id、
`run` 或 `continue`、工单位置、明确权限以及相关 cwd/session 和共享资源。它索引既有
句柄与回执，不建立第二个任务数据库。以下是合成的最小 manifest；实际 route 和绝对路径由协调者从已授权配置生成。

```json
{
  "schema": "cwr.acp.batch-manifest/1",
  "maxConcurrency": 2,
  "jobs": [
    {"id": "a", "verb": "run", "route": "worker", "cwd": "/workspace/a",
     "file": "/orders/a.md", "permissions": "read", "resources": []},
    {"id": "b", "verb": "run", "route": "worker", "cwd": "/workspace/b",
     "file": "/orders/b.md", "permissions": "read", "resources": []}
  ]
}
```

run 项显式 route；continue 项使用原 session 和相同 cwd，不另选 route。每项默认收集交付，
只有明确只需 runtime 事实时才设 `deliver:false`。共享 HOME 并发展开同时要求 manifest 的
`capabilities.sharedWorkerHome="validated"` 与每个相关项的 `sharedHomeValidation="validated"`；
这些声明必须有真实 adapter 验收支持。否则保守串行。`complete` 表示结果覆盖完整，仍不等于工程验收。

start handle 记录 `locks_held`；adapter 初始化与 prompt acknowledgement 可能尚未完成。
运行器将子进程的实际选择与资源计划核对，配置变化时在 launch 前拒绝；父进程取消复用
普通 cancel 的 nonce-bound 控制写入。

保留 exact-cwd 锁。不同目录、worktree 或 read 模式都不证明实际写入、Git 公共状态、
adapter HOME/session store/cache、端口和数据库已经隔离。共享 HOME 并发未经确认时，
批次串行该资源；只有已有授权且完成对应能力验收的安排才能展开。不能为并行复制凭据、
扩大父目录或改 cwd 绕锁。批次并发限制只约束这个运行器，不冒充所有 CWR 实例的全局限额。

父进程停止时不再启动新项，向已拥有的 CLI 发出取消请求，并有界等待其 cleanup；
超过等待期限的执行保持 unconfirmed，句柄和回执留给恢复。含糊提交与未知
清理保留原状态供恢复；不能因为没有拿到最终报告就再派同一写工单。健康进度留在工具
等待里，主脑接收有意义的异常或批次概览。

## 主脑如何验收一批结果

程序先检查身份、覆盖、重复、缺失、引用与证据新鲜度。语义判断仍有归属。复杂跨结果
比较可交给一个平级归并 worker，输入是报告与必要证据；它保留版本差异、淘汰理由、反证
与未决冲突，只把会改变决策的小问题送回原责任，不重新通读全部来源。

主脑关注关键结论、覆盖、冲突与集成边界，有具体疑点时定向展开或委派检查。并行修改
需验证组合后的最终状态；各自测试通过不能替组合结果作保。未知输入不算“不支持”，
开放调查也不要求凑出固定数量的推荐。

## 有范围的检查与反馈

先复用项目已有检查，再补真实缺口。确定行为失败带最小反例回原 worker；环境缺失、
检查未执行、skip、过期证据与标准冲突分别处理。同时保留合法成功与非法拒绝对照，
必要时用一个窄范围坏实现检查门槛的鉴别力。

验收 argv、cwd、预算和日志上限来自协调者确认的任务检查。不得执行报告中任意 shell
字符串，也不得把候选测试搬到主脑有更多 HOME/凭据/网络/写权限的环境里。缺能力应返回
blocked；permission-response policy 不提供 OS sandbox。

验收 helper 要求显式任务 HOME/环境；缺少时返回 blocked。调用者确认适用标准与覆盖后，
才设置 `criterionApplicable:true`；默认只保留进程结果，不把 exit 0、零检查或 skip 算作通过。
文件引用检查只证明授权根内的可定位性；size/mtime 比较不证明 dirty 内容仍新鲜。
Windows 的验收 helper 不能证明强制超时后的整个进程树清理，因此该情况标作 unconfirmed。
这不改变原 ACP runtime 自己的三平台清理验证。

默认自修位于 agent 的内部反馈循环。外层自动续做只作为有界实验：明确的适用检查
失败、原执行已结束且 cleanup confirmed、同 session 的精确反馈、最多两次外层修正
和不刷新的责任总 deadline。成功或单纯缺报告不追加反思，含糊执行、撤权、取消和没有
新证据的重复失败不盲重试。实验有净收益才考虑窄范围采用。

长期行为回归进入已有 tests；临时探针、报告和运行日志留在 Git 外任务现场。只清理
已确认归属且获准处理的对象；活跃 writer、未知 cleanup、用户 dirty files 与唯一失败
证据保留。需要删除被引用的现场时，先保留最小可复现材料或标记证据过期。

单个 ACP turn 可以包含多次模型/工具反馈，这是让普通自修留在执行者内的基础；
`end_turn` 表示该轮停止请求工具，并不代表任务验收通过。[ACP Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)

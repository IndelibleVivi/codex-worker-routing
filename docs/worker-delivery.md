# Worker 交付与有限批次

[English](worker-delivery.en.md) | 中文

本页说明可选的交付收集与 batch 路径。日常一个 worker 仍用原有 `run` / `continue` /
`close`，每轮显式权限，不要求额外记录。共同角色契约让 worker 在已有范围内完成调查、
实施、自检、自修与收尾；遇到确切权限、能力或产品判断缺口时，保留成果并提出精确问题。
交付、批次与恢复在整体系统中的位置见[架构总览](architecture.md)。

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

省略 `--request` 时，`delivery --session UUID` 按 `finished_at`、再按 `request_id`
读取现存有效 delivery 中最新的记录。要读取某一轮必须使用 `--request REQUEST_ID`：
named missing 显示缺失（JSON 中为 `delivery: null`），named corrupt 直接拒绝。扫描会跳过
invalid 记录，并在返回有效结果时以 warning 报告数量；若只剩 invalid 记录则拒绝扫描结果。
旧报告不能作为另一个 request 的证据。

新写入的 block 保留已校验的 request/session ID。只要内嵌 block 出现任一 ID，两项就必须
都是有界 UUID 且与外层 sidecar 匹配；两项皆缺仅按 legacy stored shape 读取。该形状不能
认证来源，也无法区分真正旧记录与后来同时移除两项 ID 的记录。

## 展开有限批次

有限且明确的任务（可带事先声明的依赖）可以使用安装包的 [swarm 方法](../plugins/worker-routing/skills/swarm/SKILL.md)。
批次先确定目标、有限清单、写入所有权与共享资源，再由运行器启动单独的 CLI 子进程，
收集实际句柄、终态和报告。空闲 slot 可以执行清单内下一项已就绪任务；一个慢任务不阻塞
无关结果，但必需输入缺失时批次只能 partial。

```sh
node ENTRY batch --config CONFIG --manifest BATCH_FILE --concurrency 2
node ENTRY batch --config CONFIG --manifest BATCH_FILE --start-handle HANDLE --compact
```

给 `batch` 传 `--start-handle FILE` 时，运行器在初始索引落盘之后、启动任何子进程之前，
把本批的机器句柄（`batch_id` 与索引位置）写入该文件；句柄写入失败会在启动前终止整批。
调用者因此可以直接寻址该批，而不必扫描私有 state 目录去猜 batch id。句柄只是身份指针，
不是进度信号：仍没有逐项唤醒。`--compact` 让终态 stdout 变成有界分页响应，默认保留的完整
终态返回不受影响。

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

### 有限依赖

依赖边必须显式、有限，指向前项只能来自同一 manifest；每条边都要有输入绑定：

```json
{
  "id": "c", "verb": "run", "route": "worker", "cwd": "/workspace/c",
  "file": "/orders/c.md", "permissions": "read",
  "depends_on": ["a", "b"],
  "inputs": [
    {"job": "a", "report": true},
    {"job": "b", "report": true, "artifacts": ["out/result.json"]}
  ]
}
```

`prepare` 与 manifest admission 会在启动前拒绝未知、自引用、重复和循环引用，拒绝只有
`depends_on` 而没有输入绑定的项，以及 `deliver:false` 的前项。选中报告指完整、已校验的
`cwr-delivery` block，绝不是 compact 摘录；选中 artifact 必须已观察到存在于前项 workspace。
绑定内容携带前项确切 job/session/request；它仍标为 `worker_reported` 与不可信输入，不是
可执行指令或 owner 验收。依赖不合并锁、不放松 route 授权，也不绕过 exact cwd、HOME、操作
或资源并发规则。

绑定内容会进入后继工单并发送到该 job 所选 route；协调者声明输入时需核对材料与接收方的
现有授权。artifact 绑定保留引用与已观察信息，原件读取仍服从该任务的范围。

两项 `continue` 可以用依赖边顺序续做同一个已存在的 session；每轮保留自己的 request 与
报告，现有 cwd/operation 锁仍生效。manifest 不会把未知的新 session ID 当作可引用句柄。

独立 A/B 与无关 D 可在当前 concurrency 下一同启动；C 只等它声明的 A/B。每项前项必须已完成
runtime、确认 cleanup、receipt/handle identity 匹配且交付为有效 `ready`。报告缺失/格式错误、
runtime failed/cancelled、身份不符或 cleanup 未确认都阻断 C。组合输入超过 order 上限时
明确阻断，绝不裁剪。

`collect --compact` 把 `waiting`（前项未结束）、`blocked`（输入被拒或前项失败/阻断，包括
传递阻断）、已记录 handle 的未结算项、`awaiting_handle` 与终态 `missing` 分开；waiting/blocked
不会伪造结果。当前没有 child 能解开有限图时批次结算为 partial。取消或索引失败会终止所有
新 launch，包括刚变成就绪的后续项。

start handle 记录 `locks_held`；adapter 初始化与 prompt acknowledgement 可能尚未完成。
运行器将子进程的实际选择与资源计划核对，配置变化时在 launch 前拒绝；父进程取消复用
普通 cancel 的 nonce-bound 控制写入。取消或索引发布失败是批次级准入终止状态：调度器
在每次准入异步操作之后、实际启动之前重新确认，已取消的批次不再启动任何新项。批次
开始后的配置重读或启动失败不吞掉整批结算：停止新准入，保留已收结果，输出带
`admission_error` 的 partial；尚未启动的项计入 missing，不伪造句柄或回执。

子进程 stdout 与 stderr 各有独立有界保留预算：诊断日志耗尽自身预算只截断 stderr
（结果中 `stderr_truncated` 保持可见），不会挤占机器回执空间；stdout 一旦被截断，
保留前缀即使恰好是合法 JSON 也拒绝当作回执，该项计入 missing。

父进程停止时不再启动新项，向已拥有的 CLI 发出取消请求，并有界等待其 cleanup；
超过等待期限的执行保持 unconfirmed。有界等待结束时对尚未捕获句柄的子进程做最后一次
实际读取：观察到的迟到句柄作为恢复线索保留在索引；只有与 job 身份匹配的句柄进入结果中的
可信 start_handle，cleanup 仍保持 unconfirmed。不匹配的句柄不能用作获准的控制目标。
含糊提交与未知清理保留原状态供恢复；不能因为没有拿到最终报告就再派同一写工单。
健康进度留在工具等待里，主脑接收有意义的异常或批次概览。

保留 exact-cwd 锁。不同目录、worktree 或 read 模式都不证明实际写入、Git 公共状态、
adapter HOME/session store/cache、端口和数据库已经隔离。共享 HOME 并发未经确认时，
批次串行该资源；只有已有授权且完成对应能力验收的安排才能展开。不能为并行复制凭据、
扩大父目录或改 cwd 绕锁。批次并发限制只约束这个运行器，不冒充所有 CWR 实例的全局限额。

## 工单准备与增量读取

协调者只需写一份 order spec：共享背景加每项的任务、显式权限与确切范围。`prepare`
机械装配出每项工单文件和一份标准 manifest。它在启动任何东西之前校验显式权限、当前
route/workspace 授权与 continue 项的 session 绑定；run 项省略 route 时填入配置当前
`routing.default` 并在结果的 `defaulted_jobs` 里标明；已有输出一律拒绝覆盖。它不启动
任何 worker、不加载 adapter，batch 准入仍会逐项重验生成的每个 job——准备不缓存授权，
也不从类别或关键词推断权限。

工单与 manifest 以排他创建写入；在 POSIX 上使用 `0600`。Windows 的 Node mode 不表示
ACL 隐私，CWR 不据此声称已验证 owner-only 访问；需要由 operator 独立核对输出目录的 ACL。

```sh
node ENTRY prepare --config CONFIG --spec SPEC [--out DIR]
node ENTRY collect --config CONFIG --batch BATCH_ID
node ENTRY collect --config CONFIG --batch BATCH_ID --compact [--limit N] [--max-bytes N] [--cursor TOKEN]
node ENTRY collect --config CONFIG --batch BATCH_ID --job JOB_ID
```

以下是合成的最小 spec；实际内容由协调者从真实目标撰写，机械步骤不发明范围、权限或
验收条件。

```json
{
  "schema": "cwr.acp.order-spec/1",
  "shared": "Shared background every item needs.",
  "jobs": [
    {"id": "a", "verb": "run", "cwd": "/workspace/a", "permissions": "read",
     "task": "Map the importer call chain."}
  ]
}
```

每个结果一结算就写入批次的持久索引；`collect` 是该索引的只读视图——不等待、不加载
adapter、没有逐项唤醒，协调者在自己宿主的事等待间隙读取。索引损坏或不存在是明确错误，
不伪造通过。普通 `collect` 返回索引里完整的逐项结果，是兼容旧消费者的完整视图，不受
compact 预算约束；日常协调改用 `--compact`。

`--compact` 返回有界分页响应：整份响应（含 metadata、cursor、items 与结尾换行）受
UTF-8 字节预算硬限，默认 32 KiB、最低 8 KiB、最高 256 KiB；每页 item 上限默认 8、
最大 32。响应给出批次状态、总数、已捕获句柄数、已结算数、outstanding、`page`
（是否还有未展开页 `has_more`/`limited_by`）、`unresolved`（已记录 handle 的未结算项、`awaiting_handle`、
依赖 `waiting`、`blocked` 与真正 missing 分开）、`next_cursor` 与逐项结果。预算装不下某个富条目时，只缩减可选 detail
并显式列出 `omitted_fields`；最简 tier 仍保留来源、条件与检查计数。还有待返回结果时，
成功页至少包含一个可定位条目，否则明确报预算不足，避免无法推进的空页。完整 questions/artifacts/checks 不进入 compact 页：
`collect --job JOB_ID` 从索引展开单个结算结果的全部字段，`delivery --session UUID
--request REQUEST_ID` 展开按请求保存的 sidecar。

交付 block 可选 `decision_impacts`：每项只有有界 `target`、`finding`、`consequence` 与短
`evidence_refs`。旧报告仍有效；未知字段、超限文本/列表和格式错误都会明确拒绝。富与 reduced
compact 保留影响数量与 affected target；最简 tier 保留数量并显式标记 target 列表被省略。
定向展开单个 job：

```sh
node ENTRY collect --config CONFIG --batch BATCH_ID --impacts JOB_ID
```

响应保留 `worker_reported` 来源及确切 job/session/request identity；不会自动采纳结论、
写外部状态、改变权限或执行报告中的命令。有效的 `partial`、`needs_input` 报告也可展开
其中的发现；这不改变后继启动所需的 `ready` 条件。

cursor 是不透明 token，只声明本 batch、revision 与 offset，按 shape/canonical 编码/
batch/range/revision 严格校验；它不是真实性标签。`awaiting_handle` 可能是尚待准入或已在启动，不能据此认定没有 child；已记录 handle
也只证明锁已取得，不证明 prompt 已确认。相对 cursor 无变化时不重传任何旧结果；
新增结果是增量读取。同 ID 的更新（迟到结算或协调）会从最早变化项起重放其后各页，可能
包含未变化的后继，因此协调者按 id 和逐项 `rev` 合并，`rev:null` 的历史结果以响应
`revision` 判断新旧，而不是把 cursor
当作严格事件 delta 或零重复保证。

`--job` 是不受 compact 预算约束的完整展开，不能与 `--compact`、`--cursor`、`--limit` 或 `--max-bytes` 混用；混用会在读取索引前报参数错误。

逐项结果附带两个协调辅助字段：

- `delivery_excerpt`：worker 自述交付的有界逐字投影（`source:"worker_reported"`）：
  带截断标记的摘要、条件总数与未满足清单、检查计数与失败名单，以及按严重度排序的少量
  `name/state/detail` 短证据和前几条问题，另有显式省略计数。程序不做语义扩写；
  `worker_reported` 不等于已被验证，worker 自述与运行器观察保持分开。
- `next_actions`：运行器根据受信 runtime/句柄事实及明确归属的 worker 自述生成候选提示。
  `answer_questions` 使用自述的 needs_input 与 questions，不表示问题或 blocker 已独立证实。
  固定词表：`reconcile_session`、
  `inspect_receipt`、`consolidate_report`、`answer_questions`。continue 类提示只在
  session 已知、runtime 已终态、cleanup confirmed 且句柄匹配时出现。候选是供协调者
  判断的提示，不是命令，从不自动执行。

## 主脑如何验收一批结果

程序先检查身份、覆盖、重复、缺失与引用可定位性。batch/collect 不自动判定检查证据的新鲜度；
这需要在任务确认的 candidate identity 上另行核对 runner-observed 记录。语义判断仍有归属。复杂跨结果
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

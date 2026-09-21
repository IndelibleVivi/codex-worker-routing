# Dispatch 数据契约

中文 | [English](dispatch-data.md)

[使用指南](dispatch.md) · [User guide](dispatch.en.md)

Dispatch 投影既有的私有状态；它不拥有 worker 执行，也不创建第二套任务数据库。
投影为 `cwr.dispatch/1`，由 ACP binding、终态回执和明确的协调者注记重建。它从不
加载 adapter。

## 来源归属与存储

| 来源（相对于私有 `stateDir`） | 含义 |
| --- | --- |
| `bindings/<session>/binding.json` | 既有的责任身份与生命周期；可选 `active_turn` 记录一个已开始但尚无终态回执的请求。可选 `dispatch` 元数据绑定简短标题与类别。 |
| `bindings/<session>/receipts/<request>.json` | 运行结果、时间戳、清理与 adapter 报告的会话累计用量。additive 的 `observations` 保留结构化 runtime 代码。诊断文件被排除。 |
| `requests/<session>/<request>.order.txt` | JSON 信封 `cwr.dispatch.order/1`，含已提交工单的 `text`。为本机新增的 run/continue 命令保留；绝不加入导出。 |
| `dashboard-preferences.json` | 仅 `{theme, language, timeZone}` 展示偏好；本机认证 PUT，输入上限 1 KiB。 |
| `events/<session>/<event>.json` | 只追加的协调者注记 `cwr.dispatch.event/1`。 |

标题可选，至多 160 字符。类别为 `investigation`、`implementation`、`review`
或 `other`。续做保留已绑定的元数据；`dispatch.type`（`dispatched` 或
`continued`）是前瞻性的追踪标记，`dispatch.tracking_started_at` 记录一次
legacy 续做开始纳入追踪的时刻。既有的 `dispatch.type='dispatched'` binding
本就视为已追踪。legacy 记录不从输出推断类别。可用的 `CODEX_THREAD_ID` 与
`CODEX_SESSION_ID` 在 adapter 环境被清理前捕获。一个在 legacy 续做期间首次
被观察到的父会话带有 `observed_at`；它不是历史关联的证明。这些标识符保持本机。

工单留存是 additive 的：留存失败会以 `dispatch_warning` 记录在终态回执中，
投影报告一条覆盖度提示。既有 legacy 工单不从 transcript 重建。受管读取拒绝
目录 symlink、非普通文件或多重链接文件以及不安全的私有文件权限；它们从不修复
状态。Windows ACL 隐私仍由操作者负责。

使用默认的 run 还可留存 `receipt.selection`（`cwr.acp.selection/1`）：
`requested_route`、`actual_route`、`fallback`（route 名或 null）与包含 route 名、
安全可用性错误码的 `skipped_routes`。它记录启动前的选择，不增加执行次数；只有
选中的路线建立责任和 turn。该本地回执字段不进入 Dispatch 投影或 share 白名单，
不含环境变量值、原始错误或路径；显式 run、continue 与旧回执可没有该字段。

## 协调者事件

`record --session UUID --file FILE` 的输入是含以下字段的对象。未知字段被拒绝；
命令在记录时提供 `at`。

| 字段 | 契约 |
| --- | --- |
| `schema` | 必须恰为 `cwr.dispatch.event/1`。 |
| `event_id` | UUID，用作本次操作的幂等键。 |
| `session_id` | 既有集成 UUID，与 `--session` 一致。 |
| `kind` | `submitted`、`revision_requested`、`accepted`、`taken_over` 或 `note`。只有 `accepted`/`taken_over`/`revision_requested`/`submitted` 是复查证据。 |
| `request_id` | 可选的不透明请求标识，属于本 session 内某个回执。 |
| `reason` | 修正/接管时必填；否则缺席或为 null。 |
| `summary` | 可选纯文本，至多 1,000 字符。 |
| `evidence` | 至多 64 个 `{source, kind, summary}` 条目；summary 必填且至多 1,000 字符。 |
| `supersedes` | 可选，被更正的最近一条注记的 UUID，须在同一 session 内。 |

原因：`requirement_missed`、`validation_failed`、`scope_changed`、
`constraint_added`、`environment_blocked`、`uncertain`。证据来源为
`coordinator` 与 `worker`；证据类别为 `diff`、`test`、`manual`、`other`。
worker 的测试声明即使由协调者记录，也仍是 worker 报告。

用同一 event id 的等同重试是无操作，保留原始时间；在同一 id 下写入不同内容会
被拒绝。更正会追加一个新文件，并可能重新分类某事件。只有有效更正链的有效末端
才被计入。悬空、成环、时间倒置或分叉的更正链会被排除并给出警告；原始通过校验
的注记仍在详情中可见。未来事件从当前投影中排除。更正自其记录时间起生效，因此
可能把有效注记移入不同的观察窗口。

相互独立的事件 id 可以并发追加。更正会额外锁定其目标。并发冲突的写入者会收到
busy/conflict 错误，必须重读并重试同一操作 id；锁不会自动删除。注记写入失败
不得导致 worker 任务被重跑。

## 时间窗口与计数

`--since` 接受 `all`，一个正数后跟 `h`、`d`、`w` 或 `m`（30 天），一个 ISO
日期，或一个带时区的 ISO 时间戳。相对窗口是滚动时长；日历分桶使用选中的
`time_zone`（CLI 默认 UTC；浏览器默认设备时间）。边界为闭区间。回执属于其完成
时间戳所在的时段，缺失时回退到开始时间。未来回执被排除。

一个责任若在选中时段内被创建、产生回执、收到有效注记、开始一轮或关闭，则出现。
`worker_turns` 统计终态回执；`runtime_completed`、`failed`、`cancelled` 每个
责任在时段内对最新结果计数一次。之后开始但无终态回执的一轮尚无终态结果；仅有
一个打开的持久会话不改变完成度。它们不表示已验收。提交与修正统计时段内有效的
事件，而不是 session；续做从不被推断为返修。

验收是截至观察时间的最新有效决定。之后的一次提交、修正或记录的 runtime 轮次
会使先前的验收失效。`accepted` 与 `taken_over` 统计所展示责任的结果状态。其他
责任保持 `unverified`；缺少标记不是失败。投影描述已记录的轮次，不是活进程健康。

## 复查状态

统计是轻量、观察性的。runtime 事实自动从既有回执派生；没有任何注记的普通完成或
关闭是正常的，**不是**待办复查义务。一次派工后不需要任何盖章。每个被投影的责任
都带一个互斥的 `review_state`，投影的 `summary.review` 对象保存每个状态的计数
（全部存在，含零）。可接受值为：

| `review_state` | 含义 |
| --- | --- |
| `not_requested` | 普通默认：已追踪、有 runtime 事实，且当前没有明确的复查请求或决定（包括刻意关闭的工作）。 |
| `accepted` | 当前存在明确的 `accepted` 决定。 |
| `taken_over` | 当前存在明确的 `taken_over` 决定。 |
| `awaiting_review` | 一个明确的 `submitted` 事件请求复查，且其后没有决定将其取代。 |
| `changes_requested` | 一个明确的 `revision_requested` 成立，其后没有成功的返回轮次。 |
| `needs_attention` | 开放追踪工作的最新终态轮次失败或被取消，或其清理未确认。 |
| `no_receipt` | 已打开且已追踪，但尚无回执。不是进程正在运行的证明。 |
| `legacy_untracked` | 没有 Dispatch 追踪、也没有明确复查事件的 binding；安静的历史。 |

只有来源证据能推导该状态，来自对有效事件与终态轮次的单次按时间顺序的遍历。
一个明确的 `submitted`、`revision_requested`、`accepted` 或 `taken_over`
事件即使在一个早于元数据的 legacy binding 上也会建立追踪；单纯的 `note` 从不
建立追踪、请求复查或凭空产生决定。`accepted`/`taken_over` 设置当前决定；
`revision_requested` 设置 `changes_requested`；`submitted` 是一个明确的复查
请求，使既有决定失效并把记录置为 `awaiting_review`。之后一次成功（`completed`）
的轮次会把未决的修正或复查请求清回 `not_requested`，并使既有验收失效，因为返修
回来了而没有人再请求复查。之后一次失败/取消/未确认的轮次发生在开放工作上，会把
记录标为 `needs_attention`。runtime 的 `completed` 本身从不构成验收。带未来时间
的观察被忽略。没有追踪且没有明确复查事件的 legacy binding 是
`legacy_untracked`——历史上下文，绝非活动的复查工作。一次变为已追踪的 legacy
续做会记录 `tracking_started_at`，因此其更早的轮次绝不被追溯标为已复查。

`session.acceptance` 保持为兼容视图：当仍存在当前复查决定时即为该决定，否则为
`unverified`，由同一份证据派生，因此二者永不冲突。`session.review_state`、
`session.review`（`{state, tracked, decision, decision_at}`）与 `summary.review`
是供本机工具与复查兼容的接口；dashboard 高亮明确的修正/接管，而不给复查完整度打分。

### 可行动视图

`pending --config FILE` 是按需、只读的视图（`cwr.dispatch.pending/1`），仅含可行动
记录——`awaiting_review`、`changes_requested` 与 `needs_attention`——最新的在前。
它不是你必须清空的积压：没有明确未决请求的普通完成与关闭永不出现。它排除
`legacy_untracked` 历史与当前决定。每条记录只含 `session_id`、`review_state`、
`closed`、`status`、`title` 与 `updated_at`；它绝不包含工单文本、输出或文件系统路径。
`pending` 不加载 adapter。

### 可选返修快捷方式（`continue --revision-reason`）

`continue --revision-reason REASON` 是对一次真实修正的可选快捷方式：它在提示词之前
追加一条 `revision_requested` 事件（使用已记录的原因枚举，带内部 event UUID 与
null request id，因为尚无回执），因此返修无需单独 JSON 文件即可归属。普通续做
永不需要它，单纯的 `continue` 也从不记录修正。原因在普通续做 preflight 期间校验，
因此无效值不会启动 adapter 轮次。若注记无法记录，已授权任务仍恰好运行一次，中断
通过既有的 additive `dispatch_warning` 路径暴露（`REVIEW_NOT_RECORDED`，保留任何
先前警告）。对于刻意深入的复查，独立的 `record` 命令仍然可用；它在普通流程中不是必需的。

Home 是聚合视图：时段总计、执行/新责任活动、精确比例的状态条、route 分布、明确
的修正/接管与 runtime 注记。其活动图覆盖完整选中窗口，必要时合并相邻的选中时区
日期。新责任图统计窗口内的创建时间戳，可能少于头条中的活动责任数。单条经过位于
**Sessions**。route 计时是时段内有效回执配对的时长中位数；这些是未配对的任务，
因此该展示不是模型性能排名。

## 累计用量口径

adapter 用量是会话累计观察，而非每轮用量。快照 100 → 180 → 250 在全部时间内算作
250，绝不是 530。对于有界时段：

- 在时段内创建的会话从零开始。
- 更早的会话需要最后一条边界前回执的总量作为其基线。边界前 100 → 边界内 250
  贡献 150。
- 跨越边界的一轮无法拆分，使该会话的时段用量为未知，即使存在更早的基线。
- 递减/重置的计数器、未知基线或缺失的最终总量都会使用量变为未知。之后一个有效的
  累计快照可以桥接一个缺失的中间快照。
- input/output/thought 分量使用各自已知的端点差值；缺失的分量保持 null。已知零仍是零。
  未来快照被忽略。

`usage_total_sessions` 是本时段内有回执的所展示责任数；仅有事件的责任不进入该分母。
`usage_sessions` 是有可归属总量的责任数。`external_tokens` 汇总这些已知总量，若无
已知则为 null。覆盖度与警告伴随部分汇总。用量是 adapter 报告的工作量，不是 provider
身份、计费、性能或 Codex 额度节省的证据。不引入任何额度 API、A/B 工作量、模型评估器
或评分。

## 私有视图与公开导出

list/stats 投影允许本机 route 名、标题、不透明的父/session 标识符、事件摘要与
来源标注的证据。工单与有界的 worker 输出节选只有责任详情才加载。`session.workspace`
与 `workspaces` 暴露本机路径以供项目归组；原始诊断、adapter handle 与完整 transcript
不被投影。`pending` 使用同一白名单，并额外省略事件与证据文本。

`cwr.dispatch.share/1` 是独立白名单：归一化的日期、IANA 时区、聚合计数、已知 token
总量或 null、用量覆盖度、复查状态计数与警告数。它不含 route、标题、事件/证据文本、
工单、输出、路径或内部 id。它不携带主题、颜色、样式或 CSS 字段：渲染器调色板只从
`themes.mjs` 中有界的本机注册表选择（`getTheme(id)`，四个 id，未知 id 回退到 `sage`），
绝不从导出数据读取。每个主题从 `mascots.mjs` 选择一位伙伴；页眉使用 `mark.mjs` 的
固定线条标识；默认圆章保留 `brand.mjs` 的 Canon 猫。图稿与颜色值都不从数据接受。
其 SVG/PNG 渲染器使用固定的仓库地址、任务总量、运行结果与用量覆盖度，语言与主题为
独立参数，文件名为 `worker-routing-THEME-LANGUAGE-FORMAT-DATE.ext`。中文与英文导出
可独立选择。预览与下载使用同一冻结快照与时区，与列表筛选无关。图片说明的统计部分
使用同一白名单。导出是本机下载；不上传任何内容。

分享个性化与本统计载荷分离。`share-style.mjs` 只归一化明确的作者文本与具名展示选择：
口号（80 Unicode 码点）、可选单行 sharedBy（32）、numberStyle 与 ornament。草稿留在
浏览器内存中直到刷新，绝不进入回执、dashboard 偏好或 API 请求。渲染器对文本做 XML
转义；说明包含相同的作者文字。不使用任何任务、项目、route、路径或账号身份来填充
这些字段。

## 工作区与 runtime 证据

`session.workspace` 携带 `{id,name,kind,root,cwd,limitation}`；`kind` 为 `git`、
`folder` 或 `unknown`。本机 Git 公共目录身份会合并链接的 worktree；没有远程查询。
缺失的路径保留记录的文件夹；缺失的 cwd 形成一个未知桶。这是目录出处，不是保存的
Codex 项目身份。工作区探测按 reader 缓存。`activity` 携带 `date`、轮次计数、唯一
活动责任数、`session_ids` 与 `created_session_ids`；创建 id 仅在窗口内。日期下钻
消费这些确切的 id。

新回执可携带 `observations: {coverage,events,omitted}`。当前 acpx 0.15.1 只暴露
带类型的 runtime 错误码（`code`、`detail_code`、`retryable`），附来源、请求与 UTC
时间；coverage 为 `runtime_codes_only` 或 `none`。没有 provider HTTP 状态或重试事件
可用。数值型 JSON-RPC 码与散文都不会被提升为 HTTP 429。不支持的 HTTP/重试字段从
归一化中排除。快照 `runtime_notes` 统计窗口内的观察与会话；其零值
`http_429_count` 是能力限制，绝不是没有限流的证据。详情保留完整的本机经过。观察
收集是同步的、每轮有界，并与既有终态回执一起保存；它不调用 provider、不按事件
写入、不推断复查，也不安排重试工作。

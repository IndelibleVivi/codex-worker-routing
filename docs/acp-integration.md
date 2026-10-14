# 可选 ACP 执行通道

[English](acp-integration.en.md) | 中文

状态：可选接入已实现；`acpx@0.15.1` 的公开 runtime API 已通过合成 ACP server
联调。真实 adapter、模型、provider、账号和本机上下文边界仍由各 operator 单独验收。
共同调度 skill 先尊重 operator 已选的执行通道；原生工具、SessionStart hook 和 installer 不变。

## 这次改变什么

主 Codex 继续负责目标、产品判断、整合与验收。仓库不规定 native 与 ACP 的
优先级；临时的 provider/model 偏好留在 Git 外的 operator config。当 operator 的日常默认或当前任务
选择已登记的外部 ACP route 时，`acp-worker` skill 可以调用
`integrations/acpx/src/cli.mjs`，通过 `acpx/runtime` 将一整块责任交给独立 coding agent。

同样的“调查→实施→自测→局部返修”责任可以跨多轮进行。`run` 建立 session；
`continue` 使用保存在私有目录中的原 handle；两次命令之间释放 adapter 进程连接，保留逻辑会话。
需要 adapter 支持恢复旧会话。恢复失败时停止，不创建替代会话、不隐式重派。

不引入新的 planner/tester/reviewer 流水线，不封装原生工具，不建第二套计划系统。
少量 binding/receipt JSON 只绑定已有 acpx 会话和执行证据，不复制它的会话实现。

## 责任边界：ACP 通道不翻译 provider 协议

cwr-acp 与 acpx 负责 session、生命周期、权限应答与执行证据；它们不翻译 provider 的
HTTP wire format，也不决定 worker 用哪个模型客户端。route 的 adapter 与隔离
worker profile 才决定实际运行什么客户端/运行时，以及它怎样到达 provider。

因此一条 route 或一个已列出的 model 能初始化，不等于真实推理会成功：Codex 自定义
provider 当前按 Responses wire format 发请求，一个只讲 `/chat/completions` 的上游
需要中间有协议转换层。这个边界、`codex-acp` 式拓扑的例子、逐层验证阶梯与排错表见
[ACP 通道与 provider 协议边界](acp-provider-protocols.md)。该文档只描述边界，
不构成 Worker Routing 的核心契约，也不规定 provider 或 fallback 策略。

## 实现选择

选择公开 `acpx/runtime` API，固定顶层依赖为 `0.15.1`。调用 `ensureSession`、
`startTurn`、`getStatus`、`close` 与公开 handle decoder，不读取私有模块、不解析 ANSI 输出。
原生路径保持直接调用宿主工具，避免不同后端取消/关闭/续做语义被强行等同。

cwr-acp 使用阻塞 CLI。它没有独立后台服务；没有完成后自动唤醒主 Codex 的桥；也不提供
“终端关闭后继续运行”的承诺。主机 shell tool 的 yield/wait 仍按宿主规则使用。
每个 exact cwd 的 ACP 操作保守串行；不同工作树仅在写入面与共享资源不重叠时可独立执行。
普通 busy 请求被拒绝，不另外重造 acpx 队列。

## 文件

0.3 增加共同 worker contract 的实际装配、可选交付 sidecar、有限 batch 与任务范围
验收辅助。操作与证据边界见 [Worker 交付与有限批次](worker-delivery.md)。普通单责任
调用继续使用下方原命令，不必加载报告 schema 或 Dispatch。历史验收保留各自日期与版本。

- `src/cli.mjs`：命令、私有环境装配、互斥、取消控制与退出码。
- `src/config.mjs`：显式命名路线、参数与授权校验、独立 worker home。
- `src/engine.mjs`：公开 runtime 接入、同会话校验、结果与清理。
- `src/state.mjs`：少量私有 binding/receipt、原子写、路径与文件类型检查。
- `src/delivery.mjs`：有界交付收集和身份校验；报告声明与 runtime 事实分开。
- `src/batch.mjs`：有限独立 CLI 子进程、批次本地资源准入与实际结果覆盖。
- `src/verify.mjs`：协调者确认的 argv 检查、任务环境、预算和证据新鲜度；不执行报告命令。
- `test/*.test.mjs`：可无依赖运行的接入层测试；runtime 使用明确标记的合约替身。
- `test/real-acpx.integration.mjs`：实际加载 acpx 包并启动合成 ACP 子进程的联调测试。
- `test/fixture-acp-agent.mjs`：无模型、无账号、无网络的 ACP 夹具。
- `plugins/worker-routing/skills/acp-worker/SKILL.md`：外部路线入口；operator 的常设 ACP 选择或当前任务选择均适用。

## 安装与一次性设置

在 canonical source checkout 中：

```sh
cd integrations/acpx
npm ci --ignore-scripts
npm run check
npm run test:acpx
node src/cli.mjs --help
```

目标系统为 macOS、Linux，以及本机固定卷上的 Windows。Node.js 至少 22.13。
仓库保留已验证的 `package-lock.json`；安装使用 `npm ci` 复现该依赖图。
任何 top-level acpx 版本偏离 0.15.1 都会被入口拒绝；升级需要重新跑联调。

配置放在 Git 外，文件权限 0600。可参考 `examples/routes.example.json`。
例子默认 disabled，所有路径均为合成占位。必须替换为真实绝对路径；不在运行中自动安装 CLI。
通过原 plugin-creator 正常更新/重装 worker-routing，登记 canonical CLI 与 config 路径。
不要改 plugin cache，不给自动 hook 添新职责。

一条 route 包含：

- 已安装 adapter 的 `argv` 数组，例如某个独立 Kimi Code 实例的 `kimi acp`。
- 独立 `workerHome`，与主用户 HOME 分离；`contextRevision` 标识已审核的工程配置。
- 明确授权的 `workspaces`；cwd 必须精确匹配其中一个目录。
- `passEnv` 列出主动允许传入的凭据或代理变量名称。默认空，不从原账户目录复制文件。
- `maxPermissions` 为 `read` 或 `full`；`sessionOptions.model` 可选。

先建立干净的工程 profile，再按原 CLI 支持的方式在该 profile 中认证。使用个人 persona
profile、主会话记忆或私人 hooks 的实例不直接当临时 worker。配置存在不等于已经证明输入隔离；
需本机采样验证。`contextRevision` 需在配置/工具/指令注入边界变化后更新。

## Windows 支持边界

Windows 是第三类受支持平台，但只声明已实现且可回归的能力。它不是把 POSIX 假设换一个
`process.platform` 判断：入口在读取配置前先做平台白名单，然后只依赖 Node 实际暴露的能力。

- 入口必须是真实文件且扩展名为 `.exe`、`.com`、`.cmd`、`.bat`；`.ps1`、`.sh` 与无扩展名
  脚本被拒绝。`.cmd`/`.bat` 交由 acpx 自身的 `%COMSPEC%` shim 策略启动，cwr-acp 不引入
  `shell:true` 回退，也不接受字符串形式的命令。
- 只支持本地卷：`stateDir`、`workerHome`、`workspaces`、选中的 `cwd`、resolved `argv[0]`
  与 config 文件路径先在词法层拒绝 UNC（`\\server\share`）、设备路径（`\\?\`、`\\.\`）
  和网络共享形式，再对 canonicalize/`realpath` 的最终目标重复同一次拒绝。config 文件路径
  先按 cwd 解析成绝对路径（相对路径行为不变），再在 `realpath` 之前完成这层拒绝，因此显式的
  UNC/设备 config 根不会被 `realpath` 触碰；它只 canonicalize 所在目录，文件名本身仍交给
  symlink 检查。因此一个本地形状的输入如果在解析后落到这些根（例如 symlink/junction 指向
  UNC），也会在真正使用前被拒绝。映射到网络位置的盘符在本层无法识别，需要操作者自行保证。
- worker 环境把 `HOME`/`USERPROFILE`/`TEMP`/`TMP`/`APPDATA`/`LOCALAPPDATA` 重定向到独立
  worker home，并从操作者环境保留 `COMSPEC`、`PATHEXT`、`SystemRoot`/`windir`（缺失时用标准
  值），因为启动子进程与 acpx 解析命令需要它们；这些变量来自环境而非 route 配置，不含凭据。
- passEnv 的环境名在 Windows 上按大小写不敏感校验与保留，`home`、`userprofile`、`path`、
  `comspec`、`appdata` 等写法同样被拒绝，也不会覆盖 worker home 的 `USERPROFILE`。
- Windows 没有 POSIX mode 位，Node 报告的是 0666/0444 这类合成值。cwr-acp 在 Windows 上不读取
  也不验证 NTFS ACL，也不检查 stateDir/workerHome 是否位于用户 profile 之下；它仍然拒绝
  symlink/junction 与 hardlink，并保留“打开后再比较文件身份”的检查。因此操作者必须自行把私有
  config、stateDir 与 workerHome 放在受 ACL 控制的当前用户位置（或为其建立等效 ACL）；
  cwr-acp 不实现也不声称提供这项保证，也不会因位置不合规而拒绝启动。这些路径还必须位于本地卷
  （见上）：映射到网络位置的盘符在本层无法识别，只能由操作者保证。
- Node 在 Windows 上会让 path `lstat` 的 `dev` 为 0，而同一文件的 open-handle stat 返回真实
  volume id。cwr-acp 始终要求两侧 file id（`ino`）一致；只有两侧都报告非零 `dev` 时才再比较
  volume id。这样保留打开后的文件身份检查，不会把每个正常 Windows 文件误判为被替换。
- 目录 fsync 在 Windows 上不可用（Node 未暴露可靠的目录句柄 fsync）。`atomicJSON` 仍使用同目录
  临时文件、文件 fsync 与 atomic rename，但不再声称目录级持久化屏障；`close` 仍要求
  cleanup confirmed。
- 只有 SIGINT（Ctrl+C）是 Windows 上的本机信号；SIGTERM 不产生本机事件。取消仍可通过
  `cancel` 的本机控制邮箱完成。
- 受管祖先遍历按“相对自身 root”展开，因此盘符与 UNC 前缀不会被重复拼接；`status`/`cancel`/
  `close` 在 Windows 上也能对已有 state 目录使用 `create:false`。
- CI 在 `windows-latest` 上执行与 macOS/Linux 相同的 `npm ci --ignore-scripts`、`npm run check`
  与 `npm run test:acpx`，真实 acpx 合成夹具套件在其中运行；Windows 专属回归不使用 skip 计数
  作为证据。

## 本地 Dispatch 投影

`stats` 提供文字 / JSON 统计，`dashboard` 打开 loopback 面板（业务数据只读，三个本地展示偏好可保存），`record` 按需追加
来源明确的送验、修正、接受和接管事件，`pending` 按需列出仍可行动的复查记录。
runtime receipts 仍是执行真源，协作事件不修改回执中的 `task_acceptance: unverified`。
统计是轻量、观察性的：runtime 事实自动从既有回执派生，普通完成或正常关闭**不需要**
任何标注，也不是待办复查义务。新派工可提供 title/category；可用的主会话 ID 在环境
清理前仅留存于本机 private state，不传入 worker。新增 run / continue 工单也留在
private state，按需供本地回放；它们不进入公开分享。读取历史与协作事件不要求 adapter、
worker home 或原 workspace 仍然可用。项目入口按 binding.cwd 查本机 Git / 文件夹，
目录不可用时显示保存的路径与限制；不声称 Codex project 身份。日期按选中时区分组；
CLI 可传 `stats --time-zone IANA_ZONE`。当前 acpx 只暴露 runtime 错误码，不能确认
provider HTTP 429 或内部重试，详情提供同源结构化经过。这些命令不加载 adapter；`stats`、
`pending` 只读本机 private state，`record` 按需追加协作事件，不改写 runtime receipt。
投影为每个责任派生互斥的 `review_state`（`summary.review`
给出各状态计数）；未登记的 legacy 责任为 `legacy_untracked`，只是安静的历史记录。
完整操作见[Dispatch](dispatch.md)，数据语义见[数据契约](dispatch-data.zh-CN.md)。

## 默认与备用

一个默认小工就能完整使用。把下面的可选片段加入现有 Git 外配置的顶层；
`default` 引用 `routes` 里已登记的名字，`fallbacks` 可省略或留空：

```json
{
  "routing": { "default": "kimi-worker", "fallbacks": [] }
}
```

正常 `run` 省略 `--route`，入口在同一次调用里读取当前默认，不需要先查询、扫描模型
或补记录。旧配置继续支持显式 `--route NAME`；显式选择只用该路线，不自动走备用。
名字、模型、渠道、凭据和临时偏好都留在本机。可选的一句使用经验放在已有 operator
说明里即可，不需要小工目录、特长 schema 或套餐到期日。

`fallbacks` 是 operator 对这些具体渠道、任务数据与费用的预授权，不是历史使用列表。
自动选择只发生在 adapter 启动、runtime import 和 worker home/state 写入之前：默认
入口缺失/不可启动，或缺少 `passEnv` 声明的必要环境凭据时，按顺序尝试明确备用，每条
最多一次。权限、workspace、`enabled: false`、不安全配置、锁冲突、工单错误、依赖错误
与任何启动后的失败都不能触发这项自动切换。选中的路线仍须通过原有所有校验。
跳过的候选不生成虚假的责任或执行轮次；本地回执给出实际选择与有界的跳过原因，
不保存环境变量的值，也不把这些私有信息放进 aggregate share。

换默认只改 `routing.default`；备用列表也在同一处更新。policy 变化不会改变既有
session 的 execution identity，`continue` 仍回原 worker。若明确要求“不再用旧渠道”，
同时将旧 route 的 `enabled` 设为 `false`，后续 run/continue 都会拒绝；这不会自动
终止已在运行的 turn，需通过原 session 协调停止。status/cancel/close 保留恢复能力。
无需为换默认改 skill、plugin cache 或复制一份 SessionStart 偏好。Native 的默认选择
仍由宿主和已有本机授权说明管理，不被这个 ACP 配置包装执行。

初始化或执行开始后失败，主 agent 先核对原 receipt/status、确认 writer 停止并检查
已有成果，再按当前授权把剩余责任交给备用；状态不明不重发写工单。质量问题仍走原
worker 返修。该主任务内复用未变化的已知故障，不反复试探同一坏渠道；无备用时，任务
允许就由主线程直接完成。runtime 错误码不能证明套餐到期、余额不足或 HTTP 429。

未选择的旧 route 缺少入口、环境凭据或 workspace，不阻止可用的默认路线；配置的
安全边界仍统一校验，实际选择的 cwd 必须存在并精确匹配该路线的 workspace 白名单。

## 日常用法

安装目录变量只用于展示；实际使用登记好的绝对路径。

```sh
ENTRY=/absolute/canonical/repo/integrations/acpx/src/cli.mjs
CONFIG=/absolute/private/routes.json

# 配置 routing.default 后；旧配置或明确指定渠道时加 --route NAME
node "$ENTRY" run --config "$CONFIG" \
  --cwd /absolute/approved/worktree --file /absolute/work-order.md --permissions read

# 从回执取 session_id；给同一个 worker 追加条件
node "$ENTRY" continue --config "$CONFIG" --session UUID \
  --file /absolute/increment.md --permissions read

# 明确返修（可选快捷方式）：记录本次修正原因再续做；普通续做无需任何标注
node "$ENTRY" continue --config "$CONFIG" --session UUID \
  --file /absolute/rework-order.md --permissions read --revision-reason requirement_missed

# 只有路线和当前任务都授权时使用；此项会批准所有 ACP 权限请求
node "$ENTRY" continue --config "$CONFIG" --session UUID \
  --file /absolute/implementation-order.md --permissions full

node "$ENTRY" status --config "$CONFIG" --session UUID
node "$ENTRY" cancel --config "$CONFIG" --session UUID

# 按需查看仍可行动的复查记录（只读；不含 legacy 历史，也不加载 adapter）
node "$ENTRY" pending --config "$CONFIG"

# 正常关闭即普通生命周期收尾，不需要标注，也不表示已验收
node "$ENTRY" close --config "$CONFIG" --session UUID

# 确有需要留存复查证据时，才用独立 record 追加一个明确事件
node "$ENTRY" record --config "$CONFIG" --session UUID --file /absolute/event.json
```

`cancel` 写入当前 operation nonce 对应的取消请求，运行进程每 200ms 检查本地控制邮箱。
它是本地控制实现，不要求主模型反复读取 worker 状态。回执中 `stopped:false` 明确表示
只确认发出请求；要等执行命令返回终态与清理结果。Ctrl+C 和 SIGTERM 也请求合作取消。
`close` 关闭工作责任，保留历史；活跃或清理未确认时拒绝关闭。
`close` 是普通生命周期收尾，不需要任何验收标注。`continue --revision-reason` 是可选的
返修快捷方式：reason 在普通 preflight 校验，写入失败不会阻塞已授权任务，只会通过既有的
additive `dispatch_warning` 暴露，不会重复调用模型。日常只需 run/continue/close，
无需在每次派工后补记任何东西。

退出码：0 为 runtime 本轮完成且清理已确认；1 为执行失败或清理未确认；130 为取消；
2 为本地配置/前置条件/控制错误。即使退出 0，`task_acceptance` 也始终是 `unverified`，
须主 Codex 检查 diff、关键不变量与测试证据。

## 状态、上下文与安全边界

stateDir 保存 binding/回执、Dispatch 的本地协作事件与工单，三个展示偏好（`dashboard-preferences.json`），以及 acpx 的私有 store。目录 0700、文件 0600；写入使用
同目录临时文件、fsync 和 atomic rename。输入拒绝 symlink、hardlink、FIFO 等特殊文件。
workerHome/stateDir 根可使用系统祖先目录的规范路径，但根自身和受管后代不接受 symlink。
目录 0700/文件 0600 的断言只在暴露 POSIX mode 的平台成立；Windows 上 mode 不是隐私证据，
隐私边界见上节。
这些检查降低意外链接/竞争造成的破坏，不构成抵御同 UID 恶意进程的完整文件系统隔离。

CLI 清理自己的环境后才 import acpx；保留 PATH 与固定 locale，重设 HOME/XDG/CODEX_HOME/
CLAUDE_CONFIG_DIR/TMPDIR，只额外传入 passEnv 明示的变量。宿主 shell、Codex 环境不被改变。
Windows 上另外重设 TEMP/TMP/APPDATA/LOCALAPPDATA，并保留 COMSPEC/PATHEXT/SystemRoot。
HOME 分离不限制绝对路径访问、Keychain 或原 CLI 自己的原生工具。
项目 AGENTS、agent 内置配置与本地工具也必须按真实 profile 验收。

每次 `run` 和 `continue` 都必须显式提供 `--permissions read|full`。省略会在 adapter 启动、
工单提交与私有 state 写入之前以 `PERMISSIONS_REQUIRED` 拒绝；不会默认为 read，也不继承上一轮。
`--category implementation` 只是 metadata，不授予权限。协调者根据当前已有授权填入参数，
调查转实施时同时更新工单和权限，无需为已经批准的工作再询问用户。status/cancel/close、
stats/dashboard/record/pending 不要求这个参数。

`--permissions` 选择的是 cwr-acp 对 ACP permission request 的应答策略，不是文件系统边界：
`read` 使用 approve-reads + 非交互 deny，`full` 使用 approve-all（可含执行/网络请求）。
两者都只约束真正到达 adapter 权限流程的请求。adapter 可能暴露不产生 ACP permission request
的操作，实际使用中已观察到 `read` 下的外部 worker 直接改写文件而未被拒绝；所以 `read` 的
“不得改动文件”只是工单授权措辞，不是强制。要获得确定性的文件系统只读行为，必须在本机
独立配置 host/OS sandbox 或使用一次性的只读环境；cwr-acp 不提供该边界，也不宣称进程级
网络隔离，也不声称每个 adapter 的所有原生工具都会走同一权限机制。

续做核对版本化的 `executionIdentity`、固定 cwd、保存的 acpxRecordId/acpSessionId、argv 和
persistent handle。`cwr.acp.execution-identity/1` 包含 route、规范化入口及其 hash、参数、
workerHome、环境声明、contextRevision 与明确的 model 选择；不包含 workspace 列表、
权限上限或 timeoutMs。每次续做仍重新检查 route enabled、绑定 cwd 的当前 allowlist 资格
与本轮权限上限。增加或重排无关 workspace、改变任务预算不会使新身份失效，撤回 cwd
或 full 许可则立即阻止相应续做。入口 hash 不涵盖 CLI 传递依赖和任意 profile 文件；
profile 修改须更新 revision。

旧 binding 只有 `routeFingerprint`，缺少可以证明原身份的分项信息。只有原完整指纹算法
仍匹配且本轮授权通过时，才在持锁后迁移到新身份；不匹配以 `ROUTE_CHANGED` 停止，不猜测
是不是只变了 allowlist，也不直接重写 hash。不要为迁移恢复已撤回的许可；保留旧会话供
status/cancel/close 恢复，检查已有成果后重新授权剩余责任。历史回执保持原样。
明确指定 model 时，开工前必须与 adapter 当前 advertised model 一致，否则不发送工单。
这一检查不认证真正的上游模型；provider identity 仍标记为未验证。
凭据值不落盘，不作为身份真实性证明。记录中的 model/usage 都只是 adapter 报告。

主会话不接收 thought 与原始 tool payload；stdout 输出最多 8192 UTF-16 code units 的正文
尾部节选及证据位置。完整历史由 acpx 保存。大输出会标记截断；超时/stream error 不被最终
success 文字掩盖。原始 agent 错误文本不直接写进结构化错误回执；需要诊断时写入单独的私有 diagnostic 文件，
回执只给出路径。该文件可能含 provider 敏感内容，分享前必须检查。

workspace lock 只按 exact cwd 协调共享本 stateDir 的 ACP 命令；不同 cwd 的重叠写入面
不会自动冲突。跨项目工单须列明执行 cwd、额外 read roots、允许的 write roots 与共享资源；
这些声明不改变 host 能力。缺少权限或工具时停止受阻操作、返回已有成果和具体缺口，由
协调者在原授权内修环境、缩小或拆分剩余责任，不扩大父目录 allowlist 或绕过拒绝。
它看不到 native worker、其他安装、
数据库、端口、服务和其他共享资源。主机仍须遵守一个重叠写入面一个 writer，或用独立
worktree；worktree 本身也不隔离上述非文件资源。

## 崩溃与失败

初始化和 prompt 提交各有 `min(route.timeoutMs, 30000)` 毫秒 setup deadline；分别报告
`INIT_TIMEOUT` 与 `PROMPT_SETUP_TIMEOUT`。公共 runtime 的 `promptStarted` 确认传输已接收
prompt 后，才开始 `route.timeoutMs` 的任务预算；预算到 canonical `result` 为止，包含
runtime finalization。连接建立所用时间不消耗任务预算。回执的 `budget` 保留
`setup_ms`、`task_ms`、`prompt_started_at`（未观察到确认时为 null，不能据此断言未发送）。

CWR 通过公开 `startTurn({timeoutMs: 0})` 关闭所固定 acpx 版本内部的 prompt RPC timer，
由自身 deadline 管理任务，避免 acpx 把“已有 progress 但没有 RPC final”的内部超时恢复成
`end_turn`。这个 0 值语义依赖当前固定版本，必须以真实包和合成 adapter 联调守住，升级
依赖时重新验证。产品代码不导入 acpx 私有模块。

超时或 operator 取消先确定本轮失败/取消，再执行清理；迟到的 completed/end_turn 不能
覆盖它。`TURN_TIMEOUT` 不会返回退出码 0，partial output 继续保存。事件流排空、取消
应答、执行结算和连接关闭各有默认 8 秒收尾上限；它们不延长已经结束的任务预算。
清理结果单独记录，unknown/unconfirmed 不能被成功文本抹掉。历史回执不重算。

初始化取消不代表底层握手已退出；在接口无法确认清理时会保留锁和不确定状态。
启动后没有自动重试或 native/ACP 静默 fallback；启动前的有限选择见[默认与备用](#默认与备用)。提交后丢失回执时，先查 status 与已保存 receipt。
不要靠再次发送同一写工单来“确认”。正常停止和代码失败会尝试关闭 ACP-owned 连接；
清理失败、初始化未决、仍观测到活跃 adapter 或进程直接死亡时保留锁。

status 的 `owner_process_present` 仅表示 PID 探针命中，不是该 PID 身份或模型健康证明。
过期锁不自动回收，避免 PID 重用/遗留 writer 导致双写。

异常恢复由本机操作者核对 owner.json、session receipt、当前 adapter 进程和实际 diff。
确认旧 writer 已终止后，才移除对应 operation 锁和 workspace 锁；保留 binding 和 acpx store。
cwr-acp 未实现自动恢复器，尤其不能将一个 dead PID 视为所有后代已退出的证明。
清理只确认 acpx-owned 进程/连接；不保证恶意 daemon 化或脱离宿主的任意后代已被终止。

## 验收门

### Delivery 0.3.0 分层验收（2026-10-13）

源码 `18a62f9` 的 [CI](https://github.com/IndelibleVivi/codex-worker-routing/actions/runs/38415570521)
五个 jobs 全通过：Ubuntu/macOS 的 check 为 337 pass + 4 Windows-only skip，
Windows 为 340 pass + 1 POSIX-only helper skip；真实 acpx 合成联调前两平台
14 pass + 2 Windows-only skip，Windows 16 pass。acpx 仍固定 0.15.1，无新增生产依赖。

本机 plugin 正式安装并启用 0.3.0，15 个包内文件与 canonical source 逐字节一致。
新的独立主 root 从自然“派小弟”请求开始，实际读取该安装版短入口，首次选择当前配置
默认 ACP 并显式 full；没有命令模板或预置 session，也没有加载 Dispatch/recovery/swarm。
worker 完成修改、原测试保持逐字不变、独立检查通过，责任关闭且历史保留。

其他受控样本覆盖自修/已正确输入、精确问题后的同 session 增量、能力缺失停止、
协调者修改 policy 后交还、两个真实 adapter session 的独立取消和重启续接、三项有限
调查及平级归并。归并保留重复身份、版本差异、反证与不可访问来源的 unknown。
报告缺身份时只补交付，新 request 保留原失败记录；runtime 完成不改成工程验收。

这些事实不证明所有模型、provider 或权限环境都同样可靠。共享 HOME 能力只覆盖对应
adapter/profile 的受控场景；0.2 对照也能完成小型修复，因此不宣称性能或成功率提升。
外层反馈保留为 test-only 实验，尚无证据将其晋升默认。

2026-10-13 的 Recovery 0.2.0 源码在 macOS 通过完整 `npm run check`（280 项，
276 pass、4 项 Windows-only skip）；随后只调整合成夹具隔离和失败收尾，夹具全部
4 项检查通过。最终完整 `npm run test:acpx` 为 12 项（10 pass、2 项 Windows-only skip），
涵盖正常完成、progress 无 final、取消后 end_turn，以及 runtime 2 秒内部预算与 CWR
6 秒任务预算的区分对照。它验证固定 acpx 的公开 API 行为，不证明真实 provider 健康、
旧回执正确或当前聊天已加载新 skill；跨平台状态以对应提交 CI 为准。

同日，真实 operator 配置的 ACP 责任先以显式 `--permissions read` 完成只读检查，再在
同一 session 以显式 `--permissions full` 续做公开文档更新。两轮均返回完整最终报告，
runtime 为 `completed/end_turn`，cleanup 为 `confirmed`；协调方已核对 runtime/cleanup
并检查文档 diff、双语一致性、相对链接与 `git diff --check`。该本机验收只适用于此次
已配置通道：permission-response policy 不是 OS sandbox，也不证明其他 adapter/provider/
账号行为、provider 身份或普遍可靠性。新 CLI root 已读取安装版 0.2.0 的调度说明并正确
续做原 ACP 责任；验收后正常 close，状态为 idle/closed，历史保留。

2026-09-21 的默认与备用源码更新在 macOS 通过 256 项 integration 检查（252 pass、
4 项 Windows-only skip），以及真实 acpx + synthetic ACP server 的 8 项检查
（6 pass、2 项 Windows-only skip）。覆盖默认省略、显式选择、有限备用、旧 session
兼容、撤回许可与启动后不重派；不代表 installed plugin、真实 provider 或本机默认
配置已更新。跨平台结果以对应提交的 CI 为准。

同日另行完成本机安装与 live route 验收：正式重装后的 plugin 文件与 canonical source
一致；不带 `--route` 的真实派工使用默认渠道并完成。在独立私有候选配置中模拟默认
入口缺失后，真实派工只选择已授权备用并完成，回执保留 `BAD_EXECUTABLE` 跳过原因。
两轮 cleanup 均 confirmed，会话正常关闭；未故障注入日常配置。这只证明所验收渠道的
此次默认/备用路径，不外推到其他 provider、套餐状态或启动后的自动恢复。

2026-09-20 的 Dispatch v3 项目入口与展示整合 在 canonical macOS 主机重新运行
`npm ci --ignore-scripts`、`npm run check` 与 `npm run test:acpx`：接入层检查共
223 项，219 pass、4 项 Windows-only skip；真实 acpx + synthetic ACP server
联调共 6 项，4 pass、2 项 Windows-only skip。它们覆盖本地状态/路径边界、
同会话续做、权限握手、取消和清理，以及 Dispatch 的计量、主动复盘状态、可选
返修注记失败不阻断、持锁后 binding 复查、loopback/privacy、双语分享白名单、四套动物主题、跨时区分桶、真实目录归组与偏好持久化。
Dashboard 另在桌面和窄屏真实浏览器验证统计首页、筛选、详情、主题切换、键盘焦点，
以及四主题 × 双语 × 横竖版 × SVG/PNG 的 32 种实际下载组合。

联调使用无模型、无账号、无网络的合成 adapter 进程，不能证明真实 provider 的
身份、计费或质量。合成取消用例等待 audit 文件证明 prompt 已到达 adapter，再
发出 cancel，并断言 `cancelled`、`cleanup=confirmed` 与后续 `idle`。
此次没有修改 Python/native hook source，未重跑原生 context probe；此前的
25 项 Python regression 与真实 root/child 输入边界证据属于各自历史验收。

Windows 专属用例（盘符根 `create:false`、junction 祖先拒绝、UNC stateDir 拒绝、显式 UNC/设备
config 文件路径在 `realpath` 之前被拒绝、adapter 环境断言、`.cmd` batch-shim 的一次完整 `run`）
只在 `windows-latest` 上执行并断言，不以其他平台的 skip 作为证据；junction 用例没有内建 skip
分支，无法创建 junction 的环境直接失败而不是跳过。POSIX 上的 mode 断言同样不会被当作
Windows ACL 隐私的证据。

此前本机 dogfood 使用一个已登记外部 route 完成了当前仓库的 review 修复，并在同一 ACP session
续做证据校正与权限措辞返修；各轮 cleanup 均 confirmed，私有主会话 marker 检索为 0。
其中一次 `read` continuation 仍直接改写了文档，这项反例正是上文不能把 permission-response
policy 当成文件系统边界的实证。opt-in Python/native probe 未在本交付中重跑；原生源码未改，
现有 Python regression 通过，但这些事实不冒充新的 native-process 验收。

CI：仓库新增 `.github/workflows/ci.yml`，Ubuntu 上跑 Python 原生测试，Ubuntu 与 macOS 上跑
`npm ci --ignore-scripts`、ACP 检查与真实合成 acpx 联调；加入 Windows 后同一套 ACP 步骤也在
`windows-latest` 上运行，并由 Windows PowerShell 5.1 实际执行 native picker 指南采用的
`UTF8Encoding($false)` 写法，断言输出没有 UTF-8 BOM 且仍可解析为 JSON。无 secrets、无 live
provider 调用。本次交付在 macOS 主机上编写与
自测，未在本机 Windows 主机运行；Windows 结论以目标 commit 或 PR 的 `windows-latest` checks
为准，本地结果不证明任一 GitHub run 已绿。真实 Windows adapter/model 验收仍需 operator 按
exact route 单独完成。

纳入日常委派前，operator 仍需按 exact adapter/profile 验证输入、provider/model 与权限边界；
需要强制只读时必须另配 host/OS sandbox 或一次性只读环境。一个 route 的验收不能外推到
其他 adapter，也不改变原生通道。

## 上游依据

查阅于 2026-09-15，针对 `openclaw/acpx` 的 `v0.15.1` 公共源码接口：

- `src/runtime/public/contract.ts`：startTurn 的 events/result、权限与 lifecycle 接口。
- `src/runtime.ts`：公开 runtime/store 与 handle decoder exports。
- `src/runtime/engine/manager.ts`：persistent 恢复、保存 handle、连接清理与保留会话的边界。
- `src/runtime/engine/reuse-policy.ts`：session 复用条件。
- `src/acp/client-process.ts`：argv identity。

源码地址形式为 `https://github.com/openclaw/acpx/blob/v0.15.1/<path>`。
本实现调用依赖的公共 API，没有复制上游引擎代码。acpx 依赖保留其自身许可；新增
integrations/plugins 代码沿用根 `LICENSING.md` 的 SUL-1.0，本文沿用其文档许可。

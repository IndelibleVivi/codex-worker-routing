# 可选 ACP 执行通道 · v0.1

[English](acp-integration.en.md) | 中文

状态：可选接入已实现；`acpx@0.15.1` 的公开 runtime API 已通过合成 ACP server
联调。真实 adapter、模型、provider、账号和本机上下文边界仍由各 operator 单独验收。
现有原生 skill、协作工具说明、SessionStart hook 和 installer 都不修改。

## 这次改变什么

主 Codex 继续负责目标、产品判断、整合与验收。仓库不规定 native 与 ACP 的
优先级；临时的 provider/model 偏好留在 Git 外的 operator config。当任务明确
选择已登记的外部 ACP route 时，新增 `acp-worker` skill 可以调用
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

v0.1 使用阻塞 CLI。它没有独立后台服务；没有完成后自动唤醒主 Codex 的桥；也不提供
“终端关闭后继续运行”的承诺。主机 shell tool 的 yield/wait 仍按宿主规则使用。
每个 exact workspace 的 ACP 操作保守串行；不同工作树可独立执行。
普通 busy 请求被拒绝，不另外重造 acpx 队列。

## 文件

- `src/cli.mjs`：命令、私有环境装配、互斥、取消控制与退出码。
- `src/config.mjs`：显式命名路线、参数与授权校验、独立 worker home。
- `src/engine.mjs`：公开 runtime 接入、同会话校验、结果与清理。
- `src/state.mjs`：少量私有 binding/receipt、原子写、路径与文件类型检查。
- `test/*.test.mjs`：可无依赖运行的接入层测试；runtime 使用明确标记的合约替身。
- `test/real-acpx.integration.mjs`：实际加载 acpx 包并启动合成 ACP 子进程的联调测试。
- `test/fixture-acp-agent.mjs`：无模型、无账号、无网络的 ACP 夹具。
- `plugins/worker-routing/skills/acp-worker/SKILL.md`：显式外部路线入口；普通委派不触发。

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
provider HTTP 429 或内部重试，详情提供同源结构化经过。`stats`、`record`、`pending` 只读本机 private
state，不加载 adapter。投影为每个责任派生互斥的 `review_state`（`summary.review`
给出各状态计数）；未登记的 legacy 责任为 `legacy_untracked`，只是安静的历史记录。
完整操作见[Dispatch](dispatch.md)，数据语义见[数据契约](dispatch-data.zh-CN.md)。

## 日常用法

安装目录变量只用于展示；实际使用登记好的绝对路径。

```sh
ENTRY=/absolute/canonical/repo/integrations/acpx/src/cli.mjs
CONFIG=/absolute/private/routes.json

node "$ENTRY" run --config "$CONFIG" --route kimi-worker \
  --cwd /absolute/approved/worktree --file /absolute/work-order.md

# 从回执取 session_id；给同一个 worker 追加条件
node "$ENTRY" continue --config "$CONFIG" --session UUID \
  --file /absolute/increment.md

# 明确返修（可选快捷方式）：记录本次修正原因再续做；普通续做无需任何标注
node "$ENTRY" continue --config "$CONFIG" --session UUID \
  --file /absolute/rework-order.md --revision-reason requirement_missed

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

`--permissions` 选择的是 cwr-acp 对 ACP permission request 的应答策略，不是文件系统边界：
`read` 使用 approve-reads + 非交互 deny，`full` 使用 approve-all（可含执行/网络请求）。
两者都只约束真正到达 adapter 权限流程的请求。adapter 可能暴露不产生 ACP permission request
的操作，实际使用中已观察到 `read` 下的外部 worker 直接改写文件而未被拒绝；所以 `read` 的
“不得改动文件”只是工单授权措辞，不是强制。要获得确定性的文件系统只读行为，必须在本机
独立配置 host/OS sandbox 或使用一次性的只读环境；cwr-acp 不提供该边界，也不宣称进程级
网络隔离，也不声称每个 adapter 的所有原生工具都会走同一权限机制。

续做核对 route fingerprint、cwd、保存的 acpxRecordId/acpSessionId、argv 和 persistent handle。
指纹包含可执行入口 hash、参数、profile revision、workspace/权限配置与明确的 model 选择。
入口 hash 不涵盖 CLI 传递依赖和任意 profile 文件；profile 修改须更新 revision。
明确指定 model 时，开工前必须与 adapter 当前 advertised model 一致，否则不发送工单。
这一检查不认证真正的上游模型；provider identity 仍标记为未验证。
凭据值不落盘，不作为身份真实性证明。记录中的 model/usage 都只是 adapter 报告。

主会话不接收 thought 与原始 tool payload；stdout 输出最多 8192 UTF-16 code units 的正文
尾部节选及证据位置。完整历史由 acpx 保存。大输出会标记截断；超时/stream error 不被最终
success 文字掩盖。原始 agent 错误文本不直接写进结构化错误回执；需要诊断时写入单独的私有 diagnostic 文件，
回执只给出路径。该文件可能含 provider 敏感内容，分享前必须检查。

workspace lock 仅协调共享本 stateDir 的 ACP 命令。它看不到 native worker、其他安装、
数据库、端口、服务和其他共享资源。主机仍须遵守一个重叠写入面一个 writer，或用独立
worktree；worktree 本身也不隔离上述非文件资源。

## 崩溃与失败

初始连接/握手使用至多 30 秒控制超时；每轮任务使用 route.timeoutMs。
初始化取消不代表底层握手已退出；在接口无法确认清理时会保留锁和不确定状态。
没有自动重试或 native/ACP 静默 fallback。提交后丢失回执时，先查 status 与已保存 receipt。
不要靠再次发送同一写工单来“确认”。正常停止和代码失败会尝试关闭 ACP-owned 连接；
清理失败、初始化未决、仍观测到活跃 adapter 或进程直接死亡时保留锁。

status 的 `owner_process_present` 仅表示 PID 探针命中，不是该 PID 身份或模型健康证明。
过期锁不自动回收，避免 PID 重用/遗留 writer 导致双写。

异常恢复由本机操作者核对 owner.json、session receipt、当前 adapter 进程和实际 diff。
确认旧 writer 已终止后，才移除对应 operation 锁和 workspace 锁；保留 binding 和 acpx store。
v0.1 未实现自动恢复器，尤其不能将一个 dead PID 视为所有后代已退出的证明。
清理只确认 acpx-owned 进程/连接；不保证恶意 daemon 化或脱离宿主的任意后代已被终止。

## 验收门

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

# 可选 ACP 执行通道 · v0.1

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

目标系统为 macOS/Linux，v0.1 对 Windows 明确拒绝运行。Node.js 至少 22.13。
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

# 只有路线和当前任务都授权时使用；此项会批准所有 ACP 权限请求
node "$ENTRY" continue --config "$CONFIG" --session UUID \
  --file /absolute/implementation-order.md --permissions full

node "$ENTRY" status --config "$CONFIG" --session UUID
node "$ENTRY" cancel --config "$CONFIG" --session UUID
node "$ENTRY" close --config "$CONFIG" --session UUID
```

`cancel` 写入当前 operation nonce 对应的取消请求，运行进程每 200ms 检查本地控制邮箱。
它是本地控制实现，不要求主模型反复读取 worker 状态。回执中 `stopped:false` 明确表示
只确认发出请求；要等执行命令返回终态与清理结果。Ctrl+C 和 SIGTERM 也请求合作取消。
`close` 关闭工作责任，保留历史；活跃或清理未确认时拒绝关闭。

退出码：0 为 runtime 本轮完成且清理已确认；1 为执行失败或清理未确认；130 为取消；
2 为本地配置/前置条件/控制错误。即使退出 0，`task_acceptance` 也始终是 `unverified`，
须主 Codex 检查 diff、关键不变量与测试证据。

## 状态、上下文与安全边界

stateDir 只保存 binding/回执与 acpx 的私有 store。目录 0700、文件 0600；写入使用
同目录临时文件、fsync 和 atomic rename。输入拒绝 symlink、hardlink、FIFO 等特殊文件。
workerHome/stateDir 根可使用系统祖先目录的规范路径，但根自身和受管后代不接受 symlink。
这些检查降低意外链接/竞争造成的破坏，不构成抵御同 UID 恶意进程的完整文件系统隔离。

CLI 清理自己的环境后才 import acpx；保留 PATH 与固定 locale，重设 HOME/XDG/CODEX_HOME/
CLAUDE_CONFIG_DIR/TMPDIR，只额外传入 passEnv 明示的变量。宿主 shell、Codex 环境不被改变。
HOME 分离不限制绝对路径访问、Keychain 或原 CLI 自己的原生工具。
项目 AGENTS、agent 内置配置与本地工具也必须按真实 profile 验收。

read 模式使用 acpx 的 approve-reads + 非交互 deny。full 批准全部 ACP 请求，可包括网络和
命令执行。它们只约束实际交给 acpx 决策的请求；不宣称 OS sandbox、进程级网络隔离，
也不声称每个 adapter 的所有原生工具都会走同一权限机制。

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

本交付：60 项本地测试通过。其范围是接入层逻辑、真实文件系统检查、私有环境子进程测试，
以及合成 ACP server 的直接 stdio 自检；其中 runtime 行为使用合约替身。
实际 acpx 包联调的 3 项在加载依赖时均被 `ACPX_NOT_INSTALLED` 阻塞，协议流程未执行。

本机应补：安装并锁定依赖 → `npm run test:acpx` 通过 → 一个干净、已授权的真实 CLI
完成只读调查、原 session 实施与返修 → 验证真实输入没有主会话私人 marker → 检查实际
provider/model 与权限边界 → 检查 native 原路径仍能正常使用。
没有本机 native binary，现有 Python/native probe 也未在本交付环境重新运行。
新增文件与原生代码零重写只提供源码边界证据，不能冒充实机回归。

不要在这些门通过前将该 route 设置为日常委派自动候选。明确选用一个已验收外部 route
即可；常规 DSF/native 工作继续走现有通道。

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

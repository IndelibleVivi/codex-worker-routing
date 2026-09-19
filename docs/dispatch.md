# Dispatch · 派工台

[English](dispatch.en.md) | 中文

平时照常派活，回执会自然留下协作轨迹。Dispatch 把已有 ACP 回执与主协调者在
送验、修正和收尾时记录的事件，投影成一张本地只读面板。它不接管调度，也不另建
任务数据库。原生 Codex worker 尚无接入的数据源，页面上的数字只覆盖 ACP。

## 打开

使用已设置好的 [ACP integration](acp-integration.md)，在 canonical checkout 中运行：

```sh
node integrations/acpx/src/cli.mjs dashboard --config /absolute/private/routes.json
```

打开命令打印的私人 loopback URL。默认使用随机可用端口；需要固定端口时加
`--port 4317`。可加 `--since 7d`、`--since 30d` 或 `--since 2026-01-01`；默认是
`all`。页面可以切换窗口、搜索责任与 route、筛选值得展开的记录、查看完整责任回放，
也可以切换中文和 English。

面板前台运行，不安装服务。点击「关闭面板」或在 CLI 按 Ctrl+C 会释放进程。
关闭最后一个页面后，心跳停止，服务约两分钟后自动退出；从未打开的链接保留五分钟。
浏览器休眠或长时间冻结也可能停止心跳，此时重新运行命令即可。面板出错不影响 ACP
派工和已有会话。

只看文字或接入自己的本地工具：

```sh
node integrations/acpx/src/cli.mjs stats --config /absolute/private/routes.json --since 7d
node integrations/acpx/src/cli.mjs stats --config /absolute/private/routes.json --since 7d --json
```

`stats --json` 是私有本地投影，包含 route、标题和 session 关联信息，**不适合直接公开**。
它不读取账号额度，不扫描 Codex rollout，不调用模型或 adapter。

## 首页与记录

默认 Home 是统计总览：累计责任、执行轮次与外部工作量，下方是覆盖整个窗口的时间柱形图、
验收状态环图、route 工作量分布和修正原因。鼠尾草绿、马卡龙粉与深茄紫配合偏白底色。
柱形可以切换「执行轮次 / 新派责任」，hover、键盘聚焦或触摸查看分段数字；新派责任仅按
窗口内创建时间计数，可能少于上方含旧 session 续做的责任总数。点 route 可进入对应记录。

「记录」单独提供搜索、筛选与责任回放，查看工单、各轮回执和有来源的验收证据。

## 每条轨迹说明什么

- **执行轮次**来自实际回执。同一 worker 的正常续做不会自动成为「修正」。
- **运行完成**只说明 runtime 完成；验收仍可能未记录。
- **送验 / 修正 / 接受 / 接管**来自协调者明确记录的事件，原因归类可以修订。
- **验证来源**区分 `coordinator` 与 `worker`。Worker 自述测试通过不自动成为主机独立验证。
- **历史记录**没有标题、父会话、独立工单或验收标记时，保持未知，不从输出正文推断。

主协调者在原有工作动作里顺手记录，而不是要求使用者逐项填写绩效。更新后的
`acp-worker` skill 提供这条路径；source 更新不会自动更新已安装 plugin cache，
应按[插件更新流程](installation.md#plugin)正常 reinstall，并在新主 session 检查 discovery。

新派工可以给责任取一个简短标题和类别：

```sh
node integrations/acpx/src/cli.mjs run --config /absolute/private/routes.json \
  --route registered-worker --cwd /absolute/approved/worktree \
  --file /absolute/work-order.md --title '修复空输入处理' --category implementation
```

`--title` 与 `--category` 属于这份责任，同 session 续做保留它们。
记录一个确实发生的接受动作时，将下面的合成示例写入 Git 外的 JSON 文件，替换
session UUID 与 event UUID；同一次动作重试时保留原 event UUID：

```json
{
  "schema": "cwr.dispatch.event/1",
  "event_id": "11111111-1111-4111-8111-111111111111",
  "session_id": "22222222-2222-4222-8222-222222222222",
  "kind": "accepted",
  "summary": "检查修复并接受交付。",
  "evidence": [
    {"source": "coordinator", "kind": "test", "summary": "实际运行空输入回归，测试通过。"},
    {"source": "worker", "kind": "test", "summary": "Worker 报告运行了相关单元测试。"}
  ]
}
```

```sh
node integrations/acpx/src/cli.mjs record --config /absolute/private/routes.json \
  --session 22222222-2222-4222-8222-222222222222 --file /absolute/private/event.json
```

没有实际运行的验证不要填写。修正与接管必须标明原因；纠正先前标记时使用
`supersedes` 指向原 event UUID，原始记录保留。完整 schema、时间窗口、累计量与
修订规则见 [Dispatch 数据契约](dispatch-data.md)。

## 数字的边界

Adapter 通常报告 session 累计量。三轮回执分别是 100、180、250 tokens，累计工作量
是 250，不是 530。窗口内统计需要可归属的增量；缺少边界、累计量重置或未知数据时，
覆盖率与提示一起显示，不把未知填成零。各 route 的时长只描述各自实际任务，并带样本数，
不能在未匹配任务复杂度时当成模型性能排名。

这些数字既不是 billing 证明，也不是 Codex 节省额度。Dispatch 不安排重复 A/B 工作，
不估算「省了百分之几」，不为主机或 worker 打总分。记录可以帮助人判断协作质量，
但主机写下的归因仍然是当时的判断；回放中的工单与回执可供核查。

## 分享

点击「导出分享图」，先检查预览，再下载横版 **1600 × 900** 或竖版 **1080 × 1350**
的 SVG / PNG。导出覆盖所选时间窗口的全部 ACP 汇总，不受列表搜索或「值得展开」筛选影响。
预览与下载使用同一份冻结的汇总，避免下载时数字悄悄变化。

独立的 export allowlist 只接受数字、时间窗口、coverage 与固定项目署名。标题、工单、
输出、私有 route 名、父会话、内部 ID、路径与诊断不会进入这份数据。图形根据汇总数展示验收构成，
不包含任何单个工单的轨迹。导出文件不会自动上传。

## 隐私与运行方式

```mermaid
flowchart LR
  R["Private ACP receipts<br/>runtime truth"] --> P["Rebuildable in-memory projection"]
  E["Coordinator events<br/>source-tagged evidence"] --> P
  P --> L["Loopback dashboard<br/>private detail on demand"]
  P --> A["Aggregate-only allowlist"]
  A --> X["Preview → SVG / PNG<br/>explicit local download"]
```

HTTP 仅监听 `127.0.0.1`，数据接口要求随机 bearer token，并校验 Host / Origin。
私人链接的 token 放在 URL fragment，页面读取后从地址栏移除。不要转发这条链接。
页面无 CDN、远程字体、analytics 或外部网络请求；公开导出是独立接口，不能靠
「页面没显示」来假定原始记录已经脱敏。

首次读取按需建立内存索引，之后按文件变动重读；关闭后不保留第二份索引数据库。
新增的精简事件、原始工单与可用父会话 ID 保存在既有 Git 外 private state。
面板按需读取工单与回执节选，不扫描完整 transcripts。旧数据不迁移、不修补。
POSIX private mode 与 Windows ACL 的实际边界沿用 [ACP integration](acp-integration.md)。

## 验证与恢复

```sh
cd integrations/acpx
npm ci --ignore-scripts
npm run check
npm run test:acpx
```

合成测试覆盖累计量、窗口归属、事件修订、输入来源、旧记录、导出白名单、HTTP 访问
边界和关闭语义。浏览器验收还应检查时间筛选、搜索、回放、键盘关闭、两种分享尺寸及
桌面/窄屏布局。测试不替代真实 provider 身份或使用者主观验收。

停止 dashboard 命令即可关闭展示层。已有 receipts 与事件保留；需要恢复旧版 source
时用版本控制恢复代码，不删 private state。无须停止或重建原生 worker / ACP 会话。

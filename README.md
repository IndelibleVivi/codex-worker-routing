# Codex Worker Routing

[English](README.en.md) | 中文

把一块完整工程责任交给原生 Codex worker，主 agent 保留目标、整合与交付责任。
适合已接入多个模型、希望分配执行工作，同时保留主会话个人上下文的使用者。

这是初版实现。调度由一个 instruction-only plugin 提供；可选 ACP integration
通过 `acpx/runtime` 连接已登记的外部 coding agent；可选的主会话集成使用原生
`SessionStart` hook 自动加载本机私人说明。没有额外 MCP、job database、provider
proxy 或固定 planner/tester/reviewer 流水线。

## 架构

```mermaid
flowchart LR
  subgraph Source["Public canonical source / 公开真源"]
    Policy["Worker Routing plugin<br/>native delegation policy"]
    ACPSource["Optional ACP integration<br/>acp-worker + cwr-acp"]
    Adapter["Optional SessionStart integration<br/>installer + adapter"]
  end

  subgraph Local["Local Codex runtime / 本机运行时"]
    Cache["Installed plugin cache<br/>derived copy"]
    Hook["Trusted SessionStart hook<br/>root-only injection"]
    Main["Main coordinating agent<br/>goal · integration · delivery"]
    Native["Native Codex worker<br/>bounded responsibility"]
    ACPBridge["cwr-acp + registered adapter<br/>persistent ACP session"]
    External["External ACP worker<br/>bounded responsibility"]
  end

  Private["Private main-session instructions<br/>outside Git"]
  RouteConfig["Private route config<br/>provider/model preference"]
  Shared["Shared engineering/project rules<br/>共享工程规则"]
  User["User / 用户"]

  Policy -->|plugin install| Cache
  ACPSource -->|plugin install| Cache
  ACPSource -->|npm ci| ACPBridge
  Cache -->|routing instructions| Main
  Adapter -->|install handler| Hook
  Private -->|local read| Hook
  Hook -->|private context<br/>root only| Main
  RouteConfig -->|named route| ACPBridge
  Shared --> Main
  Shared --> Native
  Shared --> External
  Main -->|native work order<br/>fork_turns=none| Native
  Native -->|result + evidence| Main
  Main -->|ACP work order| ACPBridge
  ACPBridge -->|ACP session| External
  External -->|result + evidence| ACPBridge
  ACPBridge -->|receipt + excerpt| Main
  Main -->|integrated delivery| User
```

图中区分了 public source、derived installed copy、Git 外私人说明与可选 ACP
执行通道。它描述输入装配和责任流：`fork_turns="none"` 不携带主对话历史，但不会
移除宿主自动共享的工程规则，也不构成文件访问 sandbox。native、ACP、provider 与
model 的临时优先级由 operator 在 Git 外配置，仓库本身不替使用者决定。

## 第一次配置

如果你还没有完整走过一次派工，先看[从零到第一次成功派工](docs/first-delegated-task.md)。
它把 model/provider、native subagent、Worker Routing plugin、可选 ACP route 和最终验收
分成五层，并给出三条可独立采用的路线与排错表。

要把自有 API model 放进 Codex native model picker，见
[自定义 native model picker](docs/native-model-picker.md)。该例子同时覆盖直接连接
Responses-compatible API 与在本机 router/proxy 后汇集多个 upstream；provider、key、
套餐优先级和 fallback 始终留在 operator 的 Git 外配置里，不进入 Worker Routing policy。

ACP route 的可达性另有协议边界：通道负责 session、生命周期、权限与证据，不负责
provider wire format 的转换。为什么 route 或 model 能初始化而推理仍会失败，见
[ACP 通道与 provider 协议边界](docs/acp-provider-protocols.md)。

## 日常使用

安装后正常提出工程任务即可。主 agent 在有收益时交出完整责任：调查、实现、自测
和必要文档可以由同一个 worker 连贯完成，需要修正时继续同一个 child。

```text
修复 CSV 导入时空行导致的失败，补能复现问题的检查。
可以把导入模块的调查、修复和自测交给一个 worker；你负责整合与最终交付。
```

`全权接住`、`从头做到位` 允许内部委派；`solo`、`亲自做`、`别派小弟` 保持主
agent 执行。微小、接近完成或交接成本过高的工作也直接完成。派出后主 agent 不
重复实施同一责任，默认不另派 reviewer，需要修正时继续同一个 child。

派工顺序是先保住完整结果、质量与权限，再在不牺牲这三者的前提下减少主订阅模型的
执行消耗，同时控制端到端耗时和 coordinator 返工。使用 operator 已指定、已授权且
适合责任、较少消耗主订阅 quota 的路线；没有已知收益就不为分工本身派工。外部
worker API 支出单独计算，不悄悄回退到更高成本路线。模型与 provider 名留在
operator 配置里，插件不做排行榜、价格查询或评测矩阵。可选 ACP route 不做自动
fallback：只有当前任务权限与 operator policy 才能决定失败后是否换路线。

## 行为场景

四个非 runtime 的观察场景与证据标准见[行为场景](docs/behavior-scenarios.md)：
自然语言中的中等修复、同一 child 从调查转入实施或局部返修、健康等待不取消也不
重复启动、以及 solo 或微小工作不派工。该页是人工核对用的观察记录，不是评测平台，
也不提供稳定触发、净省 quota、低返工或更快的结论。

## 上下文怎样分开

| 内容 | 主 session | 临时 worker |
| --- | --- | --- |
| 共享工程 AGENTS 与项目规则 | 自动加载 | 自动加载 |
| 本机私人主会话说明 | 可选 SessionStart 集成在首次模型请求前注入 | 不由该 hook 注入 |
| 具体工单 | 主 agent 组织 | 明确接收 |
| 主对话历史 | 保留 | 新工单使用 `fork_turns="none"` |

仅增加一份 worker AGENTS 不会移除原本共享的私人规则。启用上下文分离时，需要把
私人内容移出自动共享 AGENTS，并先验证启动 hook 已受信任且完整送达。
这属于输入装配边界，**不是文件访问 sandbox**。

模型和 reasoning effort 由使用者的实时库存与授权决定。插件不绑定供应商、
不提供 API key、不改变主模型，也不通过试跑申请私人数据传输权限。

## 安装

在 Codex 中打开本仓库，让内置 plugin-creator 安装插件：

```text
请把本仓库 plugins/worker-routing 安装到我的 personal marketplace，
保持当前主模型和 provider 配置。更新时使用 cachebuster 与正常 reinstall。
```

完成 personal marketplace 注册后，原生命令是：

```bash
codex plugin add worker-routing@personal --json
codex plugin list --marketplace personal --json
```

需要外部 ACP worker 时，再安装可选 integration：

```bash
cd integrations/acpx
npm ci --ignore-scripts
npm run check
npm run test:acpx
```

route config、worker home、adapter 与账号状态留在 Git 外；具体命令和边界见
[ACP integration](docs/acp-integration.md)。需要分离私人说明时，再按
[安装与恢复](docs/installation.md)接入启动 hook。该集成独立于 plugin；关闭派工
plugin 不会关闭主会话私人说明。

## 验证

Python 集成仅使用标准库：

```bash
python3 -m unittest discover -s tests -p 'test_*.py'
python3 tests/native_context_probe.py --codex-bin "$(command -v codex)"

cd integrations/acpx
npm ci --ignore-scripts
npm run check
npm run test:acpx
```

第二条是 opt-in 原生进程检查，要求 binary 提供当前 multi-agent 工具。它使用临时
Codex home、合成说明和本机 scripted Responses 服务，验证首次 root 请求、child
首次工作、同一 child 续做及完成后 interrupt。它不调用真实模型，也不能代替实际
供应商与工程执行验收。Codex 自身可能仍尝试获取公共插件元数据，进程不保证完全离线。

初始 native 兼容性依据为 Codex `0.154.0-alpha.6.2`；ACP integration 固定验证
`acpx@0.15.1`，要求 Node.js 22.13 或更高。调用时仍以真实 schema 与 adapter
能力为准。较旧的 CLI 或其他宿主未必提供相同字段。更多限制见
[输入边界](docs/context.md)与[ACP integration](docs/acp-integration.md)。

本仓库是独立 canonical source。`plugins/worker-routing` 下的 native runtime 五份
说明（`SKILL.md` 与四份 references）以英文为 canonical text；`acp-worker` 是可选的
外部 route 入口。native 说明保留 `全权接住`、
`从头做到位`、`solo`、`亲自做`、`别派小弟` 等触发示例；README、
[行为场景](docs/behavior-scenarios.md)、安装与输入边界文档保持中文。私人说明、
账号配置、请求与 continuity 不属于仓库。见[来源说明](PROVENANCE.md)。

## 许可

软件与功能材料采用 [`SUL-1.0`](LICENSE)：允许个人、非商业和企业内部使用；
对外分发或提供必须免费且非商业。文档采用
[`CC BY-NC-SA 4.0`](LICENSE-DOCUMENTATION.md)：允许署名后的非商业分享与改编，
公开改编须保持相同许可。本项目是 source-available，**不是 OSI open source**。
具体文件范围以 [`LICENSING.md`](LICENSING.md) 为准。

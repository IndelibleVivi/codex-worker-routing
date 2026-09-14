# 当前宿主的 native collaboration tools

本页记录打包时宿主的当前 schema，只在实际使用这些工具时读取。它不是跨宿主或未来版本保证；调用前以当前可见 schema 和返回状态为准。工具缺失时保持 solo 或使用宿主明确提供的等价能力，不要伪造 adapter、MCP、hook 或 job system。

## 启动与路由

`collaboration.spawn_agent` 当前支持 `task_name`、`agent_type`、`model`、`reasoning_effort`、`fork_turns`。新独立工单默认显式设 `fork_turns: "none"`，并在 message 中写全最小充分工单与 worker-role 语义。不要声称该值隔离 global/project instructions、skills、tools 或 provider 请求里自动附加的私密 instructions。

只在宿主实时库存和当前授权支持时选择 `agent_type`、`model` 或 `reasoning_effort`；不把具体模型名固化进本 skill。任务名应能区分责任，但不要为每个机械步骤新开 child。

Codex app 的 `create_thread` 创建用户可见的新 task，不用于当前任务的内部委派。

## 等待与增量

- `list_agents` 查看 child 的实际状态；不要从旧记录猜测它仍在运行。
- `wait_agent` 等待 mailbox 更新。健康运行中的 timeout、静默或 active yield 不是失败，也不是 interrupt 条件；等待不等于取消。
- 对仍活跃的 worker，用 `send_message` 发送影响当前工作的约束或证据增量。
- 对 idle worker 的续做或返修，用 `followup_task` 触发下一 turn，保留同一 child 的上下文与责任。

## 当前宿主的收拢规则

在这个宿主版本里，child 到达 `FINAL_ANSWER`、`task_complete`、`idle` 或 `errored` 后，先调用 `interrupt_agent` 收拢其状态；之后如需续做或返修，可对同一 child 调用 `followup_task`。不要因为健康等待的 timeout、静默或耗时而 interrupt 正在工作的 child。

工具返回含糊时先用 `list_agents` 核实已有 child，避免复制同一责任。接管或换 worker 前也要确认旧 worker 已停止写入。

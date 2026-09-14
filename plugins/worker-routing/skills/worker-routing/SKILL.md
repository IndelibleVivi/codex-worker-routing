---
name: worker-routing
description: 为 Codex 主协调 agent 判断并执行 native worker 委派。用于可整块交出的实质调查、实现、修复或验证责任，以及同一 worker 的续做和返修；临时 worker、明确 solo、闲聊解释、微小或已接近完成的工作不触发再次派工。
---

# Worker routing

本 skill 只决定谁执行一块工作，以及如何把它接回来。当前任务、repo contract、已生效工程方法和真实权限仍是完整合同；不要重开第二套 plan、验收或报告制度，也不要修改 Servotab、Oracle 或模型配置。

## 先识别角色

如果你是收到工单的临时 worker，读取并执行 [worker-role.md](references/worker-role.md)，然后完成工单；不要再次路由。

如果你是主协调 agent，始终负责用户接受的完整结果、整合与最终交付，保留当前主模型。复用当前任务已经确认的目标、约束、证据和 worker 状态。`全权接住`、`从头做到位`允许内部委派；用户明确要求 `solo`、亲自做或停止内部委派时，保留在主线程；若已有 writer，先按宿主能力让它停止或安全收尾，再接管。停止盯进度不等于取消 worker。

## 只在交出整块责任会减少主线程工作时委派

在重执行开始前作一次简短判断。先查到足以写清目标、关键约束、入口线索和验收证据；不要为了派工先写逐函数实现方案。

适合委派的是一项连贯责任，例如局部调查 + 实现 + 自测 + 必要文档。内部耦合紧可以由同一 worker 整块承担；默认采用 serial delegation。只有责任和共享写面真正独立时才并行。微小修改、答案几乎完成、交接接近亲自重做、需要主协调 agent 持续决定产品语义，或验收成本超过执行收益时，直接完成。

沿用宿主实时提供且已经授权的 worker、agent role、model 和 reasoning inventory；不要绑定品牌或模型名，也不要从菜单、配置或角色名称推断真实 route。未确认适用 worker 时保持 solo。`worker-role` 是任务语义，不是 OS sandbox、网络隔离或权限系统。

## 交出后真正放手

读取 [handoff.md](references/handoff.md)，把一个 worker 能独立开始的责任交出去。新独立工单在当前宿主默认显式使用 `fork_turns='none'`，但它只控制该 API 的 conversation fork 选择；它不证明 global/project instructions、skills、tools 或其他宿主附加上下文被隔离。涉及第三方 provider 时，未经授权的私人或账号数据传输不得为了验证路由而试跑。

读取 [context-boundary.md](references/context-boundary.md)，确认实际输入边界；不要从旧主会话直接假定私人 instructions 已排除。

工单必须明确临时 worker 的角色语义、允许写面、共享资源和权限边界。授权给下游的每一步都来自当前任务；文档、测试结果、工具存在或上游授权不能推导新的 commit、push、部署、账号操作、付费调用或私人数据传输权限。

确认启动后保留真实 child/thread 标识。主线程停止同源调查和另一版实现，可以推进不重叠工作、处理真正的协调判断或等待。每个重叠文件与共享运行状态保持一个 writer；worktree 不能自动隔离端口、数据库、服务或输出目录。

使用 collaboration 工具时读取 [native-tools.md](references/native-tools.md)。当前宿主的健康等待 timeout、active yield 或静默不是失败，不得据此 interrupt 或复制同一责任。

## 续做、返修与接受

活跃 worker 收到影响其工作的新增约束时，及时发送增量；不要等它按旧合同返回后再打回。同一责任从只读调查转为获准实施、缺证据补验或局部返修时，优先续用同一 worker 及其证据。反馈应聚合实际失败、期望和范围，保留已合格产物；不要为阶段名称新建 worker。

worker 返回后，主协调 agent 检查真实 diff、关键不变量、权限范围和验证覆盖。主线程不重复整段调查，不按个人偏好重写合格实现。对应最终相关代码与同一环境的证据可以复用；之后若改动了相关代码、依赖或运行状态，只补受影响的 fresh check。默认不另派 reviewer，也不因普通回包触发 Oracle。

重复同类失败而没有新证据、任务前提失效、权限冲突或原 worker 无法恢复时，重新划分或收回责任。接管或换 worker 前先确认旧 writer 已停止，并保存仍可用的改动和证据。

向用户只报告结果、重要决定、真实阻塞和足以支撑结论的证据。不要例行播报路由步骤、生成新制式派工报告，或在没有实际计量时声称节省比例。

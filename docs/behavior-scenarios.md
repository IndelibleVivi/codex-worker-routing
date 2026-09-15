# 行为场景观察

本页只记录四个**非 runtime** 的观察场景，供人在真实主 session 里核对
worker routing 是否按当前 policy 行事。runtime 的 canonical text 在
[SKILL.md 与四份 references](../plugins/worker-routing/skills/worker-routing/SKILL.md)。

证据标准：只认 tool/thread trace、diff 与 checks。主协调 agent、worker 或用户的
自述不是证据。每个场景因此写成「触发输入 → 期望可观察行为 → 需要的证据 → 不作
断言」，不作因果或收益结论。

## 场景一：自然语言中的中等修复

用户在普通对话里提出一个中等规模修复，没有点名 skill、worker 或任何模型。

- 期望可观察行为：主协调 agent 在重执行前先查明目标、约束、入口和验收证据；
  判定这是可以整块交出的连贯责任时派出一个 worker，并在等待期间停止同源调查和
  另一版实现；判定更适合直接完成时留在主线程。
- 需要的证据：thread trace（是否发生派工、派给了谁）与该责任的 diff、实际运行的
  checks。
- 不作断言：不据此声称已证明稳定触发，也不声称省了多少 quota 或返工。
- 观察入口见 README 的「日常使用」。

## 场景二：同一 child 从调查转入实施或局部返修

同一责任先以只读调查交付，随后获得实施授权，或返回后需要局部返修。

- 期望可观察行为：增量发给原 child，而不是另开新 worker；反馈聚合实际失败、
  期望与范围，保留已合格产物；没有变化的部分不从头重探。
- 需要的证据：thread trace（同一 child 是否被续做、是否出现新 child）加上该轮
  实际改动与 checks。
- 不作断言：不声称净省 quota、低返工或更快，也不据此建立 eval 平台。

## 场景三：健康等待不取消、不重复启动

worker 仍在工作时，等待出现 timeout、静默或 active yield。

- 期望可观察行为：使用宿主的阻塞等待与完成消息；健康等待的 timeout、静默或
  active yield 既不触发 interrupt，也不触发复制同一责任的新 worker。仅当需要
  恢复、状态含糊或需要介入时才查询状态。
- 需要的证据：thread trace 中的 wait/interrupt/spawn 事件顺序，而不是主线程
  自述「我没有打断它」。
- 不作断言：不把一次安静等待当成稳定行为的证明。

## 场景四：solo 或微小工作不派工

用户明确要求 `solo`、`亲自做`、`别派小弟`，或工作微小、接近完成、交接成本高于
执行收益。

- 期望可观察行为：主协调 agent 在主线程完成，不新增 worker；已有 writer 时先让
  其安全停止或收尾再接管，且停止盯进度不等于取消 worker。
- 需要的证据：thread trace（没有新 child）与主线程完成的 diff、checks。
- 不作断言：不声称这是稳定触发的证据，也不要求生产双跑或付费测试。

## 明确不做

- 不据此声称已证明稳定触发、净省 quota、低返工或更快。
- 不建立 eval 平台，不要求生产双跑，不安排付费测试。
- 不把本页当作 runtime policy；runtime 行为以
  [SKILL.md](../plugins/worker-routing/skills/worker-routing/SKILL.md) 与
  `references/*.md` 为准。

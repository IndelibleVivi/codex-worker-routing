# 行为场景观察

[English](behavior-scenarios.en.md) | 中文

本页记录**非 runtime** 的观察场景，供人在真实主 session 里核对
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

## 场景五：默认切换与撤回许可

只配置一个默认小工，连续派出两块独立责任；随后把默认从 A 改为 B，再续做 A 的旧责任。

- 期望可观察行为：普通派工不扫描模型目录、不要求填写特长；新责任使用最新默认，旧责任保持 A 的会话。只有明确撤回 A 的许可，才拒绝后续继续使用 A，并保留停止与恢复入口。
- 需要的证据：实际选择的 route、同一 session 的续做、配置变更前后 run/continue/control 的结果。ACP 的正常默认解析在原 run 内完成，没有固定的查询前置回合。
- 不作断言：一个模型名相同不证明不同渠道有相同能力或数据授权；配置测试不证明 Native 宿主行为。

## 场景六：获准备用与执行恢复

默认入口在启动前不可用，且 operator 明确允许一个备用；另一次工作在提交后出现错误或回执不明。

- 期望可观察行为：启动前的可用性故障只尝试明确备用，实际最多启动一个 worker；权限/workspace/停用不能触发自动绕路。已经启动或提交状态不明时先恢复原执行，确认 writer 停止、检查已有修改后再交接剩余工作。质量不合格仍用同 worker 返修。
- 需要的证据：preflight 跳过原因、实际 launch/prompt 次数、receipt 与 cleanup、恢复后的 diff。该任务内未变化的已知故障不反复试探；没有备用时，在任务允许的范围内由主线程直接做。
- 不作断言：runtime 错误码不证明套餐到期、余额不足或 HTTP 429；历史上用过的渠道不是当前备用授权。

## 场景七：权限与续做身份分开

调查转入实施；另一轮漏填权限；原 route 又增加一个无关 workspace 或降低权限上限。

- 期望可观察行为：获准实施沿用同 session 并显式带 full；遗漏参数在派工前拒绝，category 不推断权限。新身份下增加无关 workspace 或调整预算不拒绝续做，撤回原 cwd 或降低权限上限则拒绝相应续做。旧 binding 只在完整旧指纹匹配时迁移。
- 需要的证据：preflight 错误与零 launch/prompt/state mutation 对照、绑定身份、续做与撤回后的结果；权限模式不是 OS sandbox 的证据。
- 不作断言：配置匹配不证明 adapter 的所有工具都会请求权限，也不证明真实模型身份。

## 场景八：恢复有判断，不重复空转

同一验收缺口经过两次明确返修仍无实质进展；另有一个正常阶段推进、一份缺失的 final report 和一个 host 能力缺口作对照。

- 期望可观察行为：第三次等价工单前重新决定；有新证据、环境修复或缩小后的范围才继续。保留合格产物，可部分接管；更换 writer 前确认停止。阶段推进不计质量失败，缺 final report 先整理已有证据，host 拒绝不靠换渠道绕过。
- 需要的证据：前后实际验收缺口、可用成果、新决定及其依据；无需强制 record/revision 标注。
- 不作断言：返修次数、时长或 completed 状态不自动证明任务质量。

## 场景九：等待超时与执行 deadline 不混同

宿主 wait yield 是健康等待；另一个 worker 有 progress 却一直没有 canonical final。

- 期望可观察行为：前者继续等原执行；后者到 CWR deadline 后失败并清理，迟到 end_turn 不翻成成功。取消同样保留取消终态；partial output 与 cleanup 独立可见。
- 需要的证据：时间边界、真实 acpx 合成联调、result/receipt/退出码、清理与锁状态，以及正常完成对照。
- 不作断言：合成测试不证明真实 provider 稳定性；旧 completed 回执没有被重新判定。

## 明确不做

- 不据此声称已证明稳定触发、净省 quota、低返工或更快。
- 不建立 eval 平台，不要求生产双跑，不安排付费测试。
- 不把本页当作 runtime policy；runtime 行为以
  [SKILL.md](../plugins/worker-routing/skills/worker-routing/SKILL.md) 与
  `references/*.md` 为准。

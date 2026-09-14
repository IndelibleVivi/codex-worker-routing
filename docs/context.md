# 输入边界与验收

`fork_turns="none"` 排除父对话历史，不替换全局/项目 AGENTS。角色指令或另一份
AGENTS 的优先级也不意味着旧文本从 provider 请求里消失。

本集成把私人主会话说明放在普通 AGENTS discovery 之外，通过 SessionStart 自动
注入 root。临时 child 的新工单不继承父对话，因此不复制这份 root 上下文。
主 agent 保护工单，worker 遵守允许读写的工程范围。

原生合成检查使用真实 Codex 进程和本机模型协议替身，验证长文本进入首次 root
请求；工程规则进入 child；root 私人和模拟 recall 标记不进入 child；同一 child
的 followup 保持边界；两个完成信号都得到 interrupt。

分别验收文件/配置存在、plugin installed/enabled、hook trusted、root 完整送达、
child 输入边界、指定 provider 实际执行，以及使用者在普通主 session 中的体验。

已有 recall、project hooks、工具说明或其他注入层应在实际环境核对。模拟 recall
只验证事件路由，不证明真实记忆服务的业务行为。文件权限由宿主决定，这个机制
不阻止获准使用文件工具的进程读取其他本机文件。

源码不提供账号配置、token、代理或付费路线。使用外部模型前，先确认真实附加
上下文符合任务授权，再做有边界的实际工程验收。

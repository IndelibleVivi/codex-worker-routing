# 主会话与 worker 输入

新工单使用 `fork_turns="none"`，仍需核对自动共享 AGENTS 与其他宿主注入。
已加载私人 AGENTS 的旧主会话不能因为磁盘更新就视为已清空。

使用独立主会话 SessionStart 集成时，私人说明在 root 首次模型请求前自动注入，
shared AGENTS 只保留工程规则。该集成独立于 plugin；普通派工不自行安装、修改、
移除或绕过其 hook trust。

主 agent 不把私人说明、聊天或 recall 复制进工单；worker 不主动读取私人说明、
关系记忆和私人 continuity。行为约定不是文件访问 sandbox。输入证据支持排除
结论，角色自述、安装状态和模型菜单不能代替它。

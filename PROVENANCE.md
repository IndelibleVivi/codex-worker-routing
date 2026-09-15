# 来源与维护边界

这是独立维护的原始 workflow 项目。初始 routing policy 从内部工程 workshop 中
按组件范围抽取，独立仓库成为后续 canonical source；内部 workshop 的 Git 历史、
相邻项目、个人说明和工作记录没有迁入。

仓库包含手写调度/worker 说明、原生 SessionStart 适配脚本、安装器、合成测试和
使用文档。Responses 测试事件是本机协议 fixture，没有真实账号、私人请求或模型
输出，没有复制 Codex runtime 实现。

接口参考 OpenAI 的 [Hooks](https://learn.chatgpt.com/docs/hooks) 和
[Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) 文档，
并用本机 binary 独立观察。本项目不是 OpenAI 官方产品或其维护的 fork。

软件与功能材料采用 `SUL-1.0`，文档采用 `CC BY-NC-SA 4.0`；具体文件范围、
外部链接与许可边界见 [LICENSING.md](LICENSING.md)。这是 source-available 项目，
不是 OSI open source；仓库可见性不扩大许可授权。

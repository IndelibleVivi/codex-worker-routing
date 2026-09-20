# 来源与维护边界

这是独立维护的原始 workflow 项目。初始 routing policy 从内部工程 workshop 中
按组件范围抽取，独立仓库成为后续 canonical source；内部 workshop 的 Git 历史、
相邻项目、个人说明和工作记录没有迁入。

仓库包含手写调度/worker 说明、原生 SessionStart 适配脚本、安装器、合成测试和
使用文档，以及基于公开 `acpx/runtime` API 的可选 ACP 接入。Responses 与 ACP
测试事件是本机协议 fixture，没有真实账号、私人请求或模型输出，没有复制 Codex
runtime 或外部 adapter 实现。`acpx` 及其传递依赖保持各自的第三方许可。

猫头标识经历本项目的图像生成探索，折耳猫以原生 SVG 重绘；运行和分发使用
`integrations/acpx/src/brand.mjs` 的矢量实现；概念图不属于运行依赖。相邻主题中的兔、狗、熊为本项目原生 SVG 绘制，
由 `integrations/acpx/src/mascots.mjs` 维护，保留同一家族的造型语言。

Dispatch 的紧凑工作台、线条产品标识与独立分享排版由本项目提供的 v3 设计候选演进；
候选的合成数据与模拟 runtime 情况没有迁入生产数据路径。实际统计由私有 receipts 投影。

接口参考 OpenAI 的 [Hooks](https://learn.chatgpt.com/docs/hooks) 和
[Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) 文档，
并用本机 binary 独立观察。本项目不是 OpenAI 官方产品或其维护的 fork。

软件与功能材料采用 `SUL-1.0`，文档采用 `CC BY-NC-SA 4.0`；具体文件范围、
外部链接与许可边界见 [LICENSING.md](LICENSING.md)。这是 source-available 项目，
不是 OSI open source；仓库可见性不扩大许可授权。

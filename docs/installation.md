# 安装、切换与恢复

[English](installation.en.md) | 中文

调度 plugin 与主会话上下文集成是两个独立安装面。只需要调度时安装 plugin 即可。

## Plugin

使用 Codex 内置 plugin-creator 将 `plugins/worker-routing` 注册到使用者自己的
personal marketplace。保留一个 canonical source 和一个 discovery 入口；先核对
同名目录归属，不能覆盖其他插件。

更新源码后，用 plugin-creator 的 `read_marketplace_name.py` 验证 marketplace，
再运行 `update_plugin_cachebuster.py <plugin-path>` 与正常 `codex plugin add`。
不要热改 installed cache。安装后用新的主 session 验收 discovery。

默认与备用功能需要同时更新 canonical ACP source 和 plugin instructions；旧会话已加载的
说明不会自动刷新。已有 `routes.json` 与显式 `--route` 继续兼容，无需迁移回执或会话。
可选加入 `routing.default` 后，日常换 ACP 渠道只修改这份 Git 外配置；不要在
SessionStart 再复制当前 route 名。完整配置与撤回许可见[ACP 接入](acp-integration.md#默认与备用)。

## Dispatch 本地面板

Dispatch 随可选 ACP source 提供，不新增 frontend dependency 或系统服务。
已有 ACP runtime 的 operator 可以直接运行 canonical CLI 的 `stats` / `pending` / `dashboard`；
读取历史无需启动 adapter，也不会加载 `acpx` runtime——这些只读命令校验同一份私人
`--config` 文件，但只使用其中的 `stateDir`。配置示例见
[`integrations/acpx/examples/routes.example.json`](../integrations/acpx/examples/routes.example.json)。
新增协作事件的自然记录说明位于 `acp-worker` skill，
连同内置猫头 icon 一起按上述 Plugin 流程刷新 installed copy；只有修改 source 不会改变旧 session 已加载的说明。
面板首次使用默认为机器时区；主题、语言、时区保存在 Git 外 stateDir 的
`dashboard-preferences.json`，换端口后保留。仅这些展示偏好可由面板写入，业务数据仍只读。
完整命令、私有数据边界、导出与退出行为见[派工台](dispatch.md)。

## 主 session 自动加载

1. 在 Git 目录外准备 `main-session.md`，放入只属于主协调者的私人说明。保留原文
   与恢复副本，此时先保留旧 AGENTS。文件必须是非空 UTF-8，最多 65536 bytes。
2. 在本仓库根目录预览，然后安装：

   ```bash
   python3 integrations/main-session/install.py \
     --instructions "$HOME/.codex/private-instructions/main-session.md"

   python3 integrations/main-session/install.py \
     --instructions "$HOME/.codex/private-instructions/main-session.md" --apply
   ```

   默认目标为当前 `CODEX_HOME`，未指定时为 `~/.codex`。安装器复制脚本到
   `worker-routing/main_session.py`，合并一个 SessionStart handler，并将原有
   hooks.json / 已存在的脚本备份到 `worker-routing/backups/`。它不修改 AGENTS、
   model/provider config、其他 hook 或原生 hook trust。

   安装器先把 `$CODEX_HOME` 规范为 lexical absolute path，再 canonicalize 其
   parent/ancestor，只让 final component 保持不跟随：ancestor symlink 因此沿用
   旧版的 canonical command path，alias 调用不会重复添加 handler；`$CODEX_HOME`
   自身是 symlink（含 dangling）时则由下面的检查拒绝。随后在读取或写入任何
   managed output 之前先做 non-following `lstat` 检查：`$CODEX_HOME` 只能是
   absent 或真实目录（此时后续照常 clean install）；`hooks.json` 与
   `worker-routing/main_session.py` 只能是 absent 或 single-link regular file；
   `worker-routing/` 与 `worker-routing/backups/` 只能是 absent 或真实目录。
   symlink（含 dangling）、hardlink、FIFO、socket/device 与类型错位都会在零
   mutation 下失败，dry-run 与 `--apply` 同样处理；错误只报告具体 managed path
   与类型。runtime 与 hooks.json 都通过同目录 staging + 原子替换发布。
3. 在 Codex `/hooks` 中 review 并信任 **Loading main-session instructions** 的
   exact definition。它仅在 root 的 `startup|resume|clear|compact` SessionStart
   上读取指定文件。`additionalContextLimit: 0` 配合脚本明确的 byte 上限，保证
   正文完整送达，避免默认阈值把长文本换成外部文件引用。
4. 先确认新的 root 请求自动收到完整私人说明，再将对应内容从共享 AGENTS 移出。
   共享 AGENTS 保留工程规则和 worker 边界。不要提前撤掉原有主会话输入。
5. 从新主 session 创建 `fork_turns="none"` 的 child，核对实际请求或等价可信证据。
   已加载旧私人 AGENTS 的主 session 不能因为磁盘更新就视为已清空。

hook 在缺失、空白、非 UTF-8 或超限文件上报告错误并返回 `continue: false`。
宿主对中止的具体处理仍需按版本验证。停用 hooks、撤销 trust 或移走文件后，
不应继续声称主会话自动加载正常。原生接口依据：[Codex Hooks](https://learn.chatgpt.com/docs/hooks)。
日常使用正常 review，不使用测试专用的 hook-trust bypass。

## 恢复与卸载

- 关闭/卸载 routing plugin 只改变后续调度；既有 child 仍需收拢。
- 将私人说明恢复到共享 AGENTS 会恢复旧的暴露边界。先停止派工，恢复原文并确认
  主会话正常加载，再移除本集成的 SessionStart handler。
- 不用旧备份覆盖整个 hooks.json。只撤销命令指向 `worker-routing/main_session.py`
  的 handler，保留安装之后其他来源的改动。
- 私人文件与备份由使用者保管。安装器不删除它们；重复安装同一路径不重复添加
  handler。改动 definition 后按原生流程重新 review。

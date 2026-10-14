# 安装、切换与恢复

[English](installation.en.md) | 中文

调度 plugin 与主会话上下文集成是两个独立安装面。只需要调度时安装 plugin 即可。

## Plugin

使用 Codex 内置 plugin-creator 将 `plugins/worker-routing` 注册到使用者自己的
personal marketplace。保留一个 canonical source 和一个 discovery 入口；先核对
同名目录归属，不能覆盖其他插件。

更新源码后，先用当前宿主的 `codex plugin marketplace list --json` 核对 marketplace
和源目录；为插件 manifest 更新版本（本次为 `0.4.1`），再通过正式
`codex plugin add worker-routing@MARKETPLACE --json` 重装。宿主若提供 bundled authoring
helpers，也可用它们验证 marketplace / 更新 cachebuster；不要假设旧 helper 路径仍存在。
不要热改 installed cache。安装后核对版本与源文件，并用新的主 session 验收 discovery。

默认与备用功能需要同时更新 canonical ACP source 和 plugin instructions；旧会话已加载的
说明不会自动刷新。已有 `routes.json` 与显式 `--route` 继续可用。
可选加入 `routing.default` 后，日常换 ACP 渠道只修改这份 Git 外配置；不要在
SessionStart 再复制当前 route 名。完整配置与撤回许可见[ACP 接入](acp-integration.md#默认与备用)。

## Delivery 与 swarm 升级

0.4.1 同步收窄 packaged swarm 与双语说明中的证据承诺：worker 自述、受信结果与索引中的
恢复线索保持分开；freshness 仍需独立核对。工具调用与 schema 保持兼容。

0.4.0 新增 `prepare` 工单装配与 `collect` 增量读取，并修复 batch 的取消准入、异常
结算、迟到句柄和输出预算边界。现有 run/continue、batch manifest 与历史回执兼容；
无需新增模型池或服务。`collect` 读取已结算结果，不提供逐项唤醒保证。

同时更新 canonical ACP source 并正式重装 plugin。0.3.0 包含共同 worker contract，
以及按需 recovery/Dispatch/swarm 方法；native 交接送入同一契约，ACP 在实际工单中装配。
已有 0.2.0 的 run/continue/control 调用与历史回执仍可使用。

日常工作没有新配置或报告表单。可选 --deliver 和有限 batch manifest 保存在 Git 外，
不改变 runtime 与验收的区分。共享 HOME 并发未知时在批次内串行，对应真实 route 的能力
需单独验证；不能为激活 swarm 复制凭据或改变默认。完整接口与边界见
[Worker 交付](worker-delivery.md)。

## Recovery 升级兼容事项

同时更新 canonical ACP source、插件和 operator 自己维护的命令模板。每次 `run` / `continue`
现在都必须显式带 `--permissions read|full`；缺省调用返回 `PERMISSIONS_REQUIRED`，不会启动
adapter、提交工单或写 state。已有调查转实施的续做需按当前授权带 `full`，category 不代替权限。
本次迁移不要求改动 provider、路由默认、workspace 授权或私人上下文隔离规则。

新 binding 用版本化 execution identity，动态检查当前 cwd 授权和权限上限。旧 binding 只在
完整旧 `routeFingerprint` 仍匹配时于续做锁内迁移。若旧指纹已因配置变化失配，停止并保留
status/cancel/close 恢复能力；不要盲改 hash 或恢复已撤回的权限。确认原 writer 停止、保留
成果后，再为剩余责任建立获准会话。历史 receipts 不重算；以前的 completed 记录不能据此
被宣称已经重新验证。新超时/取消规则只影响升级后的执行。

安装后的文件一致、下一主 session 的 skill discovery、真实 route 的执行是独立验收层。
已有聊天已加载的旧说明不会被安装动作替换；operator 应在续做前送入当前调用要求。
完整身份、deadline 和清理边界见[ACP 接入](acp-integration.md)。

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

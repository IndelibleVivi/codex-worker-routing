# 存储盘点与显式清理

[English](storage-management.en.md) | 中文

CWR 的执行 `cleanup` 负责连接、已观测的 adapter 进程和执行锁；它不表示历史数据已删除。
存储接口另行盘点磁盘，并为可证明属于 CWR 的 session scratch 提供计划与确认执行。
它不调用模型或 adapter，也不安装后台 GC。

## 查看

在 canonical checkout 中运行：

```sh
node integrations/acpx/src/cli.mjs storage --config /absolute/private/routes.json
node integrations/acpx/src/cli.mjs storage --config /absolute/private/routes.json --json
```

也可以打开 [Dispatch](dispatch.md) 的「存储空间」。这是当前磁盘快照，独立于协作统计的
时间窗口；扫描仅由打开该页、修改保留天数或主动刷新触发，不随协作统计自动轮询。
按 worker home 展示类型、大小与条目数，CWR state 单独列出。缺失、读取失败、达到扫描
上限或不安全条目会保留为说明，不能把不完整扫描当成精确总数。

- `bytes` 是逻辑大小，`allocated_bytes` 是文件系统提供的分配空间估算。
  压缩、稀疏文件、硬链接和文件系统快照会影响实际可释放空间；盘点不是释放证明。
- 扫描只读取文件元数据，以及判断所有权和生命周期所需的有界 CWR metadata。
  不读会话、日志或数据库正文，不跟随 symlink，不跨文件系统遍历。
- 会话历史、日志/数据库、runtime 状态/config、旧 tmp 和 cache 均可见，但只供检查。
  目录名、文件年龄和 `close` 本身都不是删除依据。

已删除 route 的旧 profile 可以临时指定，不必重新注册：

```sh
node integrations/acpx/src/cli.mjs storage --config /absolute/private/routes.json \
  --extra-home /absolute/private/retired-worker-home --json
```

`--extra-home` 可重复，始终只读；dashboard 也提供相同的临时目录输入。
它不会保存为 route，不扩大清理范围，也不扫描相邻目录。主目录本身、它的祖先、
与现行 worker home/workspace/state 相互重叠的路径，以及重复或重叠的额外目录会被拒绝。

## Scratch 的生命周期

新建责任使用 `stateDir/scratch/COMPACT_SESSION_ID/`，带有 CWR 所有权 manifest。
短目录名保留完整 session 身份，并避免把普通本地 socket 工具挤出路径长度限制。
`TMPDIR`（Windows 同时设置 `TEMP`/`TMP`）在整个 session 内保持一致，续跑沿用同一路径。
HOME、CODEX_HOME 和执行身份不因这项功能改变。新 binding 保存 scratch 所有权指针；
已知 managed manifest 丢失时明确拒绝续跑，不静默切换目录。早期 source 已创建的 v1
`workerHome/tmp/cwr-sessions/SESSION_UUID/` 继续使用原路径；没有 manifest 的既有 legacy
binding 仍沿用旧 tmp。两者都不搬运已有临时引用。v1 兼容读取只为已有责任保留，
待旧 manifest 与依赖它的 binding 生命周期全部核清后才可移除。

Unix socket 有平台路径长度上限；极长的自定义 `stateDir` 仍可能影响相关工具。
应选择短的本地 state root，而不是用 symlink 隐藏实际位置。

只有同时满足以下条件的受管 scratch 才可能成为候选：

1. manifest 与当前 state root、worker home、route、session 及其允许的精确物理位置完全匹配；
2. CWR binding 正常关闭，执行 cleanup confirmed，没有 active turn；
3. 没有保护该 session/workspace 的执行锁；
4. 完整且安全的扫描通过，从关闭时间与文件树最新活动两者较晚者计算保留时长；默认 7 天。
   缺少或无效的关闭时间、未来时间保持为未知，不成为候选。

原始 ACP/runtime 历史、工单、回执、数据库和日志不在清理范围内。旧 tmp/cache 没有补写
manifest，也不会因为目录看起来像临时文件而被自动升级成候选。

## 先预览，再执行

从 `storage --json` 的候选复制稳定 `id`，显式选择一项或多项；每份计划最多 64 项：

```sh
node integrations/acpx/src/cli.mjs storage-plan --config /absolute/private/routes.json \
  --target scratch-0123456789abcdef0123456789abcdef --older-than 7d
# 多项重复 --target；时长支持 7d、24h；all 表示不额外要求保留时长。
```

计划只写入 private `stateDir/storage`，不会改动候选原始文件。核对返回的 `targets`、
大小、路径和 `plan_id` 后，执行同一份计划并明确确认：

```sh
node integrations/acpx/src/cli.mjs storage-apply --config /absolute/private/routes.json \
  --plan PLAN_UUID --confirm PLAN_UUID
```

**执行永久删除所选受管 scratch，没有自动撤回。** Dashboard 使用相同后端：可先打开对应协作记录，确认需要的产物已保存到工作区，再选择候选 →
预览具体目录与大小 → 明确确认。取消预览保留原始文件。
执行前重新核对配置、所有权、binding、锁和文件树；计划过时或状态改变时应重新盘点与生成计划，
不要靠改 plan JSON 强行通过。部分删除会保留独立结果，不会报告全部成功或伪造完整释放量。
一份计划只执行一次；重复确认返回原来的终态回执，不重写结果或继续删除。
失败或部分完成后若仍需处理，先核查结果，再重新盘点与生成计划。

计划和 apply 回执留在 private state root；删除前先保存进行中的回执，正常结束后保存结果，
不会改写原 runtime receipt。若进程被杀死或崩溃，进行中回执与遗留锁是需要核查的未知状态，
不自动清锁、重试或宣称零删除。已确认删除的大小与未确认部分必须分开解读。
`cleanup: confirmed` 只覆盖已观测的执行资源，不能证明 adapter 逃逸的后台 writer 已全部停止。
它不是 OS sandbox。删除执行要求 macOS/Linux 上可用的 `lsof` 对确切目录做有界检查；
活跃 handle/cwd、检查失败、超时、警告或不支持的环境都会阻止删除。Windows 可盘点与预览，
当前删除执行没有受支持的 writer probe，因而拒绝执行；不会自动安装工具或跳过检查。
该检查只覆盖可观测的当前 handle，不能证明未来不会再有外部进程写入。

## Harness 与隐私边界

`integrations/acpx/src/storage.mjs` 是 CLI 和 dashboard 的共同后端：

```js
await inventoryStorage(config, options);
await planStorage(config, { targetIds, olderThanMs });
await applyStoragePlan(config, { planId, confirm });
```

JSON schema 分别为 `cwr.storage.inventory/1`、`cwr.storage.plan/1`、`cwr.storage.apply/1`。
这些是私有本机接口，可能包含 route、session ID、目录和文件元数据，不能直接公开。
Storage 不进入 Dispatch snapshot/share 白名单；分享卡不包含磁盘明细。
loopback HTTP 读写都要求私人 bearer token；清理 POST 另要求同源、JSON、有界输入与明确确认。
Windows 的 ACL 隐私仍由 operator 负责。

[返回文档目录](README.md)

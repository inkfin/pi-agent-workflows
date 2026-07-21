# Grove 数据模型、一致性与同步协议

Grove manifest 从 `v: 1` 开始。首个正式发布前，v1 是敏捷开发接口：允许直接修改并 squash 现有实现，不维护旧的 v1 形态、不增加迁移或双读分支。首个发布后，v1 即成为稳定格式；不兼容修改必须提升版本，并在读取边界提供明确的兼容或迁移策略。

Tree Repo 中的 Node 不符合当前 v1 manifest 结构时按非 Grove commit 处理。

## Manifest 与快照

Node manifest 以单行 JSON 存入 jj commit description，包含：

- **schema**：`v: 1`
- **身份**：稳定的 `projectId`、`sessionId`，以及 jj `change-id`
- **快照**：`snapshotId = sha256(content)`，内容存入 `objects/<snapshotId>.jsonl`
- **SessionAnchor**：`entryId + entryHash + ordinal + prefixHash`，用于验证对话位置；无法验证时从不可变快照物化
- **forkFrom**：`{ parentChangeId, parentSessionId, parentAnchor }`，作为 fork 父边的唯一来源
- **lifecycle**：auto Node 使用 `draft | pinned | published`
- **context_merge**：记录 `mergeOf[]`、`injectStrategy`、`payloadHash`，明确它是上下文注入而非代码合并

## 一致性与 undo

- **OperationCoordinator** 在逻辑操作前保存 intent 与 `preOpId`，步骤成功后写 receipt
- jj 步骤失败时用 `jj op restore <preOpId>` 回退；pi 与 jj 之间的中间态由本地 pending journal 在 `session_start` 检测
- `/grove undo` 撤销最近一个 Grove receipt，而不是假设一次 `jj undo` 等于一个业务操作
- jj operation log 仅属于本机，不同步，也不承诺跨机器 undo

## Harness 自动维护

- `agent_settled` 是自动快照边界；仅当工作区存在实际文件变化时创建或更新 auto draft
- 高置信度“覆盖、重做”可更新同一 change-id，但仅限无后继、未 pin、未 published 的 draft
- 其他情况创建新 Node，并通过 `supersedes` 保留关系
- UI 和 `/grove auto keep|replace|split` 允许用户覆盖自动判断

## 同步

- 每个 origin 只写 `grove/origins/<originId>` bookmark
- push 前创建 frontier Node，使本机所有可见 heads 都可经 Git remote 到达
- pull 获取各 origin bookmark，并按 jj DAG 合并可见集合
- Registry 是最终一致的索引：先 push Tree Repo，再更新 Registry；失败写 outbox
- 同步默认关闭，必须显式配置 private tree remote，并确认私有边界或启用 payload 加密
- redaction 是降低风险的管道，不是安全边界

## 关系

本 ADR 补强 ADR-0001 的 backend 能力和 ADR-0002 的同步细节，不改变 ADR-0003 关于 Entire 的结论。

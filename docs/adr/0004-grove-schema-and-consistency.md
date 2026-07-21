# Grove schema、一致性与同步协议

Grove schema 从 `v: 1` 开始。首个正式发布前，v1 直接演进，不维护旧的预发布
manifest、迁移器或双读分支；首个发布后，v1 才成为兼容边界。

领域模型已由 [ADR-0006](0006-grove-session-graph-and-outcomes.md) 收敛为
SessionNode、Edge、Attachment、RunLedger。本 ADR 记录仍然有效的存储、一致性和
同步约束。

## GraphTransaction 与 CAS

- jj commit description 保存单行 `GraphTransaction` JSON。
- `nodeId`、`edgeId`、`attachmentId` 是领域身份；jj change-id 只定位 transaction。
- Session Snapshot 孏入 `objects/<sha256>.jsonl`。
- Attachment payload 经 canonicalization、redaction 和大小约束后存入
  `objects/<sha256>.json`。
- SessionAnchor 使用 `entryId + entryHash + ordinal + prefixHash`；无法验证本地
  anchor 时从不可变 Snapshot 物化。
- draft amend 删除当前 revision 不再引用的 CAS 路径，但 jj/git 历史对象仍由
  历史和 GC 策略保留。

## 一致性与 undo

- `OperationCoordinator` 在逻辑操作前保存 intent 与 `preOpId`，成功后写 receipt。
- Tree Repo 写入由 in-process queue 和跨进程 writer lock 串行化。
- mutation 可携带 `expectedGraphRevision`；过期写者必须显式冲突，不能覆盖。
- Node + Edge + Attachment 作为一个 GraphTransaction 写入。
- jj 步骤失败时使用 `jj op restore <preOpId>`。
- journal 使用 `pendingOp + inboxBySession + receipts`，仅是可重建恢复缓存。
- `/grove undo` 撤销最近 Grove receipt；capture undo 额外写 proposal disposition，
  防止 session entry replay 复活成果。
- jj operation log 仅属于本机，不同步，也不承诺跨机器 undo。

## Harness

- Orchestrator 模式由 durable `grove-attachment-proposal` 驱动；Ask/Plan 文本和
  dirty 电平不能直接生成 outcome Node。
- `trackingMode` 为 `auto | outcome | legacy | off`。
- `auto` 在 session 存在 Orchestrator RunLedger 时使用 outcome capture，否则使用
  legacy dirty fallback。
- replacement 只允许 amend 同 slot、同 session、未 effective-sealed 的 draft。
- 用户可用 `/grove auto keep|replace|split` 覆盖 fallback 判断。

## 同步

- 每个 origin 只写 `grove/origins/<originId>` bookmark。
- push transaction 包含 frontier record 和未发布 Node 的 published revision。
- frontier 保存 semantic head nodeIds；物理 jj parent 只保证 records 可达。
- pull 获取各 origin bookmark，materializer 按稳定实体 ID 和 revision 重建 graph。
- Registry 是最终一致索引：先 push Tree Repo，再更新 Registry；失败写 outbox。
- 同步默认关闭，必须显式配置 private Tree Repo remote，并确认私有边界或启用 payload
  加密。
- redaction 只降低风险，不是安全边界。

## 关系

本 ADR 补强 ADR-0001 的 backend 能力和 ADR-0002 的同步细节；领域模型与 outcome
协议以 ADR-0006 为准，不改变 ADR-0003 关于 Entire 的结论。

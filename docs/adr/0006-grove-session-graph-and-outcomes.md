# ADR-0006：SessionGraph 与 Outcome Capture

## 状态

Accepted，2026-07-21。

## 背景

早期 Grove 直接把 jj change、jj parents、NodeKind 和 `draft | pinned | published`
同时用作领域身份、逻辑拓扑、成果类型和生命周期。这会造成几个问题：

- jj rebase/amend 会泄漏到用户可见身份。
- Build、Summary 等成果类型污染 NodeKind。
- 新增或删除逻辑连线需要重写 jj DAG。
- Ask/Plan 的 dirty 状态可能制造无意义节点。
- 并行 worktree 很难表达“同一 base 的多个 sibling outcome”。

## 决策

Grove 使用四个正交实体：

1. **SessionNode**：可导航的稳定会话状态点。`nodeId` 是领域身份，完整
   SessionSnapshot 和 SessionAnchor 用于恢复。
2. **Edge**：独立的 `lineage | context | supersedes` 逻辑关系。Edge 的增删不
   修改 Node，也不依赖 jj parents。
3. **Attachment**：不可变、内容寻址的成果，如 execution outcome、summary、
   plan、decision 和 context injection。Build/Summary 不是 NodeKind。
4. **RunLedger**：Orchestrator 的追加式运行事实，保留成功、失败和取消；
   只有 foreground 接受的 durable proposal 才进入 Grove。

每个 jj commit 存储一个 `GraphTransaction`。Transaction 可以原子包含
SessionNode、Edge、Attachment、Disposition 或 Frontier records。jj change-id
仅是 transaction locator，jj DAG 仅负责物理可达性、同步和本地 op restore。

## Capture 协议

1. Orchestrator 先追加 `orchestrator-run` session entry。
2. 值得持久化的最终结果再追加 `grove-attachment-proposal` entry。
3. EventBus `grove:proposal-pending` 只作为低延迟通知，不是真源。
4. Grove foreground writer 在 `session_start` / `agent_settled` 重扫 entries，
   校验 project/session/base/sequence/hash 后串行写 Tree Repo。
5. Worker 不加载 Grove，不写 journal，也不写 Tree Repo。

一个 slot 首次接受 durable proposal 时创建通用 SessionNode，并挂
Attachment。同 slot retry 可安全更新未封存 Node；旧 sequence 被拒绝。未采用的
worker candidate、普通 Ask/Plan 和中间 Summary 只存在 RunLedger。

## 封存与 pin

`pinned` 只表达用户保留意图。Node 的 effective sealed 状态由以下任一条件推导：

- 显式 `state === "sealed"`；
- 存在 active outgoing lineage edge；
- 用户 pinned；
- 已 published。

因此新目标开始时不提前修改旧 Node；只有后继 Node 成功落盘后，父 Node 才自然
不可 amend。

## 并行执行

编辑 Agent 必须接收显式 `baseNodeId + baseCodeRevision`，并在独立 worktree
运行。原始 outcome 先进入 RunLedger。Foreground 显式保留多个 outcome 时，
每个 outcome 通过独立 `SessionNode + lineage Edge + Attachment` transaction
成为同一 base 的 sibling。

代码 integration、提升 outcome 为 Grove Node、建立 context edge 是三个独立操作。

## 一致性与恢复

- Tree Repo 使用跨进程 writer lock 和 optimistic graph revision。
- journal 按 session 保存 inbox cursor、processed event IDs、pending intent 和
  receipts；它可由 session entries 与 GraphTransactions 重建。
- `/grove undo` 撤销 capture 后追加 proposal disposition，避免 restart replay
  复活节点。
- draft 替换会删除当前 revision 已不再引用的 snapshot/attachment CAS 路径；
  历史对象最终仍由 jj/git GC 管理。

## API 边界

Backend 暴露显式 `getGraph`、`getNode(nodeId)`、`applyGraphTransaction`、
`appendEdge`、`deleteEdge`、`appendAttachment`、`gotoNode(nodeId)`。

本阶段不实现完整拖拽节点编辑器，但 UI 不再依赖 jj parents，未来点击节点、增删
连线和提升 worktree outcome 无需更改领域模型。

## 后果

- Grove 用户图可在 jj 物理历史发生变化时保持稳定。
- Build/Summary 展示与会话拓扑解耦。
- 并行结果与跨机器 union merge 有明确身份和冲突边界。
- Backend 需要 materialize GraphTransactions，复杂度高于直接展示 jj log；
  这是支持可编辑 SessionGraph 的必要成本。

首个正式发布前继续原地演进 schema `v: 1`，不保留旧的预发布 manifest 读写分支。

# Pi Agent 个人工作流 — 开发路线图

## Phase 1：常用命令（先用上）

### 1.1–1.7
- [x] 见 git history（commands 层已完成；`/plan` 已移交 orchestrator）

---

## Phase 1.5：Orchestrator（Ask → Plan → Build）

> 架构：ADR-0005。前台模型对话/规划；worker 为 `pi --mode json` 子进程。

- [x] orchestrator extension + 配置 + 内置 scout/worker/reviewer/tester
- [x] 自主 Ask/Plan；Build 仅用户确认（面板 / `/build`）
- [x] `submit_plan` 结构化 ExecutionPlan + revision + openQuestions
- [x] `dispatch_research` 并行只读；Build 时 DAG 调度
- [x] 修改任务 git worktree 隔离；聚合为未提交改动；冲突不污染主工作区
- [x] 计划面板 + `/orchestrator` fallback
- [x] `tests/orchestrator-e2e.mjs` 纳入 `npm test`；`test:coverage` 设最低阈值

---

## Phase 2：Grove — 本地 session 树（jj-backed）

> 架构：ADR-0001 / ADR-0004。术语：CONTEXT.md。

> **交接快照（2026-07-21）**
> - **状态**：GraphTransaction v1 + SessionNode/Edge/Attachment + SessionAnchor +
>   foreground outcome capture + RunLedger 协议 + sync/registry 骨架完成。
> - **兼容策略**：首个发布前直接演进并 squash v1；发布后 v1 冻结为兼容边界。
> - **验证**：`npm test`（grove + orchestrator）。
> - **已知坑**：
>   1. jj `description.first_line()` 取单行 JSON
>   2. `nodeId != jj change-id`，semantic Edge 不能从 jj parents 推导
>   3. 不要注册 `/tree`
>   4. Worker 不写 Grove；session entry 是 proposal 真源，EventBus 只是通知
>   5. sync 默认关闭；需 `.pi/grove.json` + private 确认

### 2.1–2.4 基础骨架
- [x] TreeBackend + jj-cli + `/grove` + 清理 project-tree

### 2.5 加固（ADR-0004）
- [x] GraphTransaction v1 + stable nodeId + typed Edge + immutable Attachment（ADR-0006）
- [x] 内容寻址快照 `objects/<sha256>.jsonl` + 加强 redaction
- [x] SessionAnchor capture/resolve（compaction 检测）
- [x] OperationCoordinator（preOpId / receipt / writer lock / optimistic revision / logical undo）
- [x] fork pending intent + explicit parentNodeId/lineage Edge
- [x] outcome harness：RunLedger proposal、settled/restart reconcile、sequence fencing、legacy fallback
- [x] UI 使用 semantic graph；Build/Summary 作为 Attachment 展示
- [x] 显式 graph API（goto nodeId、append/delete Edge、append Attachment、promote seam）
- [x] sync：per-origin bookmark + frontier；privacy gate；`/grove sync config|push|pull`
- [x] registry：本地 catalog + outbox + dashboard
- [x] 图模型、siblings、幂等、恢复、undo disposition、CAS replacement 测试
- [x] 全屏 SessionGraph TUI：二维画布、semantic zoom、稳定配色、anchored thread overlay

---

## Phase 3：Grove Sync（深化）

- [x] 最小 tree push/pull + origin bookmark（见 sync.ts）
- [x] registry outbox / dashboard（本地；远端 registry remote 可后续接）
- [ ] 跨机 cherry-pick 完整 fetch 物化流程 dogfood
- [ ] payload 加密实现（当前仅 settings 开关）
- [ ] settings.local 分层文档化进 AGENTS

---

## Phase 4：代码维度（未来）

- [ ] manifest 的 code 字段从只读指针升级
- [ ] checkpoint 联动代码提交（可选）
- [ ] jj 作为项目 VCS 时拓扑对齐
- [x] orchestrator Build 成功后自动提出 execution outcome；foreground Grove 无感捕获
- [ ] 完整节点编辑器（拖拽连线、outcome promotion、workspace 切换）

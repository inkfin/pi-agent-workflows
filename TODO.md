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
> - **状态**：manifest v1 + coordinator + SessionAnchor + CAS snapshots + harness auto + 全功能 UI + sync/registry 骨架完成。
> - **兼容策略**：首个发布前直接演进并 squash v1；发布后 v1 冻结为兼容边界。
> - **验证**：`npm test`（grove + orchestrator）。
> - **已知坑**：
>   1. jj `description.first_line()` 取单行 JSON
>   2. fork 必须经 pending `forkFrom` intent，禁止猜父
>   3. 不要注册 `/tree`
>   4. sync 默认关闭；需 `.pi/grove.json` + private 确认

### 2.1–2.4 基础骨架
- [x] TreeBackend + jj-cli + `/grove` + 清理 project-tree

### 2.5 加固（ADR-0004）
- [x] NodeManifest v1（projectId、snapshotId、SessionAnchor、lifecycle、forkFrom、mergeOf）
- [x] 内容寻址快照 `objects/<sha256>.jsonl` + 加强 redaction
- [x] SessionAnchor capture/resolve（compaction 检测）
- [x] OperationCoordinator（preOpId / receipt / logical undo）
- [x] fork pending intent + forkFrom 父边
- [x] harness：`agent_settled`/`agent_end` auto draft；替换启发式；`/grove auto keep|replace|split`
- [x] 全功能 UI 键位与命令对等（goto/commit/fork/merge/pick/undo/auto/realign/sync/dashboard/pin）
- [x] sync：per-origin bookmark + frontier；privacy gate；`/grove sync config|push|pull`
- [x] registry：本地 catalog + outbox + dashboard
- [x] 测试覆盖

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
- [ ] orchestrator Build 成功后可选 `/grove commit` 联动

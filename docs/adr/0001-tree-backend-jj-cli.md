# Tree 后端：TS 编排 + jj CLI，git-backed 存储，Rust 后置

项目树（checkpoint DAG）的存储引擎选 jj，但**不引入 Rust**：扩展内定义 `TreeBackend` 接口，当前实现 shell out 到 `jj` CLI；tree repo 用 `jj git init`（git-backed，非 colocate）。

理由：

- **性能证据不支持 Rust**：jj 本身是 Rust，CLI 调用 ~10-50ms；TUI 热路径（j/k 导航渲染）是纯内存操作，jj 调用只发生在用户动作频率的场景（打开视图一次批量取数、checkpoint、fork、merge）。
- **边界约束**：jj 操作与 pi session 操作的"对齐"需要调用进程内 TS API（`switchSession`/`navigateTree`/`fork`），Rust 无法触达；对齐编排只能住在 TS 扩展里，Rust 最多拥有仓库事务与查询，价值有限。
- **jj-lib API 不稳定**：官方视为内部库，版本间 breaking，绑定等于钉版本追上游。
- **git-backed 存储**使物理层为普通 git objects：任何后端（CLI、未来的 jj-lib/git2-rs）均可读写，后端选型从一次性赌注变为可换实现；且 Phase 3 sync 直接获得 git remote 通道。

若未来 profiling 证明 CLI 是瓶颈，按同一 `TreeBackend` 接口做 sidecar（stdio NDJSON）替换，不用 napi（避免 Node ABI 与 prebuild 矩阵）。

ADR-0004 补充 `operationId` / `op restore`、bookmark 与同步能力；ADR-0006
把存储单位改为 GraphTransaction，并明确 jj change-id/parents 只属于 backend。
稳定 nodeId、typed Edge 和 Attachment 均在 `TreeBackend` 之上 materialize；这些
物理能力仍全部经 CLI shell-out。

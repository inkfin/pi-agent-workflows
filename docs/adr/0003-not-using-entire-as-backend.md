# 不以 Entire 作为 grove 后端

调查 Entire（entire.io，Go CLI + 托管平台）后决定：**借鉴其机制，但不作为 grove 的存储/捕获后端**，grove 继续走 ADR-0001 的自建 jj 路线。

核心原因是数据模型主干倒置，而非 git vs jj 的表象差异：

- Entire 以代码 git history 为主干，checkpoint 由 Git commit 驱动并与 commit 关联。grove 以对话 DAG 为主干，代码状态只是节点属性，纯对话探索（fork/context merge/命名检查点）也是一等节点。
- Entire 没有对话树概念：无 (session, entryId) 节点、无 fork 边、无对话级 merge/cherry-pick；checkpoint 是分支上的扁平记录。
- 无 jj 语义（change-id / op log / `jj undo` / revsets 全部缺失）。
- 由 git hooks 自动捕获驱动，面向 agent 无关的插件协议；grove 需要 pi 进程内的显式交互操作与 TUI。
- 其存储格式服务于 entire.io 云平台，跟随其演进是单向依赖。

借鉴项（已记入 docs/ref/entire.md）：pi 扩展捕获节奏、secrets redaction 管道、compaction 事件处理、settings 分层、Phase 4 代码维度的 UX（why/blame/doctor/recap）。

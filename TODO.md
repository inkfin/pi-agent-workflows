# Pi Agent 个人工作流 — 开发路线图

## Phase 1：常用命令（先用上）

### 1.1 项目初始化
- [x] `.pi/` 目录结构搭建
- [x] `package.json` — pi package 配置
- [x] `extensions/` 入口骨架
- [x] 共享工具 `extensions/shared/utils.ts`

### 1.2 /plan — 生成实现计划
- [x] `/plan <goal>` 命令注册
- [x] 读取当前项目上下文（CONTEXT.md、AGENTS.md 等）
- [x] LLM 生成分步实现计划
- [x] 结果写入 session 并展示结构化输出
- [ ] 支持 `/plan continue` 在已有计划上追加 (未来)

### 1.3 /review — 多维度代码审查
- [x] `/review` 命令注册（默认 diff 暂存区或最近 commit）
- [x] `/review <paths>` 审查指定文件
- [x] `/review --commit <hash>` 审查指定 commit
- [x] `/review --quick` 快速摘要模式
- [x] `/review --full` 附带完整文件内容
- [x] 8维度框架：正确性/完成度/文档/潜在问题/安全/可维护/测试/性能
- [x] 注入领域术语表 + 术语一致性检查
- [x] 结构化输出：评分表 + 详细发现 + 总体裁定

### 1.4 /commit — 生成提交信息
- [x] `/commit` 命令注册
- [x] 读取 `git diff --staged` 或 `git diff`
- [x] LLM 生成 Conventional Commit 格式消息
- [x] 可选自动 `git commit`（/commit:apply 确认后执行）
- [x] `/commit --amend` 修改最近提交信息

### 1.5 /todo — 项目任务管理
- [x] `/todo` 命令注册
- [x] `~/.pi/agent/todo/<project>.json` 持久化
- [x] `/todo add <task>` 添加任务
- [x] `/todo list` 列出任务（按优先级/状态）
- [x] `/todo do <id>` 标记进行中
- [x] `/todo done <id>` 标记完成
- [x] `/todo rm <id>` 删除任务
- [x] `/todo clear` 清理已完成任务

### 1.6 /context — 领域术语表管理（grill-with-docs 搭档）
- [x] `/context` 显示当前域术语表（解析 **Term**: def 格式）
- [x] `/context domains` 列出所有域（从 CONTEXT-MAP.md 发现）
- [x] `/context use <name>` 切换活跃域
- [x] `/context edit [name]` 编辑域术语表
- [x] `/context adrs [domain]` 列出 ADR
- [x] `/context adr "<title>"` 创建/查看 ADR
- [x] `/context reload` 重新加载上下文
- [x] `before_agent_start` 自动注入匹配域术语表
- [x] 域自动检测：匹配 prompt 中的路径/域名词
- [x] CONTEXT-MAP.md 多域解析（## domain-name + - path: ...）

### 1.7 上下文工程（跨命令共享）
- [x] `shared/context-builder.ts` — 统一上下文构建器
  - [x] 领域发现（CONTEXT-MAP.md 解析）
  - [x] 术语提取（**Term**: def）
  - [x] ADR 发现
  - [x] 域检测（prompt 内容评分匹配）
  - [x] `buildContextSections()` + `renderContextSections()`
- [x] `/plan` 注入领域术语表 + ADRs + git 状态
- [x] `/review` 注入领域术语表 + 术语一致性检查
- [x] `/commit` 注入领域术语表（更好的 scope 推导）
- [x] `context.ts` 复用共享 context-builder（去重）

---

## Phase 2：Grove — 本地 session 树（jj-backed）

> 架构决策见 docs/adr/0001（TS 编排 + jj CLI + git-backed）。
> 术语见 CONTEXT.md（Node / Checkpoint / Tree Repo / Session Snapshot）。

> **交接快照（2026-07-20）**
> - **状态**：v1 骨架完成并验证。backend（jj-cli）/ 映射层 / `/grove` 全子命令 / 交互 UI 均可用。
> - **验证**：`npm test`（14 项 e2e+单元检查，需 jj on PATH）。dogfood：本项目跑 `pi`，`/grove commit "..."` → `/grove` 树视图 → `s` goto → `u` undo。
> - **下一步入口**：2.5 加固（dogfood 迭代优先）→ Phase 3 registry。
> - **已知的坑（勿复踩）**：
>   1. jj 模板 `description` 自带尾换行——取数必须 `description.first_line()`（单行 JSON manifest）
>   2. `ctx.switchSession`/`ctx.fork` 后旧 `ctx` 即失效——错误上报须提前快照 `ctx.ui.notify`；`withSession` 里只用 `replacementCtx`
>   3. 扩展命令优先于内置命令——不要注册 `/tree`，会屏蔽 pi 内置 undo-tree
>   4. fork 节点由 `session_start(reason:"fork")` 统一捕获——任何调用方不要再手动登记，否则重复
>   5. 测试加载 UI/commands 需要 jiti alias 打桩 `@earendil-works/pi-tui`（见 tests/stubs/）

### 2.1 TreeBackend 接口与 jj 实现
- [x] `extensions/grove/backend/types.ts` — TreeBackend 接口（init/node/commit/fork/goto/log/undo）
- [x] `extensions/grove/backend/jj-cli.ts` — shell out 实现（`--no-pager`，\x1f 分隔符取数）
  - 坑：jj `description` 模板自带尾换行，必须用 `description.first_line()` 取单行 JSON
- [x] `jj git init` 初始化 `<project>/.pi/tree/`（colocated），root 节点 describe + repo 内 .gitignore
- [x] 加载时检测 jj 存在与最低版本（`JjCliBackend.checkAvailability`），缺失则 grove 静默
- [x] 懒初始化：session_start 不为任何项目自动建仓，首个 grove 操作才建仓

### 2.2 映射层（pi ↔ jj 对齐，TS 编排）
- [x] manifest = jj commit description 单行 JSON（不建独立 manifest 文件，一次 `jj log` 取全拓扑+元数据）
- [x] checkpoint：快照当前 session 进 `sessions/<basename>.jsonl` + `jj new` + `jj describe`
  - 捕获节奏参考 Entire：`agent_end` 落稳定快照，快照缓存目录中转（docs/ref/entire.md）
- [x] **redaction 管道**：快照进仓库前 secrets 检测打码（v1 naive 模式，待加强）
- [ ] **compaction 对齐**：pi compact 后 entryId 有效性与快照 offset 处理（Entire 踩过的坑）
- [x] fork：`ctx.fork(entryId)` + `session_start(reason:"fork")` 统一捕获为 fork 节点
- [x] goto：同 session `navigateTree` / 跨 session `switchSession`，对齐 `jj edit`；快照缺失时物化
- [x] 身份：change-id 定 Node、session basename 定 Session、machine-id（XDG config）作 origin、project（git remote/basename）
- [x] 并发 naive：进程内 op queue 串行（backend enqueue）
- [ ] fork：`ctx.fork(entryId)` 对齐 `jj new <rev>`，记录 fork 父子
- [ ] goto：同 session `navigateTree` / 跨 session `switchSession`，对齐 `jj edit`
- [ ] 身份：change-id 定 Node、uuid 定 Session、machine-id（XDG config）作 origin、projectId（git remote 哈希/basename 兜底 + 本地绑定）
- [ ] 并发 naive：进程内 op queue 串行；跨进程靠 jj 锁，失败提示重试

### 2.3 `/grove` 命令与交互 UI（不屏蔽内置 /tree）
- [x] `/grove` — jj-log 风格树视图：◆ checkpoint、⑂ fork、⊙ merge、◇ root、@ 当前、origin/dirty 元信息
- [x] 操作键：Enter 详情、s goto、c commit、f fork、m merge、p pick、u undo、q 关闭
- [x] 非交互子命令：`commit/goto/fork/status/log/undo/merge/pick`，`sync` 为 Phase 3 占位
- [x] `/grove status` — @ 位置、当前节点、code dirty 标记
- [x] undo：包装 `jj undo`（pi 侧逆操作为 best-effort）
- [x] merge / cherry-pick：context-inject（读源快照摘要 → sendUserMessage），merge 记双父节点
- [ ] UI 打磨：真实 jj 多列图渲染（当前为缩进树）、折叠、状态栏刷新时机（dogfood 后迭代）

### 2.4 清理（已完成）
- [x] 删除旧 branch 模型实现（`.pi/extensions/project-tree/`）与遗留 `state.json` —— 不做迁移（未对齐，个人项目无历史包袱）
- [x] backend 改 `--no-colocate`（与 ADR-0001 一致；工作区无内嵌 `.git`）
- [x] 持久化测试 `tests/grove-e2e.mjs`（`npm test`，14 项检查）

### 2.5 加固（下一阶段入口）
- [ ] **dogfood 迭代**：在本项目日常使用，收集手感问题
- [ ] **compaction 对齐**：pi compact 后 entryId 有效性与快照 offset（Entire 踩过的坑，docs/ref/entire.md）
- [ ] redaction 规则加强（当前仅 sk-/AKIA/ghp_/JWT 四类 naive 模式）
- [ ] settings 分层：registry 退出等项目级配置应入仓共享，个人偏好走本地（参考 Entire settings.local 分层）
- [ ] UI 打磨：真实 jj 多列图渲染（当前缩进树）、折叠、status bar 刷新时机

---

## Phase 3：Grove Sync（registry + 跨机 fetch）

> 架构决策见 docs/adr/0002（每项目 tree repo + 中心元数据 registry，否决 mono-repo）。

### 3.1 Registry（中心元数据仓）
- [ ] XDG 数据目录初始化 registry jj repo（git-backed），配置中心私有 remote
- [ ] `projects/<projectId>.json` 元数据：{ name, vcsRemote?, treeRemote, machines[], sessions摘要[] }
- [ ] push 项目 tree 后联动更新 registry 记录并 push registry
- [ ] 项目级 `registry: false` 退出注册（安全阀）

### 3.2 同步命令（显式，人/agent 均可触发）
- [ ] `/grove sync push` — push 当前项目 tree repo + 更新 registry
- [ ] `/grove sync pull` — pull registry，刷新跨机视图
- [ ] `/grove dashboard` — 跨机 session 列表（origin、lastActiveAt、staleness 可见）
- [ ] 跨机 cherry-pick：registry 指路 → 从对应 treeRemote fetch 快照 → context-inject 到当前对话
- [ ] 跨机继续 session：快照物化到本机 sessions 目录 → switchSession

### 3.3 隐私
- [ ] 文档写死：tree remote 与 registry remote 必须为私有仓库
- [ ] XDG config 预留 key 字段（v2 加密占位）

---

## Phase 4：代码维度（未来）

- [ ] manifest 的 code 字段从只读指针（rev + dirty）升级
- [ ] checkpoint 联动代码提交（可选）
- [ ] merge / cherry-pick 的代码联动
- [ ] jj 作为项目 VCS 时拓扑对齐（对话树 ≡ 代码 DAG）

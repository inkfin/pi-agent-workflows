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

## Phase 2：Project Tree（本地开发树）

### 2.1 数据模型
- [x] `extensions/project-tree/state.ts` — ProjectTree / Branch 类型定义
- [x] `.pi/tree/state.json` 读写（项目级）
- [ ] 从现有 session 文件反向构建初始 tree（迁移脚本）

### 2.2 分支命令
- [x] `/branch` — 打开 tree 主视图（tig 风格交互 UI）
- [x] `/branch create <name> [desc]` — 从当前位置创建新分支
- [x] `/branch switch <name>` — 切换到已有分支
- [x] `/branch rename <name>` — 重命名当前分支
- [x] `/branch archive [name]` — 归档分支
- [x] `/branch list` — 非交互式列表

### 2.3 Tree View UI（重点打磨）
- [x] 主视图：分支树 + 摘要信息
  - [x] ● / ○ 区分本地/远程分支
  - [x] 每个分支显示 message 数量、最后活跃时间、描述
- [x] 展开/收起分支（Enter）
- [x] 分支详情面板：消息列表、涉及文件
- [x] j/k 导航、s 切换、m merge、c create、a archive、r rename 快捷键
- [x] 树形绘制（├── └── │）
- [ ] 🟡 标记未同步分支（Phase 3）
- [ ] 标题栏状态指示器

### 2.4 分支合并
- [x] `mergeBranchIntoCurrent()` — context-inject 合并策略
- [x] 在 tree view 中按 m 触发合并
- [x] 将源分支摘要注入当前对话
- [ ] Full switch 合并策略（= /branch switch 已覆盖）
- [ ] merge dialog UI（选择策略）

### 2.5 将 /fork 重定向
- [ ] 拦截 pi 原生 `/fork`，引导用户使用 `/branch create`
- [ ] 或保持兼容，但创建时同时注册为 tree branch

---

## Phase 3：Sync（基于 Tree 的同步）

### 3.1 Remote 配置
- [ ] `extensions/sync/transport.ts` — ssh + rsync 传输层
- [ ] `/sync remote add <name> <host> [path]` — 配置 remote
- [ ] `/sync remote rm <name>` — 移除 remote
- [ ] `/sync remote list` — 列出 remotes

### 3.2 Push/Pull
- [ ] `extensions/sync/tree-sync.ts` — tree 级别同步逻辑
- [ ] `/sync push [remote]` — 推送本地 tree + sessions
- [ ] `/sync pull [remote]` — 拉取 remote tree + merge 到本地
- [ ] 同步点（sync point）机制：记录每个分支的 last-synced-entry-id
- [ ] /sync status 显示每个分支的同步状态

### 3.3 冲突处理
- [ ] 同名分支来自两个 source → 冲突标记为需要 resolve
- [ ] `/sync conflicts` 列出冲突
- [ ] 冲突处理 UI：
  - [ ] 保留两个（远程重命名）
  - [ ] 丢弃远程
  - [ ] 丢弃本地
  - [ ] inspect 后决定

### 3.4 状态指示器
- [ ] 标题栏显示 sync 状态（🟢/🟡/🔴）
- [ ] branch tree 中标记远程分支来源

---

## Phase 4：高级能力（未来）

### 4.1 跨分支共享状态
- [ ] Shared Context 数据模型（`shared.json`）
- [ ] `/branch share "<decision>"` — 提升决策到项目级共享上下文
- [ ] Agent 自动感知 shared context

### 4.2 完善与打磨
- [ ] 完整 README 和安装文档
- [ ] 错误处理和边界情况
- [ ] 主题支持（跟随 pi 主题）

### 4.3 发布
- [ ] npm package 发布
- [ ] 安装使用指南

---

## 设计决策记录

| 决策 | 记录 |
|------|------|
| 常用命令最先交付 | 可以独立使用，不依赖 tree/sync |
| 一个 branch = 一个 pi session 文件 | 不修改 pi 内核，在上层做项目管理 |
| /fork → /branch | 统一分支概念，/fork 变成 /branch create |
| sync 不自动执行、不后台监听 | 用户显式 push/pull，类似 jj |
| 冲突 = 树上的分支差异 | 不单独存冲突文件，利用 pi session tree |
| 合并手段 = context inject | 不尝试自动合并消息内容 |

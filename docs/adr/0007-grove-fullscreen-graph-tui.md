# ADR-0007：Grove 全屏 SessionGraph TUI

## 状态

Accepted，2026-07-21。

## 背景

原 `/grove` 使用单列 `GroveTreeView`。它能显示 lineage 和少量技术元数据，
但没有 viewport、搜索、缩放、关系可视化或 SessionNode 对应的对话内容。节点较多
时，整棵树和十四个快捷键会一起挤入 Pi 的 editor 区域。

Pi 0.80 的扩展 API 可以用 `ctx.ui.custom()` 临时替换 editor slot，并向
`@earendil-works/pi-tui` 提交可聚焦组件和 overlay。它不能替换
`InteractiveMode` 持有的 chat/header/editor/footer 根布局。

## 决策

### 宿主边界

`/grove` 打开一个按需进入的近全屏 GraphWorkspace，退出后恢复原聊天与输入。
本阶段不 fork Pi，也不实现聊天与画布常驻分栏。若未来需要替换根布局，改用
RPC/SDK 自定义宿主或向 Pi 上游增加 layout hook。

### 图布局与画布

- `GroveGraph` 是唯一数据源；用户拓扑不从 jj parents 推导。
- active lineage Edge 决定从左到右的 rank，context 与 supersedes 只参与绘制。
- layout 对 root、orphan、cycle 和多 parent 输入给出确定性降级。
- ANSI cell buffer 在 viewport 内裁剪；所有文字经过可见宽度和 CJK 安全处理。
- 节点颜色由稳定 `nodeId` seed 和相邻冲突消解产生。颜色只是辅助编码；
  current、selected、draft 和 sealed 同时使用 glyph 与边框表达。

### 交互与缩放

方向键或 hjkl 按空间方向选择最近节点，Tab 按稳定顺序切换；大写 HJKL 平移
camera。选择、平移、fit 和 zoom 使用短 ease-out 动画，连续输入直接更新最新
target，不累积动画队列。

Pi 未公开鼠标滚轮或触控板 API，因此缩放使用 `+/-/0/z`。camera zoom 范围为
0.5x–2.0x；节点内容在 overview、normal、detail 三个阈值间做 semantic zoom。

### Anchored Chat Thread

Enter 在画布上方打开 floating ThreadWindow，`m` 可最大化，Esc 返回原画布。
窗口优先读取本地 session，缺失时读取 Tree Repo 中的 content-addressed
snapshot。解析器必须沿 `parentId` 回溯到 SessionAnchor，只显示该 Node 所代表
的 branch，不显示 anchor 之后的 turns。

ThreadWindow 是只读视图。异步加载使用 generation token 和 nodeId 校验，结果
按 nodeId 缓存；切换节点、最大化或关闭 workspace 时不得遗留 overlay、focus
或 animation timer。

### 写入边界

GraphWorkspace 继续只返回 `GroveViewResult`。所有 goto、fork、inject、pin、
undo、auto 和 sync 操作仍由 foreground `handleViewResult` 与 `TreeBackend`
执行。首版不直接创建、拖拽或删除 Node/Edge。

## 后果

- Grove 可以在 80x24 终端降级使用，并在宽终端显示 minimap 和更多视觉层级。
- 50 个以上节点通过 camera 和 viewport 操作，不再一次渲染成超长列表。
- 对话预览严格绑定 SessionAnchor，避免把未来 turns 错配给历史节点。
- 扩展仍受 Pi 固定根布局约束；“近全屏”依赖组件占据当前 viewport，而不是拥有
  独立 alternate screen。
- 完整节点/连线编辑、鼠标手势和常驻 split-pane 继续后置。

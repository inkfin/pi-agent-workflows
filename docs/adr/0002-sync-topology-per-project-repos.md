# 同步拓扑：每项目独立 tree repo + 中心元数据 registry，否决全局 mono-repo

多机同步采用双层结构：**每个项目一个 jj tree repo**（`<project>/.pi/tree/`，git-backed，各自 remote，存 session 快照与节点 manifest）；**一个全局 registry repo**（XDG 数据目录，单一中心 remote，只存项目/会话元数据，不存内容）。全局可见性在 UX 层整合：pull registry → 展示跨机 session 列表 → 按需从对应项目 remote 拉取快照。

否决"整台机器一个 mono-repo"的原因：mono-repo 只有一个 remote，会把工作项目与个人项目的 session 数据混在同一同步边界内；而 tree remote 的边界必须等于协作/隐私边界（工作项目走工作 remote，未来甚至可能组内共享 tree）。按项目拆分后，registry 只沉淀元数据（项目名、remote 地址、session 摘要、机器出处），跨机发现能力不损失，内容流动仍按项目隔离。

附加决策：

- 同步保持显式 push/pull（人或 agent 通过命令触发），无后台自动同步。
- 项目可声明 `registry: false` 退出中心注册，应对"元数据也不许出本机"的场景。
- cherry-pick 语义推广为：把任意机器、任意项目的 turn 注入当前对话（context-inject），不要求本机存在源项目。

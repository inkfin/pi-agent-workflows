# Entire (entire.io) — 参考调查

> 原始笔记：看起来和我们的思路相似——把 session 存进代码库内的一个独立 git repo，并把版本化代码和 session 绑定。区别表面上只是它用 git 我们用 jj。

## 2025-07 调查结论

**真正的差异是主干倒置**：Entire 以代码 git history 为主干、checkpoint 由 Git commit 驱动并与 commit 关联；grove 以对话 jj DAG 为主干、代码状态是节点属性（零代码改动也是一等节点）。

**机制**：Go CLI 装 git hooks；pi 支持 = 项目级 TS 扩展 `.pi/extensions/entire/index.ts`，监听 session_start/before_agent_start/agent_end/session_shutdown，读 `~/.pi/agent/sessions/`（或 `PI_CODING_AGENT_DIR`）的 JSONL，快照缓存 `.entire/tmp/pi/`，存储到 `entire/checkpoints/v1` 分支（可配独立仓库/纯本地）。插件协议：stdin/stdout JSON（get-session-id/read-session/write-session/parse-hook），事件含 SessionStart/TurnStart/TurnEnd/Compaction/SessionEnd。

**不当后端的原因**：见 docs/adr/0003。

**可借鉴**：
- 捕获节奏：agent_end 落稳定快照 + 快照缓存目录 + PI_CODING_AGENT_DIR 兜底
- Redaction 管道：存盘前 secrets 打码（比我们纯私有 remote 多一层）
- Compaction 事件处理：pi compact 后 entryId/快照对齐是我们没想的坑
- Settings 分层：项目共享 vs 个人本地（registry 配置应为项目级共享）
- Phase 4 UX：`why <file/line>`、checkpoint blame、`doctor`、`recap`

**共存**：同项目可同时装 entire 扩展与 grove，事件互不阻塞。

来源：https://entire.io/ · https://docs.entire.io/ · https://docs.entire.io/agents/pi.md

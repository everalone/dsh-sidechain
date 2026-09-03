# Sidechat context = fork-inherited completed turns, not manual attachments

`dsh-sidechain` 的侧边会话（/side、/btw）采用 Codex CLI `/side` 的 fork 语义：子会话一次性继承主会话已完成回合作为参考上下文，边界提示声明"仅参考、非指令"；侧链面板不提供 Codex IDE sidechat 式的任意文件拖拽附件。这是 2026-09 与用户逐项确认后的明确取舍——"面板不能拖文件"是设计决定，不是缺口遗漏，后续若做进本体，此决策仍然成立。

**Considered Options** — 对齐 Codex IDE sidechat（手动附件式：不自动继承，每次由用户勾选会话/文件）被否决：它要求给面板输入框增加附件序列化与提交链路，与"快速提问、不打断主线"的目标冲突；fork 继承已经免费提供"结合当前会话上下文"这一核心价值，且快照边界（进行中回合不继承、之后的新回合不同步）正是"不污染上下文"的代价。

**Consequences** — fork 种子是创建时刻的快照；面板文件提及只针对子会话自己产出的文件。若未来需要 IDE 式附件，作为新能力叠加，而不是替换 fork 语义。

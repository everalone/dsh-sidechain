# dsh-sidechain

DSH 侧会话插件：`/side` 与 `/btw` 在当前会话的**临时 fork** 里开一个侧会话（对齐 Codex `/side` & `/btw`——"start a side conversation in an ephemeral fork"）。侧会话继承当前会话的已完成上下文，但**不进主会话历史**；主线程不受影响、继续运行。

| 命令 | 行为 |
|---|---|
| `/side <问题>` | 创建**可续聊的命名侧线程**，自动跳转到侧会话视图 |
| `/side list` | 列出本会话的全部直接子代理 |
| `/btw <问题>` | **一次性侧问**：答案内联返回，自动跳转到侧会话回看 |

## 安装

前置：DSH 快照（含 `lib/`）+ `dsh web` 运行中。依赖插件（`dsh-subagent`、`dsh-subagent-fork`、`dsh-commands`）默认 profile 已含，无需额外安装。

```sh
git clone https://github.com/dsh-external/dsh-sidechain.git
cd dsh-sidechain && pnpm install
dsh plugin --profile web add link:/path/to/dsh-sidechain
```

配置行（`$DSH_HOME/profiles/web/cordis.patch.yml`；0805 旧机制为 `~/.dsh/config.yaml`）：

```yaml
- insert:
    - id: dsh-sidechain
      name: '@dsh-external/dsh-sidechain'
```

> 配置行的新增/移除热生效、无需重启；插件代码更新需重启 `dsh web` 并刷新页面。

## 配置

| Key | 默认 | 说明 |
|---|---|---|
| `providerName` | `fork` | `ctx.subagents` 上的 provider 名 |
| `persona` | 内置侧会话 persona | 侧会话行为约束（只读探索、不主动改文件、禁子代理）；空字符串 = 不覆盖部署 persona |
| `readOnlyTools` | 无 | 侧会话工具 allow-list（如 `["read","grep","glob"]`）；缺省不限制 |
| `maxResultChars` | `8000` | `/btw` 答案内联返回的最大字符数（超出截断） |
| `btwTimeoutMs` | `120000` | `/btw` 运行预算（毫秒），超时取消子代理并返回错误；`0` = 不限 |

## 使用

- `/side 调研一下 session-query 的 FTS 索引` —— 创建命名侧线程并自动跳转过去
- `/side` —— 创建空侧线程（等待你的第一个问题）
- `/side list` —— 列出本会话的全部直接子代理
- `/btw 这个目录下哪个文件最大？` —— 一次性侧问，答案内联返回（末尾的 `(btw session: <id>)` 是跳转标记），随后自动跳转到侧会话回看

侧线程也可以从**父会话标题行的子代理目录按钮**进入：continuable 侧线程保留完整输入框可继续对话；侧线程不出现在左侧边栏；重启后从子代理目录冷恢复。

## 验证

1. `/btw 1+1=?` → 答案内联返回并自动跳转到侧会话视图，主会话历史不出现该问答。
2. `/side 检查一下当前工作区状态` → 自动跳转到新侧线程，主会话继续正常干活。
3. 重启 `dsh web` 后从子代理目录再次进入侧线程，历史从持久化日志恢复。

## 已知限制

- fork 只继承父会话**已完成回合**；进行中的回合不包含。
- `/btw` 是一次性运行，无后续轮次；多轮侧聊请用 `/side`。
- `/side list` 列出的是本会话全部直接子代理（含模型委派的），不限于侧会话。

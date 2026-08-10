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

- `/side 调研一下 session-query 的 FTS 索引` —— 创建命名侧线程，**主会话保持不变**，侧线程对话显示在右侧链面板
- `/side` —— 创建空侧线程（等待你的第一个问题）
- `/side list` —— 列出本会话的全部直接子代理
- `/btw 这个目录下哪个文件最大？` —— 一次性侧问，答案内联返回（末尾的 `(btw session: <id>)` 是跳转标记），完整执行记录在侧链面板查看

## 侧链面板（右侧边栏，主会话同屏）

会话标题行新增**侧链按钮**（🌿 图标）：点击在 Web UI **右侧**打开一个浮动侧边栏，列出当前会话的全部 `/side` 与 `/btw` 子代理。

- **列表**：每行显示子代理标题、类型（`/side 可续聊` / `/btw 一次性`）、运行状态（绿点运行中/灰点已结束）；标题行按钮带**运行中数量角标**
- **只显示你自己的侧链**：面板隐藏平台的常驻侧代理（Harness 为每个主会话自动挂的 background coding agent，标签固定为 "Side conversation"）——它不是你发起的 `/side`/`/btw`，不会在面板里"自己说话"；`/side` 空线程的标签改为短标记 `Side` 以便区分
- **嵌入对话**：点击行 → 面板内直接渲染该子代理的对话（`subagent.history` 转录），**主会话视图保持不变**；`/side` 可续聊的子代理底部有**输入框**，Enter 直接继续侧聊（`subagent.prompt`）；`/btw` 一次性子代理显示只读提示
- **实时性**：子代理运行时按 1.2s 轮询转录尾部页，`assistant/chunk` 文本增量**流式累加渲染**（答案逐字滚动出现），步骤完成时替换为最终消息；结束后自动定格；目录本身也实时订阅
- `/side` 或 `/btw` 命令成功后**自动弹出面板并选中新子代理**，立即看到它的对话；不再切换主视图
- 手动刷新、错误重试、空态提示一应俱全；「返回列表」回到目录

实现说明：面板是插件自带的浮动覆盖层（`position: fixed` 右缘），不修改主仓库布局；成员数据复用运行时的子代理 catalog（`sessions.list.subagentsByParent`），对话内容走 catalog 的 `subagent.history` / `subagent.prompt` RPC。面板**不挂载任何客户端会话**（不调用 `sessions.binding` / 会话订阅）：冷会话在运行时里会丢弃实时事件帧（`acceptLiveEvent` 对未 open 的会话直接返回），订阅拿不到实时数据，且额外实例化会话会干扰运行时的会话 staging——轮询是纯 RPC 消费者，最稳妥。

转录处理要点：侧链子代理的日志**以继承的父会话完整历史开头**（fork seed），映射按最后一个 `session/end-seed` 事件裁掉继承部分、丢弃 "Side conversation boundary" 边界行，只显示侧链自身的对话；实时文本来自 `assistant/chunk` 的 `text-delta` 增量（`assistant/message` 要步骤结束才落盘）；尾部窗口按消息数取 20 条，控制轮询响应体积（继承历史可达数万 chunk 事件）。

## 验证

1. `/btw 1+1=?` → 答案内联返回，侧链面板自动弹出并显示该侧问的完整对话，主会话保持原样。
2. `/side 检查一下当前工作区状态` → 面板弹出并实时显示侧线程执行过程，主会话继续正常干活。
3. 在面板里对 `/side` 子代理输入新消息 → 侧线程继续回答，主会话不受影响。
4. 重启 `dsh web` 后打开侧链面板，冷子代理的转录从持久化日志恢复。

## 已知限制

- fork 只继承父会话**已完成回合**；进行中的回合不包含。
- `/btw` 是一次性运行，无后续轮次；多轮侧聊请用 `/side`。
- `/side list` 列出的是本会话全部直接子代理（含模型委派的），不限于侧会话。

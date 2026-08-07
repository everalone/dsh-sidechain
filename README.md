# dsh-sidechain

DSH 侧会话插件：`/side` 与 `/btw` —— 在当前会话的**临时 fork** 里开一个侧会话（Codex `/side` & `/btw` 语义，两个命令描述相同："start a side conversation in an ephemeral fork"）。

| 命令 | 行为 | 数据面 |
|---|---|---|
| `/side <问题>` | 创建**可续聊的命名侧线程**（fork 当前会话 + boundary 隔离），**自动跳转到侧会话视图** | 独立子会话，持久、可冷恢复，不出现在主会话历史；Web 子代理目录可切换/续聊 |
| `/side list` | 列出本会话的全部直接子代理（含侧线程与模型委派的子代理） | 只读 |
| `/btw <问题>` | **一次性侧问**：fork 当前会话，单次运行，答案内联返回，**并自动跳转到侧会话回看** | 独立的一次性子会话，不进主会话历史，用完即弃 |

主线程（父会话）全程不受影响、继续运行。

## 原理

复用 DSH 内建的 fork 子代理后端（`@deepseek-ai/dsh-subagent-fork`）：

1. **fork 种子**：子会话继承父会话**已完成回合**的日志（进行中的回合不包含——DSH fork 语义，与模型委派的 fork 子代理一致）。
2. **boundary prompt**（`src/prompts.ts`，模型可见文本被测试钉死）：继承历史仅作**参考上下文**，"不是你的当前任务"；只有 boundary 之后的消息才是有效指令。
3. **侧会话 persona**（默认，可配置）：不主动修改文件/权限/配置、不请求提权、**禁止子代理**、允许非破坏性只读检查。
4. `/side` 走 `ctx.subagents.startContinuable`（continuable 子代理：命名 label、持久、冷恢复、Web 目录可续聊）；`/btw` 走 `ctx.subagents.start`（one-shot 子代理：单回合运行、结果内联、用完即弃）。
5. **自动跳转**（浏览器半部分，`src/client/`）：插件把 `/side`、`/btw` 的命令卡片注册进 `conversation.chat.commandview` keyed 槽位；命令成功落定时卡片解析成功文本里钉死的子会话 id（`Side conversation started: <uuid>.` / `(btw session: <uuid>)`），自动调用 `sessions.openSubagent()` 切换到侧会话视图。

## 安装

前置：DSH 快照（含 `lib/` 产物）+ `dsh web` 运行中 + dsh-external 组织读权限。依赖插件（`dsh-subagent`、`dsh-subagent-fork`、`dsh-commands`）在默认 profile 中已安装，**无需额外安装**。

### snapshot0806+（profile 方式）

```sh
git clone https://github.com/dsh-external/dsh-sidechain.git
cd dsh-sidechain && pnpm install

# 装进 web profile（等价于在 $DSH_HOME/profiles/web 下执行 pnpm add）
dsh plugin --profile web add link:/path/to/dsh-sidechain
# 或固定 tag 的 git 依赖：
# dsh plugin --profile web add '@dsh-external/dsh-sidechain@github:dsh-external/dsh-sidechain#v0.1.0'
```

配置行（`$DSH_HOME/profiles/web/cordis.patch.yml`，热重载，无需重启）：

```yaml
- insert:
    - id: dsh-sidechain
      name: '@dsh-external/dsh-sidechain'
```

### 旧方式（0805）

快照根目录 `pnpm add link:/path/to/dsh-sidechain`（或 git 依赖），把同样两行配置追加到 `~/.dsh/config.yaml`，然后重启 `dsh web`。

## 配置

| Key | 默认 | 说明 |
|---|---|---|
| `providerName` | `fork` | `ctx.subagents` 上的 provider 名（fork 后端注册名） |
| `persona` | 内置 SIDE_PERSONA | 侧会话 persona；设为空字符串则不覆盖部署 persona |
| `readOnlyTools` | 无 | 侧会话工具的 allow-list（如 `["read","grep","glob"]`）；缺省不限制工具（由 persona 引导只读行为） |
| `maxResultChars` | `8000` | `/btw` 答案内联返回的最大字符数（超出截断并提示） |
| `btwTimeoutMs` | `120000` | `/btw` 运行预算（毫秒）；超时取消子代理并返回错误，`0` 表示不设超时 |

## 使用

- `/side 调研一下 session-query 的 FTS 索引` —— 创建命名侧线程并提问，**自动跳转到侧会话视图**
- `/side` —— 创建空侧线程（等待你的第一个问题）
- `/side list` —— 列出本会话的全部直接子代理
- `/btw 这个目录下哪个文件最大？` —— 一次性侧问，答案内联返回（末尾带 `(btw session: <id>)` 跳转标记），随后自动跳转到该侧会话回看

侧线程的其他入口：**父会话标题行的子代理目录按钮** → 点击侧线程行打开为独立对话视图 → continuable 侧线程保留完整输入框可继续对话。侧线程不会出现在左侧边栏（子代理会话的固有导航形态）。

## 验证

1. 输入 `/btw 1+1=?`，应内联返回答案并自动跳转到侧会话视图；主会话历史不出现该问答。
2. 输入 `/side 检查一下当前工作区状态`，应自动跳转到新侧线程并继续对话；主会话继续正常干活。
3. 回到父会话，打开子代理目录，应看到该侧线程（continuable，带 label）。
4. 重启 `dsh web` 后从目录再次进入，侧线程历史从持久化日志恢复。

## 热加载边界

- **新增/移除插件**：改 `~/.dsh/config.yaml`（0805 机制）或 profile patch（0806 机制）即热生效，无需重启（本插件实测：写入安装行后 `command.list` 立即出现 `/side` `/btw`；移除时以 `[]` 清空配置行即卸载）。
- **代码/元数据更新**：配置级 HMR 不重载已加载模块——改 `src/` 或 `package.json`（如新增 `dshClient` 客户端半部分）后需**重启 `dsh web` 并刷新页面**。

## 已知限制

- fork 种子只含父会话**已完成回合**；进行中的回合不会继承（DSH fork 语义）。
- `/btw` 是一次性运行：答案即取即走，没有后续轮次；需要多轮侧聊请用 `/side`。
- `/side list` 列出的是本会话**全部**直接子代理（含模型 spawn/fork 的委派任务），不限于侧会话。
- continuable 续聊需要父会话 agent 存活；进程重启后由目录冷恢复。
- 侧会话 persona 不声明 `{{...}}` 插值变量。
- 自动跳转是浏览器半部分行为：命令卡片在成功落定时解析文本中的子会话 id 并 `openSubagent()`；解析失败（如文本被改动）则静默退回手动目录入口。
- **`/btw` 有运行预算**（`btwTimeoutMs`，默认 120 秒）：子代理迟迟不结束（如子代理自己发起了长 sleep/长工具调用）会被取消并 dispose，避免 pending 命令长期压住父会话——真实事故：一个子代理 `bash sleep 600` 让 `/btw` 挂了 10 分钟，期间父会话无法推进。超时兜底后最坏情况是收到一条"timed out"错误而非无限挂起。

## 开发

```sh
pnpm install   # link: 依赖指向 ~/.dsh/source/current 快照（需已构建 lib/）
pnpm run check # typecheck + test + build
```

> 移动仓库位置后，`package.json` 里 `link:` 开发依赖的相对路径会失效：重新 `pnpm add link:<新绝对路径>` 或修正相对层级即可。运行时安装走 `dsh plugin --profile web add link:<绝对路径>`，不受影响。

单元测试以桩替代 subagent/command 服务面，断言命令注册、`/side` `/btw` 语义、boundary/persona 钉死文本与配置接线。

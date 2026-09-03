# 故障记录：Cordis `remote.*` 命名空间必须逐一声明 inject

- **日期**：2026-09-03
- **现象**：`custom/improvements`（journal 数据层）装入 web profile 后，浏览器端 loader entry 应用失败，`dsh web` 打不开，报错 `cannot get property "remote.commands" without inject`。
- **根因**：`src/client/index.tsx` 的 `apply()` 通过 `ctx.remote.commands` 访问了 commands 命名空间，但 `inject` 数组只声明了 `'remote'`、`'remote.session'`、`'remote.subagents'`，漏掉 `'remote.commands'`。Cordis 依赖注入要求 `remote` 下的每个命名空间单独注入，访问未声明服务直接抛错；客户端 apply 抛错会让整个 web shell 启动失败。
- **修复**：commit `83e0b8c` —— inject 数组补一行 `'remote.commands'`；`pnpm check`（typecheck + 114 测试 + 双构建）通过。
- **预防**：改动数据层时，`JournalRemotes` 面（`$stream` / `commands` / `session` / `subagents`）每用到一个命名空间，都要同步在 client 的 `inject` 里声明（`'remote'` 本身不等于其子命名空间）。上一条 `def38ba` 就是漏改的教训；push 前跑 `pnpm check` 并人工核对 inject 与 `ctx.remote.*` 的访问点一一对应。

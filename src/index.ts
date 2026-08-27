/**
 * dsh-sidechain plugin: `/side` and `/btw` — side conversations in an
 * ephemeral fork of the current session (Codex `/side` & `/btw` semantics).
 *
 * Both commands drive the forked subagent backend: the child inherits the
 * parent's completed conversation turns as reference context only (boundary
 * prompt), runs under a side-conversation persona (no mutation unless asked,
 * sub-agents off-limits), and never writes into the main session's history.
 * `/side` opens a durable continuable side thread (visible in the web
 * subagent catalog); `/btw` starts a one-shot side question whose answer
 * streams into the sidechain panel. Neither command blocks the main session.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'
import { createSidechainCommands } from './commands.ts'
import { SIDE_PERSONA } from './prompts.ts'
import { createSettlementSilence, type SettlementNoticeScope } from './settle-silence.ts'
import type { SideDeps } from './side.ts'

export const name = 'dsh-sidechain'

export const inject = ['agents', 'subagents']

/** Plugin config: deployment-varying behavior, validated from cordis.yml. */
export interface Config {
  /** Provider name on `ctx.subagents`; the fork backend registers as `fork`. */
  providerName: string
  /** Persona applied to side-conversation children; shadows the deployment persona. */
  persona: string
  /** Optional allow-list of tool names kept visible in side conversations. */
  readOnlyTools?: string[]
  /**
   * Which runtime `subagent-settled` notices to suppress: `all` (default)
   * silences every child's settlement bookkeeping; `side-children` silences
   * only this plugin's registered side children so orchestration workflows
   * that depend on settlement delivery keep receiving them.
   */
  settlementSilence?: SettlementNoticeScope
}

export const Config: z<Config> = z.object({
  providerName: z.string().default('fork'),
  persona: z.string().default(SIDE_PERSONA),
  readOnlyTools: z.array(z.string()),
  settlementSilence: z.union([z.const('all'), z.const('side-children')]).default('all'),
})

export function apply(ctx: Context, config: Config): () => void {
  const toolFilter: ToolRestriction | undefined =
    config.readOnlyTools !== undefined && config.readOnlyTools.length > 0
      ? { allow: config.readOnlyTools }
      : undefined
  const deps: SideDeps = {
    providerName: config.providerName,
    ...(config.persona === '' ? {} : { persona: config.persona }),
    ...(toolFilter === undefined ? {} : { toolFilter }),
  }
  const settlementSilence = createSettlementSilence(ctx, config.settlementSilence)
  // Commands are an optional surface: without a command registry the plugin
  // still loads harmlessly in minimal deployments.
  ctx.inject(['commands'], (commandCtx) => {
    for (const definition of createSidechainCommands(ctx.subagents, deps, settlementSilence)) {
      commandCtx.commands.register(definition)
    }
  })
  return () => { settlementSilence.dispose() }
}

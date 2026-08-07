/**
 * Command definitions for `/side` and `/btw` (Codex semantics: both start a
 * side conversation in an ephemeral fork of the current session).
 */

import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import {
  askSideOneShot,
  formatSideList,
  renderResultText,
  startSideConversation,
  truncateText,
  type SideDeps,
  type SubagentsLike,
} from './side.ts'

/** Build the two commands against a subagent-service face. */
export function createSidechainCommands(
  subagents: SubagentsLike,
  deps: SideDeps,
  maxResultChars: number,
  btwTimeoutMs: number,
): CommandDefinition[] {
  /** Loud hint when the configured provider is absent from the deployment. */
  const missingProvider = (): string | undefined => {
    if (subagents.getProvider(deps.providerName) !== undefined) return undefined
    return `sidechain: provider "${deps.providerName}" is not registered — mount @deepseek-ai/dsh-subagent-fork (or set providerName in the plugin config).`
  }

  return [
    {
      name: 'side',
      description: 'Start a side conversation in an ephemeral fork of the current session',
      handler: async ({ agent, rawInput, signal }) => {
        const missing = missingProvider()
        if (missing !== undefined) return { kind: 'error', text: missing }
        const arg = rawInput.trim()
        if (arg === 'list' || arg === 'ls') {
          try {
            const entries = await subagents.listChildren(agent.session.id, signal)
            return { kind: 'success', text: formatSideList(entries) }
          } catch (error) {
            return { kind: 'error', text: `sidechain: failed to list side conversations: ${messageOf(error)}` }
          }
        }
        try {
          const { childId } = await startSideConversation(subagents, agent, arg, deps, signal)
          // The trailing id is the machine-readable jump target for the client card.
          return { kind: 'success', text: `Side conversation started: ${childId}.` }
        } catch (error) {
          return { kind: 'error', text: `sidechain: failed to start side conversation: ${messageOf(error)}` }
        }
      },
    },
    {
      name: 'btw',
      description: 'Ask a quick question in an ephemeral fork of the current session',
      input: { hint: '<question>' },
      handler: async ({ agent, rawInput, signal }) => {
        const question = rawInput.trim()
        if (question === '') {
          return { kind: 'error', text: '/btw requires a question: /btw <question>' }
        }
        const missing = missingProvider()
        if (missing !== undefined) return { kind: 'error', text: missing }
        let run: SubagentRun | undefined
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          run = await askSideOneShot(subagents, agent, question, deps, signal)
          // Bounded side question: a never-settling child (e.g. a long tool
          // call) must not hold the parent session forever. On timeout the
          // run is disposed — dispose cancels remaining child work and waits
          // for settlement — so no orphan child keeps running.
          const result = btwTimeoutMs > 0
            ? await Promise.race([
              run.result,
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  reject(new Error(`timed out after ${btwTimeoutMs} ms`))
                }, btwTimeoutMs)
              }),
            ])
            : await run.result
          const text = renderResultText(result.output)
          // The trailing id is the machine-readable jump target for the client card.
          return { kind: 'success', text: `${truncateText(text, maxResultChars)}\n\n(btw session: ${run.id})` }
        } catch (error) {
          return { kind: 'error', text: `sidechain: /btw failed: ${messageOf(error)}` }
        } finally {
          if (timer !== undefined) clearTimeout(timer)
          if (run !== undefined) {
            // On the timeout path this cancels the child's remaining work and
            // waits for its settlement before the error result is returned.
            await run.dispose().catch(() => { /* disposal failure must not mask the answer */ })
          }
        }
      },
    },
  ]
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

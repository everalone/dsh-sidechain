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
): CommandDefinition[] {
  /** Loud hint when the configured provider is absent from the deployment. */
  const missingProvider = (): string | undefined => {
    if (subagents.getProvider(deps.providerName) !== undefined) return undefined
    return `sidechain: provider "${deps.providerName}" is not registered — mount @deepseek-ai/dsh-subagent-fork (or set providerName in the plugin config).`
  }

  return [
    {
      name: 'side',
      description:
        'Start a side conversation in an ephemeral fork of the current session. '
        + 'Usage: /side <question> starts one with an opening question; /side list lists this session\'s side conversations.',
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
          return {
            kind: 'success',
            text:
              `Side conversation started: ${childId}. `
              + 'The main thread keeps running; open the subagent catalog in the web UI to switch to it.',
          }
        } catch (error) {
          return { kind: 'error', text: `sidechain: failed to start side conversation: ${messageOf(error)}` }
        }
      },
    },
    {
      name: 'btw',
      description:
        'Ask a quick question in a temporary side conversation forked from the current session; '
        + 'the answer is returned inline and leaves no trace in the main history.',
      input: { hint: '<question>' },
      handler: async ({ agent, rawInput, signal }) => {
        const question = rawInput.trim()
        if (question === '') {
          return { kind: 'error', text: '/btw requires a question: /btw <question>' }
        }
        const missing = missingProvider()
        if (missing !== undefined) return { kind: 'error', text: missing }
        let run: SubagentRun | undefined
        try {
          run = await askSideOneShot(subagents, agent, question, deps, signal)
          const result = await run.result
          const text = renderResultText(result.output)
          return { kind: 'success', text: truncateText(text, maxResultChars) }
        } catch (error) {
          return { kind: 'error', text: `sidechain: /btw failed: ${messageOf(error)}` }
        } finally {
          if (run !== undefined) {
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

/**
 * Command definitions for `/side` and `/btw` (Codex semantics: both start a
 * side conversation in an ephemeral fork of the current session). Neither
 * command blocks the main session: the child runs in the background and its
 * transcript streams into the sidechain panel.
 */

import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import {
  askSideOneShot,
  formatSideList,
  startSideConversation,
  type SideDeps,
  type SubagentsLike,
} from './side.ts'

/** Build the two commands against a subagent-service face. */
export function createSidechainCommands(
  subagents: SubagentsLike,
  deps: SideDeps,
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
        try {
          // Non-blocking one-shot: the child keeps running in the background
          // and its answer streams into the sidechain panel — the main
          // session input stays free, nothing is awaited past the start.
          const run = await askSideOneShot(subagents, agent, question, deps, signal)
          // The trailing id is the machine-readable jump target for the client card.
          return { kind: 'success', text: `BTW question started: ${run.id}.` }
        } catch (error) {
          return { kind: 'error', text: `sidechain: /btw failed: ${messageOf(error)}` }
        }
      },
    },
  ]
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Embedded side-conversation transcript model (browser half).
 *
 * The panel renders a child's conversation from `subagent.history` — the
 * catalog's message-aligned transcript RPC, which reads the durable log
 * WITHOUT activating the child or changing the current session. Events map
 * to compact display rows: user prompts, assistant answers, and one line per
 * tool invocation (failures folded onto the call). Live refresh is
 * subscription-driven (the session face notifies while frames stream); the
 * mapping itself is pure so it stays unit-testable.
 */

import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { SubagentAddress } from '@deepseek-ai/dsh-client-connection/client'

/** Tail-page size for one transcript fetch (the panel shows the recent window). */
export const TRANSCRIPT_MAX_MESSAGES = 200

/** One compact transcript row rendered in the panel. */
export type TranscriptRow =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; name: string; failed: boolean }

/**
 * Extract the visible text of a content block list: `text` blocks verbatim,
 * joined by blank lines; everything else (reasoning, tool blocks) contributes
 * nothing. An empty result reads `…` so rows never render blank.
 * @param blocks - model-facing content blocks.
 * @returns the joined visible text.
 */
export function blockText(blocks: readonly ContentBlock[]): string {
  const text = blocks
    .map(block => (block.type === 'text' ? block.text : ''))
    .filter(part => part !== '')
    .join('\n\n')
  return text === '' ? '…' : text
}

/**
 * Map a session log's events onto compact transcript rows. Surface events
 * only: user prompts, assembled assistant messages, and tool invocations
 * (a failing `tool/result` marks the preceding call row). All other events
 * (chunks, turn brackets, usage, projections) are log detail the panel skips.
 * @param events - log events in seq order.
 * @returns display rows in log order.
 */
export function transcriptRows(events: readonly SessionEvent[]): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  for (const event of events) {
    switch (event.type) {
      case 'user/message': {
        rows.push({ kind: 'user', text: blockText(event.data.content) })
        break
      }
      case 'assistant/message': {
        rows.push({ kind: 'assistant', text: blockText(event.data.message.content) })
        break
      }
      case 'tool/call': {
        rows.push({ kind: 'tool', name: event.data.name, failed: false })
        break
      }
      case 'tool/result': {
        if (event.data.error !== undefined) {
          const last = rows[rows.length - 1]
          if (last !== undefined && last.kind === 'tool') {
            rows[rows.length - 1] = { ...last, failed: true }
          } else {
            rows.push({ kind: 'tool', name: 'tool', failed: true })
          }
        }
        break
      }
      default: {
        break
      }
    }
  }
  return rows
}

/**
 * Fetch a child's transcript tail page.
 * @param subagents - the api client's subagents surface.
 * @param address - durable parent/child address.
 * @returns display rows, or null on transport/business failure.
 */
export async function fetchTranscript(
  subagents: IApiClient['subagents'],
  address: SubagentAddress,
): Promise<readonly TranscriptRow[] | null> {
  try {
    const response = await subagents.history({ ...address, maxMessages: TRANSCRIPT_MAX_MESSAGES })
    if (!response.result.ok) return null
    const events = response.result.value.events.map(entry => entry.event)
    return transcriptRows(events)
  } catch {
    return null
  }
}

/**
 * Deliver one human message to a continuable child through its exact
 * direct-parent address (the same non-activating transport the runtime's
 * catalog navigation uses).
 * @param subagents - the api client's subagents surface.
 * @param address - continuable parent/child address.
 * @param text - the message body (one text block).
 * @returns whether the prompt was accepted.
 */
export async function sendPrompt(
  subagents: IApiClient['subagents'],
  address: Extract<SubagentAddress, { mode: 'continuable' }>,
  text: string,
): Promise<boolean> {
  try {
    const response = await subagents.prompt({
      ...address,
      content: [{ type: 'text', text }] satisfies readonly ContentBlock[],
    })
    return response.result.ok
  } catch {
    return false
  }
}

/**
 * Embedded side-conversation transcript model (browser half).
 *
 * The panel renders a child's conversation from `subagent.history` — the
 * catalog's message-aligned transcript RPC, which reads the durable log
 * WITHOUT activating the child or changing the current session.
 *
 * A sidechain child's log starts with the ENTIRE inherited parent history as
 * its fork seed (reference context). The mapping therefore cuts everything
 * up to the LAST `session/end-seed` event (the constructor seed marker) and
 * drops the fork's "Side conversation boundary" prompt row, so the panel
 * shows only the child's own side conversation.
 *
 * Live streaming: `assistant/message` events only land when a step completes,
 * but `assistant/chunk` events stream token-level deltas in real time. The
 * mapping accumulates `text-delta` chunks per (turn, step) into a growing
 * row, and supersedes it with the assembled message once it lands — so
 * polling the tail page yields text that visibly streams while a side run is
 * in progress. The tail window is bounded (`TRANSCRIPT_MAX_MESSAGES`) because
 * the inherited seed can be tens of thousands of chunk events long.
 */

import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy'
import type { ToolEventView } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { SubagentAddress } from '@deepseek-ai/dsh-client-connection/client'

/** Tail-page size for one transcript fetch (messages, not raw events). */
export const TRANSCRIPT_MAX_MESSAGES = 20

/** One compact transcript row rendered in the panel. `seq` is the source
 *  event's log sequence — stable row identity for React keys across polls
 *  (streaming caches ride the key, so window slides must not re-key rows). */
export type TranscriptRow =
  | { kind: 'user'; seq: number; text: string }
  | { kind: 'assistant'; seq: number; text: string }
  | { kind: 'tool'; seq: number; name: string; failed: boolean }

/** The fork boundary prompt's first line (dropped from the transcript). */
const BOUNDARY_PREFIX = 'Side conversation boundary'

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

/** Index of the last `session/end-seed` event (fork seed marker), or -1. */
function lastSeedEnd(events: readonly SessionEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'session/end-seed') return i
  }
  return -1
}

/**
 * Map a session log's events onto compact transcript rows: the inherited
 * fork seed is cut at the last `session/end-seed`, the boundary prompt is
 * dropped, `assistant/chunk` text deltas accumulate into a streaming row per
 * step (superseded by the assembled `assistant/message`), and tool
 * invocations render one line each (a failing `tool/result` marks the call).
 * @param events - log events in seq order.
 * @returns display rows in log order.
 */
export function transcriptRows(events: readonly SessionEvent[]): TranscriptRow[] {
  const seedEnd = lastSeedEnd(events)
  const rows: TranscriptRow[] = []
  /** (turn, step) key → index of its accumulating stream row in `rows`. */
  const streamRows = new Map<string, number>()
  for (let i = 0; i < events.length; i++) {
    if (i <= seedEnd) continue
    const event = events[i] as SessionEvent
    switch (event.type) {
      case 'user/message': {
        const text = blockText(event.data.content)
        if (text.startsWith(BOUNDARY_PREFIX)) break
        rows.push({ kind: 'user', seq: event.seq, text })
        break
      }
      case 'assistant/chunk': {
        const chunk = event.data.chunk
        if (chunk.type !== 'text-delta' || chunk.text === '') break
        const key = `${event.data.turn}:${event.data.step}`
        const existing = streamRows.get(key)
        if (existing !== undefined) {
          const row = rows[existing]
          if (row !== undefined && row.kind === 'assistant') {
            rows[existing] = { ...row, text: row.text + chunk.text }
          }
        } else {
          streamRows.set(key, rows.length)
          rows.push({ kind: 'assistant', seq: event.seq, text: chunk.text })
        }
        break
      }
      case 'assistant/message': {
        const key = `${event.data.turn}:${event.data.step}`
        const existing = streamRows.get(key)
        const text = blockText(event.data.message.content)
        if (existing !== undefined) {
          // Supersede the accumulated stream with the assembled message
          // (same step key, but the message seq becomes the stable identity).
          streamRows.delete(key)
          rows[existing] = { kind: 'assistant', seq: event.seq, text }
        } else {
          rows.push({ kind: 'assistant', seq: event.seq, text })
        }
        break
      }
      case 'tool/call': {
        rows.push({ kind: 'tool', seq: event.seq, name: event.data.name, failed: false })
        break
      }
      case 'tool/result': {
        if (event.data.error !== undefined) {
          const last = rows[rows.length - 1]
          if (last !== undefined && last.kind === 'tool') {
            rows[rows.length - 1] = { ...last, failed: true }
          } else {
            rows.push({ kind: 'tool', seq: event.seq, name: 'tool', failed: true })
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

/** One history row as subagent.history returns it (event + host-computed view). */
export interface TranscriptEntry {
  event: SessionEvent
  view?: ToolEventView | undefined
}

/**
 * Files the child's tool calls report having created or changed, by render
 * intent rather than tool name — the same policy as the main chat's
 * ui-deliverables: a diff card, or a generic card whose `kind` is `edit`
 * (the shape `str_replace_editor`'s insert presents). Reads, deletes, and
 * plain terminal runs produce nothing. Paths keep first-seen order and
 * appear once.
 * @param entries - history rows (views are re-derived per read by the host).
 * @returns produced file paths.
 */
export function producedPaths(entries: readonly TranscriptEntry[]): string[] {
  // The same seed cut transcriptRows applies: a fresh child's tail window
  // contains the inherited parent history, whose write/edit calls would
  // otherwise leak the PARENT's produced files into this child's vocabulary.
  const seedEnd = lastSeedEnd(entries.map(entry => entry.event))
  // Calls whose result failed produced nothing to open (ui-deliverables
  // policy: failed calls do not count).
  const failedCallIds = new Set<string>()
  for (let i = seedEnd + 1; i < entries.length; i++) {
    const event = entries[i]?.event
    if (event === undefined || event.type !== 'tool/result') continue
    const block = event.data.message.content[0]
    const callId = block?.toolCallId
    if (callId === undefined) continue
    if (event.data.error !== undefined || block?.isError === true) failedCallIds.add(callId)
  }
  const paths: string[] = []
  const seen = new Set<string>()
  for (let i = seedEnd + 1; i < entries.length; i++) {
    const entry = entries[i] as TranscriptEntry
    const view = entry.view
    if (view === undefined || view.for !== 'call') continue
    const call = view.view
    if (entry.event.type !== 'tool/call' || failedCallIds.has(entry.event.data.callId)) continue
    const locations = call.card === 'diff'
      ? call.locations
      : call.card === 'generic' && call.kind === 'edit'
        ? call.locations
        : undefined
    if (locations === undefined) continue
    for (const location of locations) {
      if (seen.has(location.path)) continue
      seen.add(location.path)
      paths.push(location.path)
    }
  }
  return paths
}

/**
 * Union two produced-file vocabularies, keeping first-seen order. The panel
 * accumulates across polls: a produced path whose call row slides out of the
 * 20-message tail window must keep its mentions working.
 * @param previous - the accumulated vocabulary (may be empty on first fetch).
 * @param next - the current window's vocabulary.
 * @returns the union in first-seen order.
 */
export function mergeProduced(
  previous: readonly string[],
  next: readonly string[],
): string[] {
  const seen = new Set(previous)
  return [...previous, ...next.filter(path => !seen.has(path))]
}

/**
 * Fetch a child's transcript tail page.
 *
 * Reads through `session.history` rather than `subagent.history`: the
 * subagent path serves history without a presenter scope, so tool events
 * carry no render views (and no produced-file locations); the session path
 * resolves the session's preset scope from its log (`presenterScopeFor`),
 * so views — and thus the produced-file vocabulary — are available even for
 * cold (finished) children.
 * @param sessions - the api client's sessions surface.
 * @param address - durable parent/child address (only the child id is used).
 * @returns display rows plus the produced-file vocabulary, or null on
 *   transport/business failure.
 */
export async function fetchTranscript(
  sessions: IApiClient['sessions'],
  address: SubagentAddress,
): Promise<{ rows: readonly TranscriptRow[]; produced: readonly string[] } | null> {
  try {
    const response = await sessions.history({ sessionId: address.childSessionId, maxMessages: TRANSCRIPT_MAX_MESSAGES })
    if (!response.result.ok) return null
    const entries = response.result.value.events
    return {
      rows: transcriptRows(entries.map(entry => entry.event)),
      produced: producedPaths(entries),
    }
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

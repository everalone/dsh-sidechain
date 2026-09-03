/**
 * Embedded side-conversation transcript model (browser half), 0.1.2-alpha.2 port.
 *
 * The panel renders a child's conversation from the Session journal stream
 * (`SessionEventStream` from `@deepseek-ai/dsh-api-session-controller/client`),
 * bound to the child's direct-subagent address. The stream reads the durable
 * log WITHOUT activating the child or changing the staged (main) session —
 * the same non-activating transport the runtime's catalog uses.
 *
 * A sidechain child's log starts with the ENTIRE inherited parent history as
 * its fork seed (reference context). The mapping therefore cuts everything
 * before the first "Side conversation boundary" prompt and its preceding
 * `session/end-seed` marker. Packed history rows (`chunkrow/*`) expand to
 * their member events before mapping.
 *
 * Live streaming: `assistant/chunk` events stream token-level text and
 * reasoning deltas. The mapping accumulates both per block and supersedes
 * them with the assembled `assistant/message` once it lands. The journal
 * keeps every accepted event keyed by seq, so earlier rounds remain visible
 * without re-reading the inherited seed.
 */

import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import {
  SessionEventStream,
  type SessionEventLikeEntry,
  type SessionJournalChange,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionAddress } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentAddress, SubagentPromptRequestId } from '@deepseek-ai/dsh-subagent/client'
import { lastActivity } from './sidechain-activity.ts'

/**
 * Tail-window size for one journal open (messages per window). Small on
 * purpose: a side child inherits the ENTIRE parent history as its fork seed,
 * and the seed is dense with chunk/reasoning events — a large window would
 * drag megabytes of inherited seed across the wire.
 */
export const TRANSCRIPT_PAGE_MESSAGES = 8
/** Activity reads reuse the journal; this many tail events feed the line. */
export const ACTIVITY_TAIL_EVENTS = 24

type ImageAttachmentRef = Extract<ContentBlock, { type: 'image' }>['attachment']

/** An image reference plus its browser-ready data URL when the host can serve it. */
export interface TranscriptImage {
  attachment: ImageAttachmentRef
  url?: string | undefined
}

export type TranscriptRow =
  | { kind: 'user'; seq: number; text: string; images?: readonly TranscriptImage[] }
  | { kind: 'assistant'; seq: number; text: string; images?: readonly TranscriptImage[] }
  | { kind: 'reasoning'; seq: number; text: string }
  | {
    kind: 'context'
    seq: number
    text: string
    source: string | null
    recall: boolean
    images?: readonly TranscriptImage[]
  }
  | { kind: 'error'; seq: number; text: string }
  | { kind: 'tool'; seq: number; name: string; failed: boolean; detail?: ToolDetail | undefined }

/** Detail attached to one tool row: raw arguments plus the settled result's
 *  content blocks (the panel renders them through {@link resultViewSummary}). */
export interface ToolDetail {
  /** Raw arguments JSON exactly as the model produced it. */
  arguments?: string
  /** The settled result block's content, absent while still running or empty. */
  result?: readonly ContentBlock[] | undefined
  error?: { name: string; code: string }
}

/** One-line summary of a settled tool result's content blocks. */
export function resultViewSummary(content: readonly ContentBlock[]): string | undefined {
  return content.length === 0 ? undefined : blockText(content)
}

/**
 * Local projection of a logged non-user message source (the main chat derives
 * the same facts inside its own bundle; the public client entry does not
 * re-export that helper, so the panel keeps a faithful small copy).
 */
export interface ContextProvenanceView {
  readonly role: 'inject' | 'recall'
  readonly label: string | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' ? value : null
}

function collectLabels(record: Record<string, unknown>, key: string, member: string): string[] {
  const value = record[key]
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (typeof item !== 'object' || item === null) return []
    const label = (item as Record<string, unknown>)[member]
    return typeof label === 'string' ? [label] : []
  })
}

function joined(values: readonly string[]): string | null {
  if (values.length === 0) return null
  return [...new Set(values)].join(', ')
}

export function contextProvenance(source: unknown): ContextProvenanceView {
  const record = asRecord(source)
  const kind = record === null ? null : readString(record, 'kind')
  if (record === null || kind === null) return { role: 'inject', label: null }
  switch (kind) {
    case 'session-reference': return {
      role: 'recall',
      label: joined(collectLabels(record, 'references', 'label')) ?? kind,
    }
    case 'agent-instructions': return {
      role: 'inject',
      label: joined(collectLabels(record, 'changes', 'path')) ?? kind,
    }
    case 'plugin': return {
      role: 'inject',
      label: readString(record, 'plugin') ?? kind,
    }
    case 'skill-invocation': return {
      role: 'inject',
      label: readString(record, 'name') ?? kind,
    }
    default: return { role: 'inject', label: kind }
  }
}

/** The fork boundary prompt's first line (marker for the side boundary message). */
const BOUNDARY_PREFIX = 'Side conversation boundary'

/**
 * Strip the internal side-conversation boundary envelope off an opening user
 * message, returning just the user's own question. The boundary message is
 * built by the host side as: boundary prompt + mode line + question. When the
 * message is not a boundary (no `Mode:` line present) it is treated as a pure
 * internal envelope and dropped (`null`).
 */
function stripSideBoundary(text: string): string | null {
  if (!text.startsWith(BOUNDARY_PREFIX)) return text
  const modeIndex = text.indexOf('\nMode:')
  if (modeIndex < 0) return null
  const afterMode = text.indexOf('\n', modeIndex + 1)
  if (afterMode < 0) return null
  const rest = text.slice(afterMode + 1).trim()
  return rest === '' ? null : rest
}

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

function imageRefs(blocks: readonly ContentBlock[]): ImageAttachmentRef[] {
  return blocks.flatMap(block => block.type === 'image' ? [block.attachment] : [])
}

function transcriptImages(refs: readonly ImageAttachmentRef[]): TranscriptImage[] {
  return refs.map(attachment => ({ attachment }))
}

function rowText(blocks: readonly ContentBlock[], images: readonly ImageAttachmentRef[]): string {
  const text = blockText(blocks)
  return images.length > 0 && text === '…' ? '' : text
}

/** Index of the last `session/end-seed` event (fork seed marker), or -1. */
function lastSeedEnd(events: readonly SessionEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'session/end-seed') return i
  }
  return -1
}

function isSideBoundaryEvent(event: SessionEvent): boolean {
  return event.type === 'user/message'
    && event.data.content.some(block => block.type === 'text' && block.text.startsWith(BOUNDARY_PREFIX))
}

/**
 * Map a session log's expanded events onto compact transcript rows: the
 * inherited fork seed is cut at the boundary's preceding
 * `session/end-seed`, the boundary prompt is dropped, `assistant/chunk` text
 * deltas accumulate into a streaming row per step (superseded by the
 * assembled `assistant/message`), and tool invocations render one expandable
 * line each — raw arguments and the paired result's text (matched by the
 * result's `toolCallId`) ride the row as detail; a failing `tool/result`
 * marks it.
 * @param events - expanded session events in seq order (already seed-cut).
 * @returns display rows in log order.
 */
export function transcriptRows(events: readonly SessionEvent[]): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  /** (turn, step, block, kind) key → index of its accumulating stream row. */
  const streamRows = new Map<string, number>()
  /** tool callId → index of its tool row in `rows` (result pairing). */
  const callRows = new Map<string, number>()
  for (const event of events) {
    switch (event.type) {
      case 'user/message': {
        const refs = imageRefs(event.data.content)
        const text = rowText(event.data.content, refs)
        const images = refs.length === 0 ? {} : { images: transcriptImages(refs) }
        const stripped = stripSideBoundary(text)
        if (stripped === null) break
        const displayText = stripped === text ? text : stripped
        const source = event.data.source as unknown
        const sourceKind = typeof source === 'object' && source !== null
          ? (source as Record<string, unknown>)['kind']
          : undefined
        if (sourceKind === undefined || sourceKind === 'user') {
          rows.push({ kind: 'user', seq: event.seq, text: displayText, ...images })
        } else {
          const provenance = contextProvenance(source)
          rows.push({
            kind: 'context', seq: event.seq, text: displayText,
            source: provenance.label,
            recall: provenance.role === 'recall',
            ...images,
          })
        }
        break
      }
      case 'assistant/chunk': {
        const chunk = event.data.chunk
        if ((chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') || chunk.text === '') break
        const kind = chunk.type === 'text-delta' ? 'assistant' : 'reasoning'
        const key = `${event.data.turn}:${event.data.step}:${chunk.index}:${kind}`
        const existing = streamRows.get(key)
        if (existing !== undefined) {
          const row = rows[existing]
          if (row !== undefined && row.kind === kind) {
            rows[existing] = { ...row, text: row.text + chunk.text }
          }
        } else {
          streamRows.set(key, rows.length)
          rows.push({ kind, seq: event.seq, text: chunk.text })
        }
        break
      }
      case 'assistant/message': {
        const prefix = `${event.data.turn}:${event.data.step}:`
        const streamed = [...streamRows.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([, index]) => index)
        for (const key of [...streamRows.keys()]) {
          if (key.startsWith(prefix)) streamRows.delete(key)
        }
        const settled = event.data.message.content.flatMap((block): TranscriptRow[] => {
          if (block.type === 'reasoning' && block.text !== '') {
            return [{ kind: 'reasoning', seq: event.seq, text: block.text }]
          }
          if (block.type === 'text' && block.text !== '') {
            return [{ kind: 'assistant', seq: event.seq, text: block.text }]
          }
          return []
        })
        const refs = imageRefs(event.data.message.content)
        if (refs.length > 0) {
          const images = transcriptImages(refs)
          const assistant = settled.findIndex(row => row.kind === 'assistant')
          if (assistant >= 0) {
            const row = settled[assistant]
            if (row !== undefined && row.kind === 'assistant') settled[assistant] = { ...row, images }
          } else {
            settled.push({ kind: 'assistant', seq: event.seq, text: '', images })
          }
        }
        if (settled.length === 0 && event.data.message.content.length === 0) {
          settled.push({ kind: 'assistant', seq: event.seq, text: '…' })
        }
        if (streamed.length === 0) rows.push(...settled)
        else rows.splice(Math.min(...streamed), streamed.length, ...settled)
        break
      }
      case 'tool/call': {
        const data = event.data
        callRows.set(data.callId, rows.length)
        rows.push({
          kind: 'tool',
          seq: event.seq,
          name: data.name,
          failed: false,
          detail: {
            arguments: data.arguments,
          },
        })
        break
      }
      case 'tool/result': {
        const data = event.data
        const resultBlock = data.message.content[0]
        const callId = resultBlock?.toolCallId
        const index = callId === undefined ? undefined : callRows.get(callId)
        const error = data.error
        // A result is failed on the explicit event error OR the block's own
        // isError flag (tools report hard failures either way).
        const failed = error !== undefined || resultBlock?.isError === true
        const detail: ToolDetail = {
          ...(resultBlock?.content !== undefined && resultBlock.content.length > 0
            ? { result: resultBlock.content }
            : {}),
          ...(error === undefined ? {} : { error }),
        }
        if (index !== undefined) {
          const row = rows[index]
          if (row !== undefined && row.kind === 'tool') {
            rows[index] = {
              ...row,
              failed,
              detail: {
                ...row.detail,
                ...detail,
              },
            }
          }
        } else if (failed) {
          // Orphan result (no call row in the window): surface the failure
          // with its error so the row stays informative and expandable.
          rows.push({
            kind: 'tool', seq: event.seq, name: 'tool', failed: true,
            ...(error === undefined ? {} : { detail: { error } }),
          })
        }
        break
      }
      case 'turn/end': {
        if (event.data.reason.kind !== 'error') break
        rows.push({ kind: 'error', seq: event.seq, text: event.data.reason.error.message })
        break
      }
      default: {
        break
      }
    }
  }
  return rows
}

/** Tool names that produce files, with an args extractor for the path. */
const PRODUCING_TOOLS: Readonly<Record<string, (args: Record<string, unknown>) => string | undefined>> = {
  write: filePathArg,
  edit: filePathArg,
  str_replace_editor: (args) =>
    args.command === 'insert' ? filePathArg(args) : undefined,
}

function filePathArg(args: Record<string, unknown>): string | undefined {
  if (typeof args.file_path === 'string') return args.file_path
  if (typeof args.path === 'string') return args.path
  return undefined
}

/**
 * Files the child's tool calls report having created or changed, by render
 * intent rather than tool name — write/edit calls and `str_replace_editor`
 * inserts. The alpha.2 port derives paths from raw call arguments (the rc.2
 * host-computed render views are gone); reads, deletes, and plain terminal
 * runs produce nothing. Paths keep first-seen order and appear once.
 * @param events - seed-cut events in seq order.
 * @returns produced file paths.
 */
export function producedPaths(events: readonly SessionEvent[]): string[] {
  // Calls whose result failed produced nothing to open (ui-deliverables
  // policy: failed calls do not count).
  const failedCallIds = new Set<string>()
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const block = event.data.message.content[0]
    const callId = block?.toolCallId
    if (callId === undefined) continue
    if (event.data.error !== undefined || block?.isError === true) failedCallIds.add(callId)
  }
  const paths: string[] = []
  const seen = new Set<string>()
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    if (failedCallIds.has(event.data.callId)) continue
    const extractor = PRODUCING_TOOLS[event.data.name]
    if (extractor === undefined) continue
    let args: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(event.data.arguments)
      if (parsed === null || typeof parsed !== 'object') continue
      args = parsed as Record<string, unknown>
    } catch {
      continue
    }
    const path = extractor(args)
    if (path === undefined || seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }
  return paths
}

/**
 * Union two produced-file vocabularies, keeping first-seen order. The panel
 * accumulates across polls so a produced path remains usable after its call
 * row slides out of the current tail window.
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

// ---- Child journals (live, non-activating transcript sources) ----

/** Remotes face the journal layer consumes (structurally the Session Remotes). */
export interface JournalRemotes {
  readonly $stream: ClientRemote['$stream']
  readonly commands: ClientRemote['commands']
  readonly session: ClientRemote['session']
  readonly subagents: ClientRemote['subagents']
}

/** One child's live journal: stream, accumulated events, seed-boundary state. */
export interface ChildJournal {
  address: SessionAddress
  stream: SessionEventStream
  /** Expanded events by seq, accumulated across pages and live appends. */
  entries: Map<number, SessionEvent>
  /** Marker seq cutting the fork seed; entries at/below it are seed. */
  seedSeq: number | undefined
  /** Whether the seed boundary has been located (no further back-paging). */
  boundaryFound: boolean
  /** The tail window's lowest seq — the exclusive bound for the next older page. */
  firstSeq: number | undefined
  /** Whether older pages remain behind the current window. */
  hasMore: boolean
  /** Settled when the first window is published; false on terminal failure. */
  opened: Promise<boolean>
  failed: boolean
}

/**
 * Expand one packed history row back to its member `assistant/chunk` events.
 * Text and reasoning runs expand member-by-member (token boundaries are
 * data); tool-call runs are skipped — the panel renders the assembled
 * `tool/call` / `tool/result` pair, never the argument deltas.
 * @param entry - one journal entry (raw event or packed run).
 * @returns the expanded member events, in seq order.
 */
export function expandEntry(entry: SessionEventLikeEntry): SessionEvent[] {
  if (entry.type === 'event') return [entry.event]
  const row = entry.event
  if (row.type === 'chunkrow/text-chunks' || row.type === 'chunkrow/reasoning-chunks') {
    const chunkType = row.type === 'chunkrow/text-chunks' ? 'text-delta' : 'reasoning-delta'
    const { turn, step, index, dt, texts } = row.data
    const events: SessionEvent[] = []
    let time = row.time
    for (let k = 0; k < texts.length; k++) {
      if (k > 0) time += dt[k - 1] ?? 0
      events.push({
        type: 'assistant/chunk',
        seq: row.seq + k,
        time,
        data: { turn, step, chunk: { type: chunkType, index, text: texts[k] ?? '' } },
      } as SessionEvent)
    }
    return events
  }
  return []
}

/**
 * Fold one published journal page into the child state: expand + store every
 * entry, track the window's leading seq and `hasMore`, and locate the seed
 * boundary when it appears in this page.
 * @param journal - the child's accumulated journal state.
 * @param entries - one page's entries in seq order.
 * @param hasMore - whether older pages remain behind this page.
 */
export function foldJournalPage(
  journal: Pick<ChildJournal, 'entries' | 'seedSeq' | 'boundaryFound' | 'firstSeq' | 'hasMore'>,
  entries: readonly SessionEventLikeEntry[],
  hasMore: boolean,
): void {
  journal.hasMore = hasMore
  const pageEvents: SessionEvent[] = []
  let first: number | undefined
  for (const entry of entries) {
    for (const event of expandEntry(entry)) {
      journal.entries.set(event.seq, event)
      pageEvents.push(event)
      first = first === undefined ? event.seq : Math.min(first, event.seq)
    }
  }
  if (first !== undefined) journal.firstSeq = first
  if (!journal.boundaryFound) detectBoundary(journal, pageEvents)
}

/**
 * Locate the seed boundary inside one page: the `session/end-seed` marker
 * immediately before the first boundary prompt. Without a boundary prompt,
 * a page that ends the log (no older pages) cuts at its latest seed marker
 * (legacy fork children without the side envelope).
 */
function detectBoundary(
  journal: Pick<ChildJournal, 'seedSeq' | 'boundaryFound' | 'hasMore'>,
  pageEvents: readonly SessionEvent[],
): void {
  const boundary = pageEvents.findIndex(isSideBoundaryEvent)
  if (boundary >= 0) {
    for (let i = boundary - 1; i >= 0; i--) {
      if (pageEvents[i]?.type !== 'session/end-seed') continue
      journal.seedSeq = pageEvents[i]!.seq
      journal.boundaryFound = true
      return
    }
    // The marker lies in an older window; the walk continues paging back.
    return
  }
  if (!journal.hasMore) {
    const seedEnd = lastSeedEnd(pageEvents)
    if (seedEnd >= 0) {
      journal.seedSeq = pageEvents[seedEnd]!.seq
      journal.boundaryFound = true
    }
  }
}

/** Accumulated journal entries above the seed cut, in seq order. */
export function displayEntries(journal: Pick<ChildJournal, 'entries' | 'seedSeq' | 'boundaryFound'>): SessionEvent[] {
  const events = [...journal.entries.values()].sort((a, b) => a.seq - b.seq)
  if (journal.boundaryFound && journal.seedSeq !== undefined) {
    const cut = journal.seedSeq
    return events.filter(event => event.seq > cut)
  }
  const seedEnd = lastSeedEnd(events)
  if (seedEnd >= 0) return events.slice(seedEnd + 1)
  return events
}

const journals = new Map<string, ChildJournal>()
const imageUrlCache = new Map<string, string | null>()

function childAddress(address: SubagentAddress): SessionAddress {
  return {
    kind: 'subagent',
    parentSessionId: address.parentSessionId,
    childSessionId: address.childSessionId,
    mode: address.mode,
  }
}

/**
 * Resolve (or create) the live journal for one child. The stream publishes
 * `replace`/`prepend` window changes and live appends into the child state;
 * the opening promise settles after the first window is published.
 */
export function ensureChildJournal(
  remotes: JournalRemotes,
  address: SubagentAddress,
  pageMessages: number,
): ChildJournal {
  const existing = journals.get(address.childSessionId)
  if (existing !== undefined) return existing
  const journal: ChildJournal = {
    address: childAddress(address),
    stream: undefined as unknown as SessionEventStream,
    entries: new Map(),
    seedSeq: undefined,
    boundaryFound: false,
    firstSeq: undefined,
    hasMore: false,
    failed: false,
    opened: Promise.resolve(true),
  }
  journal.stream = new SessionEventStream(remotes, journal.address, {
    publish: (change: SessionJournalChange): void => {
      if (change.type === 'append') {
        for (const event of expandEntry(change.entry)) journal.entries.set(event.seq, event)
        return
      }
      foldJournalPage(journal, change.entries, change.hasMore)
    },
    failed: () => { journal.failed = true },
  })
  journal.opened = journal.stream.open({ maxMessages: pageMessages })
    .then(() => !journal.failed)
    .catch(() => {
      journal.failed = true
      return false
    })
  journals.set(address.childSessionId, journal)
  return journal
}

/**
 * Page a child's journal backwards until the seed boundary is located (or
 * the cap is reached for lightweight callers). Later pages ride the stream's
 * `prepend`; the boundary is cached on the journal, so subsequent reads need
 * no further paging.
 */
async function walkToBoundary(journal: ChildJournal, pageMessages: number, pageCap?: number): Promise<void> {
  let pages = 0
  while (!journal.boundaryFound && journal.hasMore && !journal.failed) {
    if (pageCap !== undefined && pages >= pageCap) return
    if (journal.firstSeq === undefined) return
    pages += 1
    const beforeSeq = journal.firstSeq
    try {
      await journal.stream.prepend({ maxMessages: pageMessages, beforeSeq })
    } catch {
      journal.failed = true
      return
    }
  }
}

/**
 * Read a child's accumulated, seed-cut transcript.
 * @param remotes - the client Remote namespaces.
 * @param address - durable parent/child address.
 * @returns display rows plus the produced-file vocabulary, or null on
 *   transport/business failure.
 */
export async function readChildTranscript(
  remotes: JournalRemotes,
  address: SubagentAddress,
): Promise<{ rows: readonly TranscriptRow[]; produced: readonly string[] } | null> {
  const journal = ensureChildJournal(remotes, address, TRANSCRIPT_PAGE_MESSAGES)
  const opened = await journal.opened
  if (!opened || journal.failed) return null
  await walkToBoundary(journal, TRANSCRIPT_PAGE_MESSAGES)
  if (journal.failed) return null
  const entries = displayEntries(journal)
  const rows = await hydrateTranscriptImages(remotes, address.childSessionId, transcriptRows(entries))
  return {
    rows,
    produced: producedPaths(entries),
  }
}

/**
 * Read one running child's live activity line (latest assistant text or last
 * tool call) from the journal's accumulated tail — cheap because the journal
 * already streams the live events; no extra pages are pulled.
 * @param remotes - the client Remote namespaces.
 * @param address - durable parent/child address.
 * @returns the activity line, or null on transport/business failure or an
 *   empty tail.
 */
export async function readChildActivity(
  remotes: JournalRemotes,
  address: SubagentAddress,
): Promise<string | null> {
  const journal = ensureChildJournal(remotes, address, TRANSCRIPT_PAGE_MESSAGES)
  const opened = await journal.opened
  if (!opened || journal.failed) return null
  const tail = [...journal.entries.values()].sort((a, b) => a.seq - b.seq).slice(-ACTIVITY_TAIL_EVENTS)
  return lastActivity(transcriptRows(tail)) ?? null
}

/** Test seam: dispose live journals and drop the accumulated caches. */
export function resetSidechainJournalCache(): void {
  for (const journal of journals.values()) void journal.stream.dispose().catch(() => {})
  journals.clear()
  imageUrlCache.clear()
}

async function hydrateTranscriptImages(
  remotes: JournalRemotes,
  childSessionId: SessionId,
  rows: readonly TranscriptRow[],
): Promise<TranscriptRow[]> {
  const refs = new Map<string, ImageAttachmentRef>()
  for (const row of rows) {
    for (const image of 'images' in row ? row.images ?? [] : []) {
      refs.set(String(image.attachment.attachmentId), image.attachment)
    }
  }
  if (refs.size === 0) return [...rows]

  await Promise.all([...refs].map(async ([id, ref]) => {
    if (imageUrlCache.has(id)) return
    try {
      const response = await remotes.session.attachment({
        sessionId: childSessionId,
        attachmentId: ref.attachmentId,
      })
      if (!response.ok) {
        imageUrlCache.set(id, null)
        return
      }
      const data = response.value.data
      imageUrlCache.set(id, data.startsWith('data:') ? data : `data:${ref.mediaType};base64,${data}`)
    } catch {
      imageUrlCache.set(id, null)
    }
  }))

  return rows.map(row => {
    if (!('images' in row) || row.images === undefined) return row
    return {
      ...row,
      images: row.images.map(image => {
        const url = imageUrlCache.get(String(image.attachment.attachmentId))
        return { ...image, ...(typeof url === 'string' ? { url } : {}) }
      }),
    }
  })
}

/**
 * Deliver one human message to a continuable child through its exact
 * direct-parent address (the same non-activating transport the runtime's
 * catalog navigation uses).
 * @param subagents - the generated subagents Remote namespace.
 * @param address - continuable parent/child address.
 * @param text - the message body (one text block).
 * @returns whether the prompt was accepted.
 */
export async function sendPrompt(
  subagents: JournalRemotes['subagents'],
  address: Extract<SubagentAddress, { mode: 'continuable' }>,
  text: string,
): Promise<boolean> {
  try {
    const response = await subagents.prompt({
      requestId: crypto.randomUUID() as SubagentPromptRequestId,
      parentSessionId: address.parentSessionId,
      childSessionId: address.childSessionId,
      mode: 'continuable',
      content: [{ type: 'text', text }] satisfies readonly ContentBlock[],
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Unit tests for the embedded side-conversation transcript model (alpha.2
 * port): event → row mapping, tool call/result pairing, packed-row expansion,
 * the journal page folding + seed-boundary cut, and the journal/prompt reads.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  blockText, displayEntries, ensureChildJournal, expandEntry, foldJournalPage,
  mergeProduced, producedPaths, readChildActivity, readChildTranscript,
  resetSidechainJournalCache, resultViewSummary, sendPrompt, transcriptRows,
  type ChildJournal, type JournalRemotes,
} from '../src/client/sidechain-view'
import { SessionEventStream } from './browser-modules.stub'

const CHILD = '54c34e5e-1c29-4a6c-a2f7-4b19a3d92914' as SessionId
const PARENT = 'parent-1' as SessionId
const ADDRESS: SubagentAddress = { parentSessionId: PARENT, childSessionId: CHILD, mode: 'continuable' }

function event(type: SessionEvent['type'], seq: number, data: Record<string, unknown>): SessionEvent {
  return { type, seq, time: 0, data } as SessionEvent
}

/** Wire entry: one raw event record. */
function ev(entry: SessionEvent): { type: 'event'; event: SessionEvent } {
  return { type: 'event', event: entry }
}

/** Wire entry: one packed text-chunks row. */
function chunks(
  kind: 'text-chunks' | 'reasoning-chunks',
  seq: number,
  texts: string[],
): { type: 'chunks'; event: Record<string, unknown> } {
  return {
    type: 'chunks',
    event: {
      type: `chunkrow/${kind}`,
      seq,
      time: 0,
      data: { turn: 1, step: 1, index: 0, dt: texts.slice(1).map(() => 0), texts },
    },
  }
}

function textBlock(text: string): { type: 'text'; text: string } {
  return { type: 'text', text }
}

const SEED_MSG = event('user/message', 1, { content: [textBlock('inherited seed question')] })
const SEED_END = event('session/end-seed', 2, {})
const BOUNDARY = event('user/message', 3, {
  content: [textBlock('Side conversation boundary.\n\nEverything before this boundary is inherited history from the parent session.\n\nMode: this is a /side side conversation.\n\n真实问题')],
})
const USER_MSG = event('user/message', 4, { content: [textBlock('真实问题')] })

function journalState(): ChildJournal {
  return {
    address: { kind: 'subagent', parentSessionId: PARENT, childSessionId: CHILD, mode: 'continuable' },
    stream: undefined as unknown as ChildJournal['stream'],
    entries: new Map(),
    seedSeq: undefined,
    boundaryFound: false,
    firstSeq: undefined,
    hasMore: false,
    failed: false,
    opened: Promise.resolve(true),
  }
}

function fakeRemotes(): JournalRemotes {
  return {
    $stream: vi.fn(),
    commands: {},
    session: {
      attachment: vi.fn(() => Promise.resolve({ ok: true, value: { attachment: {}, data: '' } })),
    },
    subagents: { prompt: vi.fn(() => Promise.resolve({ ok: true, value: {} })) },
  } as unknown as JournalRemotes
}

beforeEach(() => {
  SessionEventStream.reset()
  resetSidechainJournalCache()
})

afterEach(() => {
  resetSidechainJournalCache()
  SessionEventStream.reset()
})

describe('blockText', () => {
  it('joins text blocks with blank lines and skips non-text blocks', () => {
    expect(blockText([textBlock('a'), textBlock('b')])).toBe('a\n\nb')
    expect(blockText([{ type: 'reasoning', text: 'x' }, textBlock('c')])).toBe('c')
    expect(blockText([])).toBe('…')
  })
})

describe('transcriptRows', () => {
  it('maps user and settled assistant messages', () => {
    const rows = transcriptRows([
      USER_MSG,
      event('assistant/message', 5, {
        turn: 1, step: 1,
        message: { role: 'assistant', content: [textBlock('回答')] },
      }),
    ])
    expect(rows).toEqual([
      { kind: 'user', seq: 4, text: '真实问题' },
      { kind: 'assistant', seq: 5, text: '回答' },
    ])
  })

  it('strips the side boundary envelope off its opening user message', () => {
    const rows = transcriptRows([BOUNDARY])
    expect(rows).toEqual([{ kind: 'user', seq: 3, text: '真实问题' }])
  })

  it('accumulates chunk deltas into streaming rows and supersedes them on settle', () => {
    const rows = transcriptRows([
      event('assistant/chunk', 5, { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '你' } }),
      event('assistant/chunk', 6, { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '好' } }),
      event('assistant/message', 7, {
        turn: 1, step: 1,
        message: { role: 'assistant', content: [textBlock('你好！')] },
      }),
    ])
    expect(rows).toEqual([{ kind: 'assistant', seq: 7, text: '你好！' }])
  })

  it('splits reasoning and text chunks into separate stream rows', () => {
    const rows = transcriptRows([
      event('assistant/chunk', 5, { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: '想' } }),
      event('assistant/chunk', 6, { turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: '答' } }),
    ])
    expect(rows).toEqual([
      { kind: 'reasoning', seq: 5, text: '想' },
      { kind: 'assistant', seq: 6, text: '答' },
    ])
  })

  it('projects non-user context messages through the local provenance view', () => {
    const rows = transcriptRows([
      event('user/message', 5, {
        content: [textBlock('上下文')],
        source: { kind: 'agent-instructions', changes: [{ path: 'AGENTS.md' }] },
      }),
      event('user/message', 6, {
        content: [textBlock('回忆')],
        source: { kind: 'session-reference', references: [{ label: '旧会话' }] },
      }),
    ])
    expect(rows).toEqual([
      { kind: 'context', seq: 5, text: '上下文', source: 'AGENTS.md', recall: false },
      { kind: 'context', seq: 6, text: '回忆', source: '旧会话', recall: true },
    ])
  })

  it('pairs tool calls with their results and marks failures', () => {
    const rows = transcriptRows([
      event('tool/call', 5, { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }),
      event('tool/result', 6, {
        turn: 1, step: 1,
        message: { role: 'tool', content: [{ toolCallId: 'c1', isError: false, content: [textBlock('文件内容')] }] },
      }),
      event('tool/call', 7, { turn: 1, step: 1, callId: 'c2', name: 'bash', arguments: '{"command":"boom"}' }),
      event('tool/result', 8, {
        turn: 1, step: 1,
        message: { role: 'tool', content: [{ toolCallId: 'c2', isError: true }] },
        error: { name: 'ToolError', code: 'EXEC_FAILED' },
      }),
    ])
    expect(rows[0]).toEqual({
      kind: 'tool', seq: 5, name: 'read', failed: false,
      detail: { arguments: '{"path":"a.ts"}', result: [textBlock('文件内容')] },
    })
    expect(rows[1]).toMatchObject({
      kind: 'tool', seq: 7, name: 'bash', failed: true,
      detail: expect.objectContaining({ error: { name: 'ToolError', code: 'EXEC_FAILED' } }),
    })
  })

  it('surfaces orphan failed results as standalone tool rows', () => {
    const rows = transcriptRows([
      event('tool/result', 8, {
        turn: 1, step: 1,
        message: { role: 'tool', content: [{ toolCallId: 'c9', isError: true }] },
        error: { name: 'ToolError', code: 'LOST' },
      }),
    ])
    expect(rows).toEqual([
      { kind: 'tool', seq: 8, name: 'tool', failed: true, detail: { error: { name: 'ToolError', code: 'LOST' } } },
    ])
  })

  it('maps turn/end error reasons into error rows', () => {
    const rows = transcriptRows([
      event('turn/end', 9, { turn: 1, reason: { kind: 'error', error: { message: '模型挂了', code: 'LLM' } } }),
    ])
    expect(rows).toEqual([{ kind: 'error', seq: 9, text: '模型挂了' }])
  })
})

describe('expandEntry', () => {
  it('passes raw events through', () => {
    expect(expandEntry(ev(USER_MSG))).toEqual([USER_MSG])
  })

  it('expands packed text runs into per-member chunk events', () => {
    const expanded = expandEntry(chunks('text-chunks', 10, ['a', 'b']) as never)
    expect(expanded).toEqual([
      { type: 'assistant/chunk', seq: 10, time: 0, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'a' } } },
      { type: 'assistant/chunk', seq: 11, time: 0, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'b' } } },
    ])
  })

  it('expands packed reasoning runs and drops tool-call runs', () => {
    const reasoning = expandEntry(chunks('reasoning-chunks', 20, ['想']) as never)
    expect(reasoning).toHaveLength(1)
    expect(reasoning[0]).toMatchObject({
      seq: 20, data: { chunk: { type: 'reasoning-delta', text: '想' } },
    })
    const toolRun = expandEntry({
      type: 'chunks',
      event: {
        type: 'chunkrow/tool-call-chunks', seq: 30, time: 0,
        data: { turn: 1, step: 1, index: 0, dt: [], id: 'c1', name: 'bash', args: ['ec'] },
      },
    } as never)
    expect(toolRun).toEqual([])
  })
})

describe('foldJournalPage / displayEntries (seed cut)', () => {
  it('cuts at the seed marker before the boundary prompt', () => {
    const journal = journalState()
    foldJournalPage(journal, [ev(SEED_MSG), ev(SEED_END), ev(BOUNDARY)], false)
    expect(journal.boundaryFound).toBe(true)
    expect(journal.seedSeq).toBe(2)
    expect(displayEntries(journal).map(entry => entry.seq)).toEqual([3])
    expect(transcriptRows(displayEntries(journal))).toEqual([{ kind: 'user', seq: 3, text: '真实问题' }])
  })

  it('keeps paging when the boundary appears without its marker', () => {
    const journal = journalState()
    foldJournalPage(journal, [ev(BOUNDARY), ev(USER_MSG)], true)
    expect(journal.boundaryFound).toBe(false)
    expect(journal.hasMore).toBe(true)
    // The older page carries the marker: boundary resolves on the next fold.
    foldJournalPage(journal, [ev(SEED_MSG), ev(SEED_END)], false)
    expect(journal.boundaryFound).toBe(true)
    expect(journal.seedSeq).toBe(2)
  })

  it('cuts legacy fork children at the latest seed marker when the log ends', () => {
    const journal = journalState()
    foldJournalPage(journal, [ev(SEED_MSG), ev(SEED_END), ev(USER_MSG)], false)
    expect(journal.boundaryFound).toBe(true)
    expect(displayEntries(journal).map(entry => entry.seq)).toEqual([4])
  })

  it('shows everything for spawn children without any seed marker', () => {
    const journal = journalState()
    foldJournalPage(journal, [ev(USER_MSG)], false)
    expect(journal.boundaryFound).toBe(false)
    expect(displayEntries(journal).map(entry => entry.seq)).toEqual([4])
  })
})

describe('producedPaths', () => {
  it('collects write/edit/insert paths and excludes failed and non-producing calls', () => {
    const events = [
      event('tool/call', 5, { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: '{"file_path":"a.ts"}' }),
      event('tool/result', 6, { turn: 1, step: 1, message: { role: 'tool', content: [{ toolCallId: 'c1', isError: false }] } }),
      event('tool/call', 7, { turn: 1, step: 1, callId: 'c2', name: 'edit', arguments: '{"path":"b.ts"}' }),
      event('tool/result', 8, { turn: 1, step: 1, message: { role: 'tool', content: [{ toolCallId: 'c2', isError: true }] } }),
      event('tool/call', 9, { turn: 1, step: 1, callId: 'c3', name: 'str_replace_editor', arguments: '{"command":"insert","path":"c.ts"}' }),
      event('tool/result', 10, { turn: 1, step: 1, message: { role: 'tool', content: [{ toolCallId: 'c3', isError: false }] } }),
      event('tool/call', 11, { turn: 1, step: 1, callId: 'c4', name: 'str_replace_editor', arguments: '{"command":"view","path":"c.ts"}' }),
      event('tool/result', 12, { turn: 1, step: 1, message: { role: 'tool', content: [{ toolCallId: 'c4', isError: false }] } }),
      event('tool/call', 13, { turn: 1, step: 1, callId: 'c5', name: 'read', arguments: '{"path":"d.ts"}' }),
      event('tool/result', 14, { turn: 1, step: 1, message: { role: 'tool', content: [{ toolCallId: 'c5', isError: false }] } }),
    ]
    expect(producedPaths(events)).toEqual(['a.ts', 'c.ts'])
  })
})

describe('resultViewSummary', () => {
  it('flattens content blocks and returns undefined for empty content', () => {
    expect(resultViewSummary([textBlock('结果')])).toBe('结果')
    expect(resultViewSummary([])).toBeUndefined()
  })
})

describe('mergeProduced', () => {
  it('unions vocabularies keeping first-seen order', () => {
    expect(mergeProduced(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c'])
  })
})

describe('sendPrompt', () => {
  it('routes the text through the generated subagents namespace', async () => {
    const prompt = vi.fn((_request: unknown) => Promise.resolve({ ok: true, value: {} }))
    const accepted = await sendPrompt({ prompt } as never, ADDRESS as Extract<SubagentAddress, { mode: 'continuable' }>, '继续')
    expect(accepted).toBe(true)
    const request = prompt.mock.calls[0]?.[0] as { requestId: string } | undefined
    expect(request).toMatchObject({
      parentSessionId: PARENT,
      childSessionId: CHILD,
      mode: 'continuable',
      content: [{ type: 'text', text: '继续' }],
    })
    expect(typeof request?.requestId).toBe('string')
  })
})

describe('readChildTranscript / readChildActivity (journal integration)', () => {
  it('opens one journal per child and returns the seed-cut rows', async () => {
    SessionEventStream.nextOpen.push({
      page: { records: [], hasMore: false },
      entries: [ev(SEED_MSG), ev(SEED_END), ev(BOUNDARY)],
      hasMore: false,
      live: [ev(event('assistant/message', 5, {
        turn: 1, step: 1,
        message: { role: 'assistant', content: [textBlock('回答')] },
      }))],
    })
    const remotes = fakeRemotes()
    const first = await readChildTranscript(remotes, ADDRESS)
    expect(first).toEqual({
      rows: [
        { kind: 'user', seq: 3, text: '真实问题' },
        { kind: 'assistant', seq: 5, text: '回答' },
      ],
      produced: [],
    })
    // The journal is reused: no second stream instance for the same child.
    const second = await readChildTranscript(remotes, ADDRESS)
    expect(second?.rows).toEqual(first?.rows)
    expect(SessionEventStream.instances).toHaveLength(1)
  })

  it('walks older pages until the boundary marker is found', async () => {
    SessionEventStream.nextOpen.push({
      page: { records: [], hasMore: false },
      entries: [ev(BOUNDARY)],
      hasMore: true,
    })
    SessionEventStream.nextPrepend.push({
      page: { records: [], hasMore: false },
      entries: [ev(SEED_MSG), ev(SEED_END)],
      hasMore: false,
    })
    const result = await readChildTranscript(fakeRemotes(), ADDRESS)
    expect(result?.rows).toEqual([{ kind: 'user', seq: 3, text: '真实问题' }])
  })

  it('derives the live activity line from the journal tail', async () => {
    SessionEventStream.nextOpen.push({
      page: { records: [], hasMore: false },
      entries: [
        ev(SEED_MSG), ev(SEED_END), ev(BOUNDARY),
        ev(event('tool/call', 5, { turn: 1, step: 1, callId: 'c1', name: 'grep', arguments: '{"pattern":"x"}' })),
      ],
      hasMore: false,
    })
    const line = await readChildActivity(fakeRemotes(), ADDRESS)
    expect(line).toBe('🔧 grep · x')
  })

  it('returns null when the journal fails to open', async () => {
    const journal = ensureChildJournal(fakeRemotes(), ADDRESS, 8)
    journal.failed = true
    expect(await readChildTranscript(fakeRemotes(), ADDRESS)).toBeNull()
  })
})

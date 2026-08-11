/**
 * Unit tests for the embedded side-conversation transcript model: event →
 * row mapping and the history/prompt RPC helpers.
 */

import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { SubagentAddress } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import {
  blockText, fetchTranscript, mergeProduced, producedPaths, sendPrompt, transcriptRows,
} from '../src/client/sidechain-view'

const CHILD = '54c34e5e-1c29-4a6c-a2f7-4b19a3d92914' as SessionId
const ADDRESS: SubagentAddress = { parentSessionId: 'parent-1' as SessionId, childSessionId: CHILD, mode: 'continuable' }

function event(type: SessionEvent['type'], seq: number, data: Record<string, unknown>): SessionEvent {
  return { type, seq, time: 0, data } as SessionEvent
}

describe('blockText', () => {
  it('joins text blocks with blank lines and skips non-text blocks', () => {
    expect(blockText([
      { type: 'text', text: '第一行' },
      { type: 'reasoning', text: '思考过程' },
      { type: 'text', text: '第二行' },
    ])).toBe('第一行\n\n第二行')
  })

  it('renders … for content without visible text', () => {
    expect(blockText([{ type: 'reasoning', text: 'hidden' }])).toBe('…')
    expect(blockText([])).toBe('…')
  })
})

describe('transcriptRows', () => {
  it('maps user prompts, assistant answers, and tool calls in order', () => {
    const rows = transcriptRows([
      event('user/message', 1, { content: [{ type: 'text', text: '查一下' }] }),
      event('tool/call', 2, { name: 'grep', arguments: '{}' }),
      event('tool/result', 3, { message: { content: [] } }),
      event('assistant/message', 4, { message: { content: [{ type: 'text', text: '结果如下' }] } }),
    ])
    expect(rows).toEqual([
      { kind: 'user', seq: 1, text: '查一下' },
      { kind: 'tool', seq: 2, name: 'grep', failed: false },
      { kind: 'assistant', seq: 4, text: '结果如下' },
    ])
  })

  it('folds a failing tool/result onto its call row', () => {
    const rows = transcriptRows([
      event('tool/call', 1, { name: 'grep', arguments: '{}' }),
      event('tool/result', 2, { message: { content: [] }, error: { name: 'E', code: 'C' } }),
    ])
    expect(rows).toEqual([{ kind: 'tool', seq: 1, name: 'grep', failed: true }])
  })

  it('skips log detail events (chunks, turn brackets, projections)', () => {
    const rows = transcriptRows([
      event('turn/start', 1, { turn: 1 }),
      event('assistant/chunk', 2, { turn: 1, step: 1, chunk: { type: 'usage', usage: {} } }),
      event('turn/end', 3, { turn: 1, reason: 'stop' }),
      event('session/end-seed', 4, {}),
    ])
    expect(rows).toEqual([])
  })

  it('cuts the inherited fork seed at the last session/end-seed', () => {
    const rows = transcriptRows([
      event('user/message', 1, { content: [{ type: 'text', text: '父会话的历史提问' }] }),
      event('session/end-seed', 2, {}),
      event('user/message', 3, { content: [{ type: 'text', text: '侧链提问' }] }),
      event('assistant/message', 4, { message: { content: [{ type: 'text', text: '侧链回答' }] } }),
    ])
    expect(rows).toEqual([
      { kind: 'user', seq: 3, text: '侧链提问' },
      { kind: 'assistant', seq: 4, text: '侧链回答' },
    ])
  })

  it('drops the fork boundary prompt row', () => {
    const rows = transcriptRows([
      event('session/end-seed', 1, {}),
      event('user/message', 2, {
        content: [{ type: 'text', text: 'Side conversation boundary.\n\nEverything before this boundary is reference context only.' }],
      }),
      event('assistant/message', 3, { message: { content: [{ type: 'text', text: '好的' }] } }),
    ])
    expect(rows).toEqual([{ kind: 'assistant', seq: 3, text: '好的' }])
  })

  it('accumulates text-delta chunks into a streaming row and supersedes it with the assembled message', () => {
    const stream = transcriptRows([
      event('session/end-seed', 1, {}),
      event('assistant/chunk', 2, { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '你好' } }),
      event('assistant/chunk', 3, { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '，世界' } }),
    ])
    expect(stream).toEqual([{ kind: 'assistant', seq: 2, text: '你好，世界' }])
    const settled = transcriptRows([
      event('session/end-seed', 1, {}),
      event('assistant/chunk', 2, { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '你好' } }),
      event('assistant/chunk', 3, { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '，世界' } }),
      event('assistant/message', 4, { turn: 1, step: 1, message: { content: [{ type: 'text', text: '你好，世界！' }] } }),
    ])
    expect(settled).toEqual([{ kind: 'assistant', seq: 4, text: '你好，世界！' }])
  })

  it('ignores reasoning deltas and non-text chunks', () => {
    const rows = transcriptRows([
      event('session/end-seed', 1, {}),
      event('assistant/chunk', 2, { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: '思考中' } }),
      event('assistant/chunk', 3, { turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 0, id: 'c1', argumentsDelta: '{}' } }),
      event('assistant/chunk', 4, { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } }),
      event('assistant/message', 5, { turn: 1, step: 1, message: { content: [{ type: 'text', text: '最终答案' }] } }),
    ])
    expect(rows).toEqual([{ kind: 'assistant', seq: 5, text: '最终答案' }])
  })
})

describe('mergeProduced', () => {
  it('unions vocabularies in first-seen order, deduped', () => {
    expect(mergeProduced(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c'])
    expect(mergeProduced([], ['a'])).toEqual(['a'])
  })
})

describe('fetchTranscript', () => {
  it('maps the history tail page to rows', async () => {
    const history = vi.fn(() => Promise.resolve({
      result: {
        ok: true,
        value: {
          events: [
            { event: event('user/message', 1, { content: [{ type: 'text', text: '嗨' }] }) },
            { event: event('assistant/message', 2, { message: { content: [{ type: 'text', text: '你好' }] } }) },
          ],
          hasMore: false,
        },
      },
    }))
    const result = await fetchTranscript({ history } as never, ADDRESS)
    expect(history).toHaveBeenCalledWith({ sessionId: CHILD, maxMessages: 20 })
    expect(result).toEqual({
      rows: [
        { kind: 'user', seq: 1, text: '嗨' },
        { kind: 'assistant', seq: 2, text: '你好' },
      ],
      produced: [],
    })
  })

  it('returns null on business failure', async () => {
    const history = vi.fn(() => Promise.resolve({ result: { ok: false, error: { code: 'x', message: 'x' } } }))
    expect(await fetchTranscript({ history } as never, ADDRESS)).toBeNull()
  })

  it('returns null on transport failure', async () => {
    const history = vi.fn(() => Promise.reject(new Error('network')))
    expect(await fetchTranscript({ history } as never, ADDRESS)).toBeNull()
  })

  it('extracts the produced-file vocabulary from call views', async () => {
    const history = vi.fn(() => Promise.resolve({
      result: {
        ok: true,
        value: {
          events: [
            { event: event('tool/call', 1, { name: 'write', arguments: '{}' }), view: { for: 'call', view: { card: 'diff', title: 'w', diffs: [], locations: [{ path: '/w/src/a.ts' }] } } },
          ],
          hasMore: false,
        },
      },
    }))
    const result = await fetchTranscript({ history } as never, ADDRESS)
    expect(result).toEqual({
      rows: [{ kind: 'tool', seq: 1, name: 'write', failed: false }],
      produced: ['/w/src/a.ts'],
    })
  })
})

describe('sendPrompt', () => {
  it('delivers a text block through subagent.prompt', async () => {
    const prompt = vi.fn(() => Promise.resolve({ result: { ok: true } }))
    const accepted = await sendPrompt({ prompt } as never, ADDRESS, '继续')
    expect(prompt).toHaveBeenCalledWith({
      ...ADDRESS,
      content: [{ type: 'text', text: '继续' }],
    })
    expect(accepted).toBe(true)
  })

  it('returns false on rejection', async () => {
    const prompt = vi.fn(() => Promise.resolve({ result: { ok: false, error: { code: 'x', message: 'x' } } }))
    expect(await sendPrompt({ prompt } as never, ADDRESS, '继续')).toBe(false)
  })
})

describe('producedPaths', () => {
  it('collects diff and edit-call locations in first-seen order, deduped', () => {
    const entries = [
      { event: event('tool/call', 1, { name: 'write', arguments: '{}' }), view: { for: 'call' as const, view: { card: 'diff' as const, title: 'Write a', diffs: [], locations: [{ path: 'src/a.ts' }] } } },
      { event: event('tool/call', 2, { name: 'edit', arguments: '{}' }), view: { for: 'call' as const, view: { card: 'generic' as const, title: 'Edit', kind: 'edit' as const, locations: [{ path: 'src/b.ts' }, { path: 'src/a.ts' }] } } },
      { event: event('tool/call', 3, { name: 'read', arguments: '{}' }), view: { for: 'call' as const, view: { card: 'generic' as const, title: 'Read', kind: 'read' as const, locations: [{ path: 'src/c.ts' }] } } },
    ]
    expect(producedPaths(entries)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('cuts the inherited seed and excludes failed calls', () => {
    const entries = [
      // Parent seed: a write that must NOT leak into the child vocabulary.
      { event: event('tool/call', 1, { name: 'write', arguments: '{}', callId: 'p1' }), view: { for: 'call' as const, view: { card: 'diff' as const, title: 'p', diffs: [], locations: [{ path: 'parent-only.ts' }] } } },
      { event: event('session/end-seed', 2, {}) },
      // Child write: failed result -> excluded.
      { event: event('tool/call', 3, { name: 'write', arguments: '{}', callId: 'c1' }), view: { for: 'call' as const, view: { card: 'diff' as const, title: 'c', diffs: [], locations: [{ path: 'failed.ts' }] } } },
      { event: event('tool/result', 4, { message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [] }] }, error: { name: 'E', code: 'C' } }) },
      // Child write: success -> the only produced path.
      { event: event('tool/call', 5, { name: 'write', arguments: '{}', callId: 'c2' }), view: { for: 'call' as const, view: { card: 'diff' as const, title: 'c', diffs: [], locations: [{ path: 'made.ts' }] } } },
      { event: event('tool/result', 6, { message: { content: [{ type: 'tool-result', toolCallId: 'c2', content: [] }] } }) },
    ]
    expect(producedPaths(entries)).toEqual(['made.ts'])
  })

  it('ignores result views, missing views, and non-mutation kinds', () => {
    const entries = [
      { event: event('tool/call', 1, { name: 'x', arguments: '{}' }), view: { for: 'result' as const, view: { card: 'diff' as const, title: 'x', diffs: [] } } },
      { event: event('tool/call', 2, { name: 'y', arguments: '{}' }) },
      { event: event('tool/call', 3, { name: 'z', arguments: '{}' }), view: { for: 'call' as const, view: { card: 'generic' as const, title: 'z', kind: 'execute' as const } } },
    ]
    expect(producedPaths(entries)).toEqual([])
  })
})

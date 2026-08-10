/**
 * Unit tests for the embedded side-conversation transcript model: event →
 * row mapping and the history/prompt RPC helpers.
 */

import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { SubagentAddress } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { blockText, fetchTranscript, sendPrompt, transcriptRows } from '../src/client/sidechain-view'

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
      { kind: 'user', text: '查一下' },
      { kind: 'tool', name: 'grep', failed: false },
      { kind: 'assistant', text: '结果如下' },
    ])
  })

  it('folds a failing tool/result onto its call row', () => {
    const rows = transcriptRows([
      event('tool/call', 1, { name: 'grep', arguments: '{}' }),
      event('tool/result', 2, { message: { content: [] }, error: { name: 'E', code: 'C' } }),
    ])
    expect(rows).toEqual([{ kind: 'tool', name: 'grep', failed: true }])
  })

  it('skips log detail events (chunks, turn brackets, projections)', () => {
    const rows = transcriptRows([
      event('turn/start', 1, { turn: 1 }),
      event('assistant/chunk', 2, { turn: 1, step: 1, chunk: {} }),
      event('turn/end', 3, { turn: 1, reason: 'stop' }),
      event('session/end-seed', 4, {}),
    ])
    expect(rows).toEqual([])
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
    const rows = await fetchTranscript({ history } as never, ADDRESS)
    expect(history).toHaveBeenCalledWith({ ...ADDRESS, maxMessages: 200 })
    expect(rows).toEqual([
      { kind: 'user', text: '嗨' },
      { kind: 'assistant', text: '你好' },
    ])
  })

  it('returns null on business failure', async () => {
    const history = vi.fn(() => Promise.resolve({ result: { ok: false, error: { code: 'x', message: 'x' } } }))
    expect(await fetchTranscript({ history } as never, ADDRESS)).toBeNull()
  })

  it('returns null on transport failure', async () => {
    const history = vi.fn(() => Promise.reject(new Error('network')))
    expect(await fetchTranscript({ history } as never, ADDRESS)).toBeNull()
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

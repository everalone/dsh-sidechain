/**
 * Unit tests for the dsh-sidechain browser half: the jump-target resolver and
 * the slot registration wiring (auto-open of created side conversations).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandNode } from '@deepseek-ai/dsh-client-runtime/client'
import { apply } from '../src/client/index'
import { resolveChildSessionId, shouldAutoJump } from '../src/client/SideCommandCard'
import { isSidechainPanelOpen, resetSidechainPanel, selectedChildId } from '../src/client/panel-state'

const CHILD_ID = '54c34e5e-1c29-4a6c-a2f7-4b19a3d92914'

function node(partial: Partial<CommandNode> = {}): CommandNode {
  return {
    kind: 'command',
    seq: 1,
    time: 0,
    commandId: 'cmd-1' as CommandNode['commandId'],
    name: 'side',
    args: null,
    outcome: null,
    ...partial,
  }
}

describe('resolveChildSessionId', () => {
  it('resolves /side success text', () => {
    expect(resolveChildSessionId(node({
      name: 'side',
      outcome: { kind: 'success', text: `Side conversation started: ${CHILD_ID}.` },
    }), 'side')).toBe(CHILD_ID)
  })

  it('resolves /btw success text with the answer prefix', () => {
    expect(resolveChildSessionId(node({
      name: 'btw',
      outcome: { kind: 'success', text: `1+1=2。\n\n(btw session: ${CHILD_ID})` },
    }), 'btw')).toBe(CHILD_ID)
  })

  it('returns undefined while the command is running', () => {
    expect(resolveChildSessionId(node({ outcome: null }), 'side')).toBeUndefined()
  })

  it('returns undefined on failure', () => {
    expect(resolveChildSessionId(node({ outcome: { kind: 'error', text: 'boom' } }), 'side')).toBeUndefined()
  })

  it('returns undefined on malformed text', () => {
    expect(resolveChildSessionId(node({ outcome: { kind: 'success', text: 'no id here' } }), 'side')).toBeUndefined()
    expect(resolveChildSessionId(node({ outcome: { kind: 'success', text: 'plain answer' } }), 'btw')).toBeUndefined()
  })
})

describe('shouldAutoJump', () => {
  it('jumps on a live pending→success transition', () => {
    expect(shouldAutoJump('pending', { kind: 'success', text: `Side conversation started: ${CHILD_ID}.` })).toBe(true)
  })

  it('never jumps on a settled (history-replay) mount', () => {
    expect(shouldAutoJump('settled', { kind: 'success', text: `Side conversation started: ${CHILD_ID}.` })).toBe(false)
  })

  it('does not jump while running or after failure', () => {
    expect(shouldAutoJump('pending', null)).toBe(false)
    expect(shouldAutoJump('pending', { kind: 'error', text: 'boom' })).toBe(false)
  })
})

describe('client apply wiring', () => {
  interface RegisteredSlot {
    options: {
      name: string
      key?: string
      id?: string
      order?: number
      locale?: string
      inject?: (parentSessionId: string) => {
        revealPanel?: (childSessionId: string) => void
        readTranscript?: (address: unknown) => Promise<unknown>
        sendPrompt?: (address: unknown, text: string) => Promise<boolean>
        refresh?: (parentSessionId: string) => void
        setCatalogOpen?: (parentSessionId: string, open: boolean) => void
      }
    }
  }

  beforeEach(() => {
    resetSidechainPanel()
  })

  function fakeCtx() {
    const registered: RegisteredSlot[] = []
    const refreshSubagents = vi.fn(() => Promise.resolve())
    const setSubagentCatalogOpen = vi.fn()
    const registerLocale = vi.fn()
    const history = vi.fn(() => Promise.resolve({ result: { ok: true, value: { events: [], hasMore: false } } }))
    const prompt = vi.fn(() => Promise.resolve({ result: { ok: true } }))
    const connection = { api: { subagents: { history, prompt } } }
    const ctx = {
      sessions: { refreshSubagents, setSubagentCatalogOpen, binding: vi.fn(() => undefined) },
      locale: { register: registerLocale },
      effect: (fn: () => void) => { fn() },
      get: (name: string) => (name === 'connection' ? connection : undefined),
      slots: {
        register: (options: RegisteredSlot['options'], _component: unknown) => {
          registered.push({ options })
          return () => {}
        },
        // The real runtime waits for the slot declaration before running the
        // register callback; the declaration exists in this test context.
        inject: (_name: string, register: () => () => void) => {
          register()
        },
      },
    }
    return { ctx, registered, history, prompt, refreshSubagents, setSubagentCatalogOpen }
  }

  it('registers keyed cards and the sidechain panel action', () => {
    const { ctx, registered } = fakeCtx()
    apply(ctx as never)
    expect(registered.map(entry => [entry.options.name, entry.options.key ?? entry.options.id]))
      .toEqual([
        ['conversation.chat.commandview', 'side'],
        ['conversation.chat.commandview', 'btw'],
        ['conversation.session.header.actions', 'sidechain-panel'],
      ])
  })

  it('panel action sits after the subagent catalog in the header', () => {
    const { ctx, registered } = fakeCtx()
    apply(ctx as never)
    const panel = registered.find(entry => entry.options.id === 'sidechain-panel')!
    expect(panel.options.order).toBe(20)
    expect(panel.options.locale).toBe('sidechain')
  })

  it('/side card reveal selects the child without switching the main view', () => {
    const { ctx, registered } = fakeCtx()
    apply(ctx as never)
    const entry = registered.find(item => item.options.key === 'side')!
    const injected = entry.options.inject!('parent-1')
    expect(isSidechainPanelOpen()).toBe(false)
    expect(selectedChildId()).toBeUndefined()
    injected.revealPanel!(CHILD_ID)
    expect(isSidechainPanelOpen()).toBe(true)
    expect(selectedChildId()).toBe(CHILD_ID)
  })

  it('/btw card reveal selects the child too', () => {
    const { ctx, registered } = fakeCtx()
    apply(ctx as never)
    const entry = registered.find(item => item.options.key === 'btw')!
    const injected = entry.options.inject!('parent-1')
    injected.revealPanel!(CHILD_ID)
    expect(selectedChildId()).toBe(CHILD_ID)
  })

  it('panel inject wires the transcript RPC and catalog methods', async () => {
    const { ctx, registered, history, prompt, refreshSubagents, setSubagentCatalogOpen } = fakeCtx()
    apply(ctx as never)
    const entry = registered.find(item => item.options.id === 'sidechain-panel')!
    const injected = entry.options.inject!('parent-1')
    const address = { parentSessionId: 'parent-1', childSessionId: CHILD_ID, mode: 'continuable' }
    const transcript = await injected.readTranscript!(address)
    expect(history).toHaveBeenCalledWith({ ...address, maxMessages: 20 })
    expect(transcript).toEqual([])
    const accepted = await injected.sendPrompt!(address, '继续')
    expect(prompt).toHaveBeenCalledWith({ ...address, content: [{ type: 'text', text: '继续' }] })
    expect(accepted).toBe(true)
    injected.refresh!('parent-1')
    expect(refreshSubagents).toHaveBeenCalledWith('parent-1')
    injected.setCatalogOpen!('parent-1', true)
    expect(setSubagentCatalogOpen).toHaveBeenCalledWith('parent-1', true)
  })
})

/**
 * Unit tests for the dsh-sidechain browser half: the jump-target resolver and
 * the slot registration wiring (auto-open of created side conversations).
 */

import { describe, expect, it, vi } from 'vitest'
import type { CommandNode } from '@deepseek-ai/dsh-client-runtime/client'
import { apply } from '../src/client/index'
import { resolveChildSessionId } from '../src/client/SideCommandCard'

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

describe('client apply wiring', () => {
  interface RegisteredSlot {
    options: {
      name: string
      key?: string
      inject?: (parentSessionId: string) => { openChild: (childSessionId: string) => void }
    }
  }

  function fakeCtx() {
    const registered: RegisteredSlot[] = []
    const openSubagent = vi.fn()
    const ctx = {
      sessions: { openSubagent },
      slots: {
        register: (options: RegisteredSlot['options'], _component: unknown) => {
          registered.push({ options })
          return () => {}
        },
      },
      effect: (fn: () => unknown) => { fn() },
    }
    return { ctx, registered, openSubagent }
  }

  it('registers keyed cards for /side and /btw', () => {
    const { ctx, registered } = fakeCtx()
    apply(ctx as never)
    expect(registered.map(entry => [entry.options.name, entry.options.key]))
      .toEqual([['conversation.chat.commandview', 'side'], ['conversation.chat.commandview', 'btw']])
  })

  it('/side inject opens the child as a continuable conversation', () => {
    const { ctx, registered, openSubagent } = fakeCtx()
    apply(ctx as never)
    const entry = registered.find(item => item.options.key === 'side')!
    const injected = entry.options.inject!('parent-1')
    injected.openChild(CHILD_ID)
    expect(openSubagent).toHaveBeenCalledWith({ parentSessionId: 'parent-1', childSessionId: CHILD_ID, mode: 'continuable' })
  })

  it('/btw inject opens the child as a one-shot transcript', () => {
    const { ctx, registered, openSubagent } = fakeCtx()
    apply(ctx as never)
    const entry = registered.find(item => item.options.key === 'btw')!
    const injected = entry.options.inject!('parent-1')
    injected.openChild(CHILD_ID)
    expect(openSubagent).toHaveBeenCalledWith({ parentSessionId: 'parent-1', childSessionId: CHILD_ID, mode: 'one-shot' })
  })
})

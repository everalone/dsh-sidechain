/**
 * Unit tests for settlement-notice silencing: side children's `subagent-settled`
 * notices are dropped from the parent's pre-step turn, everything else passes.
 */

import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import { loadSideChildren, noteSideChild, registerSettlementSilence } from '../src/settle-silence'

const SIDE = '11111111-1111-4111-8111-111111111111' as SessionId
const OTHER = '22222222-2222-4222-8222-222222222222' as SessionId

function notice(sender: string): UserMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: 'Background subagent finished.' }],
    source: { kind: 'subagent-settled', form: 'notice', senderSessionId: sender },
  } as unknown as UserMessage
}

function userMessage(text: string): UserMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  } as unknown as UserMessage
}

/** The runtime-context message the host's default pre-step handler appends. */
function contextMessage(): UserMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: '<runtime context>' }],
    source: { kind: 'context' },
  } as unknown as UserMessage
}

/** Capture the handler a ctx.on('agent/pre-step') registration installs. */
function captureHandler(): { handler: (payload: unknown, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision> } {
  const box = { handler: (() => Promise.resolve<PreStepDecision>({ kind: 'reject' })) as never }
  const ctx = {
    on: (_name: string, handler: unknown) => {
      box.handler = handler as never
      return () => {}
    },
  }
  registerSettlementSilence(ctx as never)
  return box as unknown as { handler: (payload: unknown, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision> }
}

async function run(
  handler: (payload: unknown, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>,
  claimed: UserMessage[],
  extras: UserMessage[] = [],
): Promise<PreStepDecision> {
  return handler({ agent: {}, messages: claimed } as never, async () => ({
    kind: 'enter' as const,
    messages: [...claimed, ...extras],
  }))
}

beforeEach(() => {
  vi.stubEnv('DSH_HOME', mkdtempSync(join(tmpdir(), 'dsh-sidechain-silence-')))
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('registerSettlementSilence', () => {
  it('drops the settlement notice of a recorded side child', async () => {
    noteSideChild(SIDE)
    const { handler } = captureHandler()
    const decision = await run(handler, [userMessage('继续干活'), notice(SIDE)])
    expect(decision).toEqual({ kind: 'enter', messages: [userMessage('继续干活')] })
  })

  it('rewrites an all-settlement batch to empty — no model call', async () => {
    noteSideChild(SIDE)
    const { handler } = captureHandler()
    const decision = await run(handler, [notice(SIDE)])
    expect(decision).toEqual({ kind: 'enter', messages: [] })
  })

  it('drops the appended runtime context too when nothing of the user remains', async () => {
    noteSideChild(SIDE)
    const { handler } = captureHandler()
    // The host appends its context message after the claimed batch; with every
    // claimed message removed, the turn must still close without a model call.
    const decision = await run(handler, [notice(SIDE)], [contextMessage()])
    expect(decision).toEqual({ kind: 'enter', messages: [] })
  })

  it('keeps the runtime context when a real user message survives', async () => {
    noteSideChild(SIDE)
    const { handler } = captureHandler()
    const decision = await run(handler, [userMessage('用户消息'), notice(SIDE)], [contextMessage()])
    expect(decision).toEqual({ kind: 'enter', messages: [userMessage('用户消息'), contextMessage()] })
  })

  it('passes settlement notices of children this plugin did not create', async () => {
    const { handler } = captureHandler()
    const decision = await run(handler, [notice(OTHER)])
    expect(decision).toEqual({ kind: 'enter', messages: [notice(OTHER)] })
  })

  it('passes every other message untouched', async () => {
    noteSideChild(SIDE)
    const { handler } = captureHandler()
    const decision = await run(handler, [userMessage('普通消息')])
    expect(decision).toEqual({ kind: 'enter', messages: [userMessage('普通消息')] })
  })

  it('passes a rejected downstream decision through', async () => {
    noteSideChild(SIDE)
    const { handler } = captureHandler()
    const decision = await handler({} as never, async () => ({ kind: 'reject' as const }))
    expect(decision).toEqual({ kind: 'reject' })
  })

  it('returns a disposer that removes the listener', () => {
    const dispose = vi.fn(() => {})
    const ctx = { on: () => dispose }
    const returned = registerSettlementSilence(ctx as never)
    returned()
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})

describe('durable child-id registry', () => {
  it('persists recorded ids under DSH_HOME and reloads them', async () => {
    const home = process.env.DSH_HOME!
    noteSideChild(SIDE)
    const path = join(home, 'sidechain-children.json')
    expect(existsSync(path)).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toContain(SIDE)
    // A fresh process would load the same file (in-process load is idempotent).
    loadSideChildren()
    const { handler } = captureHandler()
    const decision = await run(handler, [notice(SIDE)])
    expect(decision).toEqual({ kind: 'enter', messages: [] })
  })
})

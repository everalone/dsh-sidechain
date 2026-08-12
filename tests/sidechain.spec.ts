/**
 * Unit tests for the dsh-sidechain plugin: command registration, `/side` and
 * `/btw` semantics against a stubbed subagent service, pinned prompt text, and
 * config-driven wiring.
 */

import { describe, expect, it, vi } from 'vitest'
import type { CommandDefinition, CommandId, CommandInvocation } from '@deepseek-ai/dsh-commands'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  ContinuableStart,
  ContinuableStartSpec,
  SubagentListEntry,
  SubagentRun,
  SubagentStartRequest,
} from '@deepseek-ai/dsh-subagent'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'
import { apply, Config, inject, name } from '../src/index'
import { createSidechainCommands } from '../src/commands'
import { SIDE_BOUNDARY_PROMPT, SIDE_PERSONA, SIDE_WAITING_NOTE } from '../src/prompts'
import {
  formatSideList,
  truncateLabel,
  type SideDeps,
  type SubagentsLike,
} from '../src/side'

const PARENT_ID = 'parent-1' as SessionId
const CHILD_ID = 'child-9' as SessionId

const agent = { session: { id: PARENT_ID } } as never

const DEFAULT_DEPS: SideDeps = {
  providerName: 'fork',
  persona: SIDE_PERSONA,
}

interface Harness {
  subagents: SubagentsLike & {
    start: ReturnType<typeof vi.fn>
    startContinuable: ReturnType<typeof vi.fn>
    listChildren: ReturnType<typeof vi.fn>
    getProvider: ReturnType<typeof vi.fn>
  }
  commands: CommandDefinition[]
}

function makeHarness(deps: SideDeps = DEFAULT_DEPS): Harness {
  const subagents = {
    start: vi.fn(),
    startContinuable: vi.fn(),
    listChildren: vi.fn(),
    getProvider: vi.fn(() => ({ name: deps.providerName })),
  } as unknown as Harness['subagents']
  const commands = createSidechainCommands(subagents, deps)
  return { subagents, commands }
}

function invoke(
  command: CommandDefinition,
  rawInput: string,
  signal = new AbortController().signal,
): ReturnType<NonNullable<CommandDefinition['handler']>> {
  return command.handler({ commandId: 'cmd-test-1' as CommandId, agent, rawInput, signal } as CommandInvocation)
}

function textOf(block: ContentBlock): string {
  return block.type === 'text' ? block.text : ''
}

/** A minimal started run; by default its result never settles (still running). */
function runOf(result: Promise<unknown> = new Promise<never>(() => {})): SubagentRun {
  return {
    id: CHILD_ID,
    local: true,
    stopReason: 'completed',
    lastAssistantMessage: [],
    result,
    dispose: vi.fn().mockResolvedValue(undefined),
  } as unknown as SubagentRun
}

type ChildEntry = Extract<SubagentListEntry, { kind: 'child' }>

function childEntry(partial: Partial<ChildEntry> = {}): SubagentListEntry {
  const mode = partial.mode ?? 'continuable'
  const label = (partial as { label?: string }).label
  return {
    kind: 'child',
    id: partial.id ?? CHILD_ID,
    activity: partial.activity ?? 'inactive',
    hasChildren: partial.hasChildren ?? false,
    mode,
    ...(mode === 'continuable'
      ? { label: label ?? 'Side conversation' }
      : label === undefined ? {} : { label }),
  } as SubagentListEntry
}

describe('pinned prompt text', () => {
  it('boundary marks inherited history as reference context only', () => {
    expect(SIDE_BOUNDARY_PROMPT).toContain('Side conversation boundary.')
    expect(SIDE_BOUNDARY_PROMPT).toContain('It is reference context only.')
    expect(SIDE_BOUNDARY_PROMPT).toContain('Only messages submitted after this boundary are active user instructions')
  })

  it('persona forbids mutation unless asked and keeps sub-agents off-limits', () => {
    expect(SIDE_PERSONA).toContain('Do not modify files, source, git state, permissions, configuration, or workspace state unless the user explicitly asks')
    expect(SIDE_PERSONA).toContain('Sub-agents are off-limits in this side conversation')
    expect(SIDE_PERSONA).not.toContain('{{')
  })
})

describe('command registration', () => {
  it('registers /side and /btw in order', () => {
    const { commands } = makeHarness()
    expect(commands.map(command => command.name)).toEqual(['side', 'btw'])
  })

  it('/btw declares an argument hint', () => {
    const { commands } = makeHarness()
    expect(commands[1]?.input).toEqual({ hint: '<question>' })
  })

  it('keeps descriptions terse like Codex', () => {
    const { commands } = makeHarness()
    expect(commands[0]?.description).toBe('Start a side conversation in an ephemeral fork of the current session')
    expect(commands[1]?.description).toBe('Ask a quick question in an ephemeral fork of the current session')
  })
})

describe('/btw (non-blocking one-shot side question)', () => {
  it('starts a one-shot run with boundary + question and returns the child id', async () => {
    const { subagents, commands } = makeHarness()
    subagents.start.mockResolvedValue(runOf())

    const result = await invoke(commands[1]!, '  what is 6*7?  ')

    expect(result).toEqual({ kind: 'success', text: `BTW question started: ${String(CHILD_ID)}.` })
    expect(subagents.start).toHaveBeenCalledTimes(1)
    expect(subagents.start).toHaveBeenCalledWith('fork', expect.objectContaining({
      label: 'BTW: what is 6*7?',
      parent: agent,
      persona: SIDE_PERSONA,
    }))
    const request = subagents.start.mock.calls[0]![1] as SubagentStartRequest
    const prompt = textOf(request.prompt[0]!)
    expect(prompt).toContain(SIDE_BOUNDARY_PROMPT)
    expect(prompt).toContain('what is 6*7?')
  })

  it('resolves without awaiting the child result and keeps the run alive', async () => {
    const { subagents, commands } = makeHarness()
    const run = runOf()
    subagents.start.mockResolvedValue(run)

    const result = await invoke(commands[1]!, 'question')

    // The handler returns while the child is still running — the main session
    // input stays free and the panel streams the answer from the child.
    expect(result.kind).toBe('success')
    expect(run.dispose).not.toHaveBeenCalled()
  })

  it('rejects an empty question without calling the provider', async () => {
    const { subagents, commands } = makeHarness()
    const result = await invoke(commands[1]!, '   ')

    expect(result).toEqual({ kind: 'error', text: '/btw requires a question: /btw <question>' })
    expect(subagents.start).not.toHaveBeenCalled()
  })

  it('fails loud with a mount hint when the provider is missing', async () => {
    const { subagents, commands } = makeHarness()
    subagents.getProvider.mockReturnValue(undefined)

    const result = await invoke(commands[1]!, 'question')

    expect(result.kind).toBe('error')
    expect(result.kind === 'error' && result.text).toContain('provider "fork" is not registered')
    expect(result.kind === 'error' && result.text).toContain('@deepseek-ai/dsh-subagent-fork')
    expect(subagents.start).not.toHaveBeenCalled()
  })

  it('returns an error result when starting the child fails', async () => {
    const { subagents, commands } = makeHarness()
    subagents.start.mockRejectedValue(new Error('boom'))

    const result = await invoke(commands[1]!, 'question')

    expect(result.kind).toBe('error')
    expect(result.kind === 'error' && result.text).toContain('/btw failed: boom')
  })
})

describe('/side (continuable side thread)', () => {
  it('starts a continuable fork child labeled from the question', async () => {
    const { subagents, commands } = makeHarness()
    subagents.startContinuable.mockResolvedValue({ childId: CHILD_ID, messageId: 'm1' } as ContinuableStart)

    const result = await invoke(commands[0]!, '  investigate the plugin seams  ')

    expect(result).toEqual({ kind: 'success', text: `Side conversation started: ${String(CHILD_ID)}.` })
    expect(subagents.startContinuable).toHaveBeenCalledTimes(1)
    const spec = subagents.startContinuable.mock.calls[0]![0] as ContinuableStartSpec
    expect(spec.provider).toBe('fork')
    expect(spec.label).toBe('investigate the plugin seams')
    expect(spec.request.parent).toBe(agent)
    expect(spec.request.persona).toBe(SIDE_PERSONA)
    const prompt = textOf(spec.request.prompt[0]!)
    expect(prompt).toContain(SIDE_BOUNDARY_PROMPT)
    expect(prompt).toContain('investigate the plugin seams')
  })

  it('uses a default label and waiting note when no question is given', async () => {
    const { subagents, commands } = makeHarness()
    subagents.startContinuable.mockResolvedValue({ childId: CHILD_ID, messageId: 'm1' } as ContinuableStart)

    await invoke(commands[0]!, '')

    const spec = subagents.startContinuable.mock.calls[0]![0] as ContinuableStartSpec
    expect(spec.label).toBe('Side conversation')
    expect(textOf(spec.request.prompt[0]!)).toContain(SIDE_WAITING_NOTE)
  })

  it('lists children of the current session through /side list', async () => {
    const { subagents, commands } = makeHarness()
    subagents.listChildren.mockResolvedValue([
      childEntry({ activity: 'running', label: 'seams research' }),
      childEntry({ mode: 'one-shot', label: 'BTW: quick check' }),
      { kind: 'diagnostic', id: 'child-3' as SessionId, reason: 'corrupt' },
    ])

    const result = await invoke(commands[0]!, 'list')

    expect(subagents.listChildren).toHaveBeenCalledWith(PARENT_ID, expect.any(AbortSignal))
    expect(result.kind).toBe('success')
    const text = result.kind === 'success' ? result.text : ''
    expect(text).toContain('[side/running] seams research')
    expect(text).toContain('[btw/inactive] BTW: quick check')
    expect(text).toContain('[unavailable] child-3 (corrupt)')
  })

  it('reports an empty catalog', async () => {
    const { subagents, commands } = makeHarness()
    subagents.listChildren.mockResolvedValue([])

    const result = await invoke(commands[0]!, 'ls')

    expect(result).toEqual({ kind: 'success', text: 'No side conversations yet. Start one with /side <question>.' })
  })
})

describe('text helpers', () => {
  it('builds one-line labels from question prefixes', () => {
    expect(truncateLabel('  multiple   spaces  ')).toBe('multiple spaces')
    expect(truncateLabel('')).toBe('')
    expect(truncateLabel('🙂'.repeat(60))).toContain('…')
  })

  it('formats an empty catalog and mixed entries', () => {
    expect(formatSideList([])).toBe('No side conversations yet. Start one with /side <question>.')
    const text = formatSideList([
      childEntry({ mode: 'one-shot' }),
      childEntry({ mode: 'continuable', label: 'named side' }),
    ])
    expect(text).toContain('[btw/inactive] (one-shot)')
    expect(text).toContain('[side/inactive] named side')
  })
})

describe('plugin wiring', () => {
  it('exports the conventional plugin shape', () => {
    expect(name).toBe('dsh-sidechain')
    expect(inject).toEqual(['subagents'])
    expect(Config).toBeDefined()
  })

  it('registers both commands when a command registry is composed', () => {
    const registered: CommandDefinition[] = []
    const fakeCtx = {
      subagents: makeHarness().subagents,
      inject: (_deps: string[], callback: (inner: { commands: { register: (d: CommandDefinition) => void } }) => void) => {
        callback({ commands: { register: definition => { registered.push(definition) } } })
      },
    }
    apply(fakeCtx as never, { providerName: 'fork', persona: SIDE_PERSONA })

    expect(registered.map(definition => definition.name)).toEqual(['side', 'btw'])
  })

  it('passes the configured readOnlyTools allow-list as the child tool filter', async () => {
    const harness = makeHarness()
    const registered: CommandDefinition[] = []
    const fakeCtx = {
      subagents: harness.subagents,
      inject: (_deps: string[], callback: (inner: { commands: { register: (d: CommandDefinition) => void } }) => void) => {
        callback({ commands: { register: definition => { registered.push(definition) } } })
      },
    }
    apply(fakeCtx as never, {
      providerName: 'fork',
      persona: SIDE_PERSONA,
      readOnlyTools: ['read', 'grep'],
    })

    const run = runOf()
    harness.subagents.start.mockResolvedValue(run)
    await invoke(registered[1]!, 'question')

    const request = harness.subagents.start.mock.calls[0]![1] as SubagentStartRequest
    expect(request.toolFilter).toEqual({ allow: ['read', 'grep'] } satisfies ToolRestriction)
  })
})

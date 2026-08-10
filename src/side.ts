/**
 * Side-conversation operations over the `ctx.subagents` fork provider.
 *
 * Both commands share one mechanism (Codex semantics): fork the current
 * session — the child inherits the parent's completed conversation turns as
 * reference context only — then either run one disposable question (`/btw`,
 * one-shot) or open a durable continuable side thread (`/side`).
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
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
import { SIDE_BOUNDARY_PROMPT, SIDE_WAITING_NOTE } from './prompts.ts'

/** Minimal structural face of the subagent service this plugin consumes. */
export interface SubagentsLike {
  start(name: string, request: SubagentStartRequest): Promise<SubagentRun>
  startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>
  listChildren(parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentListEntry[]>
  getProvider(name: string): { readonly name: string } | undefined
}

/** Shared side-conversation behavior for both commands. */
export interface SideDeps {
  /** Provider name on `ctx.subagents`; the fork backend registers as `fork`. */
  providerName: string
  /** Persona shadowing the deployment persona inside side-conversation children. */
  persona?: string
  /** Optional allow-list restriction applied to side-conversation children. */
  toolFilter?: ToolRestriction
}

/** Maximum code points kept in a durable child label. */
export const LABEL_MAX_CHARS = 48

/** One text content block. */
export function textBlock(text: string): ContentBlock {
  return { type: 'text', text }
}

/**
 * The side conversation's opening user message: the boundary prompt, then the
 * user's question when present, or a waiting note when the side conversation
 * starts empty.
 */
export function sidePrompt(question?: string): ContentBlock {
  const body = question?.trim()
  const tail = body === undefined || body === ''
    ? `\n\n${SIDE_WAITING_NOTE}`
    : `\n\n${body}`
  return textBlock(SIDE_BOUNDARY_PROMPT + tail)
}

/**
 * Start one disposable side question (`/btw`): a one-shot fork run whose
 * result carries the answer; the child session stays out of the main history.
 */
export function askSideOneShot(
  subagents: SubagentsLike,
  parent: Agent,
  question: string,
  deps: SideDeps,
  signal: AbortSignal,
): Promise<SubagentRun> {
  return subagents.start(deps.providerName, {
    label: `BTW: ${truncateLabel(question)}`,
    prompt: [sidePrompt(question)],
    parent,
    signal,
    ...(deps.persona === undefined ? {} : { persona: deps.persona }),
    ...(deps.toolFilter === undefined ? {} : { toolFilter: deps.toolFilter }),
  })
}

/**
 * Start a durable continuable side thread (`/side`): a named fork child that
 * keeps its own session, appears in the web subagent catalog, and can be
 * continued while the main thread keeps running.
 */
export function startSideConversation(
  subagents: SubagentsLike,
  parent: Agent,
  question: string,
  deps: SideDeps,
  signal: AbortSignal,
): Promise<ContinuableStart> {
  // A bare `/side` gets a short marker label — deliberately NOT the harness's
  // own "Side conversation" agent label, so the sidechain panel can tell the
  // user's empty side threads apart from the platform's resident side agent.
  const label = truncateLabel(question) || 'Side'
  return subagents.startContinuable({
    provider: deps.providerName,
    label,
    request: {
      prompt: [sidePrompt(question)],
      parent,
      ...(deps.persona === undefined ? {} : { persona: deps.persona }),
      ...(deps.toolFilter === undefined ? {} : { toolFilter: deps.toolFilter }),
    },
    signal,
  })
}

/** Join the text blocks of a one-shot result into one readable answer. */
export function renderResultText(output: readonly ContentBlock[]): string {
  return output
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/** Code-point-safe truncation with an explicit notice. */
export function truncateText(text: string, maxChars: number): string {
  const chars = [...text]
  if (chars.length <= maxChars) return text
  return chars.slice(0, maxChars).join('') + '\n\n… (truncated)'
}

/** One-line label from the question's first words; empty when there is none. */
export function truncateLabel(text: string): string {
  const normalized = text.trim().replace(/\s+/g, ' ')
  const chars = [...normalized]
  return chars.length <= LABEL_MAX_CHARS ? normalized : chars.slice(0, LABEL_MAX_CHARS).join('') + '…'
}

/** Render the direct-child catalog as readable lines for `/side list`. */
export function formatSideList(entries: readonly SubagentListEntry[]): string {
  if (entries.length === 0) {
    return 'No side conversations yet. Start one with /side <question>.'
  }
  const lines = entries.map((entry) => {
    if (entry.kind === 'diagnostic') {
      return `- [unavailable] ${entry.id} (${entry.reason})`
    }
    const mode = entry.mode === 'continuable' ? 'side' : 'btw'
    const label = entry.mode === 'continuable' ? entry.label : (entry.label ?? '(one-shot)')
    return `- [${mode}/${entry.activity}] ${label} — ${entry.id}`
  })
  return lines.join('\n')
}

/**
 * Settlement-notice silencing for side conversations (server half).
 *
 * The subagent service guarantees every child an account at settlement: when
 * a child settles, it delivers a user-role `subagent-settled` notice into the
 * parent session and — if the parent is idle — wakes the parent into a new
 * turn, which makes the main session reply to a side conversation's end. Side
 * conversations are viewed in the sidechain panel by design, so that wake-up
 * reply is noise: this module drops the notices of children THIS plugin
 * created before the parent turn reaches the model, via the platform's
 * `agent/pre-step` waterfall (the seam whose contract explicitly allows
 * removing waking messages — an all-removed rewrite spends no model call).
 *
 * Identity is durable: the child id set is persisted under the DSH home
 * (`sidechain-children.json`), so a child created before a `dsh web` restart
 * is still recognized when it settles after the restart. Platform-delegated
 * children are never touched — only children our commands started are
 * silenced. (The `startContinuable` request carries no settlement-delivery
 * option on the host; the pre-step seam is the only available boundary.)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Context } from 'cordis'
import type { SessionId, UserMessage } from '@deepseek-ai/dsh-session'

/** Child session ids our commands created (durable across restarts). */
const sideChildren = new Set<SessionId>()

/** The persisted child-id registry file (under the DSH home, like settings). */
function registryPath(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'sidechain-children.json')
}

/** Best-effort load of the persisted registry (absent/corrupt file → empty). */
export function loadSideChildren(): void {
  try {
    const path = registryPath()
    if (!existsSync(path)) return
    const raw = readFileSync(path, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return
    for (const id of parsed) {
      if (typeof id === 'string') sideChildren.add(id as SessionId)
    }
  } catch {
    // Unreadable registry is not fatal: new children still record and persist.
  }
}

/** Record one side-conversation child so its settlement notice is silenced. */
export function noteSideChild(childId: SessionId): void {
  sideChildren.add(childId)
  try {
    const path = registryPath()
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, JSON.stringify([...sideChildren]), 'utf8')
  } catch {
    // Unwritable home is not fatal: the in-process set still silences this run.
  }
}

/** The notice shape the subagent service injects (source + sender id). */
interface SettlementSource {
  kind?: string | undefined
  senderSessionId?: string | undefined
}

/** Whether one user message is the settlement notice of a side child. */
function isSideSettlement(message: UserMessage): boolean {
  const source = message.source as SettlementSource | undefined
  if (source?.kind !== 'subagent-settled') return false
  const sender = source.senderSessionId
  return sender !== undefined && sideChildren.has(sender as SessionId)
}

/**
 * Register the pre-step filter on the given context. For every parent turn
 * whose CLAIMED messages are settlement notices of our side children, those
 * notices are removed:
 *
 * - all claimed messages removed → the enter decision rewrites to an EMPTY
 *   message list, dropping the runtime-context message too, so the turn
 *   boundary closes with zero model calls (the platform's documented
 *   pre-step contract: "a removed waking message ... spends no model call").
 * - some claimed messages removed → the surviving user messages plus any
 *   appended context stay, so a real user turn is unaffected.
 *
 * @param ctx - the plugin context (root scope hears every agent's pre-step).
 * @returns the disposer unregistering the listener.
 */
export function registerSettlementSilence(ctx: Context): () => void {
  return ctx.on('agent/pre-step', async (
    payload: { agent: Agent; messages: UserMessage[] },
    next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const claimed = payload.messages
    if (claimed.every(message => !isSideSettlement(message))) return decision
    const kept = claimed.filter(message => !isSideSettlement(message))
    if (kept.length === 0) {
      // Nothing of the user's own remained — drop the runtime context too;
      // an empty enter ends the turn without a model call.
      return { kind: 'enter', messages: [] }
    }
    const extras = decision.messages.filter(message => !claimed.includes(message))
    return { kind: 'enter', messages: [...kept, ...extras] }
  })
}

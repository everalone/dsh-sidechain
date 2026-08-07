/**
 * Command card for `/side` and `/btw` (browser half): renders a compact row
 * and, once the command settles successfully, auto-opens the created side
 * conversation in the subagent view — no manual catalog click. The jump fires
 * exactly once per live settle: a card re-mounted from replay history (reopening
 * the session, a page reload) already observes the settled outcome and must not
 * yank the view back to the side thread.
 */

import { useEffect, useRef } from 'react'
import type { CommandNode, SessionId } from '@deepseek-ai/dsh-client-runtime/client'

/** Business face injected by the slot registration (per session scope). */
export interface SideCommandCardInjected {
  openChild(childSessionId: SessionId): void
}

/** Composed props: the render site's owner ({ node }) plus the inject share. */
export interface SideCommandCardProps extends SideCommandCardInjected {
  node: CommandNode
}

/** Command key → child mode carried by the host's success text marker. */
export type SideCommandKind = 'side' | 'btw'

/**
 * The outcome state a card first observes at mount: `pending` while the
 * command is running, `settled` when it already carried a final outcome
 * (success or error) — which is what replaying history mounts look like.
 */
export type FirstOutcome = 'pending' | 'settled'

/**
 * Whether the card should auto-open its child: exactly the live
 * running→success transition. A mount whose first observation is `settled`
 * is history replay (reopening the session, a page reload) and must not jump.
 * @param first - the outcome state observed at mount.
 * @param outcome - the command's current outcome.
 * @returns whether to auto-open the child conversation.
 */
export function shouldAutoJump(first: FirstOutcome | null, outcome: CommandNode['outcome']): boolean {
  return first === 'pending' && outcome?.kind === 'success'
}

/**
 * Resolve the created child session id from a settled command node, or
 * undefined while the command is running, failed, or the id is absent.
 * The host pins the id in a stable marker: `/side` texts start with
 * `Side conversation started: <uuid>.`, `/btw` answers end with
 * `(btw session: <uuid>)`.
 */
export function resolveChildSessionId(node: CommandNode, kind: SideCommandKind): SessionId | undefined {
  const text = node.outcome?.kind === 'success' ? node.outcome.text : undefined
  if (text === undefined) return undefined
  const pattern = kind === 'side' ? /started: ([0-9a-f-]{36})/ : /btw session: ([0-9a-f-]{36})/
  return pattern.exec(text)?.[1] as SessionId | undefined
}

/** The command card: minimal row text plus one-shot auto-jump on success. */
export function SideCommandCard({ node, openChild }: SideCommandCardProps): JSX.Element {
  const jumpedRef = useRef(false)
  const firstOutcomeRef = useRef<FirstOutcome | null>(null)
  const kind: SideCommandKind = node.name === 'btw' ? 'btw' : 'side'
  useEffect(() => {
    // Record the mount-time outcome once: `pending` means the card witnessed
    // the command running (a live settle follows), `settled` means this mount
    // replayed a finished command and must never jump.
    if (firstOutcomeRef.current === null) {
      firstOutcomeRef.current = node.outcome === null ? 'pending' : 'settled'
    }
    if (jumpedRef.current || !shouldAutoJump(firstOutcomeRef.current, node.outcome)) return
    const childId = resolveChildSessionId(node, kind)
    if (childId === undefined) return
    jumpedRef.current = true
    openChild(childId)
  }, [node, kind, openChild])

  const outcome = node.outcome
  const label = outcome === null
    ? '…'
    : outcome.kind === 'error'
      ? outcome.text
      : outcome.text ?? `/${kind}`
  return (
    <div
      style={{
        display: 'flex',
        gap: '8px',
        alignItems: 'baseline',
        padding: '6px 10px',
        borderRadius: '8px',
        background: 'var(--ds-color-surface-2, #f2f3f5)',
        fontSize: '13px',
        lineHeight: '1.5',
      }}
    >
      <strong style={{ whiteSpace: 'nowrap' }}>/{node.name ?? kind}</strong>
      <span style={{ overflowWrap: 'anywhere' }}>{label}</span>
    </div>
  )
}

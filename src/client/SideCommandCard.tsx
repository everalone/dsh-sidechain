/**
 * Command card for `/side` and `/btw` (browser half): renders a compact row
 * and, once the command settles successfully, reveals the sidechain panel
 * with the created side conversation selected — its transcript renders in the
 * right sidebar while the main session keeps running untouched. The reveal
 * fires exactly once per live settle: a card re-mounted from replay history
 * (reopening the session, a page reload) already observes the settled outcome
 * and must not pop the panel open.
 */

import { useEffect, useRef } from 'react'
import type { CommandNode, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'

/** Business face injected by the slot registration (per session scope). */
export interface SideCommandCardInjected {
  /** Reveal the panel with the new child selected for the embedded view. */
  revealPanel(childSessionId: SessionId): void
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
 * Whether the card should reveal its child: exactly the live
 * running→success transition. A mount whose first observation is `settled`
 * is history replay (reopening the session, a page reload) and must not
 * pop the panel open.
 * @param first - the outcome state observed at mount.
 * @param outcome - the command's current outcome.
 * @returns whether to reveal the child conversation.
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

/** The command card: minimal row text plus one-shot panel reveal on success. */
export function SideCommandCard({ node, revealPanel }: SideCommandCardProps): JSX.Element {
  const revealedRef = useRef(false)
  const firstOutcomeRef = useRef<FirstOutcome | null>(null)
  const kind: SideCommandKind = node.name === 'btw' ? 'btw' : 'side'
  useEffect(() => {
    // Record the mount-time outcome once: `pending` means the card witnessed
    // the command running (a live settle follows), `settled` means this mount
    // replayed a finished command and must never pop the panel open.
    if (firstOutcomeRef.current === null) {
      firstOutcomeRef.current = node.outcome === null ? 'pending' : 'settled'
    }
    if (revealedRef.current || !shouldAutoJump(firstOutcomeRef.current, node.outcome)) return
    const childId = resolveChildSessionId(node, kind)
    if (childId === undefined) return
    revealedRef.current = true
    revealPanel(childId)
  }, [node, kind, revealPanel])

  const outcome = node.outcome
  const label = outcome === null
    ? '…'
    : outcome.kind === 'error'
      ? (outcome.text ?? '')
      : (outcome.text ?? `/${kind}`)
  return (
    <div
      style={{
        padding: '6px 10px',
        borderRadius: '8px',
        background: 'var(--ds-color-surface-2, #f2f3f5)',
        fontSize: '13px',
        lineHeight: '1.5',
      }}
    >
      <strong style={{ whiteSpace: 'nowrap', display: 'block', marginBottom: '2px' }}>/{node.name ?? kind}</strong>
      {/* The /btw answer and /side notice render as markdown (tables, code, lists). */}
      <div style={{ overflowX: 'auto' }}>
        <MarkdownText text={label} streaming={false} />
      </div>
    </div>
  )
}

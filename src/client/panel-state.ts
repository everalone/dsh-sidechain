/**
 * Module-scope panel visibility store shared by the sidechain UI pieces.
 *
 * One store serves every entry that can open or close the right panel — the
 * conversation-header toggle button and the `/side` / `/btw` command cards
 * (which reveal the panel on a live settle) — so they never disagree about
 * its open state. Module scope is safe here: the browser half is a single
 * bundle, so every import site sees the same instance.
 */

/** Listener invoked on every visibility transition. */
export type SidechainPanelListener = () => void

let open = false
const listeners = new Set<SidechainPanelListener>()

function emit(): void {
  for (const listener of [...listeners]) listener()
}

/** Whether the sidechain panel is currently open. */
export function isSidechainPanelOpen(): boolean {
  return open
}

/** Open the panel (no-op when already open). */
export function openSidechainPanel(): void {
  if (open) return
  open = true
  emit()
}

/** Close the panel (no-op when already closed). */
export function closeSidechainPanel(): void {
  if (!open) return
  open = false
  emit()
}

/** Flip the panel between open and closed. */
export function toggleSidechainPanel(): void {
  if (open) closeSidechainPanel()
  else openSidechainPanel()
}

/**
 * Subscribe to visibility transitions.
 * @param listener - called on every change.
 * @returns the disposer removing the subscription.
 */
export function subscribeSidechainPanel(listener: SidechainPanelListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Test seam: reset to the initial closed state and drop all listeners. */
export function resetSidechainPanel(): void {
  open = false
  listeners.clear()
}

/**
 * Module-scope panel visibility + selection store shared by the sidechain UI
 * pieces.
 *
 * One store serves every entry that can open or close the right panel — the
 * conversation-header toggle button and the `/side` / `/btw` command cards
 * (which reveal the panel and select the new child on a live settle) — so
 * they never disagree about its open state. The selection drives the panel's
 * embedded conversation view: selecting a child shows its transcript while
 * the main session stays untouched. Module scope is safe here: the browser
 * half is a single bundle, so every import site sees the same instance.
 */

import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'

/** Listener invoked on every visibility or selection transition. */
export type SidechainPanelListener = () => void

let open = false
let selected: SessionId | undefined
const listeners = new Set<SidechainPanelListener>()

function emit(): void {
  for (const listener of [...listeners]) listener()
}

/** Whether the sidechain panel is currently open. */
export function isSidechainPanelOpen(): boolean {
  return open
}

/** The child currently selected for the embedded transcript view, if any. */
export function selectedChildId(): SessionId | undefined {
  return selected
}

/** Open the panel (no-op when already open). */
export function openSidechainPanel(): void {
  if (open) return
  open = true
  emit()
}

/** Close the panel (no-op when already closed). */
export function closeSidechainPanel(): void {
  if (!open && selected === undefined) return
  open = false
  selected = undefined
  emit()
}

/** Flip the panel between open and closed (closing also clears the selection). */
export function toggleSidechainPanel(): void {
  if (open) closeSidechainPanel()
  else openSidechainPanel()
}

/**
 * Reveal the panel with one child selected for the embedded transcript view.
 * @param childSessionId - the child to show; undefined returns to the list.
 */
export function revealChild(childSessionId: SessionId | undefined): void {
  open = true
  if (selected === childSessionId) return
  selected = childSessionId
  emit()
}

/** Select a child (or clear the selection) without changing the panel state. */
export function selectChild(childSessionId: SessionId | undefined): void {
  if (selected === childSessionId) return
  selected = childSessionId
  emit()
}

/**
 * Subscribe to visibility/selection transitions.
 * @param listener - called on every change.
 * @returns the disposer removing the subscription.
 */
export function subscribeSidechainPanel(listener: SidechainPanelListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Test seam: reset to the initial closed, unselected state and drop all listeners. */
export function resetSidechainPanel(): void {
  open = false
  selected = undefined
  listeners.clear()
}

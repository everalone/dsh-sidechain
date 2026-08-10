/**
 * Unit tests for the module-scope sidechain panel visibility + selection store.
 */

import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeSidechainPanel, isSidechainPanelOpen, openSidechainPanel, revealChild,
  resetSidechainPanel, selectedChildId, selectChild, subscribeSidechainPanel,
  toggleSidechainPanel,
} from '../src/client/panel-state'

const CHILD_A = '11111111-1111-4111-8111-111111111111' as SessionId
const CHILD_B = '22222222-2222-4222-8222-222222222222' as SessionId

describe('panel-state', () => {
  beforeEach(() => {
    resetSidechainPanel()
  })

  it('starts closed with no selection', () => {
    expect(isSidechainPanelOpen()).toBe(false)
    expect(selectedChildId()).toBeUndefined()
  })

  it('open/close flip the visibility', () => {
    openSidechainPanel()
    expect(isSidechainPanelOpen()).toBe(true)
    closeSidechainPanel()
    expect(isSidechainPanelOpen()).toBe(false)
  })

  it('toggle flips both ways', () => {
    toggleSidechainPanel()
    expect(isSidechainPanelOpen()).toBe(true)
    toggleSidechainPanel()
    expect(isSidechainPanelOpen()).toBe(false)
  })

  it('notifies subscribers on transitions only', () => {
    const listener = vi.fn()
    const dispose = subscribeSidechainPanel(listener)
    openSidechainPanel()
    expect(listener).toHaveBeenCalledTimes(1)
    // Idempotent open must not re-notify.
    openSidechainPanel()
    expect(listener).toHaveBeenCalledTimes(1)
    closeSidechainPanel()
    expect(listener).toHaveBeenCalledTimes(2)
    dispose()
    toggleSidechainPanel()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('revealChild opens the panel and selects the child in one step', () => {
    revealChild(CHILD_A)
    expect(isSidechainPanelOpen()).toBe(true)
    expect(selectedChildId()).toBe(CHILD_A)
    // Revealing the same child again is a no-op for subscribers.
    const listener = vi.fn()
    subscribeSidechainPanel(listener)
    revealChild(CHILD_A)
    expect(listener).not.toHaveBeenCalled()
  })

  it('selectChild switches the selection without touching visibility', () => {
    revealChild(CHILD_A)
    selectChild(CHILD_B)
    expect(isSidechainPanelOpen()).toBe(true)
    expect(selectedChildId()).toBe(CHILD_B)
    selectChild(undefined)
    expect(selectedChildId()).toBeUndefined()
    expect(isSidechainPanelOpen()).toBe(true)
  })

  it('close clears the selection', () => {
    revealChild(CHILD_A)
    closeSidechainPanel()
    expect(isSidechainPanelOpen()).toBe(false)
    expect(selectedChildId()).toBeUndefined()
  })

  it('reset closes, clears the selection, and drops listeners', () => {
    const listener = vi.fn()
    subscribeSidechainPanel(listener)
    revealChild(CHILD_A)
    expect(listener).toHaveBeenCalledTimes(1)
    resetSidechainPanel()
    expect(isSidechainPanelOpen()).toBe(false)
    expect(selectedChildId()).toBeUndefined()
    toggleSidechainPanel()
    // The post-reset transition must not reach the dropped listener.
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

/**
 * Unit tests for the module-scope sidechain panel visibility store.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeSidechainPanel, isSidechainPanelOpen, openSidechainPanel,
  resetSidechainPanel, subscribeSidechainPanel, toggleSidechainPanel,
} from '../src/client/panel-state'

describe('panel-state', () => {
  beforeEach(() => {
    resetSidechainPanel()
  })

  it('starts closed', () => {
    expect(isSidechainPanelOpen()).toBe(false)
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

  it('reset closes and drops listeners', () => {
    const listener = vi.fn()
    subscribeSidechainPanel(listener)
    openSidechainPanel()
    expect(listener).toHaveBeenCalledTimes(1)
    resetSidechainPanel()
    expect(isSidechainPanelOpen()).toBe(false)
    toggleSidechainPanel()
    // The post-reset transition must not reach the dropped listener.
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

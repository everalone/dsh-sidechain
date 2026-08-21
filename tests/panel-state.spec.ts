/**
 * Unit tests for the module-scope sidechain panel visibility + selection store.
 */

import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clampPanelWidth, closeSidechainPanel, isSidechainPanelOpen, openSidechainPanel,
  PANEL_DEFAULT_WIDTH, PANEL_MAX_WIDTH, PANEL_MIN_WIDTH, panelMaxWidth,
  readPanelWidth, resetSidechainPanel, revealChild, selectedChildId,
  subscribeSidechainPanel, toggleSidechainPanel, writePanelWidth,
} from '../src/client/panel-state'

const CHILD_A = '11111111-1111-4111-8111-111111111111' as SessionId
describe('panel-state', () => {
  beforeEach(() => {
    resetSidechainPanel()
  })

  it('open/close flip the visibility', () => {
    openSidechainPanel()
    expect(isSidechainPanelOpen()).toBe(true)
    closeSidechainPanel()
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

describe('panel width helpers', () => {
  const storage = new Map<string, string>()
  beforeEach(() => {
    storage.clear()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('caps the dragged ceiling at 55% of the viewport and the hard cap', () => {
    expect(panelMaxWidth(2000)).toBe(PANEL_MAX_WIDTH)
    expect(panelMaxWidth(1000)).toBe(550)
    expect(panelMaxWidth(500)).toBe(275)
  })

  it('clamps widths into the allowed band', () => {
    expect(clampPanelWidth(100, 2000)).toBe(PANEL_MIN_WIDTH)
    expect(clampPanelWidth(500, 2000)).toBe(500)
    expect(clampPanelWidth(900, 2000)).toBe(PANEL_MAX_WIDTH)
    expect(clampPanelWidth(500, 800)).toBe(440)
  })

  it('reads undefined without a stored value', () => {
    expect(readPanelWidth()).toBeUndefined()
  })

  it('writes and reads a width round-trip', () => {
    writePanelWidth(520)
    expect(readPanelWidth()).toBe(520)
  })

  it('rejects a malformed or under-min stored value', () => {
    writePanelWidth(PANEL_DEFAULT_WIDTH)
    storage.set('dsh.sidechain.width', 'garbage')
    expect(readPanelWidth()).toBeUndefined()
    storage.set('dsh.sidechain.width', '120')
    expect(readPanelWidth()).toBeUndefined()
  })
})

/**
 * Unit tests for the sidechain panel's row derivation helpers.
 */

import { describe, expect, it } from 'vitest'
import type { SessionId, SubagentCatalogSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import {
  RESIDENT_AGENT_LABEL, runningCount, sidechainChildren, sidechainRows,
} from '../src/client/SidechainPanel'

const PARENT = 'parent-1' as SessionId
const CHILD_A = '11111111-1111-4111-8111-111111111111' as SessionId
const CHILD_B = '22222222-2222-4222-8222-222222222222' as SessionId

function snapshot(entries: SubagentCatalogSnapshot['entries']): SubagentCatalogSnapshot {
  return { entries, parentAvailable: true, state: 'ready', error: null }
}

describe('sidechainRows', () => {
  it('returns [] for an absent catalog', () => {
    expect(sidechainRows(undefined, {})).toEqual([])
  })

  it('resolves child labels: entry label, then summary title, then id', () => {
    const rows = sidechainRows(snapshot([
      { kind: 'child', id: CHILD_A, activity: 'running', hasChildren: false, mode: 'continuable', label: '调研 X' },
      { kind: 'child', id: CHILD_B, activity: 'inactive', hasChildren: false, mode: 'one-shot' },
    ]), {
      [CHILD_B]: {
        id: CHILD_B, title: '问答标题', displayTitle: '问答标题', running: false, blank: false, updatedAt: 0,
      },
    })
    expect(rows).toEqual([
      { kind: 'child', id: CHILD_A, mode: 'continuable', activity: 'running', label: '调研 X' },
      { kind: 'child', id: CHILD_B, mode: 'one-shot', activity: 'inactive', label: '问答标题' },
    ])
  })

  it('falls back to the session id without any title source', () => {
    const rows = sidechainRows(snapshot([
      { kind: 'child', id: CHILD_A, activity: 'inactive', hasChildren: false, mode: 'one-shot' },
    ]), {})
    expect(rows[0]).toEqual({ kind: 'child', id: CHILD_A, mode: 'one-shot', activity: 'inactive', label: CHILD_A })
  })

  it('passes diagnostics through', () => {
    const rows = sidechainRows(snapshot([
      { kind: 'diagnostic', id: CHILD_A, reason: 'corrupt' },
    ]), {})
    expect(rows).toEqual([{ kind: 'diagnostic', id: CHILD_A, reason: 'corrupt' }])
  })
})

describe('runningCount', () => {
  it('counts only running child rows', () => {
    const rows = sidechainRows(snapshot([
      { kind: 'child', id: CHILD_A, activity: 'running', hasChildren: false, mode: 'continuable', label: 'a' },
      { kind: 'child', id: CHILD_B, activity: 'inactive', hasChildren: false, mode: 'one-shot' },
      { kind: 'diagnostic', id: PARENT, reason: 'unavailable' },
    ]), {})
    expect(runningCount(rows)).toBe(1)
  })
})

describe('sidechainChildren', () => {
  it('hides the platform resident side agent ("Side conversation" continuable)', () => {
    const rows = sidechainRows(snapshot([
      { kind: 'child', id: CHILD_A, activity: 'running', hasChildren: false, mode: 'continuable', label: RESIDENT_AGENT_LABEL },
      { kind: 'child', id: CHILD_B, activity: 'inactive', hasChildren: false, mode: 'continuable', label: '调研 X' },
      { kind: 'child', id: PARENT, activity: 'inactive', hasChildren: false, mode: 'one-shot', label: 'BTW: 问个问题' },
    ]), {})
    const visible = sidechainChildren(rows)
    expect(visible.map(row => row.id)).toEqual([CHILD_B, PARENT])
  })

  it('keeps a user empty /side thread (short marker label) visible', () => {
    const rows = sidechainRows(snapshot([
      { kind: 'child', id: CHILD_A, activity: 'inactive', hasChildren: false, mode: 'continuable', label: 'Side' },
    ]), {})
    expect(sidechainChildren(rows).map(row => row.id)).toEqual([CHILD_A])
  })

  it('keeps diagnostics and one-shot /btw children', () => {
    const rows = sidechainRows(snapshot([
      { kind: 'diagnostic', id: CHILD_A, reason: 'corrupt' },
      { kind: 'child', id: CHILD_B, activity: 'running', hasChildren: false, mode: 'one-shot', label: 'BTW: x' },
    ]), {})
    expect(sidechainChildren(rows).length).toBe(2)
  })
})

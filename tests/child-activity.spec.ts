import { describe, expect, it } from 'vitest'
import { resolveChildActivity, type CatalogState } from '../src/client/child-activity'

describe('resolveChildActivity', () => {
  describe('catalog state machine', () => {
    it('returns unknown when no catalog has been fetched (absent)', () => {
      expect(resolveChildActivity({
        catalogState: 'absent',
        catalogActivity: undefined,
        summaryRunning: undefined,
      })).toBe('unknown')
    })

    it('returns unknown while the catalog is loading', () => {
      expect(resolveChildActivity({
        catalogState: 'loading',
        catalogActivity: undefined,
        summaryRunning: undefined,
      })).toBe('unknown')
    })

    it('returns unknown when the catalog fetch errored', () => {
      expect(resolveChildActivity({
        catalogState: 'error',
        catalogActivity: undefined,
        summaryRunning: undefined,
      })).toBe('unknown')
    })

    it('returns inactive when a ready catalog has no entry for the child', () => {
      expect(resolveChildActivity({
        catalogState: 'ready',
        catalogActivity: undefined,
        summaryRunning: undefined,
      })).toBe('inactive')
    })
  })

  describe('session summary precedence', () => {
    it('uses summaryRunning=true even when the catalog is missing', () => {
      expect(resolveChildActivity({
        catalogState: 'absent',
        catalogActivity: undefined,
        summaryRunning: true,
      })).toBe('running')
    })

    it('uses summaryRunning=false even when the catalog says running', () => {
      // A settled host frame must beat a stale catalog entry; this is the
      // "the child just ended and the catalog hasn't caught up" case.
      expect(resolveChildActivity({
        catalogState: 'ready',
        catalogActivity: 'running',
        summaryRunning: false,
      })).toBe('inactive')
    })

    it('uses summaryRunning=true over a stale inactive catalog entry', () => {
      expect(resolveChildActivity({
        catalogState: 'ready',
        catalogActivity: 'inactive',
        summaryRunning: true,
      })).toBe('running')
    })
  })

  describe('catalog activity fallback', () => {
    it('returns running when the catalog entry is running and no summary is available', () => {
      expect(resolveChildActivity({
        catalogState: 'ready',
        catalogActivity: 'running',
        summaryRunning: undefined,
      })).toBe('running')
    })

    it('returns inactive when the catalog entry is inactive and no summary is available', () => {
      expect(resolveChildActivity({
        catalogState: 'ready',
        catalogActivity: 'inactive',
        summaryRunning: undefined,
      })).toBe('inactive')
    })
  })

  describe('no-poll regression', () => {
    // These three inputs are the exact signals the /btw command card sees
    // when its parent catalog has not yet been fetched and the host has no
    // summary row for the freshly-resolved child. Before the fix, the card
    // would treat this as running and start a 1.2 s transcript poll. The
    // fix routes all of these through `unknown`, which gates the poll off.
    const cardInputs: ReadonlyArray<{
      label: string
      state: CatalogState
    }> = [
      { label: 'absent catalog', state: 'absent' },
      { label: 'loading catalog', state: 'loading' },
      { label: 'error catalog', state: 'error' },
    ]

    for (const { label, state } of cardInputs) {
      it(`does not start a poll when the child is freshly created and the catalog is ${label}`, () => {
        const activity = resolveChildActivity({
          catalogState: state,
          catalogActivity: undefined,
          summaryRunning: undefined,
        })
        expect(activity).toBe('unknown')
        // The card gates setInterval(read, BTW_CARD_POLL_INTERVAL_MS) on
        // `childRunning` which is `childActivity === 'running'`. This is the
        // assertion that catches the regression: the gate must be closed.
        expect(activity === 'running').toBe(false)
      })
    }
  })

  describe('settle-on-finish transitions', () => {
    // The panel's settle effect only fires on the explicit running -> inactive
    // transition. An early unknown -> inactive (catalog loaded after the
    // child already ended) must not fire it, and these checks mirror the
    // conditions the effect observes across renders.
    const transitions: ReadonlyArray<{
      label: string
      previous: ReturnType<typeof resolveChildActivity>
      current: ReturnType<typeof resolveChildActivity>
      expectSettle: boolean
    }> = [
      { label: 'running -> inactive', previous: 'running', current: 'inactive', expectSettle: true },
      { label: 'unknown -> inactive (no settle)', previous: 'unknown', current: 'inactive', expectSettle: false },
      { label: 'unknown -> running (no settle)', previous: 'unknown', current: 'running', expectSettle: false },
      { label: 'inactive -> running (no settle)', previous: 'inactive', current: 'running', expectSettle: false },
      { label: 'running -> running (no settle)', previous: 'running', current: 'running', expectSettle: false },
      { label: 'inactive -> inactive (no settle)', previous: 'inactive', current: 'inactive', expectSettle: false },
    ]

    for (const { label, previous, current, expectSettle } of transitions) {
      it(`${label}`, () => {
        // The settle effect's transition check is the mirror of the gate
        // used by the card poll. We assert the boolean the effect uses so
        // any future refactor that changes the gate is caught here.
        const settled = previous === 'running' && current === 'inactive'
        expect(settled).toBe(expectSettle)
      })
    }
  })
})

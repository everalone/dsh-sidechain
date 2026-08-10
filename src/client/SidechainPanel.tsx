/**
 * Sidechain right panel (browser half): a floating right-edge sidebar listing
 * the current session's `/side` and `/btw` subagent children, plus the header
 * toggle button that opens it.
 *
 * Data rides the runtime's live subagent catalog — `sessions.list` rows under
 * `subagentsByParent` — so the panel needs no bespoke transport: opening the
 * panel arms the catalog feed (`setSubagentCatalogOpen`) and triggers one
 * `refreshSubagents`; rows update as children start, finish, or disappear.
 * The visibility store is module-scoped (`panel-state.ts`), shared with the
 * `/side` / `/btw` cards, which reveal the panel when a command settles.
 *
 * Styling is inline (CSS variables) to match the plugin's other browser code:
 * the harness serves exactly one client artifact, and this package has no CSS
 * pipeline of its own.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type {
  SessionId, SessionListState, SessionSummary, SubagentAddress, SubagentCatalogSnapshot,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  IconBranchOutline16, IconCloseOutline16, IconRefreshOutline14, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS } from './locales.ts'
import {
  closeSidechainPanel, isSidechainPanelOpen,
  subscribeSidechainPanel, toggleSidechainPanel,
} from './panel-state.ts'

/** Business actions injected by the slot registration (per session scope). */
export interface SidechainPanelInjected {
  /** Open one catalog child through its exact direct-parent address. */
  openChild(address: SubagentAddress): void
  /** Trigger a fresh catalog fetch for the parent session. */
  refresh(parentSessionId: SessionId): void
  /** Arm (true) or disarm (false) the live catalog membership feed. */
  setCatalogOpen(parentSessionId: SessionId, open: boolean): void
}

/** Full props: session standard kit + the inject share + the locale seat. */
export type SidechainPanelProps =
  PropsRuntime<'conversation.session.header.actions'>
  & SidechainPanelInjected
  & PropsLocale<typeof NS>

/** One rendered catalog row, label resolved, diagnostics kept apart. */
export type SidechainRow =
  | {
    kind: 'child'
    id: SessionId
    mode: 'one-shot' | 'continuable'
    activity: 'running' | 'inactive'
    label: string
  }
  | {
    kind: 'diagnostic'
    id: SessionId
    reason: 'corrupt' | 'unsupported' | 'unavailable'
  }

/**
 * Resolve the catalog into display rows: child entries carry their host
 * label when present, falling back to the session summary's title, then the
 * session id; diagnostics pass through untouched.
 * @param catalog - the parent's catalog snapshot (absent while never fetched).
 * @param summaries - session list rows, used as the label fallback source.
 * @returns flat display rows in catalog order.
 */
export function sidechainRows(
  catalog: SubagentCatalogSnapshot | undefined,
  summaries: Readonly<Record<SessionId, SessionSummary>>,
): SidechainRow[] {
  if (catalog === undefined) return []
  return catalog.entries.map((entry): SidechainRow => {
    if (entry.kind === 'diagnostic') {
      return { kind: 'diagnostic', id: entry.id, reason: entry.reason }
    }
    return {
      kind: 'child',
      id: entry.id,
      mode: entry.mode,
      activity: entry.activity,
      label: entry.label ?? summaries[entry.id]?.title ?? entry.id,
    }
  })
}

/** Number of child rows currently running (the header badge value). */
export function runningCount(rows: readonly SidechainRow[]): number {
  return rows.filter(row => row.kind === 'child' && row.activity === 'running').length
}

/** Localized diagnostic copy, explicit key cases keep the dictionary typed. */
export function diagnosticText(
  reason: 'corrupt' | 'unsupported' | 'unavailable',
  t: SidechainPanelProps['t'],
): string {
  switch (reason) {
    case 'corrupt': return t('diagnostic.corrupt')
    case 'unsupported': return t('diagnostic.unsupported')
    case 'unavailable': return t('diagnostic.unavailable')
  }
}

/** Shared token-level palette (falls back gracefully when the app lacks the variables). */
const C = {
  text1: 'var(--ds-color-text-1, #1d2129)',
  text2: 'var(--ds-color-text-2, #4e5969)',
  surface2: 'var(--ds-color-surface-2, #f2f3f5)',
  hover: 'var(--ds-color-hover, rgba(0, 0, 0, 0.06))',
  border: 'var(--ds-color-border-1, rgba(0, 0, 0, 0.12))',
  primary: 'var(--ds-color-primary, #3370ff)',
  danger: 'var(--ds-color-danger, #f53f3f)',
} as const

const styles: Record<string, CSSProperties> = {
  toggle: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '4px 6px', border: 'none', borderRadius: 6,
    background: 'transparent', color: C.text2, cursor: 'pointer',
    fontSize: 13, lineHeight: 1,
  },
  toggleActive: {
    background: C.surface2, color: C.text1,
  },
  badge: {
    minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8,
    background: C.primary, color: '#fff', fontSize: 11, lineHeight: '16px', textAlign: 'center',
  },
  panel: {
    position: 'fixed', top: 0, right: 0, bottom: 0, width: 320, maxWidth: '80vw',
    display: 'flex', flexDirection: 'column',
    background: 'var(--ds-color-bg-1, #ffffff)', borderLeft: `1px solid ${C.border}`,
    boxShadow: '-8px 0 24px rgba(0, 0, 0, 0.12)', zIndex: 200,
    fontSize: 13, color: C.text1,
  },
  header: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '10px 12px', borderBottom: `1px solid ${C.border}`,
  },
  title: { flex: 1, fontWeight: 600, fontSize: 14 },
  runningCount: { color: C.text2, fontSize: 12 },
  iconButton: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 24, height: 24, padding: 0, border: 'none', borderRadius: 6,
    background: 'transparent', color: C.text2, cursor: 'pointer',
  },
  body: { flex: 1, overflowY: 'auto', padding: 6 },
  notice: { padding: '16px 12px', color: C.text2, textAlign: 'center' },
  error: { display: 'flex', alignItems: 'center', gap: 8, padding: 12, color: C.danger },
  retry: {
    padding: '2px 8px', border: `1px solid ${C.border}`, borderRadius: 6,
    background: 'transparent', color: C.text2, cursor: 'pointer', fontSize: 12,
  },
  row: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '7px 8px', borderRadius: 6, cursor: 'pointer',
    width: '100%', border: 'none', background: 'transparent', color: 'inherit',
    fontSize: 13, textAlign: 'left',
  },
  rowDisabled: { cursor: 'default', opacity: 0.6 },
  content: { flex: 1, minWidth: 0 },
  label: {
    display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  summary: {
    display: 'block', color: C.text2, fontSize: 12,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
}

/** Render one catalog row; children open their subagent view, diagnostics are inert. */
function Row({ row, t, onOpen }: {
  row: SidechainRow
  t: SidechainPanelProps['t']
  onOpen: (childSessionId: SessionId, mode: 'one-shot' | 'continuable') => void
}): JSX.Element {
  if (row.kind === 'diagnostic') {
    const reason = diagnosticText(row.reason, t)
    return (
      <div style={{ ...styles.row, ...styles.rowDisabled }} title={reason} aria-disabled="true">
        <StateDot state="error" />
        <span style={styles.content}>
          <span style={styles.label}>{row.id}</span>
          <span style={styles.summary}>{reason}</span>
        </span>
      </div>
    )
  }
  const mode = row.mode === 'one-shot' ? t('mode.oneShot') : t('mode.continuable')
  const activity = row.activity === 'running' ? t('activity.running') : t('activity.inactive')
  return (
    <button
      type="button"
      style={styles.row}
      title={t('row.open', { label: row.label })}
      aria-label={t('row.open', { label: row.label })}
      onClick={() => onOpen(row.id, row.mode)}
    >
      <StateDot state={row.activity === 'running' ? 'ongoing' : 'done'} />
      <span style={styles.content}>
        <span style={styles.label}>{row.label}</span>
        <span style={styles.summary}>{`${mode} · ${activity}`}</span>
      </span>
    </button>
  )
}

/**
 * The header action: a toggle button plus, while open, the floating right
 * panel. Arming the catalog happens on open and follows the current session;
 * the panel stays mounted across session switches and re-arms per parent.
 */
export function SidechainPanel({
  sessionId, useSessions, openChild, refresh, setCatalogOpen, t,
}: SidechainPanelProps): JSX.Element {
  const [open, setOpen] = useState(isSidechainPanelOpen)
  useEffect(() => subscribeSidechainPanel(() => { setOpen(isSidechainPanelOpen()) }), [])

  const catalogs = useSessions(state => state.subagentsByParent)
  const summaries = useSessions(state => state.byId)
  const catalog = catalogs[sessionId]
  const rows = useMemo(() => sidechainRows(catalog, summaries), [catalog, summaries])
  const running = runningCount(rows)

  // The injected actions can be recreated per render; keep the effect pinned
  // to the session transition only, reading the latest actions through a ref.
  const actionsRef = useRef({ refresh, setCatalogOpen })
  actionsRef.current = { refresh, setCatalogOpen }
  useEffect(() => {
    if (!open) return
    const { refresh, setCatalogOpen } = actionsRef.current
    setCatalogOpen(sessionId, true)
    refresh(sessionId)
    return () => { actionsRef.current.setCatalogOpen(sessionId, false) }
  }, [open, sessionId])

  const loading = catalog === undefined
    || (catalog.state === 'loading' && catalog.entries.length === 0)
  const empty = catalog !== undefined && catalog.state === 'ready' && catalog.entries.length === 0

  return (
    <>
      <button
        type="button"
        style={{ ...styles.toggle, ...(open ? styles.toggleActive : {}) }}
        title={t('panel.toggle')}
        aria-label={t('panel.toggle')}
        aria-pressed={open}
        onClick={toggleSidechainPanel}
      >
        <IconBranchOutline16 />
        {running > 0 && <span style={styles.badge}>{running}</span>}
      </button>
      {open && (
        <aside style={styles.panel} role="complementary" aria-label={t('panel.title')}>
          <div style={styles.header}>
            <span style={styles.title}>{t('panel.title')}</span>
            {running > 0 && (
              <span style={styles.runningCount}>{t('count.running', { count: running })}</span>
            )}
            <button
              type="button"
              style={styles.iconButton}
              title={t('panel.refresh')}
              aria-label={t('panel.refresh')}
              onClick={() => { actionsRef.current.refresh(sessionId) }}
            >
              <IconRefreshOutline14 />
            </button>
            <button
              type="button"
              style={styles.iconButton}
              title={t('panel.close')}
              aria-label={t('panel.close')}
              onClick={closeSidechainPanel}
            >
              <IconCloseOutline16 />
            </button>
          </div>
          <div style={styles.body}>
            {catalog !== undefined && catalog.state === 'error' && (
              <div style={styles.error}>
                <span>{t('panel.error')}</span>
                <button
                  type="button"
                  style={styles.retry}
                  onClick={() => { actionsRef.current.refresh(sessionId) }}
                >
                  {t('panel.retry')}
                </button>
              </div>
            )}
            {loading && <div style={styles.notice}>{t('panel.loading')}</div>}
            {empty && <div style={styles.notice}>{t('panel.empty')}</div>}
            {rows.map(row => (
              <Row
                key={row.id}
                row={row}
                t={t}
                onOpen={(childSessionId, mode) => {
                  openChild({ parentSessionId: sessionId, childSessionId, mode })
                }}
              />
            ))}
          </div>
        </aside>
      )}
    </>
  )
}

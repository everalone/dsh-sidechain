/**
 * Sidechain right panel (browser half): a floating right-edge sidebar listing
 * the current session's `/side` and `/btw` subagent children, with an
 * embedded conversation view — selecting a child renders its transcript
 * (and a composer for continuable threads) INSIDE the panel while the main
 * session stays untouched.
 *
 * Data rides the runtime's live subagent catalog — `sessions.list` rows under
 * `subagentsByParent` — for membership, and the catalog's `subagent.history`
 * transcript RPC for conversation content (no activation, no navigation).
 * While the selected child is running, a poll refreshes the transcript tail
 * page (the host serves the live child's in-memory snapshot), so a `/side`
 * or `/btw` run streams into the panel near-live; the final state lands when
 * the catalog reports the child inactive.
 *
 * The panel deliberately never attaches the child session client-side (no
 * `sessions.binding` / session-face subscription): instantiating a session
 * that is never opened leaves it in the runtime's cold state, whose live
 * event frames are dropped — the transcript would only ever refresh on
 * unrelated state flips — and the extra scope minting interferes with the
 * runtime's session staging. Polling keeps the panel a pure RPC consumer.
 *
 * The visibility + selection store is module-scoped (`panel-state.ts`),
 * shared with the `/side` / `/btw` cards, which reveal the panel and select
 * the new child on a live settle.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type {
  SessionId, SessionListState, SessionSummary, SubagentAddress,
  SubagentCatalogSnapshot,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  IconBranchOutline16, IconChevronLeftOutline14, IconCloseOutline16,
  IconRefreshOutline14, IconRightUpOutline14, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS } from './locales.ts'
import {
  closeSidechainPanel, isSidechainPanelOpen, selectChild, selectedChildId,
  subscribeSidechainPanel, toggleSidechainPanel,
} from './panel-state.ts'
import type { TranscriptRow } from './sidechain-view.ts'

/** Business actions injected by the slot registration (per session scope). */
export interface SidechainPanelInjected {
  /** Fetch one child's transcript tail page (catalog `subagent.history`). */
  readTranscript(address: SubagentAddress): Promise<readonly TranscriptRow[] | null>
  /** Deliver one human message to a continuable child. */
  sendPrompt(address: Extract<SubagentAddress, { mode: 'continuable' }>, text: string): Promise<boolean>
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
    position: 'fixed', top: 0, right: 0, bottom: 0, width: 360, maxWidth: '85vw',
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
  back: {
    display: 'inline-flex', alignItems: 'center', gap: 2,
    padding: '2px 4px', border: 'none', borderRadius: 6,
    background: 'transparent', color: C.text2, cursor: 'pointer', fontSize: 12,
    flex: 1, textAlign: 'left',
  },
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
  transcript: { flex: 1, overflowY: 'auto', padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 8 },
  userRow: { alignSelf: 'flex-start', maxWidth: '100%' },
  userText: {
    display: 'inline-block', padding: '6px 10px', borderRadius: 10,
    background: 'var(--ds-color-bg-2, #f2f3f5)', color: C.text1,
    whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 13, lineHeight: 1.5,
  },
  assistantRow: { alignSelf: 'flex-start', maxWidth: '100%' },
  assistantText: {
    display: 'inline-block', padding: '6px 10px', borderRadius: 10,
    background: 'var(--ds-color-surface-2, #eef2ff)', color: C.text1,
    whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 13, lineHeight: 1.5,
  },
  toolRow: { color: C.text2, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  toolFailed: { color: C.danger },
  composer: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '10px 12px', borderTop: `1px solid ${C.border}`,
  },
  input: {
    flex: 1, minWidth: 0, padding: '6px 10px', border: `1px solid ${C.border}`, borderRadius: 8,
    background: 'var(--ds-color-bg-1, #ffffff)', color: C.text1, fontSize: 13, outline: 'none',
  },
  sendButton: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 28, height: 28, padding: 0, border: 'none', borderRadius: 8,
    background: C.primary, color: '#fff', cursor: 'pointer',
  },
  readonly: {
    padding: '8px 12px', borderTop: `1px solid ${C.border}`,
    color: C.text2, fontSize: 12, textAlign: 'center',
  },
}

/** Render one catalog row; clicking selects it for the embedded view. */
function Row({ row, t, onSelect }: {
  row: SidechainRow
  t: SidechainPanelProps['t']
  onSelect: (childSessionId: SessionId) => void
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
      onClick={() => onSelect(row.id)}
    >
      <StateDot state={row.activity === 'running' ? 'ongoing' : 'done'} />
      <span style={styles.content}>
        <span style={styles.label}>{row.label}</span>
        <span style={styles.summary}>{`${mode} · ${activity}`}</span>
      </span>
    </button>
  )
}

/** One transcript row: user prompt, assistant answer, or a tool line. */
function TranscriptRowView({ row, t }: { row: TranscriptRow; t: SidechainPanelProps['t'] }): JSX.Element {
  if (row.kind === 'user') {
    return (
      <div style={styles.userRow}>
        <span style={styles.userText}>{row.text}</span>
      </div>
    )
  }
  if (row.kind === 'assistant') {
    return (
      <div style={styles.assistantRow}>
        <span style={styles.assistantText}>{row.text}</span>
      </div>
    )
  }
  return (
    <div style={{ ...styles.toolRow, ...(row.failed ? styles.toolFailed : {}) }}>
      {`🔧 ${row.name}${row.failed ? ' ✗' : ''}`}
    </div>
  )
}

/** Poll interval for the selected child's transcript while it is running (ms). */
const LIVE_POLL_INTERVAL_MS = 1200

/**
 * The header action: a toggle button plus, while open, the floating right
 * panel. The panel shows the catalog list, or — once a child is selected —
 * the child's embedded conversation (transcript + composer for continuable
 * threads); the main session never switches. Arming the catalog happens on
 * open and follows the current session.
 */
export function SidechainPanel({
  sessionId, useSessions, readTranscript, sendPrompt, refresh, setCatalogOpen, t,
}: SidechainPanelProps): JSX.Element {
  const [open, setOpen] = useState(isSidechainPanelOpen)
  const [selected, setSelected] = useState(selectedChildId)
  useEffect(() => subscribeSidechainPanel(() => {
    setOpen(isSidechainPanelOpen())
    setSelected(selectedChildId())
  }), [])

  const catalogs = useSessions(state => state.subagentsByParent)
  const summaries = useSessions(state => state.byId)
  const catalog = catalogs[sessionId]
  const rows = useMemo(() => sidechainRows(catalog, summaries), [catalog, summaries])
  const running = runningCount(rows)

  // The injected actions can be recreated per render; keep effects pinned to
  // stable keys, reading the latest actions through a ref.
  const actionsRef = useRef({ readTranscript, sendPrompt, refresh, setCatalogOpen })
  actionsRef.current = { readTranscript, sendPrompt, refresh, setCatalogOpen }

  // Arm the catalog feed and refresh while open; disarm on close or when the
  // panel moves to another session (the cleanup runs with the old session id).
  useEffect(() => {
    if (!open) return
    const { refresh, setCatalogOpen } = actionsRef.current
    setCatalogOpen(sessionId, true)
    refresh(sessionId)
    return () => { actionsRef.current.setCatalogOpen(sessionId, false) }
  }, [open, sessionId])

  // The selected child's durable address (stable while selection/catalog stay).
  const address = useMemo<SubagentAddress | undefined>(() => {
    if (selected === undefined) return undefined
    const row = rows.find(candidate => candidate.kind === 'child' && candidate.id === selected)
    return row?.kind === 'child'
      ? { parentSessionId: sessionId, childSessionId: selected, mode: row.mode }
      : undefined
  }, [selected, rows, sessionId])

  // Transcript fetch state; an epoch guard makes stale responses no-ops.
  const [transcript, setTranscript] = useState<readonly TranscriptRow[] | null>(null)
  const [transcriptState, setTranscriptState] = useState<'loading' | 'ready' | 'error'>('loading')
  const fetchEpoch = useRef(0)
  const refetch = useCallback(() => {
    if (address === undefined) return
    const epoch = ++fetchEpoch.current
    setTranscriptState('loading')
    void actionsRef.current.readTranscript(address).then((result) => {
      if (epoch !== fetchEpoch.current) return
      setTranscript(result)
      setTranscriptState(result === null ? 'error' : 'ready')
    })
  }, [address])
  useEffect(() => {
    if (!open) return
    refetch()
  }, [open, refetch])

  // The selected child's catalog row (its activity drives the live poll).
  const selectedRow = selected === undefined
    ? undefined
    : rows.find(candidate => candidate.id === selected)
  const selectedChild = selectedRow !== undefined && selectedRow.kind === 'child' ? selectedRow : undefined
  const selectedRunning = selectedChild?.activity === 'running'

  // Poll the transcript tail page while the selected child is running. The
  // child session is never opened client-side, so its live event frames are
  // dropped by the runtime (cold session) — the poll is the only reliable
  // live feed, and the host serves the running child's in-memory snapshot.
  useEffect(() => {
    if (!open || address === undefined || !selectedRunning) return
    const timer = setInterval(() => { refetch() }, LIVE_POLL_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [open, address, selectedRunning, refetch])

  // One final refresh when the selected child transitions running → inactive
  // (the catalog activity flip), so the settled transcript lands exactly.
  const prevRunning = useRef<boolean | undefined>(undefined)
  useEffect(() => {
    if (selectedChild === undefined) {
      prevRunning.current = undefined
      return
    }
    if (prevRunning.current === true && !selectedRunning) {
      refetch()
    }
    prevRunning.current = selectedRunning
  }, [selectedChild, selectedRunning, refetch])

  // Keep the newest content in view while a run streams.
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = transcriptRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [transcript])

  // Composer state for continuable children.
  const [draft, setDraft] = useState('')
  const [sendFailed, setSendFailed] = useState(false)
  const send = useCallback(async () => {
    if (address?.mode !== 'continuable') return
    const text = draft.trim()
    if (text === '') return
    setDraft('')
    setSendFailed(false)
    const ok = await actionsRef.current.sendPrompt(
      { parentSessionId: address.parentSessionId, childSessionId: address.childSessionId, mode: 'continuable' },
      text,
    )
    if (!ok) setSendFailed(true)
    refetch()
  }, [address, draft, refetch])

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
            {address === undefined ? (
              <span style={styles.title}>{t('panel.title')}</span>
            ) : (
              <button
                type="button"
                style={styles.back}
                title={t('view.back')}
                onClick={() => { selectChild(undefined) }}
              >
                <IconChevronLeftOutline14 />
                {t('view.back')}
              </button>
            )}
            {address === undefined && running > 0 && (
              <span style={styles.runningCount}>{t('count.running', { count: running })}</span>
            )}
            <button
              type="button"
              style={styles.iconButton}
              title={t('panel.refresh')}
              aria-label={t('panel.refresh')}
              onClick={() => {
                if (address === undefined) actionsRef.current.refresh(sessionId)
                else refetch()
              }}
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
          {address === undefined ? (
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
                  onSelect={(childSessionId) => { selectChild(childSessionId) }}
                />
              ))}
            </div>
          ) : (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <div ref={transcriptRef} style={styles.transcript}>
                {transcriptState === 'loading' && <div style={styles.notice}>{t('view.loading')}</div>}
                {transcriptState === 'error' && (
                  <div style={styles.error}>
                    <span>{t('view.error')}</span>
                    <button type="button" style={styles.retry} onClick={refetch}>
                      {t('panel.retry')}
                    </button>
                  </div>
                )}
                {transcriptState === 'ready' && transcript !== null && transcript.length === 0 && (
                  <div style={styles.notice}>{t('view.empty')}</div>
                )}
                {(transcript ?? []).map((row, index) => (
                  <TranscriptRowView key={index} row={row} t={t} />
                ))}
              </div>
              {address.mode === 'one-shot' ? (
                <div style={styles.readonly}>{t('view.readonly')}</div>
              ) : (
                <form
                  style={styles.composer}
                  onSubmit={(event) => {
                    event.preventDefault()
                    void send()
                  }}
                >
                  <input
                    style={styles.input}
                    value={draft}
                    placeholder={t('composer.placeholder')}
                    aria-label={t('composer.sendAria')}
                    onChange={(event) => { setDraft(event.target.value) }}
                  />
                  <button type="submit" style={styles.sendButton} aria-label={t('composer.send')}>
                    <IconRightUpOutline14 />
                  </button>
                </form>
              )}
              {sendFailed && <div style={styles.error}>{t('view.sendFailed')}</div>}
            </div>
          )}
        </aside>
      )}
    </>
  )
}

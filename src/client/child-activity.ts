import type { SubagentCatalogSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'

/**
 * Resolved activity of one side-conversation child. A tri-state, not a boolean:
 * the host has different UI behaviors for "we have not checked yet" versus
 * "we have checked and the child is no longer running". Treating the unknown
 * state as running would make a catalog load failure (or a missing catalog
 * feed) drive the command card into an infinite transcript poll and the
 * sidechain panel into a permanent "Deep diving…" hint, including for /btw
 * commands that finished before the page was refreshed.
 */
export type ChildActivity = 'unknown' | 'running' | 'inactive'

/** Snapshot state of the parent session's subagent catalog, if any. */
export type CatalogState = SubagentCatalogSnapshot['state'] | 'absent'

/** Single catalog entry's reported activity, when the child is in the catalog. */
export type CatalogActivity = 'running' | 'inactive'

/** Inputs the resolver combines. Each is independently optional. */
export interface ChildActivityInput {
  /** Parent catalog snapshot state: `absent` means no catalog has been fetched. */
  catalogState: CatalogState
  /** The child's own catalog activity when it appears in the catalog list. */
  catalogActivity: CatalogActivity | undefined
  /** Session summary running bit for the child (most reliable; host-updated). */
  summaryRunning: boolean | undefined
}

/**
 * Resolve a child's live activity without treating missing data as running.
 *
 * Precedence:
 * 1. A session summary running bit is the most reliable signal (the host
 *    pushes it on session frames). When present, it is authoritative.
 * 2. Otherwise the catalog entry's activity is used.
 * 3. A catalog that finished loading and is missing the child means the
 *    child is no longer in the parent's membership feed: `inactive`.
 * 4. Anything else (catalog not fetched, loading, or errored) is `unknown`.
 *
 * The `unknown` state must never drive a poll loop or a waiting hint; both
 * conditions require an explicit `running`.
 *
 * @param input - the available activity signals.
 * @returns the resolved activity.
 */
export function resolveChildActivity(input: ChildActivityInput): ChildActivity {
  if (input.summaryRunning !== undefined) {
    return input.summaryRunning ? 'running' : 'inactive'
  }
  if (input.catalogActivity !== undefined) {
    return input.catalogActivity
  }
  if (input.catalogState === 'ready') {
    return 'inactive'
  }
  return 'unknown'
}

/** Node-test stand-ins for supported DSH browser bundles loaded through window.__ModuleLoader__. */


export const DisclosureRow = () => null
export const IconBranchOutline16 = () => null
export const IconBrowseOutline16 = () => null
export const IconChevronLeftOutline14 = () => null
export const IconCloseOutline16 = () => null
export const IconFullscreenOutline16 = () => null
export const IconRefreshOutline14 = () => null
export const IconRightUpOutline14 = () => null
export const IconThinkOutline14 = () => null
export const MarkdownText = () => null
export const StateDot = () => null

/**
 * Controllable stand-in for the alpha.2 Session journal stream. Tests push
 * fixtures before a read: `nextOpen` frames feed `open()`, `nextPrepend`
 * frames feed `prepend()`; both publish into the consumer's `publish` sink
 * exactly like the Gateway journal stream does.
 */
export interface FakeJournalWindow {
  page: { records: unknown[]; hasMore: boolean }
  entries: unknown[]
  hasMore: boolean
  /** Live append entries published after the opening window. */
  live?: unknown[]
}

export class SessionEventStream {
  static instances: SessionEventStream[] = []
  static nextOpen: FakeJournalWindow[] = []
  static nextPrepend: FakeJournalWindow[] = []

  private readonly publishSink: { publish(change: unknown): void }

  constructor(_remotes: unknown, _address: unknown, options: { publish(change: unknown): void }) {
    this.publishSink = options
    SessionEventStream.instances.push(this)
  }

  async open(_request: unknown): Promise<void> {
    const next = SessionEventStream.nextOpen.shift()
    if (next !== undefined) {
      this.publishSink.publish({
        type: 'replace', page: next.page, entries: next.entries, hasMore: next.hasMore,
      })
      for (const entry of next.live ?? []) {
        this.publishSink.publish({ type: 'append', entry })
      }
    }
  }

  async prepend(_request: unknown): Promise<void> {
    const next = SessionEventStream.nextPrepend.shift()
    if (next !== undefined) {
      this.publishSink.publish({
        type: 'prepend', page: next.page, entries: next.entries, hasMore: next.hasMore,
      })
    }
  }

  async dispose(): Promise<void> {}

  static reset(): void {
    SessionEventStream.instances = []
    SessionEventStream.nextOpen = []
    SessionEventStream.nextPrepend = []
  }
}

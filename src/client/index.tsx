/**
 * dsh-sidechain, browser half: registers compact `/side` and `/btw` command
 * cards into the keyed `conversation.chat.commandview` slot, plus a
 * sidechain right panel listing the current session's side subagents with an
 * embedded conversation view. The panel host lives beside the composer so it
 * also observes blank sessions; the header contributes only its manual
 * toggle. A successful live command reveals the new child without switching
 * or engaging the main conversation.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { SideCommandCard } from './SideCommandCard.tsx'
import { SidechainPanel, SidechainPanelToggle, type SidechainPanelInjected } from './SidechainPanel.tsx'
import { installSidechainStyle } from './panel-style.ts'
import {
  readChildActivity, readChildTranscript, sendPrompt,
  type JournalRemotes,
} from './sidechain-view.ts'
import { NS, en, zh } from './locales.ts'

export const name = 'dsh-sidechain'

export const inject = [
  'slots',
  'sessions',
  'locale',
  'remote',
  'remote.session',
  'remote.subagents',
]

export function apply(ctx: Context): void {
  const sessions = ctx.sessions
  const subagents = ctx.remote.subagents
  // The journal layer consumes the generated namespaces through the same
  // structural face the Session runtime uses (session / subagents / commands
  // namespaces plus the Gateway stream factory).
  const remotes: JournalRemotes = {
    $stream: (options) => ctx.remote.$stream(options),
    commands: ctx.remote.commands,
    session: ctx.remote.session,
    subagents: ctx.remote.subagents,
  }
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-sidechain: sidechain dictionaries')
  // One shared keyframe stylesheet (shimmer sweep); the effect's disposer
  // removes it with the fiber — hot unload leaves no stray <style> tags.
  ctx.effect(installSidechainStyle, 'dsh-sidechain: panel stylesheet')
  // Wait for the chat view's declaration instead of registering into an
  // undeclared slot: entry application order is loader-driven, and a direct
  // register racing the declaration fails boot with "slot ... is not declared".
  ctx.slots.inject(
    'conversation.chat.commandview',
    () => ctx.slots.register({
      name: 'conversation.chat.commandview',
      key: 'side',
    }, (props) => <SideCommandCard node={props.node} />),
  )
  ctx.slots.inject(
    'conversation.chat.commandview',
    () => ctx.slots.register({
      name: 'conversation.chat.commandview',
      key: 'btw',
    }, (props) => <SideCommandCard node={props.node} />),
  )
  const panelInject = (_parentSessionId: SessionId): SidechainPanelInjected => ({
    readTranscript(address: SubagentAddress) {
      return readChildTranscript(remotes, address)
    },
    readActivity(address: SubagentAddress) {
      return readChildActivity(remotes, address)
    },
    sendPrompt(address: Extract<SubagentAddress, { mode: 'continuable' }>, text: string) {
      return sendPrompt(subagents, address, text)
    },
    refresh(parentSessionId: SessionId): void {
      void sessions.refreshSubagents(parentSessionId)
    },
    setCatalogOpen(parentSessionId: SessionId, open: boolean): void {
      sessions.setSubagentCatalogOpen(parentSessionId, open)
    },
    openPath(path: string): void {
      // Mirror the main chat's openFile: host open failures stay silent.
      void ctx.remote.session.openWorkspacePath({ path }).catch(() => {})
    },
  })
  ctx.slots.inject(
    'conversation.input.dock',
    () => ctx.slots.register({
      name: 'conversation.input.dock',
      id: 'sidechain-panel-host',
      order: 30,
      locale: NS,
      inject: panelInject,
    }, SidechainPanel),
  )
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'sidechain-panel-toggle',
      order: 20,
      locale: NS,
    }, SidechainPanelToggle),
  )
}

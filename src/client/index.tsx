/**
 * dsh-sidechain, browser half: registers compact `/side` and `/btw` command
 * cards into the keyed `conversation.chat.commandview` slot, plus the
 * sidechain right panel — a header action that opens a floating right-edge
 * sidebar listing the current session's side subagents with an embedded
 * conversation view. When a command settles successfully the card reveals
 * the panel and selects the new child: its transcript renders in the sidebar
 * while the main session keeps running untouched.
 */

import type { ClientContext, IWorkspaces, SessionId, SubagentAddress } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { SideCommandCard, type SideCommandCardInjected } from './SideCommandCard.tsx'
import { SidechainPanel, type SidechainPanelInjected } from './SidechainPanel.tsx'
import { openSidechainPanel, revealChild } from './panel-state.ts'
import { installSidechainStyle } from './panel-style.ts'
import { fetchActivity, fetchTranscript, sendPrompt } from './sidechain-view.ts'
import { NS, en, zh } from './locales.ts'

export const name = 'dsh-sidechain'

export const inject = ['slots', 'sessions', 'locale', 'connection', 'workspaces']

export function apply(ctx: ClientContext): void {
  const sessions = ctx.sessions
  const connection = ctx.get('connection') as ConnectionHandle
  const workspaces = ctx.get('workspaces') as IWorkspaces
  const subagents = connection.api.subagents
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-sidechain: sidechain dictionaries')
  // One shared keyframe stylesheet (shimmer sweep); the effect's disposer
  // removes it with the fiber — hot unload leaves no stray <style> tags.
  ctx.effect(installSidechainStyle, 'dsh-sidechain: panel stylesheet')
  const cardInject = (mode: 'continuable' | 'one-shot') => (_parentSessionId: SessionId): SideCommandCardInjected => ({
    // A live settle reveals the panel with the new child selected — the main
    // session never switches (the transcript renders inside the sidebar).
    revealPanel(childSessionId: SessionId): void {
      openSidechainPanel()
      revealChild(childSessionId)
    },
  })
  // Wait for the chat view's declaration instead of registering into an
  // undeclared slot: entry application order is loader-driven, and a direct
  // register racing the declaration fails boot with "slot ... is not declared".
  ctx.slots.inject(
    'conversation.chat.commandview',
    () => ctx.slots.register({
      name: 'conversation.chat.commandview',
      key: 'side',
      inject: cardInject('continuable'),
    }, SideCommandCard),
  )
  ctx.slots.inject(
    'conversation.chat.commandview',
    () => ctx.slots.register({
      name: 'conversation.chat.commandview',
      key: 'btw',
      inject: cardInject('one-shot'),
    }, SideCommandCard),
  )
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'sidechain-panel',
      order: 20,
      locale: NS,
      inject: (parentSessionId: SessionId): SidechainPanelInjected => ({
        readTranscript(address: SubagentAddress) {
          return fetchTranscript(connection.api.sessions, address)
        },
        readActivity(address: SubagentAddress) {
          return fetchActivity(connection.api.sessions, address)
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
          void workspaces.openPath(path).catch(() => {})
        },
      }),
    }, SidechainPanel),
  )
}

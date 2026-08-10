/**
 * dsh-sidechain, browser half: registers compact `/side` and `/btw` command
 * cards into the keyed `conversation.chat.commandview` slot, plus the
 * sidechain right panel — a header action that opens a floating right-edge
 * sidebar listing the current session's side subagents. A card auto-opens
 * the created side conversation in the subagent view when its command settles
 * successfully — the main thread keeps running, the view switches over — and
 * reveals the sidechain panel so the new child shows up in the sidebar.
 */

import type { ClientContext, SessionId, SubagentAddress } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { SideCommandCard, type SideCommandCardInjected } from './SideCommandCard.tsx'
import { SidechainPanel, type SidechainPanelInjected } from './SidechainPanel.tsx'
import { openSidechainPanel } from './panel-state.ts'
import { NS, en, zh } from './locales.ts'

export const name = 'dsh-sidechain'

export const inject = ['slots', 'sessions', 'locale']

export function apply(ctx: ClientContext): void {
  const sessions = ctx.sessions
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-sidechain: sidechain dictionaries')
  const cardInject = (mode: 'continuable' | 'one-shot') => (parentSessionId: SessionId): SideCommandCardInjected => ({
    openChild(childSessionId: SessionId): void {
      sessions.openSubagent({ parentSessionId, childSessionId, mode } satisfies SubagentAddress)
    },
    revealPanel(): void {
      openSidechainPanel()
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
        openChild(address: SubagentAddress): void {
          sessions.openSubagent(address)
        },
        refresh(parentSessionId: SessionId): void {
          void sessions.refreshSubagents(parentSessionId)
        },
        setCatalogOpen(parentSessionId: SessionId, open: boolean): void {
          sessions.setSubagentCatalogOpen(parentSessionId, open)
        },
      }),
    }, SidechainPanel),
  )
}

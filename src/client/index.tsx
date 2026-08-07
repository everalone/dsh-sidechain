/**
 * dsh-sidechain, browser half: registers compact `/side` and `/btw` command
 * cards into the keyed `conversation.chat.commandview` slot. A card auto-opens
 * the created side conversation in the subagent view when its command settles
 * successfully — the main thread keeps running, the view switches over.
 */

import type { ClientContext, SessionId, SubagentAddress } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SideCommandCard, type SideCommandCardInjected } from './SideCommandCard.tsx'

export const name = 'dsh-sidechain'

export const inject = ['slots', 'sessions']

export function apply(ctx: ClientContext): void {
  const sessions = ctx.sessions
  const cardInject = (mode: 'continuable' | 'one-shot') => (parentSessionId: SessionId): SideCommandCardInjected => ({
    openChild(childSessionId: SessionId): void {
      sessions.openSubagent({ parentSessionId, childSessionId, mode } satisfies SubagentAddress)
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
}

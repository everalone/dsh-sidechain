/** `sidechain` namespace dictionaries. */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Sidechain panel copy. */
    'sidechain': SidechainKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'sidechain'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'panel.title': '侧链',
  'panel.toggle': '侧链：/side 与 /btw 子代理',
  'panel.close': '关闭侧链面板',
  'panel.refresh': '刷新侧链',
  'panel.empty': '暂无侧会话，试试 /side 或 /btw',
  'panel.loading': '正在加载侧会话…',
  'panel.error': '无法加载侧会话',
  'panel.retry': '重试',
  'count.running': '{count} 个正在运行',
  'mode.oneShot': '/btw 一次性',
  'mode.continuable': '/side 可续聊',
  'activity.running': '正在运行',
  'activity.inactive': '已结束',
  'diagnostic.corrupt': '会话记录损坏',
  'diagnostic.unsupported': '子代理记录版本不受支持',
  'diagnostic.unavailable': '会话记录暂不可用',
  'row.open': '打开子代理 {label}',
} as const

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<SidechainKey, string> = {
  'panel.title': 'Sidechain',
  'panel.toggle': 'Sidechain: /side & /btw subagents',
  'panel.close': 'Close sidechain panel',
  'panel.refresh': 'Refresh sidechain',
  'panel.empty': 'No side conversations yet — try /side or /btw',
  'panel.loading': 'Loading side conversations…',
  'panel.error': 'Failed to load side conversations',
  'panel.retry': 'Retry',
  'count.running': '{count} running',
  'mode.oneShot': '/btw one-shot',
  'mode.continuable': '/side continuable',
  'activity.running': 'Running',
  'activity.inactive': 'Finished',
  'diagnostic.corrupt': 'Corrupted session record',
  'diagnostic.unsupported': 'Unsupported subagent record version',
  'diagnostic.unavailable': 'Session record temporarily unavailable',
  'row.open': 'Open subagent {label}',
}

/** Key union of the `sidechain` namespace (Chinese dictionary is the source of truth). */
export type SidechainKey = keyof typeof zh

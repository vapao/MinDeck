import { useSyncExternalStore } from 'react'

export const readDraft = (sessionId: string) => localStorage.getItem(`draft:${sessionId}`) ?? ''

export function saveDraft(sessionId: string, text: string) {
  if (text) localStorage.setItem(`draft:${sessionId}`, text)
  else localStorage.removeItem(`draft:${sessionId}`)
  // storage 事件只发给其它标签页，当前页面的列表需要单独通知。
  window.dispatchEvent(new Event('mindeck:draft-changed'))
}

/** 从消息里把一段文字放进某会话的输入框（Codex 后续建议），由 Composer 接收 */
export function fillComposer(sessionId: string, text: string) {
  window.dispatchEvent(new CustomEvent('mindeck:fill-composer', { detail: { sessionId, text } }))
}

function subscribe(callback: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.storageArea === localStorage && (event.key === null || event.key.startsWith('draft:'))) callback()
  }
  window.addEventListener('storage', onStorage)
  window.addEventListener('mindeck:draft-changed', callback)
  return () => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener('mindeck:draft-changed', callback)
  }
}

export function useDraftSessions(sessions: { id: string }[]): Set<string> {
  const snapshot = useSyncExternalStore(subscribe, () => JSON.stringify(sessions.filter((s) => readDraft(s.id).trim()).map((s) => s.id)))
  return new Set<string>(JSON.parse(snapshot))
}

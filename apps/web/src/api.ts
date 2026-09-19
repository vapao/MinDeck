import type { CreateSessionBody, CreateSessionResponse, ListWorkspacesResponse, SendMessageBody, SendMessageResponse } from '@agentdeck/shared'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null
    throw new Error(body?.message ?? `${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<T>
}

export const api = {
  listWorkspaces: () => request<ListWorkspacesResponse>('/api/workspaces'),
  createSession: (body: CreateSessionBody) =>
    request<CreateSessionResponse>('/api/sessions', { method: 'POST', body: JSON.stringify(body) }),
  sendMessage: (sessionId: string, body: SendMessageBody) =>
    request<SendMessageResponse>(`/api/sessions/${sessionId}/messages`, { method: 'POST', body: JSON.stringify(body) }),
}

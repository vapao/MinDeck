import type { CreateSessionBody, CreateSessionResponse, CreateWorkspaceBody, InterruptResponse, ListDirsResponse, ListSessionsResponse, ListWorkspacesResponse, ResolvePendingBody, ResolvePendingResponse, SendMessageBody, SendMessageResponse, SettingsResponse, UpdateSettingsBody, UpdateWorkspaceBody, UploadAttachmentResponse, Workspace } from '@agentdeck/shared'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // FormData 由浏览器自己设 multipart boundary，不能覆盖 content-type
  const headers = init?.body instanceof FormData ? init.headers : { 'content-type': 'application/json', ...init?.headers }
  const res = await fetch(path, { ...init, headers })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null
    throw new Error(body?.message ?? `${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<T>
}

export const api = {
  listWorkspaces: () => request<ListWorkspacesResponse>('/api/workspaces'),
  createWorkspace: (body: CreateWorkspaceBody) => request<Workspace>('/api/workspaces', { method: 'POST', body: JSON.stringify(body) }),
  updateWorkspace: (id: string, body: UpdateWorkspaceBody) => request<Workspace>(`/api/workspaces/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteWorkspace: (id: string) => request<{ ok: true }>(`/api/workspaces/${id}`, { method: 'DELETE' }),
  listDirs: (path?: string) => request<ListDirsResponse>(`/api/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  getSettings: () => request<SettingsResponse>('/api/settings'),
  updateSettings: (body: UpdateSettingsBody) => request<SettingsResponse>('/api/settings', { method: 'PUT', body: JSON.stringify(body) }),
  listSessions: () => request<ListSessionsResponse>('/api/sessions'),
  interrupt: (sessionId: string) => request<InterruptResponse>(`/api/sessions/${sessionId}/interrupt`, { method: 'POST' }),
  createSession: (body: CreateSessionBody) =>
    request<CreateSessionResponse>('/api/sessions', { method: 'POST', body: JSON.stringify(body) }),
  sendMessage: (sessionId: string, body: SendMessageBody) =>
    request<SendMessageResponse>(`/api/sessions/${sessionId}/messages`, { method: 'POST', body: JSON.stringify(body) }),
  resolvePending: (requestId: string, body: ResolvePendingBody) =>
    request<ResolvePendingResponse>(`/api/pending/${requestId}/resolve`, { method: 'POST', body: JSON.stringify(body) }),
  uploadAttachment: (sessionId: string, file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<UploadAttachmentResponse>(`/api/sessions/${sessionId}/attachments`, { method: 'POST', body: form })
  },
  attachmentUrl: (id: string) => `/api/attachments/${id}`,
}

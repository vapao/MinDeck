import type { CreateSessionBody, CreateSessionResponse, CreateWorkspaceBody, DeleteSessionResponse, DiffResponse, EntriesResponse, FileResponse, InterruptResponse, ListChangesResponse, ListDirsResponse, ListSessionsResponse, ListWorkspacesResponse, ResolvePendingBody, ResolvePendingResponse, SendMessageBody, SendMessageResponse, SettingsResponse, UpdateSettingsBody, UpdateWorkspaceBody, UploadAttachmentResponse, Workspace } from '@agentdeck/shared'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // 只有 JSON body 才声明 content-type：FormData 由浏览器自己设 multipart boundary；无 body 的 DELETE 带上会被 Fastify 按空 JSON 拒绝
  const headers = typeof init?.body === 'string' ? { 'content-type': 'application/json', ...init.headers } : init?.headers
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
  listEntries: (sessionId: string, q: string) => request<EntriesResponse>(`/api/sessions/${sessionId}/entries?q=${encodeURIComponent(q)}`),
  listChanges: (sessionId: string) => request<ListChangesResponse>(`/api/sessions/${sessionId}/changes`),
  fileDiff: (sessionId: string, path: string) => request<DiffResponse>(`/api/sessions/${sessionId}/diff?path=${encodeURIComponent(path)}`),
  readFile: (sessionId: string, path: string) => request<FileResponse>(`/api/sessions/${sessionId}/file?path=${encodeURIComponent(path)}`),
  deleteSession: (sessionId: string) => request<DeleteSessionResponse>(`/api/sessions/${sessionId}`, { method: 'DELETE' }),
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

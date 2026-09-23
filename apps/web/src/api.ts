import type { ProjectFilesResponse, CreateServiceBody, ListServicesResponse, Service, ServiceLogResponse, UpdateServiceBody, CreateSessionBody, CreateSessionResponse, CreateWorkspaceBody, DeleteSessionResponse, DiffResponse, EntriesResponse, ForkSessionBody, ForkSessionResponse, FileResponse, InterruptResponse, ListChangesResponse, ListDirsResponse, ListSessionsResponse, ListWorkspacesResponse, ResolvePendingBody, ResolvePendingResponse, SendMessageBody, SendMessageResponse, SettingsResponse, UpdateSessionBody, UpdateSessionResponse, UpdateSettingsBody, UpdateWorkspaceBody, UploadAttachmentResponse, UsageResponse, Workspace } from '@agentdeck/shared'

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

export type OutputFile = { path: string; name: string; size: number; mime: string; kind: string; content: string | null; truncated: boolean }
export const api = {
  outputFile: (id: string, path: string) => request<OutputFile>(`/api/sessions/${id}/output?path=${encodeURIComponent(path)}`),
  outputUrl: (id: string, path: string, download = false) => `/api/sessions/${id}/output/content?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`,
  listWorkspaces: () => request<ListWorkspacesResponse>('/api/workspaces'),
  createWorkspace: (body: CreateWorkspaceBody) => request<Workspace>('/api/workspaces', { method: 'POST', body: JSON.stringify(body) }),
  updateWorkspace: (id: string, body: UpdateWorkspaceBody) => request<Workspace>(`/api/workspaces/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteWorkspace: (id: string) => request<{ ok: true }>(`/api/workspaces/${id}`, { method: 'DELETE' }),
  listServices: () => request<ListServicesResponse>('/api/services'),
  createService: (body: CreateServiceBody) => request<Service>('/api/services', { method: 'POST', body: JSON.stringify(body) }),
  updateService: (id: string, body: UpdateServiceBody) => request<Service>(`/api/services/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteService: (id: string) => request<{ ok: true }>(`/api/services/${id}`, { method: 'DELETE' }),
  serviceAction: (id: string, action: 'start' | 'stop' | 'restart') => request<{ ok: true }>(`/api/services/${id}/${action}`, { method: 'POST' }),
  serviceLog: (id: string, cursor: string) => request<ServiceLogResponse>(`/api/services/${id}/log?cursor=${encodeURIComponent(cursor)}`),
  listDirs: (path?: string) => request<ListDirsResponse>(`/api/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  getSettings: () => request<SettingsResponse>('/api/settings'),
  updateSettings: (body: UpdateSettingsBody) => request<SettingsResponse>('/api/settings', { method: 'PUT', body: JSON.stringify(body) }),
  testDeepseek: () => request<{ baseUrl: string; model: string }>('/api/settings/deepseek/test', { method: 'POST' }),
  revealDeepseekKey: () => request<{ apiKey: string }>('/api/settings/deepseek/reveal-key', { method: 'POST', cache: 'no-store' }),
  getUsage: () => request<UsageResponse>('/api/usage'),
  listSessions: () => request<ListSessionsResponse>('/api/sessions'),
  listEntries: (sessionId: string, q: string) => request<EntriesResponse>(`/api/sessions/${sessionId}/entries?q=${encodeURIComponent(q)}`),
  listProjectFiles: (id: string, path: string, q: string, hidden: boolean) => request<ProjectFilesResponse>(`/api/sessions/${id}/files?${new URLSearchParams({ path, q, hidden: String(hidden) })}`),
  listChanges: (sessionId: string) => request<ListChangesResponse>(`/api/sessions/${sessionId}/changes`),
  fileDiff: (sessionId: string, path: string) => request<DiffResponse>(`/api/sessions/${sessionId}/diff?path=${encodeURIComponent(path)}`),
  readFile: (sessionId: string, path: string) => request<FileResponse>(`/api/sessions/${sessionId}/file?path=${encodeURIComponent(path)}`),
  updateSession: (sessionId: string, body: UpdateSessionBody) => request<UpdateSessionResponse>(`/api/sessions/${sessionId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  forkSession: (sessionId: string, body: ForkSessionBody) => request<ForkSessionResponse>(`/api/sessions/${sessionId}/fork`, { method: 'POST', body: JSON.stringify(body) }),
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

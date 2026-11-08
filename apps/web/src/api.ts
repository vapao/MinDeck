import type { ProjectFilesResponse, CreateServiceBody, ListServicesResponse, Service, ServiceLogResponse, UpdateServiceBody, CreateSessionBody, CreateSessionResponse, CreateWorkspaceBody, DeleteSessionResponse, DiffResponse, EntriesResponse, ForkSessionBody, ForkSessionResponse, FileResponse, InterruptResponse, ListChangesResponse, ListDirsResponse, ListSessionsResponse, ListWorkspacesResponse, ResolvePendingBody, ResolvePendingResponse, SendMessageBody, SendMessageResponse, SettingsResponse, SkillsResponse, UpdateSessionBody, UpdateSessionResponse, UpdateSettingsBody, UpdateWorkspaceBody, UploadAttachmentResponse, UsageResponse, Workspace } from '@agentdeck/shared'
import type { CreateTodoBody, InboxResponse, ListTodosResponse, Todo, TodoDraftResponse, UpdateTodoBody, ListSchedulesResponse, ListWakeupsResponse, RunScheduleResponse, Schedule, ScheduleConfig, UpdateStatusResponse } from '@agentdeck/shared'
import type { StewardMessageBody, StewardMessageResponse, StewardMemory, StewardResponse } from '@agentdeck/shared'
import type { PresenceBody, SaveSecretBody, Secret, SecretValueResponse, UpdateSecretBody } from '@agentdeck/shared'
import type { CreateProjectEntryBody, DeleteProjectEntryBody, DiscardChangeBody, SaveProjectFileBody } from '@agentdeck/shared'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // 只有 JSON body 才声明 content-type：FormData 由浏览器自己设 multipart boundary；无 body 的 DELETE 带上会被 Fastify 按空 JSON 拒绝
  const headers = typeof init?.body === 'string' ? { 'content-type': 'application/json', ...init.headers } : init?.headers
  const res = await fetch(path, { ...init, headers })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null
    throw Object.assign(new Error(body?.message ?? `${res.status} ${res.statusText}`), { status: res.status })
  }
  return res.json() as Promise<T>
}

export type OutputFile = { path: string; name: string; size: number; mime: string; kind: string; content: string | null; truncated: boolean; editable?: boolean }
export const api = {
  updateStatus: () => request<UpdateStatusResponse>('/api/update-status'),
  outputFile: (id: string, path: string) => request<OutputFile>(`/api/sessions/${id}/output?path=${encodeURIComponent(path)}`),
  outputUrl: (id: string, path: string, download = false) => `/api/sessions/${id}/output/content?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`,
  previewUrl: (id: string, path: string) => `/api/sessions/${id}/preview${path.split('/').map(encodeURIComponent).join('/')}`,
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
  listSchedules: () => request<ListSchedulesResponse>('/api/schedules'),
  createSchedule: (body: ScheduleConfig) => request<Schedule>('/api/schedules', { method: 'POST', body: JSON.stringify(body) }),
  updateSchedule: (id: string, body: ScheduleConfig) => request<Schedule>(`/api/schedules/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteSchedule: (id: string) => request<{ ok: true }>(`/api/schedules/${id}`, { method: 'DELETE' }),
  runSchedule: (id: string) => request<RunScheduleResponse>(`/api/schedules/${id}/run`, { method: 'POST' }),
  listDirs: (path?: string) => request<ListDirsResponse>(`/api/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  getSettings: () => request<SettingsResponse>('/api/settings'),
  updateSettings: (body: UpdateSettingsBody) => request<SettingsResponse>('/api/settings', { method: 'PUT', body: JSON.stringify(body) }),
  testDeepseek: () => request<{ baseUrl: string; model: string }>('/api/settings/deepseek/test', { method: 'POST' }),
  revealDeepseekKey: () => request<{ apiKey: string }>('/api/settings/deepseek/reveal-key', { method: 'POST', cache: 'no-store' }),
  // keepalive：离开前台时页面可能马上被冻结或关掉，请求仍要发出去
  presence: (body: PresenceBody) => request<{ ok: true }>('/api/presence', { method: 'POST', body: JSON.stringify(body), keepalive: true }),
  listSecrets: () => request<Secret[]>('/api/secrets'),
  getSecretValue: (id: string) => request<SecretValueResponse>(`/api/secrets/${id}/value`, { cache: 'no-store' }),
  saveSecret: (body: SaveSecretBody) => request<Secret>('/api/secrets', { method: 'POST', body: JSON.stringify(body) }),
  updateSecret: (id: string, body: UpdateSecretBody) => request<Secret>(`/api/secrets/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteSecret: (id: string) => request<{ ok: true }>(`/api/secrets/${id}`, { method: 'DELETE' }),
  getUsage: () => request<UsageResponse>('/api/usage'),
  listSessions: () => request<ListSessionsResponse>('/api/sessions'),
  listEntries: (sessionId: string, q: string) => request<EntriesResponse>(`/api/sessions/${sessionId}/entries?q=${encodeURIComponent(q)}`),
  listSkills: (sessionId: string) => request<SkillsResponse>(`/api/sessions/${sessionId}/skills`),
  listProjectFiles: (id: string, path: string, q: string, hidden: boolean) => request<ProjectFilesResponse>(`/api/sessions/${id}/files?${new URLSearchParams({ path, q, hidden: String(hidden) })}`),
  createProjectEntry: (id: string, body: CreateProjectEntryBody) => request<{ ok: true }>(`/api/sessions/${id}/files`, { method: 'POST', body: JSON.stringify(body) }),
  deleteProjectEntry: (id: string, body: DeleteProjectEntryBody) => request<{ ok: true }>(`/api/sessions/${id}/files`, { method: 'DELETE', body: JSON.stringify(body) }),
  saveProjectFile: (id: string, body: SaveProjectFileBody) => request<{ ok: true }>(`/api/sessions/${id}/files/content`, { method: 'PUT', body: JSON.stringify(body) }),
  listChanges: (sessionId: string) => request<ListChangesResponse>(`/api/sessions/${sessionId}/changes`),
  discardChange: (sessionId: string, body: DiscardChangeBody) => request<{ ok: true }>(`/api/sessions/${sessionId}/changes/discard`, { method: 'POST', body: JSON.stringify(body) }),
  fileDiff: (sessionId: string, path: string) => request<DiffResponse>(`/api/sessions/${sessionId}/diff?path=${encodeURIComponent(path)}`),
  readFile: (sessionId: string, path: string) => request<FileResponse>(`/api/sessions/${sessionId}/file?path=${encodeURIComponent(path)}`),
  updateSession: (sessionId: string, body: UpdateSessionBody) => request<UpdateSessionResponse>(`/api/sessions/${sessionId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  forkSession: (sessionId: string, body: ForkSessionBody) => request<ForkSessionResponse>(`/api/sessions/${sessionId}/fork`, { method: 'POST', body: JSON.stringify(body) }),
  deleteSession: (sessionId: string, descendants = false) => request<DeleteSessionResponse>(`/api/sessions/${sessionId}${descendants ? '?descendants=true' : ''}`, { method: 'DELETE' }),
  interrupt: (sessionId: string) => request<InterruptResponse>(`/api/sessions/${sessionId}/interrupt`, { method: 'POST' }),
  createSession: (body: CreateSessionBody) =>
    request<CreateSessionResponse>('/api/sessions', { method: 'POST', body: JSON.stringify(body) }),
  sendMessage: (sessionId: string, body: SendMessageBody) =>
    request<SendMessageResponse>(`/api/sessions/${sessionId}/messages`, { method: 'POST', body: JSON.stringify(body) }),
  resolvePending: (requestId: string, body: ResolvePendingBody) =>
    request<ResolvePendingResponse>(`/api/pending/${requestId}/resolve`, { method: 'POST', body: JSON.stringify(body) }),
  dismissPending: (requestId: string) => request<{ ok: true }>(`/api/pending/${requestId}/dismiss`, { method: 'POST' }),
  listWakeups: () => request<ListWakeupsResponse>('/api/wakeups'),
  cancelWakeup: (id: string) => request<{ ok: true }>(`/api/wakeups/${id}`, { method: 'DELETE' }),
  inbox: (done: boolean) => request<InboxResponse>(`/api/inbox${done ? '?done=true' : ''}`),
  dismissReview: (sessionId: string) => request<{ ok: true }>(`/api/sessions/${sessionId}/review/dismiss`, { method: 'POST' }),
  todoDraft: (sessionId: string) => request<TodoDraftResponse>(`/api/sessions/${sessionId}/todo-draft`, { method: 'POST' }),
  listTodos: (done: boolean) => request<ListTodosResponse>(`/api/todos?done=${done}`),
  createTodo: (body: CreateTodoBody) => request<Todo>('/api/todos', { method: 'POST', body: JSON.stringify(body) }),
  updateTodo: (id: string, body: UpdateTodoBody) => request<Todo>(`/api/todos/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteTodo: (id: string) => request<{ ok: true }>(`/api/todos/${id}`, { method: 'DELETE' }),
  markReportRead: (id: string) => request<{ ok: true }>(`/api/reports/${id}/read`, { method: 'POST' }),
  uploadAttachment: (sessionId: string, file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<UploadAttachmentResponse>(`/api/sessions/${sessionId}/attachments`, { method: 'POST', body: form })
  },
  attachmentUrl: (id: string) => `/api/attachments/${id}`,
  steward: () => request<StewardResponse>('/api/steward'),
  stewardMessage: (body: StewardMessageBody) => request<StewardMessageResponse>('/api/steward/messages', { method: 'POST', body: JSON.stringify(body) }),
  stewardBrief: () => request<StewardMessageResponse>('/api/steward/brief', { method: 'POST' }),
  createMemory: (text: string) => request<StewardMemory>('/api/steward/memories', { method: 'POST', body: JSON.stringify({ text }) }),
  updateMemory: (id: string, text: string) => request<{ ok: true }>(`/api/steward/memories/${id}`, { method: 'PATCH', body: JSON.stringify({ text }) }),
  deleteMemory: (id: string) => request<{ ok: true }>(`/api/steward/memories/${id}`, { method: 'DELETE' }),
}

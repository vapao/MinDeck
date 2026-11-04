import { useQuery } from '@tanstack/react-query'
import { api } from '../api'

// 同会话列表：单用户 5s 轮询足够。侧栏角标和 Inbox 页共用这一份
export const useInbox = () => useQuery({ queryKey: ['inbox', false], queryFn: () => api.inbox(false), refetchInterval: 5000, refetchIntervalInBackground: true })

export const inboxCount = (data: { requests: unknown[]; reports: unknown[]; unfinished: unknown[]; todos: unknown[] } | undefined) => (data ? data.requests.length + data.reports.length + data.unfinished.length + data.todos.length : 0)

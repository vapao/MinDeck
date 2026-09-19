import { useQuery } from '@tanstack/react-query'
import { api } from '../api'

// 会话列表没有走 WS：单用户场景下 5s 轮询足够，也避免为侧栏再开一路订阅
export const useSessions = () => useQuery({ queryKey: ['sessions'], queryFn: api.listSessions, refetchInterval: 5000 })

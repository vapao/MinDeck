import { useEffect, useState } from 'react'

/** 从 since 起已过去的秒数，active 时每秒刷新 */
export function useElapsed(since: string, active: boolean) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000))
}

export const formatElapsed = (sec: number) => (sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${sec % 60}s`)

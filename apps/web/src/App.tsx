import { usePathname } from './router'
import { NewSessionPage } from './pages/NewSessionPage'
import { SessionPage } from './pages/SessionPage'

export default function App() {
  const pathname = usePathname()
  const match = pathname.match(/^\/s\/([^/]+)$/)
  return match ? <SessionPage sessionId={match[1]} /> : <NewSessionPage />
}

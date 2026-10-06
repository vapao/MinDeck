import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import App from './App.tsx'
import { FilePreviewHost } from './components/FilePreview'
import { DialogHost } from './components/Dialog'

const queryClient = new QueryClient()

// 刷新时旧 SW 先用缓存的旧壳打开页面，新 SW 随后才接管（skipWaiting + clientsClaim）；接管时重载一次，刷新一次就是新版。
// 首次安装没有旧 controller，不重载
if (navigator.serviceWorker?.controller) navigator.serviceWorker.addEventListener('controllerchange', () => location.reload())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      <DialogHost />
      <FilePreviewHost />
    </QueryClientProvider>
  </StrictMode>,
)

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import App from './App.tsx'
import { FilePreviewHost } from './components/FilePreview'
import { DialogHost } from './components/Dialog'

const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      <DialogHost />
      <FilePreviewHost />
    </QueryClientProvider>
  </StrictMode>,
)

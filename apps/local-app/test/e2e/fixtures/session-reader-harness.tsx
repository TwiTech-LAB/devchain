// Mounts the real transcript panel without the app shell, for Playwright specs that
// need real layout. Served by the Vite dev server; the spec mocks every API request.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionViewerPanel } from '@/ui/components/session-reader/SessionViewerPanel';
import '@/ui/styles/global.css';

const params = new URLSearchParams(window.location.search);
const sessionId = params.get('session') ?? 'e2e-session';
const isLive = params.get('live') === '1';
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <SessionViewerPanel sessionId={sessionId} isLive={isLive} />
  </QueryClientProvider>,
);

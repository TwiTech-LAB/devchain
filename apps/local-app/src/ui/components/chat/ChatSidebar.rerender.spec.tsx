import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { ChatSidebar, type ChatSidebarProps } from './ChatSidebar';
import { packChatSidebarProps, makeFlatChatSidebarProps } from './ChatSidebar.test-helpers';

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

// Count how many times an AgentRow commits. Because the bundles feed AgentRow the
// same granular props as before, this count is the regression guard the phase DoD
// requires: stable bundles must not increase AgentRow renders vs. today.
let agentRowRenders = 0;
jest.mock('./AgentRow', () => ({
  AgentRow: () => {
    agentRowRenders += 1;
    return <div data-testid="agent-row" />;
  },
  AgentIdentity: () => <div data-testid="agent-identity" />,
}));

function renderSidebar(props: ChatSidebarProps) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (p: ChatSidebarProps): ReactElement => (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <ChatSidebar {...p} />
      </QueryClientProvider>
    </MemoryRouter>
  );
  const utils = render(wrap(props));
  return { ...utils, rerenderSidebar: (p: ChatSidebarProps) => utils.rerender(wrap(p)) };
}

describe('ChatSidebar referential stability', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    agentRowRenders = 0;
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ items: [], total: 0, limit: 50, offset: 0 }),
    })) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('skips re-render (and AgentRow re-render) when all three bundles keep their references', async () => {
    const bundles = packChatSidebarProps(makeFlatChatSidebarProps());
    const { rerenderSidebar } = renderSidebar(bundles);

    await waitFor(() => expect(agentRowRenders).toBeGreaterThan(0));
    const afterInitial = agentRowRenders;

    // Parent re-renders with the exact same bundle references — memo must bail out.
    rerenderSidebar(bundles);
    expect(agentRowRenders).toBe(afterInitial);
  });

  it('re-renders AgentRow when a bundle reference changes', async () => {
    const bundles = packChatSidebarProps(makeFlatChatSidebarProps());
    const { rerenderSidebar } = renderSidebar(bundles);
    await waitFor(() => expect(agentRowRenders).toBeGreaterThan(0));
    const afterInitial = agentRowRenders;

    // New `data` reference (same content) — memo can no longer bail out.
    rerenderSidebar({ ...bundles, data: { ...bundles.data } });
    expect(agentRowRenders).toBeGreaterThan(afterInitial);
  });
});

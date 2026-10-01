import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ProviderAuthGenerationView } from '@/ui/hooks/useProviderAuth';
import { GenerateLoginDialog } from './GenerateLoginDialog';

jest.mock('@/ui/hooks/use-toast', () => ({ useToast: () => ({ toast: jest.fn() }) }));
jest.mock('@/ui/components/terminal/ChatTerminal', () => ({
  ChatTerminal: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="terminal-stub">{sessionId}</div>
  ),
}));

const waiting: ProviderAuthGenerationView = {
  id: 'g1',
  provider: 'codex',
  sessionId: 's1',
  state: 'waiting',
  startedAt: '2026-09-24T00:00:00.000Z',
  finishedAt: null,
  entries: [],
  error: null,
};

let cancels: number;

beforeEach(() => {
  cancels = 0;
  global.fetch = jest.fn(async (url: string | undefined, init?: RequestInit) => {
    const target = String(url);
    const method = init?.method ?? 'GET';
    if (target === '/api/provider-auth/generate/g1/cancel') {
      cancels += 1;
      return { ok: true, json: async () => ({ ...waiting, state: 'cancelled' }) } as Response;
    }
    if (target === '/api/provider-auth/generate' && method === 'POST') {
      return { ok: true, status: 201, json: async () => waiting } as Response;
    }
    if (target === '/api/provider-auth/generate/g1') {
      return { ok: true, json: async () => waiting } as Response;
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;
});

function renderDialog(props: Partial<Parameters<typeof GenerateLoginDialog>[0]> = {}) {
  const onClose = jest.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <GenerateLoginDialog provider="codex" onClose={onClose} {...props} />
    </QueryClientProvider>,
  );
  return onClose;
}

describe('GenerateLoginDialog', () => {
  it("hides a claim's login on Escape without cancelling it", async () => {
    const onClose = renderDialog({ attach: waiting });
    await screen.findByTestId('terminal-stub');

    await userEvent.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalled();
    expect(cancels).toBe(0);
  });

  it("cancels a claim's login only through the explicit button", async () => {
    renderDialog({ attach: waiting });
    await screen.findByTestId('terminal-stub');

    await userEvent.click(screen.getByRole('button', { name: 'Cancel login' }));

    await waitFor(() => expect(cancels).toBe(1));
  });

  it('cancels a login it started when dismissed', async () => {
    renderDialog();
    await screen.findByTestId('terminal-stub');

    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(cancels).toBe(1));
  });
});

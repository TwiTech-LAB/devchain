import { StrictMode } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ProviderAuthGenerationView } from '@/ui/hooks/useProviderAuth';
import { GenerateLoginDialog } from './GenerateLoginDialog';

const mockToast = jest.fn();
jest.mock('@/ui/hooks/use-toast', () => ({ useToast: () => ({ toast: mockToast }) }));
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
let starts: number;
/** How the start answers: a new login, or the 409 that names the login already running. */
let startAnswer: 'new' | 'running';
/** While set, the start answers only after it settles. */
let startGate: Promise<void> | null;

beforeEach(() => {
  cancels = 0;
  starts = 0;
  startAnswer = 'new';
  startGate = null;
  mockToast.mockClear();
  global.fetch = jest.fn(async (url: string | undefined, init?: RequestInit) => {
    const target = String(url);
    const method = init?.method ?? 'GET';
    if (target === '/api/provider-auth/generate/g1/cancel') {
      cancels += 1;
      return { ok: true, json: async () => ({ ...waiting, state: 'cancelled' }) } as Response;
    }
    if (target === '/api/provider-auth/generate' && method === 'POST') {
      starts += 1;
      await startGate;
      if (startAnswer === 'running') {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            statusCode: 409,
            code: 'conflict',
            message: 'A codex login is already running.',
            details: { code: 'PROVIDER_AUTH_GENERATION_RUNNING', generationId: 'g1' },
          }),
        } as Response;
      }
      return { ok: true, status: 201, json: async () => waiting } as Response;
    }
    if (target === '/api/provider-auth/generate/g1') {
      return { ok: true, json: async () => waiting } as Response;
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;
});

function renderDialog(
  props: Partial<Parameters<typeof GenerateLoginDialog>[0]> = {},
  { strict = false }: { strict?: boolean } = {},
) {
  const onClose = jest.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const dialog = (
    <QueryClientProvider client={client}>
      <GenerateLoginDialog provider="codex" onClose={onClose} {...props} />
    </QueryClientProvider>
  );
  const { unmount } = render(strict ? <StrictMode>{dialog}</StrictMode> : dialog);
  return { onClose, unmount };
}

describe('GenerateLoginDialog', () => {
  it("hides a claim's login on Escape without cancelling it", async () => {
    const { onClose } = renderDialog({ attach: waiting });
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

  // Development builds render in StrictMode, which runs mount effects twice.
  it('starts one login under StrictMode and cancels it only on a real unmount', async () => {
    const { unmount } = renderDialog({}, { strict: true });
    await screen.findByTestId('terminal-stub');
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(starts).toBe(1);
    expect(cancels).toBe(0);

    unmount();

    await waitFor(() => expect(cancels).toBe(1));
  });

  it('cancels a login whose start answers after the dialog closed', async () => {
    let answer!: () => void;
    startGate = new Promise((resolve) => (answer = resolve));
    const { onClose } = renderDialog();
    await waitFor(() => expect(starts).toBe(1));

    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
    answer();

    await waitFor(() => expect(cancels).toBe(1));
    expect(screen.queryByTestId('terminal-stub')).not.toBeInTheDocument();
  });

  it('cancels a login it started when it unmounts without a close', async () => {
    const { unmount } = renderDialog();
    await screen.findByTestId('terminal-stub');

    unmount();

    await waitFor(() => expect(cancels).toBe(1));
  });

  it('shows the login already running instead of an error, and Escape only hides it', async () => {
    startAnswer = 'running';
    const { onClose } = renderDialog();

    expect(await screen.findByTestId('terminal-stub')).toHaveTextContent('s1');
    expect(screen.getByText(/A codex login was already running/)).toBeInTheDocument();
    expect(mockToast).not.toHaveBeenCalled();

    await userEvent.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalled();
    expect(cancels).toBe(0);
  });

  it('cancels the login already running through the explicit button', async () => {
    startAnswer = 'running';
    renderDialog();
    await screen.findByTestId('terminal-stub');

    await userEvent.click(screen.getByRole('button', { name: 'Cancel login' }));

    await waitFor(() => expect(cancels).toBe(1));
  });
});

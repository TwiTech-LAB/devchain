import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ProfilesPage } from './ProfilesPage';

const useSelectedProjectMock = jest.fn();

jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => useSelectedProjectMock(),
}));

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { Wrapper, queryClient };
}

describe('ProfilesPage persist prompt ordering', () => {
  const originalFetch = global.fetch;
  const fetchMock = jest.fn();

  beforeEach(() => {
    useSelectedProjectMock.mockReturnValue({
      selectedProjectId: 'project-1',
      selectedProject: { id: 'project-1', name: 'Demo' },
    });

    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method || 'GET').toUpperCase();

      if (url.startsWith('/api/profiles?projectId=project-1')) {
        return {
          ok: true,
          json: async () => ({ items: [], total: 0, limit: 0, offset: 0 }),
        } as Response;
      }

      if (url.startsWith('/api/providers')) {
        return {
          ok: true,
          json: async () => ({ items: [{ id: 'prov-1', name: 'codex', binPath: null }] }),
        } as Response;
      }

      if (url.startsWith('/api/prompts?projectId=project-1')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              { id: 'p1', title: 'First Prompt', content: '...' },
              { id: 'p2', title: 'Second Prompt', content: '...' },
            ],
            total: 2,
            limit: 1000,
            offset: 0,
          }),
        } as Response;
      }

      if (url === '/api/profiles' && method === 'POST') {
        return {
          ok: true,
          json: async () => ({ id: 'prof-1', name: 'X', providerId: 'prov-1' }),
        } as Response;
      }

      if (url === '/api/profiles/prof-1/prompts' && method === 'PUT') {
        return {
          ok: true,
          json: async () => ({ profileId: 'prof-1', prompts: [] }),
        } as Response;
      }

      return { ok: true, json: async () => ({}) } as Response;
    });

    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    fetchMock.mockReset();
  });

  it('calls prompts replace endpoint after creating a profile with ordered prompts', async () => {
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <ProfilesPage />
        </Wrapper>,
      );
    });

    const createButton = await screen.findByRole('button', { name: /create profile/i });
    await act(async () => {
      fireEvent.click(createButton);
    });

    // Fill required fields
    const nameInput = screen.getByLabelText(/name \*/i) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Runner' } });
    const providerSelect = screen.getByLabelText(/provider \*/i) as HTMLSelectElement;
    fireEvent.change(providerSelect, { target: { value: 'prov-1' } });

    // Add two prompts
    await screen.findByText('Add Prompts');
    fireEvent.click(screen.getByText('First Prompt'));
    fireEvent.click(screen.getByText('Second Prompt'));

    const submitBtn = screen.getByRole('button', { name: /^create$/i });
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    // Assert replace endpoint called with ordered promptIds
    const calls = fetchMock.mock.calls.map(([u, init]) => ({
      url: typeof u === 'string' ? u : u.toString(),
      method: (init?.method || 'GET').toUpperCase(),
      body: init?.body as string | undefined,
    }));
    const replaceCall = calls.find(
      (c) => c.url === '/api/profiles/prof-1/prompts' && c.method === 'PUT',
    );
    expect(replaceCall).toBeTruthy();
    const parsed = JSON.parse(replaceCall!.body || '{}');
    expect(parsed.promptIds).toEqual(['p1', 'p2']);
  });
});

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { PromptsPage } from './PromptsPage';
const useSelectedProjectMock = jest.fn();

const toastSpy = jest.fn();

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastSpy }),
}));

jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => useSelectedProjectMock(),
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  return { Wrapper, queryClient };
}

describe('PromptsPage variable helper', () => {
  const originalFetch = global.fetch;
  const fetchMock = jest.fn();

  beforeEach(() => {
    useSelectedProjectMock.mockReturnValue({
      selectedProjectId: 'project-1',
      selectedProject: { id: 'project-1', name: 'Demo' },
    });
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.startsWith('/api/prompts?projectId=project-1')) {
        return {
          ok: true,
          json: async () => ({ items: [], total: 0, limit: 0, offset: 0 }),
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({}),
      } as Response;
    });

    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    fetchMock.mockReset();
    toastSpy.mockReset();
  });

  it('displays the available variables helper panel in the prompt dialog', async () => {
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <PromptsPage />
        </Wrapper>,
      );
    });

    const createButton = await screen.findByRole('button', { name: /create prompt/i });
    await act(async () => {
      fireEvent.click(createButton);
    });

    expect(await screen.findByText('Available Variables')).toBeInTheDocument();
    expect(screen.getByText('{agent_name}')).toBeInTheDocument();
    expect(screen.getByText('{project_name}')).toBeInTheDocument();
    expect(screen.getByText('{epic_title}')).toBeInTheDocument();
    expect(screen.getByText('{provider_name}')).toBeInTheDocument();
    expect(screen.getByText('{profile_name}')).toBeInTheDocument();
    expect(screen.getByText('{session_id}')).toBeInTheDocument();
    expect(screen.getByText('{session_id_short}')).toBeInTheDocument();
  });
});

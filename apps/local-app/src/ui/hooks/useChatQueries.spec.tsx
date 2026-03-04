import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useChatQueries, type UseChatQueriesOptions } from './useChatQueries';

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

jest.mock('@/ui/lib/sessions', () => ({
  fetchAgentPresence: jest.fn().mockResolvedValue({}),
  fetchActiveSessions: jest.fn().mockResolvedValue([]),
}));

jest.mock('@/ui/lib/preflight', () => ({
  fetchPreflightChecks: jest.fn().mockResolvedValue({}),
}));

jest.mock('@/ui/lib/chat', () => ({
  fetchThreads: jest.fn().mockResolvedValue({
    items: [],
    total: 0,
    limit: 50,
    offset: 0,
  }),
  createGroupThread: jest.fn(),
  fetchMessages: jest.fn().mockResolvedValue({
    items: [],
    total: 0,
    limit: 50,
    offset: 0,
  }),
  createMessage: jest.fn(),
  inviteMembers: jest.fn(),
  clearHistory: jest.fn(),
  purgeHistory: jest.fn(),
}));

import { fetchMessages } from '@/ui/lib/chat';

const mockFetchMessages = fetchMessages as jest.MockedFunction<typeof fetchMessages>;

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  return { wrapper, queryClient };
}

function asRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  if (typeof URL !== 'undefined' && input instanceof URL) {
    return input.toString();
  }
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return input.url;
  }
  return String(input);
}

function buildOptions(overrides: Partial<UseChatQueriesOptions> = {}): UseChatQueriesOptions {
  return {
    projectId: 'project-main',
    selectedThreadId: null,
    projectRootPath: undefined,
    ...overrides,
  };
}

describe('useChatQueries', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();

    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = asRequestUrl(input);

      if (url.startsWith('/api/agents')) {
        return {
          ok: true,
          json: async () => [],
        } as Response;
      }

      if (url.startsWith('/api/profiles')) {
        return {
          ok: true,
          json: async () => [],
        } as Response;
      }

      if (url === '/api/providers') {
        return {
          ok: true,
          json: async () => [],
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({}),
      } as Response;
    });

    global.fetch = fetchMock as unknown as typeof fetch;
    window.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
      window.fetch = originalFetch;
    } else {
      delete (global as unknown as { fetch?: unknown }).fetch;
      delete (window as unknown as { fetch?: unknown }).fetch;
    }
  });

  it('does not fetch messages during project transition when thread id is stale', async () => {
    const { wrapper } = createWrapper();

    const { rerender } = renderHook((options: UseChatQueriesOptions) => useChatQueries(options), {
      initialProps: buildOptions({
        projectId: 'project-main',
        selectedThreadId: 'thread-main-1',
      }),
      wrapper,
    });

    await waitFor(() => {
      expect(mockFetchMessages).toHaveBeenCalledWith('thread-main-1', 'project-main');
    });

    mockFetchMessages.mockClear();

    rerender(
      buildOptions({
        projectId: 'project-worktree',
        selectedThreadId: 'thread-main-1',
      }),
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockFetchMessages).not.toHaveBeenCalled();
  });

  it('keeps normal message fetching behavior when project does not change', async () => {
    const { wrapper } = createWrapper();

    const { rerender } = renderHook((options: UseChatQueriesOptions) => useChatQueries(options), {
      initialProps: buildOptions({
        projectId: 'project-main',
        selectedThreadId: 'thread-main-1',
      }),
      wrapper,
    });

    await waitFor(() => {
      expect(mockFetchMessages).toHaveBeenCalledWith('thread-main-1', 'project-main');
    });

    mockFetchMessages.mockClear();

    rerender(
      buildOptions({
        projectId: 'project-main',
        selectedThreadId: 'thread-main-2',
      }),
    );

    await waitFor(() => {
      expect(mockFetchMessages).toHaveBeenCalledWith('thread-main-2', 'project-main');
    });
  });
});

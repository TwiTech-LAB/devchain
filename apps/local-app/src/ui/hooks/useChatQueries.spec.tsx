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
  fetchThread: jest.fn(),
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

import { fetchMessages, fetchThread, fetchThreads } from '@/ui/lib/chat';

const mockFetchMessages = fetchMessages as jest.MockedFunction<typeof fetchMessages>;
const mockFetchThread = fetchThread as jest.MockedFunction<typeof fetchThread>;
const mockFetchThreads = fetchThreads as jest.MockedFunction<typeof fetchThreads>;

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
    mockFetchThreads.mockResolvedValue({
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
    });
    mockFetchThread.mockResolvedValue({
      id: 'thread-main-1',
      projectId: 'project-main',
      title: 'Thread Main',
      isGroup: false,
      createdByType: 'user',
      createdByUserId: 'user-1',
      createdByAgentId: null,
      members: ['agent-1'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

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
      expect(mockFetchMessages).toHaveBeenCalledWith(
        'thread-main-1',
        'project-main',
        undefined,
        undefined,
        undefined,
        expect.any(Function),
      );
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
      expect(mockFetchMessages).toHaveBeenCalledWith(
        'thread-main-1',
        'project-main',
        undefined,
        undefined,
        undefined,
        expect.any(Function),
      );
    });

    mockFetchMessages.mockClear();

    rerender(
      buildOptions({
        projectId: 'project-main',
        selectedThreadId: 'thread-main-2',
      }),
    );

    await waitFor(() => {
      expect(mockFetchMessages).toHaveBeenCalledWith(
        'thread-main-2',
        'project-main',
        undefined,
        undefined,
        undefined,
        expect.any(Function),
      );
    });
  });

  it('merges selected URL thread when it is outside the paginated thread lists', async () => {
    mockFetchThread.mockResolvedValue({
      id: 'thread-outside-page',
      projectId: 'project-main',
      title: 'Old Direct Thread',
      isGroup: false,
      createdByType: 'user',
      createdByUserId: 'user-1',
      createdByAgentId: null,
      members: ['agent-1'],
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:00:00.000Z',
    });

    const { wrapper } = createWrapper();

    const { result } = renderHook((options: UseChatQueriesOptions) => useChatQueries(options), {
      initialProps: buildOptions({
        selectedThreadId: 'thread-outside-page',
      }),
      wrapper,
    });

    await waitFor(() => {
      expect(mockFetchThread).toHaveBeenCalledWith(
        'thread-outside-page',
        'project-main',
        expect.any(Function),
      );
    });

    await waitFor(() => {
      expect(result.current.allThreads).toEqual([
        expect.objectContaining({ id: 'thread-outside-page', title: 'Old Direct Thread' }),
      ]);
    });
    expect(result.current.userThreads[0]).toEqual(
      expect.objectContaining({ id: 'thread-outside-page' }),
    );
  });

  it('prefers listed thread metadata when selected thread is already in paginated lists', async () => {
    mockFetchThread.mockResolvedValue({
      id: 'thread-main-1',
      projectId: 'project-main',
      title: 'Older Direct Copy',
      isGroup: false,
      createdByType: 'user',
      createdByUserId: 'user-1',
      createdByAgentId: null,
      members: ['agent-old'],
      createdAt: '2026-04-29T00:00:00.000Z',
      updatedAt: '2026-04-29T00:00:00.000Z',
    });
    mockFetchThreads.mockImplementation(async (_projectId, createdByType) => {
      if (createdByType === 'user') {
        return {
          items: [
            {
              id: 'thread-main-1',
              projectId: 'project-main',
              title: 'Newer Listed Copy',
              isGroup: false,
              createdByType: 'user',
              createdByUserId: 'user-1',
              createdByAgentId: null,
              members: ['agent-new'],
              createdAt: '2026-04-30T00:00:00.000Z',
              updatedAt: '2026-05-01T00:00:00.000Z',
            },
          ],
          total: 1,
          limit: 50,
          offset: 0,
        };
      }

      return {
        items: [],
        total: 0,
        limit: 50,
        offset: 0,
      };
    });

    const { wrapper } = createWrapper();

    const { result } = renderHook((options: UseChatQueriesOptions) => useChatQueries(options), {
      initialProps: buildOptions({
        selectedThreadId: 'thread-main-1',
      }),
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.allThreads[0]).toEqual(
        expect.objectContaining({
          id: 'thread-main-1',
          title: 'Newer Listed Copy',
          members: ['agent-new'],
        }),
      );
    });
    expect(result.current.allThreads).toHaveLength(1);
  });

  it('keeps selected system thread metadata available without adding it to sidebar lists', async () => {
    mockFetchThread.mockResolvedValue({
      id: 'thread-system',
      projectId: 'project-main',
      title: 'System Conversation',
      isGroup: false,
      createdByType: 'system',
      createdByUserId: null,
      createdByAgentId: null,
      members: ['agent-1'],
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:00:00.000Z',
    });

    const { wrapper } = createWrapper();

    const { result } = renderHook((options: UseChatQueriesOptions) => useChatQueries(options), {
      initialProps: buildOptions({
        selectedThreadId: 'thread-system',
      }),
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.allThreads).toEqual([
        expect.objectContaining({
          id: 'thread-system',
          title: 'System Conversation',
          createdByType: 'system',
        }),
      ]);
    });
    expect(result.current.userThreads).toEqual([]);
    expect(result.current.agentThreads).toEqual([]);
  });
});

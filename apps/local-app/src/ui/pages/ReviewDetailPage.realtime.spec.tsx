import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { act, render, screen, waitFor } from '@testing-library/react';

// Mock refractor (ESM module that Jest can't transform) - must be before imports that use it
jest.mock('refractor', () => ({
  refractor: {
    registered: jest.fn(() => false),
    highlight: jest.fn(),
  },
}));

// Mock react-diff-view CSS import
jest.mock('react-diff-view/style/index.css', () => ({}));

import { ReviewDetailPage } from './ReviewDetailPage';

// Mock ResizeObserver
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Minimal socket mock to capture handlers and trigger messages
interface MockSocket {
  on: jest.Mock;
  off: jest.Mock;
  emit: jest.Mock;
  disconnect: jest.Mock;
}
const handlers: Record<string, ((...args: unknown[]) => unknown)[]> = {};
const mockSocket: MockSocket = {
  on: jest.fn(),
  off: jest.fn(),
  emit: jest.fn(),
  disconnect: jest.fn(),
};
mockSocket.on.mockImplementation((event: string, cb: (...args: unknown[]) => unknown) => {
  handlers[event] = handlers[event] || [];
  handlers[event].push(cb);
  return mockSocket;
});
mockSocket.off.mockImplementation((event: string, cb: (...args: unknown[]) => unknown) => {
  if (!handlers[event]) return mockSocket;
  handlers[event] = handlers[event].filter((fn) => fn !== cb);
  return mockSocket;
});

// Aliases for test assertions
const { on, off, disconnect } = mockSocket;

jest.mock('socket.io-client', () => ({
  io: () => mockSocket,
}));

const mockReview = {
  id: 'review-1',
  projectId: 'project-1',
  title: 'Test Review',
  status: 'pending',
  baseSha: 'abc123',
  headSha: 'def456',
  baseRef: 'main',
  headRef: 'feature/test',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  version: 1,
};

function createWrapper(reviewId: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter initialEntries={[`/reviews/${reviewId}`]}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route path="/reviews/:reviewId" element={children} />
          <Route path="/reviews" element={<div>Reviews List</div>} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
  return { Wrapper, queryClient };
}

describe('ReviewDetailPage realtime subscription', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    // Clear handlers between tests
    Object.keys(handlers).forEach((key) => delete handlers[key]);
    jest.clearAllMocks();

    // Basic fetch stubs
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/reviews/review-1')) {
        return { ok: true, json: async () => mockReview } as Response;
      }
      if (url.includes('/api/reviews') && url.includes('comments')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      if (url.includes('/api/git/diff')) {
        return { ok: true, json: async () => '' } as Response;
      }
      if (url.includes('/api/git/changed-files')) {
        return { ok: true, json: async () => [] } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    }
  });

  it('invalidates comments query on comment.created event', async () => {
    const { Wrapper, queryClient } = createWrapper('review-1');
    const spy = jest.spyOn(queryClient, 'invalidateQueries');

    render(<ReviewDetailPage />, { wrapper: Wrapper });

    // Wait for review to load (review title indicates data is loaded and projectId is available)
    await waitFor(() => {
      expect(screen.getByText('Test Review')).toBeInTheDocument();
    });

    // Wait a tick for useAppSocket to rebind with the new projectId
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    // Trigger comment.created envelope
    await act(async () => {
      handlers['message']?.forEach((fn) =>
        fn({
          topic: 'review/review-1',
          type: 'comment.created',
          payload: { commentId: 'comment-1', reviewId: 'review-1' },
          ts: new Date().toISOString(),
        }),
      );
    });

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith({ queryKey: ['review-comments', 'review-1'] });
    });
  });

  it('invalidates comments query on comment.resolved event', async () => {
    const { Wrapper, queryClient } = createWrapper('review-1');
    const spy = jest.spyOn(queryClient, 'invalidateQueries');

    render(<ReviewDetailPage />, { wrapper: Wrapper });

    // Wait for review to load
    await waitFor(() => {
      expect(screen.getByText('Test Review')).toBeInTheDocument();
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    // Trigger comment.resolved envelope
    await act(async () => {
      handlers['message']?.forEach((fn) =>
        fn({
          topic: 'review/review-1',
          type: 'comment.resolved',
          payload: { commentId: 'comment-1', reviewId: 'review-1', status: 'resolved', version: 2 },
          ts: new Date().toISOString(),
        }),
      );
    });

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith({ queryKey: ['review-comments', 'review-1'] });
    });
  });

  it('invalidates review query on review.updated event', async () => {
    const { Wrapper, queryClient } = createWrapper('review-1');
    const spy = jest.spyOn(queryClient, 'invalidateQueries');

    render(<ReviewDetailPage />, { wrapper: Wrapper });

    // Wait for review to load
    await waitFor(() => {
      expect(screen.getByText('Test Review')).toBeInTheDocument();
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    // Trigger review.updated envelope
    await act(async () => {
      handlers['message']?.forEach((fn) =>
        fn({
          topic: 'review/review-1',
          type: 'review.updated',
          payload: {
            reviewId: 'review-1',
            version: 2,
            title: 'Updated Title',
            changes: { status: { previous: 'pending', current: 'approved' } },
          },
          ts: new Date().toISOString(),
        }),
      );
    });

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith({ queryKey: ['review', 'review-1'] });
    });
  });

  it('invalidates project reviews on project-level events', async () => {
    const { Wrapper, queryClient } = createWrapper('review-1');
    const spy = jest.spyOn(queryClient, 'invalidateQueries');

    render(<ReviewDetailPage />, { wrapper: Wrapper });

    // Wait for review to load
    await waitFor(() => {
      expect(screen.getByText('Test Review')).toBeInTheDocument();
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    // Trigger project-level comment.created envelope
    await act(async () => {
      handlers['message']?.forEach((fn) =>
        fn({
          topic: 'project/project-1/reviews',
          type: 'comment.created',
          payload: { reviewId: 'review-1', commentId: 'comment-1' },
          ts: new Date().toISOString(),
        }),
      );
    });

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith({ queryKey: ['reviews', 'project-1'] });
    });
  });

  it('cleans up message listener on unmount without disconnecting socket', async () => {
    const { Wrapper } = createWrapper('review-1');
    const { unmount } = render(<ReviewDetailPage />, { wrapper: Wrapper });

    // Ensure an on(message) registration happened
    await waitFor(() => {
      expect(on).toHaveBeenCalledWith('message', expect.any(Function));
    });

    unmount();

    // Verify off(message) was called during cleanup
    expect(off).toHaveBeenCalledWith('message', expect.any(Function));
    // Shared socket should not be disconnected by ReviewDetailPage cleanup
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('ignores events for other reviews', async () => {
    const { Wrapper, queryClient } = createWrapper('review-1');
    const spy = jest.spyOn(queryClient, 'invalidateQueries');

    render(<ReviewDetailPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(handlers['message']).toBeDefined();
    });

    // Trigger event for a different review
    await act(async () => {
      handlers['message']?.forEach((fn) =>
        fn({
          topic: 'review/review-other',
          type: 'comment.created',
          payload: { commentId: 'comment-1', reviewId: 'review-other' },
          ts: new Date().toISOString(),
        }),
      );
    });

    // Should not invalidate for review-1
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(spy).not.toHaveBeenCalledWith({ queryKey: ['review-comments', 'review-1'] });
  });
});

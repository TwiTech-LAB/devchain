import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor, act } from '@testing-library/react';
import {
  useCreateComment,
  useReplyToComment,
  useResolveComment,
  useDeleteComment,
} from './useCommentMutations';
import type { ReviewComment } from '@/ui/lib/reviews';

// Mock toast
jest.mock('@/ui/hooks/use-toast', () => ({
  toast: jest.fn(),
}));

import { toast } from '@/ui/hooks/use-toast';

const mockComment: ReviewComment = {
  id: 'comment-1',
  reviewId: 'review-1',
  filePath: 'src/test.ts',
  parentId: null,
  lineStart: 10,
  lineEnd: 15,
  side: 'new',
  content: 'Test comment',
  commentType: 'issue',
  status: 'open',
  authorType: 'user',
  authorAgentId: null,
  version: 1,
  editedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function createWrapper(initialItems: ReviewComment[] = [mockComment]) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  // Pre-populate with initial comments
  queryClient.setQueryData(['review-comments', 'review-1'], {
    items: initialItems,
    total: initialItems.length,
    limit: 100,
    offset: 0,
  });

  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  return { Wrapper, queryClient };
}

describe('useCreateComment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('optimistically adds comment to cache', async () => {
    const { Wrapper, queryClient } = createWrapper();
    global.fetch = jest.fn(() => new Promise(() => {})); // Never resolves

    const { result } = renderHook(() => useCreateComment(), { wrapper: Wrapper });

    act(() => {
      result.current.mutate({
        reviewId: 'review-1',
        content: 'New optimistic comment',
        commentType: 'comment',
        filePath: 'src/test.ts',
        lineStart: 20,
        lineEnd: 20,
        side: 'new',
      });
    });

    // Wait for mutation to be pending (onMutate has run)
    await waitFor(() => {
      expect(result.current.isPending).toBe(true);
    });

    // Check cache was updated optimistically
    const data = queryClient.getQueryData<{ items: ReviewComment[] }>([
      'review-comments',
      'review-1',
    ]);
    expect(data?.items).toHaveLength(2);
    expect(data?.items[0].content).toBe('New optimistic comment');
    expect(data?.items[0].id).toMatch(/^temp-/);
  });

  it('rolls back on error and shows toast', async () => {
    const { Wrapper, queryClient } = createWrapper();
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    const { result } = renderHook(() => useCreateComment(), { wrapper: Wrapper });

    await act(async () => {
      try {
        await result.current.mutateAsync({
          reviewId: 'review-1',
          content: 'Will fail',
          commentType: 'comment',
          filePath: 'src/test.ts',
          lineStart: 20,
          lineEnd: 20,
          side: 'new',
        });
      } catch {
        // Expected to fail
      }
    });

    // Check cache was rolled back
    const data = queryClient.getQueryData<{ items: ReviewComment[] }>([
      'review-comments',
      'review-1',
    ]);
    expect(data?.items).toHaveLength(1);
    expect(data?.items[0].id).toBe('comment-1');

    // Check toast was shown
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Failed to create comment',
        variant: 'destructive',
      }),
    );
  });

  it('invalidates queries on success', async () => {
    const { Wrapper, queryClient } = createWrapper();
    const newComment = { ...mockComment, id: 'new-comment', content: 'Success' };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => newComment,
    });

    const spy = jest.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useCreateComment(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        reviewId: 'review-1',
        content: 'Success',
        commentType: 'comment',
        filePath: 'src/test.ts',
        lineStart: 20,
        lineEnd: 20,
        side: 'new',
      });
    });

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith({ queryKey: ['review-comments', 'review-1'] });
    });
  });
});

describe('useReplyToComment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('optimistically adds reply to cache', async () => {
    const { Wrapper, queryClient } = createWrapper();
    global.fetch = jest.fn(() => new Promise(() => {})); // Never resolves

    const { result } = renderHook(() => useReplyToComment(), { wrapper: Wrapper });

    act(() => {
      result.current.mutate({
        reviewId: 'review-1',
        parentId: 'comment-1',
        content: 'Reply content',
      });
    });

    // Wait for mutation to be pending (onMutate has run)
    await waitFor(() => {
      expect(result.current.isPending).toBe(true);
    });

    // Check cache was updated optimistically
    const data = queryClient.getQueryData<{ items: ReviewComment[] }>([
      'review-comments',
      'review-1',
    ]);
    expect(data?.items).toHaveLength(2);
    const reply = data?.items.find((c) => c.parentId === 'comment-1');
    expect(reply?.content).toBe('Reply content');
  });

  it('rolls back on error and shows toast', async () => {
    const { Wrapper, queryClient } = createWrapper();
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    const { result } = renderHook(() => useReplyToComment(), { wrapper: Wrapper });

    await act(async () => {
      try {
        await result.current.mutateAsync({
          reviewId: 'review-1',
          parentId: 'comment-1',
          content: 'Will fail',
        });
      } catch {
        // Expected to fail
      }
    });

    // Check cache was rolled back
    const data = queryClient.getQueryData<{ items: ReviewComment[] }>([
      'review-comments',
      'review-1',
    ]);
    expect(data?.items).toHaveLength(1);

    // Check toast was shown
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Failed to post reply',
        variant: 'destructive',
      }),
    );
  });

  it('includes targetAgentIds in POST body when provided', async () => {
    const { Wrapper } = createWrapper();
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ...mockComment, id: 'reply-1', parentId: 'comment-1' }),
    });
    global.fetch = mockFetch;

    const { result } = renderHook(() => useReplyToComment(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        reviewId: 'review-1',
        parentId: 'comment-1',
        content: 'Reply with targets',
        targetAgentIds: ['agent-1', 'agent-2'],
      });
    });

    // Verify fetch was called with correct body including targetAgentIds
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/reviews/review-1/comments',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          parentId: 'comment-1',
          content: 'Reply with targets',
          commentType: 'comment',
          targetAgentIds: ['agent-1', 'agent-2'],
        }),
      }),
    );
  });

  it('omits targetAgentIds from POST body when not provided', async () => {
    const { Wrapper } = createWrapper();
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ...mockComment, id: 'reply-1', parentId: 'comment-1' }),
    });
    global.fetch = mockFetch;

    const { result } = renderHook(() => useReplyToComment(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        reviewId: 'review-1',
        parentId: 'comment-1',
        content: 'Reply without targets',
        // No targetAgentIds provided
      });
    });

    // Verify fetch was called with body where targetAgentIds is undefined
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/reviews/review-1/comments',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          parentId: 'comment-1',
          content: 'Reply without targets',
          commentType: 'comment',
          targetAgentIds: undefined,
        }),
      }),
    );
  });
});

describe('useResolveComment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('optimistically updates comment status', async () => {
    const { Wrapper, queryClient } = createWrapper();
    global.fetch = jest.fn(() => new Promise(() => {})); // Never resolves

    const { result } = renderHook(() => useResolveComment(), { wrapper: Wrapper });

    act(() => {
      result.current.mutate({
        reviewId: 'review-1',
        commentId: 'comment-1',
        status: 'resolved',
        version: 1,
      });
    });

    // Wait for mutation to be pending (onMutate has run)
    await waitFor(() => {
      expect(result.current.isPending).toBe(true);
    });

    // Check cache was updated optimistically
    const data = queryClient.getQueryData<{ items: ReviewComment[] }>([
      'review-comments',
      'review-1',
    ]);
    expect(data?.items[0].status).toBe('resolved');
    expect(data?.items[0].version).toBe(2);
  });

  it('rolls back on error and shows toast', async () => {
    const { Wrapper, queryClient } = createWrapper();
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    const { result } = renderHook(() => useResolveComment(), { wrapper: Wrapper });

    await act(async () => {
      try {
        await result.current.mutateAsync({
          reviewId: 'review-1',
          commentId: 'comment-1',
          status: 'resolved',
          version: 1,
        });
      } catch {
        // Expected to fail
      }
    });

    // Check cache was rolled back
    const data = queryClient.getQueryData<{ items: ReviewComment[] }>([
      'review-comments',
      'review-1',
    ]);
    expect(data?.items[0].status).toBe('open');

    // Check toast was shown
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Failed to resolve comment',
        variant: 'destructive',
      }),
    );
  });

  it('handles wont_fix status', async () => {
    const { Wrapper, queryClient } = createWrapper();
    global.fetch = jest.fn(() => new Promise(() => {})); // Never resolves

    const { result } = renderHook(() => useResolveComment(), { wrapper: Wrapper });

    act(() => {
      result.current.mutate({
        reviewId: 'review-1',
        commentId: 'comment-1',
        status: 'wont_fix',
        version: 1,
      });
    });

    // Wait for mutation to be pending (onMutate has run)
    await waitFor(() => {
      expect(result.current.isPending).toBe(true);
    });

    // Check cache was updated optimistically
    const data = queryClient.getQueryData<{ items: ReviewComment[] }>([
      'review-comments',
      'review-1',
    ]);
    expect(data?.items[0].status).toBe('wont_fix');
  });
});

describe('useDeleteComment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('optimistically removes deleted comment and all descendants', async () => {
    const root: ReviewComment = { ...mockComment, id: 'root', parentId: null };
    const reply: ReviewComment = { ...mockComment, id: 'reply', parentId: 'root' };
    const grandchild: ReviewComment = { ...mockComment, id: 'grandchild', parentId: 'reply' };
    const { Wrapper, queryClient } = createWrapper([root, reply, grandchild]);
    global.fetch = jest.fn(() => new Promise(() => {})); // Never resolves

    const { result } = renderHook(() => useDeleteComment(), { wrapper: Wrapper });

    act(() => {
      result.current.mutate({ reviewId: 'review-1', commentId: 'root' });
    });

    await waitFor(() => {
      expect(result.current.isPending).toBe(true);
    });

    const data = queryClient.getQueryData<{ items: ReviewComment[] }>([
      'review-comments',
      'review-1',
    ]);
    expect(data?.items).toHaveLength(0);
  });

  it('rolls back on error and shows toast', async () => {
    const root: ReviewComment = { ...mockComment, id: 'root', parentId: null };
    const reply: ReviewComment = { ...mockComment, id: 'reply', parentId: 'root' };
    const { Wrapper, queryClient } = createWrapper([root, reply]);
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    const { result } = renderHook(() => useDeleteComment(), { wrapper: Wrapper });

    await act(async () => {
      try {
        await result.current.mutateAsync({ reviewId: 'review-1', commentId: 'root' });
      } catch {
        // Expected to fail
      }
    });

    const data = queryClient.getQueryData<{ items: ReviewComment[] }>([
      'review-comments',
      'review-1',
    ]);
    expect(data?.items).toHaveLength(2);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Failed to delete comment',
        variant: 'destructive',
      }),
    );
  });
});

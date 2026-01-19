import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from '@/ui/hooks/use-toast';
import type { ReviewComment, CommentType } from '@/ui/lib/reviews';

interface CommentsQueryData {
  items: ReviewComment[];
  total: number;
  limit: number;
  offset: number;
}

interface CreateCommentParams {
  reviewId: string;
  content: string;
  commentType: CommentType;
  filePath: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  side: 'old' | 'new' | null;
  targetAgentIds?: string[];
}

interface ReplyParams {
  reviewId: string;
  parentId: string;
  content: string;
  /** Optional target agents - if not provided, server defaults to parent's targets or author */
  targetAgentIds?: string[];
}

interface ResolveParams {
  reviewId: string;
  commentId: string;
  status: 'resolved' | 'wont_fix';
  version: number;
}

interface DeleteParams {
  reviewId: string;
  commentId: string;
}

interface EditParams {
  reviewId: string;
  commentId: string;
  content: string;
  version: number;
}

/**
 * Hook for creating new comments with optimistic updates
 */
export function useCreateComment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: CreateCommentParams) => {
      const response = await fetch(`/api/reviews/${params.reviewId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: params.content,
          commentType: params.commentType,
          filePath: params.filePath,
          lineStart: params.lineStart,
          lineEnd: params.lineEnd,
          side: params.side,
          targetAgentIds: params.targetAgentIds,
        }),
      });
      if (!response.ok) throw new Error('Failed to create comment');
      return response.json() as Promise<ReviewComment>;
    },

    onMutate: async (params) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: ['review-comments', params.reviewId] });

      // Snapshot the previous value
      const previousComments = queryClient.getQueryData<CommentsQueryData>([
        'review-comments',
        params.reviewId,
      ]);

      // Create an optimistic comment (uses API convention: 'old'/'new' for side)
      const optimisticComment: ReviewComment = {
        id: `temp-${Date.now()}`,
        reviewId: params.reviewId,
        filePath: params.filePath,
        parentId: null,
        lineStart: params.lineStart,
        lineEnd: params.lineEnd,
        side: params.side,
        content: params.content,
        commentType: params.commentType,
        status: 'open',
        authorType: 'user',
        authorAgentId: null,
        authorAgentName: null,
        targetAgents: [],
        version: 1,
        editedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // Optimistically update to the new value
      queryClient.setQueryData<CommentsQueryData>(['review-comments', params.reviewId], (old) => {
        if (!old) return { items: [optimisticComment], total: 1, limit: 100, offset: 0 };
        return {
          ...old,
          items: [optimisticComment, ...old.items],
          total: old.total + 1,
        };
      });

      // Return context for potential rollback
      return { previousComments };
    },

    onError: (_error, params, context) => {
      // Rollback on error
      if (context?.previousComments) {
        queryClient.setQueryData(['review-comments', params.reviewId], context.previousComments);
      }
      toast({
        title: 'Failed to create comment',
        description: 'Your comment could not be posted. Please try again.',
        variant: 'destructive',
      });
    },

    onSettled: (_data, _error, params) => {
      // Always refetch to ensure we have the correct data
      queryClient.invalidateQueries({ queryKey: ['review-comments', params.reviewId] });
    },
  });
}

/**
 * Hook for replying to comments with optimistic updates
 */
export function useReplyToComment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: ReplyParams) => {
      const response = await fetch(`/api/reviews/${params.reviewId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parentId: params.parentId,
          content: params.content,
          commentType: 'comment',
          targetAgentIds: params.targetAgentIds,
        }),
      });
      if (!response.ok) throw new Error('Failed to post reply');
      return response.json() as Promise<ReviewComment>;
    },

    onMutate: async (params) => {
      await queryClient.cancelQueries({ queryKey: ['review-comments', params.reviewId] });

      const previousComments = queryClient.getQueryData<CommentsQueryData>([
        'review-comments',
        params.reviewId,
      ]);

      // Find the parent comment to copy its file/line info
      const parentComment = previousComments?.items.find((c) => c.id === params.parentId);

      const optimisticReply: ReviewComment = {
        id: `temp-${Date.now()}`,
        reviewId: params.reviewId,
        filePath: parentComment?.filePath ?? null,
        parentId: params.parentId,
        lineStart: parentComment?.lineStart ?? null,
        lineEnd: parentComment?.lineEnd ?? null,
        side: parentComment?.side ?? null,
        content: params.content,
        commentType: 'comment',
        status: 'open',
        authorType: 'user',
        authorAgentId: null,
        authorAgentName: null,
        targetAgents: [],
        version: 1,
        editedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      queryClient.setQueryData<CommentsQueryData>(['review-comments', params.reviewId], (old) => {
        if (!old) return { items: [optimisticReply], total: 1, limit: 100, offset: 0 };
        return {
          ...old,
          items: [...old.items, optimisticReply],
          total: old.total + 1,
        };
      });

      return { previousComments };
    },

    onError: (_error, params, context) => {
      if (context?.previousComments) {
        queryClient.setQueryData(['review-comments', params.reviewId], context.previousComments);
      }
      toast({
        title: 'Failed to post reply',
        description: 'Your reply could not be posted. Please try again.',
        variant: 'destructive',
      });
    },

    onSettled: (_data, _error, params) => {
      queryClient.invalidateQueries({ queryKey: ['review-comments', params.reviewId] });
    },
  });
}

/**
 * Hook for resolving comments with optimistic updates
 */
export function useResolveComment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: ResolveParams) => {
      const response = await fetch(
        `/api/reviews/${params.reviewId}/comments/${params.commentId}/resolve`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: params.status, version: params.version }),
        },
      );
      if (!response.ok) throw new Error('Failed to resolve comment');
      return response.json() as Promise<ReviewComment>;
    },

    onMutate: async (params) => {
      await queryClient.cancelQueries({ queryKey: ['review-comments', params.reviewId] });

      const previousComments = queryClient.getQueryData<CommentsQueryData>([
        'review-comments',
        params.reviewId,
      ]);

      // Optimistically update the comment status
      queryClient.setQueryData<CommentsQueryData>(['review-comments', params.reviewId], (old) => {
        if (!old) return old;
        return {
          ...old,
          items: old.items.map((comment) =>
            comment.id === params.commentId
              ? { ...comment, status: params.status, version: params.version + 1 }
              : comment,
          ),
        };
      });

      return { previousComments };
    },

    onError: (_error, params, context) => {
      if (context?.previousComments) {
        queryClient.setQueryData(['review-comments', params.reviewId], context.previousComments);
      }
      toast({
        title: 'Failed to resolve comment',
        description: 'The comment could not be resolved. Please try again.',
        variant: 'destructive',
      });
    },

    onSettled: (_data, _error, params) => {
      queryClient.invalidateQueries({ queryKey: ['review-comments', params.reviewId] });
    },
  });
}

/**
 * Hook for deleting comments with optimistic updates.
 *
 * Optimistically removes the deleted comment and any descendant replies.
 * (The current UI only supports single-level replies, but agents/API can create deeper threads.)
 */
export function useDeleteComment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: DeleteParams) => {
      const response = await fetch(`/api/reviews/${params.reviewId}/comments/${params.commentId}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error('Failed to delete comment');
    },

    onMutate: async (params) => {
      await queryClient.cancelQueries({ queryKey: ['review-comments', params.reviewId] });

      const previousComments = queryClient.getQueryData<CommentsQueryData>([
        'review-comments',
        params.reviewId,
      ]);

      // Optimistically remove the comment and all descendants (handles nested threads).
      queryClient.setQueryData<CommentsQueryData>(['review-comments', params.reviewId], (old) => {
        if (!old) return old;

        const childrenByParentId = new Map<string, string[]>();
        old.items.forEach((comment) => {
          if (!comment.parentId) return;
          const list = childrenByParentId.get(comment.parentId);
          if (list) {
            list.push(comment.id);
          } else {
            childrenByParentId.set(comment.parentId, [comment.id]);
          }
        });

        const toDelete = new Set<string>();
        const queue: string[] = [params.commentId];
        while (queue.length > 0) {
          const id = queue.pop();
          if (!id || toDelete.has(id)) continue;
          toDelete.add(id);
          const children = childrenByParentId.get(id);
          if (children) queue.push(...children);
        }

        const remainingItems = old.items.filter((comment) => !toDelete.has(comment.id));
        return {
          ...old,
          items: remainingItems,
          total: remainingItems.length,
        };
      });

      return { previousComments };
    },

    onError: (_error, params, context) => {
      if (context?.previousComments) {
        queryClient.setQueryData(['review-comments', params.reviewId], context.previousComments);
      }
      toast({
        title: 'Failed to delete comment',
        description: 'The comment could not be deleted. Please try again.',
        variant: 'destructive',
      });
    },

    onSuccess: () => {
      toast({
        title: 'Comment deleted',
        description: 'The comment has been deleted.',
      });
    },

    onSettled: (_data, _error, params) => {
      queryClient.invalidateQueries({ queryKey: ['review-comments', params.reviewId] });
    },
  });
}

/**
 * Hook for editing comments with optimistic updates
 */
export function useEditComment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: EditParams) => {
      const response = await fetch(`/api/reviews/${params.reviewId}/comments/${params.commentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: params.content, version: params.version }),
      });
      if (!response.ok) throw new Error('Failed to edit comment');
      return response.json() as Promise<ReviewComment>;
    },

    onMutate: async (params) => {
      await queryClient.cancelQueries({ queryKey: ['review-comments', params.reviewId] });

      const previousComments = queryClient.getQueryData<CommentsQueryData>([
        'review-comments',
        params.reviewId,
      ]);

      // Optimistically update the comment content
      queryClient.setQueryData<CommentsQueryData>(['review-comments', params.reviewId], (old) => {
        if (!old) return old;
        return {
          ...old,
          items: old.items.map((comment) =>
            comment.id === params.commentId
              ? {
                  ...comment,
                  content: params.content,
                  version: params.version + 1,
                  editedAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                }
              : comment,
          ),
        };
      });

      return { previousComments };
    },

    onError: (_error, params, context) => {
      if (context?.previousComments) {
        queryClient.setQueryData(['review-comments', params.reviewId], context.previousComments);
      }
      toast({
        title: 'Failed to edit comment',
        description: 'The comment could not be updated. Please try again.',
        variant: 'destructive',
      });
    },

    onSettled: (_data, _error, params) => {
      queryClient.invalidateQueries({ queryKey: ['review-comments', params.reviewId] });
    },
  });
}

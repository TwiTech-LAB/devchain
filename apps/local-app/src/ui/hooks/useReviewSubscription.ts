import { useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAppSocket } from './useAppSocket';
import type { WsEnvelope } from '@/ui/lib/socket';

/**
 * Subscribe to real-time review updates via WebSocket.
 * Invalidates React Query caches when review events occur.
 *
 * @param reviewId - The review ID to subscribe to
 * @param projectId - The project ID for project-level subscriptions
 */
export function useReviewSubscription(reviewId: string | null, projectId: string | null): void {
  const queryClient = useQueryClient();

  const handleMessage = useCallback(
    (envelope: WsEnvelope) => {
      // Early return only if no reviewId - projectId is optional for review-scoped events
      if (!reviewId) return;

      const { topic, type } = envelope;

      // Handle review-specific events (don't need projectId)
      if (topic === `review/${reviewId}`) {
        if (type === 'comment.created') {
          // Invalidate comments query to refetch
          queryClient.invalidateQueries({ queryKey: ['review-comments', reviewId] });
        } else if (type === 'comment.resolved') {
          // Update comment in cache or invalidate
          queryClient.invalidateQueries({ queryKey: ['review-comments', reviewId] });
        } else if (type === 'comment.updated') {
          // Invalidate comments query to refetch edited comment
          queryClient.invalidateQueries({ queryKey: ['review-comments', reviewId] });
        } else if (type === 'comment.deleted') {
          // Invalidate comments query to remove deleted comment
          queryClient.invalidateQueries({ queryKey: ['review-comments', reviewId] });
        } else if (type === 'review.updated') {
          // Invalidate review detail query
          queryClient.invalidateQueries({ queryKey: ['review', reviewId] });
        }
      }

      // Handle project-level events (for review list updates) - require projectId
      if (projectId && topic === `project/${projectId}/reviews`) {
        if (
          type === 'comment.created' ||
          type === 'comment.resolved' ||
          type === 'comment.updated' ||
          type === 'comment.deleted'
        ) {
          // May want to update review list to show comment counts
          // Note: ReviewsPage uses ['reviews', projectId, statusFilter] - invalidate all with prefix
          queryClient.invalidateQueries({ queryKey: ['reviews', projectId] });
        } else if (type === 'review.updated') {
          // Update review in list
          queryClient.invalidateQueries({ queryKey: ['reviews', projectId] });
        }
      }
    },
    [queryClient, reviewId, projectId],
  );

  const handlers = useMemo(
    () => ({
      message: handleMessage,
    }),
    [handleMessage],
  );

  useAppSocket(handlers, [reviewId, projectId]);
}

/**
 * Subscribe to project-level review updates only.
 * Use this when viewing a review list (not a specific review).
 *
 * @param projectId - The project ID to subscribe to
 */
export function useProjectReviewsSubscription(projectId: string | null): void {
  const queryClient = useQueryClient();

  const handleMessage = useCallback(
    (envelope: WsEnvelope) => {
      if (!projectId) return;

      const { topic, type } = envelope;

      // Handle project-level events
      if (topic === `project/${projectId}/reviews`) {
        if (
          type === 'comment.created' ||
          type === 'comment.resolved' ||
          type === 'comment.updated' ||
          type === 'comment.deleted' ||
          type === 'review.updated'
        ) {
          queryClient.invalidateQueries({ queryKey: ['reviews', projectId] });
        }
      }
    },
    [queryClient, projectId],
  );

  const handlers = useMemo(
    () => ({
      message: handleMessage,
    }),
    [handleMessage],
  );

  useAppSocket(handlers, [projectId]);
}

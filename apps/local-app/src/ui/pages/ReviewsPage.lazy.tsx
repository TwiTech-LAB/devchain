import { lazy, Suspense } from 'react';
import { Skeleton } from '@/ui/components/ui/skeleton';

/**
 * Lazy-loaded ReviewsPage component.
 * This enables code-splitting so react-diff-view and other heavy
 * dependencies are only loaded when the user navigates to reviews.
 */
export const LazyReviewsPage = lazy(() =>
  import('./ReviewsPage').then((module) => ({
    default: module.ReviewsPage,
  })),
);

/**
 * Preload function to trigger loading the ReviewsPage chunk.
 * Call this on hover to eliminate loading delay on click.
 */
let preloadPromise: Promise<unknown> | null = null;

export function preloadReviewsPage(): void {
  if (!preloadPromise) {
    preloadPromise = import('./ReviewsPage');
  }
}

/**
 * Loading skeleton displayed while ReviewsPage is loading.
 * Mimics the page structure for a smooth loading experience.
 */
export function ReviewsPageSkeleton() {
  return (
    <div className="flex flex-col h-full">
      {/* Header skeleton */}
      <div className="border-b p-4 bg-card">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Skeleton className="h-9 w-32" />
            <Skeleton className="h-9 w-32" />
          </div>
          <div className="flex-1" />
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 w-9" />
        </div>
      </div>

      {/* Three-panel layout skeleton */}
      <div className="flex-1 flex min-h-0">
        {/* Left panel: File Navigator */}
        <div className="w-64 border-r bg-card p-3 space-y-2">
          <div className="flex items-center gap-2 mb-3">
            <Skeleton className="h-4 w-4" />
            <Skeleton className="h-4 w-12" />
            <Skeleton className="h-5 w-6" />
          </div>
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>

        {/* Center panel: Diff Viewer */}
        <div className="flex-1 min-w-0 bg-background p-4">
          <div className="space-y-3">
            <div className="flex items-center gap-2 mb-4">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-5 w-12" />
              <Skeleton className="h-5 w-12" />
            </div>
            {Array.from({ length: 12 }).map((_, i) => (
              <Skeleton
                key={i}
                className="h-6 w-full"
                style={{ width: `${60 + Math.random() * 40}%` }}
              />
            ))}
          </div>
        </div>

        {/* Right panel: Comments */}
        <div className="w-80 border-l bg-card p-4 space-y-3">
          <Skeleton className="h-5 w-24 mb-4" />
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <div className="flex items-center gap-2">
                <Skeleton className="h-6 w-6 rounded-full" />
                <Skeleton className="h-4 w-20" />
              </div>
              <Skeleton className="h-16 w-full" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Wrapped component with Suspense boundary.
 * Use this in the router for automatic loading state handling.
 */
export function ReviewsPageWithSuspense() {
  return (
    <Suspense fallback={<ReviewsPageSkeleton />}>
      <LazyReviewsPage />
    </Suspense>
  );
}

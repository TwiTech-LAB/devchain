import { Skeleton } from '../../ui/skeleton';

type SkeletonVariant = 'card' | 'table-row' | 'list-item';

interface LoadingSkeletonProps {
  variant: SkeletonVariant;
}

export function LoadingSkeleton({ variant }: LoadingSkeletonProps) {
  if (variant === 'card') {
    return (
      <div className="rounded-lg border bg-card p-4 space-y-3" data-testid="skeleton-card">
        <Skeleton className="h-4 w-2/5" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-4/5" />
        <Skeleton className="h-3 w-3/5" />
      </div>
    );
  }

  if (variant === 'table-row') {
    return (
      <div className="flex items-center gap-3 px-3 py-2" data-testid="skeleton-table-row">
        <Skeleton className="h-3 w-6 shrink-0" />
        <Skeleton className="h-3 flex-1" />
        <Skeleton className="h-3 w-16 shrink-0" />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 py-1.5" data-testid="skeleton-list-item">
      <Skeleton className="h-3 w-3 shrink-0 rounded-full" />
      <Skeleton className="h-3 flex-1" />
    </div>
  );
}

import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useToastHelpers } from '@/ui/lib/toast-helpers';

/**
 * Low-level headless builder for the optimistic CRUD mutation pattern repeated
 * across the adopted pages. The consumer supplies the `mutationFn` (a fetcher or
 * raw `apiFetch` call) and the query keys; the kit provides the cancel → snapshot
 * → optimistic-project → rollback → invalidate → toast skeleton plus the three
 * optimistic list patterns (temp-id add, in-place merge, filter-out). Per-operation
 * behavior is customized through explicit extension points (`optimistic.project`,
 * `contextMetadata`, `onSuccessSideEffects`, `onErrorSideEffects`) rather than a
 * matrix of boolean flags.
 *
 * NO shared rendered components: pages keep their own dialog/markup and wire it to
 * the returned `useMutation` result (`mutate`, `isPending`, …).
 */

// ============================================
// Optimistic list patterns
// ============================================

/** The list-cache container shape shared by the adopted pages (`{ items, total? }`). */
export interface ListContainer<T> {
  items: T[];
  total?: number;
}

/**
 * temp-id add. Prepends by default (Providers/Profiles); pass `position:'append'`
 * for pages that append (Teams). Adjusts `total` when present unless `trackTotal:false`.
 */
export function optimisticAdd<T>(
  list: ListContainer<T>,
  item: T,
  opts: { position?: 'prepend' | 'append'; trackTotal?: boolean } = {},
): ListContainer<T> {
  const { position = 'prepend', trackTotal = true } = opts;
  const items = position === 'append' ? [...list.items, item] : [item, ...list.items];
  return {
    ...list,
    items,
    total: trackTotal && typeof list.total === 'number' ? list.total + 1 : list.total,
  };
}

/**
 * in-place merge. Replaces the item whose id matches via the supplied mapper
 * (the mapper owns the exact per-field merge so page semantics are preserved).
 */
export function optimisticMergeById<T extends { id: string }>(
  list: ListContainer<T>,
  id: string,
  map: (item: T) => T,
): ListContainer<T> {
  return { ...list, items: list.items.map((item) => (item.id === id ? map(item) : item)) };
}

/** filter-out. Removes the matching id and adjusts `total` when present. */
export function optimisticRemoveById<T extends { id: string }>(
  list: ListContainer<T>,
  id: string,
  opts: { trackTotal?: boolean } = {},
): ListContainer<T> {
  const { trackTotal = true } = opts;
  return {
    ...list,
    items: list.items.filter((item) => item.id !== id),
    total: trackTotal && typeof list.total === 'number' ? list.total - 1 : list.total,
  };
}

// ============================================
// useCrudMutation — the builder
// ============================================

export interface CrudToastCopy {
  title: string;
  description: string;
}

/**
 * Extension hooks may be async; the kit AWAITS them, so `mutateAsync` resolution and
 * `isPending` cover the full chain (matching React Query's own promise-returning
 * callback semantics). Never type a caller-performed-async hook as plain `void` —
 * that silently drops the promise.
 */
type MaybePromise<T> = T | Promise<T>;

export interface UseCrudMutationOptions<TData, TVars, TMeta> {
  mutationFn: (vars: TVars) => Promise<TData>;

  /**
   * Optimistic projection over a single list-cache key. `project` receives the
   * current cached value (unknown — the consumer narrows) and the mutation vars,
   * and returns the next cached value. The key is canceled, snapshotted, projected,
   * and rolled back on error.
   */
  optimistic?: {
    queryKey: QueryKey;
    project: (previous: unknown, vars: TVars) => unknown;
  };

  /** Extra keys to cancel + snapshot + roll back (no optimistic projection). */
  rollbackKeys?: QueryKey[];

  /**
   * Keys invalidated on success, in order (supports Teams' dual list+detail
   * invalidation). A function form receives the mutation result so keys can be
   * derived from the vars/data (e.g. the detail key of the just-updated id).
   */
  invalidateKeys?: QueryKey[] | ((vars: TVars, data: TData, meta: TMeta) => QueryKey[]);

  /**
   * Derive metadata in `onMutate` (e.g. a name read off the pre-mutation snapshot)
   * that later flows to toast copy and side effects. Receives the `optimistic`
   * snapshot as `previous`.
   */
  contextMetadata?: (vars: TVars, previous: unknown) => TMeta;

  /** Caller-supplied copy (wording stays with the caller; the factory only shapes it). */
  toast?: {
    success?: (data: TData, vars: TVars, meta: TMeta) => CrudToastCopy;
    error?: (error: unknown, vars: TVars, meta: TMeta) => CrudToastCopy;
  };

  onSuccessSideEffects?: (data: TData, vars: TVars, meta: TMeta) => MaybePromise<void>;
  onErrorSideEffects?: (error: unknown, vars: TVars, meta: TMeta) => MaybePromise<void>;
}

interface CrudMutationContext<TMeta> {
  snapshots: Array<[QueryKey, unknown]>;
  meta: TMeta;
}

export function useCrudMutation<TData = unknown, TVars = void, TMeta = void>(
  options: UseCrudMutationOptions<TData, TVars, TMeta>,
) {
  const queryClient = useQueryClient();
  const { showSuccess, showError } = useToastHelpers();

  const {
    mutationFn,
    optimistic,
    rollbackKeys,
    invalidateKeys,
    contextMetadata,
    toast,
    onSuccessSideEffects,
    onErrorSideEffects,
  } = options;

  return useMutation<TData, unknown, TVars, CrudMutationContext<TMeta>>({
    mutationFn,
    onMutate: async (vars) => {
      const keys: QueryKey[] = [];
      if (optimistic) keys.push(optimistic.queryKey);
      if (rollbackKeys) keys.push(...rollbackKeys);

      // Cancel in-flight fetches for every managed key, then snapshot for rollback.
      await Promise.all(keys.map((key) => queryClient.cancelQueries({ queryKey: key })));
      const snapshots: Array<[QueryKey, unknown]> = keys.map((key) => [
        key,
        queryClient.getQueryData(key),
      ]);

      const previous = optimistic ? queryClient.getQueryData(optimistic.queryKey) : undefined;
      const meta = (contextMetadata?.(vars, previous) ?? (undefined as TMeta)) as TMeta;

      if (optimistic) {
        queryClient.setQueryData(optimistic.queryKey, (current: unknown) =>
          optimistic.project(current, vars),
        );
      }

      return { snapshots, meta };
    },
    onError: async (error, vars, context) => {
      // Roll back every snapshot before surfacing the error.
      context?.snapshots.forEach(([key, value]) => {
        queryClient.setQueryData(key, value);
      });
      const meta = (context?.meta ?? (undefined as TMeta)) as TMeta;
      if (toast?.error) showError(toast.error(error, vars, meta));
      await onErrorSideEffects?.(error, vars, meta);
    },
    onSuccess: async (data, vars, context) => {
      const meta = (context?.meta ?? (undefined as TMeta)) as TMeta;
      const keys =
        typeof invalidateKeys === 'function' ? invalidateKeys(vars, data, meta) : invalidateKeys;
      // Invalidations initiate in declared order and are awaited so the mutation stays
      // pending until the refetches settle; the side-effect chain is awaited last so
      // `mutateAsync` does not resolve mid-chain (Profiles' prompt-ordering relies on this).
      if (keys) {
        await Promise.all(keys.map((key) => queryClient.invalidateQueries({ queryKey: key })));
      }
      if (toast?.success) showSuccess(toast.success(data, vars, meta));
      await onSuccessSideEffects?.(data, vars, meta);
    },
  });
}

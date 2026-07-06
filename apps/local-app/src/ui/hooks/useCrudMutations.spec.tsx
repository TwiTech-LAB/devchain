import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  optimisticAdd,
  optimisticMergeById,
  optimisticRemoveById,
  useCrudMutation,
  type ListContainer,
} from './useCrudMutations';

// ── toast factory: capture the shaped calls ──
const showSuccess = jest.fn();
const showError = jest.fn();
jest.mock('@/ui/lib/toast-helpers', () => ({
  useToastHelpers: () => ({ showSuccess, showError, toast: jest.fn() }),
}));

interface Item {
  id: string;
  name: string;
}
type List = ListContainer<Item>;

// ============================================
// Optimistic list patterns
// ============================================

describe('optimistic list patterns', () => {
  const base: List = {
    items: [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ],
    total: 2,
  };

  describe('optimisticAdd (temp-id add)', () => {
    it('prepends by default and increments total', () => {
      const next = optimisticAdd(base, { id: 'temp', name: 'New' });
      expect(next.items.map((i) => i.id)).toEqual(['temp', 'a', 'b']);
      expect(next.total).toBe(3);
    });

    it('appends when position=append', () => {
      const next = optimisticAdd(base, { id: 'temp', name: 'New' }, { position: 'append' });
      expect(next.items.map((i) => i.id)).toEqual(['a', 'b', 'temp']);
      expect(next.total).toBe(3);
    });

    it('leaves total untouched when absent or trackTotal=false', () => {
      expect(optimisticAdd({ items: base.items }, { id: 't', name: 'N' }).total).toBeUndefined();
      expect(optimisticAdd(base, { id: 't', name: 'N' }, { trackTotal: false }).total).toBe(2);
    });

    it('does not mutate the input', () => {
      optimisticAdd(base, { id: 'temp', name: 'New' });
      expect(base.items).toHaveLength(2);
    });
  });

  describe('optimisticMergeById (in-place merge)', () => {
    it('applies the mapper only to the matching id', () => {
      const next = optimisticMergeById(base, 'b', (i) => ({ ...i, name: 'B2' }));
      expect(next.items).toEqual([
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B2' },
      ]);
      expect(next.total).toBe(2);
    });

    it('is a no-op mapping when no id matches', () => {
      const next = optimisticMergeById(base, 'z', (i) => ({ ...i, name: 'X' }));
      expect(next.items).toEqual(base.items);
    });
  });

  describe('optimisticRemoveById (filter-out)', () => {
    it('removes the matching id and decrements total', () => {
      const next = optimisticRemoveById(base, 'a');
      expect(next.items.map((i) => i.id)).toEqual(['b']);
      expect(next.total).toBe(1);
    });

    it('respects trackTotal=false', () => {
      expect(optimisticRemoveById(base, 'a', { trackTotal: false }).total).toBe(2);
    });
  });
});

// ============================================
// useCrudMutation builder
// ============================================

describe('useCrudMutation', () => {
  const LIST_KEY = ['items'] as const;

  function seed(): { client: QueryClient; wrapper: (p: { children: ReactNode }) => JSX.Element } {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    client.setQueryData<List>(LIST_KEY, {
      items: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ],
      total: 2,
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    return { client, wrapper };
  }

  beforeEach(() => {
    showSuccess.mockClear();
    showError.mockClear();
  });

  it('applies the optimistic projection immediately, then invalidates + toasts on success', async () => {
    const { client, wrapper } = seed();
    const invalidateSpy = jest.spyOn(client, 'invalidateQueries');

    const { result } = renderHook(
      () =>
        useCrudMutation<Item, { id: string; name: string }>({
          mutationFn: async (vars) => ({ id: vars.id, name: vars.name }),
          optimistic: {
            queryKey: LIST_KEY,
            project: (prev, vars) =>
              optimisticAdd(prev as List, { id: vars.id, name: vars.name }, { position: 'append' }),
          },
          invalidateKeys: [LIST_KEY],
          toast: {
            success: () => ({ title: 'Created', description: 'ok' }),
          },
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutateAsync({ id: 'c', name: 'C' });
    });

    // Optimistic write survived (added 'c'); success toast + invalidation fired.
    expect(client.getQueryData<List>(LIST_KEY)!.items.map((i) => i.id)).toContain('c');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: LIST_KEY });
    expect(showSuccess).toHaveBeenCalledWith({ title: 'Created', description: 'ok' });
    expect(showError).not.toHaveBeenCalled();
  });

  it('rolls back the optimistic write and shows the error toast on failure', async () => {
    const { client, wrapper } = seed();
    const before = client.getQueryData<List>(LIST_KEY);

    const { result } = renderHook(
      () =>
        useCrudMutation<void, string>({
          mutationFn: async () => {
            throw new Error('nope');
          },
          optimistic: {
            queryKey: LIST_KEY,
            project: (prev, id) => optimisticRemoveById(prev as List, id),
          },
          toast: {
            error: (err) => ({
              title: 'Failed',
              description: err instanceof Error ? err.message : 'x',
            }),
          },
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutateAsync('a').catch(() => undefined);
    });

    // Cache restored to the pre-mutation snapshot.
    expect(client.getQueryData<List>(LIST_KEY)).toEqual(before);
    expect(showError).toHaveBeenCalledWith({ title: 'Failed', description: 'nope' });
    expect(showSuccess).not.toHaveBeenCalled();
  });

  it('threads contextMetadata (from the pre-mutation snapshot) into the success toast', async () => {
    const { wrapper } = seed();

    const { result } = renderHook(
      () =>
        useCrudMutation<void, string, { name: string }>({
          mutationFn: async () => undefined,
          optimistic: {
            queryKey: LIST_KEY,
            project: (prev, id) => optimisticRemoveById(prev as List, id),
          },
          contextMetadata: (id, previous) => ({
            name: (previous as List).items.find((i) => i.id === id)?.name ?? '?',
          }),
          toast: {
            success: (_d, _v, meta) => ({ title: 'Removed', description: `${meta.name} gone` }),
          },
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutateAsync('b');
    });

    expect(showSuccess).toHaveBeenCalledWith({ title: 'Removed', description: 'B gone' });
  });

  it('supports a function invalidateKeys derived from the mutation vars', async () => {
    const { client, wrapper } = seed();
    const invalidateSpy = jest.spyOn(client, 'invalidateQueries');

    const { result } = renderHook(
      () =>
        useCrudMutation<void, { id: string }>({
          mutationFn: async () => undefined,
          invalidateKeys: ({ id }) => [LIST_KEY, ['items', 'detail', id]],
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutateAsync({ id: 'b' });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: LIST_KEY });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['items', 'detail', 'b'] });
  });

  it('runs onSuccessSideEffects after invalidation and onErrorSideEffects on failure', async () => {
    const { wrapper } = seed();
    const onSuccessSideEffects = jest.fn();
    const onErrorSideEffects = jest.fn();

    const { result } = renderHook(
      () =>
        useCrudMutation<void, boolean>({
          mutationFn: async (shouldFail) => {
            if (shouldFail) throw new Error('boom');
          },
          onSuccessSideEffects,
          onErrorSideEffects,
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutateAsync(false);
    });
    expect(onSuccessSideEffects).toHaveBeenCalledTimes(1);
    expect(onErrorSideEffects).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.mutateAsync(true).catch(() => undefined);
    });
    expect(onErrorSideEffects).toHaveBeenCalledTimes(1);
  });

  it('does not resolve mutateAsync until an ASYNC onSuccessSideEffects finishes', async () => {
    // Regression: the kit used to invoke side effects without returning/awaiting the
    // promise, so `mutateAsync` (and isPending) completed while the chain still ran —
    // ProfilesPage's prompt-ordering (replaceProfilePrompts → invalidate → close →
    // toast) escaped the pending window.
    const { wrapper } = seed();
    let finishSideEffect!: () => void;
    let sideEffectDone = false;
    const onSuccessSideEffects = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSideEffect = () => {
            sideEffectDone = true;
            resolve();
          };
        }),
    );

    const { result } = renderHook(
      () =>
        useCrudMutation<string, void>({
          mutationFn: async () => 'ok',
          onSuccessSideEffects,
        }),
      { wrapper },
    );

    let resolved = false;
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.mutateAsync().then((v) => {
        resolved = true;
        return v;
      });
    });

    // The mutationFn has settled but the side effect is still hanging — mutateAsync
    // must not have resolved yet.
    await waitFor(() => expect(onSuccessSideEffects).toHaveBeenCalledTimes(1));
    expect(resolved).toBe(false);
    expect(result.current.isPending).toBe(true);

    await act(async () => {
      finishSideEffect();
      await pending;
    });
    expect(sideEffectDone).toBe(true);
    expect(resolved).toBe(true);
  });

  it('awaits an ASYNC onErrorSideEffects before the mutation settles', async () => {
    const { wrapper } = seed();
    const order: string[] = [];
    const onErrorSideEffects = jest.fn(async () => {
      await Promise.resolve();
      order.push('side-effect');
    });

    const { result } = renderHook(
      () =>
        useCrudMutation<void, void>({
          mutationFn: async () => {
            throw new Error('boom');
          },
          onErrorSideEffects,
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current
        .mutateAsync()
        .catch(() => order.push('settled'))
        .then(() => undefined);
    });

    // The rejection surfaced only AFTER the async error side effect completed.
    expect(order).toEqual(['side-effect', 'settled']);
  });

  it('orders success work invalidate → toast → side effect', async () => {
    const { client, wrapper } = seed();
    const order: string[] = [];
    jest.spyOn(client, 'invalidateQueries').mockImplementation(async () => {
      order.push('invalidate');
    });
    showSuccess.mockImplementation(() => {
      order.push('toast');
    });

    const { result } = renderHook(
      () =>
        useCrudMutation<void, void>({
          mutationFn: async () => undefined,
          invalidateKeys: [LIST_KEY],
          toast: { success: () => ({ title: 't', description: 'd' }) },
          onSuccessSideEffects: async () => {
            order.push('side-effect');
          },
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(order).toEqual(['invalidate', 'toast', 'side-effect']);
  });

  it('rolls back extra rollbackKeys (no optimistic projection) on failure', async () => {
    const { client, wrapper } = seed();
    const SIDE_KEY = ['side'] as const;
    client.setQueryData(SIDE_KEY, { value: 'original' });

    const { result } = renderHook(
      () =>
        useCrudMutation<void, void>({
          // Corrupt the side key from inside mutationFn — this runs AFTER onMutate
          // has snapshotted it, so restoration on error is what we assert.
          mutationFn: async () => {
            client.setQueryData(SIDE_KEY, { value: 'corrupted' });
            throw new Error('x');
          },
          optimistic: {
            queryKey: LIST_KEY,
            project: () => ({ items: [], total: 0 }),
          },
          rollbackKeys: [SIDE_KEY],
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutateAsync().catch(() => undefined);
    });

    expect(client.getQueryData(SIDE_KEY)).toEqual({ value: 'original' });
  });
});

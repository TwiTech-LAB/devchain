import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useBoardDragDrop } from '@/ui/hooks/useBoardDragDrop';
import { boardCacheKeys } from '@/ui/lib/board-cache';
import type { Epic, EpicsQueryData } from '@/ui/types';

// Hook unit tests use the real QueryClient to verify cache keys and debounce without transport.
const epic: Epic = {
  id: 'epic',
  projectId: 'project',
  title: 'Epic',
  description: null,
  statusId: 'todo',
  version: 1,
  parentId: 'parent',
  agentId: null,
  createdBy: null,
  tags: [],
  createdAt: '',
  updatedAt: '',
};

function setup(parentFilter = 'parent') {
  const client = new QueryClient();
  const epicsKey = boardCacheKeys.list('project', 'active');
  const data = { items: [epic, { ...epic, id: 'other' }], total: 2, limit: 100, offset: 0 };
  client.setQueryData(epicsKey, data);
  client.setQueryData(boardCacheKeys.children('parent'), data);
  const onDropStatusChange = jest.fn();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useBoardDragDrop({ epicsKey, parentFilter, onDropStatusChange }), {
    wrapper,
  });
  return { ...hook, client, epicsKey, onDropStatusChange, data };
}

describe('useBoardDragDrop', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it.each([
    {
      label: 'drag end',
      finish: (h: ReturnType<typeof setup>) => h.result.current.handleDragEnd(),
    },
    {
      label: 'same-status drop',
      finish: (h: ReturnType<typeof setup>) => h.result.current.handleDrop(epic, 'todo'),
    },
  ] as const)('keeps caches and save untouched on $label', ({ finish }) => {
    const h = setup();
    act(() => h.result.current.handleDragStart(epic));
    expect(h.result.current.draggedEpic).toEqual(epic);
    act(() => finish(h));
    expect(h.result.current.draggedEpic).toBeNull();
    expect(h.client.getQueryData(h.epicsKey)).toEqual(h.data);
    act(() => jest.runOnlyPendingTimers());
    expect(h.onDropStatusChange).not.toHaveBeenCalled();
  });

  it('updates the list and children cache immediately and saves the supplied epic after 300 ms', () => {
    const h = setup();
    act(() => {
      h.result.current.handleDragStart(epic);
      h.result.current.handleDrop(epic, 'done');
    });
    for (const key of [h.epicsKey, boardCacheKeys.children('parent')]) {
      const data = h.client.getQueryData<EpicsQueryData>(key)!;
      expect(data.items[0]).toEqual({ ...epic, statusId: 'done', updatedAt: expect.any(String) });
      expect(data.items[1]).toEqual(h.data.items[1]);
      expect(data.total).toBe(2);
    }
    expect(h.result.current.draggedEpic).toBeNull();
    act(() => jest.advanceTimersByTime(299));
    expect(h.onDropStatusChange).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(1));
    expect(h.onDropStatusChange).toHaveBeenCalledWith(epic, 'done', { skipSuccessToast: true });
  });

  it('does not update the children cache outside the parent scope and clears a pending save on unmount', () => {
    const h = setup('different-parent');
    act(() => h.result.current.handleDrop(epic, 'done'));
    expect(h.client.getQueryData(boardCacheKeys.children('parent'))).toEqual(h.data);
    h.unmount();
    act(() => jest.runOnlyPendingTimers());
    expect(h.onDropStatusChange).not.toHaveBeenCalled();
  });
});

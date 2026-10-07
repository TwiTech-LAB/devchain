import { act, renderHook, waitFor } from '@testing-library/react';
import { useBoardViewPreferences } from '@/ui/hooks/board/useBoardViewPreferences';

const storageKey = (projectId: string) => `devchain:board:columns:${projectId}`;

function storedPreferences(projectId: string): Record<string, unknown> {
  return JSON.parse(window.localStorage.getItem(storageKey(projectId)) ?? '{}') as Record<
    string,
    unknown
  >;
}

describe('useBoardViewPreferences', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('hydrates persisted preferences after each project change', async () => {
    window.localStorage.setItem(
      storageKey('project-a'),
      JSON.stringify({
        collapsedStatusIds: ['todo'],
        autoCollapseEmpty: false,
        explicitlyExpandedStatusIds: ['done'],
        viewMode: 'list',
        listPageSize: 50,
      }),
    );
    window.localStorage.setItem(
      storageKey('project-b'),
      JSON.stringify({
        collapsedStatusIds: ['review'],
        autoCollapseEmpty: true,
        explicitlyExpandedStatusIds: [],
        viewMode: 'kanban',
        listPageSize: 100,
      }),
    );
    const onRouteViewChange = jest.fn();
    const onRoutePageSizeChange = jest.fn();
    const { result, rerender } = renderHook(
      ({ projectId }) =>
        useBoardViewPreferences({
          selectedProjectId: projectId,
          parentFilter: undefined,
          routeView: undefined,
          routePageSize: undefined,
          onRouteViewChange,
          onRoutePageSizeChange,
        }),
      { initialProps: { projectId: 'project-a' } },
    );

    await waitFor(() => expect(result.current.preferences.collapsedStatusIds).toEqual(['todo']));
    expect(result.current.currentViewMode).toBe('list');
    expect(result.current.currentPageSize).toBe(50);

    rerender({ projectId: 'project-b' });

    await waitFor(() => expect(result.current.preferences.collapsedStatusIds).toEqual(['review']));
    expect(result.current.currentViewMode).toBe('kanban');
    expect(result.current.currentPageSize).toBe(100);
  });

  it.each([
    { label: 'parent filter', next: { projectId: 'project-a', parentFilter: 'parent-1' } },
    { label: 'project', next: { projectId: 'project-b', parentFilter: undefined } },
  ] as const)('resets expanded empty columns on $label change', async ({ next }) => {
    const { result, rerender } = renderHook(
      ({ projectId, parentFilter }) =>
        useBoardViewPreferences({
          selectedProjectId: projectId,
          parentFilter,
          routeView: undefined,
          routePageSize: undefined,
          onRouteViewChange: jest.fn(),
          onRoutePageSizeChange: jest.fn(),
        }),
      { initialProps: { projectId: 'project-a', parentFilter: undefined as string | undefined } },
    );
    await waitFor(() => expect(result.current.isColumnCollapsed('todo', true)).toBe(true));
    act(() => result.current.expandColumn('todo'));
    expect(result.current.isColumnCollapsed('todo', true)).toBe(false);
    rerender(next);
    await waitFor(() => expect(result.current.isColumnCollapsed('todo', true)).toBe(true));
  });

  it('gives manual collapse precedence over automatic and session expansion', async () => {
    const { result } = renderHook(() =>
      useBoardViewPreferences({
        selectedProjectId: 'project-a',
        parentFilter: undefined,
        routeView: undefined,
        routePageSize: undefined,
        onRouteViewChange: jest.fn(),
        onRoutePageSizeChange: jest.fn(),
      }),
    );
    await waitFor(() => expect(result.current.isColumnCollapsed('todo', true)).toBe(true));

    act(() => result.current.expandColumn('todo'));
    expect(result.current.isColumnCollapsed('todo', true)).toBe(false);

    act(() => result.current.toggleColumnCollapse('todo'));
    expect(result.current.isColumnCollapsed('todo', true)).toBe(true);
  });

  it('auto-collapses only eligible empty columns', async () => {
    const { result } = renderHook(() =>
      useBoardViewPreferences({
        selectedProjectId: 'project-a',
        parentFilter: undefined,
        routeView: undefined,
        routePageSize: undefined,
        onRouteViewChange: jest.fn(),
        onRoutePageSizeChange: jest.fn(),
      }),
    );
    await waitFor(() => expect(result.current.preferences.autoCollapseEmpty).toBe(true));

    expect(result.current.isColumnCollapsed('todo', false)).toBe(false);
    expect(result.current.isColumnCollapsed('todo', true)).toBe(true);

    act(() => result.current.toggleColumnCollapse('todo'));
    act(() => result.current.toggleColumnCollapse('todo'));

    expect(result.current.isColumnCollapsed('todo', true)).toBe(false);
  });

  it('collapse-all clears session expansion', async () => {
    const { result } = renderHook(() =>
      useBoardViewPreferences({
        selectedProjectId: 'project-a',
        parentFilter: undefined,
        routeView: undefined,
        routePageSize: undefined,
        onRouteViewChange: jest.fn(),
        onRoutePageSizeChange: jest.fn(),
      }),
    );
    await waitFor(() => expect(result.current.preferences.autoCollapseEmpty).toBe(true));
    act(() => result.current.expandColumn('todo'));
    expect(result.current.isColumnCollapsed('todo', true)).toBe(false);

    act(() => result.current.collapseAll(['review']));

    expect(result.current.isColumnCollapsed('todo', true)).toBe(true);
    expect(result.current.isColumnCollapsed('review', false)).toBe(true);
  });

  it('reset-defaults preserves session expansion and URL overrides', async () => {
    const onRouteViewChange = jest.fn();
    const onRoutePageSizeChange = jest.fn();
    const { result } = renderHook(() =>
      useBoardViewPreferences({
        selectedProjectId: 'project-a',
        parentFilter: undefined,
        routeView: 'list',
        routePageSize: 50,
        onRouteViewChange,
        onRoutePageSizeChange,
      }),
    );
    await waitFor(() => expect(result.current.preferences.autoCollapseEmpty).toBe(true));
    act(() => result.current.expandColumn('todo'));
    act(() => result.current.toggleColumnCollapse('review'));

    act(() => result.current.resetDefaults());

    expect(result.current.isColumnCollapsed('todo', true)).toBe(false);
    expect(result.current.preferences.collapsedStatusIds).toEqual([]);
    expect(result.current.currentViewMode).toBe('list');
    expect(result.current.currentPageSize).toBe(50);
    expect(onRouteViewChange).not.toHaveBeenCalled();
    expect(onRoutePageSizeChange).not.toHaveBeenCalled();
  });

  it('lets URL view and page size override stored values', async () => {
    window.localStorage.setItem(
      storageKey('project-a'),
      JSON.stringify({ viewMode: 'kanban', listPageSize: 25 }),
    );
    const { result } = renderHook(() =>
      useBoardViewPreferences({
        selectedProjectId: 'project-a',
        parentFilter: undefined,
        routeView: 'list',
        routePageSize: 100,
        onRouteViewChange: jest.fn(),
        onRoutePageSizeChange: jest.fn(),
      }),
    );

    await waitFor(() => expect(result.current.currentViewMode).toBe('list'));
    expect(result.current.currentPageSize).toBe(100);
  });

  it('updates page-size storage and route state through one composition action', async () => {
    const onRoutePageSizeChange = jest.fn();
    const { result } = renderHook(() =>
      useBoardViewPreferences({
        selectedProjectId: 'project-a',
        parentFilter: undefined,
        routeView: undefined,
        routePageSize: undefined,
        onRouteViewChange: jest.fn(),
        onRoutePageSizeChange,
      }),
    );
    await waitFor(() => expect(result.current.currentPageSize).toBe(25));

    act(() => result.current.changePageSize(100));

    expect(storedPreferences('project-a').listPageSize).toBe(100);
    expect(onRoutePageSizeChange).toHaveBeenCalledTimes(1);
    expect(onRoutePageSizeChange).toHaveBeenCalledWith(100);
  });

  it('persists view changes and updates route state together', async () => {
    const onRouteViewChange = jest.fn();
    const { result } = renderHook(() =>
      useBoardViewPreferences({
        selectedProjectId: 'project-a',
        parentFilter: undefined,
        routeView: undefined,
        routePageSize: undefined,
        onRouteViewChange,
        onRoutePageSizeChange: jest.fn(),
      }),
    );
    await waitFor(() => expect(result.current.currentViewMode).toBe('kanban'));

    act(() => result.current.changeViewMode('list'));

    expect(storedPreferences('project-a').viewMode).toBe('list');
    expect(onRouteViewChange).toHaveBeenCalledWith('list');
  });
});

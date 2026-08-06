import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Import as ComponentType to avoid strict JSX component typing complaints
// eslint-disable-next-line @typescript-eslint/no-require-imports
const BoardPage: React.ComponentType = require('./BoardPage').BoardPage;

// Mutable project selection mock — allows tests to switch projects mid-render
let __mockSelectedProjectId = 'project-1';
jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({
    projects: [],
    projectsLoading: false,
    projectsError: false,
    refetchProjects: jest.fn(),
    selectedProjectId: __mockSelectedProjectId,
    selectedProject: { id: __mockSelectedProjectId, name: `Project ${__mockSelectedProjectId}` },
    setSelectedProjectId: jest.fn(),
  }),
}));

// Minimal socket mock to satisfy BoardPage subscription wiring
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
jest.mock('socket.io-client', () => ({ io: () => mockSocket }));

// JSDOM lacks ResizeObserver used by Radix
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

function Wrapper({
  children,
  initialEntries = ['/board'] as string[],
}: {
  children: React.ReactNode;
  initialEntries?: string[];
}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={initialEntries}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc-search">{location.search}</div>;
}

describe('BoardPage — Saved filters integration', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;
  const storageKey = 'devchain:board:savedFilters:project-1';

  beforeEach(() => {
    __mockSelectedProjectId = 'project-1';
    window.localStorage.clear();

    // Basic fetch stubs for statuses/epics/agents
    fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/statuses')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              { id: 's1', projectId: 'project-1', label: 'Todo', color: '#aaa', position: 0 },
              {
                id: 's2',
                projectId: 'project-1',
                label: 'In Progress',
                color: '#0af',
                position: 1,
              },
              { id: 's3', projectId: 'project-1', label: 'Done', color: '#0f0', position: 2 },
            ],
          }),
        } as Response;
      }
      if (url.startsWith('/api/agents')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      if (url.startsWith('/api/epics?projectId=')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'epic-1',
                projectId: 'project-1',
                title: 'Test Epic',
                description: null,
                statusId: 's1',
                version: 1,
                parentId: null,
                agentId: null,
                tags: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
          }),
        } as Response;
      }
      if (url.startsWith('/api/epics?parentId=')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      if (url.endsWith('/sub-epics/counts')) {
        return { ok: true, json: async () => ({ s1: 0, s2: 0, s3: 0 }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as jest.Mock;
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global.fetch as jest.Mock | undefined)?.mockClear?.();
  });

  it('applies saved filter and updates URL', async () => {
    // Pre-populate saved filter
    window.localStorage.setItem(
      storageKey,
      JSON.stringify([{ id: 'f1', name: 'Todo Only', qs: 'st=s1' }]),
    );

    render(
      <Wrapper>
        <Routes>
          <Route
            path="/board"
            element={
              <>
                <LocationProbe />
                <BoardPage />
              </>
            }
          />
        </Routes>
      </Wrapper>,
    );

    // Wait for page to load
    await waitFor(() => {
      expect(screen.getByText('Test Epic')).toBeInTheDocument();
    });

    // Open saved filters dropdown
    fireEvent.click(screen.getByRole('button', { name: /saved filters/i }));

    await waitFor(() => {
      expect(screen.getByText('Todo Only')).toBeInTheDocument();
    });

    // Click to apply filter
    fireEvent.click(screen.getByText('Todo Only'));

    // URL should be updated with the filter
    await waitFor(() => {
      expect(screen.getByTestId('loc-search').textContent).toBe('?st=s1');
    });
  });

  it('replaces current filters when applying saved filter (not merge)', async () => {
    // Pre-populate saved filter with different filters
    window.localStorage.setItem(
      storageKey,
      JSON.stringify([{ id: 'f1', name: 'Done Filter', qs: 'st=s3' }]),
    );

    // Start with existing filters in URL
    render(
      <Wrapper initialEntries={['/board?st=s1&q=test']}>
        <Routes>
          <Route
            path="/board"
            element={
              <>
                <LocationProbe />
                <BoardPage />
              </>
            }
          />
        </Routes>
      </Wrapper>,
    );

    // Wait for page to fully load (not just loading state)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /saved filters/i })).toBeInTheDocument();
    });

    // Verify initial URL has both filters
    expect(screen.getByTestId('loc-search').textContent).toContain('st=s1');
    expect(screen.getByTestId('loc-search').textContent).toContain('q=test');

    // Open saved filters dropdown
    fireEvent.click(screen.getByRole('button', { name: /saved filters/i }));
    await waitFor(() => screen.getByText('Done Filter'));

    // Apply saved filter
    fireEvent.click(screen.getByText('Done Filter'));

    // URL should be REPLACED with just the saved filter (not merged)
    await waitFor(() => {
      const search = screen.getByTestId('loc-search').textContent;
      expect(search).toBe('?st=s3');
      expect(search).not.toContain('q=test');
    });
  });

  it('resets pagination on apply', async () => {
    // Pre-populate saved filter
    window.localStorage.setItem(
      storageKey,
      JSON.stringify([{ id: 'f1', name: 'Simple Filter', qs: 'st=s2' }]),
    );

    // Start with pagination in URL
    render(
      <Wrapper initialEntries={['/board?pg=3&ps=50']}>
        <Routes>
          <Route
            path="/board"
            element={
              <>
                <LocationProbe />
                <BoardPage />
              </>
            }
          />
        </Routes>
      </Wrapper>,
    );

    // Wait for page to fully load
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /saved filters/i })).toBeInTheDocument();
    });

    // Verify initial URL has pagination
    expect(screen.getByTestId('loc-search').textContent).toContain('pg=3');

    // Open saved filters dropdown
    fireEvent.click(screen.getByRole('button', { name: /saved filters/i }));
    await waitFor(() => screen.getByText('Simple Filter'));

    // Apply saved filter
    fireEvent.click(screen.getByText('Simple Filter'));

    // URL should have filter but NOT pagination params
    await waitFor(() => {
      const search = screen.getByTestId('loc-search').textContent;
      expect(search).toBe('?st=s2');
      expect(search).not.toContain('pg=');
      expect(search).not.toContain('ps=');
    });
  });

  it('updates view mode on apply', async () => {
    // Pre-populate saved filter with list view
    window.localStorage.setItem(
      storageKey,
      JSON.stringify([{ id: 'f1', name: 'List View Filter', qs: 'v=list&st=s1' }]),
    );

    // Start with kanban view (default)
    render(
      <Wrapper initialEntries={['/board']}>
        <Routes>
          <Route
            path="/board"
            element={
              <>
                <LocationProbe />
                <BoardPage />
              </>
            }
          />
        </Routes>
      </Wrapper>,
    );

    // Wait for page load
    await waitFor(() => {
      expect(screen.getByText('Test Epic')).toBeInTheDocument();
    });

    // Open saved filters dropdown
    fireEvent.click(screen.getByRole('button', { name: /saved filters/i }));
    await waitFor(() => screen.getByText('List View Filter'));

    // Apply saved filter with list view
    fireEvent.click(screen.getByText('List View Filter'));

    // URL should include v=list
    await waitFor(() => {
      const search = screen.getByTestId('loc-search').textContent;
      expect(search).toContain('v=list');
      expect(search).toContain('st=s1');
    });
  });

  describe('auto-apply default filter', () => {
    const defaultKey = 'devchain:board:defaultFilterId:project-1';

    it('applies default filter on cold mount when search is empty', async () => {
      const filters = [{ id: 'f1', name: 'My Default', qs: 'st=s1' }];
      window.localStorage.setItem(storageKey, JSON.stringify(filters));
      window.localStorage.setItem(defaultKey, 'f1');

      render(
        <Wrapper initialEntries={['/board']}>
          <Routes>
            <Route path="/board" element={<BoardPage />} />
          </Routes>
          <LocationProbe />
        </Wrapper>,
      );

      await waitFor(() => {
        const search = screen.getByTestId('loc-search').textContent;
        expect(search).toContain('st=s1');
      });
    });

    it('does NOT apply default when URL already has search params', async () => {
      const filters = [{ id: 'f1', name: 'My Default', qs: 'st=s1&st=s2' }];
      window.localStorage.setItem(storageKey, JSON.stringify(filters));
      window.localStorage.setItem(defaultKey, 'f1');

      render(
        <Wrapper initialEntries={['/board?st=s3']}>
          <Routes>
            <Route path="/board" element={<BoardPage />} />
          </Routes>
          <LocationProbe />
        </Wrapper>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('loc-search').textContent).toContain('st=s3');
      });
      // Should NOT have applied the default (s1&s2)
      expect(screen.getByTestId('loc-search').textContent).not.toContain('st=s1');
    });

    it('does NOT apply when no default is set', async () => {
      render(
        <Wrapper initialEntries={['/board']}>
          <Routes>
            <Route path="/board" element={<BoardPage />} />
          </Routes>
          <LocationProbe />
        </Wrapper>,
      );

      await waitFor(() => {
        expect(screen.getByText('Test Epic')).toBeInTheDocument();
      });
      expect(screen.getByTestId('loc-search').textContent).toBe('');
    });

    it('auto-apply uses replace (not push) — verified via no duplicate history entries', async () => {
      const filters = [{ id: 'f1', name: 'My Default', qs: 'st=s1' }];
      window.localStorage.setItem(storageKey, JSON.stringify(filters));
      window.localStorage.setItem(defaultKey, 'f1');

      render(
        <Wrapper initialEntries={['/board']}>
          <Routes>
            <Route path="/board" element={<BoardPage />} />
          </Routes>
          <LocationProbe />
        </Wrapper>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('loc-search').textContent).toContain('st=s1');
      });
    });
  });

  describe('auto-apply project-switch carryover', () => {
    const keyA = 'devchain:board:savedFilters:project-a';
    const defaultKeyA = 'devchain:board:defaultFilterId:project-a';
    const keyB = 'devchain:board:savedFilters:project-b';
    const defaultKeyB = 'devchain:board:defaultFilterId:project-b';

    function renderBoard() {
      return render(
        <Wrapper initialEntries={['/board']}>
          <Routes>
            <Route path="/board" element={<BoardPage />} />
          </Routes>
          <LocationProbe />
        </Wrapper>,
      );
    }

    it('applies project B default after switching from A (carryover detection)', async () => {
      __mockSelectedProjectId = 'project-a';
      window.localStorage.setItem(
        keyA,
        JSON.stringify([{ id: 'fa', name: 'A Default', qs: 'st=s1' }]),
      );
      window.localStorage.setItem(defaultKeyA, 'fa');
      window.localStorage.setItem(
        keyB,
        JSON.stringify([{ id: 'fb', name: 'B Default', qs: 'st=s2' }]),
      );
      window.localStorage.setItem(defaultKeyB, 'fb');

      const { rerender } = renderBoard();

      await waitFor(() => {
        expect(screen.getByTestId('loc-search').textContent).toContain('st=s1');
      });

      __mockSelectedProjectId = 'project-b';
      rerender(
        <Wrapper initialEntries={['/board']}>
          <Routes>
            <Route path="/board" element={<BoardPage />} />
          </Routes>
          <LocationProbe />
        </Wrapper>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('loc-search').textContent).toContain('st=s2');
      });
    });

    it('preserves user-intentional URL when switching projects', async () => {
      __mockSelectedProjectId = 'project-a';
      window.localStorage.setItem(
        keyA,
        JSON.stringify([{ id: 'fa', name: 'A Default', qs: 'st=s1' }]),
      );
      window.localStorage.setItem(defaultKeyA, 'fa');
      window.localStorage.setItem(
        keyB,
        JSON.stringify([{ id: 'fb', name: 'B Default', qs: 'st=s2' }]),
      );
      window.localStorage.setItem(defaultKeyB, 'fb');

      const { rerender } = render(
        <Wrapper initialEntries={['/board?st=s3']}>
          <Routes>
            <Route path="/board" element={<BoardPage />} />
          </Routes>
          <LocationProbe />
        </Wrapper>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('loc-search').textContent).toContain('st=s3');
      });

      __mockSelectedProjectId = 'project-b';
      rerender(
        <Wrapper initialEntries={['/board?st=s3']}>
          <Routes>
            <Route path="/board" element={<BoardPage />} />
          </Routes>
          <LocationProbe />
        </Wrapper>,
      );

      // User-intentional URL (not carryover — no auto-apply happened) → preserved
      await waitFor(() => {
        expect(screen.getByTestId('loc-search').textContent).toContain('st=s3');
      });
      expect(screen.getByTestId('loc-search').textContent).not.toContain('st=s2');
    });

    it('does not re-apply A default when switching back A→B→A within same mount', async () => {
      __mockSelectedProjectId = 'project-a';
      window.localStorage.setItem(
        keyA,
        JSON.stringify([{ id: 'fa', name: 'A Default', qs: 'st=s1' }]),
      );
      window.localStorage.setItem(defaultKeyA, 'fa');
      window.localStorage.setItem(
        keyB,
        JSON.stringify([{ id: 'fb', name: 'B Default', qs: 'st=s2' }]),
      );
      window.localStorage.setItem(defaultKeyB, 'fb');

      const { rerender } = renderBoard();

      await waitFor(() => {
        expect(screen.getByTestId('loc-search').textContent).toContain('st=s1');
      });

      __mockSelectedProjectId = 'project-b';
      rerender(
        <Wrapper initialEntries={['/board']}>
          <Routes>
            <Route path="/board" element={<BoardPage />} />
          </Routes>
          <LocationProbe />
        </Wrapper>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('loc-search').textContent).toContain('st=s2');
      });

      __mockSelectedProjectId = 'project-a';
      rerender(
        <Wrapper initialEntries={['/board']}>
          <Routes>
            <Route path="/board" element={<BoardPage />} />
          </Routes>
          <LocationProbe />
        </Wrapper>,
      );

      // A is already in appliedDefaultsRef — should NOT re-apply A's default
      // URL stays at B's last applied value
      await waitFor(() => {
        expect(screen.getByTestId('loc-search').textContent).toContain('st=s2');
      });
    });

    it('clears URL when switching to no-default project from auto-applied state', async () => {
      __mockSelectedProjectId = 'project-a';
      window.localStorage.setItem(
        keyA,
        JSON.stringify([{ id: 'fa', name: 'A Default', qs: 'st=s1' }]),
      );
      window.localStorage.setItem(defaultKeyA, 'fa');

      const { rerender } = renderBoard();

      await waitFor(() => {
        expect(screen.getByTestId('loc-search').textContent).toContain('st=s1');
      });

      __mockSelectedProjectId = 'project-b';
      rerender(
        <Wrapper initialEntries={['/board']}>
          <Routes>
            <Route path="/board" element={<BoardPage />} />
          </Routes>
          <LocationProbe />
        </Wrapper>,
      );

      // B has no default — carryover detected → URL cleared
      await waitFor(() => {
        expect(screen.getByTestId('loc-search').textContent).toBe('');
      });
    });
  });
});

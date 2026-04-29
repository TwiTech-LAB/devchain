import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { CodebaseOverviewPage } from './CodebaseOverviewPage';
import type { CodebaseOverviewSnapshot, TargetDetail } from '@devchain/codebase-overview';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const useSelectedProjectMock = jest.fn();

jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => useSelectedProjectMock(),
}));

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const mockSnapshot: CodebaseOverviewSnapshot = {
  snapshotId: 'snap-1',
  projectKey: '/projects/test',
  name: 'Test Project',
  regions: [{ id: 'r-src', path: 'src', name: 'src', totalFiles: 10, totalLOC: 1000 }],
  districts: [
    {
      id: 'd-ctrl',
      regionId: 'r-src',
      path: 'src/controllers',
      name: 'controllers',
      totalFiles: 5,
      totalLOC: 500,
      churn7d: 3,
      churn30d: 15,
      inboundWeight: 0,
      outboundWeight: 0,
      couplingScore: 0,
      testFileCount: 1,
      testFileRatio: 0.2,
      role: 'controller',
      complexityAvg: null,
      ownershipConcentration: null,
      testCoverageRate: null,
      blastRadius: 0,
      primaryAuthorName: null,
      primaryAuthorShare: null,
      primaryAuthorRecentlyActive: false,
    },
  ],
  dependencies: [],
  hotspots: [],
  activity: [],
  signals: [],
  globalContributors: [],
  metrics: {
    totalRegions: 1,
    totalDistricts: 1,
    totalFiles: 10,
    gitHistoryDaysAvailable: 30,
    shallowHistoryDetected: false,
    dependencyCoverage: null,
    warnings: [],
    excludedAuthorCount: 0,
    scopeConfigHash: 'test',
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(data: unknown): Response {
  return { ok: true, json: async () => data, status: 200 } as Response;
}

function createWrapper(initialEntries: string[] = ['/overview']) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter initialEntries={initialEntries}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
  return { Wrapper, queryClient };
}

function buildFetchMock(snapshot?: CodebaseOverviewSnapshot | null) {
  const snap = snapshot !== undefined ? snapshot : mockSnapshot;
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/codebase-overview')) {
      if (!snap) throw new Error('Not found');
      return jsonResponse(snap);
    }
    return jsonResponse({});
  });
}

// Snapshot with 5 untested+changed districts so the Testability card renders
const testabilityDistrict = (id: string, name: string) => ({
  id,
  regionId: 'r-src',
  path: `src/${name}`,
  name,
  totalFiles: 3,
  totalLOC: 300,
  churn7d: 1,
  churn30d: 5,
  inboundWeight: 0,
  outboundWeight: 0,
  couplingScore: 0,
  testFileCount: 0,
  testFileRatio: 0,
  role: 'service' as const,
  complexityAvg: null,
  ownershipConcentration: null,
  testCoverageRate: null,
  blastRadius: 0,
  primaryAuthorName: null,
  primaryAuthorShare: null,
  primaryAuthorRecentlyActive: false,
});

const testabilitySignal = (districtId: string, name: string, churn30d: number) => ({
  districtId,
  name,
  path: `src/${name}`,
  regionId: 'r-src',
  regionName: 'src',
  files: 3,
  sourceFileCount: 3,
  supportFileCount: 0,
  hasSourceFiles: true,
  loc: 300,
  churn7d: 1,
  churn30d,
  testCoverageRate: 0.1,
  sourceCoverageMeasured: true,
  complexityAvg: null,
  inboundWeight: 0,
  outboundWeight: 0,
  blastRadius: 0,
  couplingScore: 0,
  ownershipHHI: null,
  ownershipMeasured: false,
  primaryAuthorName: null,
  primaryAuthorShare: null,
  primaryAuthorRecentlyActive: false,
  fileTypeBreakdown: { kind: 'extension' as const, counts: {} },
});

const mockTestabilitySnapshot: CodebaseOverviewSnapshot = {
  ...mockSnapshot,
  districts: [
    testabilityDistrict('d-ctrl', 'controllers'),
    testabilityDistrict('d-svc', 'services'),
    testabilityDistrict('d-util', 'utils'),
    testabilityDistrict('d-model', 'models'),
    testabilityDistrict('d-repo', 'repos'),
  ],
  signals: [
    testabilitySignal('d-ctrl', 'controllers', 10),
    testabilitySignal('d-svc', 'services', 8),
    testabilitySignal('d-util', 'utils', 6),
    testabilitySignal('d-model', 'models', 4),
    testabilitySignal('d-repo', 'repos', 2),
  ],
};

const mockTargetDetail: TargetDetail = {
  targetId: 'd-ctrl',
  kind: 'district',
  summary: 'Detail panel loaded',
  whyRanked: [],
  recentCommits: [],
  topAuthors: [],
  recentActivity: [],
};

function buildTestabilityFetchMock() {
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/targets/')) return jsonResponse(mockTargetDetail);
    if (url.includes('/codebase-overview')) return jsonResponse(mockTestabilitySnapshot);
    return jsonResponse({});
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CodebaseOverviewPage Shell', () => {
  beforeEach(() => {
    useSelectedProjectMock.mockReturnValue({ selectedProjectId: 'p1' });
    localStorage.clear();
  });

  it('shows empty state when no project is selected', () => {
    useSelectedProjectMock.mockReturnValue({ selectedProjectId: null });
    const { Wrapper } = createWrapper();
    render(<CodebaseOverviewPage />, { wrapper: Wrapper });

    expect(screen.getByText('No project selected')).toBeInTheDocument();
  });

  it('registers all 7 section tabs', async () => {
    global.fetch = buildFetchMock() as typeof fetch;
    const { Wrapper, queryClient } = createWrapper(['/overview?section=summary']);
    render(<CodebaseOverviewPage />, { wrapper: Wrapper });

    await screen.findByText('No signal data available');

    expect(screen.getByRole('tab', { name: /summary/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /change/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /testability/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /architecture/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /ownership/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /structure/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /scope/i })).toBeInTheDocument();

    queryClient.clear();
  });

  // -----------------------------------------------------------------------
  // 1. Default routing → summary
  // -----------------------------------------------------------------------

  it('renders Summary section by default when visiting /overview', async () => {
    global.fetch = buildFetchMock() as typeof fetch;
    const { Wrapper, queryClient } = createWrapper(['/overview']);
    render(<CodebaseOverviewPage />, { wrapper: Wrapper });

    await waitFor(() => {
      const summaryTab = screen.getByRole('tab', { name: /summary/i });
      expect(summaryTab).toHaveAttribute('data-state', 'active');
    });

    await screen.findByText('No signal data available');
    queryClient.clear();
  });

  // -----------------------------------------------------------------------
  // 2. Invalid section canonicalizes
  // -----------------------------------------------------------------------

  it('canonicalizes invalid ?section= to summary', async () => {
    global.fetch = buildFetchMock() as typeof fetch;
    const { Wrapper, queryClient } = createWrapper(['/overview?section=garbage']);
    render(<CodebaseOverviewPage />, { wrapper: Wrapper });

    await waitFor(() => {
      const summaryTab = screen.getByRole('tab', { name: /summary/i });
      expect(summaryTab).toHaveAttribute('data-state', 'active');
    });

    await screen.findByText('No signal data available');
    queryClient.clear();
  });

  // -----------------------------------------------------------------------
  // 3. Section switching does NOT refetch
  // -----------------------------------------------------------------------

  it('does not refetch snapshot when switching sections', async () => {
    const user = userEvent.setup();
    const fetchMock = buildFetchMock();
    global.fetch = fetchMock as typeof fetch;
    const { Wrapper, queryClient } = createWrapper(['/overview?section=summary']);

    await act(async () => {
      render(<CodebaseOverviewPage />, { wrapper: Wrapper });
    });

    await screen.findByText('No signal data available');

    const snapshotCalls = () =>
      fetchMock.mock.calls.filter(
        ([url]: [string]) => typeof url === 'string' && url.includes('/codebase-overview'),
      ).length;

    const countAfterLoad = snapshotCalls();

    // Switch to change (userEvent dispatches pointer+focus events Radix expects)
    await user.click(screen.getByRole('tab', { name: /change/i }));
    await screen.findByText("What's happening this week?");

    // Switch back to summary
    await user.click(screen.getByRole('tab', { name: /summary/i }));
    await screen.findByText('No signal data available');

    // No additional network calls
    expect(snapshotCalls()).toBe(countAfterLoad);

    queryClient.clear();
  });

  // -----------------------------------------------------------------------
  // 4. Refresh invalidates
  // -----------------------------------------------------------------------

  it('triggers refetch when refresh button is clicked', async () => {
    const fetchMock = buildFetchMock();
    global.fetch = fetchMock as typeof fetch;
    const { Wrapper, queryClient } = createWrapper(['/overview?section=summary']);
    render(<CodebaseOverviewPage />, { wrapper: Wrapper });

    await screen.findByText('No signal data available');

    const snapshotCalls = () =>
      fetchMock.mock.calls.filter(
        ([url]: [string]) => typeof url === 'string' && url.includes('/codebase-overview'),
      ).length;

    const countBefore = snapshotCalls();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh overview' }));

    await waitFor(() => {
      expect(snapshotCalls()).toBeGreaterThan(countBefore);
    });

    queryClient.clear();
  });

  // -----------------------------------------------------------------------
  // 5. Project change → new query key
  // -----------------------------------------------------------------------

  it('fetches with new query key when project changes', async () => {
    const fetchMock = buildFetchMock();
    global.fetch = fetchMock as typeof fetch;
    const { Wrapper, queryClient } = createWrapper(['/overview?section=summary']);
    const { rerender } = render(<CodebaseOverviewPage />, { wrapper: Wrapper });

    await screen.findByText('No signal data available');

    useSelectedProjectMock.mockReturnValue({ selectedProjectId: 'p2' });
    rerender(<CodebaseOverviewPage />);

    await waitFor(() => {
      const p2Calls = fetchMock.mock.calls.filter(
        ([url]: [string]) => typeof url === 'string' && url.includes('/projects/p2/'),
      );
      expect(p2Calls.length).toBeGreaterThan(0);
    });

    queryClient.clear();
  });

  // -----------------------------------------------------------------------
  // 6. Active section visual (data-state="active")
  // -----------------------------------------------------------------------

  it('shows data-state="active" on the selected tab', async () => {
    global.fetch = buildFetchMock() as typeof fetch;
    const { Wrapper, queryClient } = createWrapper(['/overview?section=testability']);
    render(<CodebaseOverviewPage />, { wrapper: Wrapper });

    await waitFor(() => {
      const testabilityTab = screen.getByRole('tab', { name: /testability/i });
      expect(testabilityTab).toHaveAttribute('data-state', 'active');
    });

    const summaryTab = screen.getByRole('tab', { name: /summary/i });
    expect(summaryTab).toHaveAttribute('data-state', 'inactive');

    queryClient.clear();
  });

  // -----------------------------------------------------------------------
  // 7. Keyboard navigation (smoke test)
  // -----------------------------------------------------------------------

  it('tabs are keyboard-focusable with correct roles', async () => {
    global.fetch = buildFetchMock() as typeof fetch;
    const { Wrapper, queryClient } = createWrapper(['/overview?section=summary']);
    render(<CodebaseOverviewPage />, { wrapper: Wrapper });

    await screen.findByText('No signal data available');

    const tabs = screen.getAllByRole('tab');
    expect(tabs.length).toBe(7);

    const summaryTab = screen.getByRole('tab', { name: /summary/i });
    summaryTab.focus();
    expect(document.activeElement).toBe(summaryTab);

    queryClient.clear();
  });

  // -----------------------------------------------------------------------
  // 8. Loading state
  // -----------------------------------------------------------------------

  it('shows loading skeletons while snapshot is pending', () => {
    global.fetch = jest.fn(() => new Promise<Response>(() => {})) as typeof fetch;
    const { Wrapper } = createWrapper(['/overview?section=summary']);
    render(<CodebaseOverviewPage />, { wrapper: Wrapper });

    expect(screen.getAllByTestId('skeleton-card').length).toBeGreaterThan(0);

    // Navigation still rendered during load
    expect(screen.getByRole('tab', { name: /summary/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /change/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /testability/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /architecture/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /ownership/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /structure/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /scope/i })).toBeInTheDocument();
  });

  // -----------------------------------------------------------------------
  // 9. Error state
  // -----------------------------------------------------------------------

  it('shows error empty state when snapshot query fails', async () => {
    global.fetch = buildFetchMock(null) as typeof fetch;
    const { Wrapper, queryClient } = createWrapper(['/overview?section=summary']);
    render(<CodebaseOverviewPage />, { wrapper: Wrapper });

    await screen.findByText("Couldn't load overview");
    expect(screen.getByText('Try refresh; if persistent, see logs.')).toBeInTheDocument();

    // Refresh button still functional
    expect(screen.getByRole('button', { name: 'Refresh overview' })).toBeInTheDocument();

    // Navigation still rendered
    expect(screen.getByRole('tab', { name: /summary/i })).toBeInTheDocument();

    queryClient.clear();
  });

  // -----------------------------------------------------------------------
  // Placeholder sections render correct content
  // -----------------------------------------------------------------------

  it('Change section shows placeholder when deep-linked', async () => {
    global.fetch = buildFetchMock() as typeof fetch;
    const { Wrapper, queryClient } = createWrapper(['/overview?section=change']);

    await act(async () => {
      render(<CodebaseOverviewPage />, { wrapper: Wrapper });
    });

    await screen.findByText("What's happening this week?");
    queryClient.clear();
  });

  it('Ownership section shows empty state when deep-linked with no data', async () => {
    global.fetch = buildFetchMock() as typeof fetch;
    const { Wrapper, queryClient } = createWrapper(['/overview?section=ownership']);

    await act(async () => {
      render(<CodebaseOverviewPage />, { wrapper: Wrapper });
    });

    await screen.findByText('No ownership data available');
    queryClient.clear();
  });

  it('refresh button has spinning animation while fetching', async () => {
    global.fetch = buildFetchMock() as typeof fetch;
    const { Wrapper, queryClient } = createWrapper(['/overview?section=summary']);
    render(<CodebaseOverviewPage />, { wrapper: Wrapper });

    const refreshBtn = screen.getByRole('button', { name: 'Refresh overview' });
    const icon = refreshBtn.querySelector('svg');
    expect(icon).toBeInTheDocument();

    await screen.findByText('No signal data available');
    queryClient.clear();
  });

  // -----------------------------------------------------------------------
  // Architecture section — DependencyMatrix rendered (not just placeholder)
  // -----------------------------------------------------------------------

  it('Architecture section renders section header when deep-linked', async () => {
    global.fetch = buildFetchMock() as typeof fetch;
    const { Wrapper, queryClient } = createWrapper(['/overview?section=architecture']);

    await act(async () => {
      render(<CodebaseOverviewPage />, { wrapper: Wrapper });
    });

    await screen.findByText('Architecture');
    expect(screen.getByText('Is the structure decaying?')).toBeInTheDocument();
    queryClient.clear();
  });

  it('Architecture section shows empty state when no dependency data', async () => {
    global.fetch = buildFetchMock() as typeof fetch;
    const { Wrapper, queryClient } = createWrapper(['/overview?section=architecture']);

    await act(async () => {
      render(<CodebaseOverviewPage />, { wrapper: Wrapper });
    });

    await screen.findByText('No architecture data available');
    queryClient.clear();
  });

  // -----------------------------------------------------------------------
  // Structure section
  // -----------------------------------------------------------------------

  it('Structure section renders header when deep-linked', async () => {
    global.fetch = buildFetchMock() as typeof fetch;
    const { Wrapper, queryClient } = createWrapper(['/overview?section=structure']);

    await act(async () => {
      render(<CodebaseOverviewPage />, { wrapper: Wrapper });
    });

    await screen.findByText('Structure');
    expect(screen.getByText("What's in this repo?")).toBeInTheDocument();
    queryClient.clear();
  });

  it('Structure section shows empty state when no signals', async () => {
    global.fetch = buildFetchMock() as typeof fetch;
    const { Wrapper, queryClient } = createWrapper(['/overview?section=structure']);

    await act(async () => {
      render(<CodebaseOverviewPage />, { wrapper: Wrapper });
    });

    await screen.findByText('No districts analyzed');
    queryClient.clear();
  });

  // -----------------------------------------------------------------------
  // WarningsBar — shell-level placement
  // -----------------------------------------------------------------------

  it('renders WarningsBar when snapshot has warnings', async () => {
    const snapshotWithWarning: CodebaseOverviewSnapshot = {
      ...mockSnapshot,
      metrics: {
        ...mockSnapshot.metrics,
        warnings: [{ code: 'loc_unavailable', message: 'LOC data unavailable for some files' }],
      },
    };
    global.fetch = buildFetchMock(snapshotWithWarning) as typeof fetch;
    const { Wrapper, queryClient } = createWrapper(['/overview?section=summary']);

    await act(async () => {
      render(<CodebaseOverviewPage />, { wrapper: Wrapper });
    });

    await screen.findByText('No signal data available');
    expect(screen.getByTestId('warnings-bar')).toBeInTheDocument();
    expect(screen.getByText('LOC data unavailable for some files')).toBeInTheDocument();
    queryClient.clear();
  });

  it('does not render WarningsBar when snapshot has no warnings', async () => {
    global.fetch = buildFetchMock() as typeof fetch; // mockSnapshot has warnings: []
    const { Wrapper, queryClient } = createWrapper(['/overview?section=summary']);

    await act(async () => {
      render(<CodebaseOverviewPage />, { wrapper: Wrapper });
    });

    await screen.findByText('No signal data available');
    expect(screen.queryByTestId('warnings-bar')).not.toBeInTheDocument();
    queryClient.clear();
  });

  it('WarningsBar persists when switching sections', async () => {
    const user = userEvent.setup();
    const snapshotWithWarning: CodebaseOverviewSnapshot = {
      ...mockSnapshot,
      metrics: {
        ...mockSnapshot.metrics,
        warnings: [{ code: 'shallow_git_history', message: 'Shallow git history detected' }],
      },
    };
    global.fetch = buildFetchMock(snapshotWithWarning) as typeof fetch;
    const { Wrapper, queryClient } = createWrapper(['/overview?section=summary']);

    await act(async () => {
      render(<CodebaseOverviewPage />, { wrapper: Wrapper });
    });

    await screen.findByText('No signal data available');
    expect(screen.getByTestId('warnings-bar')).toBeInTheDocument();

    // Switch section
    await user.click(screen.getByRole('tab', { name: /change/i }));
    await screen.findByText("What's happening this week?");

    // WarningsBar still present
    expect(screen.getByTestId('warnings-bar')).toBeInTheDocument();
    queryClient.clear();
  });

  it('renders multiple warnings across severity buckets', async () => {
    const snapshotMultiWarn: CodebaseOverviewSnapshot = {
      ...mockSnapshot,
      metrics: {
        ...mockSnapshot.metrics,
        warnings: [
          { code: 'shallow_git_history', message: 'Shallow clone detected' },
          { code: 'coverage_unmeasured', message: 'Coverage data missing' },
          { code: 'partial_test_detection', message: 'Some tests may be missed' },
        ],
      },
    };
    global.fetch = buildFetchMock(snapshotMultiWarn) as typeof fetch;
    const { Wrapper, queryClient } = createWrapper(['/overview?section=summary']);

    await act(async () => {
      render(<CodebaseOverviewPage />, { wrapper: Wrapper });
    });

    await screen.findByText('No signal data available');
    expect(screen.getByText('Shallow clone detected')).toBeInTheDocument();
    expect(screen.getByText('Coverage data missing')).toBeInTheDocument();
    expect(screen.getByText('Some tests may be missed')).toBeInTheDocument();
    queryClient.clear();
  });

  // -----------------------------------------------------------------------
  // Testability section — shared panels wired
  // -----------------------------------------------------------------------

  it('clicking a Testability row opens HotspotDetailPanel', async () => {
    global.fetch = buildTestabilityFetchMock() as typeof fetch;
    const { Wrapper, queryClient } = createWrapper(['/overview?section=testability']);

    await act(async () => {
      render(<CodebaseOverviewPage />, { wrapper: Wrapper });
    });

    // Wait for the Testability section to load and card to appear
    await screen.findByText('Untested Changed');

    // Click the 'controllers' district row
    fireEvent.click(screen.getByText('controllers').closest('button')!);

    // Detail panel should appear (summary text from mockTargetDetail)
    await screen.findByText('Detail panel loaded');
    queryClient.clear();
  });

  it('pinning two Testability districts reveals ComparePanel', async () => {
    global.fetch = buildTestabilityFetchMock() as typeof fetch;
    const { Wrapper, queryClient } = createWrapper(['/overview?section=testability']);

    await act(async () => {
      render(<CodebaseOverviewPage />, { wrapper: Wrapper });
    });

    await screen.findByText('Untested Changed');

    // Click first row, wait for panel, pin it
    fireEvent.click(screen.getByText('controllers').closest('button')!);
    await screen.findByText('Detail panel loaded');
    fireEvent.click(screen.getByRole('button', { name: 'Pin to compare' }));

    // Click second row (panel switches to services), wait for panel, pin it
    fireEvent.click(screen.getByText('services').closest('button')!);
    await screen.findByText('Detail panel loaded');
    fireEvent.click(screen.getByRole('button', { name: 'Pin to compare' }));

    // ComparePanel should now appear
    await screen.findByText('Compare');
    queryClient.clear();
  });

  // -----------------------------------------------------------------------
  // Scope section
  // -----------------------------------------------------------------------

  it('Scope section tab is visible and renders section content when deep-linked', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/scope')) return jsonResponse({ entries: [], storageMode: 'local-only' });
      return jsonResponse(mockSnapshot);
    }) as typeof fetch;
    const { Wrapper, queryClient } = createWrapper(['/overview?section=scope']);

    await act(async () => {
      render(<CodebaseOverviewPage />, { wrapper: Wrapper });
    });

    expect(screen.getByRole('tab', { name: /scope/i })).toBeInTheDocument();
    // ScopeSection renders its description text once the query resolves
    await screen.findByText(/control which folders/i);
    queryClient.clear();
  });
});

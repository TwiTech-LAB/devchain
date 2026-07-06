import { useEffect, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { useImportProjectWizard } from './useImportProjectWizard';
import type { SetupPreviewResponse } from '@/ui/pages/projects/lib/project-api';

function preview(over: Partial<SetupPreviewResponse['payload']> = {}): SetupPreviewResponse {
  return {
    payload: {
      agents: [],
      profiles: [],
      teams: [],
      presets: [],
      providerModels: [],
      providerEfforts: [],
      ...over,
    } as unknown as SetupPreviewResponse['payload'],
    providerSummary: [],
    familyAlternatives: [],
    presetProviderCoverage: [],
    localAvailability: { installedProviders: [] },
  };
}

interface FetchLog {
  setupPreview: number;
  dryRun: number;
  commit: number;
  lastCommitBody: unknown;
  lastDryRunBody: unknown;
}

function mockFetch(opts: {
  previewResponse?: SetupPreviewResponse;
  dryRunResponse?: unknown;
  commitResponse?: unknown;
}): FetchLog {
  const log: FetchLog = {
    setupPreview: 0,
    dryRun: 0,
    commit: 0,
    lastCommitBody: null,
    lastDryRunBody: null,
  };
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url === '/api/projects/setup-preview') {
      log.setupPreview += 1;
      return { ok: true, json: async () => opts.previewResponse ?? preview() };
    }
    if (url.includes('/import?dryRun=true')) {
      log.dryRun += 1;
      log.lastDryRunBody = body;
      return {
        ok: true,
        json: async () =>
          opts.dryRunResponse ?? {
            dryRun: true,
            missingProviders: [],
            counts: { toImport: { agents: 1 }, toDelete: {} },
          },
      };
    }
    // Commit (no query string).
    log.commit += 1;
    log.lastCommitBody = body;
    return {
      ok: true,
      json: async () =>
        opts.commitResponse ?? {
          success: true,
          counts: { imported: {}, deleted: {} },
          mappings: {},
        },
    };
  }) as unknown as typeof fetch;
  return log;
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const TARGET = { id: 'proj-1', name: 'My Project' };

describe('useImportProjectWizard', () => {
  it('loads the setup-preview, runs the dry-run on Review, and commits on submit', async () => {
    const log = mockFetch({});
    const onImported = jest.fn();
    const { result } = renderHook(() => useImportProjectWizard({ onImported, toast: jest.fn() }), {
      wrapper,
    });

    act(() => result.current.openImportWizard(TARGET, { slug: 'demo' }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(log.setupPreview).toBe(1);

    // Providers → Agents (Teams skipped: no configurable team) → Review.
    act(() => result.current.controller.goNext());
    act(() => result.current.controller.goNext());
    await waitFor(() => expect(result.current.controller.currentStep?.id).toBe('review'));

    // Dry-run fires on entering Review; the final step then becomes proceedable.
    await waitFor(() => expect(log.dryRun).toBe(1));
    await waitFor(() => expect(result.current.controller.canProceed).toBe(true));
    expect(result.current.controller.isLastStep).toBe(true);

    // Submit → destructive commit → onImported + wizard closes.
    await act(async () => {
      result.current.controller.submit();
    });
    await waitFor(() => expect(log.commit).toBe(1));
    expect(onImported).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    await waitFor(() => expect(result.current.isOpen).toBe(false));
  });

  it('blocks the final Import until every unmatched status is mapped', async () => {
    mockFetch({
      dryRunResponse: {
        dryRun: true,
        missingProviders: [],
        counts: { toImport: {}, toDelete: {} },
        unmatchedStatuses: [{ id: 's1', label: 'Backlog', color: '#111', epicCount: 2 }],
        templateStatuses: [{ label: 'Todo', color: '#222' }],
      },
    });
    const { result } = renderHook(
      () => useImportProjectWizard({ onImported: jest.fn(), toast: jest.fn() }),
      { wrapper },
    );

    act(() => result.current.openImportWizard(TARGET, { slug: 'demo' }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => result.current.controller.goNext());
    act(() => result.current.controller.goNext());
    await waitFor(() => expect(result.current.controller.currentStep?.id).toBe('review'));

    // Dry-run reports an unmatched status → Import is gated closed until it is mapped.
    await waitFor(() => expect(result.current.controller.canProceed).toBe(false));
  });

  it('includes selectedProviderNames + status mappings in the request bodies', async () => {
    const log = mockFetch({
      previewResponse: preview({
        // one available provider so the selection is non-empty
      }),
    });
    // Re-mock preview with an available provider summary.
    const previewWithProvider: SetupPreviewResponse = {
      ...preview(),
      providerSummary: [{ name: 'claude', available: true, families: [], agentCount: 0 }],
    };
    (global.fetch as jest.Mock).mockImplementation(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (url === '/api/projects/setup-preview') {
        return { ok: true, json: async () => previewWithProvider };
      }
      if (url.includes('/import?dryRun=true')) {
        log.dryRun += 1;
        log.lastDryRunBody = body;
        return {
          ok: true,
          json: async () => ({
            dryRun: true,
            missingProviders: [],
            counts: { toImport: {}, toDelete: {} },
          }),
        };
      }
      log.commit += 1;
      log.lastCommitBody = body;
      return {
        ok: true,
        json: async () => ({ success: true, counts: { imported: {}, deleted: {} }, mappings: {} }),
      };
    });

    // Render the Providers step body so the (no longer preselected) provider can be clicked;
    // later steps are driven purely through the captured controller.
    let wiz: ReturnType<typeof useImportProjectWizard> | null = null;
    function Harness() {
      const hook = useImportProjectWizard({ onImported: jest.fn(), toast: jest.fn() });
      wiz = hook;
      useEffect(() => {
        hook.openImportWizard(TARGET, { slug: 'demo' });
      }, []);
      return (
        <div>
          {hook.controller.currentStep?.id === 'providers'
            ? hook.controller.currentStep.render()
            : null}
        </div>
      );
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
    );

    await screen.findByRole('checkbox', { name: 'Claude provider' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Claude provider' }));
    await waitFor(() => expect(wiz!.controller.canProceed).toBe(true));

    act(() => wiz!.controller.goNext());
    act(() => wiz!.controller.goNext());
    await waitFor(() => expect(wiz!.controller.currentStep?.id).toBe('review'));
    await waitFor(() => expect(log.dryRun).toBeGreaterThanOrEqual(1));

    await act(async () => {
      wiz!.controller.submit();
    });
    await waitFor(() => expect(log.commit).toBe(1));
    expect(
      (log.lastCommitBody as { selectedProviderNames?: string[] }).selectedProviderNames,
    ).toEqual(['claude']);
  });
});

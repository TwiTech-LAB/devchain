import { useEffect, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { useImportProjectWizard, useUpgradeProjectWizard } from './useImportProjectWizard';
import type {
  ImportDryRunResponse,
  ImportProjectResponse,
  SetupPreviewResponse,
} from '@/ui/pages/projects/lib/project-contracts';
import { InMemoryProjectsPageApi } from '../../../test/helpers/in-memory-projects-page-api';
import type { PromptReferenceValidationFailure } from '@/common/prompt-references';

(global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = jest.fn();

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

function configuredPreview(): SetupPreviewResponse {
  return {
    payload: {
      description: 'target-only marker',
      profiles: [
        {
          id: 'profile-1',
          name: 'Coder',
          provider: { name: 'claude' },
          providerConfigs: [{ name: 'claude-config', providerName: 'claude', env: {} }],
        },
      ],
      agents: [{ name: 'Captain', profileId: 'profile-1', providerConfigName: 'claude-config' }],
      teams: [
        {
          name: 'Target Team',
          teamLeadAgentName: 'Captain',
          memberAgentNames: [],
          allowTeamLeadCreateAgents: true,
          profileNames: ['Coder'],
        },
      ],
      presets: [
        {
          name: 'Target Default',
          agentConfigs: [{ agentName: 'Captain', providerConfigName: 'claude-config' }],
        },
      ],
    } as unknown as SetupPreviewResponse['payload'],
    providerSummary: [{ name: 'claude', available: true, families: [], agentCount: 1 }],
    familyAlternatives: [],
    presetProviderCoverage: [
      {
        presetName: 'Target Default',
        referencedProviders: ['claude'],
        coversAllAgents: true,
        coveredAgentNames: ['Captain'],
        agentResolvedProviders: { Captain: 'claude' },
      },
    ],
    localAvailability: { installedProviders: [{ id: 'provider-1', name: 'claude' }] },
  };
}

function mockApi(opts: {
  previewResponse?: SetupPreviewResponse;
  dryRunResponse?: ImportDryRunResponse;
  commitResponse?: ImportProjectResponse;
}): InMemoryProjectsPageApi {
  return new InMemoryProjectsPageApi({
    setupPreview: opts.previewResponse ?? preview(),
    importDryRunResult: opts.dryRunResponse ?? {
      dryRun: true,
      missingProviders: [],
      counts: { toImport: { agents: 1 }, toDelete: {} },
    },
    importResult: opts.commitResponse ?? {
      success: true,
      counts: { imported: {}, deleted: {} },
      mappings: {},
    },
  });
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const TARGET = { id: 'proj-1', name: 'My Project' };
const PROMPT_PREFLIGHT_FAILURE: PromptReferenceValidationFailure = {
  success: false,
  mutationStarted: false,
  error: 'Template profiles reference excluded prompts',
  promptReferenceValidation: {
    code: 'skipped_prompt_references',
    promptTitles: ['Private SOP'],
    issues: [{ promptTitle: 'Private SOP', profileNames: ['Coder'] }],
  },
};

describe('useImportProjectWizard', () => {
  it('loads the setup-preview, runs the dry-run on Review, and commits on submit', async () => {
    const api = mockApi({});
    const onImported = jest.fn();
    const { result } = renderHook(
      () => useImportProjectWizard({ onImported, toast: jest.fn(), api }),
      {
        wrapper,
      },
    );

    act(() => result.current.openImportWizard(TARGET, { slug: 'demo' }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(api.calls.loadSetupPreview).toHaveLength(1);

    // Providers → Agents (Teams skipped: no configurable team) → Review.
    act(() => result.current.controller.goNext());
    act(() => result.current.controller.goNext());
    await waitFor(() => expect(result.current.controller.currentStep?.id).toBe('review'));

    // Dry-run fires on entering Review; the final step then becomes proceedable.
    await waitFor(() => expect(api.calls.runImportDryRun).toHaveLength(1));
    await waitFor(() => expect(result.current.controller.canProceed).toBe(true));
    expect(result.current.controller.isLastStep).toBe(true);

    // Submit → destructive commit → onImported + wizard closes.
    await act(async () => {
      result.current.controller.submit();
    });
    await waitFor(() => expect(api.calls.commitImport).toHaveLength(1));
    expect(onImported).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    await waitFor(() => expect(result.current.isOpen).toBe(false));
  });

  it('blocks the final Import until every unmatched status is mapped', async () => {
    const api = mockApi({
      dryRunResponse: {
        dryRun: true,
        missingProviders: [],
        counts: { toImport: {}, toDelete: {} },
        unmatchedStatuses: [{ id: 's1', label: 'Backlog', color: '#111', epicCount: 2 }],
        templateStatuses: [{ label: 'Todo', color: '#222' }],
      },
    });
    const { result } = renderHook(
      () => useImportProjectWizard({ onImported: jest.fn(), toast: jest.fn(), api }),
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

  it('keeps dry-run failures out of the counts review and displays their details', async () => {
    const api = mockApi({
      dryRunResponse: {
        ...PROMPT_PREFLIGHT_FAILURE,
        dryRun: true,
        readiness: {
          ready: false,
          issues: [
            {
              code: 'prompt_reference_validation',
              message: PROMPT_PREFLIGHT_FAILURE.error,
              details: PROMPT_PREFLIGHT_FAILURE.promptReferenceValidation,
            },
          ],
        },
        missingProviders: [],
        counts: { toImport: { agents: 1 }, toDelete: { statuses: 0 } },
      },
    });
    const toast = jest.fn();
    let wizard: ReturnType<typeof useImportProjectWizard> | null = null;

    function Harness() {
      const hook = useImportProjectWizard({ onImported: jest.fn(), toast, api });
      wizard = hook;
      useEffect(() => hook.openImportWizard(TARGET, { slug: 'demo' }), []);
      return <>{hook.controller.currentStep?.render()}</>;
    }

    render(<Harness />, { wrapper });
    await waitFor(() => expect(wizard?.isLoading).toBe(false));
    act(() => wizard!.controller.goNext());
    act(() => wizard!.controller.goNext());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Import blocked before making changes',
    );
    expect(screen.getByRole('alert')).toHaveTextContent('"Private SOP" (profiles: Coder)');
    expect(screen.getByTestId('wizard-review-import-counts')).toHaveTextContent('agents1');
    expect(api.calls.runImportDryRun).toHaveLength(1);
    expect(wizard!.controller.canProceed).toBe(false);
    expect(wizard!.isOpen).toBe(true);
  });

  it('keeps the wizard open and skips completion when commit returns a structured failure', async () => {
    const api = mockApi({ commitResponse: PROMPT_PREFLIGHT_FAILURE });
    const onImported = jest.fn();
    const toast = jest.fn();
    const { result } = renderHook(() => useImportProjectWizard({ onImported, toast, api }), {
      wrapper,
    });

    act(() => result.current.openImportWizard(TARGET, { slug: 'demo' }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => result.current.controller.goNext());
    act(() => result.current.controller.goNext());
    await waitFor(() => expect(result.current.controller.canProceed).toBe(true));

    await act(async () => result.current.controller.submit());
    await waitFor(() => expect(api.calls.commitImport).toHaveLength(1));

    expect(result.current.isOpen).toBe(true);
    expect(result.current.preflightFailure).toEqual(PROMPT_PREFLIGHT_FAILURE);
    expect(onImported).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Import failed',
        description: expect.stringContaining('"Private SOP" (profiles: Coder)'),
        variant: 'destructive',
      }),
    );
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Import complete' }));
  });

  it('includes selectedProviderNames + status mappings in the request bodies', async () => {
    // Preview with an available provider summary.
    const previewWithProvider: SetupPreviewResponse = {
      ...preview(),
      providerSummary: [{ name: 'claude', available: true, families: [], agentCount: 0 }],
    };
    const api = mockApi({
      previewResponse: previewWithProvider,
      dryRunResponse: {
        dryRun: true,
        missingProviders: [],
        counts: { toImport: {}, toDelete: { statuses: 1 } },
        unmatchedStatuses: [{ id: 'status-1', label: 'Backlog', color: '#111', epicCount: 2 }],
        templateStatuses: [{ label: 'Todo', color: '#222' }],
      },
    });

    // Render the Providers step body so the (no longer preselected) provider can be clicked;
    // later steps are driven purely through the captured controller.
    let wiz: ReturnType<typeof useImportProjectWizard> | null = null;
    function Harness() {
      const hook = useImportProjectWizard({
        onImported: jest.fn(),
        toast: jest.fn(),
        api,
      });
      wiz = hook;
      useEffect(() => {
        hook.openImportWizard(TARGET, { slug: 'demo' });
      }, []);
      return <div>{hook.controller.currentStep?.render()}</div>;
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
    await waitFor(() => expect(api.calls.runImportDryRun.length).toBeGreaterThanOrEqual(1));
    fireEvent.click(await screen.findByTestId('wizard-status-map-status-1'));
    fireEvent.click(await screen.findByRole('option', { name: /Todo/ }));
    await waitFor(() => expect(wiz!.controller.canProceed).toBe(true));

    await act(async () => {
      wiz!.controller.submit();
    });
    await waitFor(() => expect(api.calls.commitImport).toHaveLength(1));
    const commitBody = api.calls.commitImport.at(-1)?.[1];
    expect((commitBody as { selectedProviderNames?: string[] }).selectedProviderNames).toEqual([
      'claude',
    ]);
    expect((commitBody as { statusMappings?: Record<string, string> }).statusMappings).toEqual({
      'status-1': 'Todo',
    });
  });
});

describe('useUpgradeProjectWizard', () => {
  it('uses target preview, replace dry-run, and source-aligned configured commit adapters', async () => {
    const api = new InMemoryProjectsPageApi({
      upgradePreview: configuredPreview(),
      importDryRunResult: {
        dryRun: true,
        readiness: { ready: true, issues: [] },
        missingProviders: [],
        counts: { toImport: { agents: 0 }, toDelete: { statuses: 0 } },
      },
      upgradeResult: { success: true, newVersion: '2.0.0' },
    });
    const onFinished = jest.fn();
    const onClosed = jest.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    const upgradeWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () =>
        useUpgradeProjectWizard({
          actionName: 'Upgrade',
          onFinished,
          onClosed,
          toast: jest.fn(),
          api,
        }),
      { wrapper: upgradeWrapper },
    );

    act(() =>
      result.current.openUpgradeWizard({
        id: 'proj-1',
        name: 'My Project',
        targetVersion: '2.0.0',
      }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(api.calls.loadUpgradePreview).toEqual([['proj-1', '2.0.0']]);

    act(() => result.current.controller.goNext());
    act(() => result.current.controller.goNext());
    act(() => result.current.controller.goNext());
    await waitFor(() => expect(result.current.controller.currentStep?.id).toBe('review'));
    await waitFor(() => expect(result.current.controller.canProceed).toBe(true));
    expect(api.calls.runImportDryRun[0]?.[1]).toEqual(
      expect.objectContaining({ description: 'target-only marker' }),
    );

    await act(async () => result.current.controller.submit());
    await waitFor(() =>
      expect(onFinished).toHaveBeenCalledWith({ success: true, newVersion: '2.0.0' }),
    );
    const commitBody = api.calls.commitUpgrade[0]?.[1];
    expect(commitBody).toEqual(
      expect.objectContaining({
        targetVersion: '2.0.0',
        selectedProviderNames: ['claude'],
        presetName: 'Target Default',
        teamOverrides: [
          expect.objectContaining({ teamName: 'Target Team', allowTeamLeadCreateAgents: true }),
        ],
      }),
    );
    expect(commitBody).not.toHaveProperty('agentOverrides');
    expect(commitBody).not.toHaveProperty('description');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['projects'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['templates-for-upgrade'] });
  });

  it('shows readiness issues with counts and blocks final confirmation', async () => {
    const api = new InMemoryProjectsPageApi({
      upgradePreview: preview(),
      importDryRunResult: {
        dryRun: true,
        success: false,
        mutationStarted: false,
        error: 'Active sessions block replacement',
        readiness: {
          ready: false,
          issues: [
            {
              code: 'active_sessions',
              message: 'Stop active sessions before replacing this project.',
              details: { activeSessions: [{ id: 'session-1', agentId: null }] },
            },
          ],
        },
        missingProviders: [],
        counts: { toImport: { agents: 2 }, toDelete: { statuses: 1 } },
      },
    });
    let wizard: ReturnType<typeof useUpgradeProjectWizard> | null = null;
    function Harness() {
      const hook = useUpgradeProjectWizard({
        actionName: 'Upgrade',
        onFinished: jest.fn(),
        onClosed: jest.fn(),
        toast: jest.fn(),
        api,
      });
      wizard = hook;
      useEffect(() => {
        hook.openUpgradeWizard({ id: 'proj-1', name: 'My Project', targetVersion: '2.0.0' });
      }, []);
      return <>{hook.controller.currentStep?.render()}</>;
    }
    render(<Harness />, { wrapper });
    await waitFor(() => expect(wizard?.isLoading).toBe(false));
    act(() => wizard!.controller.goNext());
    act(() => wizard!.controller.goNext());

    expect(await screen.findByRole('alert')).toHaveTextContent(/Stop active sessions/);
    expect(screen.getByTestId('wizard-review-import-counts')).toHaveTextContent('agents2');
    expect(wizard!.controller.canProceed).toBe(false);
  });

  it('invalidates upgrade discovery queries when canceled', async () => {
    const api = new InMemoryProjectsPageApi({ upgradePreview: preview() });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    const onClosed = jest.fn();
    const upgradeWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () =>
        useUpgradeProjectWizard({
          actionName: 'Upgrade',
          onFinished: jest.fn(),
          onClosed,
          toast: jest.fn(),
          api,
        }),
      { wrapper: upgradeWrapper },
    );

    act(() =>
      result.current.openUpgradeWizard({
        id: 'proj-1',
        name: 'My Project',
        targetVersion: '2.0.0',
      }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => result.current.controller.cancel());

    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['projects'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['templates-for-upgrade'] });
  });
});

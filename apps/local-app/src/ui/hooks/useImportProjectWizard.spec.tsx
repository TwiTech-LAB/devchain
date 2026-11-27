import { useEffect, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { useImportProjectWizard, useUpgradeProjectWizard } from './useImportProjectWizard';
import type {
  ImportDryRunResponse,
  ImportProjectResponse,
  SetupPreviewResponse,
} from '@/ui/pages/projects/lib/project-contracts';
import { InMemoryProjectsPageApi } from '../../../test/helpers/in-memory-projects-page-api';
import type { ExportData } from '@devchain/shared';
import type { PreservationReview, PreserveTeamSetup } from '@/common/project-preservation.contract';
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
  it('loads the setup-preview, runs the precheck once on open, and commits on submit', async () => {
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

    // One page: the precheck runs as soon as it opens, then the final action is allowed.
    expect(result.current.controller.visibleSteps).toHaveLength(1);
    await waitFor(() => expect(result.current.controller.canProceed).toBe(true));
    expect(api.calls.runImportDryRun).toHaveLength(1);

    // Submit → destructive commit → onImported + wizard closes.
    await act(async () => {
      result.current.controller.submit();
    });
    await waitFor(() => expect(api.calls.commitImport).toHaveLength(1));
    expect(onImported).toHaveBeenCalledWith(expect.objectContaining({ success: true }), TARGET);
    await waitFor(() => expect(result.current.isOpen).toBe(false));

    // A home target sends today's requests to home.
    expect(api.calls.loadSetupPreview).toEqual([[{ slug: 'demo' }]]);
    expect(api.calls.readHomeTemplateContent).toEqual([]);
    expect(api.backends.loadSetupPreview).toEqual(['home']);
    expect(api.backends.runImportDryRun).toEqual(['home']);
    expect(api.backends.commitImport).toEqual(['home']);
  });

  it.each([
    {
      source: 'template',
      request: { slug: 'demo', version: '1.2.0' },
      vmRequest: { rawContent: { marker: 'home-template' } },
      homeReads: [['demo', '1.2.0']],
    },
    {
      source: 'file',
      request: { rawContent: { marker: 'file' } },
      vmRequest: { rawContent: { marker: 'file' } },
      homeReads: [],
    },
  ])(
    'sends the $source preview content, the dry run and the commit to the VM of a remote target',
    async ({ request, vmRequest, homeReads }) => {
      const api = new InMemoryProjectsPageApi({
        setupPreview: preview(),
        templateContents: { demo: { marker: 'home-template' } },
        importDryRunResult: {
          dryRun: true,
          missingProviders: [],
          counts: { toImport: { agents: 1 }, toDelete: {} },
        },
        importResult: { success: true, counts: { imported: {}, deleted: {} }, mappings: {} },
      });
      const onImported = jest.fn();
      const remoteTarget = { ...TARGET, backend: 'remote-1' };
      const { result } = renderHook(
        () => useImportProjectWizard({ onImported, toast: jest.fn(), api }),
        { wrapper },
      );

      act(() => result.current.openImportWizard(remoteTarget, request));
      await waitFor(() => expect(result.current.controller.canProceed).toBe(true));
      await act(async () => result.current.controller.submit());
      await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));

      expect(api.calls.readHomeTemplateContent).toEqual(homeReads);
      expect(api.calls.loadSetupPreview).toEqual([[vmRequest]]);
      expect(api.backends.loadSetupPreview).toEqual(['remote-1']);
      expect(api.backends.loadProjectExport).toEqual(['remote-1']);
      expect(api.backends.runImportDryRun).toEqual(['remote-1']);
      expect(api.backends.commitImport).toEqual(['remote-1']);
      expect(onImported).toHaveBeenCalledWith(
        expect.objectContaining({ success: true }),
        remoteTarget,
      );
    },
  );

  it.each(['import', 'upgrade'] as const)(
    'exposes the message of a failed %s preview',
    async (flow) => {
      const failure = new Error('Remote "vm-1" is offline');
      const api = new InMemoryProjectsPageApi({
        overrides: { loadSetupPreview: failure, loadUpgradePreview: failure },
      });
      const { result } = renderHook(
        () =>
          flow === 'import'
            ? useImportProjectWizard({ onImported: jest.fn(), toast: jest.fn(), api })
            : useUpgradeProjectWizard({
                actionName: 'Upgrade',
                onFinished: jest.fn(),
                onClosed: jest.fn(),
                toast: jest.fn(),
                api,
              }),
        { wrapper },
      );

      act(() => {
        const wizard = result.current;
        if ('openImportWizard' in wizard) wizard.openImportWizard(TARGET, { slug: 'demo' });
        else wizard.openUpgradeWizard({ ...TARGET, targetVersion: '2.0.0' });
      });
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.errorMessage).toBe('Remote "vm-1" is offline');
    },
  );

  it('ignores a precheck result that belongs to an earlier opening', async () => {
    // Project A's precheck is slow and fails; project B's is fast and passes. A's late result
    // must not replace B's.
    const blocked: ImportDryRunResponse = {
      dryRun: true,
      success: false,
      mutationStarted: false,
      error: 'Active sessions block replacement',
      missingProviders: [],
      counts: { toImport: { agents: 9 }, toDelete: {} },
    };
    const ready: ImportDryRunResponse = {
      dryRun: true,
      missingProviders: [],
      counts: { toImport: { agents: 1 }, toDelete: {} },
    };
    let finishA: (value: ImportDryRunResponse) => void = () => undefined;
    const slowA = new Promise<ImportDryRunResponse>((resolve) => {
      finishA = resolve;
    });
    const api = new InMemoryProjectsPageApi({
      setupPreview: preview(),
      overrides: { runImportDryRun: (projectId) => (projectId === 'proj-a' ? slowA : ready) },
    });
    const { result } = renderHook(
      () => useImportProjectWizard({ onImported: jest.fn(), toast: jest.fn(), api }),
      { wrapper },
    );

    act(() => result.current.openImportWizard({ id: 'proj-a', name: 'A' }, { slug: 'demo' }));
    await waitFor(() => expect(api.calls.runImportDryRun).toHaveLength(1));
    act(() => result.current.onOpenChange(false));
    act(() => result.current.openImportWizard({ id: 'proj-b', name: 'B' }, { slug: 'demo' }));
    await waitFor(() => expect(result.current.controller.canProceed).toBe(true));

    await act(async () => {
      finishA(blocked);
      await slowA;
    });
    expect(result.current.controller.canProceed).toBe(true);
    expect(result.current.preflightFailure).toBeNull();
  });

  // The rendered import flow verifies that the reset starts a precheck with the displayed values.
  it('checks a manual agent choice and clears it with Reset', async () => {
    const target = configuredPreview();
    const options = target.payload.profiles![0].providerConfigs!;
    options.push({
      name: 'codex-config',
      providerName: 'codex',
      env: {},
    });
    const [defaultOption, codexOption] = options;
    target.localAvailability.installedProviders.push({ id: 'provider-2', name: 'codex' });
    target.payload.presets = [];
    target.presetProviderCoverage = [];
    const api = mockApi({ previewResponse: target });
    let wizard: ReturnType<typeof useImportProjectWizard> | null = null;
    function Harness() {
      const hook = useImportProjectWizard({ onImported: jest.fn(), toast: jest.fn(), api });
      wizard = hook;
      useEffect(() => hook.openImportWizard(TARGET, { slug: 'demo' }), []);
      return <>{hook.controller.currentStep?.render()}</>;
    }
    render(<Harness />, { wrapper });
    await waitFor(() => expect(wizard!.controller.canProceed).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: /^Captain: / }));
    fireEvent.click(await screen.findByRole('combobox', { name: 'Captain provider' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Codex' }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    expect(
      await screen.findByRole('button', { name: `Captain: Codex · ${codexOption.name}` }),
    ).toBeVisible();
    await waitFor(() => expect(api.calls.runImportDryRun).toHaveLength(2));
    expect(api.calls.runImportDryRun.at(-1)?.[1]).toMatchObject({
      selectedProviderNames: ['claude'],
      agentOverrides: [
        expect.objectContaining({ agentName: 'Captain', providerConfigName: codexOption.name }),
      ],
    });

    expect(screen.getByText('No ready-made setup fits the selected providers.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Reset setup' }));

    expect(
      await screen.findByRole('button', { name: `Captain: Claude · ${defaultOption.name}` }),
    ).toBeVisible();
    await waitFor(() => expect(api.calls.runImportDryRun).toHaveLength(3));
    expect(api.calls.runImportDryRun.at(-1)?.[1]).not.toHaveProperty('agentOverrides');
  });

  it('allows Import with an unmatched status and omits status mappings', async () => {
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
    await waitFor(() => expect(result.current.controller.canProceed).toBe(true));
    await act(async () => result.current.controller.submit());
    expect(api.calls.runImportDryRun[0][1]).not.toHaveProperty('statusMappings');
    expect(api.calls.commitImport).toHaveLength(1);
    expect(api.calls.commitImport[0][1]).not.toHaveProperty('statusMappings');
  });

  it('shows prompt reference details and a retry action in one precheck alert', async () => {
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

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Import blocked before making changes');
    expect(alert).toHaveTextContent('"Private SOP" (profiles: Coder)');
    expect(within(alert).getByRole('button', { name: 'Check again' })).toBeEnabled();
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

  it('includes the selected providers in precheck and commit requests', async () => {
    // claude is installed and referenced by a template profile, so it is the selected provider.
    const previewWithProvider: SetupPreviewResponse = {
      ...preview({ profiles: [{ name: 'Coder', provider: { name: 'claude' } }] }),
      localAvailability: { installedProviders: [{ id: 'provider-1', name: 'claude' }] },
    };
    const api = mockApi({ previewResponse: previewWithProvider });
    const { result } = renderHook(
      () => useImportProjectWizard({ onImported: jest.fn(), toast: jest.fn(), api }),
      { wrapper },
    );

    act(() => result.current.openImportWizard(TARGET, { slug: 'demo' }));
    await waitFor(() => expect(result.current.controller.canProceed).toBe(true));
    await act(async () => result.current.controller.submit());
    await waitFor(() => expect(api.calls.commitImport).toHaveLength(1));
    for (const body of [api.calls.runImportDryRun[0][1], api.calls.commitImport[0][1]]) {
      expect(body).toMatchObject({ selectedProviderNames: ['claude'] });
      expect(body).not.toHaveProperty('statusMappings');
    }
  });
});

describe('setup review provider catalogs', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it.each([
    { flow: 'Import', backend: undefined, prefix: '' },
    { flow: 'Import', backend: 'remote-1', prefix: '/r/remote-1' },
    { flow: 'Upgrade', backend: 'remote-1', prefix: '/r/remote-1' },
  ] as const)(
    '$flow with target backend $backend reads the catalogs from it',
    async ({ flow, backend, prefix }) => {
      const fetchMock = jest.fn(
        async (_input: RequestInfo | URL) =>
          ({ ok: true, json: async () => [] }) as unknown as Response,
      );
      global.fetch = fetchMock as unknown as typeof fetch;
      const api = new InMemoryProjectsPageApi({
        setupPreview: configuredPreview(),
        upgradePreview: configuredPreview(),
        templateContents: { demo: {} },
      });
      const target = { ...TARGET, ...(backend ? { backend } : {}) };
      function Harness() {
        const importWizard = useImportProjectWizard({
          onImported: jest.fn(),
          toast: jest.fn(),
          api,
        });
        const upgradeWizard = useUpgradeProjectWizard({
          actionName: 'Upgrade',
          onFinished: jest.fn(),
          onClosed: jest.fn(),
          toast: jest.fn(),
          api,
        });
        const wizard = flow === 'Import' ? importWizard : upgradeWizard;
        useEffect(() => {
          if (flow === 'Import') importWizard.openImportWizard(target, { slug: 'demo' });
          else upgradeWizard.openUpgradeWizard({ ...target, targetVersion: '2.0.0' });
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, []);
        return <>{wizard.controller.currentStep?.render()}</>;
      }
      render(<Harness />, { wrapper });

      await waitFor(() =>
        expect(fetchMock.mock.calls.map(([url]) => String(url)).sort()).toEqual([
          `${prefix}/api/providers/provider-1/efforts`,
          `${prefix}/api/providers/provider-1/models`,
        ]),
      );
    },
  );
});

describe('useUpgradeProjectWizard', () => {
  it.each(['Upgrade', 'Update'] as const)(
    'uses the target preview and commits the checked setup for %s',
    async (actionName) => {
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
            actionName,
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

      await waitFor(() => expect(result.current.controller.canProceed).toBe(true));
      expect(api.calls.runImportDryRun[0]?.[1]).toEqual(
        expect.objectContaining({ description: 'target-only marker' }),
      );
      expect(api.calls.runImportDryRun[0]?.[1]).not.toHaveProperty('statusMappings');

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
      expect(commitBody).not.toHaveProperty('statusMappings');
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['projects'] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['templates-for-upgrade'] });
    },
  );

  it('shows a failed precheck inline without a toast and unblocks after Check again', async () => {
    const activeSessions: ImportDryRunResponse = {
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
    };
    const ready: ImportDryRunResponse = {
      dryRun: true,
      readiness: { ready: true, issues: [] },
      missingProviders: [],
      counts: { toImport: { agents: 2 }, toDelete: { statuses: 1 } },
    };
    const responses = [activeSessions, ready];
    const api = new InMemoryProjectsPageApi({
      upgradePreview: preview(),
      overrides: { runImportDryRun: () => responses.shift()! },
    });
    const toast = jest.fn();
    let wizard: ReturnType<typeof useUpgradeProjectWizard> | null = null;
    function Harness() {
      const hook = useUpgradeProjectWizard({
        actionName: 'Upgrade',
        onFinished: jest.fn(),
        onClosed: jest.fn(),
        toast,
        api,
      });
      wizard = hook;
      useEffect(() => {
        hook.openUpgradeWizard({ id: 'proj-1', name: 'My Project', targetVersion: '2.0.0' });
      }, []);
      return <>{hook.controller.currentStep?.render()}</>;
    }
    render(<Harness />, { wrapper });

    expect(await screen.findByRole('alert')).toHaveTextContent(/Stop active sessions/);
    expect(wizard!.controller.canProceed).toBe(false);
    expect(toast).not.toHaveBeenCalled();

    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Check again' }));

    await waitFor(() => expect(wizard!.controller.canProceed).toBe(true));
    expect(api.calls.runImportDryRun).toHaveLength(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(toast).not.toHaveBeenCalled();
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

// Render the review and submit through the hook so input, readiness, and request bodies stay linked.
describe('useUpgradeProjectWizard — keep my current setup', () => {
  const UPGRADE_TARGET = { ...TARGET, targetVersion: '2.0.0', backend: 'remote-1' };
  const team = {
    name: 'Planning',
    retained: true,
    teamLeadAgentName: 'Lead',
    memberAgentNames: ['Lead', 'Analyst', 'Scribe'],
    maxMembers: 8,
    maxConcurrentTasks: 5,
    allowTeamLeadCreateAgents: false,
    permissions: [{ profileName: 'Coder', configNames: ['claude-config'] }],
    permissionsChanged: false,
  };
  const option = { configName: 'claude-config', providerName: 'claude' };
  const ready: ImportDryRunResponse = {
    dryRun: true,
    readiness: { ready: true, issues: [] },
    missingProviders: [],
    counts: { toImport: {}, toDelete: {} },
  };
  const currentExport = {
    ...preview().payload,
    agents: [
      { name: 'Lead', description: 'Current lead description' },
      { name: 'Analyst', description: '   ' },
      { name: 'Scribe' },
      { name: 'Retired' },
    ],
    teams: [
      {
        name: team.name,
        description: 'Current planning team',
        memberAgentNames: team.memberAgentNames,
      },
    ],
  } as ExportData;

  function plan(): PreservationReview {
    return {
      agents: team.memberAgentNames.map((name) => ({
        name,
        profileName: 'Coder',
        status: 'kept',
        currentOption: option,
        option,
        eligibleOptions: [option],
        model: { value: 'retained-model', source: 'retained' },
        effort: { value: 'high', source: 'template-option' },
      })),
      teams: [team],
      familyAlternatives: [
        {
          familySlug: 'planning',
          defaultProvider: 'claude',
          defaultProviderAvailable: true,
          hasAlternatives: true,
          availableProviders: ['claude'],
        },
      ],
      eligiblePermissions: [{ profileName: 'Coder', options: [option] }],
      additions: {
        teams: [
          {
            name: 'Research',
            teamLeadAgentName: 'Scout',
            memberAgentNames: ['Scout'],
            selected: false,
          },
        ],
        members: [{ teamName: 'Planning', agentName: 'Extra', selected: false }],
      },
    };
  }

  /** A plan row for an agent that the roster gains: it has no current option. */
  function newAgent(base: PreservationReview['agents'][number], name: string) {
    return { ...base, name, status: 'new' as const, currentOption: null, reason: undefined };
  }

  function renderUpgrade(api: InMemoryProjectsPageApi) {
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
      useEffect(() => hook.openUpgradeWizard(UPGRADE_TARGET), []);
      return <>{hook.controller.currentStep?.render()}</>;
    }
    render(<Harness />, { wrapper });
    return () => wizard!;
  }

  it('shows automatic replacements, grouped agents and removals while keeping additions optional', async () => {
    const reviewed = plan();
    reviewed.teams = [{ ...team, permissionsChanged: true }];
    reviewed.agents[2] = {
      ...reviewed.agents[2],
      status: 'changed',
      reason: 'option_changed',
      currentOption: { configName: 'old-option', providerName: 'claude' },
    };
    reviewed.agents.reverse();
    reviewed.agents.push(newAgent(reviewed.agents[0], 'Courier'));
    const withMember = {
      ...reviewed,
      teams: [{ ...reviewed.teams[0], memberAgentNames: [...team.memberAgentNames, 'Extra'] }],
      agents: [...reviewed.agents, newAgent(reviewed.agents[0], 'Extra')],
    };
    const withTeam = {
      ...withMember,
      teams: [
        ...withMember.teams,
        {
          ...team,
          retained: false,
          name: 'Research',
          teamLeadAgentName: 'Scout',
          memberAgentNames: ['Scout'],
        },
      ],
      agents: [...withMember.agents, newAgent(withMember.agents[0], 'Scout')],
    };
    const runImportDryRun = jest
      .fn()
      .mockResolvedValueOnce({ ...ready, preservationPlan: reviewed })
      .mockResolvedValueOnce({ ...ready, preservationPlan: withMember })
      .mockResolvedValueOnce({ ...ready, preservationPlan: withTeam });
    const upgradePreview = configuredPreview();
    upgradePreview.payload = {
      ...upgradePreview.payload,
      agents: [
        ...(upgradePreview.payload.agents ?? []),
        { name: 'Scribe', description: 'Template scribe description' },
        { name: 'Courier', description: 'Template courier description' },
      ],
      teams: [
        ...(upgradePreview.payload.teams ?? []),
        { name: 'Research', description: 'Template research team', memberAgentNames: ['Scout'] },
      ],
    } as ExportData;
    const api = new InMemoryProjectsPageApi({
      upgradePreview,
      projectExport: currentExport,
      upgradeResult: { success: true, newVersion: '2.0.0' },
      overrides: { runImportDryRun },
    });
    const getWizard = renderUpgrade(api);

    expect(await screen.findByRole('radio', { name: /Keep my current setup/ })).toBeChecked();
    const rosterSection = await screen.findByRole('region', { name: 'Teams and agents' });
    const planning = within(rosterSection).getByRole('region', { name: 'Planning' });
    expect(
      within(planning)
        .getAllByRole('listitem')
        .map((row) => row.textContent),
    ).toEqual([
      expect.stringMatching(/^Lead/),
      expect.stringMatching(/^Analyst/),
      expect.stringMatching(/^ScribeChanged/),
    ]);
    // The fixture's lead is named "Lead", so the badge is found by its test id, not its text.
    expect(
      within(planning)
        .getAllByRole('listitem')
        .filter((row) => within(row).queryByTestId('wizard-lead-badge'))
        .map((row) => row.textContent),
    ).toEqual([expect.stringMatching(/^Lead/)]);
    expect(within(planning).getByText('Current planning team')).toBeVisible();
    expect(within(planning).getByText('Current lead description')).toBeVisible();
    expect(within(planning).queryByText('Template scribe description')).not.toBeInTheDocument();
    expect(
      within(planning).getByText('Some allowed options are not in this template.'),
    ).toBeVisible();
    const independent = within(rosterSection).getByRole('region', { name: 'Independent' });
    expect(within(independent).getByText('Courier')).toBeVisible();
    expect(within(independent).getByText('Template courier description')).toBeVisible();
    expect(screen.getByText(/Scribe \(old-option → claude-config\)/)).toBeVisible();
    expect(screen.getByText('Retired', { exact: false })).toHaveTextContent('Removed: Retired');
    expect(getWizard().controller.canProceed).toBe(true);
    expect(api.calls.runImportDryRun[0][1]).toMatchObject({ preserveTeamSetup: {} });

    const addMember = screen.getByRole('checkbox', { name: 'Add Extra to Planning' });
    const addTeam = screen.getByRole('checkbox', { name: 'Add team Research' });
    expect(addMember).not.toBeChecked();
    expect(addTeam).not.toBeChecked();
    fireEvent.click(addMember);
    expect(
      await screen.findByRole('button', { name: 'Extra: Claude · claude-config' }),
    ).toBeVisible();
    fireEvent.click(addTeam);
    const research = await screen.findByRole('region', { name: 'Research' });
    expect(within(research).getByText('Template research team')).toBeVisible();
    expect(within(research).getByText('Scout')).toBeVisible();

    await waitFor(() => expect(getWizard().controller.canProceed).toBe(true));
    await act(async () => getWizard().controller.submit());

    expect(api.calls.commitUpgrade).toEqual([
      [
        'proj-1',
        {
          targetVersion: '2.0.0',
          selectedProviderNames: ['claude'],
          preserveTeamSetup: {
            addTeams: ['Research'],
            addMembers: [{ teamName: 'Planning', agentName: 'Extra' }],
          },
        },
      ],
    ]);
    expect(api.backends.commitUpgrade).toEqual(['remote-1']);
  });

  it('checks a team that the server selected and sends an empty list when the user clears it', async () => {
    const selected = plan();
    selected.additions.teams[0].selected = true;
    const runImportDryRun = jest
      .fn()
      .mockResolvedValueOnce({ ...ready, preservationPlan: selected })
      .mockResolvedValueOnce({ ...ready, preservationPlan: plan() });
    const api = new InMemoryProjectsPageApi({
      upgradePreview: configuredPreview(),
      projectExport: currentExport,
      upgradeResult: { success: true, newVersion: '2.0.0' },
      overrides: { runImportDryRun },
    });
    renderUpgrade(api);

    const addTeam = await screen.findByRole('checkbox', { name: 'Add team Research' });
    expect(addTeam).toBeChecked();
    expect(api.calls.runImportDryRun[0][1]).toMatchObject({ preserveTeamSetup: {} });

    fireEvent.click(addTeam);
    await waitFor(() => expect(api.calls.runImportDryRun).toHaveLength(2));
    expect(api.calls.runImportDryRun[1][1]).toMatchObject({ preserveTeamSetup: { addTeams: [] } });
    expect(screen.getByRole('checkbox', { name: 'Add team Research' })).not.toBeChecked();
  });

  it('requires a new result when switching to a preset and ignores the pending Keep result', async () => {
    let finishOld: (result: ImportDryRunResponse) => void = () => undefined;
    let finishNew: (result: ImportDryRunResponse) => void = () => undefined;
    const old = new Promise<ImportDryRunResponse>((resolve) => {
      finishOld = resolve;
    });
    const next = new Promise<ImportDryRunResponse>((resolve) => {
      finishNew = resolve;
    });
    const api = new InMemoryProjectsPageApi({
      upgradePreview: configuredPreview(),
      projectExport: currentExport,
      upgradeResult: { success: true, newVersion: '2.0.0' },
      overrides: { runImportDryRun: (_, body) => (body.preserveTeamSetup ? old : next) },
    });
    const getWizard = renderUpgrade(api);
    await waitFor(() => expect(api.calls.runImportDryRun).toHaveLength(1));

    expect(screen.queryByRole('combobox', { name: 'Ready-made setup' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /^Use the template setup/ }));
    await waitFor(() => expect(api.calls.runImportDryRun).toHaveLength(2));
    expect(screen.getByRole('combobox', { name: 'Ready-made setup' })).toHaveTextContent(
      'Target Default',
    );
    // A click on the checked card, or on its text, changes nothing.
    fireEvent.click(screen.getByRole('radio', { name: /^Use the template setup/ }));
    fireEvent.click(screen.getByText('Use the template setup'));
    await act(async () => undefined);
    expect(api.calls.runImportDryRun).toHaveLength(2);
    await act(async () => {
      finishOld({ ...ready, preservationPlan: plan() });
    });
    expect(getWizard().controller.canProceed).toBe(false);
    await act(async () => getWizard().controller.submit());
    expect(api.calls.commitUpgrade).toHaveLength(0);

    await act(async () => {
      finishNew(ready);
    });
    await waitFor(() => expect(getWizard().controller.canProceed).toBe(true));
    await act(async () => getWizard().controller.submit());
    expect(api.calls.commitUpgrade[0][1]).toMatchObject({ presetName: 'Target Default' });
    expect(api.calls.commitUpgrade[0][1]).not.toHaveProperty('preserveTeamSetup');
  });

  it('omits family mappings from Keep precheck and commit even when the default provider is absent', async () => {
    const preservationPlan = plan();
    preservationPlan.familyAlternatives[0] = {
      ...preservationPlan.familyAlternatives[0],
      defaultProvider: 'codex',
      defaultProviderAvailable: false,
    };
    const api = new InMemoryProjectsPageApi({
      upgradePreview: {
        ...configuredPreview(),
        familyAlternatives: preservationPlan.familyAlternatives,
      },
      projectExport: currentExport,
      upgradeResult: { success: true, newVersion: '2.0.0' },
      overrides: {
        runImportDryRun: () => ({ ...ready, preservationPlan }),
      },
    });
    const getWizard = renderUpgrade(api);
    await waitFor(() => expect(getWizard().controller.canProceed).toBe(true));
    await act(async () => getWizard().controller.submit());
    for (const body of [api.calls.runImportDryRun[0][1], api.calls.commitUpgrade[0][1]]) {
      expect(body).toMatchObject({ selectedProviderNames: ['claude'], preserveTeamSetup: {} });
      expect(body).not.toHaveProperty('familyProviderMappings');
      expect(body).not.toHaveProperty('statusMappings');
    }
  });

  it('replaces a provider mapping failure with an instruction to change providers', async () => {
    const api = new InMemoryProjectsPageApi({
      upgradePreview: configuredPreview(),
      projectExport: currentExport,
      importDryRunResult: {
        ...ready,
        preservationPlan: plan(),
        readiness: {
          ready: false,
          issues: [
            {
              code: 'provider_mapping_required',
              message: 'Provider selection requires a complete family mapping',
              details: { canImport: true },
            },
          ],
        },
      },
    });
    const getWizard = renderUpgrade(api);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'A selected provider cannot run one or more agents. Select another provider.',
    );
    expect(alert).not.toHaveTextContent('family mapping');
    expect(getWizard().controller.canProceed).toBe(false);
  });

  it('resets manual Keep options on provider changes and preserves the selection for template defaults', async () => {
    const target = configuredPreview();
    const codexOption = { configName: 'codex-config', providerName: 'codex' };
    target.payload.profiles![0].providerConfigs!.push({
      name: codexOption.configName,
      providerName: codexOption.providerName,
      env: {},
    });
    target.localAvailability.installedProviders.push({ id: 'provider-2', name: 'codex' });
    const projectExport: ExportData = {
      ...currentExport,
      profiles: target.payload.profiles,
      agents: currentExport.agents.map((agent) =>
        agent.name === 'Lead'
          ? { ...agent, profileId: 'profile-1', providerConfigName: codexOption.configName }
          : agent,
      ),
    };
    let finishProviderCheck: (result: ImportDryRunResponse) => void = () => undefined;
    const providerCheck = new Promise<ImportDryRunResponse>((resolve) => {
      finishProviderCheck = resolve;
    });
    function replacementPlan(selected = option) {
      const reviewed = plan();
      reviewed.agents[2] = {
        ...reviewed.agents[2],
        status: 'changed',
        reason: 'option_changed',
        currentOption: { configName: 'old-option', providerName: 'claude' },
        option: selected,
        eligibleOptions: [option, codexOption],
      };
      return reviewed;
    }
    const api = new InMemoryProjectsPageApi({
      upgradePreview: target,
      projectExport,
      upgradeResult: { success: true, newVersion: '2.0.0' },
      overrides: {
        runImportDryRun: (_, body) => {
          const choices = body.preserveTeamSetup as PreserveTeamSetup | undefined;
          if (!choices) return ready;
          if ((body.selectedProviderNames as string[]).length === 1) return providerCheck;
          const selected = choices.agentOptions?.length ? codexOption : option;
          return { ...ready, preservationPlan: replacementPlan(selected) };
        },
      },
    });
    const getWizard = renderUpgrade(api);

    expect(await screen.findByRole('checkbox', { name: 'Codex' })).toBeChecked();
    expect(screen.getByRole('radio', { name: /^Use the template setup/ })).not.toBeChecked();
    expect(screen.queryByRole('combobox', { name: 'Ready-made setup' })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Add team Research' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Add Extra to Planning' }));
    expect(await screen.findByText(/Scribe \(old-option → claude-config\)/)).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Scribe: Claude · claude-config' }));
    // A change of provider selects its first option, here codex-config.
    fireEvent.click(await screen.findByRole('combobox', { name: 'Scribe provider' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Codex' }));
    expect(
      await screen.findByRole('button', { name: 'Scribe: Codex · codex-config' }),
    ).toBeVisible();
    expect(screen.queryByText('Changed:')).not.toBeInTheDocument();
    expect(api.calls.runImportDryRun.at(-1)?.[1]).toMatchObject({
      preserveTeamSetup: { agentOptions: [{ agentName: 'Scribe', ...codexOption }] },
    });

    fireEvent.click(screen.getByRole('checkbox', { name: 'Claude' }));
    expect(screen.getByRole('radio', { name: /Keep my current setup/ })).toBeChecked();
    expect(screen.queryByRole('combobox', { name: 'Ready-made setup' })).not.toBeInTheDocument();
    expect(await screen.findByText('Checking project setup…')).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Planning' })).not.toBeInTheDocument();
    expect(getWizard().controller.canProceed).toBe(false);
    expect(api.calls.runImportDryRun.at(-1)?.[1]).toMatchObject({
      selectedProviderNames: ['codex'],
      preserveTeamSetup: {
        addTeams: ['Research'],
        addMembers: [{ teamName: 'Planning', agentName: 'Extra' }],
      },
    });
    expect(api.calls.runImportDryRun.at(-1)?.[1].preserveTeamSetup).not.toHaveProperty(
      'agentOptions',
    );
    await act(async () =>
      finishProviderCheck({ ...ready, preservationPlan: replacementPlan(codexOption) }),
    );

    fireEvent.click(screen.getByRole('radio', { name: /^Use the template setup/ }));
    await waitFor(() => expect(getWizard().controller.canProceed).toBe(true));
    expect(screen.getByRole('checkbox', { name: 'Codex' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Claude' })).not.toBeChecked();
    const templateRequest = api.calls.runImportDryRun.at(-1)?.[1];
    expect(templateRequest).toMatchObject({ selectedProviderNames: ['codex'] });
    expect(templateRequest).not.toHaveProperty('preserveTeamSetup');
    expect(templateRequest).not.toHaveProperty('presetName');
  });

  it('clears uncommitted additions and awaits a new check when reopening the same project', async () => {
    let finishLatest: (result: ImportDryRunResponse) => void = () => undefined;
    const latest = new Promise<ImportDryRunResponse>((resolve) => {
      finishLatest = resolve;
    });
    const reviewed = { ...ready, preservationPlan: plan() };
    const runImportDryRun = jest
      .fn()
      .mockResolvedValueOnce(reviewed)
      .mockResolvedValueOnce(reviewed)
      .mockReturnValueOnce(latest);
    const api = new InMemoryProjectsPageApi({
      upgradePreview: configuredPreview(),
      projectExport: currentExport,
      upgradeResult: { success: true, newVersion: '2.0.0' },
      overrides: { runImportDryRun },
    });
    const getWizard = renderUpgrade(api);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Add team Research' }));
    await waitFor(() => expect(getWizard().controller.canProceed).toBe(true));
    expect(api.calls.runImportDryRun.at(-1)?.[1]).toMatchObject({
      preserveTeamSetup: { addTeams: ['Research'] },
    });

    act(() => getWizard().onOpenChange(false));
    act(() => getWizard().openUpgradeWizard(UPGRADE_TARGET));
    await waitFor(() => expect(api.calls.runImportDryRun).toHaveLength(3));
    expect(getWizard().controller.canProceed).toBe(false);
    await act(async () => getWizard().controller.submit());
    expect(api.calls.commitUpgrade).toHaveLength(0);

    await act(async () => {
      finishLatest(reviewed);
    });
    expect(await screen.findByRole('checkbox', { name: 'Add team Research' })).not.toBeChecked();
    await waitFor(() => expect(getWizard().controller.canProceed).toBe(true));
    expect(api.calls.runImportDryRun.at(-1)?.[1]).toMatchObject({ preserveTeamSetup: {} });
  });

  it.each<[string, ExportData | undefined, boolean]>([
    ['the export cannot be read', undefined, true],
    ['there is no team to retain', { ...currentExport, teams: [] }, false],
  ])('offers only the template setup when %s', async (_case, projectExport, notice) => {
    const api = new InMemoryProjectsPageApi({
      upgradePreview: configuredPreview(),
      projectExport,
      importDryRunResult: ready,
      upgradeResult: { success: true, newVersion: '2.0.0' },
    });
    const getWizard = renderUpgrade(api);

    expect(await screen.findByRole('combobox', { name: 'Ready-made setup' })).toHaveTextContent(
      'Target Default',
    );
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByTestId('wizard-current-setup-unavailable') !== null).toBe(notice);
    await waitFor(() => expect(getWizard().controller.canProceed).toBe(true));
    await act(async () => getWizard().controller.submit());
    expect(api.calls.commitUpgrade[0][1]).toMatchObject({ presetName: 'Target Default' });
  });
});

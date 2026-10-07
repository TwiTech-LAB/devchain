import React, { useEffect, useMemo } from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCreateProjectWizard } from './useCreateProjectWizard';
import type { CreateFromTemplateInput } from '@/ui/pages/projects/lib/project-contracts';
import type { SetupPreviewResponse } from '@/ui/pages/projects/lib/project-contracts';
import { InMemoryProjectsPageApi } from '../../../test/helpers/in-memory-projects-page-api';

const BASE: CreateFromTemplateInput = { name: 'X', rootPath: '/tmp/x', templateId: 'tpl' };

/** One family (reasoning) with two available providers — used for the ≥1-selected gate. */
function oneFamilyPreview(): SetupPreviewResponse {
  return {
    payload: {
      version: 1,
      prompts: [],
      profiles: [],
      agents: [],
      statuses: [],
      watchers: [],
      subscribers: [],
      teams: [],
      providerModels: [],
      providerEfforts: [],
      presets: [],
      scheduledEpics: [],
    },
    providerSummary: [
      { name: 'claude', available: true, families: ['reasoning'], agentCount: 1 },
      { name: 'codex', available: true, families: ['reasoning'], agentCount: 0 },
    ],
    familyAlternatives: [
      {
        familySlug: 'reasoning',
        defaultProvider: 'claude',
        defaultProviderAvailable: true,
        availableProviders: ['claude', 'codex'],
        hasAlternatives: true,
      },
    ],
    presetProviderCoverage: [],
    localAvailability: {
      installedProviders: [
        { id: 'c', name: 'claude' },
        { id: 'x', name: 'codex' },
      ],
    },
  };
}

/**
 * One family whose DEFAULT provider (claude) is unavailable, with TWO installed alternatives
 * (codex, gemini) — the multi-alternative scenario that, without familyProviderMappings, makes the
 * backend return providerMappingRequired (template-loader.ts:449-477). Both alternatives are
 * preselected by Step 1, so deriveFamilyProviderMappings → { reasoning: 'codex' }.
 */
function multiAlternativePreview(): SetupPreviewResponse {
  return {
    payload: {
      version: 1,
      prompts: [],
      profiles: [],
      agents: [],
      statuses: [],
      watchers: [],
      subscribers: [],
      teams: [],
      providerModels: [],
      providerEfforts: [],
      presets: [],
      scheduledEpics: [],
    },
    providerSummary: [
      { name: 'claude', available: false, families: ['reasoning'], agentCount: 1 },
      { name: 'codex', available: true, families: ['reasoning'], agentCount: 0 },
      { name: 'gemini', available: true, families: ['reasoning'], agentCount: 0 },
    ],
    familyAlternatives: [
      {
        familySlug: 'reasoning',
        defaultProvider: 'claude',
        defaultProviderAvailable: false,
        availableProviders: ['codex', 'gemini'],
        hasAlternatives: true,
      },
    ],
    presetProviderCoverage: [],
    localAvailability: {
      installedProviders: [
        { id: 'x', name: 'codex' },
        { id: 'g', name: 'gemini' },
      ],
    },
  };
}

/** Two families, each with a single available provider — isolates family-coverage from ≥1-selected. */
function twoFamilyPreview(): SetupPreviewResponse {
  return {
    payload: {
      version: 1,
      prompts: [],
      profiles: [],
      agents: [],
      statuses: [],
      watchers: [],
      subscribers: [],
      teams: [],
      providerModels: [],
      providerEfforts: [],
      presets: [],
      scheduledEpics: [],
    },
    providerSummary: [
      { name: 'claude', available: true, families: ['reasoning'], agentCount: 1 },
      { name: 'codex', available: true, families: ['vision'], agentCount: 1 },
    ],
    familyAlternatives: [
      {
        familySlug: 'reasoning',
        defaultProvider: 'claude',
        defaultProviderAvailable: true,
        availableProviders: ['claude'],
        hasAlternatives: true,
      },
      {
        familySlug: 'vision',
        defaultProvider: 'codex',
        defaultProviderAvailable: true,
        availableProviders: ['codex'],
        hasAlternatives: true,
      },
    ],
    presetProviderCoverage: [],
    localAvailability: {
      installedProviders: [
        { id: 'c', name: 'claude' },
        { id: 'x', name: 'codex' },
      ],
    },
  };
}

interface CreateMutationLike {
  mutate: jest.Mock;
  isPending: boolean;
  isSuccess: boolean;
}

/**
 * Test harness that drives the create wizard to open and renders the active step body + a "Next"
 * button gated on `controller.canProceed` (mirroring the wizard shell's footer). This proves the
 * Step-1 gating wiring — selection → lifted state → getUncoveredFamilies → canProceed → button —
 * WITHOUT the Dialog chrome. No mutation fires (we never reach submit).
 */
function WizardHarness({ api }: { api: InMemoryProjectsPageApi }) {
  const mutation = useMemo<CreateMutationLike>(
    () => ({ mutate: jest.fn(), isPending: false, isSuccess: false }),
    [],
  );
  const wiz = useCreateProjectWizard(mutation, api);
  useEffect(() => {
    // openWizard is stable (useCallback over reset); run once on mount.
    wiz.openWizard(BASE);
  }, []);
  return (
    <div>
      <div data-testid="body">{wiz.controller.currentStep?.render() ?? null}</div>
      <button type="button" data-testid="next" disabled={!wiz.controller.canProceed}>
        Next
      </button>
    </div>
  );
}

function renderWizard(preview: SetupPreviewResponse) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const api = new InMemoryProjectsPageApi({ setupPreview: preview });
  return render(
    <QueryClientProvider client={queryClient}>
      <WizardHarness api={api} />
    </QueryClientProvider>,
  );
}

describe('useCreateProjectWizard — Step 1 provider gating', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('starts with nothing selected and Next disabled; selecting a provider enables it', async () => {
    renderWizard(oneFamilyPreview());

    // Step body renders once the setup-preview resolves — with NO preselection.
    await screen.findByRole('checkbox', { name: 'Claude provider' });
    expect(screen.getByRole('checkbox', { name: 'Claude provider' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Codex provider' })).not.toBeChecked();
    expect(screen.getByTestId('next')).toBeDisabled();

    // Selecting one available provider (covering the family) opens the gate.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Claude provider' }));
    await waitFor(() => expect(screen.getByTestId('next')).toBeEnabled());
    fireEvent.click(screen.getByRole('checkbox', { name: 'Claude provider' }));
    await waitFor(() => expect(screen.getByTestId('next')).toBeDisabled());
  });

  it('disables Next and warns when a family loses coverage even with providers selected', async () => {
    renderWizard(twoFamilyPreview());

    await screen.findByRole('checkbox', { name: 'Codex provider' });
    // Select claude only: reasoning is covered, but vision (codex-only) stays uncovered.
    // ≥1 holds, but vision loses coverage → family gate blocks Next.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Claude provider' }));

    await waitFor(() =>
      expect(screen.getByTestId('wizard-providers-coverage-alert')).toHaveTextContent('vision'),
    );
    expect(screen.getByTestId('next')).toBeDisabled();
  });
});

/**
 * Emission harness: renders the Providers step body so tests can make a real selection (nothing
 * is preselected anymore), while exposing the wizard object for goNext/submit. The body is only
 * rendered on Step 1 — later steps are driven purely through the controller.
 */
let lastWiz: ReturnType<typeof useCreateProjectWizard> | null = null;
function EmissionHarness({
  mutation,
  api,
}: {
  mutation: CreateMutationLike;
  api: InMemoryProjectsPageApi;
}) {
  const wiz = useCreateProjectWizard(mutation, api);
  lastWiz = wiz;
  useEffect(() => {
    wiz.openWizard(BASE);
  }, []);
  return (
    <div>
      {wiz.controller.currentStep?.id === 'providers' ? wiz.controller.currentStep.render() : null}
    </div>
  );
}

function renderEmissionHarness(mutation: CreateMutationLike, preview: SetupPreviewResponse) {
  lastWiz = null;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const api = new InMemoryProjectsPageApi({ setupPreview: preview });
  return render(
    <QueryClientProvider client={queryClient}>
      <EmissionHarness mutation={mutation} api={api} />
    </QueryClientProvider>,
  );
}

describe('useCreateProjectWizard — Step 1 family→provider mapping emission', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('emits familyProviderMappings on create submit for a multi-alternative family (default unavailable)', async () => {
    // Family 'reasoning': default 'claude' is NOT installed; codex + gemini are installed and get
    // selected by the user. Without familyProviderMappings the backend returns
    // providerMappingRequired (template-loader.ts:449-477); with it, the mapping resolves the
    // family client-side.
    const mutation = { mutate: jest.fn(), isPending: false, isSuccess: false };
    renderEmissionHarness(mutation, multiAlternativePreview());

    await screen.findByRole('checkbox', { name: 'Codex provider' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Codex provider' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Gemini provider' }));
    await waitFor(() => expect(lastWiz!.controller.canProceed).toBe(true));

    // Advance Providers → Agents (Teams skipped: no configurable team) to the last step, where the
    // controller's submit() fires onSubmit.
    act(() => lastWiz!.controller.goNext());
    await waitFor(() => expect(lastWiz!.controller.isLastStep).toBe(true));

    await act(async () => {
      lastWiz!.controller.submit();
    });

    expect(mutation.mutate).toHaveBeenCalledTimes(1);
    expect(mutation.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedProviderNames: ['codex', 'gemini'],
        familyProviderMappings: { reasoning: 'codex' },
      }),
    );
  });

  it('omits familyProviderMappings when the default provider is already selected', async () => {
    // oneFamilyPreview: default 'claude' is installed and gets selected → no mapping needed.
    const mutation = { mutate: jest.fn(), isPending: false, isSuccess: false };
    renderEmissionHarness(mutation, oneFamilyPreview());

    await screen.findByRole('checkbox', { name: 'Claude provider' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Claude provider' }));
    await waitFor(() => expect(lastWiz!.controller.canProceed).toBe(true));

    act(() => lastWiz!.controller.goNext());
    await waitFor(() => expect(lastWiz!.controller.isLastStep).toBe(true));

    await act(async () => {
      lastWiz!.controller.submit();
    });

    expect(mutation.mutate).toHaveBeenCalledTimes(1);
    const payload = mutation.mutate.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.familyProviderMappings).toBeUndefined();
  });
});

import React, { useEffect, useMemo } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCreateProjectWizard } from './useCreateProjectWizard';
import { ProjectSetupWizard } from '@/ui/components/project/ProjectSetupWizard';
import type {
  CreateFromTemplateInput,
  SetupPreviewResponse,
} from '@/ui/pages/projects/lib/project-contracts';
import { providerDisplayName } from '@/ui/components/project/wizard/providerDisplay';
import { InMemoryProjectsPageApi } from '../../../test/helpers/in-memory-projects-page-api';
import { teamsDevSetupPreview } from '../../../test/helpers/teams-dev-setup-preview';

// The create flow is the hook + the step components + the dialog shell together: only a render of
// all three shows which steps a user sees, what blocks Create, and what Create submits.

const BASE: CreateFromTemplateInput = { name: 'X', rootPath: '/tmp/x', templateId: 'tpl' };

// The bundled template changes often. The tests read setup names and option names from its
// payload, so a template edit does not need a change here.
const INSTALLED = ['claude', 'codex'];

/** The newest setup of the bundled template: storage order is oldest first. */
function newestSetup(preview: SetupPreviewResponse) {
  const presets = preview.payload.presets ?? [];
  return presets[presets.length - 1];
}

function profileOptions(preview: SetupPreviewResponse, profileName: string) {
  const profile = (preview.payload.profiles ?? []).find(({ name }) => name === profileName)!;
  return profile.providerConfigs ?? [];
}

function agentOptions(preview: SetupPreviewResponse, agentName: string) {
  const agent = (preview.payload.agents ?? []).find(({ name }) => name === agentName)!;
  const profile = (preview.payload.profiles ?? []).find(({ id }) => id === agent.profileId)!;
  return profile.providerConfigs ?? [];
}

/** The Coder options that Builders may use: the newest setup's entry, else the team's own. */
function buildersCoderOptions(preview: SetupPreviewResponse): string[] {
  const coder = ({ profileName }: { profileName: string }) => profileName === 'Coder';
  const fromSetup = newestSetup(preview)
    .teamConfigs?.find(({ teamName }) => teamName === 'Builders')
    ?.profileSelections.find(coder);
  const team = (preview.payload.teams ?? []).find(({ name }) => name === 'Builders')!;
  return (fromSetup ?? team.profileSelections?.find(coder))?.configNames ?? [];
}

interface CreateMutationLike {
  mutate: jest.Mock;
  isPending: boolean;
  isSuccess: boolean;
}

function CreateWizard({
  api,
  mutation,
}: {
  api: InMemoryProjectsPageApi;
  mutation: CreateMutationLike;
}) {
  const wiz = useCreateProjectWizard(mutation, api);
  useEffect(() => {
    // openWizard is stable (useCallback over reset); run once on mount.
    wiz.openWizard(BASE);
  }, []);
  return (
    <ProjectSetupWizard
      open={wiz.isOpen}
      onOpenChange={wiz.onOpenChange}
      controller={wiz.controller}
      submitLabel="Create project"
      isLoading={wiz.isLoading}
    />
  );
}

function renderCreateWizard(preview: SetupPreviewResponse) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const api = new InMemoryProjectsPageApi({ setupPreview: preview });
  const mutation: CreateMutationLike = { mutate: jest.fn(), isPending: false, isSuccess: false };
  function Harness() {
    const stable = useMemo(() => mutation, []);
    return <CreateWizard api={api} mutation={stable} />;
  }
  render(
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>,
  );
  return mutation;
}

function withoutGuide(preview: SetupPreviewResponse): SetupPreviewResponse {
  for (const prompt of preview.payload.prompts ?? []) {
    prompt.tags = (prompt.tags ?? []).filter((tag) => tag !== 'template:how-it-works');
  }
  return preview;
}

async function openReviewSetup() {
  await screen.findByTestId('wizard-setup-review');
}

/** Close the open popover, as a user does before pressing Create; the page is reachable again. */
async function closePopover() {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
  await screen.findByRole('button', { name: 'Create project' });
}

async function chooseAgentProvider(agentName: string, provider: string) {
  fireEvent.click(
    screen.getByRole('button', { name: (name) => name.startsWith(`${agentName}: `) }),
  );
  fireEvent.click(await screen.findByRole('combobox', { name: `${agentName} provider` }));
  fireEvent.click(await screen.findByRole('option', { name: providerDisplayName(provider) }));
}

function submittedPayload(mutation: CreateMutationLike): Record<string, unknown> {
  fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
  expect(mutation.mutate).toHaveBeenCalledTimes(1);
  return mutation.mutate.mock.calls[0][0] as Record<string, unknown>;
}

describe('useCreateProjectWizard', () => {
  it('creates teams-dev through How it works and Review setup with no change', async () => {
    const preview = teamsDevSetupPreview(INSTALLED);
    const mutation = renderCreateWizard(preview);

    await screen.findByTestId('wizard-how-it-works');
    const steps = within(screen.getByRole('navigation', { name: 'Setup steps' }));
    expect(steps.getByText('How it works')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await openReviewSetup();

    expect(screen.getByRole('button', { name: 'Create project' })).toBeEnabled();
    const payload = submittedPayload(mutation);
    expect(payload).toMatchObject({ ...BASE, presetName: newestSetup(preview).name });
    expect(payload.agentOverrides).toBeUndefined();
  });

  it('opens directly on Review setup when the template has no guide prompt', async () => {
    const preview = withoutGuide(teamsDevSetupPreview(INSTALLED));
    preview.payload.vaultAccess = { mode: 'all' };
    renderCreateWizard(preview);

    await openReviewSetup();
    expect(screen.queryByTestId('wizard-how-it-works')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Also created' })).not.toBeInTheDocument();
    expect(screen.queryByText(/This template turns on the Vault/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create project' })).toBeEnabled();
  });

  it('filters setups to the selected provider and offers all installed providers in the agent picker', async () => {
    const user = userEvent.setup();
    const preview = withoutGuide(teamsDevSetupPreview(INSTALLED));
    const mutation = renderCreateWizard(preview);
    await openReviewSetup();
    const providers = within(screen.getByRole('region', { name: 'Providers' }));
    const setups = within(screen.getByRole('region', { name: 'Setup' }));
    const claudeSetups = preview.presetProviderCoverage.filter(({ referencedProviders }) =>
      referencedProviders.every((name) => name === 'claude'),
    );
    const suggested = [...preview.payload.presets]
      .reverse()
      .find(({ name }) => claudeSetups.some(({ presetName }) => presetName === name))!;

    expect(providers.getByRole('checkbox', { name: 'Claude' })).toBeChecked();
    expect(providers.getByRole('checkbox', { name: 'Codex' })).toBeChecked();
    // Every setup that fits the selection is listed; none is behind a "show more" control.
    const fitting = preview.presetProviderCoverage.filter(({ referencedProviders }) =>
      referencedProviders.every((name) => INSTALLED.includes(name)),
    );
    expect(setups.getAllByRole('radio')).toHaveLength(fitting.length);
    await user.click(providers.getByText('Codex', { exact: true }));

    expect(providers.getByRole('checkbox', { name: 'Codex' })).not.toBeChecked();
    expect(setups.getAllByRole('radio')).toHaveLength(claudeSetups.length);
    for (const { presetName } of claudeSetups) {
      expect(
        setups.getByRole('radio', { name: (name) => name.startsWith(presetName) }),
      ).toBeInTheDocument();
    }
    expect(
      setups.getByRole('radio', { name: (name) => name.startsWith(suggested.name) }),
    ).toBeChecked();

    await user.click(screen.getByRole('button', { name: /^Brainstormer: / }));
    expect(
      await screen.findByRole('combobox', { name: 'Brainstormer option' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('combobox', { name: 'Brainstormer provider' }));
    expect(await screen.findByRole('option', { name: 'Codex' })).toBeVisible();
    expect(screen.queryByRole('option', { name: 'Copilot' })).not.toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await closePopover();

    expect(submittedPayload(mutation)).toMatchObject({
      selectedProviderNames: ['claude'],
      presetName: suggested.name,
    });
  });

  it('supports keyboard selection and gives a reason when the last provider cannot be cleared', async () => {
    const user = userEvent.setup();
    renderCreateWizard(withoutGuide(teamsDevSetupPreview(INSTALLED)));
    await openReviewSetup();
    const providers = within(screen.getByRole('region', { name: 'Providers' }));
    const claude = providers.getByRole('checkbox', { name: 'Claude' });
    const codex = providers.getByRole('checkbox', { name: 'Codex' });

    claude.focus();
    await user.tab();
    expect(codex).toHaveFocus();
    await user.keyboard('[Space]');

    expect(codex).not.toBeChecked();
    expect(claude).toBeDisabled();
    expect(claude).toHaveAccessibleDescription('One provider is required');
    await user.click(providers.getByText('Claude', { exact: true }));
    expect(claude).toBeChecked();
  });

  it('submits a manual Codex option while only Claude is selected for the project', async () => {
    const preview = withoutGuide(teamsDevSetupPreview(INSTALLED));
    const option = agentOptions(preview, 'Brainstormer').find(
      ({ providerName }) => providerName === 'codex',
    )!;
    const mutation = renderCreateWizard(preview);
    await openReviewSetup();
    const providers = within(screen.getByRole('region', { name: 'Providers' }));
    fireEvent.click(providers.getByRole('checkbox', { name: 'Codex' }));

    await chooseAgentProvider('Brainstormer', 'codex');
    expect(await screen.findByRole('combobox', { name: 'Brainstormer option' })).toHaveTextContent(
      option.name,
    );
    await closePopover();

    expect(
      screen.getByRole('button', {
        name: `Brainstormer: Codex · ${option.name}`,
      }),
    ).toBeInTheDocument();
    expect(providers.getByRole('checkbox', { name: 'Codex' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Create project' })).toBeEnabled();
    expect(screen.getByTestId('wizard-setup-modified')).toBeInTheDocument();
    const payload = submittedPayload(mutation);
    expect(payload.selectedProviderNames).toEqual(['claude']);
    expect(payload.presetName).toBeUndefined();
    expect(payload.agentOverrides).toContainEqual(
      expect.objectContaining({ agentName: 'Brainstormer', providerConfigName: option.name }),
    );
  });

  // A rendered Review page connects the provider checkbox event to the displayed choice and request.
  it('clears the manual choice when the provider selection changes', async () => {
    const preview = withoutGuide(teamsDevSetupPreview(INSTALLED));
    const mutation = renderCreateWizard(preview);
    await openReviewSetup();
    const codex = screen.getByRole('checkbox', { name: 'Codex' });
    fireEvent.click(codex);
    const defaultLabel = screen
      .getByRole('button', { name: /^Brainstormer: / })
      .getAttribute('aria-label')!;

    await chooseAgentProvider('Brainstormer', 'codex');
    await closePopover();
    expect(screen.getByRole('button', { name: /^Brainstormer: Codex · / })).toBeVisible();

    fireEvent.click(codex);

    expect(screen.getByRole('button', { name: defaultLabel })).toBeVisible();
    expect(submittedPayload(mutation).agentOverrides).toBeUndefined();
  });

  // The real picker and catalog hook show whether a deselected provider's local data reaches the controls.
  it('shows the local model and effort catalog for a manual option outside the selection', async () => {
    const preview = withoutGuide(teamsDevSetupPreview(INSTALLED));
    const model = 'local-codex-model';
    const effort = 'local-codex-effort';
    const catalogs: Record<string, unknown> = {
      '/api/providers/codex/models': [model],
      '/api/providers/codex/efforts': {
        efforts: [{ name: effort }],
        supportsEffort: true,
        requiresModelForEffort: false,
      },
    };
    global.fetch = jest.fn((input: RequestInfo | URL) =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(catalogs[String(input)] ?? { efforts: [] }),
      } as Response),
    );
    renderCreateWizard(preview);
    await openReviewSetup();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Codex' }));
    await chooseAgentProvider('Brainstormer', 'codex');

    fireEvent.click(await screen.findByRole('combobox', { name: 'Brainstormer model' }));
    expect(await screen.findByRole('option', { name: model })).toBeVisible();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    fireEvent.click(await screen.findByRole('combobox', { name: 'Brainstormer effort' }));
    expect(await screen.findByRole('option', { name: effort })).toBeVisible();
  });

  it('submits the team configs checked in the team popover', async () => {
    const preview = withoutGuide(teamsDevSetupPreview(INSTALLED));
    const mutation = renderCreateWizard(preview);
    await openReviewSetup();
    // The popover lists the allowed options on the installed providers. Clear the last one.
    const allowed = buildersCoderOptions(preview);
    const listed = profileOptions(preview, 'Coder')
      .filter(
        ({ name, providerName }) => INSTALLED.includes(providerName) && allowed.includes(name),
      )
      .map(({ name }) => name);
    const cleared = listed[listed.length - 1];
    const expected = listed.filter((name) => name !== cleared);

    fireEvent.click(screen.getByRole('button', { name: /^Coder agents: / }));
    fireEvent.click(await screen.findByRole('checkbox', { name: `Config ${cleared}` }));
    await closePopover();

    const teamOverrides = submittedPayload(mutation).teamOverrides as Array<{
      teamName: string;
      profileSelections: Array<{ profileName: string; configNames: string[] }>;
    }>;
    expect(teamOverrides.map(({ teamName }) => teamName)).toEqual(['Builders']);
    const [selection, ...others] = teamOverrides[0].profileSelections;
    expect(others).toEqual([]);
    expect(selection.profileName).toBe('Coder');
    expect([...selection.configNames].sort()).toEqual([...expected].sort());
  });

  it('falls back to Copilot with only Copilot installed', async () => {
    const preview = withoutGuide(teamsDevSetupPreview(['copilot']));
    renderCreateWizard(preview);
    await openReviewSetup();
    const copilotOption = profileOptions(preview, 'Coder').find(
      ({ providerName }) => providerName === 'copilot',
    )!;

    const providers = within(screen.getByRole('region', { name: 'Providers' }));
    expect(providers.getByRole('checkbox', { name: 'Copilot' })).toBeChecked();
    const codex = providers.getByRole('checkbox', { name: 'Codex' });
    expect(codex).toBeDisabled();
    expect(codex).toHaveAccessibleDescription('Not installed');
    expect(
      screen.getByText('No ready-made setup fits the selected providers.'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('wizard-fallback-notice')).toHaveTextContent(
      'Some template options use providers that are not selected. The affected agents or teams now use Copilot.',
    );
    expect(screen.queryByTestId(/^wizard-agent-blocked-/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create project' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Coder agents: Copilot' }));
    expect(
      await screen.findByRole('checkbox', { name: `Config ${copilotOption.name}` }),
    ).toBeChecked();
  });

  it('blocks Create and explains why when an agent has no option on a selected provider', async () => {
    const preview = withoutGuide(teamsDevSetupPreview(INSTALLED));
    const redTeam = preview.payload.profiles!.find((p) => p.name === 'Red-Team Architect')!;
    redTeam.providerConfigs = redTeam.providerConfigs!.filter(
      ({ providerName }) => providerName === 'codex',
    );
    preview.payload.agents!.push({
      name: 'Red Team',
      profileId: redTeam.id,
      isProjectOwner: false,
    });
    renderCreateWizard(preview);
    await openReviewSetup();
    expect(screen.getByRole('button', { name: /^Red Team: Codex · / })).toBeVisible();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Codex' }));

    expect(screen.getByTestId('wizard-agent-blocked-Red Team')).toHaveTextContent(
      'No selected provider can run this agent. The template supports:',
    );
    expect(screen.queryByRole('button', { name: /^Red Team: / })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create project' })).toBeDisabled();
  });
});

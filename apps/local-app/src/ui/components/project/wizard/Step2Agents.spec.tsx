import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Step2Agents, type Step2AgentsProps } from './Step2Agents';
import { initialAgentRows } from './agentPlan';
import type { SetupPreviewResponse } from '@/ui/pages/projects/lib/project-api';

// Radix primitives need these in JSDOM.
(global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = jest.fn();

// Default: no local model/effort catalogs (rows stay config + default model, effort control hidden).
beforeEach(() => {
  global.fetch = jest.fn(async () => ({
    ok: false,
    json: async () => [],
  })) as unknown as typeof fetch;
});

function makePreview(): SetupPreviewResponse {
  return {
    payload: {
      profiles: [
        {
          id: 'profile-1',
          name: 'Coder',
          provider: { name: 'claude' },
          providerConfigs: [
            { name: 'claude-cfg', providerName: 'claude', model: 'claude-sonnet', env: {} },
            { name: 'codex-cfg', providerName: 'codex', model: 'gpt-5', env: {} },
          ],
        },
      ],
      agents: [
        { name: 'Captain', profileId: 'profile-1', providerConfigName: 'claude-cfg' },
        { name: 'Member', profileId: 'profile-1', providerConfigName: 'claude-cfg' },
        { name: 'Solo', profileId: 'profile-1', providerConfigName: 'codex-cfg' },
      ],
      teams: [{ name: 'Squad', teamLeadAgentName: 'Captain', memberAgentNames: ['Member'] }],
      presets: [
        {
          name: 'AllClaude',
          agentConfigs: [{ agentName: 'Captain', providerConfigName: 'claude-cfg' }],
        },
        {
          name: 'MixedCodex',
          agentConfigs: [{ agentName: 'Solo', providerConfigName: 'codex-cfg' }],
        },
      ],
      providerModels: [],
      providerEfforts: [],
    } as unknown as SetupPreviewResponse['payload'],
    providerSummary: [],
    familyAlternatives: [],
    presetProviderCoverage: [
      {
        presetName: 'AllClaude',
        referencedProviders: ['claude'],
        coversAllAgents: false,
        coveredAgentNames: [],
        agentResolvedProviders: {},
      },
      {
        presetName: 'MixedCodex',
        referencedProviders: ['codex'],
        coversAllAgents: false,
        coveredAgentNames: [],
        agentResolvedProviders: {},
      },
    ],
    localAvailability: {
      installedProviders: [
        { id: 'p-claude', name: 'claude' },
        { id: 'p-codex', name: 'codex' },
      ],
    },
  };
}

function renderStep(over: Partial<Step2AgentsProps> = {}) {
  const preview = over.preview ?? makePreview();
  const props: Step2AgentsProps = {
    preview,
    selectedProviderNames: ['claude', 'codex'],
    rows: initialAgentRows(preview.payload.agents ?? []),
    presetName: null,
    presetModified: false,
    onRowChange: jest.fn(),
    onApplyPreset: jest.fn(),
    onClearPreset: jest.fn(),
    ...over,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <Step2Agents {...props} />
    </QueryClientProvider>,
  );
  return { ...utils, props };
}

describe('Step2Agents', () => {
  it('groups agents by team (lead first + badge, member indented) then independent', () => {
    renderStep();
    expect(screen.getByText('Squad')).toBeInTheDocument();
    expect(screen.getByText('Independent agents')).toBeInTheDocument();
    // Lead row carries a Lead badge; Solo sits under the independent bucket.
    const leadRow = screen.getByTestId('wizard-agent-row-Captain');
    expect(within(leadRow).getByText('Lead')).toBeInTheDocument();
    expect(screen.getByTestId('wizard-agent-row-Member')).toBeInTheDocument();
    expect(screen.getByTestId('wizard-agent-row-Solo')).toBeInTheDocument();
  });

  it('shows only presets whose referenced providers are all selected', async () => {
    renderStep({ selectedProviderNames: ['claude'] });
    await userEvent.click(screen.getByTestId('wizard-agents-preset-select'));
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toContain('AllClaude');
    expect(options).not.toContain('MixedCodex');
  });

  it('lists presets newest-first, matching the Agents page ordering', async () => {
    // Storage/payload order is oldest-first (AllClaude, then MixedCodex); the picker
    // mirrors PresetSelector's most-recently-updated-first convention.
    renderStep();
    await userEvent.click(screen.getByTestId('wizard-agents-preset-select'));
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Custom (no preset)', 'MixedCodex', 'AllClaude']);
  });

  it('applies a preset via the picker', async () => {
    const onApplyPreset = jest.fn();
    renderStep({ onApplyPreset });
    await userEvent.click(screen.getByTestId('wizard-agents-preset-select'));
    await userEvent.click(await screen.findByRole('option', { name: 'AllClaude' }));
    expect(onApplyPreset).toHaveBeenCalledWith('AllClaude');
  });

  it('renders the "modified" badge when an applied preset was edited', () => {
    renderStep({ presetName: 'AllClaude', presetModified: true });
    expect(screen.getByTestId('wizard-agents-preset-modified')).toBeInTheDocument();
  });

  it('flags an agent unresolved when its named config lost its provider', () => {
    // Deselect codex → Solo (codex-cfg) becomes unresolved; claude agents stay resolved.
    renderStep({ selectedProviderNames: ['claude'] });
    expect(screen.getByTestId('wizard-agent-unresolved-Solo')).toBeInTheDocument();
    expect(screen.queryByTestId('wizard-agent-unresolved-Captain')).not.toBeInTheDocument();
  });

  it('limits an agent config options to the selected providers', async () => {
    // Only claude selected → the config select for Captain offers claude-cfg, never codex-cfg.
    renderStep({ selectedProviderNames: ['claude'] });
    await userEvent.click(screen.getByTestId('wizard-config-select-Captain'));
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toContain('claude-cfg');
    expect(options).not.toContain('codex-cfg');
  });

  it('labels the effort Default option with the config effort, mirroring the model select', async () => {
    // claude-cfg pins effort "high" → the Default item shows the inherited value,
    // matching the model select's "Default (<model>)" convention.
    const preview = makePreview();
    const claudeCfg = preview.payload.profiles?.[0]?.providerConfigs?.[0];
    if (claudeCfg) claudeCfg.effort = 'high';
    renderStep({ preview });

    await userEvent.click(await screen.findByTestId('wizard-effort-select-Captain'));
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toContain('Default (high)');
  });

  it('lifts a model override edit through onRowChange', async () => {
    const onRowChange = jest.fn();
    // Give providers a local model catalog so the model select offers a non-default option.
    global.fetch = jest.fn(async (url: string) =>
      String(url).includes('/models')
        ? { ok: true, json: async () => ['claude-opus', 'claude-sonnet'] }
        : { ok: false, json: async () => null },
    ) as unknown as typeof fetch;
    renderStep({ onRowChange });

    await userEvent.click(await screen.findByTestId('wizard-model-select-Captain'));
    await userEvent.click(await screen.findByRole('option', { name: /opus/i }));
    expect(onRowChange).toHaveBeenCalledWith('Captain', { modelOverride: 'claude-opus' });
  });
});

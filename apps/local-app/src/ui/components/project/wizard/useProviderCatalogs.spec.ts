import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { SetupPreviewResponse } from '@/ui/pages/projects/lib/project-contracts';
import {
  agentModelChoices,
  configPickPatch,
  modelPickPatch,
  useProviderCatalogs,
  type ProviderCatalogs,
} from './useProviderCatalogs';
import type { AgentRow, TemplateAgent, TemplateProviderConfig } from './agentPlan';

const OPENCODE_CATALOGS: ProviderCatalogs = {
  localModels: new Map([['opencode', ['zed/sonnet']]]),
  localEfforts: new Map([
    ['opencode', { efforts: ['high'], supportsEffort: true, requiresModelForEffort: true }],
  ]),
  templateModels: new Map(),
  templateEfforts: new Map(),
};

const AGENT = { name: 'Coder' } as TemplateAgent;

function config(over: Partial<TemplateProviderConfig> = {}): TemplateProviderConfig {
  return { name: 'oc', providerName: 'opencode', env: {}, ...over } as TemplateProviderConfig;
}

function row(over: Partial<AgentRow> = {}): AgentRow {
  return {
    agentName: 'Coder',
    configName: 'oc',
    pinned: false,
    modelOverride: null,
    effortOverride: null,
    ...over,
  };
}

describe('agentModelChoices effort gate', () => {
  it.each([
    ['locks with no model source', row(), config(), true],
    ['opens with a row model', row({ modelOverride: 'zed/sonnet' }), config(), false],
    ['opens with a config model', row(), config({ model: 'zed/sonnet' }), false],
    ['opens with a raw --model', row(), config({ options: '--model zed/sonnet' }), false],
  ])('%s', (_case, agentRow, agentConfig, disabled) => {
    const choices = agentModelChoices(OPENCODE_CATALOGS, AGENT, agentRow, agentConfig);
    expect(choices.requiresModelForEffort).toBe(true);
    expect(choices.effortDisabled).toBe(disabled);
  });
});

describe('modelPickPatch', () => {
  it('clears the effort when the pick leaves no model', () => {
    expect(modelPickPatch(true, config(), null)).toEqual({
      modelOverride: null,
      effortOverride: null,
    });
  });

  it.each([
    ['a picked model', true, config(), 'zed/sonnet'],
    ['a raw --model', true, config({ options: '-m zed/sonnet' }), null],
    ['a provider without the model rule', false, config(), null],
  ])('keeps the effort with %s', (_case, requiresModel, agentConfig, model) => {
    expect(modelPickPatch(requiresModel, agentConfig, model)).toEqual({ modelOverride: model });
  });
});

describe('configPickPatch', () => {
  const pick = { configName: 'oc', pinned: true, userSelectedOption: true };

  it('clears the effort when the picked config leaves no model', () => {
    expect(configPickPatch(OPENCODE_CATALOGS, row({ effortOverride: 'high' }), config())).toEqual({
      ...pick,
      effortOverride: null,
    });
  });

  it.each([
    ['a row model', row({ modelOverride: 'zed/sonnet' }), config(), OPENCODE_CATALOGS],
    ['a config model', row(), config({ model: 'zed/sonnet' }), OPENCODE_CATALOGS],
    ['a raw --model', row(), config({ options: '--model zed/sonnet' }), OPENCODE_CATALOGS],
    [
      'a provider without the model rule',
      row(),
      config(),
      { ...OPENCODE_CATALOGS, localEfforts: new Map() },
    ],
  ])('keeps the effort with %s', (_case, agentRow, agentConfig, catalogs) => {
    expect(configPickPatch(catalogs, agentRow, agentConfig)).toEqual(pick);
  });
});

describe('useProviderCatalogs backend', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  // The preview names the answering backend's provider ids; opencode is installed as `oc-id`.
  const preview = {
    payload: {
      profiles: [
        {
          id: 'profile-1',
          name: 'Coder',
          provider: { name: 'opencode' },
          providerConfigs: [{ name: 'oc', providerName: 'opencode', env: {} }],
        },
      ],
      agents: [{ name: 'Coder', profileId: 'profile-1', providerConfigName: 'oc' }],
    },
    localAvailability: { installedProviders: [{ id: 'oc-id', name: 'opencode' }] },
  } as unknown as SetupPreviewResponse;

  it.each([
    { backend: 'home', prefix: '' },
    { backend: 'remote-1', prefix: '/r/remote-1' },
  ])('reads both catalogs from $backend', async ({ backend, prefix }) => {
    const catalogs: Record<string, unknown> = {
      [`${prefix}/api/providers/oc-id/models`]: [`${backend}-only/model`],
      [`${prefix}/api/providers/oc-id/efforts`]: {
        efforts: [{ name: 'high' }],
        supportsEffort: true,
        requiresModelForEffort: true,
      },
    };
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const body = catalogs[String(input)];
      return { ok: body !== undefined, status: body ? 200 : 404, json: async () => body ?? {} };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);

    const { result } = renderHook(() => useProviderCatalogs(preview, backend), { wrapper });

    await waitFor(() =>
      expect(result.current.localEfforts.get('opencode')?.supportsEffort).toBe(true),
    );
    await waitFor(() =>
      expect(result.current.localModels.get('opencode')).toEqual([`${backend}-only/model`]),
    );
    expect(fetchMock.mock.calls.map(([url]) => String(url)).sort()).toEqual(
      Object.keys(catalogs).sort(),
    );
    const choices = agentModelChoices(result.current, AGENT, row(), config());
    expect(choices.modelOptions).toContain(`${backend}-only/model`);
    expect(choices.supportsEffort).toBe(true);
    expect(choices.effortDisabled).toBe(true);
    client.clear();
  });

  // The Projects page renders the wizard under `HomeQueryScope` (the home client). The VM's
  // Providers page renders under `BackendBoundary`, which gives the VM its own client. A catalog
  // edit there invalidates only that client.
  it('reads a VM catalog again when the wizard opens again', async () => {
    let models = ['vm/model-a'];
    let efforts = [{ name: 'high' }];
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const body = String(input).endsWith('/models')
        ? models
        : { efforts, supportsEffort: true, requiresModelForEffort: true };
      return { ok: true, status: 200, json: async () => body };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const homeClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const vmPageClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: homeClient }, children);

    const first = renderHook(() => useProviderCatalogs(preview, 'remote-1'), { wrapper });
    await waitFor(() =>
      expect(first.result.current.localModels.get('opencode')).toEqual(['vm/model-a']),
    );
    first.unmount();

    models = ['vm/model-a', 'vm/model-b'];
    efforts = [{ name: 'high' }, { name: 'max' }];
    await vmPageClient.invalidateQueries({ queryKey: ['provider-models'] });
    await vmPageClient.invalidateQueries({ queryKey: ['provider-efforts'] });

    const second = renderHook(() => useProviderCatalogs(preview, 'remote-1'), { wrapper });
    await waitFor(() =>
      expect(second.result.current.localModels.get('opencode')).toEqual([
        'vm/model-a',
        'vm/model-b',
      ]),
    );
    await waitFor(() =>
      expect(second.result.current.localEfforts.get('opencode')?.efforts).toEqual(['high', 'max']),
    );
    second.unmount();
    homeClient.clear();
  });
});

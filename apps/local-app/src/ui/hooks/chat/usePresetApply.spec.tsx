import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { usePresetApply, type UsePresetApplyOptions } from './usePresetApply';

const toast = jest.fn();
const showSuccess = jest.fn();
const showError = jest.fn();
jest.mock('@/ui/lib/toast-helpers', () => ({
  useToastHelpers: () => ({ toast, showSuccess, showError }),
  getErrorMessage: (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback),
}));

const validatePresetAvailability = jest.fn();
jest.mock('@/ui/lib/preset-validation', () => ({
  validatePresetAvailability: (...args: unknown[]) => validatePresetAvailability(...args),
}));

jest.mock('@/ui/lib/restart-keys', () => ({
  restartKeyForMain: (agentId: string) => `main:${agentId}`,
}));

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

const presetAlpha = {
  name: 'Alpha',
  agentConfigs: [{ agentName: 'Coder', providerConfigName: 'claude' }],
} as never;
const presetBeta = {
  name: 'Beta',
  agentConfigs: [{ agentName: 'Coder', providerConfigName: 'gpt' }],
} as never;

function baseOptions(overrides: Partial<UsePresetApplyOptions> = {}): UsePresetApplyOptions {
  return {
    projectId: 'p1',
    apiFetch: jest.fn(),
    presets: [presetAlpha, presetBeta],
    agentsWithProfiles: [{ id: 'a1', name: 'Coder', profileId: 'prof1' }],
    configsMap: new Map(),
    agents: [{ id: 'a1', name: 'Coder', providerConfigId: 'old' }],
    agentPresence: { a1: { online: true } },
    markAgentsForRestart: jest.fn(),
    confirmIfActiveSessions: jest.fn(),
    ...overrides,
  };
}

describe('usePresetApply', () => {
  beforeEach(() => jest.clearAllMocks());

  it('validatedPresets is empty when configsMap is missing', () => {
    const client = new QueryClient();
    const { result } = renderHook(() => usePresetApply(baseOptions({ configsMap: undefined })), {
      wrapper: wrapper(client),
    });
    expect(result.current.validatedPresets).toEqual([]);
    expect(validatePresetAvailability).not.toHaveBeenCalled();
  });

  it('sorts available presets first, then most-recently-updated within a group', () => {
    // Alpha (index 0) unavailable, Beta (index 1) available -> Beta first.
    validatePresetAvailability.mockImplementation((p: { name: string }) => ({
      preset: p,
      available: p.name === 'Beta',
      missingConfigs: [],
    }));
    const client = new QueryClient();
    const { result } = renderHook(() => usePresetApply(baseOptions()), {
      wrapper: wrapper(client),
    });
    expect(result.current.validatedPresets.map((v) => v.preset.name)).toEqual(['Beta', 'Alpha']);
  });

  it('rejects an unavailable preset with a destructive toast and no mutation', async () => {
    validatePresetAvailability.mockReturnValue({
      preset: presetAlpha,
      available: false,
      missingConfigs: [],
    });
    const apiFetch = jest.fn();
    const client = new QueryClient();
    const { result } = renderHook(() => usePresetApply(baseOptions({ apiFetch })), {
      wrapper: wrapper(client),
    });

    await act(async () => {
      await result.current.handleApplyPreset('Alpha');
    });

    expect(toast).toHaveBeenCalledWith({
      title: 'Cannot apply preset',
      description: 'Some required provider configurations are missing.',
      variant: 'destructive',
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('confirms active sessions, applies, marks online affected agents, invalidates, and toasts success', async () => {
    validatePresetAvailability.mockReturnValue({
      preset: presetAlpha,
      available: true,
      missingConfigs: [],
    });
    const apiFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        applied: 1,
        warnings: [],
        agents: [{ id: 'a1', name: 'Coder', providerConfigId: 'new' }],
      }),
    });
    const markAgentsForRestart = jest.fn();
    const confirmIfActiveSessions = jest.fn((_names: string[], onConfirm: () => void) =>
      onConfirm(),
    );
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const invalidate = jest.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(
      () =>
        usePresetApply(baseOptions({ apiFetch, markAgentsForRestart, confirmIfActiveSessions })),
      { wrapper: wrapper(client) },
    );

    await act(async () => {
      await result.current.handleApplyPreset('Alpha');
    });

    // Coder is online and in the preset -> surfaced to the confirmation gate.
    expect(confirmIfActiveSessions).toHaveBeenCalledWith(['Coder'], expect.any(Function));
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/projects/p1/presets/apply',
      expect.objectContaining({ method: 'POST' }),
    );
    await waitFor(() => expect(showSuccess).toHaveBeenCalled());
    expect(markAgentsForRestart).toHaveBeenCalledWith(['main:a1']);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['agents', 'p1'] });
    expect(showSuccess).toHaveBeenCalledWith({
      title: 'Preset applied',
      description: '1 agent(s) updated. Restart sessions to apply.',
    });
  });

  it('surfaces a destructive error toast when apply fails', async () => {
    validatePresetAvailability.mockReturnValue({
      preset: presetAlpha,
      available: true,
      missingConfigs: [],
    });
    const apiFetch = jest.fn().mockResolvedValue({ ok: false });
    const confirmIfActiveSessions = jest.fn((_names: string[], onConfirm: () => void) =>
      onConfirm(),
    );
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const { result } = renderHook(
      () => usePresetApply(baseOptions({ apiFetch, confirmIfActiveSessions })),
      { wrapper: wrapper(client) },
    );

    await act(async () => {
      await result.current.handleApplyPreset('Alpha');
    });

    await waitFor(() =>
      expect(showError).toHaveBeenCalledWith({
        title: 'Failed to apply preset',
        description: 'Failed to apply preset',
      }),
    );
  });
});

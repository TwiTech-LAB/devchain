import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { useProjectsPageController } from './useProjectsPageController';
import type { AgentOverridePayload } from '@/ui/pages/projects/lib/project-api';

// useSelectedProject requires a ProjectSelectionProvider; the retry path only needs
// setSelectedProjectId, so stub the hook.
jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({ selectedProjectId: null, setSelectedProjectId: jest.fn() }),
}));

interface CapturedCreateBody {
  body: Record<string, unknown>;
}

/** Server response that forces the providerMappingRequired fallback path. */
const PROVIDER_MAPPING_REQUIRED_RESPONSE = {
  providerMappingRequired: {
    missingProviders: ['claude'],
    familyAlternatives: [
      {
        familySlug: 'reasoning',
        defaultProvider: 'claude',
        defaultProviderAvailable: false,
        availableProviders: ['codex'],
        hasAlternatives: true,
      },
    ],
    canImport: true,
  },
};

/**
 * Mock global fetch: the FIRST create POST returns providerMappingRequired, subsequent create POSTs
 * (the retry) return success. All create POST bodies are captured for assertion. Mount-time queries
 * (projects, templates) get benign empty responses.
 */
function installFetch(captures: CapturedCreateBody[]) {
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method;

    if (url === '/api/projects/from-template' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      captures.push({ body });
      return {
        ok: true,
        json: async () =>
          captures.length === 1
            ? PROVIDER_MAPPING_REQUIRED_RESPONSE
            : { success: true, project: { id: 'p-new', name: body.name } },
      } as Response;
    }
    if (url === '/api/projects') {
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }
    if (url === '/api/templates') {
      return { ok: true, json: async () => ({ templates: [], total: 0 }) } as Response;
    }
    if (url.endsWith('/stats')) {
      return { ok: true, json: async () => ({ epicsCount: 0, agentsCount: 0 }) } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
}

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

describe('useProjectsPageController — providerMappingRequired retry preserves wizard payload', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('preserves selectedProviderNames + agentOverrides + teamOverrides through the retry', async () => {
    const captures: CapturedCreateBody[] = [];
    installFetch(captures);
    const { result } = renderHook(() => useProjectsPageController(), { wrapper });

    const agentOverrides: AgentOverridePayload[] = [
      {
        agentName: 'Coder',
        providerConfigName: 'default',
        modelOverride: 'opus',
        effortOverride: 'high',
      },
    ];
    const submitted = {
      name: 'P',
      rootPath: '/tmp/p',
      templateId: 'tpl',
      selectedProviderNames: ['claude'],
      agentOverrides,
      teamOverrides: [{ teamName: 'Core', maxMembers: 3 }],
    };

    // 1) Submit the wizard payload → backend responds providerMappingRequired.
    act(() => {
      result.current.createFromTemplateMutation.mutate(submitted);
    });
    await waitFor(() => expect(result.current.providerMappingData).not.toBeNull());
    expect(captures).toHaveLength(1);
    expect(captures[0].body).toMatchObject(submitted);

    // 2) User confirms a family→provider mapping in ProviderMappingModal.
    await act(async () => {
      await result.current.handleProviderMappingConfirm({ reasoning: 'codex' });
    });

    // 3) The retried request carries EVERY original wizard field + the confirmed mappings.
    await waitFor(() => expect(captures).toHaveLength(2));
    const retryBody = captures[1].body;
    expect(retryBody).toMatchObject({
      ...submitted,
      familyProviderMappings: { reasoning: 'codex' },
    });
    // Explicit per-field assertions: the pre-wizard templateFormData would have dropped all of these.
    expect(retryBody.selectedProviderNames).toEqual(['claude']);
    expect(retryBody.agentOverrides).toEqual(agentOverrides);
    expect(retryBody.teamOverrides).toEqual([{ teamName: 'Core', maxMembers: 3 }]);
    expect(retryBody.familyProviderMappings).toEqual({ reasoning: 'codex' });
  });

  it('preserves presetName (instead of agentOverrides) through the retry', async () => {
    const captures: CapturedCreateBody[] = [];
    installFetch(captures);
    const { result } = renderHook(() => useProjectsPageController(), { wrapper });

    const submitted = {
      name: 'P2',
      rootPath: '/tmp/p2',
      templateId: 'tpl',
      selectedProviderNames: ['claude', 'codex'],
      presetName: 'balanced',
      teamOverrides: [{ teamName: 'Reviews' }],
    };

    act(() => {
      result.current.createFromTemplateMutation.mutate(submitted);
    });
    await waitFor(() => expect(result.current.providerMappingData).not.toBeNull());

    await act(async () => {
      await result.current.handleProviderMappingConfirm({ reasoning: 'codex' });
    });

    await waitFor(() => expect(captures).toHaveLength(2));
    const retryBody = captures[1].body;
    expect(retryBody.presetName).toBe('balanced');
    expect(retryBody.selectedProviderNames).toEqual(['claude', 'codex']);
    expect(retryBody.teamOverrides).toEqual([{ teamName: 'Reviews' }]);
    expect(retryBody.familyProviderMappings).toEqual({ reasoning: 'codex' });
  });
});

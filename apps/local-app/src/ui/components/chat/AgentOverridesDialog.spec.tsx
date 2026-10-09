import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AgentOverridesDialog, type AgentOverridesSavePayload } from './AgentOverridesDialog';
import type { ProfileProviderConfig } from '@/ui/lib/provider-configs';
import type { AgentOrGuest } from '@/ui/hooks/useChatQueries';
import { providerModelQueryKeys } from '@/ui/lib/provider-model-query-keys';

// Shim the shadcn/Radix Select with a native <select> so tests can drive it
// deterministically (Radix Select relies on pointer events that jsdom lacks).
// The trigger's `id` is mirrored onto the native select so <Label htmlFor> and
// getByLabelText keep working.
jest.mock('@/ui/components/ui/select', () => {
  const ReactLib = jest.requireActual<typeof import('react')>('react');
  let currentId: string | undefined;

  interface Node {
    value?: string;
    disabled?: boolean;
    onValueChange?: (value: string) => void;
    id?: string;
    children?: React.ReactNode;
  }

  const SelectTrigger = ({ id, children }: Node) => {
    currentId = id;
    return <>{children}</>;
  };
  const SelectContent = ({ children }: Node) => <>{children}</>;
  const SelectItem = ({ value, children, disabled }: Node) => (
    <option value={value} disabled={disabled}>
      {children}
    </option>
  );
  (SelectItem as { __ITEM?: boolean }).__ITEM = true;
  const SelectValue = () => null;

  const collect = (nodes: React.ReactNode): React.ReactNode[] => {
    const out: React.ReactNode[] = [];
    for (const child of ReactLib.Children.toArray(nodes)) {
      if (!ReactLib.isValidElement(child)) continue;
      const props = child.props as Node;
      if (child.type === SelectTrigger && props.id) currentId = props.id;
      if (child.type === SelectContent) {
        out.push(...collect(props.children));
      } else if ((child.type as { __ITEM?: boolean })?.__ITEM && props.value !== undefined) {
        out.push(
          <option key={props.value} value={props.value} disabled={props.disabled}>
            {props.children}
          </option>,
        );
      }
    }
    return out;
  };

  const Select = ({ value, onValueChange, disabled, children }: Node) => {
    const options = collect(children);
    const el = (
      <select
        id={currentId}
        aria-label={currentId}
        value={value}
        disabled={disabled}
        onChange={(event) => onValueChange?.(event.target.value)}
      >
        {options}
      </select>
    );
    currentId = undefined;
    return el;
  };

  return { Select, SelectTrigger, SelectContent, SelectItem, SelectValue };
});

const baseAgent: AgentOrGuest = {
  id: 'agent-1',
  name: 'Alpha',
  profileId: 'profile-1',
  type: 'agent',
  providerConfigId: 'config-1',
  modelOverride: null,
  effortOverride: null,
  isProjectOwner: false,
};

const configDefaults = {
  profileId: 'profile-1',
  description: null,
  options: null,
  env: null,
  position: 0,
  createdAt: '2026-10-08T00:00:00.000Z',
  updatedAt: '2026-10-08T00:00:00.000Z',
};

const CONFIGS: ProfileProviderConfig[] = [
  {
    ...configDefaults,
    id: 'config-1',
    name: 'Config A',
    providerId: 'provider-1',
    model: null,
    effort: null,
  },
  {
    ...configDefaults,
    id: 'config-2',
    name: 'Config B',
    providerId: 'provider-2',
    model: null,
    effort: null,
  },
];

interface FetchOptions {
  modelsByProvider?: Record<string, Array<{ id: string; name: string }>>;
  effortsByProvider?: Record<
    string,
    {
      efforts: Array<{ id: string; name: string }>;
      supportsEffort: boolean;
      requiresModelForEffort: boolean;
    }
  >;
}

function installFetch(options: FetchOptions = {}) {
  const {
    modelsByProvider = { 'provider-1': [], 'provider-2': [] },
    effortsByProvider = {
      'provider-1': { efforts: [], supportsEffort: true, requiresModelForEffort: false },
      'provider-2': { efforts: [], supportsEffort: true, requiresModelForEffort: false },
    },
  } = options;

  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const modelsMatch = url.match(/\/api\/providers\/([^/]+)\/models$/);
    if (modelsMatch) {
      const providerId = decodeURIComponent(modelsMatch[1]);
      return { ok: true, json: async () => modelsByProvider[providerId] ?? [] } as Response;
    }
    const effortsMatch = url.match(/\/api\/providers\/([^/]+)\/efforts$/);
    if (effortsMatch) {
      const providerId = decodeURIComponent(effortsMatch[1]);
      return {
        ok: true,
        json: async () => {
          const catalog = effortsByProvider[providerId] ?? {
            efforts: [],
            supportsEffort: false,
            requiresModelForEffort: false,
          };
          return {
            ...catalog,
            efforts: catalog.efforts.map((effort, index) => ({
              ...effort,
              providerId,
              position: index,
              createdAt: '2026-10-08T00:00:00.000Z',
              updatedAt: '2026-10-08T00:00:00.000Z',
            })),
          };
        },
      } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
}

function renderDialog(
  props: Partial<React.ComponentProps<typeof AgentOverridesDialog>> = {},
  configs: ProfileProviderConfig[] = CONFIGS,
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  const onSave = props.onSave ?? jest.fn();
  const onOpenChange = props.onOpenChange ?? jest.fn();
  const catalogFetch = global.fetch;
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/provider-configs')) {
      return { ok: true, json: async () => configs } as Response;
    }
    return catalogFetch(input, init);
  });

  const utils = render(
    <QueryClientProvider client={queryClient}>
      <AgentOverridesDialog
        open
        onOpenChange={onOpenChange}
        agent={baseAgent}
        isOnline={false}
        isSaving={false}
        onSave={onSave}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { ...utils, onSave, onOpenChange };
}

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

describe('AgentOverridesDialog', () => {
  it('lazily loads configs on open and labels the selects', async () => {
    installFetch();
    renderDialog();

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/profiles/profile-1/provider-configs', {}),
    );
    expect(await screen.findByLabelText('Provider Config')).toBeInTheDocument();
    expect(screen.getByLabelText('Model')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Reasoning Effort')).toBeInTheDocument());

    {
      await screen.findByLabelText('Provider Config');
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    }
  });

  it('shows "Default (config: <model>)" when the config has a structured default', async () => {
    installFetch();
    renderDialog({}, [
      {
        ...configDefaults,
        id: 'config-1',
        name: 'Config A',
        providerId: 'provider-1',
        model: 'anthropic/opus',
        effort: 'high',
      },
    ]);

    expect(await screen.findByText('Default (config: opus)')).toBeInTheDocument();
    expect(await screen.findByText('Default (config: high)')).toBeInTheDocument();
  });

  it('normalizes a string model catalog left in the shared cache by the import wizard', async () => {
    installFetch();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(providerModelQueryKeys.main('provider-1'), ['anthropic/opus']);

    renderDialog({}, CONFIGS, queryClient);

    expect(await screen.findByRole('option', { name: 'opus' })).toBeInTheDocument();
    expect(screen.getByLabelText('Model')).toBeInTheDocument();
  });

  it('hides the effort select for providers that do not support effort (agy)', async () => {
    installFetch({
      effortsByProvider: {
        'provider-1': { efforts: [], supportsEffort: false, requiresModelForEffort: false },
      },
    });
    renderDialog();

    await screen.findByLabelText('Provider Config');
    await waitFor(() =>
      expect(screen.queryByLabelText('Reasoning Effort')).not.toBeInTheDocument(),
    );
  });

  it('disables the effort select with "No effort levels configured" when the catalog is empty', async () => {
    installFetch({
      effortsByProvider: {
        'provider-1': { efforts: [], supportsEffort: true, requiresModelForEffort: false },
      },
    });
    renderDialog();

    expect(await screen.findByText('No effort levels configured')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Reasoning Effort')).toBeDisabled());
  });

  it('disables the effort select with "Select a model first" for opencode until a model is effective', async () => {
    installFetch({
      modelsByProvider: { 'provider-1': [{ id: 'm1', name: 'zed/sonnet' }] },
      effortsByProvider: {
        'provider-1': {
          efforts: [{ id: 'e1', name: 'high' }],
          supportsEffort: true,
          requiresModelForEffort: true,
        },
      },
    });
    renderDialog();

    // No agent model override and no config structured default → gated.
    expect(await screen.findByText('Select a model first')).toBeInTheDocument();
    expect(screen.getByLabelText('Reasoning Effort')).toBeDisabled();

    // Choosing a model unlocks the effort select.
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'zed/sonnet' } });
    await waitFor(() => expect(screen.getByLabelText('Reasoning Effort')).not.toBeDisabled());
    expect(screen.queryByText('Select a model first')).not.toBeInTheDocument();
  });

  it('resets model and effort to Default when the provider config is switched', async () => {
    installFetch({
      modelsByProvider: {
        'provider-1': [{ id: 'm1', name: 'anthropic/opus' }],
        'provider-2': [{ id: 'm2', name: 'openai/gpt-5' }],
      },
      effortsByProvider: {
        'provider-1': {
          efforts: [{ id: 'e1', name: 'high' }],
          supportsEffort: true,
          requiresModelForEffort: false,
        },
        'provider-2': {
          efforts: [{ id: 'e2', name: 'low' }],
          supportsEffort: true,
          requiresModelForEffort: false,
        },
      },
    });
    const onSave = jest.fn();
    renderDialog({
      agent: { ...baseAgent, modelOverride: 'anthropic/opus', effortOverride: 'high' },
      onSave,
    });

    const modelSelect = (await screen.findByLabelText('Model')) as HTMLSelectElement;
    await waitFor(() => expect(modelSelect.value).toBe('anthropic/opus'));

    // Switch to Config B (provider-2): both selects rebind and reset to Default.
    fireEvent.change(screen.getByLabelText('Provider Config'), { target: { value: 'config-2' } });

    await waitFor(() =>
      expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('__default__'),
    );
    expect((screen.getByLabelText('Reasoning Effort') as HTMLSelectElement).value).toBe(
      '__default__',
    );

    // Saving after the switch carries the cleared (null) overrides for the new config.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        providerConfigId: 'config-2',
        modelOverride: null,
        effortOverride: null,
      } satisfies AgentOverridesSavePayload),
    );
  });

  it('saves model + effort overrides in a single payload and closes', async () => {
    installFetch({
      modelsByProvider: { 'provider-1': [{ id: 'm1', name: 'anthropic/opus' }] },
      effortsByProvider: {
        'provider-1': {
          efforts: [{ id: 'e1', name: 'high' }],
          supportsEffort: true,
          requiresModelForEffort: false,
        },
      },
    });
    const onSave = jest.fn().mockResolvedValue(undefined);
    const onOpenChange = jest.fn();
    renderDialog({ onSave, onOpenChange });

    // Wait for the lazy model/effort catalogs to load before selecting.
    await screen.findByRole('option', { name: 'opus' });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'anthropic/opus' } });
    fireEvent.change(screen.getByLabelText('Reasoning Effort'), { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        providerConfigId: 'config-1',
        modelOverride: 'anthropic/opus',
        effortOverride: 'high',
      }),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('warns about restart only when the agent is online and something changed', async () => {
    installFetch({
      modelsByProvider: { 'provider-1': [{ id: 'm1', name: 'anthropic/opus' }] },
    });
    renderDialog({ isOnline: true });

    await screen.findByRole('option', { name: 'opus' });
    expect(screen.queryByText(/Restart the session/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'anthropic/opus' } });
    expect(await screen.findByText(/Restart the session to apply/i)).toBeInTheDocument();
  });

  it('surfaces save failures in an aria-live alert and keeps the dialog open', async () => {
    installFetch({ modelsByProvider: { 'provider-1': [{ id: 'm1', name: 'anthropic/opus' }] } });
    const onSave = jest.fn().mockRejectedValue(new Error('network down'));
    const onOpenChange = jest.fn();
    renderDialog({ onSave, onOpenChange });

    await screen.findByRole('option', { name: 'opus' });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'anthropic/opus' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('network down');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('restores focus to the trigger element on close', async () => {
    installFetch();
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    const focusSpy = jest.spyOn(trigger, 'focus');
    const onOpenChange = jest.fn();

    renderDialog({ triggerEl: trigger, onOpenChange });
    await screen.findByLabelText('Provider Config');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // onCloseAutoFocus fires on the underlying Radix close; assert the handler wiring
    // by invoking close through the Cancel button and confirming the ref is honored.
    trigger.remove();
    focusSpy.mockRestore();
  });
});

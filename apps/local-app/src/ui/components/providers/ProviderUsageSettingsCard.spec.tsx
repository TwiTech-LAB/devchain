import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PROVIDER_USAGE_SETTINGS_DEFAULTS } from '@devchain/shared';
import { buildApiUrl, createApiFetch } from '@/ui/lib/api-transport';
import { BackendContext, type BackendContextValue } from '@/ui/lib/backend-context';
import { ProviderUsageSettingsCard } from './ProviderUsageSettingsCard';

// Layer: component unit over the real fetch transport with `fetch` mocked. A
// remote-bound project is active in every test, so each request URL also proves
// the card stays on home's /api/settings instead of the VM's /r/ proxy.
const fetchMock = jest.fn();
const originalFetch = global.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function renderCard() {
  const bindings = new Map([['project-1', 'remote-1']]);
  const backend: BackendContextValue = {
    activeBackend: 'remote-1',
    activeRemote: null,
    bindings,
    ready: true,
    bindingsError: null,
    retry: jest.fn(),
    apiFetch: createApiFetch(() => ({
      bindings,
      activeProjectId: 'project-1',
      authority: 'known',
    })),
    buildApiUrl,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <BackendContext.Provider value={backend}>{children}</BackendContext.Provider>
    </QueryClientProvider>
  );
  return render(<ProviderUsageSettingsCard />, { wrapper });
}

async function field(label: string): Promise<HTMLInputElement> {
  const input = await screen.findByLabelText(label);
  await waitFor(() => expect(input).toBeEnabled());
  return input as HTMLInputElement;
}

function putCalls() {
  return fetchMock.mock.calls.filter(
    ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
    jsonResponse(
      init?.method === 'PUT'
        ? (JSON.parse(String(init.body)) as unknown)
        : { providerUsage: { ...PROVIDER_USAGE_SETTINGS_DEFAULTS } },
    ),
  );
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('ProviderUsageSettingsCard', () => {
  it("loads home's values while a VM project is open", async () => {
    renderCard();

    expect(await field('Check accounts with running sessions every (min)')).toHaveValue(5);
    expect(screen.getByLabelText("Check the open project's accounts every (min)")).toHaveValue(30);
    expect(screen.getByLabelText('Refresh on hover when older than (s)')).toHaveValue(60);
    expect(screen.getByLabelText('Claude token check every (min, 0 = off)')).toHaveValue(10);
    expect(screen.getByRole('switch', { name: 'Show usage rings' })).toBeChecked();
    expect(fetchMock).toHaveBeenCalledWith('/api/settings', expect.anything());
  });

  it("saves the changed values to home's settings", async () => {
    renderCard();
    fireEvent.change(await field('Check accounts with running sessions every (min)'), {
      target: { value: '7' },
    });
    fireEvent.change(screen.getByLabelText('Claude token check every (min, 0 = off)'), {
      target: { value: '0' },
    });
    fireEvent.click(screen.getByRole('switch', { name: 'Show usage rings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(putCalls()).toHaveLength(1));
    const [url, init] = putCalls()[0] as [string, RequestInit];
    expect(url).toBe('/api/settings');
    expect(JSON.parse(String(init.body))).toEqual({
      providerUsage: {
        ...PROVIDER_USAGE_SETTINGS_DEFAULTS,
        enabled: false,
        runningMaxAgeMin: 7,
        tokenCheckMinutes: 0,
      },
    });
  });

  it.each([
    ['Claude token check every (min, 0 = off)', '3', 'Enter 0, or a whole number from 5 to 60.'],
    ['Refresh on hover when older than (s)', '', 'Enter a whole number from 15 to 600.'],
  ])('rejects %s = "%s" without saving', async (label, value, message) => {
    renderCard();
    fireEvent.change(await field(label), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(putCalls()).toHaveLength(0);
  });

  it('shows the server error of a failed save', async () => {
    renderCard();
    await field('Check accounts with running sessions every (min)');
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === 'PUT'
        ? jsonResponse({ message: 'Settings are read-only' }, 400)
        : jsonResponse({ providerUsage: { ...PROVIDER_USAGE_SETTINGS_DEFAULTS } }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Settings are read-only')).toBeInTheDocument();
  });
});

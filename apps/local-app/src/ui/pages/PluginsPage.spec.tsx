import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PluginsPage } from './PluginsPage';

const toastSpy = jest.fn();
const useSelectedProjectMock = jest.fn();
let policyFailuresRemaining = 0;
let deferredPolicyRefetch: Deferred<Response> | undefined;

interface PolicyItem {
  providerId: string;
  pluginId: string;
  enabled: boolean;
  source: 'default' | 'project';
}

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastSpy }),
}));

jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => useSelectedProjectMock(),
}));

const claudePlugin = {
  pluginId: 'review@official',
  name: 'Review Tools',
  description: 'Review automation',
  marketplaceName: 'official',
  version: '1.0.0',
  installed: false,
  available: true,
  providerEnabled: false,
  installationScopes: [],
  installCount: 3,
  installPolicy: null,
  authPolicy: null,
  providerId: 'provider-claude',
  providerName: 'Claude',
};

const claudeInstalledPlugin = {
  ...claudePlugin,
  pluginId: 'workflow@official',
  name: 'Workflow Tools',
  description: 'Claude workflow support',
  installed: true,
  available: false,
  providerEnabled: false,
};

const codexPlugin = {
  pluginId: 'profile@community',
  name: 'Profile Tools',
  description: 'Codex profile support',
  marketplaceName: 'community',
  version: '2.0.0',
  installed: true,
  available: false,
  providerEnabled: false,
  installationScopes: [],
  installCount: null,
  installPolicy: null,
  authPolicy: null,
  providerId: 'provider-codex',
  providerName: 'Codex',
};

let catalogPlugins = [claudePlugin, claudeInstalledPlugin, codexPlugin];
let policyItems: PolicyItem[] = [];

const projectSelection = {
  projects: [],
  projectsLoading: false,
  projectsError: false,
  refetchProjects: jest.fn(),
  selectedProjectId: 'project-1',
  selectedProject: { id: 'project-1', name: 'Project Alpha' },
  setSelectedProjectId: jest.fn(),
};

function jsonResponse(data: unknown): Response {
  return { ok: true, json: async () => data, status: 200 } as Response;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderPage() {
  const queryClient = createQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <PluginsPage />
    </QueryClientProvider>,
  );
}

describe('PluginsPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    policyFailuresRemaining = 0;
    deferredPolicyRefetch = undefined;
    catalogPlugins = [claudePlugin, claudeInstalledPlugin, codexPlugin];
    policyItems = [
      {
        providerId: 'provider-claude',
        pluginId: 'review@official',
        enabled: true,
        source: 'default',
      },
      {
        providerId: 'provider-claude',
        pluginId: 'workflow@official',
        enabled: false,
        source: 'project',
      },
    ];
    useSelectedProjectMock.mockReturnValue(projectSelection);
    (Element as unknown as { prototype: { scrollIntoView: unknown } }).prototype.scrollIntoView =
      jest.fn();

    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method?.toUpperCase() ?? 'GET';

        if (method === 'GET' && url === '/api/provider-plugins') {
          return jsonResponse({ items: catalogPlugins, total: catalogPlugins.length });
        }
        if (method === 'GET' && url.startsWith('/api/provider-plugins/policy?')) {
          if (deferredPolicyRefetch) {
            const deferred = deferredPolicyRefetch;
            deferredPolicyRefetch = undefined;
            return deferred.promise;
          }
          if (policyFailuresRemaining > 0) {
            policyFailuresRemaining -= 1;
            return {
              ok: false,
              json: async () => ({ message: 'Policy service temporarily unavailable' }),
            } as Response;
          }
          return jsonResponse({ items: policyItems });
        }
        if (method === 'POST' && url === '/api/provider-plugins/install') {
          return jsonResponse({ success: true });
        }
        if (method === 'POST' && url === '/api/provider-plugins/refresh') {
          return jsonResponse({ items: [claudePlugin, codexPlugin], total: 2 });
        }
        if (method === 'PUT' && url === '/api/provider-plugins/policy/default') {
          const body = JSON.parse(String(init?.body)) as Omit<PolicyItem, 'source'>;
          const policy = { ...body, source: 'default' as const };
          policyItems = [
            ...policyItems.filter(
              (item) =>
                !(
                  item.source === policy.source &&
                  item.providerId === policy.providerId &&
                  item.pluginId === policy.pluginId
                ),
            ),
            policy,
          ];
          return jsonResponse(policy);
        }
        if (method === 'DELETE' && url.startsWith('/api/provider-plugins/policy/default?')) {
          const params = new URL(url, 'http://localhost').searchParams;
          policyItems = policyItems.filter(
            (item) =>
              !(
                item.source === 'default' &&
                item.providerId === params.get('providerId') &&
                item.pluginId === params.get('pluginId')
              ),
          );
          return jsonResponse({ deleted: true });
        }
        if (method === 'PUT' && url === '/api/provider-plugins/policy/project') {
          const body = JSON.parse(String(init?.body)) as Omit<PolicyItem, 'source'> & {
            projectId: string;
          };
          const policy = {
            providerId: body.providerId,
            pluginId: body.pluginId,
            enabled: body.enabled,
            source: 'project' as const,
          };
          policyItems = [
            ...policyItems.filter(
              (item) =>
                !(
                  item.source === policy.source &&
                  item.providerId === policy.providerId &&
                  item.pluginId === policy.pluginId
                ),
            ),
            policy,
          ];
          return jsonResponse(policy);
        }
        if (method === 'DELETE' && url.startsWith('/api/provider-plugins/policy/project?')) {
          const params = new URL(url, 'http://localhost').searchParams;
          policyItems = policyItems.filter(
            (item) =>
              !(
                item.source === 'project' &&
                item.providerId === params.get('providerId') &&
                item.pluginId === params.get('pluginId')
              ),
          );
          return jsonResponse({ deleted: true });
        }
        return { ok: false, json: async () => ({ message: 'unexpected request' }) } as Response;
      },
    );
  });

  it('shows a project-selection empty state without loading project-scoped data', () => {
    useSelectedProjectMock.mockReturnValue({ ...projectSelection, selectedProjectId: undefined });

    renderPage();

    expect(screen.getByText('Select a project to manage provider plugins.')).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('pins the provider filter to Claude and excludes Codex catalog rows', async () => {
    policyItems = policyItems.filter((item) => item.source !== 'project');
    renderPage();

    const claudeRow = (await screen.findByText('Review Tools')).closest('tr');
    expect(claudeRow).not.toBeNull();
    expect(screen.getByLabelText('Provider filter pinned to Claude')).toHaveTextContent('Claude');
    expect(screen.queryByRole('combobox', { name: 'Filter by provider' })).not.toBeInTheDocument();
    expect(screen.queryByText('Profile Tools')).not.toBeInTheDocument();
    expect(
      within(claudeRow as HTMLElement).getByRole('switch', {
        name: 'DevChain Default policy for Review Tools',
      }),
    ).toBeChecked();
    expect(
      within(claudeRow as HTMLElement).getByRole('switch', {
        name: 'DevChain Default policy for Review Tools',
      }),
    ).toBeDisabled();
    expect(
      within(claudeRow as HTMLElement).getByRole('switch', {
        name: 'This Project policy for Review Tools',
      }),
    ).toBeChecked();
    expect(
      within(claudeRow as HTMLElement).getByRole('switch', {
        name: 'This Project policy for Review Tools',
      }),
    ).toBeDisabled();
    expect(screen.queryByRole('columnheader', { name: 'Active' })).not.toBeInTheDocument();
    expect(screen.queryByText('Inherited')).not.toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/provider-plugins/policy?projectId=project-1',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('sorts installed project-effective plugins first, then by normal catalog order', async () => {
    policyItems = [];
    catalogPlugins = [
      {
        ...claudeInstalledPlugin,
        pluginId: 'zulu@official',
        name: 'Zulu Active',
        providerEnabled: true,
      },
      {
        ...claudePlugin,
        pluginId: 'inactive@official',
        name: 'Inactive Plugin',
        installed: true,
        available: false,
      },
      {
        ...claudeInstalledPlugin,
        pluginId: 'alpha@official',
        name: 'Alpha Active',
        providerEnabled: true,
      },
      codexPlugin,
    ];
    renderPage();

    await screen.findByText('Alpha Active');
    const rows = screen.getAllByRole('row').slice(1);
    expect(within(rows[0]).getByText('Alpha Active')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Zulu Active')).toBeInTheDocument();
    expect(within(rows[2]).getByText('Inactive Plugin')).toBeInTheDocument();
    expect(screen.queryByText('Profile Tools')).not.toBeInTheDocument();
  });

  it('covers search and Installed/Available status filters', async () => {
    renderPage();

    await screen.findByText('Review Tools');
    const search = screen.getByRole('textbox', { name: 'Search plugins' });
    fireEvent.change(search, { target: { value: 'workflow' } });
    expect(screen.getByText('Workflow Tools')).toBeInTheDocument();
    expect(screen.queryByText('Review Tools')).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: '' } });
    fireEvent.click(screen.getByRole('combobox', { name: 'Filter by status' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Installed' }));
    expect(screen.getByText('Workflow Tools')).toBeInTheDocument();
    expect(screen.queryByText('Review Tools')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('combobox', { name: 'Filter by status' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Available' }));
    expect(screen.getByText('Review Tools')).toBeInTheDocument();
    expect(screen.queryByText('Workflow Tools')).not.toBeInTheDocument();
  });

  it('retries a failed policy query instead of refetching only the catalog', async () => {
    policyFailuresRemaining = 1;
    renderPage();

    expect(await screen.findByText('Policy service temporarily unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));

    expect(await screen.findByText('Review Tools')).toBeInTheDocument();
    const policyCalls = (global.fetch as jest.Mock).mock.calls.filter(
      ([url]) => typeof url === 'string' && url.startsWith('/api/provider-plugins/policy?'),
    );
    expect(policyCalls).toHaveLength(2);
  });

  it('omits installation actions and disables policy changes for plugins not yet installed', async () => {
    renderPage();

    const claudeRow = (await screen.findByText('Review Tools')).closest('tr');
    expect(claudeRow).not.toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Actions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /install/i })).not.toBeInTheDocument();
    expect(
      within(claudeRow as HTMLElement).getByRole('switch', {
        name: 'DevChain Default policy for Review Tools',
      }),
    ).toBeDisabled();
    expect(
      within(claudeRow as HTMLElement).getByRole('switch', {
        name: 'This Project policy for Review Tools',
      }),
    ).toBeDisabled();
    expect(global.fetch).not.toHaveBeenCalledWith(
      '/api/provider-plugins/install',
      expect.anything(),
    );
  });

  it('saves a project override and resets an explicit default policy', async () => {
    renderPage();

    const workflowRow = (await screen.findByText('Workflow Tools')).closest('tr');
    expect(workflowRow).not.toBeNull();
    const workflowProjectSwitch = within(workflowRow as HTMLElement).getByRole('switch', {
      name: 'This Project policy for Workflow Tools',
    });
    fireEvent.click(workflowProjectSwitch);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/provider-plugins/policy/project',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({
            projectId: 'project-1',
            providerId: 'provider-claude',
            pluginId: 'workflow@official',
            enabled: true,
          }),
        }),
      );
      expect(workflowProjectSwitch).toBeChecked();
    });

    const claudeRow = (await screen.findByText('Review Tools')).closest('tr');
    expect(claudeRow).not.toBeNull();
    fireEvent.click(within(claudeRow as HTMLElement).getByRole('button', { name: 'Reset' }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/provider-plugins/policy/default?providerId=provider-claude&pluginId=review%40official',
        expect.objectContaining({ method: 'DELETE' }),
      );
      expect(
        within(claudeRow as HTMLElement).getByRole('switch', {
          name: 'DevChain Default policy for Review Tools',
        }),
      ).not.toBeChecked();
      expect(
        within(claudeRow as HTMLElement).getByRole('switch', {
          name: 'This Project policy for Review Tools',
        }),
      ).not.toBeChecked();
      expect(within(claudeRow as HTMLElement).queryByRole('button', { name: 'Reset' })).toBeNull();
    });
  });

  it('creates an explicit project rule from the displayed effective value', async () => {
    policyItems = policyItems.filter((item) => item.source === 'default');
    catalogPlugins = [{ ...claudePlugin, installed: true, available: false }, codexPlugin];
    renderPage();

    const claudeRow = (await screen.findByText('Review Tools')).closest('tr');
    expect(claudeRow).not.toBeNull();
    const projectSwitch = within(claudeRow as HTMLElement).getByRole('switch', {
      name: 'This Project policy for Review Tools',
    });
    expect(projectSwitch).toBeChecked();

    fireEvent.click(projectSwitch);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/provider-plugins/policy/project',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({
            projectId: 'project-1',
            providerId: 'provider-claude',
            pluginId: 'review@official',
            enabled: false,
          }),
        }),
      );
      expect(projectSwitch).not.toBeChecked();
      expect(
        within(claudeRow as HTMLElement).getAllByRole('button', { name: 'Reset' }),
      ).toHaveLength(2);
    });
  });

  it('keeps policy controls pending until the policy refetch settles', async () => {
    renderPage();

    const workflowRow = (await screen.findByText('Workflow Tools')).closest('tr');
    expect(workflowRow).not.toBeNull();
    const workflowProjectSwitch = within(workflowRow as HTMLElement).getByRole('switch', {
      name: 'This Project policy for Workflow Tools',
    });

    const policyRefetch = createDeferred<Response>();
    deferredPolicyRefetch = policyRefetch;
    fireEvent.click(workflowProjectSwitch);

    await within(workflowRow as HTMLElement).findByText('Saving…');
    expect(workflowProjectSwitch).toBeDisabled();
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Plugin policy saved' }),
    );

    await act(async () => {
      policyRefetch.resolve(
        jsonResponse({
          items: [
            {
              providerId: 'provider-claude',
              pluginId: 'review@official',
              enabled: true,
              source: 'default',
            },
            {
              providerId: 'provider-claude',
              pluginId: 'workflow@official',
              enabled: true,
              source: 'project',
            },
          ],
        }),
      );
    });

    await waitFor(() => {
      expect(workflowProjectSwitch).toBeEnabled();
      expect(workflowProjectSwitch).toBeChecked();
      expect(within(workflowRow as HTMLElement).getByText('On')).toBeInTheDocument();
    });
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Plugin policy saved' }),
    );
  });
});

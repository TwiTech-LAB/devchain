import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RemoteListItemDto } from '@/modules/remotes/dtos/remote.dto';
import { LoginsTab } from './LoginsTab';
import { providerAuthKeys } from '@/ui/hooks/useProviderAuth';

jest.mock('@/ui/hooks/useHomeSocket', () => ({ useHomeSocket: jest.fn() }));
const mockToast = jest.fn();
jest.mock('@/ui/hooks/use-toast', () => ({ useToast: () => ({ toast: mockToast }) }));
const mockUseSelectedProject = jest.fn();
jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => mockUseSelectedProject(),
}));
jest.mock('@/ui/components/terminal/ChatTerminal', () => ({
  ChatTerminal: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="terminal-stub">{sessionId}</div>
  ),
}));

const TOKEN_VALUE = 'sk-ant-secret-token-value';

const OPENCODE_LOGINS = [
  { providerId: 'zai-coding-plan', type: 'api', importable: true, imported: false },
  { providerId: 'openai', type: 'oauth', importable: false, imported: false },
  { providerId: 'github', type: 'wellknown', importable: true, imported: true },
  { providerId: 'odd one', type: 'other', importable: false, imported: false },
] as const;

let entries: Array<Record<string, unknown>>;
let remotes: RemoteListItemDto[];
let generationState: string;
let generationsStarted: number;
let providerAuthListRequests: number;
let createStaticBody: Record<string, unknown> | null;
let importBody: Record<string, unknown> | null;
let renameBody: Record<string, unknown> | null;
// While set, a rename answers 400 with this message.
let renameRefusal: string | null;
let opencodeLogins: Array<Record<string, unknown>>;
// While set, the login list stays pending until the promise resolves.
let loginsGate: Promise<void> | null;
let loginsFail: boolean;

beforeEach(() => {
  mockToast.mockClear();
  entries = [];
  remotes = [];
  generationState = 'waiting';
  generationsStarted = 0;
  providerAuthListRequests = 0;
  createStaticBody = null;
  importBody = null;
  renameBody = null;
  renameRefusal = null;
  opencodeLogins = OPENCODE_LOGINS.map((login) => ({ ...login }));
  loginsGate = null;
  loginsFail = false;
  mockUseSelectedProject.mockReset().mockReturnValue({ projects: [], projectsLoading: false });
  global.fetch = jest.fn(async (url: string | undefined, init?: RequestInit) => {
    const target = String(url);
    const method = init?.method ?? 'GET';
    if (target === '/api/provider-auth' && method === 'GET') {
      providerAuthListRequests += 1;
      return { ok: true, json: async () => ({ items: entries }) } as Response;
    }
    if (target === '/api/provider-auth/static') {
      createStaticBody = init?.body ? JSON.parse(init.body as string) : null;
      entries = [
        ...entries,
        { id: 'e1', provider: 'claude', kind: 'static', label: 'Main token', payloadKind: 'env' },
      ];
      return { ok: true, status: 201, json: async () => entries[entries.length - 1] } as Response;
    }
    if (target === '/api/provider-auth/opencode-logins' && method === 'GET') {
      if (loginsGate) await loginsGate;
      if (loginsFail) {
        return {
          ok: false,
          status: 500,
          json: async () => ({ message: 'list failed' }),
        } as Response;
      }
      return { ok: true, json: async () => ({ logins: opencodeLogins }) } as Response;
    }
    if (target === '/api/provider-auth/opencode-import' && method === 'POST') {
      importBody = init?.body ? JSON.parse(init.body as string) : null;
      const providerIds = (importBody?.['providerIds'] as string[] | undefined) ?? [];
      const entryId = `import-${entries.length}`;
      entries = [
        ...entries,
        {
          id: entryId,
          provider: 'opencode',
          kind: 'static',
          label: providerIds.join(', ').slice(0, 128),
          payloadKind: 'opencode-entries',
        },
      ];
      return {
        ok: true,
        json: async () => ({
          results: providerIds.map((providerId) => ({
            providerId,
            outcome: 'imported',
            entryId,
          })),
        }),
      } as Response;
    }
    const renameMatch = target.match(/^\/api\/provider-auth\/([^/]+)$/);
    if (renameMatch && method === 'PATCH') {
      renameBody = init?.body ? JSON.parse(init.body as string) : null;
      if (renameRefusal) {
        const message = renameRefusal;
        return { ok: false, status: 400, json: async () => ({ message }) } as Response;
      }
      const current = entries.find((entry) => entry['id'] === renameMatch[1]) ?? {};
      const renamedEntry = { ...current, label: renameBody?.['label'] };
      entries = entries.map((entry) => (entry['id'] === renameMatch[1] ? renamedEntry : entry));
      return { ok: true, status: 200, json: async () => renamedEntry } as Response;
    }
    const releaseMatch = target.match(/^\/api\/provider-auth\/([^/]+)\/release$/);
    if (releaseMatch && method === 'POST') {
      const current = entries.find((entry) => entry['id'] === releaseMatch[1]) ?? {};
      const releasedEntry = { ...current, checkedOutRemoteId: null };
      entries = entries.map((entry) => (entry['id'] === releaseMatch[1] ? releasedEntry : entry));
      return {
        ok: true,
        status: 200,
        json: async () => ({ entry: releasedEntry, pullStatus: 'pulled' }),
      } as Response;
    }
    if (target === '/api/provider-auth/generate' && method === 'POST') {
      generationsStarted += 1;
      return {
        ok: true,
        status: 201,
        json: async () => ({
          id: 'g1',
          provider: 'codex',
          sessionId: 's1',
          state: generationState,
          startedAt: '2026-09-24T00:00:00.000Z',
          finishedAt: null,
          entries: [],
          error: null,
        }),
      } as Response;
    }
    if (target === '/api/provider-auth/generate/g1') {
      return {
        ok: true,
        json: async () => ({
          id: 'g1',
          provider: 'codex',
          sessionId: 's1',
          state: generationState,
          startedAt: '2026-09-24T00:00:00.000Z',
          finishedAt: generationState === 'stored' ? '2026-09-24T00:01:00.000Z' : null,
          entries:
            generationState === 'stored'
              ? [
                  {
                    id: 'e3',
                    provider: 'codex',
                    kind: 'family',
                    label: 'Codex login',
                    payloadKind: 'files',
                  },
                ]
              : [],
          error: null,
        }),
      } as Response;
    }
    if (target === '/api/provider-auth/e1' && method === 'DELETE') {
      entries = [];
      // Like the real route: 200 with an empty body.
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected end of JSON input');
        },
      } as unknown as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
});

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <LoginsTab remotes={remotes} />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

/** Opens Add login with a provider chosen. */
async function addLogin(provider: string) {
  await userEvent.click(screen.getByRole('button', { name: 'Add login' }));
  await userEvent.click(screen.getByRole('combobox', { name: 'Provider' }));
  await userEvent.click(await screen.findByRole('option', { name: provider }));
}

async function openImport() {
  await addLogin('OpenCode');
}

async function startSignIn(provider: string) {
  await addLogin(provider);
  await userEvent.click(screen.getByRole('button', { name: 'Start sign-in' }));
}

describe('LoginsTab', () => {
  // UI component: the real import hook and list refresh must render one group row.
  it('shows three imported OpenCode providers as one login row', async () => {
    const ids = ['anthropic', 'github', 'zai-coding-plan'];
    opencodeLogins = ids.map((providerId) => ({
      providerId,
      type: 'api',
      importable: true,
      imported: false,
    }));
    renderPanel();
    await openImport();
    await screen.findByRole('checkbox', { name: 'anthropic' });
    await userEvent.click(screen.getByTestId('opencode-import-submit'));
    await waitFor(() => expect(importBody).toEqual({ providerIds: ids }));
    for (const id of ids) {
      expect(await screen.findByTestId(`import-result-${id}`)).toHaveTextContent('imported');
    }
    await userEvent.keyboard('{Escape}');
    const row = await screen.findByRole('listitem', { name: ids.join(', ') });
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(within(row).getByText('Token')).toBeInTheDocument();
  });

  it('deletes an entry without an error toast for the empty answer', async () => {
    entries = [
      { id: 'e1', provider: 'claude', kind: 'static', label: 'Main token', payloadKind: 'env' },
    ];
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Delete Main token' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByText('Main token')).not.toBeInTheDocument());
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('stores a Claude token and lists the entry without its value', async () => {
    renderPanel();

    await addLogin('Claude');
    await userEvent.type(screen.getByLabelText('Label'), 'Main token');
    await userEvent.type(screen.getByLabelText('Token value'), TOKEN_VALUE);
    await userEvent.click(screen.getByTestId('add-token-submit'));

    await waitFor(() =>
      expect(createStaticBody).toEqual({
        provider: 'claude',
        label: 'Main token',
        token: TOKEN_VALUE,
      }),
    );
    const row = await screen.findByRole('listitem', { name: 'Main token' });
    expect(within(row).getByText('Token')).toBeInTheDocument();
    // The value never renders anywhere in the panel.
    expect(document.body.textContent).not.toContain(TOKEN_VALUE);
  });

  it('shows the logins as checkboxes with the approved defaults and submits the checked ids', async () => {
    renderPanel();

    await openImport();

    const zai = await screen.findByRole('checkbox', { name: 'zai-coding-plan' });
    expect(zai).toBeChecked();
    const openai = screen.getByRole('checkbox', { name: 'openai' });
    expect(openai).toBeDisabled();
    expect(screen.getByText('OAuth login: sign in instead')).toBeInTheDocument();
    const github = screen.getByRole('checkbox', { name: 'github' });
    expect(github).not.toBeChecked();
    expect(github).toBeEnabled();
    expect(
      screen.getByText('already imported — importing again adds a second entry'),
    ).toBeInTheDocument();
    const odd = screen.getByRole('checkbox', { name: 'odd one' });
    expect(odd).toBeDisabled();
    expect(screen.getByText('cannot be imported')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('opencode-import-submit'));

    await waitFor(() => expect(importBody).toEqual({ providerIds: ['zai-coding-plan'] }));
    expect(await screen.findByTestId('import-result-zai-coding-plan')).toHaveTextContent(
      'imported',
    );
  });

  it('keeps deselections across a refresh and unchecks ids an import stored', async () => {
    opencodeLogins = [
      { providerId: 'zai-coding-plan', type: 'api', importable: true, imported: false },
      { providerId: 'github', type: 'wellknown', importable: true, imported: false },
    ];
    renderPanel();

    await openImport();
    expect(await screen.findByRole('checkbox', { name: 'github' })).toBeChecked();

    await userEvent.click(screen.getByRole('checkbox', { name: 'zai-coding-plan' }));
    // The refresh after the import reports github as already in the vault.
    opencodeLogins = [
      { providerId: 'zai-coding-plan', type: 'api', importable: true, imported: false },
      { providerId: 'github', type: 'wellknown', importable: true, imported: true },
    ];
    await userEvent.click(screen.getByTestId('opencode-import-submit'));

    await waitFor(() => expect(importBody).toEqual({ providerIds: ['github'] }));
    expect(await screen.findByTestId('import-result-github')).toHaveTextContent('imported');
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'github' })).not.toBeChecked());
    // The deselected id stays deselected through the refresh, which also
    // relabels the imported row.
    expect(screen.getByRole('checkbox', { name: 'zai-coding-plan' })).not.toBeChecked();
    expect(
      await screen.findByText('already imported — importing again adds a second entry'),
    ).toBeInTheDocument();
  });

  // The real hook and query client exercise mutation results independently from query refreshes.
  it('preserves a post-import re-selection when changed login data is refetched', async () => {
    opencodeLogins = [
      { providerId: 'zai-coding-plan', type: 'api', importable: true, imported: false },
    ];
    const { client } = renderPanel();
    await openImport();
    expect(await screen.findByRole('checkbox', { name: 'zai-coding-plan' })).toBeChecked();

    await userEvent.click(screen.getByTestId('opencode-import-submit'));
    await screen.findByTestId('import-result-zai-coding-plan');
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'zai-coding-plan' })).not.toBeChecked(),
    );
    await userEvent.click(screen.getByRole('checkbox', { name: 'zai-coding-plan' }));
    expect(screen.getByRole('checkbox', { name: 'zai-coding-plan' })).toBeChecked();

    opencodeLogins = [
      { providerId: 'zai-coding-plan', type: 'api', importable: true, imported: true },
    ];
    await act(async () => {
      await client.invalidateQueries({ queryKey: providerAuthKeys.all });
    });
    await screen.findByText('already imported — importing again adds a second entry');
    expect(screen.getByRole('checkbox', { name: 'zai-coding-plan' })).toBeChecked();

    await userEvent.click(screen.getByTestId('opencode-import-submit'));
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'zai-coding-plan' })).not.toBeChecked(),
    );
  });

  it('preserves selection and deselection through a background refetch without an import', async () => {
    opencodeLogins = [
      { providerId: 'zai-coding-plan', type: 'api', importable: true, imported: false },
      { providerId: 'github', type: 'wellknown', importable: true, imported: false },
    ];
    const { client } = renderPanel();
    await openImport();
    expect(await screen.findByRole('checkbox', { name: 'github' })).toBeChecked();
    await userEvent.click(screen.getByRole('checkbox', { name: 'zai-coding-plan' }));

    opencodeLogins = [
      { providerId: 'zai-coding-plan', type: 'api', importable: true, imported: false },
      { providerId: 'github', type: 'wellknown', importable: true, imported: true },
    ];
    await act(async () => {
      await client.invalidateQueries({ queryKey: providerAuthKeys.all });
    });
    await screen.findByText('already imported — importing again adds a second entry');
    expect(screen.getByRole('checkbox', { name: 'zai-coding-plan' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'github' })).toBeChecked();
    expect(importBody).toBeNull();
  });

  it('loads the login list when the dialog opens and keeps Import disabled meanwhile', async () => {
    let releaseLogins!: () => void;
    loginsGate = new Promise<void>((resolve) => {
      releaseLogins = resolve;
    });
    renderPanel();

    await openImport();

    expect(await screen.findByText('Loading OpenCode logins…')).toBeInTheDocument();
    const submit = screen.getByTestId('opencode-import-submit');
    expect(submit).toBeDisabled();
    expect(submit.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    await act(async () => releaseLogins());
    expect(await screen.findByRole('checkbox', { name: 'zai-coding-plan' })).toBeChecked();
    expect(screen.getByTestId('opencode-import-submit').querySelector('svg')).toBeNull();
  });

  it('shows the empty state when the PC has no OpenCode logins', async () => {
    opencodeLogins = [];
    renderPanel();

    await openImport();

    expect(await screen.findByText('No OpenCode logins found on this PC')).toBeInTheDocument();
    expect(screen.getByTestId('opencode-import-submit')).toBeDisabled();
  });

  it('shows an error message when the login list cannot be loaded', async () => {
    loginsFail = true;
    renderPanel();

    await openImport();

    expect(await screen.findByText('Could not load the OpenCode logins.')).toBeInTheDocument();
    expect(screen.getByTestId('opencode-import-submit')).toBeDisabled();
  });

  it('generates a Codex login in the embedded terminal and closes when it is stored', async () => {
    renderPanel();

    await waitFor(() => expect(providerAuthListRequests).toBe(1));
    await startSignIn('Codex');
    await screen.findByTestId('terminal-stub');
    // Opening Add login reads the list once more; the stored login adds one refresh.
    const listed = providerAuthListRequests;
    expect(screen.getByText('s1')).toBeInTheDocument();
    expect(screen.getByTestId('login-generation-state')).toHaveTextContent(/Waiting for the login/);

    generationState = 'stored';
    entries = [
      { id: 'e3', provider: 'codex', kind: 'family', label: 'Codex login', payloadKind: 'files' },
    ];
    await waitFor(
      () =>
        expect(screen.getByTestId('login-generation-state')).toHaveTextContent(
          'Login verified and stored.',
        ),
      { timeout: 4000 },
    );
    await waitFor(() => expect(screen.queryByTestId('terminal-stub')).not.toBeInTheDocument(), {
      timeout: 4000,
    });
    expect(await screen.findByText('Codex login')).toBeInTheDocument();
    expect(providerAuthListRequests).toBe(listed + 1);
    expect(generationsStarted).toBe(1);
  });

  it('still invalidates the provider auth list when a generation is cancelled', async () => {
    renderPanel();

    await waitFor(() => expect(providerAuthListRequests).toBe(1));
    await startSignIn('Codex');
    await screen.findByTestId('terminal-stub');
    const listed = providerAuthListRequests;
    await userEvent.click(screen.getByRole('button', { name: 'Cancel login' }));

    await waitFor(() => expect(providerAuthListRequests).toBe(listed + 1));
  });

  // The component layer exercises the real hook, the list refresh, and the
  // row's key-by-entry-id behavior when the renamed row re-sorts.
  it('renames a login inline and shows the new name in the row', async () => {
    entries = [
      { id: 'e1', provider: 'claude', kind: 'static', label: 'Main token', payloadKind: 'env' },
    ];
    renderPanel();

    const row = await screen.findByRole('listitem', { name: 'Main token' });
    await userEvent.click(within(row).getByRole('button', { name: 'Rename Main token' }));
    const field = within(row).getByLabelText('Name');
    await userEvent.clear(field);
    await userEvent.type(field, 'Work token');
    await userEvent.type(field, '{Enter}');

    await waitFor(() => expect(renameBody).toEqual({ label: 'Work token' }));
    await waitFor(() =>
      expect(screen.getByRole('listitem', { name: 'Work token' })).toBeInTheDocument(),
    );
  });

  it('shows a refused rename once, inline, with no error toast', async () => {
    entries = [
      { id: 'e1', provider: 'claude', kind: 'static', label: 'Main token', payloadKind: 'env' },
    ];
    renameRefusal = 'label is too long';
    renderPanel();

    const row = await screen.findByRole('listitem', { name: 'Main token' });
    await userEvent.click(within(row).getByRole('button', { name: 'Rename Main token' }));
    const field = within(row).getByLabelText('Name');
    await userEvent.type(field, ' 2{Enter}');

    expect(await within(row).findByRole('alert')).toHaveTextContent('label is too long');
    expect(within(row).getByLabelText('Name')).toHaveValue('Main token 2');
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('cancels an inline rename with Escape and keeps the old name', async () => {
    entries = [
      { id: 'e1', provider: 'claude', kind: 'static', label: 'Main token', payloadKind: 'env' },
    ];
    renderPanel();

    const row = await screen.findByRole('listitem', { name: 'Main token' });
    await userEvent.click(within(row).getByRole('button', { name: 'Rename Main token' }));
    const field = within(row).getByLabelText('Name');
    await userEvent.type(field, ' ignored');
    await userEvent.keyboard('{Escape}');

    expect(screen.getByRole('listitem', { name: 'Main token' })).toBeInTheDocument();
    expect(within(row).queryByLabelText('Name')).not.toBeInTheDocument();
    expect(renameBody).toBeNull();
  });

  it('shows a login on a VM with the VM name', async () => {
    entries = [
      {
        id: 'e4',
        provider: 'codex',
        kind: 'family',
        label: 'Codex login',
        payloadKind: 'files',
        checkedOutRemoteId: 'r9',
      },
    ];
    remotes = [{ id: 'r9', name: 'lab-vm', logins: null } as RemoteListItemDto];

    renderPanel();
    const row = await screen.findByRole('listitem', { name: 'Codex login' });
    expect(row).toHaveTextContent('On lab-vm');
    expect(row).toHaveTextContent('Not checked yet');
  });

  // The component layer is the cheapest place to verify confirmation, mutation, and list refresh together.
  it('releases a login on a VM after confirmation and shows it as free', async () => {
    entries = [
      {
        id: 'e4',
        provider: 'codex',
        kind: 'family',
        label: 'Codex login',
        payloadKind: 'files',
        checkedOutRemoteId: 'r9',
      },
    ];
    renderPanel();

    const row = await screen.findByRole('listitem', { name: 'Codex login' });
    expect(row).toHaveTextContent('On a VM');
    await userEvent.click(screen.getByRole('button', { name: 'Release Codex login' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent("The VM's copy will stop being written back");
    await userEvent.click(within(dialog).getByRole('button', { name: 'Release' }));

    await waitFor(() =>
      expect(screen.getByRole('listitem', { name: 'Codex login' })).toHaveTextContent('Free'),
    );
    expect(providerAuthListRequests).toBeGreaterThanOrEqual(2);
  });
});

describe('LoginsTab sections', () => {
  function entry(partial: Record<string, unknown>) {
    return {
      kind: 'static',
      payloadKind: 'env',
      checkedOutRemoteId: null,
      createdAt: '2026-09-24T00:00:00.000Z',
      updatedAt: '2026-09-24T00:00:00.000Z',
      lastVerifiedAt: null,
      lastWritebackAt: null,
      ...partial,
    };
  }

  it('shows one section per provider in order, with an add link when empty', async () => {
    entries = [
      entry({ id: 'e1', provider: 'claude', label: 'Main token' }),
      entry({ id: 'e9', provider: 'gemini', label: 'Gemini key' }),
    ];
    renderPanel();

    await screen.findByText('Main token');
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Claude',
      'Codex',
      'Copilot',
      'Antigravity',
      'OpenCode',
      'Other keys',
    ]);
    expect(within(screen.getByRole('list', { name: 'Other keys' })).getByText('Gemini key'));
    expect(screen.getAllByText('No login yet.')).toHaveLength(4);

    await userEvent.click(screen.getByRole('button', { name: 'Add a Codex login' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add login' });
    expect(within(dialog).getByRole('combobox', { name: 'Provider' })).toHaveTextContent('Codex');
    expect(within(dialog).getByRole('button', { name: 'Start sign-in' })).toBeInTheDocument();
  });

  it('says where each login is used and when it was checked and saved', async () => {
    entries = [
      entry({
        id: 'e1',
        provider: 'claude',
        label: 'Main token',
        lastVerifiedAt: '2026-09-25T10:00:00.000Z',
      }),
      entry({ id: 'e2', provider: 'claude', label: 'Spare token' }),
      entry({
        id: 'e3',
        provider: 'codex',
        kind: 'family',
        payloadKind: 'files',
        label: 'Codex family',
        checkedOutRemoteId: 'r1',
        lastWritebackAt: '2026-09-26T10:00:00.000Z',
      }),
      entry({
        id: 'e4',
        provider: 'codex',
        kind: 'family',
        payloadKind: 'files',
        label: 'Spare family',
      }),
    ];
    remotes = [
      { id: 'r1', name: 'lab-vm', logins: { claude: { choice: 'reuse', entryIds: ['e1'] } } },
      { id: 'r2', name: 'build-vm', logins: { claude: { choice: 'reuse', entryIds: ['e1'] } } },
    ] as unknown as RemoteListItemDto[];
    renderPanel();

    const main = await screen.findByRole('listitem', { name: 'Main token' });
    expect(main).toHaveTextContent('Used by lab-vm, build-vm');
    expect(main).toHaveTextContent(
      `Checked ${new Date('2026-09-25T10:00:00.000Z').toLocaleString()}`,
    );
    expect(screen.getByRole('listitem', { name: 'Spare token' })).toHaveTextContent('Not used');
    const family = screen.getByRole('listitem', { name: 'Codex family' });
    expect(family).toHaveTextContent('Login');
    expect(family).toHaveTextContent('On lab-vm');
    expect(family).toHaveTextContent(
      `Saved from lab-vm ${new Date('2026-09-26T10:00:00.000Z').toLocaleString()}`,
    );
    expect(
      within(family).getByRole('button', { name: 'Release Codex family' }),
    ).toBeInTheDocument();
    const spare = screen.getByRole('listitem', { name: 'Spare family' });
    expect(spare).toHaveTextContent('Free');
    expect(within(spare).queryByRole('button', { name: /Release/ })).not.toBeInTheDocument();
  });
});

describe('Add login methods', () => {
  it.each([
    ['Claude', [], true, false],
    ['Copilot', ['Paste a token', 'Sign in'], true, false],
    ['Codex', [], false, true],
    ['Antigravity', [], false, true],
    ['OpenCode', ['Import from this PC', 'Sign in'], false, false],
  ] as const)('offers only what works for %s', async (provider, tabs, token, signIn) => {
    renderPanel();
    await addLogin(provider);
    const dialog = screen.getByRole('dialog', { name: 'Add login' });

    expect(
      within(dialog)
        .queryAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual([...tabs]);
    expect(Boolean(within(dialog).queryByLabelText('Token value'))).toBe(token);
    expect(Boolean(within(dialog).queryByRole('button', { name: 'Start sign-in' }))).toBe(signIn);
  });

  it('tells how to create a Claude token and gives no such hint for Copilot', async () => {
    renderPanel();
    await addLogin('Claude');
    const claudeDialog = screen.getByRole('dialog', { name: 'Add login' });
    expect(within(claudeDialog).getByText('claude setup-token')).toBeInTheDocument();
    expect(within(claudeDialog).getByText(/signed in to Claude, then paste/)).toBeInTheDocument();

    await userEvent.click(within(claudeDialog).getByRole('combobox', { name: 'Provider' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Copilot' }));
    expect(
      within(screen.getByRole('dialog', { name: 'Add login' })).queryByText(/setup-token/),
    ).not.toBeInTheDocument();
  });

  it('stores a Copilot token from its token tab', async () => {
    renderPanel();
    await addLogin('Copilot');
    await userEvent.type(screen.getByLabelText('Label'), 'GH token');
    await userEvent.type(screen.getByLabelText('Token value'), 'ghp-secret');
    await userEvent.click(screen.getByTestId('add-token-submit'));

    await waitFor(() =>
      expect(createStaticBody).toEqual({
        provider: 'copilot',
        label: 'GH token',
        token: 'ghp-secret',
      }),
    );
  });

  it('stores another environment key with its provider', async () => {
    renderPanel();
    await addLogin('Other key');
    await userEvent.type(screen.getByLabelText('Provider name'), 'Gemini');
    await userEvent.type(screen.getByLabelText('Environment key'), 'GEMINI_API_KEY');
    await userEvent.type(screen.getByLabelText('Label'), 'Gemini key');
    await userEvent.type(screen.getByLabelText('Value'), 'gm-secret');
    await userEvent.click(screen.getByTestId('add-token-submit'));

    await waitFor(() =>
      expect(createStaticBody).toEqual({
        provider: 'gemini',
        label: 'Gemini key',
        envKey: 'GEMINI_API_KEY',
        value: 'gm-secret',
      }),
    );
  });
});

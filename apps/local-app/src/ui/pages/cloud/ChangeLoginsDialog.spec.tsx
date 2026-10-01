import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ProviderAuthEntryItem } from '@/ui/hooks/useProviderAuth';
import { ChangeLoginsDialog } from './ChangeLoginsDialog';

let entries: ProviderAuthEntryItem[];
let changeBody: { providerAuth: Record<string, string>; force: boolean } | null;
let remoteSessions: Array<{ status: string; agentId: string | null }>;
let remoteSessionsFail: boolean;

function entry(
  partial: Partial<ProviderAuthEntryItem> & { id: string; provider: string },
): ProviderAuthEntryItem {
  return {
    kind: 'static',
    label: 'Entry',
    payloadKind: 'env',
    checkedOutRemoteId: null,
    createdAt: '2026-09-24T00:00:00.000Z',
    updatedAt: '2026-09-24T00:00:00.000Z',
    lastVerifiedAt: null,
    lastWritebackAt: null,
    ...partial,
  };
}

beforeEach(() => {
  entries = [];
  changeBody = null;
  remoteSessions = [];
  remoteSessionsFail = false;
  global.fetch = jest.fn(async (url: string | undefined, init?: RequestInit) => {
    const target = String(url);
    if (target === '/api/provider-auth/static' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { provider: string; label: string };
      const stored = entry({ id: 'new-token', provider: body.provider, label: body.label });
      entries = [...entries, stored];
      return { ok: true, status: 201, json: async () => stored } as Response;
    }
    if (target === '/api/provider-auth') {
      return { ok: true, json: async () => ({ items: entries }) } as Response;
    }
    if (target === '/r/r1/api/sessions') {
      if (remoteSessionsFail) {
        return { ok: false, status: 502, json: async () => ({}) } as Response;
      }
      return { ok: true, json: async () => remoteSessions } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
});

const recorded = {
  claude: { choice: 'reuse:e1', entryId: 'e1' },
  opencode: { choice: 'generate', entryIds: ['a1', 'a2'] },
};

function renderDialog(
  providerEnvOverrides: Array<{ key: string; source: string; provider: string }> = [],
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ChangeLoginsDialog
        remote={{
          id: 'r1',
          name: 'lab-vm',
          logins: recorded,
          providerEnvOverrides: providerEnvOverrides as never,
        }}
        remoteNames={new Map([['r2', 'vm-two']])}
        pending={false}
        onClose={jest.fn()}
        onChangeLogins={(providerAuth, force) => {
          changeBody = { providerAuth, force };
        }}
      />
    </QueryClientProvider>,
  );
}

async function settleSessions() {
  await waitFor(() =>
    expect(global.fetch).toHaveBeenCalledWith(
      '/r/r1/api/sessions',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ),
  );
}

async function choose(provider: string, option: string) {
  await userEvent.click(screen.getByRole('combobox', { name: `${provider} login choice` }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

const submit = () => screen.getByTestId('change-logins-submit');

describe('ChangeLoginsDialog', () => {
  it('starts every provider at Keep current, OpenCode with its login count', async () => {
    renderDialog();
    await settleSessions();

    expect(screen.getByRole('combobox', { name: 'opencode login choice' })).toHaveTextContent(
      'Keep current (2 logins)',
    );
    expect(screen.getByRole('combobox', { name: 'claude login choice' })).toHaveTextContent(
      'Keep current',
    );
    // Nothing changed yet: submit stays off.
    expect(submit()).toBeDisabled();
  });

  it('sends only the changed providers, None included as a removal', async () => {
    entries = [entry({ id: 'e1', provider: 'claude', label: 'Main token' })];
    renderDialog();
    await settleSessions();

    await choose('codex', 'New login (sign in during setup)');
    await choose('claude', 'None');
    await userEvent.click(submit());

    expect(changeBody).toEqual({
      providerAuth: { codex: 'generate', claude: 'skip' },
      force: false,
    });
  });

  it('shows a login another VM holds as disabled', async () => {
    entries = [
      entry({
        id: 'f1',
        provider: 'codex',
        kind: 'family',
        label: 'Codex family',
        checkedOutRemoteId: 'r2',
      }),
    ];
    renderDialog();
    await settleSessions();

    await userEvent.click(screen.getByRole('combobox', { name: 'codex login choice' }));
    expect(
      await screen.findByRole('option', { name: 'Codex family · Login · on vm-two' }),
    ).toHaveAttribute('aria-disabled', 'true');
  });

  it('warns with the running count for claude and copilot and sends without force', async () => {
    remoteSessions = [
      { status: 'running', agentId: 'a1' },
      { status: 'running', agentId: 'a2' },
      { status: 'stopped', agentId: 'a3' },
      { status: 'running', agentId: null },
    ];
    entries = [entry({ id: 'e1', provider: 'claude', label: 'Main token' })];
    renderDialog();
    await settleSessions();

    await choose('claude', 'Main token · Token');
    await waitFor(() =>
      expect(screen.getByTestId('env-warning')).toHaveTextContent(
        '2 agent sessions are running on this VM. Restart running agent sessions so they use the new logins.',
      ),
    );
    expect(screen.queryByTestId('family-block')).not.toBeInTheDocument();
    expect(submit()).toHaveTextContent('Change logins');

    await userEvent.click(submit());
    expect(changeBody).toEqual({ providerAuth: { claude: 'reuse:e1' }, force: false });
  });

  it("shows 'unknown' when the VM's session list cannot be read", async () => {
    remoteSessionsFail = true;
    renderDialog();
    await settleSessions();

    await choose('claude', 'None');
    await waitFor(() =>
      expect(screen.getByTestId('env-warning')).toHaveTextContent(
        'An unknown number of agent sessions are running on this VM.',
      ),
    );
  });

  it('blocks codex, agy and opencode changes while sessions run; Change anyway sends force', async () => {
    remoteSessions = [{ status: 'running', agentId: 'a1' }];
    renderDialog();
    await settleSessions();

    await choose('codex', 'New login (sign in during setup)');
    await waitFor(() =>
      expect(screen.getByTestId('family-block')).toHaveTextContent(
        '1 agent session is running on this VM. Stop them first; a running session overwrites the new login on its next refresh.',
      ),
    );
    expect(submit()).toHaveTextContent('Change anyway');

    await userEvent.click(submit());
    expect(changeBody).toEqual({ providerAuth: { codex: 'generate' }, force: true });
  });

  it('names the overriding keys the VM reports for a changed provider', async () => {
    renderDialog([
      { key: 'CLAUDE_CODE_OAUTH_TOKEN', source: 'provider-env', provider: 'claude' },
      { key: 'COPILOT_GITHUB_TOKEN', source: 'provider-config', provider: 'copilot' },
    ]);
    await settleSessions();

    await choose('claude', 'None');
    await waitFor(() =>
      expect(screen.getByTestId('override-warning')).toHaveTextContent(
        "The VM's provider settings hold CLAUDE_CODE_OAUTH_TOKEN (provider-env), which overrides this login. Remove it in that VM's Edit Provider.",
      ),
    );
    // Copilot was not changed, so its override stays unmentioned.
    expect(screen.queryAllByTestId('override-warning')).toHaveLength(1);
  });

  it("selects a token added through the step's Add a token link", async () => {
    renderDialog();
    await settleSessions();

    await userEvent.click(screen.getByRole('button', { name: 'Add a token' }));
    const add = await screen.findByRole('dialog', { name: 'Add login' });
    await userEvent.click(within(add).getByRole('combobox', { name: 'Provider' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Claude' }));
    await userEvent.type(within(add).getByLabelText('Label'), 'Fresh token');
    await userEvent.type(within(add).getByLabelText('Token value'), 'sk-fresh');
    await userEvent.click(within(add).getByTestId('add-token-submit'));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Add login' })).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'claude login choice' })).toHaveTextContent(
        'Fresh token · Token',
      ),
    );
    await userEvent.click(submit());
    expect(changeBody).toEqual({ providerAuth: { claude: 'reuse:new-token' }, force: false });
  });
});

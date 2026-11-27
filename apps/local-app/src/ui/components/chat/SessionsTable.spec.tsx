import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ProfileProviderConfig } from '@/ui/lib/provider-configs';
import type { SavePointAvailability, SessionTreeNode } from '@/ui/lib/sessions';
import { SessionsTable, type SessionsTableProps } from './SessionsTable';

const projectId = 'project-1';
const agentId = 'agent-1';
const treePath = `/api/sessions/agents/${agentId}/tree`;
const date = '2026-01-01T00:00:00.000Z';

function record(
  id: string,
  name: string,
  overrides: Partial<SessionTreeNode> = {},
): SessionTreeNode {
  return {
    id,
    name,
    kind: 'session',
    status: 'stopped',
    parentSessionId: null,
    providerSessionId: `provider-${id}`,
    providerNameAtLaunch: 'claude',
    startedAt: date,
    endedAt: null,
    lastActivityAt: null,
    sizeBytes: 2048,
    transcriptAvailable: true,
    beforeRollback: false,
    ...overrides,
  };
}

const root = record('root', 'Original session');
const savePoint = record('saved', 'Checkpoint', { kind: 'save_point', parentSessionId: root.id });
const fork = record('fork', 'Forked session', { parentSessionId: savePoint.id });
const nextRoot = record('older', 'Older session');
const nextSave = record('older-saved', 'Older checkpoint', {
  kind: 'save_point',
  parentSessionId: nextRoot.id,
});
// The session of this save point was deleted.
const orphan = { ...savePoint, parentSessionId: null };
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const olderFork = record('older-fork', 'Older fork', {
  parentSessionId: root.id,
  lastActivityAt: minutesAgo(30),
});
const newerFork = record('newer-fork', 'Newer fork', {
  parentSessionId: savePoint.id,
  lastActivityAt: minutesAgo(5),
});

const response = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

// Real query and tree components verify that the visible actions use the right records and cursors.
describe('SessionsTable', () => {
  const originalFetch = global.fetch;
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  let firstPage: SessionTreeNode[];
  let secondPage: SessionTreeNode[];
  let availability: SavePointAvailability;
  let requests: Array<{ url: string; options: RequestInit | undefined }>;
  const onRead = jest.fn();
  const onRestore = jest.fn();
  const onFork = jest.fn();
  const onRollback = jest.fn();

  function showTable(
    overrides: Partial<SessionsTableProps> = {},
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  ) {
    return render(
      <QueryClientProvider client={client}>
        <SessionsTable
          projectId={projectId}
          agentId={agentId}
          onRead={onRead}
          onRestore={onRestore}
          onFork={onFork}
          onRollback={onRollback}
          currentProviderName="claude"
          restoringSessionIds={{}}
          forkingSessionIds={{}}
          {...overrides}
        />
      </QueryClientProvider>,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    firstPage = [root, savePoint, fork];
    secondPage = [];
    availability = { available: true };
    requests = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      requests.push({ url: url.pathname + url.search, options });
      if (url.pathname === treePath) {
        const cursor = url.searchParams.get('cursor');
        const hasMore = !cursor && secondPage.length > 0;
        return response({
          items: cursor ? secondPage : firstPage,
          savePoints: availability,
          hasMore,
          nextCursor: hasMore ? 'older-roots' : null,
          total: secondPage.length ? 2 : 1,
        });
      }
      if (options?.method === 'PATCH') {
        const { name } = JSON.parse(String(options.body)) as { name: string };
        const id = url.pathname.split('/').at(-1);
        firstPage = firstPage.map((node) => (node.id === id ? { ...node, name } : node));
        return response(firstPage.find((node) => node.id === id));
      }
      if (options?.method === 'DELETE') {
        const id = url.pathname.split('/').at(-2);
        firstPage = firstPage.filter((node) => node.id !== id);
        return response(null);
      }
      throw new Error(`Unexpected request ${url.pathname}`);
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
    else Reflect.deleteProperty(navigator, 'clipboard');
  });

  async function expand(name: string) {
    fireEvent.click(await screen.findByRole('button', { name: `Expand ${name}` }));
  }

  const sessionRow = (name: string) => screen.getByRole('button', { name }).closest('tr')!;

  // The server sends save points as tree nodes; the table shows them only in the session's list.
  it.each([
    {
      scenario: 'a session with one save point is one row with no expand control',
      page: [root, savePoint],
      check: () => {
        expect(screen.getAllByRole('row')).toHaveLength(2);
        const row = within(sessionRow('Original session'));
        expect(row.getByRole('button', { name: '1 save point' })).toBeVisible();
        expect(row.queryByRole('button', { name: /^Expand/ })).toBeNull();
      },
    },
    {
      scenario: 'a fork of a save point is under the session',
      page: [root, savePoint, fork],
      check: async () => {
        await expand('Original session');
        expect(screen.getByRole('button', { name: 'Forked session' })).toBeVisible();
        expect(screen.queryByRole('button', { name: 'Checkpoint' })).toBeNull();
      },
    },
    {
      scenario: 'an orphan save point is a root row with its forks and no Roll back',
      page: [orphan, fork],
      check: async () => {
        const row = within(sessionRow('Checkpoint'));
        expect(row.getByRole('img', { name: 'Save point' })).toBeVisible();
        expect(row.getByRole('button', { name: 'Fork' })).toBeEnabled();
        await expand('Checkpoint');
        expect(screen.getByRole('button', { name: 'Forked session' })).toBeVisible();
        expect(screen.queryByRole('button', { name: /save points?$/ })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Roll back' })).toBeNull();
      },
    },
    {
      scenario: 'a newer fork of a save point sorts before an older direct fork',
      page: [root, savePoint, olderFork, newerFork],
      check: async () => {
        await expand('Original session');
        const forks = screen.getAllByRole('button', { name: /^(Newer|Older) fork$/ });
        expect(forks.map((button) => button.textContent)).toEqual(['Newer fork', 'Older fork']);
      },
    },
    {
      scenario: 'the path of a live fork of a save point is expanded',
      page: [root, savePoint, fork],
      liveSessionId: fork.id,
      check: () => {
        expect(screen.getByRole('button', { name: 'Collapse Original session' })).toBeVisible();
        expect(screen.getByRole('button', { name: 'Forked session' })).toBeVisible();
      },
    },
  ])('$scenario', async ({ page, liveSessionId, check }) => {
    firstPage = page;
    showTable({ liveSessionId });
    await screen.findByRole('columnheader', { name: 'Session' });
    await check();
  });

  it('collapses an expanded session', async () => {
    showTable();
    await expand('Original session');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Original session' }));
    expect(screen.queryByRole('button', { name: 'Forked session' })).toBeNull();
  });

  it('passes the selected session to Restore', async () => {
    showTable({ currentProviderName: 'Claude' });
    fireEvent.click(await screen.findByRole('button', { name: 'Restore session' }));
    expect(onRestore).toHaveBeenCalledWith(root, undefined);
  });

  describe('Restore on another provider', () => {
    const config = (id: string, name: string, providerName: string) =>
      ({ id, name, providerName }) as ProfileProviderConfig;
    const codexConfigs = [
      config('cfg-claude', 'claude-default', 'claude'),
      config('cfg-codex-1', 'codex-default', 'Codex'),
      config('cfg-codex-2', 'codex-fast', 'codex'),
    ];

    it('enables Restore with the first config on the launch provider and passes it', async () => {
      firstPage = [{ ...root, providerNameAtLaunch: 'codex' }];
      showTable({
        currentProviderName: 'claude',
        agentName: 'Coder',
        providerConfigs: codexConfigs,
      });
      const restore = await screen.findByRole('button', {
        name: 'Restore session. Restores on Codex (codex-default)',
      });
      expect(restore).toBeEnabled();
      fireEvent.click(restore);
      expect(onRestore).toHaveBeenCalledWith(firstPage[0], codexConfigs[1]);
    });

    it.each([
      {
        name: 'when the profile has no config on the launch provider',
        providerConfigs: [codexConfigs[0]],
        reason: "Started with Codex. Coder uses Claude. Coder's profile has no Codex config.",
      },
      {
        name: "with today's reason while the configs are not loaded",
        providerConfigs: undefined,
        reason: 'Started with Codex. Coder uses Claude.',
      },
    ])('disables Restore $name', async ({ providerConfigs, reason }) => {
      firstPage = [{ ...root, providerNameAtLaunch: 'codex' }];
      showTable({ currentProviderName: 'claude', agentName: 'Coder', providerConfigs });
      const restore = await screen.findByRole('button', { name: reason });
      expect(restore).toBeDisabled();
    });
  });

  it.each([
    {
      problem: 'no provider session ID',
      nativeId: null,
      provider: 'claude',
      reason: "Cannot restore — provider session id wasn't captured for this run.",
    },
    {
      problem: 'a changed provider',
      nativeId: root.providerSessionId,
      provider: 'codex',
      reason: 'Started with Claude. Coder uses Codex.',
    },
  ])('blocks Restore for $problem', async ({ nativeId, provider, reason }) => {
    firstPage = [{ ...root, providerSessionId: nativeId }];
    showTable({ currentProviderName: provider, agentName: 'Coder' });
    const restore = await screen.findByRole('button', { name: reason });
    expect(restore).toBeDisabled();
    fireEvent.click(restore);
    expect(onRestore).not.toHaveBeenCalled();
  });

  it('opens the save point list from the chip of a stopped session and forks from it', async () => {
    showTable();
    fireEvent.click(await screen.findByRole('button', { name: '1 save point' }));
    const list = await screen.findByRole('list', { name: 'Save points' });
    fireEvent.click(within(list).getByRole('button', { name: 'Fork from save point' }));
    expect(onFork).toHaveBeenCalledWith(savePoint, { available: true });
  });

  it('omits Fork on an orphan save point for a team member while leaving Read available', async () => {
    availability = { available: false, reason: 'TEAM_MEMBER' };
    firstPage = [orphan];
    showTable();
    const row = await screen.findByRole('row', { name: /Checkpoint/ });
    expect(within(row).queryByRole('button', { name: 'Fork' })).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'Read transcript' }));
    expect(onRead).toHaveBeenCalledWith(orphan);
  });

  // The table owns Fork visibility and disabled states and passes the selected row
  // to its caller. Rendering the table exercises all three through its public props.
  it.each(['stopped', 'failed'] as const)('passes a %s session to Fork', async (status) => {
    const session = { ...root, status };
    firstPage = [session];
    showTable();
    const row = await screen.findByRole('row', { name: /Original session/ });
    fireEvent.click(within(row).getByRole('button', { name: 'Fork' }));
    expect(onFork).toHaveBeenCalledWith(session, { available: true });
  });

  it.each([
    { scenario: 'a running session', status: 'running', reason: undefined },
    { scenario: 'a team member', status: 'stopped', reason: 'TEAM_MEMBER' },
    { scenario: 'an unsupported provider', status: 'stopped', reason: 'PROVIDER_UNSUPPORTED' },
  ] as const)('hides Fork for $scenario', async ({ status, reason }) => {
    firstPage = [{ ...root, status }];
    if (reason) availability = { available: false, reason };
    showTable();
    const row = await screen.findByRole('row', { name: /Original session/ });
    expect(within(row).queryByRole('button', { name: 'Fork' })).toBeNull();
  });

  it.each([
    { scenario: 'a provider mismatch', node: { providerNameAtLaunch: 'codex' } },
    // Restore accepts this legacy row, but the server rejects it as a fork source.
    { scenario: 'no launch provider', node: { providerNameAtLaunch: null } },
    { scenario: 'a missing provider session ID', node: { providerSessionId: null } },
    { scenario: 'an unavailable transcript', node: { transcriptAvailable: false } },
  ])('disables Fork for $scenario', async ({ node }) => {
    firstPage = [{ ...root, ...node }];
    showTable();
    const row = await screen.findByRole('row', { name: /Original session/ });
    const forkButton = within(row).getByRole('button', { name: 'Fork' });
    expect(forkButton).toBeDisabled();
    fireEvent.click(forkButton);
    expect(onFork).not.toHaveBeenCalled();
  });

  // The controls hook drops a second action on a pending source without a request or a toast.
  it.each([
    { started: 'Restore session', other: 'Fork', ids: 'restoringSessionIds' },
    { started: 'Fork', other: 'Restore session', ids: 'forkingSessionIds' },
  ] as const)('blocks $other while $started is pending', async ({ started, other, ids }) => {
    showTable({ [ids]: { [root.id]: true } });
    const row = await screen.findByRole('row', { name: /Original session/ });
    expect(within(row).getByRole('button', { name: started })).toHaveAttribute('aria-busy', 'true');
    const blocked = within(row).getByRole('button', { name: other });
    expect(blocked).toBeDisabled();
    expect(blocked).not.toHaveAttribute('aria-busy');
    fireEvent.click(blocked);
    expect(onRestore).not.toHaveBeenCalled();
    expect(onFork).not.toHaveBeenCalled();
  });

  it('blocks Fork, Restore and Delete on a session while it rolls back', async () => {
    firstPage = [root, savePoint, nextRoot];
    showTable({ rollingBackSessionIds: { [root.id]: true } });
    const pending = within(await screen.findByRole('row', { name: /Original session/ }));
    const other = within(screen.getByRole('row', { name: /Older session/ }));

    for (const name of ['Fork', 'Restore session', 'Delete session record']) {
      expect(pending.getByRole('button', { name })).toBeDisabled();
      expect(other.getByRole('button', { name })).toBeEnabled();
    }
  });

  it('shows Live in green on the live row, on the same line as its name', async () => {
    showTable({ liveSessionId: root.id });
    const name = await screen.findByRole('button', { name: 'Original session' });
    const live = screen.getByText('Live');
    expect(live.parentElement).toBe(name.parentElement);
    expect(live).toHaveClass('text-status-ok');
  });

  // A renamed save point no longer has the "Save point ·" default name, so the mark uses its kind.
  it('marks a renamed orphan save point in the info color and leaves sessions unmarked', async () => {
    firstPage = [orphan, root];
    showTable();
    const savedName = await screen.findByRole('button', { name: 'Checkpoint' });
    const savedRow = savedName.closest('tr')!;
    expect(within(savedRow).getByRole('img', { name: 'Save point' })).toHaveClass(
      'text-status-info',
    );
    expect(within(savedName).getByText('Checkpoint')).toHaveClass('text-status-info');

    const sessionName = screen.getByRole('button', { name: 'Original session' });
    const sessionRow = sessionName.closest('tr')!;
    expect(within(sessionRow).queryByRole('img', { name: 'Save point' })).toBeNull();
    expect(within(sessionName).getByText('Original session')).not.toHaveClass('text-status-info');
  });

  it('loads the next roots with their descendants and keeps the first tree expanded', async () => {
    secondPage = [nextRoot, nextSave];
    showTable();
    await expand('Original session');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    const older = within(await screen.findByRole('row', { name: /Older session/ }));
    expect(older.getByRole('button', { name: '1 save point' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Forked session' })).toBeVisible();
    expect(requests.map(({ url }) => url)).toEqual([
      `${treePath}?projectId=${projectId}&limit=20&scope=family`,
      `${treePath}?projectId=${projectId}&limit=20&scope=family&cursor=older-roots`,
    ]);
  });

  it('renames inline, preserving the original when Escape cancels the draft', async () => {
    showTable();
    fireEvent.click(await screen.findByRole('button', { name: root.name! }));
    const draft = screen.getByRole('textbox', { name: 'Session name' });
    fireEvent.change(draft, { target: { value: 'Discarded edit' } });
    fireEvent.keyDown(draft, { key: 'Escape' });
    expect(requests.some(({ options }) => options?.method === 'PATCH')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: root.name! }));
    const input = screen.getByRole('textbox', { name: 'Session name' });
    fireEvent.change(input, { target: { value: ' Renamed session ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByRole('button', { name: 'Renamed session' })).toBeVisible();
    await waitFor(() =>
      expect(requests).toContainEqual({
        url: '/api/sessions/root',
        options: expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ projectId, name: 'Renamed session' }),
        }),
      }),
    );
  });

  // The bar modal unmounts the table on close; the pending rename must survive a reopen.
  it('keeps a rename blocked after the table remounts until the pending request settles', async () => {
    const fetchMock = global.fetch as jest.Mock;
    const respond = fetchMock.getMockImplementation()!;
    let releasePatch: (() => void) | undefined;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, options?: RequestInit) => {
      if (options?.method === 'PATCH') {
        await new Promise<void>((resolve) => {
          releasePatch = resolve;
        });
      }
      return respond(input, options);
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const modal = { liveSessionId: fork.id };

    const first = showTable(modal, client);
    fireEvent.click(await screen.findByRole('button', { name: root.name! }));
    const input = screen.getByRole('textbox', { name: 'Session name' });
    fireEvent.change(input, { target: { value: 'First' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(releasePatch).toBeDefined());
    first.unmount();

    showTable(modal, client);
    expect(await screen.findByRole('button', { name: 'First' })).toBeDisabled();

    await act(async () => releasePatch!());
    await waitFor(() => expect(screen.getByRole('button', { name: 'First' })).toBeEnabled());
    expect(requests.filter(({ options }) => options?.method === 'PATCH')).toHaveLength(1);
  });

  it('labels a session with no name by its DevChain ID, also after its provider ID changes', async () => {
    const unnamed = { ...root, id: 'abcdef0123456789', name: null };
    firstPage = [unnamed];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    showTable({}, client);
    expect(await screen.findByRole('button', { name: 'abcdef01' })).toBeVisible();

    firstPage = [{ ...unnamed, providerSessionId: 'rolled-back-provider-id' }];
    await act(async () => {
      await client.invalidateQueries();
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'abcdef01' })).toHaveAttribute(
        'title',
        'rolled-back-provider-id',
      ),
    );
  });

  it.each([null, root.providerSessionId])(
    'copies the available ID when the provider ID is %s',
    async (providerSessionId) => {
      firstPage = [{ ...root, providerSessionId }];
      const writeText = jest.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
      showTable();
      const copy = await screen.findByRole('button', { name: 'Copy session ID' });
      await act(async () => {
        fireEvent.click(copy);
      });
      expect(writeText).toHaveBeenCalledWith(providerSessionId ?? root.id);
    },
  );

  it('waits for confirmation before deleting a record and then refreshes the tree', async () => {
    firstPage = [root];
    showTable();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete session record' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(requests.some(({ options }) => options?.method === 'DELETE')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Delete session record' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: root.name! })).toBeNull());
    expect(requests).toContainEqual({
      url: `/api/sessions/${root.id}/record?projectId=${projectId}`,
      options: expect.objectContaining({ method: 'DELETE' }),
    });
  });

  describe('family sessions', () => {
    const other = { agentId: 'agent-2', agentName: 'Coder (2)' };
    const own = { agentId, agentName: 'Coder' };

    it.each([
      {
        scenario: 'an icon with alt text and the provider name as title',
        provider: 'claude',
        check: (row: HTMLElement) => {
          const icon = within(row).getByRole('img', { name: 'Claude icon' });
          expect(icon).toHaveAttribute('title', 'Claude');
        },
      },
      {
        scenario: 'the name for a provider without an icon',
        provider: 'mystery',
        check: (row: HTMLElement) => {
          expect(within(row).getByText('Mystery')).toBeVisible();
          expect(within(row).queryByRole('img', { name: /icon$/ })).toBeNull();
        },
      },
      {
        scenario: '"Provider unknown" for no recorded provider',
        provider: null,
        check: (row: HTMLElement) => {
          expect(within(row).getByText('Provider unknown')).toBeVisible();
        },
      },
    ])('shows $scenario on a session row', async ({ provider, check }) => {
      firstPage = [{ ...root, providerNameAtLaunch: provider }];
      showTable();
      check(await screen.findByRole('row', { name: /Original session/ }));
    });

    it('shows no provider on a save point', async () => {
      firstPage = [orphan];
      showTable();
      const row = await screen.findByRole('row', { name: /Checkpoint/ });
      expect(within(row).queryByRole('img', { name: /icon$/ })).toBeNull();
      expect(within(row).queryByText('Provider unknown')).toBeNull();
    });

    it('shows the owner only on rows of another agent', async () => {
      firstPage = [
        record('mine', 'Mine', own),
        record('legacy', 'Legacy'),
        record('theirs', 'Theirs', other),
      ];
      showTable();
      const theirs = within(await screen.findByRole('row', { name: /Theirs/ }));
      expect(theirs.getByText('Coder (2)')).toHaveAttribute('title', 'Owned by Coder (2)');
      for (const name of [/Mine/, /Legacy/]) {
        expect(within(screen.getByRole('row', { name })).queryByTitle(/^Owned by/)).toBeNull();
      }
    });

    it('offers no change to a session running on another agent', async () => {
      const running = record('running', 'Elsewhere', { ...other, status: 'running' });
      const runningSave = record('running-saved', 'Its checkpoint', {
        ...other,
        kind: 'save_point',
        parentSessionId: running.id,
      });
      firstPage = [running, runningSave];
      showTable();
      const row = within(await screen.findByRole('row', { name: /Elsewhere/ }));
      expect(row.getByText('Running on Coder (2)')).toBeVisible();
      const restore = row.getByRole('button', { name: 'Running on Coder (2)' });
      expect(restore).toBeDisabled();
      expect(row.queryByRole('button', { name: 'Fork' })).toBeNull();
      expect(row.queryByRole('button', { name: 'Delete session record' })).toBeNull();

      fireEvent.click(row.getByRole('button', { name: '1 save point' }));
      const list = within(await screen.findByRole('list', { name: 'Save points' }));
      expect(list.getByText('Running on Coder (2)')).toBeVisible();
      expect(list.queryByRole('button', { name: 'Roll back' })).toBeNull();
      expect(list.queryByRole('button', { name: 'Fork from save point' })).toBeNull();
    });

    it('restores a stopped session of another agent but forks only after the restore', async () => {
      const theirs = record('theirs', 'Theirs', other);
      const theirSave = record('their-saved', 'Their checkpoint', {
        ...other,
        kind: 'save_point',
        parentSessionId: theirs.id,
      });
      firstPage = [theirs, theirSave];
      showTable();
      const row = within(await screen.findByRole('row', { name: /Theirs/ }));
      fireEvent.click(row.getByRole('button', { name: 'Restore session' }));
      expect(onRestore).toHaveBeenCalledWith(theirs, undefined);

      const fork = row.getByRole('button', { name: 'Fork' });
      expect(fork).toBeDisabled();
      fireEvent.focus(fork.parentElement!);
      expect(await screen.findByRole('tooltip')).toHaveTextContent('Restore to this agent first');

      fireEvent.click(row.getByRole('button', { name: '1 save point' }));
      const list = within(await screen.findByRole('list', { name: 'Save points' }));
      expect(list.getByText('Restore to this agent first')).toBeVisible();
      expect(list.queryByRole('button', { name: 'Roll back' })).toBeNull();
    });

    it('blocks Fork on an orphan save point of another agent', async () => {
      firstPage = [{ ...orphan, ...other }];
      showTable();
      const row = within(await screen.findByRole('row', { name: /Checkpoint/ }));
      const fork = row.getByRole('button', { name: 'Fork' });
      expect(fork).toBeDisabled();
      fireEvent.focus(fork.parentElement!);
      expect(await screen.findByRole('tooltip')).toHaveTextContent('Owned by Coder (2)');
    });

    it('fetches the tree again when the Sessions modal opens', async () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const first = showTable({ liveSessionId: root.id }, client);
      await screen.findByRole('button', { name: 'Original session' });
      first.unmount();
      expect(requests).toHaveLength(1);

      showTable({ liveSessionId: root.id }, client);
      await waitFor(() => expect(requests).toHaveLength(2));
    });
  });
});

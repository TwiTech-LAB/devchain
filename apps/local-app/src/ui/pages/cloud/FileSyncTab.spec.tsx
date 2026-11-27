import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileSyncTab, type FileSyncTabActions, type FileSyncTabData } from './FileSyncTab';
import type {
  FileSyncStatusFolder,
  FileSyncStatusResponse,
  FileSyncStatusScope,
  FileSyncVerdict,
} from './lib/remote-vm-contracts';
import type { ProjectListRow } from './ProjectList';
import { syncScope } from './testing/file-sync-status.fixture';

// The tab is pure rendering of the details answer plus local view state, so the component layer
// covers it; the controller's query and poll are covered in RemoteVmSection.spec.

const AT = '2026-11-24T19:00:00.000Z';

function scope(overrides: Partial<FileSyncStatusScope> = {}): FileSyncStatusScope {
  return syncScope({ files: 12, bytes: 2048, folders: [], ...overrides });
}

function folder(overrides: Partial<FileSyncStatusFolder> = {}): FileSyncStatusFolder {
  return {
    id: 'code:p1',
    kind: 'code',
    type: 'sendreceive',
    paused: false,
    state: 'idle',
    remoteState: 'valid',
    files: 1,
    bytes: 1,
    toVm: null,
    fromVm: null,
    errors: 0,
    error: null,
    watchError: null,
    lastReceived: null,
    pending: [],
    ...overrides,
  };
}

function status(...scopes: FileSyncStatusScope[]): FileSyncStatusResponse {
  return {
    checkedAt: AT,
    syncthing: { running: true, version: 'v2.1.5', error: null },
    links: [
      {
        remoteId: 'r1',
        connected: true,
        since: AT,
        address: '10.0.0.5:22000',
        sentBytes: 1024,
        receivedBytes: 2048,
      },
    ],
    scopes,
  };
}

function listRow(remoteId: string, state = 'remote'): ProjectListRow {
  return {
    project: { id: 'p1', name: 'Project One' },
    status: { state, remoteId },
  } as unknown as ProjectListRow;
}
const row = listRow('r1');

const NAMES = new Map([
  ['p1', 'Project One'],
  ['p2', 'Project Two'],
  ['p3', 'alpha'],
  ['p4', 'Beta'],
  ['p5', 'gamma'],
  ['p6', 'Delta'],
  ['p7', 'Epsilon'],
]);

function renderTab(data: Partial<FileSyncTabData> = {}, canFix = true) {
  const refresh = jest.fn(() => Promise.resolve());
  const actions: FileSyncTabActions = {
    openSettings: jest.fn(),
    fixFileSync: jest.fn(),
    canFixFileSync: () => canFix,
  };
  const props = (next: Partial<FileSyncTabData>) => ({
    status: status(scope()),
    loading: false,
    error: null,
    projectNames: NAMES,
    remoteNames: new Map([['r1', 'lab-vm']]),
    rows: [row],
    refresh,
    actions,
    ...next,
  });
  const { rerender } = render(<FileSyncTab {...props(data)} />);
  return {
    actions,
    refresh,
    rerender: (next: Partial<FileSyncTabData>) => rerender(<FileSyncTab {...props(next)} />),
  };
}

/** The project names of the table rows, top to bottom. */
const rowNames = () =>
  screen
    .getAllByRole('row')
    .map((element) => element.getAttribute('aria-label'))
    .filter(Boolean);

const toggle = (name: string) =>
  within(screen.getByRole('row', { name })).getByRole('button', { name });

describe('FileSyncTab', () => {
  const VERDICTS: [FileSyncVerdict, string][] = [
    ['problem', 'p1'],
    ['disconnected', 'p2'],
    ['unknown', 'p3'],
    ['syncing', 'p4'],
    ['waiting', 'p5'],
    ['busy', 'p6'],
    ['in-sync', 'p7'],
  ];
  const everyVerdict = () =>
    status(...VERDICTS.map(([verdict, projectId]) => scope({ verdict, projectId })));

  it.each([
    ['All', 7, ['Project One', 'Project Two', 'alpha', 'Beta', 'Delta', 'Epsilon', 'gamma']],
    ['Needs attention', 3, ['Project One', 'Project Two', 'alpha']],
    ['Syncing or paused', 3, ['Beta', 'Delta', 'gamma']],
    ['In sync', 1, ['Epsilon']],
  ])('filters %s with a count of %i over the seven verdicts', async (label, count, names) => {
    renderTab({ status: everyVerdict() });
    const chip = screen.getByRole('button', { name: new RegExp(`^${label}`) });
    expect(chip).toHaveAccessibleName(`${label} ${count}`);
    await userEvent.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect([...rowNames()].sort()).toEqual([...names].sort());
  });

  it('lists projects that need attention first, then by name', () => {
    renderTab({ status: everyVerdict() });
    expect(rowNames()).toEqual([
      'alpha',
      'Project One',
      'Project Two',
      'Beta',
      'Delta',
      'Epsilon',
      'gamma',
    ]);
  });

  it('searches project names without changing the counts, and says when nothing matches', async () => {
    renderTab({ status: everyVerdict() });
    const search = screen.getByRole('searchbox', { name: 'Search projects' });
    await userEvent.type(search, 'PROJECT');
    expect(rowNames()).toEqual(['Project One', 'Project Two']);
    expect(screen.getByRole('button', { name: /^All/ })).toHaveAccessibleName('All 7');

    await userEvent.click(screen.getByRole('button', { name: /^In sync/ }));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText('No project matches.')).toBeInTheDocument();
  });

  it('keeps an expanded project open when a new status answer moves it', async () => {
    const { rerender } = renderTab({ status: status(scope(), scope({ projectId: 'p2' })) });
    await userEvent.click(toggle('Project Two'));
    expect(rowNames()).toEqual(['Project One', 'Project Two']);

    rerender({
      status: status(scope(), scope({ projectId: 'p2', verdict: 'problem', reason: 'Disk full.' })),
    });
    expect(rowNames()).toEqual(['Project Two', 'Project One']);
    expect(toggle('Project Two')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('region', { name: 'Project Two details' })).toBeInTheDocument();
  });

  it('expands a project with the keyboard into its facts and folders', async () => {
    renderTab({
      status: status(
        scope({
          verdict: 'waiting',
          toVm: { items: 3, bytes: 3072 },
          failed: { home: 2, vm: 1 },
          lastReceived: { path: 'src/b.ts', deleted: true, at: AT },
          folders: [
            folder({
              watchError: 'too many files',
              pending: [
                { direction: 'toVm', path: 'src/a.ts' },
                { direction: 'fromVm', path: 'build/out.js' },
              ],
            }),
            folder({
              id: 'git:p1',
              kind: 'git',
              type: 'receiveonly',
              paused: true,
              error: 'folder path missing',
            }),
          ],
        }),
      ),
    });
    const button = toggle('Project One');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    button.focus();
    await userEvent.keyboard('{Enter}');
    expect(button).toHaveAttribute('aria-expanded', 'true');

    const details = screen.getByRole('region', { name: 'Project One details' });
    expect(button).toHaveAttribute('aria-controls', details.id);
    expect(details).toHaveTextContent('To the VM3 items, 3.0 KB');
    expect(details).toHaveTextContent('Failed2 on this PC · 1 on the VM (last reported)');
    expect(details).toHaveTextContent('Files12 files, 2.0 KB');
    expect(details).toHaveTextContent(
      `Last receivedsrc/b.ts (deleted) at ${new Date(AT).toLocaleString()}`,
    );
    const files = within(details).getByRole('region', { name: 'Project files' });
    expect(files).toHaveTextContent('Two-way');
    expect(files).toHaveTextContent(
      'This PC does not watch this folder for changes: too many files. Changes sync after the next scan.',
    );
    expect(files).toHaveTextContent('Waiting to go to the VMsrc/a.ts');
    expect(files).toHaveTextContent('Waiting to come from the VMbuild/out.js');
    const git = within(details).getByRole('region', { name: 'Git history' });
    expect(git).toHaveTextContent('This PC receives');
    expect(git).toHaveTextContent('Paused');
    expect(git).toHaveTextContent('folder path missing');
  });

  it('says the folder details are loading while the scope has none', async () => {
    renderTab({ status: status(scope({ folders: undefined })) });
    await userEvent.click(toggle('Project One'));
    expect(
      within(screen.getByRole('region', { name: 'Project One details' })).getByText(
        'Loading the folder details…',
      ),
    ).toBeInTheDocument();
  });

  it.each<[string, ProjectListRow, boolean, string[]]>([
    ['is on the VM and can be fixed', row, true, ['File sync settings', 'Fix file sync']],
    ['is on the VM and has nothing to fix', row, false, ['File sync settings']],
    ['is now bound to another VM', listRow('r2'), true, []],
    ['is moving back to this PC', listRow('r1', 'busy'), true, []],
  ])('offers the actions when the project %s', async (_case, current, canFix, labels) => {
    const { actions } = renderTab({ rows: [current] }, canFix);
    const projectRow = screen.getByRole('row', { name: 'Project One' });
    await userEvent.click(toggle('Project One'));
    const details = screen.getByRole('region', { name: 'Project One details' });
    const offered = (scopeElement: HTMLElement) =>
      within(scopeElement)
        .queryAllByRole('button')
        .map((button) => button.textContent)
        .filter((text) => text === 'File sync settings' || text === 'Fix file sync');
    expect(offered(details)).toEqual(labels);
    expect(offered(projectRow)).toEqual(labels.filter((label) => label === 'Fix file sync'));

    if (labels.length === 2) {
      fireEvent.click(within(details).getByRole('button', { name: 'File sync settings' }));
      fireEvent.click(within(projectRow).getByRole('button', { name: 'Fix file sync' }));
      expect(actions.openSettings).toHaveBeenCalledWith(row);
      expect(actions.fixFileSync).toHaveBeenCalledWith(row);
    }
  });

  it('shows unknown for values home could not read', async () => {
    renderTab({
      status: {
        ...status(
          scope({
            verdict: 'unknown',
            reason: 'DevChain could not read the file sync status.',
            toVm: null,
            fromVm: null,
            failed: { home: null, vm: null },
            files: null,
            bytes: null,
          }),
        ),
      },
    });
    const projectRow = screen.getByRole('row', { name: 'Project One' });
    expect(projectRow).toHaveTextContent('To VM: unknownFrom VM: unknown');
    await userEvent.click(toggle('Project One'));
    const details = screen.getByRole('region', { name: 'Project One details' });
    expect(details).toHaveTextContent('To the VMunknown');
    expect(details).toHaveTextContent('From the VMunknown');
    expect(details).toHaveTextContent(
      'Failedunknown on this PC · unknown on the VM (last reported)',
    );
    expect(details).toHaveTextContent('Filesunknown files, unknown');
    expect(details).toHaveTextContent('Last receivedunknown');
  });

  it.each<[string, Partial<FileSyncTabData>, string, boolean]>([
    ['empty', { status: { ...status(), links: [] } }, 'No project is connected to a VM.', true],
    ['loading', { status: null, loading: true }, 'Loading the file sync status…', false],
    [
      'failed',
      { status: null, error: 'Network down' },
      'Could not load the file sync status: Network down',
      true,
    ],
  ])('shows the header and the %s state', (_case, data, text, canRefresh) => {
    renderTab(data);
    expect(screen.getByRole('heading', { name: 'File sync' })).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Refresh status' });
    if (canRefresh) expect(button).toBeEnabled();
    else expect(button).toBeDisabled();
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows Refresh status as busy only during a manual refresh', async () => {
    let finish = () => {};
    const { refresh, rerender } = renderTab();
    refresh.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    const button = () => screen.getByRole('button', { name: 'Refresh status' });

    rerender({ loading: true });
    expect(button()).not.toHaveAttribute('aria-busy');
    rerender({ status: status(scope({ verdict: 'syncing' })) });
    expect(button()).not.toHaveAttribute('aria-busy');

    await userEvent.click(button());
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(button()).toHaveAttribute('aria-busy', 'true');
    expect(button()).toBeDisabled();
    await act(async () => finish());
    expect(button()).not.toHaveAttribute('aria-busy');
    expect(button()).toBeEnabled();
  });

  it.each<[string, Partial<FileSyncStatusResponse>, string[]]>([
    ['connected', {}, ['lab-vmConnected']],
    [
      'not connected',
      { links: [{ ...status().links[0], connected: false }] },
      ['lab-vmNot connected'],
    ],
    [
      'of unknown connection',
      { links: [{ ...status().links[0], connected: null }] },
      ['lab-vmConnection unknown'],
    ],
    [
      'next to a PC that does not run Syncthing',
      {
        syncthing: { running: false, version: null, error: 'Syncthing exited with code 1.' },
        links: [],
      },
      ['This PCNot running', 'Syncthing exited with code 1.'],
    ],
  ])('shows the state of a VM %s in the connection strip', (_case, overrides, texts) => {
    renderTab({ status: { ...status(), ...overrides } });
    const strip = screen.getByRole('region', { name: 'Connections' });
    for (const text of texts) expect(strip).toHaveTextContent(text);
  });

  it('shows the Syncthing version and the VM link facts in the connection details', async () => {
    renderTab();
    const strip = screen.getByRole('region', { name: 'Connections' });
    const facts = 'Syncthing v2.1.5 runs on this PC';
    expect(within(strip).queryByText(facts)).not.toBeInTheDocument();
    await userEvent.click(within(strip).getByRole('button', { name: 'Connection details' }));
    expect(within(strip).getByText(facts)).toBeInTheDocument();
    expect(
      within(strip).getByText(`Connected since ${new Date(AT).toLocaleString()}`),
    ).toBeInTheDocument();
    expect(within(strip).getByText('10.0.0.5:22000')).toBeInTheDocument();
    expect(
      within(strip).getByText('Sent 1.0 KB · Received 2.0 KB in this connection'),
    ).toBeInTheDocument();
  });

  it.each<[string, FileSyncStatusScope[], string, string]>([
    [
      'one project',
      [scope({ verdict: 'problem', reason: 'Disk full.' }), scope({ projectId: 'p2' })],
      '1 project needs attention',
      'Project One · Disk full.',
    ],
    [
      'four projects',
      ['p1', 'p2', 'p3', 'p6'].map((projectId) => scope({ projectId, verdict: 'disconnected' })),
      '4 projects need attention',
      'alpha, Delta, Project One and 1 more',
    ],
  ])('names %s that need attention in the banner', (_case, scopes, title, detail) => {
    renderTab({ status: status(...scopes) });
    const banner = screen.getByRole('region', { name: title });
    expect(banner).toHaveTextContent(detail);
  });

  it('shows the first issue from the banner and moves the focus to it', async () => {
    renderTab({
      status: status(
        scope({ projectId: 'p7' }),
        scope({ projectId: 'p2', verdict: 'problem' }),
        scope({ projectId: 'p4', verdict: 'unknown' }),
      ),
    });
    await userEvent.click(screen.getByRole('button', { name: /^In sync/ }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search projects' }), 'Eps');

    await userEvent.click(screen.getByRole('button', { name: 'View issues' }));
    expect(screen.getByRole('button', { name: /^Needs attention/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('searchbox', { name: 'Search projects' })).toHaveValue('');
    expect(rowNames()).toEqual(['Beta', 'Project Two']);
    expect(toggle('Beta')).toHaveAttribute('aria-expanded', 'true');
    expect(toggle('Beta')).toHaveFocus();
  });
});

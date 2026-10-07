// Components are the cheapest layer that joins owner/Git facts, user choices, ignore saves and refreshed failures.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { apiFetch } from '@/ui/lib/api-transport';
import type {
  ProjectFileSyncFailures,
  ProjectPatternPreview,
} from '@/modules/remotes/sync/remote-file-sync.dto';
import { FixFileSyncDialog } from './FixFileSyncDialog';
import { exclusion, failedFile, fileSyncFailures } from './testing/file-sync-failures.fixture';

jest.mock('@/ui/lib/api-transport', () => ({ HOME_BACKEND: 'home', apiFetch: jest.fn() }));
const transport = jest.mocked(apiFetch);
const response = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as Response;
let failures: ProjectFileSyncFailures;
let ignores: string[];
let revision: number;
let saves: string[][];
let reads: number;
let saveError: string | null;
let saveMessage: string;
let afterSave: ProjectFileSyncFailures | null;
function renderDialog() {
  const onClose = jest.fn();
  const onEditSettings = jest.fn();
  const onForceSync = jest.fn();
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <FixFileSyncDialog
        projectId="p1"
        projectName="Project One"
        onClose={onClose}
        onEditSettings={onEditSettings}
        onForceSync={onForceSync}
      />
    </QueryClientProvider>,
  );
  return { onClose, onEditSettings, onForceSync };
}
beforeEach(() => {
  failures = fileSyncFailures();
  ignores = ['/existing'];
  revision = 0;
  saves = [];
  reads = 0;
  saveError = null;
  saveMessage = 'Applied to the VM and this PC.';
  afterSave = null;
  transport.mockReset().mockImplementation(async (url, init) => {
    if (String(url).endsWith('/failed')) {
      reads++;
      return response(failures);
    }
    if (String(url).endsWith('/auto-fix')) return response({ enabled: true, actions: [] });
    if (init?.method === 'PUT') {
      const list = JSON.parse(String(init.body)).ignores as string[];
      saves.push(list);
      if (saveError) return response({ message: saveError }, 400);
      ignores = list;
      revision++;
      if (afterSave) failures = afterSave;
      return response({
        ignores,
        revision,
        applied: saveMessage.startsWith('Applied'),
        message: saveMessage,
      });
    }
    if (String(url).endsWith('/pattern-preview'))
      return response({
        home: {
          state: 'checked',
          tracked: { count: 0, sample: [] },
          kept: { count: 0, sample: [] },
        },
        vm: { state: 'checked', tracked: { count: 0, sample: [] }, kept: { count: 0, sample: [] } },
      });
    return response({ ignores, revision });
  });
});

it('gives only eligible VM groups individually or together, explains the code decision, and refreshes failures', async () => {
  const base = exclusion();
  const eligible = (path: string) =>
    exclusion({
      path,
      pattern: `(?d)/${path}`,
      patterns: [`(?d)/${path}`],
      vm: { ...base.vm!, path, ignored: false, tracked: false, trackedDescendants: [] },
    });
  failures = fileSyncFailures({
    vmUser: { uid: 1001, name: 'alice' },
    groups: [
      eligible('migration.ts'),
      eligible('new-package'),
      exclusion({ path: 'ignored' }),
      exclusion({ path: 'tracked', vm: { ...base.vm!, tracked: true, ignored: false } }),
      exclusion({
        path: 'owned',
        vm: { ...base.vm!, foreignOwner: false, foreignOwners: [], ignored: false },
      }),
      exclusion({ path: 'unchecked', gitUnchecked: true, vm: { ...base.vm!, ignored: false } }),
      exclusion({ path: 'home', side: 'home', vm: null }),
      { ...eligible('shared.ts'), side: 'home' },
    ],
  });
  const gives: string[][] = [];
  const fallback = transport.getMockImplementation()!;
  transport.mockImplementation(async (url, init, context) => {
    if (String(url).endsWith('/give-ownership')) {
      const { paths } = JSON.parse(String(init?.body)) as { paths: string[] };
      gives.push(paths);
      return response({
        user: failures.vmUser,
        items: paths.map((path) => ({ path, state: 'repaired', paths: [path] })),
      });
    }
    return fallback(url, init, context);
  });
  renderDialog();
  const buttons = await screen.findAllByRole('button', { name: 'Give to alice' });
  expect(buttons).toHaveLength(3);
  expect(
    within(screen.getByRole('region', { name: 'This PC' })).queryByRole('button', {
      name: 'Give to alice',
    }),
  ).not.toBeInTheDocument();
  expect(
    screen.getAllByText(/Use it for files that belong to your code, for example a new migration/),
  ).toHaveLength(3);
  await userEvent.click(buttons[0]);
  await waitFor(() => expect(reads).toBe(2));
  expect(gives[0]).toEqual(['migration.ts']);
  await userEvent.click(screen.getByRole('button', { name: 'Give all to alice' }));
  await waitFor(() => expect(reads).toBe(3));
  expect(gives[1]).toEqual(['migration.ts', 'new-package', 'shared.ts']);
});

it('shows the host refusal reason and keeps VM copy commands available', async () => {
  const base = exclusion();
  failures = fileSyncFailures({
    vmUser: { uid: 1001, name: 'alice' },
    groups: [
      exclusion({
        path: 'migration.ts',
        vm: { ...base.vm!, ignored: false },
        chown: { vm: 'sudo chown alice migration.ts' },
      }),
    ],
  });
  const fallback = transport.getMockImplementation()!;
  transport.mockImplementation(async (url, init, context) =>
    String(url).endsWith('/give-ownership')
      ? response({
          user: null,
          items: [
            {
              path: 'migration.ts',
              state: 'unsupported',
              paths: [],
              reason: 'Update the VM or use the copy command.',
            },
          ],
        })
      : fallback(url, init, context),
  );
  renderDialog();
  await userEvent.click(await screen.findByRole('button', { name: 'Give to alice' }));
  await screen.findByText('Update the VM or use the copy command.');
  expect(
    screen.getByRole('button', { name: 'Copy command on The VM: sudo chown alice migration.ts' }),
  ).toBeEnabled();
});

it.each(['Applied to the VM and this PC.', 'Saved, not applied yet: the VM is offline.'])(
  'saves default exclusions in order, shows "%s" and reloads remaining failures',
  async (message) => {
    saveMessage = message;
    afterSave = fileSyncFailures({ vm: { entries: [] }, groups: [] });
    const { onClose } = renderDialog();
    const checkbox = await screen.findByRole('checkbox', { name: 'Exclude logs on The VM' });
    expect(checkbox).toBeChecked();
    expect(screen.getByRole('region', { name: 'This PC' })).toHaveTextContent(
      'uid 48 · cannot read · No Git repository',
    );
    expect(screen.getByRole('region', { name: 'The VM' })).toHaveTextContent(
      'root · cannot change · Git ignores it',
    );
    expect(screen.getByRole('region', { name: 'Why this happens' })).toHaveTextContent(
      'uid 48, root',
    );
    expect(transport).toHaveBeenCalledWith(
      '/api/projects/p1/file-sync/failed',
      expect.objectContaining({ signal: expect.anything() }),
      { backend: 'home' },
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(message);
    await waitFor(() => expect(reads).toBe(2));
    expect(saves).toEqual([['/existing', '!/logs/keep.txt', '(?d)/logs']]);
    expect(screen.queryByText('logs/error.txt')).not.toBeInTheDocument();
    expect(screen.getByText('cache/temp')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  },
);

it('shows automatic additions as removable saved patterns and persists the switch', async () => {
  failures = fileSyncFailures({ groups: [], home: { entries: [] }, vm: { entries: [] } });
  ignores = ['(?d)/automatic'];
  let enabled = true;
  const original = transport.getMockImplementation()!;
  transport.mockImplementation(async (url, init, options) => {
    if (!String(url).endsWith('/auto-fix')) return original(url, init, options);
    if (init?.method === 'PUT') enabled = JSON.parse(String(init.body)).enabled as boolean;
    return response({
      enabled,
      actions: [
        {
          at: '2026-10-05T12:00:00.000Z',
          kind: 'exclude',
          side: 'vm',
          patterns: ['(?d)/automatic'],
        },
      ],
    });
  });
  renderDialog();
  const checkbox = await screen.findByRole('checkbox', {
    name: 'Fix file sync problems automatically',
  });
  await waitFor(() => expect(checkbox).toBeEnabled());
  expect(checkbox).toBeChecked();
  expect(screen.getByText(/Added automatically on .*: \(\?d\)\/automatic/)).toBeInTheDocument();
  await userEvent.click(checkbox);
  await waitFor(() => expect(checkbox).not.toBeChecked());
  expect(enabled).toBe(false);
  await userEvent.click(screen.getByRole('button', { name: 'Remove (?d)/automatic' }));
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(saves).toEqual([[]]));
});

it('refetches a cached list on mount and reloads an open stale draft after a 409', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['home', 'file-sync-ignores', 'p1'], { ignores: ['/cached'], revision: 0 });
  ignores = ['/existing'];
  revision = 1;
  const requests: Array<{ ignores: string[]; revision: number }> = [];
  const original = transport.getMockImplementation()!;
  transport.mockImplementation(async (url, init, options) => {
    if (String(url).endsWith('/ignores') && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { ignores: string[]; revision: number };
      requests.push(body);
      if (body.revision !== revision)
        return response(
          { message: 'The file list changed. Review it again.', code: 'FILE_SYNC_IGNORES_CHANGED' },
          409,
        );
    }
    return original(url, init, options);
  });
  render(
    <QueryClientProvider client={client}>
      <FixFileSyncDialog
        projectId="p1"
        projectName="Project One"
        onClose={jest.fn()}
        onEditSettings={jest.fn()}
        onForceSync={jest.fn()}
      />
    </QueryClientProvider>,
  );
  await screen.findByRole('button', { name: 'Remove /existing' });
  expect(screen.queryByRole('button', { name: 'Remove /cached' })).not.toBeInTheDocument();
  await userEvent.type(screen.getByLabelText('Add your own pattern'), '/manual');
  await userEvent.click(screen.getByRole('button', { name: 'Add' }));
  ignores = ['/existing', '/automatic'];
  revision = 2;
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'The file list changed. Review it again.',
  );
  await screen.findByRole('button', { name: 'Remove /automatic' });
  expect(requests[0].revision).toBe(1);
  expect(ignores).toEqual(['/existing', '/automatic']);
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[1]).toMatchObject({ revision: 2 });
  expect(requests[1].ignores).toEqual(expect.arrayContaining(['/automatic', '/manual']));
});

it('unticks a default group and opts into an unticked one without saving the removed group', async () => {
  failures.groups.push(
    exclusion({
      side: 'home',
      path: 'cache',
      pattern: '(?d)/cache',
      patterns: ['(?d)/cache'],
      selected: false,
    }),
  );
  renderDialog();
  await userEvent.click(await screen.findByRole('checkbox', { name: 'Exclude logs on The VM' }));
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  const optional = screen.getByRole('checkbox', { name: 'Exclude cache on This PC' });
  expect(optional).not.toBeChecked();
  await userEvent.click(optional);
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(saves).toEqual([['/existing', '(?d)/cache']]));
});

it('names the blocking pattern and opens settings instead of offering an exclusion', async () => {
  failures.groups = [exclusion({ blockedBy: '!/logs', patterns: [] })];
  const { onEditSettings } = renderDialog();
  await userEvent.click(await screen.findByRole('button', { name: 'Edit file sync settings' }));
  expect(screen.getByText(/which keeps these files in sync/)).toHaveTextContent('!/logs');
  expect(screen.queryByRole('checkbox', { name: /^Exclude / })).not.toBeInTheDocument();
  expect(onEditSettings).toHaveBeenCalledTimes(1);
  expect(saves).toEqual([]);
});

it('copies tracked-file repairs on the correct side without offering exclusions', async () => {
  failures.vm.entries = [
    failedFile({ git: { ...failedFile().git!, tracked: true, ignored: false } }),
  ];
  failures.groups = [
    exclusion({ patterns: [], chown: { vm: "sudo chown -R alice '/project/logs/error.txt'" } }),
  ];
  const user = userEvent.setup();
  const copy = jest.spyOn(navigator.clipboard, 'writeText');
  renderDialog();
  const side = await screen.findByRole('region', { name: 'The VM' });
  await user.click(await within(side).findByRole('button', { name: /Copy command/ }));
  expect(copy).toHaveBeenCalledWith("sudo chown -R alice '/project/logs/error.txt'");
  expect(side).toHaveTextContent('Tracked by Git');
  expect(screen.queryByRole('checkbox', { name: /^Exclude / })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
});

it.each(['server', 'merged'] as const)(
  'uses the final list instead of the %s suggestion count to enable Save',
  async (mode) => {
    if (mode === 'server') failures.overLimit = true;
    else ignores = Array.from({ length: 199 }, (_, index) => `pattern-${index}`);
    renderDialog();
    await screen.findByRole('checkbox', { name: 'Exclude logs on The VM' });
    if (mode === 'server') {
      expect(
        screen.getByText('These suggestions would pass the limit of 200 patterns.'),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    } else {
      expect(screen.getByText(/The final list must have at most/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    }
    expect(saves).toEqual([]);
  },
);

it('shows unreadable Git and side errors, preserves the raw error reason, and remains closable', async () => {
  failures = fileSyncFailures({
    home: { entries: [failedFile({ owner: null, error: 'disk full', git: null })] },
    vm: { entries: [], readError: "DevChain could not read the VM's errors." },
    groups: [exclusion({ gitUnchecked: true, patterns: [] })],
  });
  const { onClose } = renderDialog();
  await screen.findByText("DevChain could not read the VM's errors.");
  expect(screen.getByRole('region', { name: 'This PC' })).toHaveTextContent(
    'disk full · Git could not be checked',
  );
  expect(screen.queryByRole('checkbox', { name: /^Exclude / })).not.toBeInTheDocument();
  await userEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('keeps selections after a failed save and does not reload the failed list', async () => {
  saveError = 'Could not save exclusions.';
  renderDialog();
  await screen.findByRole('checkbox', { name: 'Exclude logs on The VM' });
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText(saveError);
  expect(screen.getByRole('checkbox', { name: 'Exclude logs on The VM' })).toBeChecked();
  expect(reads).toBe(1);
  expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
});

it.each(['failed', 'ignores'])(
  'refuses Save when the %s read fails and still allows Close',
  async (route) => {
    const pass = transport.getMockImplementation()!;
    transport.mockImplementation(async (url, init, options) =>
      String(url).endsWith(`/${route}`)
        ? response({ message: 'Read unavailable.' }, 503)
        : pass(url, init, options),
    );
    const { onClose } = renderDialog();
    await screen.findByText('Read unavailable.');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await userEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(saves).toEqual([]);
  },
);

it.each([true, false])('opens Force sync only when the server offers it (%s)', async (offered) => {
  failures.forceSync = {
    offered,
    reason: offered ? null : 'Permission denied',
    pending: { fromVm: 2, fromHome: 3 },
  };
  const { onForceSync } = renderDialog();
  await screen.findByRole('checkbox', { name: 'Exclude logs on The VM' });
  const button = screen.queryByRole('button', { name: 'Force sync…' });
  if (offered) {
    await userEvent.click(button!);
    expect(onForceSync).toHaveBeenCalledWith(failures.forceSync);
  } else {
    expect(button).not.toBeInTheDocument();
    expect(onForceSync).not.toHaveBeenCalled();
  }
});

// The dialog is the cheapest layer for draft order, typed feedback and cancellable preview requests.
describe('own pattern drafts', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  const typePattern = (value: string) =>
    fireEvent.change(screen.getByLabelText('Add your own pattern'), { target: { value } });
  const open = async () => {
    const rendered = renderDialog();
    await screen.findByRole('checkbox', { name: 'Exclude logs on The VM' });
    return rendered;
  };
  const debounce = async () => {
    await act(async () => {
      jest.advanceTimersByTime(400);
    });
  };

  it('updates the row decision while typing and removes it when the input clears', async () => {
    failures.groups = [exclusion({ selected: false })];
    await open();
    typePattern('*.txt');
    const row = screen.getByText('logs/error.txt').closest('li')!;
    expect(row).toHaveTextContent('excluded by *.txt');
    typePattern('');
    expect(row).not.toHaveTextContent('excluded by');
    expect(
      transport.mock.calls.filter(([url]) => String(url).endsWith('/pattern-preview')),
    ).toHaveLength(0);
  });

  it('puts an own keep rule before a selected group when highlighting and saving', async () => {
    await open();
    typePattern('!/logs/error.txt');
    const row = screen.getByText('logs/error.txt').closest('li')!;
    expect(row).toHaveTextContent('kept by !/logs/error.txt');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(
      within(screen.getByRole('list', { name: 'Own patterns' })).getByText('!/logs/error.txt'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(saves).toEqual([['/existing', '!/logs/error.txt', '!/logs/keep.txt', '(?d)/logs']]),
    );
  });

  it.each([
    [['#include other'], 'unknown'],
    [['!/logs/error.txt'], 'kept by !/logs/error.txt'],
    [['/logs'], 'excluded by /logs'],
  ])('honors the installed prefix %s before the typed draft', async (prefix, decision) => {
    failures.installedPrefix = prefix;
    await open();
    typePattern('!/logs');
    expect(screen.getByText('logs/error.txt').closest('li')).toHaveTextContent(decision);
  });

  it('honors the current saved list before an own keep rule', async () => {
    ignores = ['/logs'];
    await open();
    typePattern('!/logs/error.txt');
    expect(screen.getByText('logs/error.txt').closest('li')).toHaveTextContent('excluded by /logs');
  });

  it('validates syntax as typed without requesting a preview or changing the draft', async () => {
    await open();
    typePattern('broken[');
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid ignore pattern:');
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    await debounce();
    expect(
      transport.mock.calls.filter(([url]) => String(url).endsWith('/pattern-preview')),
    ).toHaveLength(0);
    typePattern('*.txt');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled();
  });

  it('warns about tracked and Git-kept matches without blocking Add and shows a VM error as unknown', async () => {
    const pass = transport.getMockImplementation()!;
    transport.mockImplementation(async (url, init, options) =>
      String(url).endsWith('/pattern-preview')
        ? response({
            home: {
              state: 'checked',
              tracked: { count: 51, sample: ['logs/tracked.txt'] },
              kept: { count: 1, sample: ['logs/kept.txt'] },
            },
            vm: { state: 'error', tracked: null, kept: null },
          } satisfies ProjectPatternPreview)
        : pass(url, init, options),
    );
    await open();
    typePattern('*.txt');
    await act(async () => {
      jest.advanceTimersByTime(399);
    });
    expect(
      transport.mock.calls.filter(([url]) => String(url).endsWith('/pattern-preview')),
    ).toHaveLength(0);
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(screen.getByLabelText('Pattern preview')).toHaveTextContent('51 tracked files');
    expect(screen.getByLabelText('Pattern preview')).toHaveTextContent('1 Git-kept file');
    expect(screen.getByLabelText('Pattern preview')).toHaveTextContent('logs/tracked.txt');
    expect(screen.getByLabelText('Pattern preview')).toHaveTextContent('logs/kept.txt');
    expect(screen.getByLabelText('Pattern preview')).toHaveTextContent(
      'The VM: Git could not be checked. Pattern matches are unknown.',
    );
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled();
    expect(transport).toHaveBeenCalledWith(
      '/api/projects/p1/file-sync/pattern-preview',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ pattern: '*.txt' }),
        signal: expect.anything(),
      }),
      { backend: 'home' },
    );
  });

  it('discards out-of-order preview answers and aborts requests on a new pattern and on clearing', async () => {
    const pending: Array<{ resolve: (value: Response) => void; signal: AbortSignal }> = [];
    const pass = transport.getMockImplementation()!;
    transport.mockImplementation((url, init, options) =>
      String(url).endsWith('/pattern-preview')
        ? new Promise<Response>((resolve) =>
            pending.push({ resolve, signal: init!.signal as AbortSignal }),
          )
        : pass(url, init, options),
    );
    const answer = (path: string): ProjectPatternPreview => ({
      home: {
        state: 'checked',
        tracked: { count: 1, sample: [path] },
        kept: { count: 0, sample: [] },
      },
      vm: { state: 'unavailable', tracked: null, kept: null },
    });
    await open();
    typePattern('*.txt');
    await debounce();
    typePattern('*.log');
    expect(pending[0].signal.aborted).toBe(true);
    await debounce();
    await act(async () => {
      pending[1].resolve(response(answer('new.log')));
    });
    expect(screen.getByLabelText('Pattern preview')).toHaveTextContent('new.log');
    await act(async () => {
      pending[0].resolve(response(answer('old.txt')));
    });
    expect(screen.getByLabelText('Pattern preview')).not.toHaveTextContent('old.txt');
    expect(screen.getByLabelText('Pattern preview')).toHaveTextContent(
      'The VM: unavailable. Pattern matches are unknown.',
    );
    typePattern('*.cache');
    await debounce();
    typePattern('');
    expect(pending[2].signal.aborted).toBe(true);
    await act(async () => {
      pending[2].resolve(response(answer('late.cache')));
    });
    expect(screen.queryByLabelText('Pattern preview')).not.toBeInTheDocument();
  });

  it('saves only an own pattern and lets the user remove it before saving', async () => {
    failures.groups = [exclusion({ selected: false })];
    await open();
    typePattern('*.txt');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove *.txt' }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    typePattern('*.log');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saves).toEqual([['/existing', '*.log']]));
  });

  it('enables Save for 199 saved entries, two unticked groups and one own pattern despite overLimit', async () => {
    ignores = Array.from({ length: 199 }, (_, i) => `saved-${i}`);
    failures.overLimit = true;
    failures.groups = [
      exclusion({ selected: false }),
      exclusion({ path: 'cache', side: 'home', patterns: ['(?d)/cache'], selected: false }),
    ];
    await open();
    typePattern('*.log');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(saves).toEqual([[...Array.from({ length: 199 }, (_, i) => `saved-${i}`), '*.log']]),
    );
  });

  it('shows the coverage count of a selected merged pattern group', async () => {
    failures.groups = [
      exclusion({
        path: 'plugins/a.egg-info',
        pathCount: 2,
        pathSample: ['plugins/a.egg-info', 'plugins/b.egg-info'],
        pattern: '(?d)*.egg-info',
        patterns: ['(?d)*.egg-info'],
        fileCount: 9,
      }),
      exclusion({
        path: 'tools/repo',
        pathCount: 1,
        pathSample: ['tools/repo'],
        pattern: '(?d)/tools/repo',
        patterns: ['(?d)/tools/repo'],
        fileCount: 1,
      }),
    ];
    renderDialog();
    expect(
      await screen.findByRole('checkbox', { name: 'Exclude plugins/a.egg-info on The VM' }),
    ).toBeChecked();
    expect(screen.getByText('(?d)*.egg-info')).toBeInTheDocument();
    expect(screen.getByText('covers 2 paths · 9 files')).toBeInTheDocument();
    expect(screen.getByText('covers 1 path · 1 file')).toBeInTheDocument();
  });
});

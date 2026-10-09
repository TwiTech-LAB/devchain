import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RemoteOperationDto } from './lib/remote-vm-contracts';
import {
  OperationDetail,
  OperationStateChip,
  type ActivityActions,
  type ActivityNames,
} from './OperationDetail';

jest.mock('@/ui/lib/api-transport', () => ({
  HOME_BACKEND: 'home',
  apiFetch: jest.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
}));

type Step = RemoteOperationDto['steps'][number];

const NAMES: ActivityNames = {
  remotes: new Map([['r1', 'lab-vm']]),
  projects: new Map([['p1', 'Project One']]),
};

function step(
  id: string,
  state: Step['state'],
  label = `Label ${id}`,
  error?: Step['error'],
): Step {
  return { id, label, state, error: error ?? null };
}

function operation(overrides: Partial<RemoteOperationDto> = {}): RemoteOperationDto {
  return {
    id: 'op1',
    kind: 'attach',
    remoteId: 'r1',
    projectId: 'p1',
    state: 'running',
    steps: [step('a', 'done'), step('b', 'running'), step('c', 'pending')],
    details: {},
    createdAt: '2026-09-28T10:00:00.000Z',
    updatedAt: '2026-09-28T10:05:00.000Z',
    ...overrides,
  };
}

function actions(overrides: Partial<ActivityActions> = {}): ActivityActions {
  return {
    retry: jest.fn(),
    cancel: jest.fn(),
    reauth: jest.fn(),
    openLogin: jest.fn(),
    disconnectInstead: jest.fn(),
    forceDisconnect: jest.fn(),
    ...overrides,
  };
}

/** The action handlers, and `setPending` to rerender with the row's shared pending flag. */
function renderDetail(
  target: RemoteOperationDto,
  options: { actions?: ActivityActions; error?: string | null } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const handlers = options.actions ?? actions();
  const tree = (pending: boolean) => (
    <QueryClientProvider client={client}>
      <OperationDetail
        operation={target}
        names={NAMES}
        pending={pending}
        error={options.error ?? null}
        actions={handlers}
      />
    </QueryClientProvider>
  );
  const view = render(tree(false));
  return { ...handlers, setPending: (pending: boolean) => view.rerender(tree(pending)) };
}

function stepState(label: string): string | null {
  return screen.getByText(label).closest('li')!.getAttribute('data-state');
}

// Component rendering is the cheapest layer that proves which details, notes
// and actions an operation shows; the page spec covers the requests they send.
describe('OperationDetail progress', () => {
  it('shows the state, the step count and a progress bar', () => {
    renderDetail(operation());
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('Step 2 of 3')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Progress' })).toHaveAttribute(
      'aria-valuenow',
      '1',
    );
    expect(screen.getByText(/^Started /)).toBeInTheDocument();
    expect(screen.queryByText(/^Ended /)).not.toBeInTheDocument();
  });

  it('spins the state chip only while the operation runs', () => {
    render(<OperationStateChip state="running" />);
    expect(screen.getByText('Running').querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    render(<OperationStateChip state="done" />);
    expect(screen.getByText('Done').querySelector('svg')).toBeNull();
  });

  it('folds finished steps and lists the current step before the pending ones', async () => {
    renderDetail(
      operation({
        steps: [
          step('a', 'done', 'Check'),
          step('b', 'skipped', 'Docker'),
          step('c', 'done', 'Copy'),
          step('d', 'running', 'Send'),
          step('e', 'pending', 'Unlock'),
        ],
      }),
    );
    expect(screen.queryByText('Check')).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: '2 steps done' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(
      within(screen.getByRole('list', { name: 'Current step' })).getByText('Send'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('list', { name: 'Pending steps' })).getByText('Unlock'),
    ).toBeInTheDocument();

    await userEvent.click(toggle);
    const finished = screen.getByRole('list', { name: 'Finished steps' });
    expect(within(finished).getByText('Check')).toBeInTheDocument();
    expect(stepState('Docker')).toBe('skipped');
  });

  it('calls out the failed step with its error and shows the end time', () => {
    renderDetail(
      operation({
        state: 'failed',
        steps: [
          step('a', 'done'),
          step('b', 'failed', 'Copy project', { message: 'Disk full', code: 'DISK_FULL' }),
        ],
      }),
    );
    const callout = screen.getByRole('alert');
    expect(callout).toHaveTextContent('Stopped at “Copy project”');
    expect(callout).toHaveTextContent('Disk full');
    expect(screen.getByText('Stopped')).toBeInTheDocument();
    expect(screen.getByText(/^Ended /)).toBeInTheDocument();
  });

  it('shows the project name in reset steps that carry a project id', () => {
    renderDetail(
      operation({
        kind: 'reset_vm',
        projectId: null,
        steps: [
          step('detach:p1:preflight', 'running', 'Disconnect p1: Check connection'),
          step('attach:p1:preflight', 'pending', 'Reconnect p1: Check connection'),
        ],
      }),
    );
    expect(stepState('Disconnect Project One: Check connection')).toBe('running');
    expect(stepState('Reconnect Project One: Check connection')).toBe('pending');
  });

  it('shows the refusal of the last Retry or Cancel', () => {
    renderDetail(operation({ state: 'failed' }), { error: 'The VM copy is being removed.' });
    expect(screen.getByText('The VM copy is being removed.')).toHaveAttribute('role', 'alert');
  });
});

describe('OperationDetail file merge notes', () => {
  it('explains why an over-cap report cannot separate new conflicts and shows the total', () => {
    renderDetail(
      operation({
        kind: 'attach',
        state: 'done',
        details: {
          fileSyncConflicts: {
            total: 1040,
            sample: ['file.sync-conflict-old.txt'],
            baselineOverCap: true,
          },
        },
      }),
    );
    expect(screen.getByRole('note', { name: 'File conflicts' })).toHaveTextContent(
      '1040 conflicts',
    );
    expect(screen.getByText(/DevChain could not separate the new conflicts/)).toHaveTextContent(
      'more than 1,000 conflict copies before this Connect',
    );
  });
  it.each(['done', 'cancelled'] as const)(
    'keeps VM edit/deletion and conflict totals and samples for %s Connect',
    (state) => {
      renderDetail(
        operation({
          kind: 'attach',
          state,
          details: {
            vmEdits: {
              conflictPaths: [],
              conflictsOverCap: false,
              total: 40,
              deleted: 3,
              sample: [
                { path: 'src/edit.ts', deleted: false },
                { path: 'gone.txt', deleted: true },
              ],
            },
            fileSyncConflicts: { total: 24, sample: ['src/edit.sync-conflict-date.ts'] },
          },
        }),
      );
      expect(screen.getByRole('note', { name: 'VM files' })).toHaveTextContent(
        'Brought 40 files from the VM',
      );
      expect(screen.getByRole('note', { name: 'VM files' })).toHaveTextContent('3 deletions.');
      expect(screen.getByText('gone.txt (deleted)')).toBeInTheDocument();
      expect(screen.getByText('src/edit.ts')).toBeInTheDocument();
      expect(screen.getByRole('note', { name: 'File conflicts' })).toHaveTextContent(
        '24 conflicts kept as .sync-conflict copies',
      );
      expect(screen.getByText('src/edit.sync-conflict-date.ts')).toBeInTheDocument();
    },
  );

  it.each([
    {},
    {
      vmEdits: { total: -1, deleted: 0, sample: [] },
      fileSyncConflicts: { total: 1, sample: [42] },
    },
  ])('omits absent or invalid reports (%p)', (details) => {
    renderDetail(operation({ kind: 'attach', state: 'done', details }));
    expect(screen.queryByRole('note', { name: 'VM files' })).not.toBeInTheDocument();
    expect(screen.queryByRole('note', { name: 'File conflicts' })).not.toBeInTheDocument();
  });
});

describe('OperationDetail git guard notes', () => {
  // Component tests prove which persisted details Activity exposes for each lifecycle outcome.
  it.each([
    ['attach', 'done', 'guardWarning', 'Home git guard'],
    ['detach', 'done', 'vmGuardWarning', 'VM git guard'],
    ['attach', 'cancelled', 'vmGuardWarning', 'VM git guard'],
    ['detach', 'done', 'vmGuardSkipped', 'VM guard skipped'],
  ] as const)('shows %s/%s guard detail %s as a note', (kind, state, key, label) => {
    renderDetail(operation({ kind, state, details: { [key]: 'guard result from the operation' } }));
    expect(screen.getByRole('note', { name: label })).toHaveTextContent(
      'guard result from the operation',
    );
  });

  it.each([{}, { guardWarning: null, vmGuardWarning: 1, vmGuardSkipped: '' }])(
    'omits guard notes without a reported warning or skip (%p)',
    (details) => {
      renderDetail(operation({ state: 'done', details }));
      for (const label of ['Home git guard', 'VM git guard', 'VM guard skipped']) {
        expect(screen.queryByRole('note', { name: label })).not.toBeInTheDocument();
      }
    },
  );
});

// Component layer proves a successful claim warning is visible in Activity.
it('shows the reported Docker uid warning for a finished claim', () => {
  const warning =
    'uid 1000 is used by ubuntu on the VM; the VM user got 1001:1000. Automatic Docker moves are off for this VM.';
  renderDetail(
    operation({ kind: 'claim', state: 'done', steps: [], details: { dockerUserWarning: warning } }),
  );
  expect(screen.getByRole('note', { name: 'Docker user ids' })).toHaveTextContent(warning);
});

describe('OperationDetail check warnings', () => {
  const install = operation({
    id: 'install-1',
    kind: 'install_host',
    projectId: null,
    steps: [step('check', 'done', 'Check the VM'), step('install', 'running', 'Install the host')],
    details: { checkWarnings: ['The VM has 1 vCPU.', 'ufw is active.'] },
  });

  it('shows passing-check warnings as a note, not an error', () => {
    renderDetail(install);
    const note = screen.getByRole('note', { name: 'VM check warnings' });
    expect(within(note).getByText('The VM has 1 vCPU.')).toBeInTheDocument();
    expect(within(note).getByText('ufw is active.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([undefined, [null, 1]])('omits the note without valid warnings (%p)', (checkWarnings) => {
    renderDetail({ ...install, details: { checkWarnings } });
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });
});

describe('OperationDetail git settings copy', () => {
  it('says the PC has no readable global git config', () => {
    renderDetail(operation({ state: 'done', details: { gitConfig: 'not_set_on_pc' } }));
    const note = screen.getByRole('note', { name: 'Git settings' });
    expect(
      within(note).getByText(
        'This PC has no readable global git config; the VM keeps its own git settings.',
      ),
    ).toBeInTheDocument();
  });

  it.each<[string, { gitConfig: string; gitConfigError?: string }]>([
    ['a message ending in a period', { gitConfig: 'failed', gitConfigError: 'The VM refused.' }],
    [
      'a message without a final period',
      { gitConfig: 'failed', gitConfigError: 'connect ECONNREFUSED' },
    ],
    ['no message at all', { gitConfig: 'failed' }],
  ])('shows the failure and %s, each sentence on its own line', (_label, details) => {
    renderDetail(operation({ state: 'done', details }));
    const note = screen.getByRole('note', { name: 'Git settings' });
    expect(
      within(note).getByText(
        details.gitConfigError ? `The copy failed: ${details.gitConfigError}` : 'The copy failed.',
      ),
    ).toBeInTheDocument();
    expect(within(note).getByText('The VM keeps its own git settings.')).toBeInTheDocument();
  });

  it('shows nothing extra when the settings were sent', () => {
    renderDetail(operation({ state: 'done', details: { gitConfig: 'sent' } }));
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });
});

describe('OperationDetail sudo-password retry', () => {
  it('hides the plain Retry for SSH_SUDO_PASSWORD_REQUIRED and keeps Cancel', () => {
    renderDetail(
      operation({
        kind: 'install_host',
        projectId: null,
        state: 'failed',
        steps: [
          step('check', 'failed', 'Check the VM', {
            message:
              'sudo on the VM needs a password for vm-admin. Enter the sudo password and retry.',
            code: 'SSH_SUDO_PASSWORD_REQUIRED',
          }),
        ],
      }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('needs a password for vm-admin');
    const form = screen.getByRole('form', { name: 'SSH credentials retry' });
    expect(screen.getAllByRole('button', { name: 'Retry' })).toEqual([
      within(form).getByRole('button', { name: 'Retry' }),
    ]);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });
});

describe('OperationDetail notes', () => {
  it('shows transcript losses inside a forced Reset record with the project name', () => {
    renderDetail(
      operation({
        kind: 'reset_vm',
        projectId: null,
        state: 'done',
        steps: [],
        details: {
          force: true,
          forcedLoss: [{ projectId: 'p1', detach: { transcripts: 'remote-changes' } }],
        },
      }),
    );
    const note = screen.getByRole('note', { name: 'Forced reset loss note' });
    expect(note).toHaveTextContent(/Project One: Unsynced project changes/);
    expect(note).toHaveTextContent(
      /Claude and Codex transcripts changed on the VM may have been lost/,
    );
  });

  it('says where logins came from in a forced destruction', () => {
    renderDetail(
      operation({
        kind: 'destroy_vm',
        projectId: null,
        state: 'done',
        steps: [],
        details: {
          force: true,
          familyPull: { pulled: false, families: [{ provider: 'codex', lastWritebackAt: null }] },
        },
      }),
    );
    const note = screen.getByRole('note', { name: 'Forced destruction loss note' });
    expect(note).toHaveTextContent(
      'The VM could not return its logins; the destruction used the last saved copies.',
    );
    expect(note).toHaveTextContent('Codex login last saved at an unknown time.');
  });

  it('shows copied files, bytes and files missing on this PC', () => {
    renderDetail(
      operation({
        steps: [step('transcripts_push', 'running', 'Copy session transcripts')],
        details: {
          transcripts: {
            filesDone: 2,
            filesTotal: 3,
            bytesDone: 1024,
            bytesTotal: 2048,
            missing: 4,
            skipped: 0,
          },
        },
      }),
    );
    expect(
      screen.getByText(/2\/3 files, 1.0 KB\/2.0 KB; 4 recorded files missing on this PC\.$/),
    ).toBeInTheDocument();
  });

  it('labels a Disconnect copy by the VM side and names skipped sessions', () => {
    renderDetail(
      operation({
        kind: 'detach',
        steps: [step('transcripts_pull', 'running', 'Copy session transcripts home')],
        details: {
          transcripts: {
            filesDone: 1,
            filesTotal: 1,
            bytesDone: 1024,
            bytesTotal: 1024,
            missing: 0,
            skipped: 2,
          },
        },
      }),
    );
    expect(
      screen.getByText(
        /0 recorded files missing on the VM; 2 sessions have a transcript path that cannot be copied\.$/,
      ),
    ).toBeInTheDocument();
  });

  it('shows per-folder progress under a running file-sync step only', () => {
    renderDetail(
      operation({
        steps: [
          step('file_sync_initial', 'running', 'Sync files to the VM'),
          step('file_sync_flip', 'pending'),
        ],
        details: {
          fileSync: {
            folders: {
              'code:p1': { completion: 40.6, needItems: 3, needBytes: 2048 },
              'git:p1': { completion: 12.5, needItems: 7, needBytes: 4096 },
              'tx:claude:p1': { completion: 100, needItems: 0, needBytes: 0 },
            },
          },
        },
      }),
    );
    const progress = screen.getByRole('list', { name: 'Sync files to the VM progress' });
    expect(
      within(progress)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Project files: 40% (3 items, 2.0 KB left)',
      'Git history: 12% (7 items, 4.0 KB left)',
      'Claude transcripts: 100% (0 items, 0 B left)',
    ]);
  });

  it('lists forced-disconnect losses on a done Disconnect', () => {
    renderDetail(
      operation({
        kind: 'detach',
        state: 'done',
        steps: [step('a', 'done')],
        details: {
          forcedLoss: {
            mirrorAgeMs: 120_000,
            fileSync: { folders: [{ id: 'code:p1', needItems: 5, needBytes: 1_572_864 }] },
            teamLanes: 'unfinalized',
            transcripts: 'remote-changes',
          },
        },
      }),
    );
    const note = screen.getByRole('note', { name: 'Forced disconnect losses' });
    expect(within(note).getByText('Mirror was 2 minutes old.')).toBeInTheDocument();
    expect(
      within(note).getByText('Claude and Codex transcripts changed on the VM.'),
    ).toBeInTheDocument();
    expect(
      within(note).getByText('Project files: files not yet received: 5 items, 1.5 MB'),
    ).toBeInTheDocument();
    expect(within(note).getByText('Agent time may include unfinalized work.')).toBeInTheDocument();
  });

  it('shows login test results', () => {
    renderDetail(
      operation({
        kind: 'claim',
        projectId: null,
        state: 'failed',
        details: {
          verified: {
            claude: { ok: true, summary: '', hint: null },
            codex: { ok: false, summary: 'not logged in', hint: 'Codex is not logged in.' },
          },
        },
      }),
    );
    expect(screen.getByTestId('verify-claude')).toHaveTextContent('Claude — verified');
    expect(screen.getByTestId('verify-codex')).toHaveTextContent(
      'Codex — failed: Codex is not logged in.',
    );
  });
});

describe('OperationDetail Docker progress and result', () => {
  function dockerOperation(state: 'running' | 'done', details: Record<string, unknown>) {
    return operation({
      state,
      steps: [
        step('docker_push', 'running', 'Copy Docker data'),
        step('docker_create_host', 'pending', 'Create containers on the VM'),
      ],
      details,
    });
  }

  it('shows bytes, rate and a live ETA while Docker data copies', () => {
    renderDetail(
      dockerOperation('running', {
        docker: {
          bytesDone: 2048,
          bytesTotal: 8192,
          rateBytesPerSecond: 1024,
          etaSeconds: 240,
          item: { name: 'web', phase: 'volume' },
        },
      }),
    );
    expect(
      screen.getByText(
        /Docker: 2\.0 KB of 8\.0 KB \(web, volume\) — 1\.0 KB\/s — about 4 min left/,
      ),
    ).toBeInTheDocument();
  });

  it('omits the rate and ETA while they are still null', () => {
    renderDetail(
      dockerOperation('running', {
        docker: { bytesDone: 10, bytesTotal: 8192, rateBytesPerSecond: null, etaSeconds: null },
      }),
    );
    expect(screen.getByText(/Docker: 10 B of 8\.0 KB/)).toBeInTheDocument();
    expect(screen.queryByText(/ left$/)).not.toBeInTheDocument();
  });

  it('marks replaced VM copies as not recoverable by Cancel while running', () => {
    renderDetail(
      dockerOperation('running', {
        docker: { bytesDone: 1, bytesTotal: 2, replaced: ['web', 'db'] },
      }),
    );
    const note = screen.getByRole('note', { name: 'Docker replacement loss note' });
    expect(
      within(note).getByText(
        'The VM copies being replaced (web, db) are deleted first; Cancel will not bring them back.',
      ),
    ).toBeInTheDocument();
  });

  it('marks items copied without data and data-only in the result', () => {
    renderDetail(
      dockerOperation('done', {
        docker: { result: { withoutData: ['store'], dataOnly: ['gpu'] } },
      }),
    );
    const note = screen.getByRole('note', { name: 'Docker copy result' });
    expect(within(note).getByText('store was copied without its data.')).toBeInTheDocument();
    expect(within(note).getByText('gpu: data only, no container was created.')).toBeInTheDocument();
  });

  it('shows no Docker result when every container was copied with its data', () => {
    renderDetail(
      dockerOperation('done', {
        docker: { result: { withoutData: [], dataOnly: [] } },
      }),
    );
    expect(screen.queryByRole('note', { name: 'Docker copy result' })).not.toBeInTheDocument();
  });

  it('shows the copy-home result and an incomplete copy home', () => {
    renderDetail(
      operation({
        kind: 'detach',
        state: 'done',
        details: { dockerCopyBackResult: { copied: ['db'], kept: ['cache'], skipped: ['logs'] } },
      }),
    );
    const note = screen.getByRole('note', { name: 'Docker copy home result' });
    expect(within(note).getByText('db: VM data copied home.')).toBeInTheDocument();
    expect(within(note).getByText('cache: home data kept.')).toBeInTheDocument();
    expect(within(note).getByText('logs: not copied.')).toBeInTheDocument();
  });

  it('warns when a cancelled copy home left home data incomplete', () => {
    renderDetail(
      operation({ kind: 'detach', state: 'cancelled', details: { dockerCopyBackPartial: ['db'] } }),
    );
    expect(screen.getByRole('note', { name: 'Docker copy home incomplete' })).toHaveTextContent(
      'The copy home of db did not finish.',
    );
  });

  it('shows the reason on a done detach whose VM engine was down', () => {
    renderDetail(
      operation({
        kind: 'detach',
        state: 'done',
        details: {
          dockerStopSkipped: "The VM's Docker engine was down; its containers keep running.",
        },
      }),
    );
    const note = screen.getByRole('note', { name: 'Docker stop skipped' });
    expect(
      within(note).getByText("The VM's Docker engine was down; its containers keep running."),
    ).toBeInTheDocument();
  });

  it('omits the stop note without a string reason', () => {
    renderDetail(operation({ kind: 'detach', state: 'done', details: { dockerStopSkipped: 42 } }));
    expect(screen.queryByRole('note', { name: 'Docker stop skipped' })).not.toBeInTheDocument();
  });
});

describe('OperationDetail actions', () => {
  it.each([
    ['install_host', true],
    ['create_vm', true],
    ['update_logins', true],
    ['attach', true],
    ['detach', false],
    ['update_host', false],
  ])('offers Cancel on a running %s: %s', (kind, cancellable) => {
    renderDetail(operation({ kind }));
    expect(screen.queryByRole('button', { name: 'Cancel' }) !== null).toBe(cancellable);
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it.each([
    ['pending', true],
    ['running', false],
  ] as const)('offers Cancel on a running attach with bind_remote %s: %s', (state, cancellable) => {
    renderDetail(
      operation({ steps: [step('file_sync_initial', 'done'), step('bind_remote', state)] }),
    );
    expect(screen.queryByRole('button', { name: 'Cancel' }) !== null).toBe(cancellable);
  });

  it('sends the running attach to the cancel action', async () => {
    const handlers = renderDetail(
      operation({ steps: [step('file_sync_initial', 'running'), step('bind_remote', 'pending')] }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(handlers.cancel).toHaveBeenCalledWith(expect.objectContaining({ id: 'op1' }));
  });

  it('spins only the pressed action while its request runs', async () => {
    const detail = renderDetail(operation({ kind: 'detach', state: 'failed' }));

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    detail.setPending(true);

    const retry = screen.getByRole('button', { name: 'Retry' });
    expect(retry).toBeDisabled();
    expect(retry.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    for (const name of ['Cancel', 'Force disconnect']) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled();
      expect(button.querySelector('svg')).toBeNull();
    }
  });

  it.each([
    ['pending', true],
    ['running', false],
    ['done', false],
  ] as const)(
    'offers Cancel on a running destroy with its destroy step %s: %s',
    (state, cancellable) => {
      renderDetail(
        operation({ kind: 'destroy_vm', projectId: null, steps: [step('destroy', state)] }),
      );
      expect(screen.queryByRole('button', { name: 'Cancel' }) !== null).toBe(cancellable);
    },
  );

  it('offers Retry and Cancel on a failed attach before bind_remote', async () => {
    const handlers = renderDetail(
      operation({
        state: 'failed',
        steps: [step('push_replica', 'failed'), step('bind_remote', 'pending')],
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(handlers.retry).toHaveBeenCalledWith(expect.objectContaining({ id: 'op1' }));
    expect(handlers.cancel).toHaveBeenCalledWith(expect.objectContaining({ id: 'op1' }));
    expect(screen.queryByRole('button', { name: 'Disconnect instead' })).not.toBeInTheDocument();
  });

  it('offers only Retry on an attach that failed inside bind_remote', () => {
    renderDetail(operation({ state: 'failed', steps: [step('bind_remote', 'failed')] }));
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect instead' })).not.toBeInTheDocument();
  });

  it('offers "Disconnect instead" and no Cancel after bind_remote is done', async () => {
    const handlers = renderDetail(
      operation({
        state: 'failed',
        steps: [step('bind_remote', 'done'), step('thaw_host', 'failed')],
      }),
    );
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect instead' }));
    expect(handlers.disconnectInstead).toHaveBeenCalledWith(expect.objectContaining({ id: 'op1' }));
  });

  it('offers Retry, Cancel and "Force disconnect" on a failed detach', async () => {
    const handlers = renderDetail(operation({ kind: 'detach', state: 'failed' }));
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Force disconnect' }));
    expect(handlers.forceDisconnect).toHaveBeenCalledWith(expect.objectContaining({ id: 'op1' }));
  });

  it('offers Re-authenticate for the providers a failed login test sent back', async () => {
    const handlers = renderDetail(
      operation({
        kind: 'claim',
        projectId: null,
        state: 'failed',
        details: { reauth: ['codex'] },
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Re-authenticate codex' }));
    expect(handlers.reauth).toHaveBeenCalledWith(expect.objectContaining({ id: 'op1' }), ['codex']);
  });

  it('opens the sign-in of a login that waits', async () => {
    const handlers = renderDetail(
      operation({
        kind: 'update_logins',
        projectId: null,
        details: {
          providerAuth: {
            codex: { choice: 'generate', generationId: 'generation-1', sessionId: 'session-1' },
            claude: { choice: 'reuse', entryIds: ['e1'] },
          },
        },
      }),
    );
    expect(screen.queryByRole('button', { name: 'Open Claude sign-in' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open Codex sign-in' }));
    expect(handlers.openLogin).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'generation-1', provider: 'codex', sessionId: 'session-1' }),
    );
  });

  it('offers "Open Chat" after a done Connect when the page can open it', async () => {
    const openChat = jest.fn();
    renderDetail(operation({ state: 'done', steps: [step('a', 'done')] }), {
      actions: actions({ openChat }),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Open Chat' }));
    expect(openChat).toHaveBeenCalledWith('p1');
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('offers "Connect a project" after a done setup only when the page gives the action', async () => {
    const done = operation({ kind: 'create_vm', projectId: null, state: 'done', steps: [] });
    renderDetail(done);
    expect(screen.queryByRole('button', { name: /Connect a project/ })).not.toBeInTheDocument();

    const connectProject = jest.fn();
    renderDetail(done, { actions: actions({ connectProject }) });
    await userEvent.click(screen.getByRole('button', { name: 'Connect a project to lab-vm' }));
    expect(connectProject).toHaveBeenCalledWith('r1');
  });

  it('offers nothing but closing on other done operations', () => {
    renderDetail(operation({ kind: 'update_host', projectId: null, state: 'done', steps: [] }));
    expect(screen.queryAllByRole('button')).toEqual([]);
  });
});

// Rendering operation details is the cheapest layer for the conditional Activity note.
it.each([undefined, 'created'] as const)(
  'shows Git creation in Activity when gitInit is %s',
  (gitInit) => {
    renderDetail(operation({ details: gitInit ? { gitInit } : {} }));
    const note = screen.queryByText('Created a Git repository on this PC.');
    if (gitInit === 'created') expect(note).toBeInTheDocument();
    else expect(note).not.toBeInTheDocument();
  },
);

// Activity rendering owns persisted backup reports and the server's no-cancel boundary.
it.each(['home', 'vm'] as const)(
  'preserves the %s source, per-share backups and replacement sample on failed Force sync',
  (source) => {
    renderDetail(
      operation({
        kind: 'force_sync',
        state: 'failed',
        details: {
          forceSync: {
            source,
            gitInit: 'created',
            backups: [
              { side: source === 'home' ? 'vm' : 'home', kind: 'code', path: '/backup/code' },
              { side: source === 'home' ? 'vm' : 'home', kind: 'git', path: '/backup/git' },
            ],
            replaced: { count: 4, sample: ['code/a.txt', 'git/HEAD'] },
          },
        },
      }),
    );
    const report = screen.getByRole('note', { name: 'Force sync files' });
    expect(report).toHaveTextContent(
      source === 'home' ? 'Source: This PC.' : 'Source: The VM (lab-vm).',
    );
    expect(report).toHaveTextContent(
      `${source === 'home' ? 'The VM' : 'This PC'} · code: /backup/code`,
    );
    expect(report).toHaveTextContent(
      `${source === 'home' ? 'The VM' : 'This PC'} · git: /backup/git`,
    );
    expect(report).toHaveTextContent('4 files replaced or deleted.');
    expect(
      within(report)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['code/a.txt', 'git/HEAD']);
    expect(screen.getByRole('note', { name: 'Git repository' })).toHaveTextContent(
      'Created a Git repository on this PC.',
    );
  },
);
it.each(
  [
    ...(['pending', 'running', 'failed', 'done'] as const).map((copyState) => ({
      operationState: 'failed' as const,
      copyState,
      startedAt: null,
    })),
    { operationState: 'running' as const, copyState: 'pending' as const, startedAt: null },
    {
      operationState: 'running' as const,
      copyState: 'pending' as const,
      startedAt: '2026-09-28T10:03:00.000Z',
    },
    {
      operationState: 'failed' as const,
      copyState: 'pending' as const,
      startedAt: '2026-09-28T10:03:00.000Z',
    },
  ].flatMap((entry) => [
    { ...entry, kind: 'force_sync', stepId: 'force_copy' },
    { ...entry, kind: 'git_owner', stepId: 'git_flip' },
  ]),
)(
  'keeps the persisted $kind cancellation cutoff ($operationState/$copyState, startedAt=$startedAt)',
  async ({ operationState, copyState, startedAt, kind, stepId }) => {
    const handlers = renderDetail(
      operation({
        kind,
        state: operationState,
        steps: [{ ...step(stepId, copyState), startedAt }],
      }),
    );
    if (operationState === 'failed') {
      await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(handlers.retry).toHaveBeenCalled();
    }
    if (copyState === 'pending' && startedAt === null) {
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(handlers.cancel).toHaveBeenCalled();
    } else {
      expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
      expect(handlers.cancel).not.toHaveBeenCalled();
      if (operationState === 'failed' && kind === 'force_sync')
        expect(
          screen.getByText('Retry, or force a disconnect from the project row.'),
        ).toBeInTheDocument();
    }
  },
);

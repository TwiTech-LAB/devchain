import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RemoteOperationDto } from './lib/remote-vm-contracts';
import {
  PROXMOX_CONNECTION,
  REMOTE,
  addOwnVm,
  finishConnect,
  fx,
  makeOperation,
  chooseLogin,
  pickAddVmMenu,
  pickVmMenu,
  overviewVmButton,
  projectRow,
  renderSection,
  resetRemoteVmFixture,
  vmRow,
} from './testing/remote-vm-section.fixture';

const mockUseAllProjects = jest.fn();
const mockUseWorkspaces = jest.fn();
jest.mock('@/ui/hooks/useAllProjects', () => ({
  useAllProjects: () => mockUseAllProjects(),
  useWorkspaces: () => mockUseWorkspaces(),
}));

const mockUseSelectedProject = jest.fn();
jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => mockUseSelectedProject(),
}));

jest.mock('@/ui/hooks/useHomeSocket', () => ({ useHomeSocket: jest.fn() }));

const toastSpy = jest.fn();
jest.mock('@/ui/hooks/use-toast', () => ({ useToast: () => ({ toast: toastSpy }) }));

beforeEach(() =>
  resetRemoteVmFixture({
    useSelectedProject: mockUseSelectedProject,
    useAllProjects: mockUseAllProjects,
    useWorkspaces: mockUseWorkspaces,
    toast: toastSpy,
  }),
);

type Step = RemoteOperationDto['steps'][number];

function step(id: string, label: string, state: Step['state'], error?: Step['error']): Step {
  return { id, label, state, error: error ?? null };
}

function emitProgress(payload?: RemoteOperationDto) {
  act(() =>
    fx.messageHandler?.({
      topic: 'remote-operations',
      type: 'progress',
      ...(payload ? { payload } : {}),
    }),
  );
}

async function openActivityList() {
  await userEvent.click(await screen.findByRole('button', { name: /^Activity/ }));
  return screen.findByRole('dialog', { name: 'Activity' });
}

/** Opens the Activity list and then the detail of the item with this title. */
async function openFromList(title: string) {
  const list = await openActivityList();
  await userEvent.click(await within(list).findByRole('button', { name: new RegExp(`^${title}`) }));
  return screen.findByRole('dialog', { name: title });
}

function currentStep(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByRole('list', { name: 'Current step' });
}

const INSTALL_FAILED = (code: string, message: string, details: Record<string, unknown> = {}) =>
  ({
    ...makeOperation(),
    kind: 'install_host',
    state: 'failed',
    projectId: null,
    details,
    steps: [step('ssh_connect', 'Connect to the VM over SSH', 'failed', { message, code })],
  }) as RemoteOperationDto;

const INSTALLER_AT_LAB = {
  kind: 'installer',
  bootstrapUrl: 'https://10.0.0.5:3000',
  state: 'unclaimed',
  imageVersion: '0.1.2',
  supported: true,
  remoteId: 'r1',
} as const;

// UI integration is the cheapest layer that proves which Activity view each
// request opens, together with the transport, the cache and the socket patch.
const FINGERPRINT = 'AB'.repeat(32);

function pasteFingerprint(scope: HTMLElement) {
  fireEvent.change(within(scope).getByLabelText('Certificate fingerprint (SHA-256)'), {
    target: { value: FINGERPRINT },
  });
}

describe('RemoteVmSection Activity', () => {
  describe('opening rules', () => {
    it('opens the detail of a started Connect, follows its steps and finds it again after reload', async () => {
      fx.remotesData = [{ ...REMOTE, online: true, versionMatches: true }];
      // A bound project keeps the checklist away, so the VM summary loads.
      fx.bindingsData = [{ projectId: 'p2', remoteId: 'r1', state: 'remote' }];
      const view = renderSection();
      await overviewVmButton('lab-vm');
      await userEvent.click(
        within(await projectRow('Project One')).getByRole('button', { name: 'Connect' }),
      );
      await finishConnect(screen.getByRole('dialog', { name: 'Connect Project One' }));

      const detail = await screen.findByRole('dialog', { name: 'Connect · Project One' });
      expect(within(currentStep(detail)).getByText('Copy project')).toBeInTheDocument();
      expect(fx.calls.attachProject).toContainEqual([
        'r1',
        expect.objectContaining({ projectId: 'p1' }),
      ]);

      fx.operationsData[0] = {
        ...fx.operationsData[0],
        steps: [
          { ...fx.operationsData[0].steps[0], state: 'done' },
          { ...fx.operationsData[0].steps[1], state: 'running' },
        ],
      };
      emitProgress(fx.operationsData[0]);
      await waitFor(() =>
        expect(
          within(currentStep(detail)).getByText('Hand ownership to remote'),
        ).toBeInTheDocument(),
      );
      expect(within(detail).getByRole('button', { name: '1 step done' })).toBeInTheDocument();

      view.unmount();
      renderSection();
      await projectRow('Project One');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      const reopened = await openFromList('Connect · Project One');
      expect(
        within(currentStep(reopened)).getByText('Hand ownership to remote'),
      ).toBeInTheDocument();
    });

    it('retries a failed step in the same view and cancels it without opening anything new', async () => {
      fx.operationsData = [
        {
          ...makeOperation(),
          state: 'failed',
          steps: [
            step('copy', 'Copy project', 'failed', { message: 'Disk full', code: 'DISK_FULL' }),
          ],
        },
      ];
      fx.bindingsData = [{ projectId: 'p1', remoteId: 'r1', state: 'failed' }];
      renderSection();

      const detail = await openFromList('Connect · Project One');
      expect(within(detail).getByRole('alert')).toHaveTextContent('Stopped at “Copy project”');
      expect(within(detail).getByRole('alert')).toHaveTextContent('Disk full');
      await userEvent.click(within(detail).getByRole('button', { name: 'Retry' }));

      await waitFor(() =>
        expect(within(currentStep(detail)).getByText('Copy project').closest('li')).toHaveAttribute(
          'data-state',
          'running',
        ),
      );
      expect(fx.calls.retryOperation).toContainEqual(['op1', expect.anything()]);
      expect(screen.getByRole('dialog', { name: 'Connect · Project One' })).toBe(detail);

      fx.operationsData[0] = { ...fx.operationsData[0], state: 'failed' };
      emitProgress();
      await userEvent.click(await within(detail).findByRole('button', { name: 'Cancel' }));

      expect(await within(detail).findByText('Cancelled')).toBeInTheDocument();
      expect(screen.getAllByRole('dialog')).toEqual([detail]);
      await userEvent.click(within(detail).getByRole('button', { name: 'Close' }));
      await waitFor(async () =>
        expect(await projectRow('Project One')).toHaveTextContent('This PC'),
      );
    });

    it('shows the refusal of a Cancel in the detail', async () => {
      fx.operationsData = [{ ...makeOperation(), kind: 'detach', state: 'failed' }];
      fx.overrides.cancelOperation = new Error('The VM copy is being removed; Cancel is refused.');
      renderSection();

      const detail = await openFromList('Disconnect · Project One');
      await userEvent.click(within(detail).getByRole('button', { name: 'Cancel' }));
      expect(
        await within(detail).findByText('The VM copy is being removed; Cancel is refused.'),
      ).toBeInTheDocument();
      expect(toastSpy).not.toHaveBeenCalled();
    });

    it('keeps a rejected start in its form with the error and opens nothing', async () => {
      fx.remotesData = [{ ...REMOTE, online: true, versionMatches: true }];
      // A bound project keeps the checklist away, so the VM summary loads.
      fx.bindingsData = [{ projectId: 'p2', remoteId: 'r1', state: 'remote' }];
      fx.overrides.attachProject = new Error('An operation is open for this VM.');
      renderSection();
      await overviewVmButton('lab-vm');
      await userEvent.click(
        within(await projectRow('Project One')).getByRole('button', { name: 'Connect' }),
      );
      const form = screen.getByRole('dialog');
      await finishConnect(form);

      expect(await within(form).findByRole('alert')).toHaveTextContent(
        'An operation is open for this VM.',
      );
      expect(screen.getAllByRole('dialog')).toEqual([form]);
      expect(toastSpy).not.toHaveBeenCalled();
    });

    it('closes without cancelling and reopens from the header', async () => {
      fx.operationsData = [makeOperation()];
      renderSection();
      const detail = await openFromList('Connect · Project One');

      await userEvent.click(within(detail).getByRole('button', { name: 'Close' }));

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(fx.calls.cancelOperation).toHaveLength(0);
      expect(await openFromList('Connect · Project One')).toBeInTheDocument();
    });
  });

  describe('list mode', () => {
    it('counts open work in the header and groups running, failed and finished work', async () => {
      fx.operationsData = [
        makeOperation(),
        {
          ...makeOperation(),
          id: 'failed-update',
          kind: 'update_host',
          projectId: null,
          state: 'failed',
          steps: [
            step('update', 'Install the new version', 'failed', {
              message: 'No disk.',
              code: null,
            }),
          ],
        },
        { ...makeOperation(), id: 'done-detach', kind: 'detach', projectId: 'p2', state: 'done' },
      ];
      renderSection();

      const button = await screen.findByRole('button', { name: /^Activity/ });
      await waitFor(() => expect(button).toHaveTextContent('Activity2'));
      const list = await openActivityList();

      await userEvent.click(within(list).getByRole('button', { name: /^Update · lab-vm/ }));
      const detail = await screen.findByRole('dialog', { name: 'Update · lab-vm' });
      await userEvent.click(within(detail).getByRole('button', { name: 'All activity' }));
      expect(await screen.findByRole('dialog', { name: 'Activity' })).toBeInTheDocument();
    });
  });

  describe('project recovery', () => {
    it('takes over a failed Connect after bind_remote with "Disconnect instead"', async () => {
      fx.remotesData = [{ ...REMOTE, online: true, versionMatches: true }];
      fx.bindingsData = [{ projectId: 'p1', remoteId: 'r1', state: 'remote' }];
      fx.operationsData = [
        {
          ...makeOperation(),
          state: 'failed',
          steps: [
            step('bind_remote', 'Make the VM the project owner', 'done'),
            step('thaw_host', 'Unlock the project on the VM', 'failed', {
              message: 'VM refused.',
              code: null,
            }),
          ],
        },
      ];
      renderSection();

      const failed = await openFromList('Connect · Project One');
      expect(within(failed).queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
      await userEvent.click(within(failed).getByRole('button', { name: 'Disconnect instead' }));

      const disconnect = await screen.findByRole('dialog', { name: 'Disconnect Project One?' });
      expect(screen.getAllByRole('dialog')).toEqual([disconnect]);
      await userEvent.click(within(disconnect).getByRole('button', { name: 'Disconnect' }));

      await waitFor(() =>
        expect(fx.calls.detachProject).toContainEqual([
          'r1',
          expect.objectContaining({ projectId: 'p1', force: false }),
        ]),
      );
      const detail = await screen.findByRole('dialog', { name: 'Disconnect · Project One' });
      expect(within(currentStep(detail)).getByText('Copy project')).toBeInTheDocument();
    });

    it('takes over a failed Disconnect with "Force disconnect" and its loss list', async () => {
      fx.remotesData = [{ ...REMOTE, online: true, versionMatches: true }];
      fx.bindingsData = [
        {
          projectId: 'p1',
          remoteId: 'r1',
          state: 'detaching',
          hostCursor: new Date(Date.now() - 120_000).toISOString(),
        },
      ];
      fx.operationsData = [
        {
          ...makeOperation(),
          kind: 'detach',
          state: 'failed',
          steps: [
            step('host_release', 'Remove the project copy from the VM', 'failed', {
              message: 'Busy.',
              code: null,
            }),
          ],
        },
      ];
      renderSection();

      const failed = await openFromList('Disconnect · Project One');
      await userEvent.click(within(failed).getByRole('button', { name: 'Force disconnect' }));

      const disconnect = await screen.findByRole('dialog', { name: 'Disconnect Project One?' });
      expect(within(disconnect).getByText('What may be lost')).toBeInTheDocument();
      expect(within(disconnect).getByText(/Changes since the last mirror/)).toBeInTheDocument();
      await userEvent.click(within(disconnect).getByRole('button', { name: 'Force disconnect' }));

      await waitFor(() =>
        expect(fx.calls.detachProject).toContainEqual([
          'r1',
          expect.objectContaining({ projectId: 'p1', force: true }),
        ]),
      );
      const detail = await screen.findByRole('dialog', { name: 'Disconnect · Project One' });
      expect(within(detail).getByText('Running')).toBeInTheDocument();
    });

    it('opens Chat of a connected project in its workspace', async () => {
      fx.operationsData = [
        { ...makeOperation(), state: 'done', steps: [step('copy', 'Copy project', 'done')] },
      ];
      renderSection();

      const detail = await openFromList('Connect · Project One');
      await userEvent.click(within(detail).getByRole('button', { name: 'Open Chat' }));

      const { activateProject } = mockUseSelectedProject.mock.results[0].value;
      expect(activateProject).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'p1', workspaceId: 'w1' }),
      );
      await waitFor(() => expect(fx.pathname).toBe('/chat'));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });
  });

  describe('host install recovery', () => {
    // The component owns the shared pending flag; the backend SSH suite covers cancel latency.
    it('reenables Cloud actions when cancelling a running install returns', async () => {
      fx.providerConnectionsData = [PROXMOX_CONNECTION];
      fx.operationsData = [
        {
          ...makeOperation(),
          kind: 'install_host',
          state: 'running',
          projectId: null,
          steps: [step('install', 'Install the DevChain host', 'running')],
        },
      ];
      let release!: () => void;
      const cancelled = new Promise<void>((resolve) => {
        release = resolve;
      });
      fx.overrides.cancelOperation = async (operationId) => {
        await cancelled;
        return fx.defaults.cancelOperation(operationId);
      };
      renderSection('/?tab=vms');
      // The Create-on items follow the shared pending flag; the menu itself stays openable.
      const createIsDisabled = async (): Promise<boolean> => {
        await userEvent.click(screen.getByRole('button', { name: 'Add VM' }));
        const disabled =
          screen
            .getByRole('menuitem', { name: 'Create on Proxmox lab' })
            .getAttribute('aria-disabled') === 'true';
        await userEvent.keyboard('{Escape}');
        return disabled;
      };
      expect(await createIsDisabled()).toBe(false);
      const detail = await openFromList('Install · lab-vm');
      await userEvent.click(within(detail).getByRole('button', { name: 'Cancel' }));
      // The dialog hides the page behind it, so close it before reading the menu.
      await userEvent.click(within(detail).getByRole('button', { name: 'Close' }));
      expect(await createIsDisabled()).toBe(true);
      await act(async () => {
        release();
      });
      await waitFor(async () => {
        expect(await createIsDisabled()).toBe(false);
      });
      expect(fx.calls.cancelOperation).toContainEqual(['op1']);
    });

    it('shows SSH credentials recovery for a failed host install and retries with them', async () => {
      fx.operationsData = [
        INSTALL_FAILED('SSH_CREDENTIALS_REQUIRED', 'SSH credentials are required.'),
      ];
      renderSection();

      const detail = await openFromList('Install · lab-vm');
      const retryForm = within(detail).getByRole('form', { name: 'SSH credentials retry' });
      expect(within(detail).getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
      await userEvent.type(within(retryForm).getByLabelText('SSH user'), 'ubuntu');
      await userEvent.type(within(retryForm).getByLabelText('SSH password'), 'secret');
      await userEvent.click(within(retryForm).getByRole('button', { name: 'Retry' }));

      await waitFor(() =>
        expect(fx.calls.retryOperation).toContainEqual([
          'op1',
          expect.objectContaining({ ssh: { user: 'ubuntu', password: 'secret' } }),
        ]),
      );
    });

    it.each(['SSH_AUTH_FAILED', 'SSH_KEY_INVALID'])(
      'replaces the plain retry with credential recovery for %s',
      async (code) => {
        fx.availableSshKeys = [{ name: 'id_rsa', type: 'ssh-rsa', encrypted: false }];
        fx.operationsData = [INSTALL_FAILED(code, 'SSH login failed.', { sshKeyName: 'id_rsa' })];
        renderSection();

        const detail = await openFromList('Install · lab-vm');
        const retryForm = within(detail).getByRole('form', { name: 'SSH credentials retry' });
        await waitFor(() =>
          expect(within(retryForm).getByLabelText('Sign in with')).toHaveTextContent(
            'A key from this PC',
          ),
        );
        expect(
          within(retryForm).getByLabelText("Key (the DevChain user's ~/.ssh)"),
        ).toHaveTextContent('id_rsa');
        expect(within(detail).getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
      },
    );
    it('keeps the plain retry for an SSH transport failure', async () => {
      fx.operationsData = [INSTALL_FAILED('SSH_CONNECT_FAILED', 'Connection refused.')];
      renderSection();

      const detail = await openFromList('Install · lab-vm');
      expect(within(detail).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
      expect(
        within(detail).queryByRole('form', { name: 'SSH credentials retry' }),
      ).not.toBeInTheDocument();
    });
    it('offers the sudo-password retry form for SSH_SUDO_PASSWORD_REQUIRED', async () => {
      fx.operationsData = [
        {
          ...INSTALL_FAILED('SSH_SUDO_PASSWORD_REQUIRED', ''),
          steps: [
            step('check', 'Check the VM', 'failed', {
              message:
                'sudo on the VM needs a password for ubuntu. Enter the sudo password and retry.',
              code: 'SSH_SUDO_PASSWORD_REQUIRED',
            }),
          ],
        },
      ];
      renderSection();

      const detail = await openFromList('Install · lab-vm');
      const retryForm = within(detail).getByRole('form', { name: 'SSH credentials retry' });
      expect(within(detail).getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
      await userEvent.type(within(retryForm).getByLabelText('SSH user'), 'ubuntu');
      await userEvent.type(within(retryForm).getByLabelText('SSH password'), 'ssh-secret');
      await userEvent.type(
        within(retryForm).getByLabelText('Sudo password (optional)'),
        'sudo-secret',
      );
      await userEvent.click(within(retryForm).getByRole('button', { name: 'Retry' }));

      await waitFor(() =>
        expect(fx.calls.retryOperation).toContainEqual([
          'op1',
          expect.objectContaining({
            ssh: { user: 'ubuntu', password: 'ssh-secret', sudoPassword: 'sudo-secret' },
          }),
        ]),
      );
    });
  });

  describe('Connect and Disconnect details', () => {
    it('forces an offline disconnect with a loss preview and reports the losses when done', async () => {
      fx.fileSyncStatus = {
        folders: [
          { id: 'code:p1', needItems: 3, needBytes: 4096 },
          { id: 'tx:claude:p1', needItems: 0, needBytes: 0 },
        ],
      };
      fx.bindingsData = [
        {
          projectId: 'p1',
          remoteId: 'r1',
          state: 'remote',
          hostCursor: new Date(Date.now() - 120_000).toISOString(),
          syncError: 'Apply failed',
        },
      ];
      renderSection();
      const row = await projectRow('Project One');
      await waitFor(() => expect(row).toHaveTextContent('Sync failed: Apply failed'));
      await userEvent.click(within(row).getByRole('button', { name: 'Disconnect' }));
      expect(screen.getByText(/Changes since the last mirror/)).toBeInTheDocument();
      await screen.findByText('Project files: files not yet received: 3 items, 4.0 KB');
      expect(screen.queryByText(/Claude transcripts/)).not.toBeInTheDocument();
      expect(screen.queryByText('VM file changes are not synced back.')).not.toBeInTheDocument();
      expect(screen.getByText('Agent time may include unfinalized work.')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Force disconnect' }));

      const detail = await screen.findByRole('dialog', { name: 'Disconnect · Project One' });
      expect(fx.calls.detachProject).toContainEqual([
        'r1',
        expect.objectContaining({ projectId: 'p1', force: true }),
      ]);
      fx.operationsData[0] = {
        ...fx.operationsData[0],
        state: 'done',
        steps: fx.operationsData[0].steps.map((candidate) => ({ ...candidate, state: 'done' })),
        details: {
          forcedLoss: {
            mirrorAgeMs: 120_000,
            fileSync: { folders: [{ id: 'code:p1', needItems: 5, needBytes: 1_572_864 }] },
            teamLanes: 'unfinalized',
            transcripts: 'remote-changes',
          },
        },
      };
      fx.bindingsData = [];
      emitProgress(fx.operationsData[0]);

      expect(await within(detail).findByText('Done')).toBeInTheDocument();
      within(detail).getByRole('note', { name: 'Forced disconnect losses' });

      await userEvent.click(within(detail).getByRole('button', { name: 'Close' }));
      await waitFor(async () =>
        expect(await projectRow('Project One')).toHaveTextContent('This PC'),
      );
    });
  });

  describe('VM operations', () => {
    it('opens the detail of Update VM on a version-mismatched online VM', async () => {
      fx.remotesData = [{ ...REMOTE, online: true, version: '0.22.0', versionMatches: false }];
      renderSection();
      const row = await vmRow('lab-vm');
      expect(within(row).getByText('Update needed')).toBeInTheDocument();

      await userEvent.click(within(row).getByRole('button', { name: 'Update' }));
      await screen.findByRole('dialog', { name: 'Update · lab-vm' });

      expect(fx.calls.updateHost).toContainEqual(['r1', undefined]);
    });

    it('asks before Install Docker and opens its detail', async () => {
      fx.remotesData = [{ ...REMOTE, online: true, version: '0.23.4', versionMatches: true }];
      renderSection();
      await pickVmMenu('lab-vm', 'Install Docker');
      const confirm = await screen.findByRole('dialog');
      expect(within(confirm).getByText(/restarts DevChain on this VM/)).toBeInTheDocument();
      expect(fx.calls.updateHost).toHaveLength(0);
      await userEvent.click(within(confirm).getByRole('button', { name: 'Install Docker' }));

      const detail = await screen.findByRole('dialog', { name: 'Update · lab-vm' });
      expect(
        within(currentStep(detail)).getByText('Install Docker Engine and Compose'),
      ).toBeInTheDocument();
      expect(fx.calls.updateHost).toContainEqual([
        'r1',
        expect.objectContaining({ installDocker: true }),
      ]);
    });

    it('opens a started setup, shows its login tests and re-authenticates in the same view', async () => {
      fx.probeResult = INSTALLER_AT_LAB;
      renderSection();
      // An address VM that this PC never set up offers Set up as its next step.
      await userEvent.click(within(await vmRow('lab-vm')).getByRole('button', { name: 'Set up' }));
      const setup = screen.getByRole('dialog', { name: 'Add your own VM' });
      pasteFingerprint(await within(setup).findByRole('region', { name: 'Address check' }));
      await userEvent.click(within(setup).getByRole('button', { name: 'Continue' }));
      await chooseLogin(setup, 'codex', 'New login (sign in during setup)');
      await userEvent.click(within(setup).getByRole('button', { name: 'Next' }));
      await userEvent.click(within(setup).getByRole('button', { name: 'Set up VM' }));

      const detail = await screen.findByRole('dialog', { name: 'Set up · lab-vm' });
      expect(within(currentStep(detail)).getByText('Check the VM')).toBeInTheDocument();
      expect(fx.calls.claimHost).toContainEqual([
        expect.objectContaining({
          baseUrl: 'https://10.0.0.5:3000',
          certificateFingerprint: FINGERPRINT,
          name: 'lab-vm',
          providerAuth: { codex: 'generate' },
          installDocker: true,
        }),
      ]);

      fx.operationsData[0] = {
        ...fx.operationsData[0],
        state: 'failed',
        details: {
          providerAuth: { codex: { choice: 'generate' } },
          reauth: ['codex'],
          verified: {
            codex: { ok: false, summary: 'not logged in', hint: 'Codex is not logged in.' },
          },
        },
      };
      emitProgress(fx.operationsData[0]);

      expect(await within(detail).findByTestId('verify-codex')).toHaveTextContent('failed');
      await userEvent.click(within(detail).getByTestId('reauth-button'));

      const reauthDialog = await screen.findByRole('dialog', { name: 'Re-authenticate codex' });
      await chooseLogin(reauthDialog, 'codex', 'New login (sign in during setup)');
      await userEvent.click(within(reauthDialog).getByTestId('reauth-submit'));

      await waitFor(() =>
        expect(fx.calls.retryOperation).toContainEqual([
          'op1',
          expect.objectContaining({ providerAuth: { codex: 'generate' } }),
        ]),
      );
      await waitFor(() => expect(reauthDialog).not.toBeInTheDocument());
      expect(screen.getByRole('dialog', { name: 'Set up · lab-vm' })).toBe(detail);
    });

    it('creates a Proxmox VM, cancels it from its detail and offers cleanup', async () => {
      fx.providerConnectionsData = [PROXMOX_CONNECTION];
      renderSection('/?tab=vms');
      await pickAddVmMenu('Create on Proxmox lab');
      const form = screen.getByRole('dialog', { name: 'Add a VM on Proxmox lab' });
      await userEvent.type(within(form).getByLabelText('Name'), 'worker');
      await userEvent.click(within(form).getByRole('button', { name: 'Next' }));
      await chooseLogin(form, 'codex', 'New login (sign in during setup)');
      await userEvent.click(within(form).getByRole('button', { name: 'Next' }));
      await userEvent.click(within(form).getByTestId('add-vm-submit'));

      const detail = await screen.findByRole('dialog', { name: 'Create VM · worker' });

      expect(fx.calls.createVm).toContainEqual([
        'pc1',
        expect.objectContaining({
          name: 'worker',
          cores: 2,
          memory: 4096,
          disk: 30,
          providerAuth: { codex: 'generate' },
          installDocker: true,
        }),
      ]);

      await userEvent.click(within(detail).getByRole('button', { name: 'Cancel' }));
      expect(await within(detail).findByText('Cancelled')).toBeInTheDocument();
      await userEvent.click(within(detail).getByRole('button', { name: 'Close' }));

      await userEvent.click(screen.getByRole('tab', { name: 'Overview' }));
      const row = await vmRow('worker');
      expect(await within(row).findByText('Setup cancelled')).toBeInTheDocument();
      await userEvent.click(within(row).getByRole('button', { name: 'Remove from list' }));
      const cleanupDialog = screen.getByRole('dialog');
      expect(within(cleanupDialog).getByText(/guarded VM cleanup completed/i)).toBeInTheDocument();
      await userEvent.click(within(cleanupDialog).getByRole('button', { name: 'Remove' }));
      await waitFor(() => expect(screen.queryByText('worker')).not.toBeInTheDocument());
      expect(fx.calls.deleteRemote).toContainEqual(['r-created']);
    });

    it('lists bound projects, requires forced confirmation when unreachable, and opens the reset detail', async () => {
      fx.remotesData = [
        {
          ...REMOTE,
          kind: 'proxmox',
          vmProviderConnectionId: 'pc1',
          vmIdentity: '12345678-1234-1234-1234-123456789abc',
          vmSpec: { cores: 2, memory: 4096, disk: 30 },
        },
      ];
      fx.bindingsData = [
        { projectId: 'p1', remoteId: 'r1', state: 'remote' },
        { projectId: 'p2', remoteId: 'r1', state: 'remote' },
      ];
      renderSection();
      await pickVmMenu('lab-vm', 'Reset VM');
      const form = screen.getByRole('dialog');
      expect(
        within(form).getByRole('list', { name: 'Projects that will be reconnected' }),
      ).toHaveTextContent('Project OneProject Two');
      expect(within(form).getByText(/may be lost/i)).toBeInTheDocument();
      const resetButton = within(form).getByRole('button', { name: 'Reset VM' });
      expect(resetButton).toBeDisabled();
      await userEvent.click(
        within(form).getByRole('checkbox', { name: 'Force reset while the VM is unreachable' }),
      );
      await userEvent.click(resetButton);

      await screen.findByRole('dialog', { name: 'Reset · lab-vm' });

      // Reset steps carry the project id; the detail shows its name.

      expect(fx.calls.resetVm).toContainEqual([
        'r1',
        expect.objectContaining({ force: true, providerAuth: {} }),
      ]);
    });

    it('starts guarded VM destruction and opens its detail', async () => {
      fx.remotesData = [
        {
          ...REMOTE,
          online: true,
          kind: 'proxmox',
          vmProviderConnectionId: 'pc1',
          vmIdentity: '12345678-1234-1234-1234-123456789abc',
          vmSpec: { cores: 2, memory: 4096, disk: 30 },
        },
      ];
      renderSection();
      await pickVmMenu('lab-vm', 'Destroy VM');
      const form = screen.getByRole('dialog');
      // The Destroy VM menu item opens today's dialog with the destroy option set.
      expect(within(form).getByRole('checkbox', { name: 'Destroy VM too' })).toBeChecked();
      await userEvent.click(within(form).getByRole('button', { name: 'Destroy VM' }));

      const detail = await screen.findByRole('dialog', { name: 'Destroy · lab-vm' });
      expect(within(detail).getByText('Running')).toBeInTheDocument();

      expect(fx.calls.destroyVm).toContainEqual(['r1', expect.objectContaining({ force: false })]);
    });
  });

  describe('Add your own VM', () => {
    it('sets up a VM again after a cancelled setup, through the address check', async () => {
      fx.remotesData = [
        {
          ...REMOTE,
          lastOperation: {
            id: 'op-old',
            kind: 'claim',
            state: 'cancelled',
            updatedAt: '2026-09-25T00:00:00.000Z',
          },
        },
      ];
      fx.probeResult = INSTALLER_AT_LAB;
      renderSection();

      const row = await vmRow('lab-vm');
      expect(row).toHaveTextContent('Setup cancelled');
      await userEvent.click(within(row).getByRole('button', { name: 'Set up' }));

      const flow = screen.getByRole('dialog', { name: 'Add your own VM' });
      expect(within(flow).getByLabelText('VM address')).toHaveValue('10.0.0.5');
      pasteFingerprint(await within(flow).findByRole('region', { name: 'Address check' }));
      await userEvent.click(within(flow).getByRole('button', { name: 'Continue' }));
      expect(fx.probeBodies).toEqual([{ address: '10.0.0.5', checkSsh: true }]);
      expect(within(flow).getByText('Step 2 of 3: Logins')).toBeInTheDocument();
      expect(
        within(flow).getByRole('combobox', { name: 'codex login choice' }),
      ).toBeInTheDocument();
    });

    it('sends a failed setup to Activity instead of starting a new one', async () => {
      fx.operationsData = [
        {
          ...makeOperation(),
          id: 'claim-failed',
          kind: 'claim',
          projectId: null,
          state: 'failed',
          steps: [
            step('preflight', 'Check the VM', 'failed', {
              code: 'VM_NOT_UNCLAIMED',
              message: 'The address does not answer as an unclaimed DevChain host VM.',
            }),
          ],
        },
      ];
      fx.probeResult = INSTALLER_AT_LAB;
      renderSection();

      const row = await vmRow('lab-vm');
      expect(within(row).queryByRole('button', { name: 'Set up' })).not.toBeInTheDocument();
      expect(within(row).getByRole('button', { name: 'Resolve' })).toBeInTheDocument();

      await addOwnVm();
      const flow = screen.getByRole('dialog', { name: 'Add your own VM' });
      await userEvent.type(within(flow).getByLabelText('VM address'), '10.0.0.5');
      await userEvent.click(within(flow).getByRole('button', { name: 'Check' }));

      await userEvent.click(within(flow).getByRole('button', { name: 'Resolve' }));
      const detail = await screen.findByRole('dialog', { name: 'Set up · lab-vm' });
      expect(within(detail).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
      expect(fx.calls.claimHost).not.toContainEqual([expect.anything()]);
    });
  });

  describe('Change logins', () => {
    const LOGINS = { codex: { choice: 'reuse', entryIds: ['e1'] } };

    it('cancels a failed change first and opens only the new one', async () => {
      fx.remotesData = [{ ...REMOTE, online: true, versionMatches: true, logins: LOGINS }];
      fx.operationsData = [
        {
          ...makeOperation(),
          id: 'logins-failed',
          kind: 'update_logins',
          projectId: null,
          state: 'failed',
          createdAt: '2026-09-26T00:00:00.000Z',
          details: {},
          steps: [
            step('preflight', 'Check the VM and its logins', 'failed', {
              code: 'REMOTE_AGENTS_RUNNING',
              message: '2 agent sessions are running. Choose Change anyway to force this change.',
            }),
          ],
        },
      ];
      renderSection();

      await pickVmMenu('lab-vm', 'Change logins');
      const form = screen.getByRole('dialog', { name: 'Change logins for lab-vm' });
      await chooseLogin(form, 'codex', 'None');
      await userEvent.click(within(form).getByTestId('change-logins-submit'));

      await waitFor(() =>
        expect(fx.loginsBody).toEqual({ providerAuth: { codex: 'skip' }, force: false }),
      );
      expect(fx.calls.cancelOperation).toContainEqual(['logins-failed']);
      const detail = await screen.findByRole('dialog', { name: 'Change logins · lab-vm' });
      expect(
        within(currentStep(detail)).getByText('Check the VM and its logins').closest('li'),
      ).toHaveAttribute('data-state', 'running');
      expect(within(detail).queryByText(/agent sessions are running/)).not.toBeInTheDocument();
    });
  });
});

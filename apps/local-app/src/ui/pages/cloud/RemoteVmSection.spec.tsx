import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  PROXMOX_CONNECTION,
  REMOTE,
  addOwnVm,
  fx,
  makeOperation,
  openVmMenu,
  chooseLogin,
  pickAddVmMenu,
  pickVmMenu,
  overviewVmButton,
  openFileSyncSettings,
  projectRow,
  renderSection,
  resetRemoteVmFixture,
  vmRow,
  type TestRemote,
  finishConnect,
} from './testing/remote-vm-section.fixture';
import { RemoteOperationDto } from '@/ui/hooks/useRemoteOperations';
import { exclusion, fileSyncFailures } from './testing/file-sync-failures.fixture';
import { POWER_ON_GRACE_MS } from './remote-status';
const mockUseSelectedProject = jest.fn();
jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => mockUseSelectedProject(),
}));

jest.mock('@/ui/hooks/useHomeSocket', () => ({ useHomeSocket: jest.fn() }));

const toastSpy = jest.fn();
jest.mock('@/ui/hooks/use-toast', () => ({ useToast: () => ({ toast: toastSpy }) }));

beforeEach(() =>
  resetRemoteVmFixture({ useSelectedProject: mockUseSelectedProject, toast: toastSpy }),
);

describe('RemoteVmSection', () => {
  describe('RemoteVmSection', () => {
    it('sends the selected Docker items with the connect request', async () => {
      fx.dockerPlanData = {
        projectId: 'p1',
        remoteId: 'r1',
        scannedAt: '2026-09-27T10:00:00.000Z',
        availability: { available: true, side: null, reason: null },
        apiVersion: '1.47',
        items: [
          {
            id: 'web',
            kind: 'container',
            name: 'web',
            composeProject: null,
            linkedReasons: ['bind:/home/dev/project'],
            defaultSelected: true,
            selectedMode: 'container-and-data',
            choices: ['container-and-data'],
            temporary: false,
            images: [],
            mounts: [],
            writerGroup: [],
            alsoStops: [],
            blockers: [],
            warnings: [],
            notes: [],
            writableLayer: { bytes: 0, unknown: false },
            targetAction: 'create',
          },
          {
            id: 'gpu',
            kind: 'container',
            name: 'gpu',
            composeProject: null,
            linkedReasons: ['bind:/home/dev/project/gpu'],
            defaultSelected: false,
            selectedMode: null,
            choices: ['data-only'],
            temporary: false,
            images: [],
            mounts: [],
            writerGroup: [],
            alsoStops: [],
            blockers: [],
            warnings: [],
            notes: [],
            writableLayer: { bytes: 0, unknown: false },
            targetAction: 'data-only',
          },
        ],
        filesystems: [
          {
            filesystemId: 'fs1',
            paths: ['/var/lib/docker'],
            requiredBytes: 1,
            headroomBytes: 0,
            freeBytes: 1_000_000,
            unknown: false,
            status: 'fits',
          },
        ],
        copySize: { bytes: 0, unknown: false },
        fit: 'fits',
        canConnect: true,
        warnings: [],
        managedExclusions: [],
        codePaths: [],
        reconnect: null,
        estimate: null,
      };
      fx.remotesData = [{ ...REMOTE, online: true, versionMatches: true }];
      // A bound project keeps the checklist away, so the VM summary loads.
      fx.bindingsData = [{ projectId: 'p2', remoteId: 'r1', state: 'remote' }];
      renderSection();
      await overviewVmButton('lab-vm');
      await userEvent.click(
        within(await projectRow('Project One')).getByRole('button', { name: 'Connect' }),
      );
      const flow = screen.getByRole('dialog', { name: 'Connect Project One' });
      await userEvent.click(within(flow).getByRole('button', { name: 'Next' }));
      await userEvent.click(
        within(flow).getByRole('checkbox', { name: 'Include Docker containers' }),
      );
      await within(flow).findByText('Docker containers');
      await userEvent.click(within(flow).getByRole('checkbox', { name: 'gpu' }));
      await waitFor(() => expect(within(flow).getByRole('button', { name: 'Next' })).toBeEnabled());
      await userEvent.click(within(flow).getByRole('button', { name: 'Next' }));
      await userEvent.click(within(flow).getByRole('button', { name: 'Connect' }));
      await screen.findByRole('dialog', { name: 'Connect · Project One' });
      expect(fx.mockFetch).toHaveBeenCalledWith(
        '/api/remotes/r1/attach',
        expect.objectContaining({
          body: JSON.stringify({
            projectId: 'p1',
            docker: {
              items: [
                { id: 'web', mode: 'container-and-data' },
                { id: 'gpu', mode: 'data-only' },
              ],
            },
          }),
        }),
      );
    });

    it('shows a retryable file sync warning independently of database mirror errors', async () => {
      fx.bindingsData = [
        {
          projectId: 'p1',
          remoteId: 'r1',
          state: 'remote',
          fileSyncWarning: 'File sync will retry automatically.',
        },
      ];
      renderSection();
      expect(await projectRow('Project One')).toHaveTextContent(
        'File sync will retry automatically.',
      );
      expect(screen.queryByText(/sync failed:/)).not.toBeInTheDocument();
    });

    it('falls back to the generic file line when home cannot tell what it has not received', async () => {
      fx.bindingsData = [{ projectId: 'p1', remoteId: 'r1', state: 'remote', hostCursor: null }];
      renderSection();
      await userEvent.click(
        within(await projectRow('Project One')).getByRole('button', { name: 'Disconnect' }),
      );

      expect(await screen.findByText('VM file changes are not synced back.')).toBeInTheDocument();
      expect(fx.mockFetch).toHaveBeenCalledWith(
        '/api/file-sync/projects/p1/status',
        expect.anything(),
      );
    });

    it.each([['No VM is ready', [{ ...REMOTE }]]])(
      'disables Connect with "%s"',
      async (reason, remotes) => {
        fx.remotesData = remotes;
        renderSection();
        const row = await projectRow('Project One');
        expect(within(row).getByRole('button', { name: 'Connect' })).toBeDisabled();
        expect(within(row).getByLabelText(`Connect: ${reason}`)).toBeInTheDocument();
      },
    );

    it('opens Add your own VM from the VMs tab Add VM menu; without a server it offers Connect', async () => {
      renderSection();
      // Overview has no add button of its own anymore.
      expect(screen.queryByRole('button', { name: 'Add VM' })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('tab', { name: /^VMs/ }));

      // No server is connected, so the menu offers the connect flow instead of Create on.
      await pickAddVmMenu('Connect a Proxmox server');
      expect(screen.getByRole('dialog', { name: 'Connect a server' })).toBeInTheDocument();
      await userEvent.keyboard('{Escape}');

      await addOwnVm();

      const flow = screen.getByRole('dialog', { name: 'Add your own VM' });
      expect(within(flow).getByLabelText('VM address')).toHaveValue('');
      expect(fx.probeBodies).toEqual([]);
    });

    const FINGERPRINT = 'AB'.repeat(32);
    const MISMATCH =
      'The fingerprint does not match the certificate that this address shows. Copy the fingerprint again from this VM.';

    it('adds a DevChain found at an address and the list updates without reload', async () => {
      fx.probeResult = {
        kind: 'devchain',
        baseUrl: 'http://10.0.0.9:4000',
        version: '0.23.4',
        versionMatches: true,
        homePath: '/home/devchain',
        homePathMatches: true,
        remoteId: null,
      };
      renderSection();
      await addOwnVm();
      const flow = screen.getByRole('dialog', { name: 'Add your own VM' });

      await userEvent.type(within(flow).getByLabelText('VM address'), '10.0.0.9:4000');
      await userEvent.click(within(flow).getByRole('button', { name: 'Check' }));
      const name = await within(flow).findByLabelText('Name');
      await userEvent.clear(name);
      await userEvent.type(name, 'new-vm');
      await userEvent.type(within(flow).getByLabelText('API key'), `dck_${'a'.repeat(43)}`);
      fireEvent.change(within(flow).getByLabelText('Certificate fingerprint (SHA-256)'), {
        target: { value: FINGERPRINT },
      });
      await userEvent.click(within(flow).getByRole('button', { name: 'Add VM' }));

      expect(await vmRow('new-vm')).toBeInTheDocument();
      expect(screen.queryByRole('dialog', { name: 'Add your own VM' })).not.toBeInTheDocument();
      const create = fx.mockFetch.mock.calls.find(
        ([url, init]) => url === '/api/remotes' && init?.method === 'POST',
      );
      expect(JSON.parse(create![1].body)).toEqual({
        name: 'new-vm',
        baseUrl: 'http://10.0.0.9:4000',
        apiKey: `dck_${'a'.repeat(43)}`,
        certificateFingerprint: FINGERPRINT,
      });
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'VM added', description: 'new-vm was added.' }),
      );
    });

    it('shows a fingerprint mismatch once in the dialog, without a toast', async () => {
      fx.probeResult = {
        kind: 'devchain',
        baseUrl: 'http://10.0.0.9:4000',
        version: '0.23.4',
        versionMatches: true,
        homePath: '/home/devchain',
        homePathMatches: true,
        remoteId: null,
      };
      const serve = fx.mockFetch.getMockImplementation()!;
      fx.mockFetch.mockImplementation(async (url: string, init?: RequestInit) =>
        url === '/api/remotes' && init?.method === 'POST'
          ? ({
              ok: false,
              status: 409,
              json: async () => ({ statusCode: 409, message: MISMATCH }),
            } as Response)
          : serve(url, init),
      );
      renderSection();
      await addOwnVm();
      const flow = screen.getByRole('dialog', { name: 'Add your own VM' });

      await userEvent.type(within(flow).getByLabelText('VM address'), '10.0.0.9:4000');
      await userEvent.click(within(flow).getByRole('button', { name: 'Check' }));
      const name = await within(flow).findByLabelText('Name');
      await userEvent.clear(name);
      await userEvent.type(name, 'new-vm');
      await userEvent.type(within(flow).getByLabelText('API key'), `dck_${'a'.repeat(43)}`);
      fireEvent.change(within(flow).getByLabelText('Certificate fingerprint (SHA-256)'), {
        target: { value: FINGERPRINT },
      });
      await userEvent.click(within(flow).getByRole('button', { name: 'Add VM' }));

      expect(await within(flow).findByRole('alert')).toHaveTextContent(MISMATCH);
      expect(screen.getByRole('dialog', { name: 'Add your own VM' })).toBeInTheDocument();
      expect(toastSpy).not.toHaveBeenCalled();
    });

    it('applies a remotes/state socket envelope in place', async () => {
      renderSection();
      expect(await vmRow('lab-vm')).toHaveTextContent('Not set up');

      act(() => {
        fx.messageHandler?.({
          topic: 'remotes',
          type: 'state',
          payload: {
            remoteId: 'r1',
            online: true,
            version: '9.9.9',
            versionMatches: false,
            stats: {
              cpuPercent: 42,
              load1: 1.2,
              load5: 1.1,
              memTotalBytes: 8 * 1024 ** 3,
              memUsedBytes: 4 * 1024 ** 3,
              diskTotalBytes: 100 * 1024 ** 3,
              diskUsedBytes: 40 * 1024 ** 3,
              uptimeSec: 100,
              sampledAt: '2026-01-01T00:00:00.000Z',
            },
            lastSeenAt: '2026-01-01T00:00:00.000Z',
          },
          ts: '2026-01-01T00:00:00.000Z',
        });
      });

      const row = await vmRow('lab-vm');
      await waitFor(() => expect(row).toHaveTextContent('Update needed'));
      // Online rows show the metrics strip instead of the last-seen time.
      expect(within(row).getByTestId('remote-metrics-strip')).toBeInTheDocument();
    });

    it('ignores socket envelopes for other topics', async () => {
      // A bound project keeps the checklist away, so the VM summary loads.
      fx.bindingsData = [{ projectId: 'p2', remoteId: 'r1', state: 'remote' }];
      renderSection();
      await overviewVmButton('lab-vm');

      act(() => {
        fx.messageHandler?.({ topic: 'system', type: 'ping', payload: {}, ts: '' });
      });

      expect(await vmRow('lab-vm')).toHaveTextContent('Not set up');
    });

    it('shows the server 409 message when deleting a remote with bindings', async () => {
      fx.bindingsData = [{ projectId: 'p1', remoteId: 'r1', state: 'remote' }];
      renderSection();
      await pickVmMenu('lab-vm', 'Remove');
      await userEvent.click(screen.getByRole('button', { name: /^delete registration$/i }));

      await waitFor(() =>
        expect(toastSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            description: 'Cannot delete a remote with a project binding.',
            variant: 'destructive',
          }),
        ),
      );
      // The row survives the failed delete (optimistic removal was rolled back); the
      // dialog stays open, so the page behind it is hidden from the accessibility tree.
      expect(
        within(screen.getByRole('list', { name: 'VMs', hidden: true })).getByRole('listitem', {
          name: 'lab-vm',
          hidden: true,
        }),
      ).toBeInTheDocument();
    });

    it('shows the Docker badge and hides install when Engine, Compose and group access are usable', async () => {
      fx.remotesData = [
        {
          ...REMOTE,
          online: true,
          docker: {
            installed: true,
            userInGroup: true,
            engineVersion: '29',
            composeVersion: '2',
            dataRootFreeBytes: 1,
          },
        },
      ];
      renderSection();

      expect(await openVmMenu('lab-vm')).not.toContain('Install Docker');
    });

    it('lists bound projects and refuses to start VM destruction until they are disconnected', async () => {
      fx.remotesData = [
        {
          ...REMOTE,
          online: true,
          kind: 'proxmox',
          vmProviderConnectionId: 'pc1',
          vmIdentity: '12345678-1234-1234-1234-123456789abc',
        },
      ];
      fx.bindingsData = [
        { projectId: 'p1', remoteId: 'r1', state: 'remote' },
        { projectId: 'p2', remoteId: 'r1', state: 'remote' },
      ];
      renderSection();
      await pickVmMenu('lab-vm', 'Destroy VM');
      const dialog = screen.getByRole('dialog');

      expect(within(dialog).getByText('Disconnect these projects first:')).toBeInTheDocument();
      expect(
        within(dialog).getByRole('list', { name: 'Projects connected to this VM' }),
      ).toHaveTextContent('Project OneProject Two');
      expect(within(dialog).getByRole('button', { name: 'Destroy VM' })).toBeDisabled();
      expect(fx.mockFetch).not.toHaveBeenCalledWith(
        '/api/remotes/r1/destroy-vm',
        expect.anything(),
      );
    });

    it.each([
      [{ online: false, apiKeyRejected: false }, /Provider logins keep their last saved copy/i],
      [{ online: true, apiKeyRejected: true }, /The VM rejects this PC's API key/],
    ])('requires force confirmation for an unreachable VM: %j', async (state, warning) => {
      fx.remotesData = [
        {
          ...REMOTE,
          ...state,
          kind: 'proxmox',
          vmProviderConnectionId: 'pc1',
          vmIdentity: '12345678-1234-1234-1234-123456789abc',
        },
      ];
      renderSection();
      await pickVmMenu('lab-vm', 'Destroy VM');
      const dialog = screen.getByRole('dialog');

      expect(within(dialog).getByText(warning)).toBeInTheDocument();
      const destroyButton = within(dialog).getByRole('button', { name: 'Destroy VM' });
      expect(destroyButton).toBeDisabled();
      await userEvent.click(
        within(dialog).getByRole('checkbox', {
          name: 'Force destruction while the VM is unreachable',
        }),
      );
      await userEvent.click(destroyButton);

      expect(fx.mockFetch).toHaveBeenCalledWith(
        '/api/remotes/r1/destroy-vm',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ force: true }) }),
      );
    });

    it('offers guarded destroy after a failed create even when no VM identity was saved', async () => {
      fx.remotesData = [
        {
          ...REMOTE,
          baseUrl: null,
          kind: 'proxmox',
          vmProviderConnectionId: 'pc1',
          vmIdentity: null,
        },
      ];
      fx.operationsData = [
        {
          ...makeOperation(),
          kind: 'create_vm',
          projectId: null,
          state: 'failed',
          createdAt: '2026-09-25T01:00:00.000Z',
          steps: [
            {
              id: 'claim_claim',
              label: 'Claim VM',
              state: 'failed',
              error: { code: 'HOST_START_TIMEOUT', message: 'Host did not start.' },
            },
          ],
        },
      ];
      renderSection();
      expect(await vmRow('lab-vm')).toHaveTextContent('Create stopped');
      await pickVmMenu('lab-vm', 'Remove');
      const dialog = screen.getByRole('dialog');
      expect(
        within(dialog).getByText(/Delete registration leaves any VM in Proxmox/i),
      ).toBeInTheDocument();
      await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Destroy VM too' }));
      await userEvent.click(
        within(dialog).getByRole('checkbox', {
          name: 'Force destruction while the VM is unreachable',
        }),
      );
      await userEvent.click(within(dialog).getByRole('button', { name: 'Destroy VM' }));
      expect(fx.mockFetch).toHaveBeenCalledWith(
        '/api/remotes/r1/destroy-vm',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ force: true }) }),
      );
    });

    it('offers registration-only deletion after a failed reset and says the VM remains', async () => {
      fx.remotesData = [
        {
          ...REMOTE,
          baseUrl: null,
          kind: 'proxmox',
          vmProviderConnectionId: 'pc1',
          vmIdentity: null,
        },
      ];
      fx.operationsData = [
        {
          ...makeOperation(),
          kind: 'reset_vm',
          projectId: null,
          state: 'failed',
          createdAt: '2026-09-25T01:00:00.000Z',
          steps: [
            {
              id: 'create_clone',
              label: 'Clone new VM',
              state: 'failed',
              error: { code: 'PROXMOX_UNREACHABLE', message: 'Cannot reach node.' },
            },
          ],
        },
      ];
      renderSection();
      await pickVmMenu('lab-vm', 'Remove');
      const dialog = screen.getByRole('dialog');
      expect(
        within(dialog).getByText(/Delete registration leaves any VM in Proxmox/i),
      ).toBeInTheDocument();
      expect(within(dialog).getByRole('checkbox', { name: 'Destroy VM too' })).toBeEnabled();
      await userEvent.click(within(dialog).getByRole('button', { name: 'Delete registration' }));
      await waitFor(() => expect(screen.queryByText('lab-vm')).not.toBeInTheDocument());
      expect(fx.mockFetch).toHaveBeenCalledWith('/api/remotes/r1', { method: 'DELETE' });
      expect(fx.mockFetch).not.toHaveBeenCalledWith(
        '/api/remotes/r1/destroy-vm',
        expect.anything(),
      );
    });

    it('shows VM destroyed with the shared Remove action for a completed addressless destroy', async () => {
      fx.remotesData = [
        {
          ...REMOTE,
          baseUrl: null,
          kind: 'proxmox',
          vmProviderConnectionId: 'pc1',
          vmIdentity: null,
          // The finished destroy is not loaded; the VM list names it.
          lastOperation: {
            id: 'destroy-done',
            kind: 'destroy_vm',
            state: 'done',
            updatedAt: '2026-09-25T00:00:00.000Z',
          },
        },
      ];
      renderSection();

      const row = await vmRow('lab-vm');
      expect(row).toHaveTextContent('VM destroyed');
      await userEvent.click(within(row).getByRole('button', { name: 'Remove from list' }));
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByText(/already destroyed/i)).toBeInTheDocument();
      await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
      await waitFor(() => expect(screen.queryByText('lab-vm')).not.toBeInTheDocument());
      expect(fx.mockFetch).toHaveBeenCalledWith('/api/remotes/r1', { method: 'DELETE' });
    });

    describe('Change logins', () => {
      // The VM list's record of the newest setup; old operations are not loaded.
      const LOGINS = {
        claude: { choice: 'reuse', entryIds: ['e1'] },
        opencode: { choice: 'generate', entryIds: ['a1', 'a2'] },
      };

      it('offers the menu item only for an online, version-matched, claimed VM', async () => {
        fx.remotesData = [{ ...REMOTE, online: true, versionMatches: true, logins: LOGINS }];
        const claimed = renderSection();
        expect(await openVmMenu('lab-vm')).toContain('Change logins');
        claimed.unmount();

        // Never set up from this PC: no item, even online.
        fx.remotesData = [{ ...REMOTE, online: true, versionMatches: true, logins: null }];
        const independent = renderSection();
        expect(await openVmMenu('lab-vm')).not.toContain('Change logins');
        independent.unmount();

        // Version mismatch: no item, even with a record.
        fx.remotesData = [{ ...REMOTE, online: true, versionMatches: false, logins: LOGINS }];
        renderSection();
        expect(await openVmMenu('lab-vm')).not.toContain('Change logins');
      });

      it('prefills from the record and sends only the changed providers', async () => {
        fx.remotesData = [
          {
            ...REMOTE,
            online: true,
            versionMatches: true,
            providerEnvOverrides: [
              { key: 'CLAUDE_CODE_OAUTH_TOKEN', source: 'provider-env', provider: 'claude' },
            ],
            logins: LOGINS,
          },
        ];
        renderSection();

        await pickVmMenu('lab-vm', 'Change logins');
        const dialog = screen.getByRole('dialog', { name: 'Change logins for lab-vm' });

        await chooseLogin(dialog, 'codex', 'None');
        // Changing claude surfaces the VM's override report for that provider.
        await chooseLogin(dialog, 'claude', 'None');

        await userEvent.click(within(dialog).getByTestId('change-logins-submit'));
        await waitFor(() => expect(fx.loginsBody).not.toBeNull());
        expect(fx.loginsBody).toEqual({
          providerAuth: { claude: 'skip', codex: 'skip' },
          force: false,
        });
        expect(fx.mockFetch).toHaveBeenCalledWith(
          '/api/remotes/r1/logins',
          expect.objectContaining({ method: 'POST' }),
        );
      });
    });
  });

  // Page wiring verifies that both the attention action and the VM menu reach the home-only dialogs.
  describe('VM API key recovery actions', () => {
    it('opens Enter API key from Needs attention and hides Reset while rejected', async () => {
      fx.remotesData = [{ ...REMOTE, online: true, apiKeyRejected: true }];
      renderSection();
      const attention = await screen.findByRole('list', { name: 'Needs attention' });
      await userEvent.click(within(attention).getByRole('button', { name: 'Enter API key' }));
      expect(screen.getByRole('dialog', { name: 'Enter API key for lab-vm' })).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });

    it('offers Reset API key for an accepted online VM', async () => {
      fx.remotesData = [{ ...REMOTE, online: true, apiKeyRejected: false }];
      renderSection();
      await pickVmMenu('lab-vm', 'Reset API key');
      expect(screen.getByRole('dialog', { name: 'Reset API key for lab-vm' })).toBeInTheDocument();
    });
  });
});

describe('RemoteVmSection.shell', () => {
  const LOGINS = { codex: { choice: 'reuse', entryIds: ['e1'] } };
  const READY: TestRemote = {
    ...REMOTE,
    online: true,
    version: '0.23.4',
    versionMatches: true,
    lastSeenAt: '2026-09-28T10:00:00.000Z',
    logins: LOGINS,
    homePath: '/home/devchain',
    homePathMatches: true,
  };
  const MANAGED: TestRemote = {
    ...READY,
    kind: 'proxmox',
    vmProviderConnectionId: 'pc1',
    vmIdentity: '12345678-1234-1234-1234-123456789abc',
    vmSpec: { cores: 2, memory: 4096, disk: 30 },
  };

  function hostOperation(
    kind: string,
    state: RemoteOperationDto['state'],
    error?: string,
  ): RemoteOperationDto {
    return {
      ...makeOperation(),
      id: `${kind}-op`,
      kind,
      projectId: null,
      state,
      steps: [
        {
          id: 'update',
          label: 'Install the new version',
          state: state === 'failed' ? 'failed' : 'running',
          error: error ? { message: error, code: null } : null,
        },
      ],
    };
  }

  function actionButtons(row: HTMLElement): string[] {
    return within(row)
      .getAllByRole('button')
      .map((button) => button.textContent ?? '')
      .filter((name) => name !== 'lab-vm' && name !== '');
  }

  // UI integration: the page's rows, menu and boxes render only the status model's
  // output; this proves the wiring from the fetched data to what the user can click.
  describe('RemoteVmSection shell', () => {
    it('shows the Activity button on the tabs line, and keeps the tab in the URL', async () => {
      fx.providerConnectionsData = [PROXMOX_CONNECTION];
      fx.bindingsData = [{ projectId: 'p1', remoteId: 'r1', state: 'remote' }];
      renderSection();

      // The Cloud navigation already names the section, so the page repeats no heading.

      expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await waitFor(() =>
        expect(screen.getByRole('tab', { name: /^Proxmox/ })).toHaveTextContent('Proxmox1'),
      );
      expect(screen.getByRole('tab', { name: /^VMs/ })).toHaveTextContent('VMs1');
      expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
        'Overview',
        'Projects2',
        'VMs1',
        'Logins0',
        'Proxmox1',
      ]);
      // Overview is read-only: the summary names each VM, and no row actions render.
      expect(screen.getByRole('button', { name: 'Manage VMs' })).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'More actions for lab-vm' }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Add VM' })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('tab', { name: /^VMs/ }));
      expect(fx.search).toContain('tab=vms');
      // The full VM list lives on the VMs tab, not in a titled card.

      await userEvent.click(screen.getByRole('tab', { name: /^Proxmox/ }));
      expect(fx.search).toContain('tab=proxmox');
      expect(await screen.findByRole('button', { name: 'Connect a server' })).toBeInTheDocument();
    });

    // Existing page fixture is the smallest owner that opens real VM details.
    it('shows the Docker conflict note in VM details while the account ids differ', async () => {
      fx.remotesData = [
        {
          ...REMOTE,
          online: true,
          versionMatches: true,
          uid: 1001,
          gid: 1000,
          dockerUserMismatch: {
            homeUid: 1000,
            homeGid: 1000,
            vmUid: 1001,
            vmGid: 1000,
            uidConflict: { requestedUid: 1000, holder: 'ubuntu' },
          },
        },
      ];
      renderSection('/?tab=vms&vm=r1');
      const drawer = await screen.findByRole('dialog', { name: 'lab-vm' });
      expect(within(drawer).getByRole('note', { name: 'Docker user ids' })).toHaveTextContent(
        'uid 1000 is used by ubuntu on the VM; the VM user got 1001:1000. Automatic Docker moves are off for this VM.',
      );
    });

    it('opens the Logins tab from the URL', async () => {
      renderSection('/?tab=logins');
      expect(screen.getByRole('tab', { name: /^Logins/ })).toHaveAttribute('aria-selected', 'true');
      expect(await screen.findByRole('button', { name: 'Add a Claude login' })).toBeInTheDocument();
    });

    it('opens the Projects list with its row actions from the URL and counts loaded projects', async () => {
      fx.remotesData = [READY];
      renderSection('/?tab=projects');

      const list = await screen.findByRole('list', { name: 'Projects' });
      expect(screen.getByRole('tab', { name: /^Projects/ })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(screen.getByRole('tab', { name: /^Projects/ })).toHaveTextContent('Projects2');
      const row = within(list).getByRole('listitem', { name: 'Project One' });
      await userEvent.click(within(row).getByRole('button', { name: 'Connect' }));
      expect(
        await screen.findByRole('dialog', { name: 'Connect Project One' }),
      ).toBeInTheDocument();
      expect(new URLSearchParams(fx.search).get('tab')).toBe('projects');
    });

    describe('first-run checklist', () => {
      it('checks this PC, points at the VMs tab and keeps Connect disabled', async () => {
        fx.remotesData = [];
        fx.readiness = {
          ...fx.readiness,
          syncthing: { ok: false, version: null, message: 'Syncthing was not found on PATH.' },
        };
        renderSection();

        const checklist = await screen.findByRole('list', { name: 'Get started' });
        const pcCheck = await within(checklist).findByRole('list', { name: 'PC check' });
        await waitFor(() =>
          expect(pcCheck).toHaveTextContent('Syncthing: not readySyncthing was not found on PATH.'),
        );
        expect(pcCheck).toHaveTextContent('Account and home folder: ready');
        const connect = within(checklist).getByRole('button', { name: 'Connect a project' });
        expect(connect).toBeDisabled();
        expect(within(checklist).getByText('Available once a VM is ready.')).toBeInTheDocument();

        const readinessCalls = () =>
          fx.mockFetch.mock.calls.filter(([url]) => url === '/api/remotes/readiness').length;
        const before = readinessCalls();
        await userEvent.click(within(checklist).getByRole('button', { name: 'Check again' }));
        await waitFor(() => expect(readinessCalls()).toBe(before + 1));

        await userEvent.click(within(checklist).getByRole('button', { name: 'Go to VMs' }));
        expect(fx.search).toContain('tab=vms');
      });

      it('marks Add a VM done and keeps the checklist until a project binds', async () => {
        // lab-vm exists but is not set up, and no project is bound to any VM.
        renderSection();

        const checklist = await screen.findByRole('list', { name: 'Get started' });
        // The done mark is a visually hidden suffix on the step title.
        expect(
          within(checklist).getByText((_, element) => element?.textContent === 'Add a VM: done'),
        ).toBeInTheDocument();
        expect(within(checklist).getByRole('button', { name: 'Connect a project' })).toBeDisabled();

        // The first binding, in any state, ends the first-run checklist.
        fx.bindingsData = [{ projectId: 'p1', remoteId: 'r1', state: 'attaching' }];
        act(() => fx.messageHandler?.({ topic: 'remotes', type: 'changed', payload: {}, ts: '' }));
        await waitFor(() =>
          expect(screen.queryByRole('list', { name: 'Get started' })).not.toBeInTheDocument(),
        );
      });

      it('opens Connect from step 3 once a VM is ready, with that VM chosen', async () => {
        fx.remotesData = [READY];
        renderSection();

        const checklist = await screen.findByRole('list', { name: 'Get started' });
        await userEvent.click(within(checklist).getByRole('button', { name: 'Connect a project' }));

        const dialog = await screen.findByRole('dialog', { name: 'Connect a project to lab-vm' });
        const vms = within(dialog).getByRole('group', { name: 'VM' });
        expect(within(vms).getByRole('button', { name: 'lab-vm' })).toHaveAttribute(
          'aria-pressed',
          'true',
        );
      });
    });

    describe('Needs attention', () => {
      it('says so when nothing needs attention', async () => {
        renderSection();
        expect(await screen.findByText('Nothing needs attention.')).toBeInTheDocument();
      });

      it('opens the Activity detail of a stopped operation', async () => {
        fx.remotesData = [READY];
        fx.operationsData = [hostOperation('update_host', 'failed', 'No disk.')];
        renderSection();

        const list = await screen.findByRole('list', { name: 'Needs attention' });
        const item = await within(list).findByText(
          'Update of lab-vm stopped at “Install the new version”: No disk.',
        );
        await userEvent.click(within(item.closest('li')!).getByRole('button', { name: 'Open' }));
        expect(await screen.findByRole('dialog', { name: 'Update · lab-vm' })).toBeInTheDocument();
      });

      it('reports Syncthing this PC cannot use while a VM exists', async () => {
        fx.readiness = {
          ...fx.readiness,
          syncthing: { ok: false, version: null, message: 'Install Syncthing v2' },
        };
        renderSection();
        expect(
          await screen.findByText('Syncthing is not usable on this PC: Install Syncthing v2.'),
        ).toBeInTheDocument();
      });

      it('shows View for a VM that runs another version, opening its drawer on the VMs tab', async () => {
        fx.remotesData = [{ ...READY, version: '0.22.0', versionMatches: false }];
        renderSection();

        const text = await screen.findByText(
          /^lab-vm runs DevChain 0\.22\.0\. This PC runs 0\.23\.4\./,
        );
        await userEvent.click(within(text.closest('li')!).getByRole('button', { name: 'View' }));
        // Overview stays read-only: the button only moves to the VM, not to Update.
        expect(fx.search).toContain('tab=vms');
        expect(fx.search).toContain('vm=r1');
        const drawer = await screen.findByRole('dialog', { name: 'lab-vm' });
        expect(within(drawer).getByRole('button', { name: 'Update' })).toBeInTheDocument();
        expect(fx.mockFetch).not.toHaveBeenCalledWith(
          '/api/remotes/r1/update',
          expect.objectContaining({ method: 'POST' }),
        );
      });

      it('shows View for a stopped VM that holds projects, without powering it on', async () => {
        fx.remotesData = [{ ...MANAGED, online: false, powerState: 'stopped' }];
        fx.bindingsData = [{ projectId: 'p1', remoteId: 'r1', state: 'remote' }];
        renderSection();

        const text = await screen.findByText('lab-vm is powered off. 1 project waits for it.');
        await userEvent.click(within(text.closest('li')!).getByRole('button', { name: 'View' }));
        expect(fx.search).toContain('tab=vms');
        const drawer = await screen.findByRole('dialog', { name: 'lab-vm' });
        expect(within(drawer).getByRole('button', { name: 'Power on' })).toBeInTheDocument();
        expect(fx.mockFetch).not.toHaveBeenCalledWith('/api/remotes/r1/power-on', {
          method: 'POST',
        });
      });
    });

    describe('Overview VM summary', () => {
      it('lists each VM with its status; a line opens the VMs tab with the drawer', async () => {
        fx.remotesData = [READY, { ...REMOTE, id: 'r2', name: 'side-vm' }];
        fx.bindingsData = [{ projectId: 'p1', remoteId: 'r1', state: 'remote' }];
        renderSection();

        const summary = within(await screen.findByRole('list', { name: 'VMs' }));
        expect(summary.getByRole('button', { name: 'lab-vm' })).toBeInTheDocument();
        expect(summary.getByRole('button', { name: 'side-vm' })).toBeInTheDocument();
        expect(summary.getByText('Ready')).toBeInTheDocument();

        await userEvent.click(summary.getByRole('button', { name: 'side-vm' }));
        expect(fx.search).toContain('tab=vms');
        expect(fx.search).toContain('vm=r2');
        expect(await screen.findByRole('dialog', { name: 'side-vm' })).toBeInTheDocument();
      });

      it('hides the summary while the checklist shows', async () => {
        renderSection();

        expect(await screen.findByRole('list', { name: 'Get started' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Manage VMs' })).not.toBeInTheDocument();
        expect(screen.queryByRole('list', { name: 'VMs' })).not.toBeInTheDocument();
        expect(screen.queryByRole('list', { name: 'Projects on VMs' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Manage projects' })).not.toBeInTheDocument();
      });

      it('Manage VMs opens the VMs tab once a project is bound', async () => {
        fx.bindingsData = [{ projectId: 'p1', remoteId: 'r1', state: 'remote' }];
        renderSection();

        expect(screen.queryByRole('list', { name: 'Get started' })).not.toBeInTheDocument();
        await userEvent.click(await screen.findByRole('button', { name: 'Manage VMs' }));
        expect(fx.search).toContain('tab=vms');
        expect(await screen.findByRole('button', { name: 'Add VM' })).toBeInTheDocument();
      });

      it('renders no summary while the VM list or the bindings still load', async () => {
        fx.bindingsData = [{ projectId: 'p1', remoteId: 'r1', state: 'remote' }];
        const serve = fx.mockFetch.getMockImplementation()!;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        fx.mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
          if (url === '/api/remotes' || url === '/api/remotes/bindings') await gate;
          return serve(url, init);
        });
        renderSection();

        expect(screen.queryByRole('button', { name: 'Manage VMs' })).not.toBeInTheDocument();
        expect(screen.queryByRole('list', { name: 'VMs' })).not.toBeInTheDocument();
        expect(screen.queryByRole('list', { name: 'Get started' })).not.toBeInTheDocument();
        expect(screen.queryByRole('list', { name: 'Projects on VMs' })).not.toBeInTheDocument();

        await act(async () => release());
        expect(await screen.findByRole('button', { name: 'Manage VMs' })).toBeInTheDocument();
      });
    });

    describe('Overview project summary', () => {
      it('lists only on-VM projects by name with VM and status, and opens the VM drawer', async () => {
        fx.remotesData = [READY];
        fx.allProjects = [
          { id: 'p2', name: 'Zulu', rootPath: '/tmp/p2', workspaceId: 'w1' },
          { id: 'p1', name: 'Alpha', rootPath: '/tmp/p1', workspaceId: 'w1' },
          { id: 'p3', name: 'Local', rootPath: '/tmp/p3', workspaceId: 'w1' },
          { id: 'p4', name: 'Failed', rootPath: '/tmp/p4', workspaceId: 'w1' },
        ];
        fx.bindingsData = [
          { projectId: 'p2', remoteId: 'r1', state: 'attaching' },
          { projectId: 'p1', remoteId: 'r1', state: 'remote' },
          { projectId: 'p4', remoteId: 'r1', state: 'failed' },
        ];
        fx.operationsData = [{ ...makeOperation(), projectId: 'p2' }];
        renderSection();

        const list = await screen.findByRole('list', { name: 'Projects on VMs' });
        const rows = within(list).getAllByRole('listitem');
        expect(rows).toHaveLength(2);
        expect(rows[0]).toHaveTextContent('Alpha');
        expect(rows[0]).toHaveTextContent('On lab-vm');
        expect(rows[1]).toHaveTextContent('Zulu');
        expect(rows[1]).toHaveTextContent('Connecting to lab-vm');
        expect(within(list).queryByText('Local')).not.toBeInTheDocument();
        expect(within(list).queryByText('Failed')).not.toBeInTheDocument();
        expect(screen.queryByRole('list', { name: 'Projects' })).not.toBeInTheDocument();

        await userEvent.click(within(rows[1]).getByRole('button', { name: 'lab-vm' }));
        expect(new URLSearchParams(fx.search).get('tab')).toBe('vms');
        expect(new URLSearchParams(fx.search).get('vm')).toBe('r1');
        expect(await screen.findByRole('dialog', { name: 'lab-vm' })).toBeInTheDocument();
      });

      it('Manage projects opens the Projects tab and its working list', async () => {
        fx.remotesData = [READY];
        fx.bindingsData = [{ projectId: 'p1', remoteId: 'r1', state: 'remote' }];
        renderSection();

        await userEvent.click(await screen.findByRole('button', { name: 'Manage projects' }));
        expect(new URLSearchParams(fx.search).get('tab')).toBe('projects');
        expect(await screen.findByRole('list', { name: 'Projects' })).toBeInTheDocument();
        const row = await projectRow('Project One');
        expect(within(row).getByRole('button', { name: 'Disconnect' })).toBeEnabled();
      });

      it('hides the card when all bindings failed and projects stay on this PC', async () => {
        fx.bindingsData = [{ projectId: 'p1', remoteId: 'r1', state: 'failed' }];
        renderSection();

        await screen.findByRole('button', { name: 'Manage VMs' });
        expect(screen.queryByRole('list', { name: 'Projects on VMs' })).not.toBeInTheDocument();
      });
    });

    describe('VM rows', () => {
      it.each<[string, TestRemote, RemoteOperationDto[], string, string[]]>([
        ['2 busy', READY, [hostOperation('claim', 'running')], 'Setting up', ['View']],
        ['4 not set up', REMOTE, [], 'Not set up', ['Set up']],
        ['11 ready', READY, [], 'Ready', []],
      ])(
        'row %s shows its label and at most one next step',
        async (_row, remote, operations, label, next) => {
          fx.remotesData = [remote];
          fx.operationsData = operations;
          renderSection();

          const row = await vmRow('lab-vm');
          await waitFor(() => expect(row).toHaveTextContent(label));
          expect(actionButtons(row)).toEqual(next);
        },
      );

      it.each([
        ['View', 'running', 'Set up · lab-vm'],
        ['Resolve', 'failed', 'Set up · lab-vm'],
      ] as const)('opens Activity from %s', async (button, state, title) => {
        fx.remotesData = [READY];
        fx.operationsData = [{ ...hostOperation('claim', state), steps: makeOperation().steps }];
        renderSection();

        await userEvent.click(within(await vmRow('lab-vm')).getByRole('button', { name: button }));
        expect(await screen.findByRole('dialog', { name: title })).toBeInTheDocument();
      });

      it('opens the Activity of a running project operation from its chip', async () => {
        fx.remotesData = [READY];
        fx.operationsData = [makeOperation()];
        renderSection();

        const row = await vmRow('lab-vm');
        await userEvent.click(
          await within(row).findByRole('button', { name: 'Connecting Project One, 1/2' }),
        );
        expect(
          await screen.findByRole('dialog', { name: 'Connect · Project One' }),
        ).toBeInTheDocument();
      });

      it('shows where the VM runs, its projects and when it was last seen', async () => {
        fx.providerConnectionsData = [PROXMOX_CONNECTION];
        fx.remotesData = [{ ...MANAGED, online: false, powerState: 'unknown' }];
        fx.bindingsData = [
          { projectId: 'p1', remoteId: 'r1', state: 'remote' },
          { projectId: 'p2', remoteId: 'r1', state: 'remote' },
        ];
        renderSection();

        const row = await vmRow('lab-vm');
        await waitFor(() =>
          expect(row).toHaveTextContent('Proxmox · Proxmox lab · https://10.0.0.5:4000'),
        );
        expect(row).toHaveTextContent('2 projects');
        expect(row).toHaveTextContent('Last seen');
        expect(within(row).queryByTestId('remote-metrics-strip')).not.toBeInTheDocument();
      });

      it.each<{
        name: string;
        remotes: TestRemote[];
        rows: Array<{ name: string; text: string; absent: string }>;
        drawerAddress: boolean;
      }>([
        {
          name: 'own VM user',
          remotes: [{ ...READY, userName: 'devchain' }],
          rows: [{ name: 'lab-vm', text: 'devchain@10.0.0.5', absent: 'https://10.0.0.5:4000' }],
          drawerAddress: true,
        },
        {
          name: 'Proxmox VM user',
          remotes: [{ ...MANAGED, userName: 'devchain', online: false, powerState: 'unknown' }],
          rows: [
            {
              name: 'lab-vm',
              text: 'Proxmox · Proxmox lab · devchain@10.0.0.5',
              absent: 'https://10.0.0.5:4000',
            },
          ],
          drawerAddress: false,
        },
        {
          name: 'no user or address',
          remotes: [REMOTE, { ...MANAGED, id: 'r2', name: 'build-vm', baseUrl: null }],
          rows: [
            { name: 'lab-vm', text: 'https://10.0.0.5:4000', absent: '@10.0.0.5' },
            { name: 'build-vm', text: 'Proxmox · Proxmox lab', absent: '@' },
          ],
          drawerAddress: false,
        },
      ])('shows the VM row address: $name', async ({ remotes, rows, drawerAddress }) => {
        fx.providerConnectionsData = [PROXMOX_CONNECTION];
        fx.remotesData = remotes;
        renderSection();
        for (const expected of rows) {
          const row = await vmRow(expected.name);
          await waitFor(() => expect(row).toHaveTextContent(expected.text));
          expect(row).not.toHaveTextContent(expected.absent);
        }
        if (drawerAddress) {
          await userEvent.click(
            within(await vmRow('lab-vm')).getByRole('button', { name: 'lab-vm' }),
          );
          const drawer = await screen.findByRole('dialog', { name: 'lab-vm' });
          expect(within(drawer).getByLabelText('Address')).toHaveTextContent(
            'https://10.0.0.5:4000',
          );
        }
      });
    });

    describe('VM menu', () => {
      it('lists every item that applies to a ready managed VM', async () => {
        fx.remotesData = [MANAGED];
        renderSection();
        expect(await openVmMenu('lab-vm')).toEqual([
          'Reset API key',
          'Connect a project',
          'Change logins',
          'Install Docker',
          'Rename',
          'View details',
          'Reset VM',
          'Remove',
          'Destroy VM',
        ]);
      });

      it('offers Update for another version and no managed-VM items for an address VM', async () => {
        fx.remotesData = [{ ...READY, versionMatches: false }];
        renderSection();
        expect(await openVmMenu('lab-vm')).toEqual([
          'Reset API key',
          'Install Docker',
          'Update',
          'Rename',
          'View details',
          'Remove',
        ]);
      });

      it('hides items that start a host operation while one runs', async () => {
        fx.remotesData = [MANAGED];
        fx.operationsData = [hostOperation('update_host', 'running')];
        renderSection();
        expect(await openVmMenu('lab-vm')).toEqual(['Rename', 'View details', 'Remove']);
      });

      it.each([
        { online: false, apiKeyRejected: false },
        { online: true, apiKeyRejected: true },
      ])('hides Reset API key when the VM is unavailable: %j', async (state) => {
        fx.remotesData = [{ ...MANAGED, ...state }];
        renderSection();
        expect(await openVmMenu('lab-vm')).not.toContain('Reset API key');
      });

      it('opens the details drawer from View details', async () => {
        fx.remotesData = [READY];
        renderSection();
        await pickVmMenu('lab-vm', 'View details');
        expect(fx.search).toContain('vm=r1');
        expect(await screen.findByRole('dialog', { name: 'lab-vm' })).toBeInTheDocument();
      });

      it('renames a VM', async () => {
        fx.remotesData = [READY];
        renderSection();
        await pickVmMenu('lab-vm', 'Rename');

        const dialog = await screen.findByRole('dialog', { name: 'Rename lab-vm' });
        await userEvent.clear(within(dialog).getByLabelText('Name'));
        await userEvent.type(within(dialog).getByLabelText('Name'), 'renamed-vm');
        await userEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));

        expect(await vmRow('renamed-vm')).toBeInTheDocument();
        expect(fx.mockFetch).toHaveBeenCalledWith(
          '/api/remotes/r1',
          expect.objectContaining({
            method: 'PATCH',
            body: JSON.stringify({ name: 'renamed-vm' }),
          }),
        );
        expect(toastSpy).toHaveBeenCalledWith(
          expect.objectContaining({ title: 'VM renamed', description: 'It is now renamed-vm.' }),
        );
      });

      it('shows a refused rename once in the dialog, and the next submit replaces the message', async () => {
        fx.remotesData = [READY];
        renderSection();
        const serve = fx.mockFetch.getMockImplementation()!;
        let refusal = 'A VM named build-vm exists.';
        fx.mockFetch.mockImplementation(async (url: string, init?: RequestInit) =>
          init?.method === 'PATCH' && refusal
            ? ({
                ok: false,
                status: 409,
                json: async () => ({ statusCode: 409, message: refusal }),
              } as Response)
            : serve(url, init),
        );
        await pickVmMenu('lab-vm', 'Rename');
        const dialog = await screen.findByRole('dialog', { name: 'Rename lab-vm' });
        const name = within(dialog).getByLabelText('Name');

        await userEvent.clear(name);
        await userEvent.type(name, 'build-vm');
        await userEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));

        expect(await within(dialog).findByRole('alert')).toHaveTextContent(
          'A VM named build-vm exists.',
        );
        expect(screen.getByRole('dialog', { name: 'Rename lab-vm' })).toBeInTheDocument();
        expect(toastSpy).not.toHaveBeenCalled();

        refusal = 'That name is reserved.';
        await userEvent.clear(name);
        await userEvent.type(name, 'other-vm');
        await userEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));

        expect(await within(dialog).findByRole('alert')).toHaveTextContent(
          'That name is reserved.',
        );
        expect(within(dialog).queryByText('A VM named build-vm exists.')).not.toBeInTheDocument();
        expect(toastSpy).not.toHaveBeenCalled();
      });
    });

    describe('Power on', () => {
      afterEach(() => jest.useRealTimers());

      it('reads "Starting…" while the request runs, "Starting" for 3 minutes, then "Not answering"', async () => {
        jest.useFakeTimers({ advanceTimers: true });
        const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
        fx.remotesData = [{ ...MANAGED, online: false, powerState: 'stopped' }];
        let release!: () => void;
        fx.powerOnGate = new Promise<void>((resolve) => {
          release = resolve;
        });
        renderSection();

        const row = await vmRow('lab-vm');
        await user.click(await within(row).findByRole('button', { name: 'Power on' }));
        expect(within(row).getByRole('button', { name: 'Starting…' })).toBeDisabled();
        expect(fx.mockFetch).toHaveBeenCalledWith('/api/remotes/r1/power-on', { method: 'POST' });

        await act(async () => release());
        await waitFor(() =>
          expect(within(row).queryByRole('button', { name: 'Starting…' })).not.toBeInTheDocument(),
        );
        expect(within(row).getByText('Starting')).toBeInTheDocument();

        await act(async () => {
          jest.advanceTimersByTime(POWER_ON_GRACE_MS);
        });
        await waitFor(() => expect(within(row).getByText('Not answering')).toBeInTheDocument());
      });
    });
  });
});

describe('RemoteVmSection.drawer', () => {
  const READY: TestRemote = {
    ...REMOTE,
    online: true,
    version: '0.23.4',
    versionMatches: true,
    lastSeenAt: '2026-09-28T10:00:00.000Z',
    homePath: '/home/devchain',
    homePathMatches: true,
    logins: { codex: { choice: 'reuse', entryIds: ['e1'] } },
  };
  const MANAGED: TestRemote = {
    ...READY,
    kind: 'proxmox',
    vmProviderConnectionId: 'pc1',
    vmIdentity: '12345678-1234-1234-1234-123456789abc',
    vmSpec: { cores: 2, memory: 4096, disk: 30 },
  };

  /** A project of the second workspace, bound to lab-vm; the selected workspace lacks it. */
  function bindSideProject() {
    fx.workspaces = [...fx.workspaces, { id: 'w2', name: 'Side', isDefault: false }];
    fx.allProjects = [
      ...fx.allProjects,
      { id: 'p3', name: 'Side Project', rootPath: '/tmp/p3', workspaceId: 'w2' },
    ];
    fx.bindingsData = [{ projectId: 'p3', remoteId: 'r1', state: 'remote' }];
  }

  function hostOperation(
    id: string,
    kind: string,
    state: RemoteOperationDto['state'],
    createdAt = '2026-09-27T00:00:00.000Z',
  ): RemoteOperationDto {
    return {
      ...makeOperation(),
      id,
      kind,
      projectId: null,
      state,
      createdAt,
      steps: [{ id: 'step', label: 'Do the work', state, error: null }],
    } as RemoteOperationDto;
  }

  const drawer = () => screen.findByRole('dialog', { name: 'lab-vm' });

  describe('RemoteVmSection VM details drawer', () => {
    it('opens from the URL and row name, and clears the URL on Close or Escape', async () => {
      fx.remotesData = [READY];
      renderSection('/?vm=r1');

      const panel = await drawer();
      expect(within(panel).getByText('Ready')).toBeInTheDocument();
      await userEvent.click(within(panel).getByRole('button', { name: 'Close details' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(fx.search).not.toContain('vm=');
      await userEvent.click(within(await vmRow('lab-vm')).getByRole('button', { name: 'lab-vm' }));
      expect(await drawer()).toBeInTheDocument();
      expect(fx.search).toContain('vm=r1');
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(fx.search).not.toContain('vm=');
    });

    it('renames the VM in place', async () => {
      fx.remotesData = [READY];
      renderSection('/?vm=r1');

      const panel = await drawer();
      await userEvent.click(within(panel).getByRole('button', { name: 'Rename' }));
      const name = within(panel).getByLabelText('Name');
      await userEvent.clear(name);
      await userEvent.type(name, 'build-vm');
      await userEvent.click(within(panel).getByRole('button', { name: 'Save' }));

      expect(await screen.findByRole('dialog', { name: 'build-vm' })).toBeInTheDocument();
      expect(fx.mockFetch).toHaveBeenCalledWith(
        '/api/remotes/r1',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'build-vm' }) }),
      );
    });

    it('shows a refused rename under the name', async () => {
      fx.remotesData = [READY];
      renderSection('/?vm=r1');
      const serve = fx.mockFetch.getMockImplementation()!;
      fx.mockFetch.mockImplementation(async (url: string, init?: RequestInit) =>
        init?.method === 'PATCH'
          ? ({
              ok: false,
              status: 409,
              json: async () => ({ statusCode: 409, message: 'A VM named build-vm exists.' }),
            } as Response)
          : serve(url, init),
      );

      const panel = await drawer();
      await userEvent.click(within(panel).getByRole('button', { name: 'Rename' }));
      await userEvent.clear(within(panel).getByLabelText('Name'));
      await userEvent.type(within(panel).getByLabelText('Name'), 'build-vm');
      await userEvent.click(within(panel).getByRole('button', { name: 'Save' }));

      expect(await within(panel).findByRole('alert')).toHaveTextContent(
        'A VM named build-vm exists.',
      );
      expect(within(panel).getByLabelText('Name')).toHaveValue('build-vm');
      expect(toastSpy).not.toHaveBeenCalled();
    });

    it("shows the VM's facts on Overview, the home folder from the VM list included", async () => {
      fx.remotesData = [
        {
          ...MANAGED,
          versionMatches: false,
          version: '0.22.0',
          homePath: '/home/other',
          homePathMatches: false,
          docker: { installed: true, userInGroup: false },
          uid: 1000,
          gid: 1001,
        } as TestRemote,
      ];
      renderSection('/?vm=r1');

      const panel = await drawer();
      expect(within(panel).getByLabelText('Address')).toHaveTextContent('https://10.0.0.5:4000');
      expect(within(panel).getByLabelText('DevChain version')).toHaveTextContent(
        '0.22.0 · differs from this PC',
      );
      expect(within(panel).getByLabelText('Size')).toHaveTextContent(
        '2 cores · 4 GiB memory · 30 GiB disk',
      );
      expect(within(panel).getByLabelText('Docker')).toHaveTextContent(
        'Installed · restart DevChain to use it',
      );
      expect(within(panel).getByLabelText('uid and gid')).toHaveTextContent('1000 / 1001');
      expect(within(panel).getByLabelText('Home folder')).toHaveTextContent(
        '/home/other · differs from this PC',
      );
      expect(within(panel).getByLabelText('Last seen')).toHaveTextContent('Now');
      // The next step comes from the status model.
      expect(within(panel).getByRole('button', { name: 'Update' })).toBeInTheDocument();
    });

    it("shows each provider CLI's version and state, and Antigravity from the claim", async () => {
      fx.remotesData = [
        {
          ...READY,
          providerClis: {
            claude: {
              desiredVersion: 'latest',
              installedVersion: '2.1.281',
              state: 'idle',
              error: null,
              checkedAt: '2026-09-28T09:00:00.000Z',
            },
            codex: {
              desiredVersion: 'latest',
              installedVersion: '0.156.1',
              state: 'installing',
              error: null,
              checkedAt: '2026-09-28T09:00:00.000Z',
            },
            copilot: {
              desiredVersion: 'latest',
              installedVersion: '1.0.88',
              state: 'failed',
              error: 'npm 404',
              checkedAt: '2026-09-28T09:00:00.000Z',
            },
          },
          cliVersions: { agy: '1.2.3' },
        } as TestRemote,
      ];
      renderSection('/?vm=r1');

      const panel = await drawer();
      const clis = within(panel).getByLabelText('Provider CLIs');
      expect(clis).toHaveTextContent('Claude');
      expect(clis).toHaveTextContent('2.1.281');
      expect(clis).toHaveTextContent('Codex');
      expect(clis).toHaveTextContent('0.156.1');
      expect(clis).toHaveTextContent('Installing');
      expect(clis).toHaveTextContent('Copilot');
      expect(clis).toHaveTextContent('Failed: npm 404');
      expect(clis).toHaveTextContent('OpenCode');
      expect(clis).toHaveTextContent('No report yet');
      expect(clis).toHaveTextContent('Antigravity');
      expect(clis).toHaveTextContent('1.2.3');
      expect(clis).not.toHaveTextContent('stale');
    });

    it("marks an offline VM's provider CLI values as its last known ones", async () => {
      fx.remotesData = [
        {
          ...READY,
          online: false,
          providerClis: {
            claude: {
              desiredVersion: 'latest',
              installedVersion: '2.1.281',
              state: 'idle',
              error: null,
              checkedAt: '2026-09-28T09:00:00.000Z',
            },
          },
          cliVersions: { agy: '1.2.3' },
        } as TestRemote,
      ];
      renderSection('/?vm=r1');

      const panel = await drawer();
      const clis = within(panel).getByLabelText('Provider CLIs');
      expect(clis).toHaveTextContent('2.1.281 (stale)');
      expect(clis).toHaveTextContent('1.2.3 (stale)');
      const staleValues = within(clis).getAllByTitle('Offline — last known version');
      expect(staleValues).toHaveLength(2);
    });

    it("offers Set up for a VM this PC has not set up, with the VM's host", async () => {
      fx.probeResult = {
        kind: 'installer',
        bootstrapUrl: 'https://10.0.0.5:3000',
        state: 'unclaimed',
        imageVersion: '0.1.2',
        supported: true,
        remoteId: 'r1',
      };
      renderSection('/?vm=r1');

      await userEvent.click(within(await drawer()).getByRole('button', { name: 'Set up' }));
      const flow = await screen.findByRole('dialog', { name: 'Add your own VM' });
      expect(within(flow).getByLabelText('VM address')).toHaveValue('10.0.0.5');
      await waitFor(() =>
        expect(fx.probeBodies).toEqual([{ address: '10.0.0.5', checkSsh: true }]),
      );
    });

    it("names another workspace's project in the drawer and in the Reset and Destroy dialogs", async () => {
      fx.remotesData = [MANAGED];
      bindSideProject();
      renderSection('/?vm=r1');

      const panel = await drawer();
      await userEvent.click(within(panel).getByRole('tab', { name: 'Projects (1)' }));
      const row = within(panel).getByRole('listitem', { name: 'Side Project' });
      expect(row).toHaveTextContent('On lab-vm');
      expect(within(row).getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();

      await userEvent.click(within(panel).getByRole('tab', { name: 'Overview' }));
      const danger = within(panel).getByRole('region', { name: 'Danger zone' });
      expect(
        within(danger)
          .getAllByRole('button')
          .map((button) => button.textContent),
      ).toEqual(['Reset VM', 'Remove', 'Destroy VM']);

      await userEvent.click(within(danger).getByRole('button', { name: 'Reset VM' }));
      const reset = await screen.findByRole('dialog', { name: 'Reset lab-vm?' });
      expect(reset).toHaveTextContent('Side Project');
      expect(reset).not.toHaveTextContent('p3');
      await userEvent.click(within(reset).getByRole('button', { name: 'Cancel' }));

      await userEvent.click(within(await drawer()).getByRole('button', { name: 'Destroy VM' }));
      const destroy = await screen.findByRole('dialog', { name: 'Delete lab-vm?' });
      expect(
        within(destroy).getByRole('list', { name: 'Projects connected to this VM' }),
      ).toHaveTextContent('Side Project');
    });

    it('lists the recorded logins by their vault labels and offers Change logins', async () => {
      fx.remotesData = [
        {
          ...READY,
          logins: {
            codex: { choice: 'reuse', entryIds: ['e1'] },
            opencode: { choice: 'generate', entryIds: [] },
            claude: { choice: 'skip', entryIds: [] },
            agy: { choice: 'reuse', entryIds: ['gone'] },
          },
        },
      ];
      fx.loginEntries = [
        {
          id: 'e1',
          provider: 'codex',
          kind: 'family',
          label: 'Lab family',
          payloadKind: 'files',
          checkedOutRemoteId: 'r1',
          createdAt: '2026-09-24T00:00:00.000Z',
          updatedAt: '2026-09-24T00:00:00.000Z',
          lastVerifiedAt: null,
          lastWritebackAt: null,
        },
      ];
      renderSection('/?vm=r1');

      const panel = await drawer();
      await userEvent.click(within(panel).getByRole('tab', { name: 'Logins' }));
      await waitFor(() =>
        expect(within(panel).getByLabelText('Codex')).toHaveTextContent('Lab family'),
      );
      expect(within(panel).getByLabelText('OpenCode')).toHaveTextContent('New login');
      expect(within(panel).getByLabelText('Claude')).toHaveTextContent('None');
      expect(within(panel).getByLabelText('Copilot')).toHaveTextContent('None');
      expect(within(panel).getByLabelText('Antigravity')).toHaveTextContent('A deleted login');

      const tab = within(panel).getByRole('tabpanel');
      await userEvent.click(within(tab).getByRole('button', { name: 'Change logins' }));
      expect(
        await screen.findByRole('dialog', { name: 'Change logins for lab-vm' }),
      ).toBeInTheDocument();
    });

    it("lists this VM's operations and opens one in Activity", async () => {
      fx.remotesData = [READY];
      fx.operationsData = [
        hostOperation('update-op', 'update_host', 'running', '2026-09-28T00:00:00.000Z'),
        hostOperation('setup-op', 'claim', 'done', '2026-09-20T00:00:00.000Z'),
        { ...hostOperation('other-op', 'update_host', 'running'), remoteId: 'r2' },
      ];
      renderSection('/?vm=r1');

      const panel = await drawer();
      await userEvent.click(within(panel).getByRole('tab', { name: 'Activity' }));
      const runningGroup = await within(panel).findByRole('region', { name: 'Running' });
      expect(within(runningGroup).getAllByRole('listitem')).toHaveLength(1);
      expect(within(panel).getByRole('region', { name: 'Finished' })).toHaveTextContent(
        'Set up · lab-vm',
      );

      await userEvent.click(within(runningGroup).getByRole('button', { name: /Update · lab-vm/ }));
      expect(await screen.findByRole('dialog', { name: 'Update · lab-vm' })).toBeInTheDocument();
    });

    it('orders Finished by end time, as the Activity dialog does', async () => {
      fx.remotesData = [READY];
      // The Set up started first and finished last; the Update started last and finished first.
      fx.operationsData = [
        {
          ...hostOperation('short-update', 'update_host', 'done', '2026-09-27T00:00:00.000Z'),
          updatedAt: '2026-09-27T06:00:00.000Z',
        },
        {
          ...hostOperation('long-setup', 'claim', 'done', '2026-09-20T00:00:00.000Z'),
          updatedAt: '2026-09-28T12:00:00.000Z',
        },
      ];
      renderSection('/?vm=r1');

      const panel = await drawer();
      await userEvent.click(within(panel).getByRole('tab', { name: 'Activity' }));
      const finished = within(panel).getByRole('region', { name: 'Finished' });
      const drawerOrder = within(finished)
        .getAllByRole('button')
        .map((button) => button.textContent ?? '');
      expect(drawerOrder[0]).toContain('Set up · lab-vm');
      expect(drawerOrder[1]).toContain('Update · lab-vm');

      // The open drawer hides the page behind it, so close it before opening Activity.
      await userEvent.keyboard('{Escape}');
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: 'lab-vm' })).not.toBeInTheDocument(),
      );
      await userEvent.click(screen.getByRole('button', { name: 'Activity' }));
      const activity = await screen.findByRole('dialog', { name: 'Activity' });
      const activityOrder = within(within(activity).getByRole('region', { name: 'Finished' }))
        .getAllByRole('button')
        .map((button) => button.textContent ?? '');
      expect(activityOrder).toEqual(drawerOrder);
    });

    // UI layer: the sign is derived only from the list item, so rendering the section covers it.
    describe('connection security', () => {
      const FINGERPRINT = '0123456789ABCDEF'.repeat(4);
      const COLON_FINGERPRINT = FINGERPRINT.match(/.{2}/g)!.join(':');
      const PINNED = 'Encrypted (TLS) · certificate pinned';
      const NO_CERTIFICATE = 'No certificate · add the VM again or reset it';

      it.each([
        {
          name: 'online pinned',
          remote: { ...READY, tlsFingerprint: FINGERPRINT } as TestRemote,
          connection: PINNED,
          certificate: 'SHA-256 ' + COLON_FINGERPRINT,
        },
        {
          name: 'offline pinned',
          remote: { ...READY, online: false, tlsFingerprint: FINGERPRINT } as TestRemote,
          connection: 'Certificate pinned · not connected now',
          certificate: COLON_FINGERPRINT,
        },
        {
          name: 'no certificate',
          remote: { ...READY, online: false, tlsFingerprint: null } as TestRemote,
          connection: NO_CERTIFICATE,
          certificate: null,
        },
        {
          name: 'not set up',
          remote: { ...REMOTE, tlsFingerprint: null } as TestRemote,
          connection: null,
          certificate: null,
        },
      ])('renders connection security for $name', async ({ remote, connection, certificate }) => {
        fx.remotesData = [remote];
        renderSection('/?vm=r1');
        const panel = await drawer();
        if (connection === null)
          expect(within(panel).queryByLabelText('Connection')).not.toBeInTheDocument();
        else expect(within(panel).getByLabelText('Connection')).toHaveTextContent(connection);
        if (certificate === null)
          expect(within(panel).queryByLabelText('Certificate')).not.toBeInTheDocument();
        else expect(within(panel).getByLabelText('Certificate')).toHaveTextContent(certificate);
      });

      it('marks each VM row with its connection sign', async () => {
        fx.remotesData = [
          { ...READY, tlsFingerprint: FINGERPRINT } as TestRemote,
          { ...READY, id: 'r2', name: 'old-vm', online: false, tlsFingerprint: null } as TestRemote,
          {
            ...READY,
            id: 'r3',
            name: 'off-vm',
            online: false,
            tlsFingerprint: FINGERPRINT,
          } as TestRemote,
          { ...REMOTE, id: 'r4', name: 'new-vm', tlsFingerprint: null } as TestRemote,
        ];
        renderSection();

        expect(
          within(await vmRow('lab-vm')).getByRole('img', { name: PINNED }),
        ).toBeInTheDocument();
        expect(
          within(await vmRow('old-vm')).getByRole('img', { name: NO_CERTIFICATE }),
        ).toBeInTheDocument();
        for (const name of ['off-vm', 'new-vm']) {
          expect(
            within(await vmRow(name)).queryByRole('img', { name: /certificate/ }),
          ).not.toBeInTheDocument();
        }
      });
    });
  });
});

describe('RemoteVmSection.intent', () => {
  const READY = { ...REMOTE, online: true, versionMatches: true, logins: {} };

  const params = () => new URLSearchParams(fx.search);

  /** The intent keys are gone and the rest of the URL stays. */
  async function expectIntentConsumed(): Promise<void> {
    await waitFor(() => expect(params().has('projectAction')).toBe(false));
    expect(params().has('connectVm')).toBe(false);
    expect(params().get('section')).toBe('remote-vm');
  }

  const vmChoice = (dialog: HTMLElement, name: string) =>
    within(within(dialog).getByRole('group', { name: 'VM' })).getByRole('button', { name });

  // UI integration: the intent needs the page's full project status, which only
  // the mounted section joins from remotes, bindings, projects and operations.
  describe('RemoteVmSection project action intent', () => {
    it('opens Connect for the project with the chosen ready VM', async () => {
      fx.remotesData = [READY, { ...READY, id: 'r2', name: 'second-vm' }];
      renderSection('/?section=remote-vm&projectAction=p1&connectVm=r2');

      const dialog = await screen.findByRole('dialog', { name: 'Connect Project One' });
      expect(vmChoice(dialog, 'second-vm')).toHaveAttribute('aria-pressed', 'true');
      expect(vmChoice(dialog, 'lab-vm')).toHaveAttribute('aria-pressed', 'false');
      await expectIntentConsumed();
    });

    it('opens Disconnect for a project on a VM', async () => {
      fx.remotesData = [READY];
      fx.bindingsData = [{ projectId: 'p1', remoteId: 'r1', state: 'remote' }];
      renderSection('/?section=remote-vm&projectAction=p1');

      expect(
        await screen.findByRole('dialog', { name: 'Disconnect Project One?' }),
      ).toBeInTheDocument();
      await expectIntentConsumed();
    });

    it('opens the Activity detail of a running Connect, and a remount keeps it', async () => {
      fx.remotesData = [READY];
      fx.operationsData = [makeOperation()];
      fx.bindingsData = [{ projectId: 'p1', remoteId: 'r1', state: 'attaching' }];
      const { unmount } = renderSection('/?section=remote-vm&projectAction=p1');

      expect(
        await screen.findByRole('dialog', { name: 'Connect · Project One' }),
      ).toBeInTheDocument();
      await expectIntentConsumed();
      expect(params().get('activity')).toBe('op1');

      unmount();
      renderSection(`/${fx.search}`);
      expect(
        await screen.findByRole('dialog', { name: 'Connect · Project One' }),
      ).toBeInTheDocument();
      expect(params().get('activity')).toBe('op1');
      expect(params().has('projectAction')).toBe(false);
    });

    it('opens the Activity list for a stuck Connect with no known operation', async () => {
      fx.remotesData = [READY];
      fx.bindingsData = [{ projectId: 'p1', remoteId: 'r1', state: 'attaching' }];
      renderSection('/?section=remote-vm&projectAction=p1');

      expect(await screen.findByRole('dialog', { name: 'Activity' })).toBeInTheDocument();
      await expectIntentConsumed();
      expect(params().get('activity')).toBe('list');
    });

    it('only removes the keys for an unknown project', async () => {
      fx.remotesData = [READY];
      renderSection('/?section=remote-vm&projectAction=missing&connectVm=r1');

      await projectRow('Project One');
      await expectIntentConsumed();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it.each([
      ['remotes', (url: string) => url === '/api/remotes'],
      ['bindings', (url: string) => url === '/api/remotes/bindings'],
      ['projects', (url: string) => url.startsWith('/api/projects?limit=')],
      ['operations', (url: string) => url.startsWith('/api/remotes/operations?state=')],
    ])('waits for the %s to load', async (_name, gated) => {
      fx.remotesData = [READY];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const answer = fx.mockFetch.getMockImplementation()!;
      fx.mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
        if (gated(url)) await gate;
        return answer(url, init);
      });
      renderSection('/?section=remote-vm&projectAction=p1&connectVm=r1');

      await waitFor(() => expect(fx.mockFetch.mock.calls.some(([url]) => gated(url))).toBe(true));
      // Every other request has answered by now; only the gated one holds the intent.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(screen.queryByRole('dialog', { name: 'Connect Project One' })).not.toBeInTheDocument();
      expect(params().get('projectAction')).toBe('p1');

      release();
      expect(
        await screen.findByRole('dialog', { name: 'Connect Project One' }),
      ).toBeInTheDocument();
      await expectIntentConsumed();
    });

    it('runs an intent that arrives while the page is already open', async () => {
      fx.remotesData = [READY];
      renderSection('/?section=remote-vm');
      await projectRow('Project One');

      act(() => fx.navigate('/?section=remote-vm&projectAction=p1&connectVm=r1'));

      const dialog = await screen.findByRole('dialog', { name: 'Connect Project One' });
      expect(vmChoice(dialog, 'lab-vm')).toHaveAttribute('aria-pressed', 'true');
      await expectIntentConsumed();
    });

    it('does not reopen a closed dialog on reload', async () => {
      fx.remotesData = [READY];
      const { unmount } = renderSection('/?section=remote-vm&projectAction=p1&connectVm=r1');
      const dialog = await screen.findByRole('dialog', { name: 'Connect Project One' });
      await expectIntentConsumed();

      await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

      unmount();
      renderSection(`/${fx.search}`);
      await projectRow('Project One');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });
});

describe('RemoteVmSection.projects', () => {
  const READY = { ...REMOTE, online: true, versionMatches: true, logins: {} };

  function projectRequests(): string[] {
    return fx.mockFetch.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.startsWith('/api/projects'));
  }

  // UI integration: the project rows join the all-workspace list, the bindings,
  // the operations and each project's newest operation, as the page does.
  describe('RemoteVmSection projects', () => {
    // UI integration is the cheapest layer that joins row availability, dialog saves and the home cache.
    it.each([
      { applied: true, message: 'Applied to the VM and this PC.' },
      {
        applied: false,
        message:
          'Saved, not applied yet: the VM is offline; DevChain applies it automatically while the project stays connected.',
      },
    ])(
      'saves a connected project list, closes and shows its applied=$applied result',
      async (result) => {
        fx.bindingsData = [{ projectId: 'p1', remoteId: 'r1', state: 'remote' }];
        fx.ignoreSaveResult = result;
        renderSection('/?tab=projects');
        const dialog = await openFileSyncSettings('Project One');
        await userEvent.type(
          await within(dialog).findByLabelText('Add a pattern'),
          '/runtime{Enter}',
        );
        await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(dialog).not.toBeInTheDocument());
        expect(toastSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            title: 'File sync settings saved',
            description: result.message,
          }),
        );
        expect(fx.ignorePuts).toEqual([
          { projectId: 'p1', ignores: expect.arrayContaining(['/runtime']) },
        ]);
        const reopened = await openFileSyncSettings('Project One');
        expect(
          await within(reopened).findByRole('button', { name: 'Remove /runtime' }),
        ).toBeInTheDocument();
      },
    );

    it('keeps a saved pattern on the next save while a list read is still held', async () => {
      fx.ignores.p1 = ['/old'];
      const serve = fx.mockFetch.getMockImplementation()!;
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      fx.mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === '/api/file-sync/projects/p1/ignores' && fx.ignorePuts.length > 0) await held;
        return serve(url, init);
      });
      try {
        renderSection('/?tab=projects');
        const dialog = await openFileSyncSettings('Project One');
        await userEvent.type(
          await within(dialog).findByLabelText('Add a pattern'),
          '/first{Enter}',
        );
        await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(dialog).not.toBeInTheDocument());
        const reopened = await openFileSyncSettings('Project One');
        expect(within(reopened).getByRole('button', { name: 'Remove /first' })).toBeInTheDocument();
        await userEvent.type(within(reopened).getByLabelText('Add a pattern'), '/second{Enter}');
        await userEvent.click(within(reopened).getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(fx.ignorePuts).toHaveLength(2));
        expect(fx.ignorePuts[1]).toEqual({
          projectId: 'p1',
          ignores: ['/old', '/first', '/second'],
        });
      } finally {
        release();
      }
    });

    it('restores the stored defaults from the settings dialog', async () => {
      fx.ignores.p1 = ['/runtime'];
      renderSection('/?tab=projects');
      const dialog = await openFileSyncSettings('Project One');
      await userEvent.click(
        await within(dialog).findByRole('button', { name: 'Restore defaults' }),
      );
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(dialog).not.toBeInTheDocument());
      expect(fx.ignorePuts).toEqual([{ projectId: 'p1', ignores: null }]);
      const reopened = await openFileSyncSettings('Project One');
      await within(reopened).findByLabelText('Add a pattern');
      expect(
        within(reopened).queryByRole('button', { name: 'Remove /runtime' }),
      ).not.toBeInTheDocument();
    });

    it('keeps the draft and shows a save error inline', async () => {
      fx.ignoreSaveError = 'Could not save the file list.';
      renderSection('/?tab=projects');
      const dialog = await openFileSyncSettings('Project One');
      await userEvent.type(
        await within(dialog).findByLabelText('Add a pattern'),
        '/runtime{Enter}',
      );
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(fx.ignoreSaveError);
      expect(within(dialog).getByRole('button', { name: 'Remove /runtime' })).toBeInTheDocument();
      expect(toastSpy).not.toHaveBeenCalled();
    });

    it.each(['attaching', 'detaching'])('disables file sync settings while %s', async (state) => {
      fx.bindingsData = [{ projectId: 'p1', remoteId: 'r1', state }];
      fx.operationsData = [
        { ...makeOperation(), kind: state === 'attaching' ? 'attach' : 'detach', state: 'running' },
      ];
      renderSection('/?tab=projects');
      const button = within(await projectRow('Project One')).getByRole('button', {
        name: 'File sync settings',
      });
      await waitFor(() => expect(button).toBeDisabled());
      await userEvent.click(button);
      expect(
        screen.queryByRole('dialog', { name: 'File sync settings · Project One' }),
      ).not.toBeInTheDocument();
    });

    it('lists every workspace from one request without per-project stats', async () => {
      fx.workspaces = [
        { id: 'w1', name: 'Main', isDefault: true },
        { id: 'w2', name: 'Side', isDefault: false },
      ];
      fx.allProjects = [
        ...fx.allProjects,
        { id: 'p3', name: 'Project Three', rootPath: '/tmp/p3', workspaceId: 'w2' },
      ];
      renderSection();

      expect(await projectRow('Project Three')).toHaveTextContent('Side');
      expect(await projectRow('Project One')).toHaveTextContent('Main');
      expect(projectRequests()).toEqual(['/api/projects?limit=1000']);
      expect(screen.queryByText('Showing the first 1,000 projects.')).not.toBeInTheDocument();
    });

    it.each([
      ['View', 'running'],
      ['Resolve', 'failed'],
    ] as const)('opens the Activity of the project from %s', async (button, state) => {
      fx.remotesData = [READY];
      fx.operationsData = [{ ...makeOperation(), state }];
      fx.bindingsData = [{ projectId: 'p1', remoteId: 'r1', state: 'attaching' }];
      renderSection();

      const row = await projectRow('Project One');
      await userEvent.click(await within(row).findByRole('button', { name: button }));
      expect(
        await screen.findByRole('dialog', { name: 'Connect · Project One' }),
      ).toBeInTheDocument();
    });

    it('reports the cleanup error of a cancelled Connect and offers Connect again', async () => {
      fx.remotesData = [READY];
      fx.bindingsData = [{ projectId: 'p1', remoteId: 'r1', state: 'failed' }];
      fx.projectHistory = [
        {
          ...makeOperation(),
          id: 'cancelled-attach',
          state: 'cancelled',
          details: { hostReleaseError: 'The VM refused to release the copy.' },
        },
      ];
      renderSection();

      const row = await projectRow('Project One');
      await waitFor(() =>
        expect(row).toHaveTextContent(
          'Connect cancelled. The copy on lab-vm was not removed.The VM refused to release the copy.',
        ),
      );
      expect(fx.mockFetch).toHaveBeenCalledWith(
        '/api/remotes/operations?projectId=p1&limit=1',
        expect.anything(),
      );
      expect(within(row).getByRole('button', { name: 'Connect' })).toBeEnabled();
      await userEvent.click(screen.getByRole('tab', { name: 'Overview' }));
      expect(
        await screen.findByText(
          'Project One: the copy on lab-vm was not removed. The VM refused to release the copy.',
        ),
      ).toBeInTheDocument();
    });

    it('opens the board of a project in another workspace', async () => {
      fx.workspaces = [
        { id: 'w1', name: 'Main', isDefault: true },
        { id: 'w2', name: 'Side', isDefault: false },
      ];
      fx.allProjects = [
        ...fx.allProjects,
        { id: 'p3', name: 'Project Three', rootPath: '/tmp/p3', workspaceId: 'w2' },
      ];
      const done: RemoteOperationDto = {
        ...makeOperation(),
        projectId: 'p3',
        state: 'done',
        steps: [{ id: 'copy', label: 'Copy project', state: 'done', error: null }],
      };
      fx.operationsData = [done];
      renderSection();
      await projectRow('Project Three');

      await userEvent.click(await screen.findByRole('button', { name: /^Activity/ }));
      const list = await screen.findByRole('dialog', { name: 'Activity' });
      await userEvent.click(within(list).getByRole('button', { name: /^Connect · Project Three/ }));
      const detail = await screen.findByRole('dialog', { name: 'Connect · Project Three' });
      await userEvent.click(within(detail).getByRole('button', { name: 'Open Chat' }));

      const { activateProject } = mockUseSelectedProject.mock.results[0].value;
      expect(activateProject).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'p3', workspaceId: 'w2' }),
      );
    });
  });

  // UI integration: every VM entry point opens the same Connect flow with that VM chosen.
  describe('RemoteVmSection Connect from a VM', () => {
    function sideProject() {
      fx.workspaces = [
        { id: 'w1', name: 'Main', isDefault: true },
        { id: 'w2', name: 'Side', isDefault: false },
      ];
      fx.allProjects = [
        ...fx.allProjects,
        { id: 'p3', name: 'Project Three', rootPath: '/tmp/p3', workspaceId: 'w2' },
      ];
    }

    it('connects a project of another workspace from the VM menu and opens Activity', async () => {
      fx.remotesData = [READY];
      sideProject();
      renderSection();

      await pickVmMenu('lab-vm', 'Connect a project');
      const flow = screen.getByRole('dialog', { name: 'Connect a project to lab-vm' });
      expect(
        within(within(flow).getByRole('group', { name: 'VM' })).getByRole('button', {
          name: 'lab-vm',
        }),
      ).toHaveAttribute('aria-pressed', 'true');
      await userEvent.click(within(flow).getByRole('button', { name: 'Choose Project Three' }));
      await finishConnect(flow);

      expect(
        await screen.findByRole('dialog', { name: 'Connect · Project Three' }),
      ).toBeInTheDocument();
      expect(fx.mockFetch).toHaveBeenCalledWith(
        '/api/remotes/r1/attach',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ projectId: 'p3' }) }),
      );
    });

    it("opens from the drawer's Connect a project", async () => {
      fx.remotesData = [READY];
      renderSection('/?vm=r1');

      const drawer = await screen.findByRole('dialog', { name: 'lab-vm' });
      await userEvent.click(within(drawer).getByRole('button', { name: 'Connect a project' }));
      expect(
        await screen.findByRole('dialog', { name: 'Connect a project to lab-vm' }),
      ).toBeInTheDocument();
    });

    it("opens from a finished setup's next step in Activity", async () => {
      fx.remotesData = [READY];
      fx.operationsData = [
        {
          ...makeOperation(),
          id: 'setup-op',
          kind: 'claim',
          projectId: null,
          state: 'done',
          steps: [{ id: 'claim', label: 'Set up the VM', state: 'done', error: null }],
        },
      ];
      renderSection();

      await userEvent.click(await screen.findByRole('button', { name: 'Activity' }));
      await userEvent.click(await screen.findByRole('button', { name: /^Set up · lab-vm/ }));
      const detail = await screen.findByRole('dialog', { name: 'Set up · lab-vm' });
      await userEvent.click(
        within(detail).getByRole('button', { name: 'Connect a project to lab-vm' }),
      );

      const flow = await screen.findByRole('dialog', { name: 'Connect a project to lab-vm' });
      expect(
        within(within(flow).getByRole('group', { name: 'VM' })).getByRole('button', {
          name: 'lab-vm',
        }),
      ).toHaveAttribute('aria-pressed', 'true');
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: 'Set up · lab-vm' })).not.toBeInTheDocument(),
      );
    });
  });
});

// Page integration is the cheapest layer that verifies all entry points reach the real dialog.
describe('RemoteVmSection Fix file sync', () => {
  beforeEach(() => {
    fx.bindingsData = [
      {
        projectId: 'p1',
        remoteId: 'r1',
        state: 'remote',
        fileSyncFailed: { home: 1, vm: 1 },
        fileSyncWarning: '2 files cannot sync.',
      },
    ];
    fx.remotesData = [{ ...REMOTE, online: true, versionMatches: true, logins: {} }];
    fx.fileSyncFailures.p1 = fileSyncFailures();
  });
  it.each(['row', 'attention', 'disconnect'] as const)(
    'opens Fix file sync from %s',
    async (entry) => {
      renderSection(entry === 'attention' ? '/?tab=overview' : '/?tab=projects');
      if (entry === 'attention') {
        await userEvent.click(
          within(await screen.findByRole('list', { name: 'Needs attention' })).getByRole('button', {
            name: 'Fix',
          }),
        );
      } else {
        const row = await projectRow('Project One');
        if (entry === 'row')
          await userEvent.click(within(row).getByRole('button', { name: 'Fix file sync' }));
        else {
          await userEvent.click(within(row).getByRole('button', { name: 'Disconnect' }));
          const disconnect = await screen.findByRole('dialog', { name: 'Disconnect Project One?' });
          await userEvent.click(
            await within(disconnect).findByRole('button', { name: 'Fix file sync' }),
          );
        }
      }
      const dialog = await screen.findByRole('dialog', { name: 'Fix file sync · Project One' });
      expect(
        await within(dialog).findByRole('checkbox', { name: 'Exclude logs on The VM' }),
      ).toBeChecked();
      await userEvent.click(within(dialog).getAllByRole('button', { name: 'Close' })[0]);
      await waitFor(() => expect(dialog).not.toBeInTheDocument());
      if (entry === 'disconnect')
        expect(screen.getByRole('button', { name: 'Disconnect' })).toBeEnabled();
    },
  );
  it('refreshes the open Disconnect notice after saving a fix', async () => {
    renderSection('/?tab=projects');
    const row = await projectRow('Project One');
    await userEvent.click(within(row).getByRole('button', { name: 'Disconnect' }));
    const disconnect = await screen.findByRole('dialog', { name: 'Disconnect Project One?' });
    await userEvent.click(await within(disconnect).findByRole('button', { name: 'Fix file sync' }));
    const fix = await screen.findByRole('dialog', { name: 'Fix file sync · Project One' });
    await within(fix).findByRole('checkbox', { name: 'Exclude logs on The VM' });
    fx.fileSyncFailures.p1 = fileSyncFailures({
      home: { entries: [] },
      vm: { entries: [] },
      groups: [],
    });
    await userEvent.click(within(fix).getByRole('button', { name: 'Save' }));
    await within(fix).findByText('No files currently fail to sync.');
    await waitFor(() =>
      expect(within(fix).getAllByRole('button', { name: 'Close' })[0]).toBeEnabled(),
    );
    await userEvent.click(within(fix).getAllByRole('button', { name: 'Close' })[0]);
    expect(screen.queryByText(/Disconnect waits for them/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeEnabled();
  });

  it('opens the existing settings dialog for a blocking rule', async () => {
    fx.fileSyncFailures.p1.groups = [exclusion({ patterns: [], blockedBy: '!/logs' })];
    renderSection('/?tab=projects');
    const row = await projectRow('Project One');
    await userEvent.click(within(row).getByRole('button', { name: 'Fix file sync' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Edit file sync settings' }));
    const settings = await screen.findByRole('dialog', {
      name: 'File sync settings · Project One',
    });
    expect(await within(settings).findByLabelText('Add a pattern')).toBeEnabled();
    expect(
      screen.queryByRole('dialog', { name: 'Fix file sync · Project One' }),
    ).not.toBeInTheDocument();
  });
  it('does not offer Fix when failed counts are zero or absent', async () => {
    fx.bindingsData = [
      { projectId: 'p1', remoteId: 'r1', state: 'remote', fileSyncFailed: { home: 0, vm: 0 } },
    ];
    renderSection('/?tab=projects');
    const row = await projectRow('Project One');
    expect(within(row).queryByRole('button', { name: 'Fix file sync' })).not.toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: 'File sync settings' }));
    expect(
      await screen.findByRole('dialog', { name: 'File sync settings · Project One' }),
    ).toBeInTheDocument();
  });
});

// Page integration proves the confirmation reaches the real request hook and Activity.
describe('RemoteVmSection Force sync', () => {
  beforeEach(() => {
    fx.bindingsData = [
      {
        projectId: 'p1',
        remoteId: 'r1',
        state: 'remote',
        fileSyncProblem: 'error',
        fileSyncWarning: 'The shared folder is missing.',
      },
    ];
    fx.remotesData = [{ ...REMOTE, online: true, versionMatches: true, logins: {} }];
    fx.fileSyncFailures.p1 = fileSyncFailures({
      home: { entries: [] },
      vm: { entries: [] },
      groups: [],
      forceSync: { offered: true, reason: null, pending: { fromVm: 3, fromHome: 2 } },
    });
  });
  async function openConfirmation(source: 'home' | 'vm') {
    const row = await projectRow('Project One');
    await userEvent.click(within(row).getByRole('button', { name: 'Fix file sync' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Force sync…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Force sync · Project One' });
    await userEvent.click(
      within(dialog).getByRole('radio', {
        name: source === 'home' ? "Use this PC's files" : "Use the VM's files (lab-vm)",
      }),
    );
    await userEvent.click(within(dialog).getByRole('checkbox'));
    return dialog;
  }
  it.each([
    ['error', 'row'],
    ['stalled', 'attention'],
    ['setup', 'row'],
  ] as const)('opens the warning without a file list for %s from %s', async (kind, entry) => {
    fx.bindingsData[0].fileSyncProblem = kind;
    renderSection(entry === 'attention' ? '/?tab=overview' : '/?tab=projects');
    if (entry === 'attention')
      await userEvent.click(
        within(await screen.findByRole('list', { name: 'Needs attention' })).getByRole('button', {
          name: 'Fix',
        }),
      );
    else
      await userEvent.click(
        within(await projectRow('Project One')).getByRole('button', { name: 'Fix file sync' }),
      );
    const fix = await screen.findByRole('dialog', { name: 'Fix file sync · Project One' });
    expect(fix).toHaveTextContent(fx.bindingsData[0].fileSyncWarning!);
    await within(fix).findByRole('button', { name: 'Force sync…' });
    expect(within(fix).queryByRole('list')).not.toBeInTheDocument();
  });
  it.each(['home', 'vm'] as const)(
    'starts with the %s source, opens Activity and makes the project busy',
    async (source) => {
      renderSection('/?tab=projects');
      const dialog = await openConfirmation(source);
      await userEvent.click(within(dialog).getByRole('button', { name: 'Force sync' }));
      expect(fx.mockFetch).toHaveBeenCalledWith(
        '/api/remotes/r1/force-sync',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ projectId: 'p1', source }),
        }),
      );
      const activity = await screen.findByRole('dialog', { name: 'Force sync · Project One' });
      await within(activity).findByRole('progressbar');
      expect(within(activity).queryByRole('radio')).not.toBeInTheDocument();
      await userEvent.keyboard('{Escape}');
      const row = await projectRow('Project One');
      expect(row).toHaveTextContent('Force syncing');
      expect(within(row).queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
      expect(within(row).queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
    },
  );
  it('keeps server 409 refusals in the confirmation and allows a new start', async () => {
    const base = fx.mockFetch.getMockImplementation()!;
    let refuse = true;
    fx.mockFetch.mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('/force-sync') && refuse)
        return {
          ok: false,
          status: 409,
          json: async () => ({ message: 'Another operation is open for this project.' }),
        } as Response;
      return base(...args);
    });
    renderSection('/?tab=projects');
    const dialog = await openConfirmation('home');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Force sync' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Another operation is open for this project.',
    );
    expect(fx.operationsData).toEqual([]);
    refuse = false;
    await userEvent.click(within(dialog).getByRole('button', { name: 'Force sync' }));
    await waitFor(() => expect(fx.operationsData[0]?.kind).toBe('force_sync'));
    expect(await screen.findByRole('progressbar')).toBeInTheDocument();
  });
  it('opens a forced Disconnect from a failed Force sync project row', async () => {
    fx.operationsData = [
      {
        ...makeOperation(),
        kind: 'force_sync',
        state: 'failed',
        steps: [
          {
            id: 'force_copy',
            label: 'Copy files',
            state: 'failed',
            error: { code: 'SYNC_FAILED', message: 'Copy stopped.' },
          },
        ],
      },
    ];
    renderSection('/?tab=projects');
    await userEvent.click(
      within(await projectRow('Project One')).getByRole('button', { name: 'Force disconnect' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Disconnect Project One?' });
    expect(await within(dialog).findByRole('button', { name: 'Force disconnect' })).toBeEnabled();
  });
});

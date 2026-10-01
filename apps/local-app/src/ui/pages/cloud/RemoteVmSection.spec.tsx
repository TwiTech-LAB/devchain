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
  projectRow,
  renderSection,
  resetRemoteVmFixture,
  vmRow,
} from './testing/remote-vm-section.fixture';

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
      fit: 'fits',
      canConnect: true,
      warnings: [],
      managedExclusions: [],
      reconnect: null,
      estimate: null,
    };
    fx.remotesData = [{ ...REMOTE, online: true, versionMatches: true }];
    // A bound project keeps the checklist away, so the VM summary loads.
    fx.bindingsData = [{ projectId: 'p2', remoteId: 'r1', state: 'remote' }];
    renderSection();
    await screen.findByText('lab-vm');
    await userEvent.click(
      within(await projectRow('Project One')).getByRole('button', { name: 'Connect' }),
    );
    const flow = screen.getByRole('dialog', { name: 'Connect Project One' });
    await userEvent.click(within(flow).getByRole('button', { name: 'Next' }));
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
    await screen.findByText('File sync will retry automatically.');
    expect(screen.queryByText(/sync failed:/)).not.toBeInTheDocument();
  });

  it('falls back to the generic file line when home cannot tell what it has not received', async () => {
    fx.bindingsData = [{ projectId: 'p1', remoteId: 'r1', state: 'remote', hostCursor: null }];
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));

    expect(await screen.findByText('VM file changes are not synced back.')).toBeInTheDocument();
    expect(fx.mockFetch).toHaveBeenCalledWith(
      '/api/file-sync/projects/p1/status',
      expect.anything(),
    );
  });

  it('offers only ready VMs in Connect, the others disabled with their reason', async () => {
    fx.remotesData = [
      { ...REMOTE, online: true, versionMatches: true },
      { ...REMOTE, id: 'r2', name: 'old-vm', online: true, versionMatches: false },
    ];
    renderSection();
    await vmRow('old-vm');
    expect(screen.queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reset VM' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
    await userEvent.click(
      within(await projectRow('Project One')).getByRole('button', { name: 'Connect' }),
    );
    const vms = within(screen.getByRole('dialog', { name: 'Connect Project One' })).getByRole(
      'group',
      { name: 'VM' },
    );
    // The only ready VM is preselected.
    expect(within(vms).getByRole('button', { name: 'lab-vm' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(vms).getByRole('button', { name: 'old-vm · Update needed' })).toBeDisabled();
    expect(within(vms).getByRole('button', { name: 'Update old-vm' })).toBeEnabled();
  });

  it.each([
    ['No VM is ready', [{ ...REMOTE }]],
    ['Add a VM first', []],
  ])('disables Connect with "%s"', async (reason, remotes) => {
    fx.remotesData = remotes;
    renderSection();
    const row = await projectRow('Project One');
    expect(within(row).getByRole('button', { name: 'Connect' })).toBeDisabled();
    expect(within(row).getByLabelText(`Connect: ${reason}`)).toBeInTheDocument();
  });
  it('renders the VMs box and the projects table', async () => {
    renderSection();

    expect(await vmRow('lab-vm')).toHaveTextContent('Not set up');
    expect(await projectRow('Project One')).toHaveTextContent('This PC');
    expect(await projectRow('Project Two')).toHaveTextContent('This PC');
  });

  it('opens Add your own VM from the VMs tab Add VM menu; without a server it offers Connect', async () => {
    renderSection();
    // Overview has no add button of its own anymore.
    expect(screen.queryByRole('button', { name: 'Add VM' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: /^VMs/ }));

    // No server is connected, so the menu offers the connect flow instead of Create on.
    await pickAddVmMenu('Connect a Proxmox server');
    expect(screen.getByRole('dialog', { name: 'Connect a server' })).toHaveTextContent(
      'Step 1 of 3: Run the setup block',
    );
    await userEvent.keyboard('{Escape}');

    await addOwnVm();

    const flow = screen.getByRole('dialog', { name: 'Add your own VM' });
    expect(within(flow).getByLabelText('VM address')).toHaveValue('');
    expect(fx.probeBodies).toEqual([]);
  });

  it('shows provisioning and powered-off states without an address', async () => {
    fx.remotesData = [
      { ...REMOTE, kind: 'proxmox', baseUrl: null },
      { ...REMOTE, id: 'r2', name: 'stopped-vm', kind: 'proxmox', powerState: 'stopped' },
    ];
    renderSection();
    expect(await vmRow('lab-vm')).toHaveTextContent('Provisioning');
    expect(await vmRow('stopped-vm')).toHaveTextContent('Powered off');
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
    await waitFor(() => expect(screen.getByText('lab-vm')).toBeInTheDocument());

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

  it('shows each project state with its VM name', async () => {
    fx.bindingsData = [{ projectId: 'p1', remoteId: 'r1', state: 'remote' }];
    renderSection();

    const onVm = await projectRow('Project One');
    await waitFor(() => expect(onVm).toHaveTextContent('On lab-vm'));
    expect(within(onVm).getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
    expect(await projectRow('Project Two')).toHaveTextContent('This PC');
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
    expect(within(await vmRow('lab-vm')).getByText('Docker')).toBeInTheDocument();
    expect(await openVmMenu('lab-vm')).not.toContain('Install Docker');
  });

  it('copies the setup block, confirms the fingerprint and lists missing Proxmox rights', async () => {
    fx.permissionMissing = ['Sys.AccessNetwork on /nodes/pve1'];
    const clipboardWrite = jest.fn().mockResolvedValue(undefined);
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWrite },
    });

    try {
      renderSection('/?tab=proxmox');
      await userEvent.click(await screen.findByRole('button', { name: 'Connect a server' }));
      const dialog = screen.getByRole('dialog');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Advanced (optional)' }));
      await userEvent.type(within(dialog).getByLabelText('Node'), 'pve1');
      await userEvent.type(within(dialog).getByLabelText('Proxmox address'), '192.168.1.128');
      expect(
        within(dialog).getByText('Use the address you open the Proxmox web UI with.'),
      ).toBeInTheDocument();
      await userEvent.click(within(dialog).getByRole('button', { name: 'Generate setup block' }));
      expect(fx.mockFetch).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\/api\/vm-providers\/proxmox\/setup-block\?.*address=192\.168\.1\.128/,
        ),
        expect.anything(),
      );
      expect(await within(dialog).findByLabelText('Generated setup block')).toHaveValue(
        'pveum pool add devchain',
      );
      await userEvent.click(within(dialog).getByRole('button', { name: 'Copy setup block' }));
      expect(clipboardWrite).toHaveBeenCalledWith('pveum pool add devchain');

      await userEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
      const connectionString =
        'devchain-proxmox://pve.test:8006/pve1?pool=devchain&storage=local-lvm&imageStorage=local&bridge=vmbr0&fp=AA&token=devchain%40pve!agent:secret';
      await userEvent.type(within(dialog).getByLabelText('Connection string'), connectionString);
      await userEvent.click(within(dialog).getByRole('button', { name: 'Review fingerprint' }));
      expect(await within(dialog).findByTestId('proxmox-fingerprint')).toHaveTextContent(
        PROXMOX_CONNECTION.sslFingerprint,
      );
      const placement = within(dialog).getByTestId('proxmox-placement');
      expect(placement).toHaveTextContent('pve1');
      expect(placement).toHaveTextContent('local-lvm');
      expect(placement).toHaveTextContent('local');
      expect(placement).toHaveTextContent('vmbr0');
      expect(placement).toHaveTextContent('devchain');
      expect(placement).toHaveTextContent('https://pve.test:8006');
      const confirmButton = within(dialog).getByRole('button', { name: 'Connect' });
      expect(confirmButton).toBeDisabled();
      await userEvent.click(
        within(dialog).getByRole('checkbox', { name: 'Confirm Proxmox fingerprint' }),
      );
      await userEvent.click(confirmButton);

      expect(await within(dialog).findByText('Missing Proxmox rights:')).toBeInTheDocument();
      expect(
        within(dialog).getByRole('list', { name: 'Missing Proxmox rights' }),
      ).toHaveTextContent('Sys.AccessNetwork on /nodes/pve1');
      expect(within(dialog).getByText(/re-run the setup block/i)).toBeInTheDocument();
      expect(fx.mockFetch).toHaveBeenCalledWith(
        '/api/vm-providers/proxmox/connect',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ connectionString, confirmFingerprint: true }),
        }),
      );
      await userEvent.click(within(dialog).getByRole('button', { name: 'Add VM' }));
      // The connect dialog's Add VM lands on the VMs tab, where Create VM lives now.
      expect(fx.search).toContain('tab=vms');
      expect(
        await screen.findByRole('dialog', { name: 'Add a VM on Proxmox lab' }),
      ).toBeInTheDocument();
    } finally {
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
      } else {
        Reflect.deleteProperty(navigator, 'clipboard');
      }
    }
  });

  it('generates a discovering setup block with empty inputs and collapses the advanced fields by default', async () => {
    renderSection('/?tab=proxmox');
    await userEvent.click(await screen.findByRole('button', { name: 'Connect a server' }));
    const dialog = screen.getByRole('dialog');

    expect(within(dialog).getByRole('button', { name: 'Advanced (optional)' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(within(dialog).queryByRole('textbox', { name: 'Node' })).not.toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Generate setup block' }));
    expect(fx.mockFetch).toHaveBeenCalledWith(
      '/api/vm-providers/proxmox/setup-block?node=&pool=devchain&storage=&imageStorage=&bridge=',
      expect.anything(),
    );
    expect(await within(dialog).findByLabelText('Generated setup block')).toHaveValue(
      'pveum pool add devchain',
    );
  });

  it('leaves an empty pool out of the setup block query', async () => {
    renderSection('/?tab=proxmox');
    await userEvent.click(await screen.findByRole('button', { name: 'Connect a server' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Advanced (optional)' }));
    await userEvent.clear(within(dialog).getByRole('textbox', { name: 'Pool' }));

    await userEvent.click(within(dialog).getByRole('button', { name: 'Generate setup block' }));
    expect(fx.mockFetch).toHaveBeenCalledWith(
      '/api/vm-providers/proxmox/setup-block?node=&storage=&imageStorage=&bridge=',
      expect.anything(),
    );
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
    expect(fx.mockFetch).not.toHaveBeenCalledWith('/api/remotes/r1/destroy-vm', expect.anything());
  });

  it('requires offline force confirmation and sends force true for VM destruction', async () => {
    fx.remotesData = [
      {
        ...REMOTE,
        online: false,
        kind: 'proxmox',
        vmProviderConnectionId: 'pc1',
        vmIdentity: '12345678-1234-1234-1234-123456789abc',
      },
    ];
    renderSection();
    await pickVmMenu('lab-vm', 'Destroy VM');
    const dialog = screen.getByRole('dialog');

    expect(
      within(dialog).getByText(/Provider logins keep their last saved copy/i),
    ).toBeInTheDocument();
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

  it("requires force confirmation to destroy a VM that rejects this PC's API key", async () => {
    fx.remotesData = [
      {
        ...REMOTE,
        online: true,
        apiKeyRejected: true,
        kind: 'proxmox',
        vmProviderConnectionId: 'pc1',
        vmIdentity: '12345678-1234-1234-1234-123456789abc',
      },
    ];
    renderSection();
    await pickVmMenu('lab-vm', 'Destroy VM');
    const dialog = screen.getByRole('dialog');

    expect(within(dialog).getByText(/The VM rejects this PC's API key/)).toBeInTheDocument();
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
    expect(fx.mockFetch).not.toHaveBeenCalledWith('/api/remotes/r1/destroy-vm', expect.anything());
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
      expect(
        within(dialog).getByRole('combobox', { name: 'opencode login choice' }),
      ).toHaveTextContent('Keep current (2 logins)');

      await chooseLogin(dialog, 'codex', 'None');
      // Changing claude surfaces the VM's override report for that provider.
      await chooseLogin(dialog, 'claude', 'None');
      expect(
        await within(dialog).findByText(/The VM's provider settings hold CLAUDE_CODE_OAUTH_TOKEN/),
      ).toBeInTheDocument();

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
    expect(await openVmMenu('lab-vm')).not.toContain('Reset API key');
  });

  it('offers Reset API key for an accepted online VM', async () => {
    fx.remotesData = [{ ...REMOTE, online: true, apiKeyRejected: false }];
    renderSection();
    await pickVmMenu('lab-vm', 'Reset API key');
    expect(screen.getByRole('dialog', { name: 'Reset API key for lab-vm' })).toBeInTheDocument();
  });
});

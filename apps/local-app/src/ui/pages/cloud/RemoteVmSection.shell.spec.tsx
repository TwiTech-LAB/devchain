import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RemoteOperationDto } from '@/ui/hooks/useRemoteOperations';
import { POWER_ON_GRACE_MS } from './remote-status';
import {
  PROXMOX_CONNECTION,
  REMOTE,
  fx,
  makeOperation,
  openVmMenu,
  pickVmMenu,
  renderSection,
  resetRemoteVmFixture,
  vmRow,
  type TestRemote,
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
    expect(screen.queryByRole('heading', { name: 'Remote VMs' })).not.toBeInTheDocument();
    expect(screen.getByRole('tablist').parentElement).toContainElement(
      screen.getByRole('button', { name: /^Activity/ }),
    );
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /^Proxmox/ })).toHaveTextContent('Proxmox1'),
    );
    expect(screen.getByRole('tab', { name: /^VMs/ })).toHaveTextContent('VMs1');
    // Overview is read-only: the summary names each VM, and no row actions render.
    expect(screen.getByRole('button', { name: 'Manage VMs' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'More actions for lab-vm' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add VM' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: /^VMs/ }));
    expect(fx.search).toContain('tab=vms');
    // The full VM list lives on the VMs tab, not in a titled card.
    expect(await screen.findByRole('list', { name: 'VMs' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'VMs' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: /^Proxmox/ }));
    expect(fx.search).toContain('tab=proxmox');
    expect(await screen.findByRole('button', { name: 'Connect a server' })).toBeInTheDocument();
  });

  it('opens the Logins tab from the URL', async () => {
    renderSection('/?tab=logins');
    expect(screen.getByRole('tab', { name: /^Logins/ })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('button', { name: 'Add a Claude login' })).toBeInTheDocument();
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

    it('opens the details of the VM whose home folder differs when View is pressed', async () => {
      fx.remotesData = [{ ...READY, homePath: '/home/other', homePathMatches: false }];
      renderSection();

      const text = await screen.findByText(
        'lab-vm uses the home folder /home/other. This PC uses /home/devchain. Projects cannot connect to it.',
      );
      await userEvent.click(within(text.closest('li')!).getByRole('button', { name: 'View' }));
      expect(fx.search).toContain('vm=r1');
      expect(fx.search).toContain('tab=vms');
      const drawer = await screen.findByRole('dialog', { name: 'lab-vm' });
      expect(within(drawer).getByLabelText('Home folder')).toHaveTextContent(
        '/home/other · differs from this PC',
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

      await act(async () => release());
      expect(await screen.findByRole('button', { name: 'Manage VMs' })).toBeInTheDocument();
    });
  });

  describe('VM rows', () => {
    it.each<[string, TestRemote, RemoteOperationDto[], string, string[]]>([
      [
        '1 removed',
        {
          ...REMOTE,
          kind: 'proxmox',
          baseUrl: null,
          vmProviderConnectionId: 'pc1',
          lastOperation: { id: 'x', kind: 'create_vm', state: 'cancelled', updatedAt: '' },
        },
        [],
        'Setup cancelled',
        ['Remove from list'],
      ],
      ['2 busy', READY, [hostOperation('claim', 'running')], 'Setting up', ['View']],
      ['3 stopped', READY, [hostOperation('update_host', 'failed')], 'Update stopped', ['Resolve']],
      ['4 not set up', REMOTE, [], 'Not set up', ['Set up']],
      ['5 provisioning', { ...MANAGED, baseUrl: null, online: false }, [], 'Provisioning', []],
      [
        '6 powered off',
        { ...MANAGED, online: false, powerState: 'stopped' },
        [],
        'Powered off',
        ['Power on'],
      ],
      [
        '7 not answering',
        { ...MANAGED, online: false, powerState: 'running' },
        [],
        'Not answering',
        [],
      ],
      ['8 offline', { ...READY, online: false, lastSeenAt: null }, [], 'Never reached', []],
      ['9 update needed', { ...READY, versionMatches: false }, [], 'Update needed', ['Update']],
      [
        '10 home folder differs',
        { ...READY, homePathMatches: false },
        [],
        'Home folder differs',
        [],
      ],
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

    it('shows user@host for a provisioned own VM, while the drawer keeps the full address', async () => {
      fx.remotesData = [{ ...READY, userName: 'devchain' }];
      renderSection();

      const row = await vmRow('lab-vm');
      await waitFor(() => expect(row).toHaveTextContent('devchain@10.0.0.5'));
      expect(row).not.toHaveTextContent('https://10.0.0.5:4000');

      await userEvent.click(within(row).getByRole('button', { name: 'lab-vm' }));
      const drawer = await screen.findByRole('dialog', { name: 'lab-vm' });
      expect(within(drawer).getByLabelText('Address')).toHaveTextContent('https://10.0.0.5:4000');
    });

    it('shows Proxmox · server · user@host for a provisioned Proxmox VM', async () => {
      fx.providerConnectionsData = [PROXMOX_CONNECTION];
      fx.remotesData = [{ ...MANAGED, userName: 'devchain', online: false, powerState: 'unknown' }];
      renderSection();

      const row = await vmRow('lab-vm');
      await waitFor(() =>
        expect(row).toHaveTextContent('Proxmox · Proxmox lab · devchain@10.0.0.5'),
      );
    });

    it('keeps the address text for VMs without a provisioned user or address', async () => {
      fx.providerConnectionsData = [PROXMOX_CONNECTION];
      fx.remotesData = [REMOTE, { ...MANAGED, id: 'r2', name: 'build-vm', baseUrl: null }];
      renderSection();

      const own = await vmRow('lab-vm');
      expect(own).toHaveTextContent('https://10.0.0.5:4000');
      expect(own).not.toHaveTextContent('@10.0.0.5');

      const provisioning = await vmRow('build-vm');
      expect(provisioning).toHaveTextContent('Proxmox · Proxmox lab');
      expect(provisioning).not.toHaveTextContent('@');
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
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'renamed-vm' }) }),
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

      expect(await within(dialog).findByRole('alert')).toHaveTextContent('That name is reserved.');
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

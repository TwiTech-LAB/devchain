import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RemoteOperationDto } from '@/ui/hooks/useRemoteOperations';
import {
  REMOTE,
  fx,
  makeOperation,
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
  it('opens from vm= in the URL on load, and closing it clears the key', async () => {
    fx.remotesData = [READY];
    renderSection('/?vm=r1');

    const panel = await drawer();
    expect(within(panel).getByText('Ready')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(fx.search).not.toContain('vm=');
  });

  it('closes from its Close button, which a phone needs because the drawer fills the screen', async () => {
    fx.remotesData = [READY];
    renderSection('/?vm=r1');

    const panel = await drawer();
    await userEvent.click(within(panel).getByRole('button', { name: 'Close details' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(fx.search).not.toContain('vm=');
  });

  it("opens from the VM's name", async () => {
    fx.remotesData = [READY];
    renderSection();

    await userEvent.click(within(await vmRow('lab-vm')).getByRole('button', { name: 'lab-vm' }));
    expect(await drawer()).toBeInTheDocument();
    expect(fx.search).toContain('vm=r1');
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
    await waitFor(() => expect(fx.probeBodies).toEqual([{ address: '10.0.0.5', checkSsh: true }]));
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

  it('opens from the right and leaves the bottom drawers as they are', async () => {
    fx.remotesData = [READY];
    renderSection('/?vm=r1');

    const panel = await drawer();
    expect(panel.className).toContain('right-0');
    expect(panel.className).not.toContain('bottom-0');
  });

  // UI layer: the sign is derived only from the list item, so rendering the section covers it.
  describe('connection security', () => {
    const FINGERPRINT = '0123456789ABCDEF'.repeat(4);
    const COLON_FINGERPRINT = FINGERPRINT.match(/.{2}/g)!.join(':');
    const PINNED = 'Encrypted (TLS) · certificate pinned';
    const NO_CERTIFICATE = 'No certificate · add the VM again or reset it';

    it('shows the pinned connection and the fingerprint of an online VM', async () => {
      fx.remotesData = [{ ...READY, tlsFingerprint: FINGERPRINT } as TestRemote];
      renderSection('/?vm=r1');

      const panel = await drawer();
      expect(within(panel).getByLabelText('Connection')).toHaveTextContent(PINNED);
      expect(within(panel).getByLabelText('Certificate')).toHaveTextContent(
        `SHA-256 ${COLON_FINGERPRINT}`,
      );
    });

    it('says the certificate is pinned but not connected for an offline VM', async () => {
      fx.remotesData = [{ ...READY, online: false, tlsFingerprint: FINGERPRINT } as TestRemote];
      renderSection('/?vm=r1');

      const panel = await drawer();
      expect(within(panel).getByLabelText('Connection')).toHaveTextContent(
        'Certificate pinned · not connected now',
      );
      expect(within(panel).getByLabelText('Certificate')).toHaveTextContent(COLON_FINGERPRINT);
    });

    it('warns when a set-up VM has no certificate', async () => {
      fx.remotesData = [{ ...READY, online: false, tlsFingerprint: null } as TestRemote];
      renderSection('/?vm=r1');

      const panel = await drawer();
      expect(within(panel).getByLabelText('Connection')).toHaveTextContent(NO_CERTIFICATE);
      expect(within(panel).queryByLabelText('Certificate')).not.toBeInTheDocument();
    });

    it('shows nothing for a VM that is not set up yet', async () => {
      fx.remotesData = [{ ...REMOTE, tlsFingerprint: null } as TestRemote];
      renderSection('/?vm=r1');

      const panel = await drawer();
      expect(within(panel).queryByLabelText('Connection')).not.toBeInTheDocument();
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

      expect(within(await vmRow('lab-vm')).getByRole('img', { name: PINNED })).toBeInTheDocument();
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

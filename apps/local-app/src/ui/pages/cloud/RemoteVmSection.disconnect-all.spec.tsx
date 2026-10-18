// Page interactions retain the modal, per-project checks, API payload and exact-VM entry wiring.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  fx,
  REMOTE,
  makeOperation,
  pickVmMenu,
  renderSection,
  resetRemoteVmFixture,
} from './testing/remote-vm-section.fixture';
import { fileSyncFailures } from './testing/file-sync-failures.fixture';
import type { DockerSyncState } from '@/modules/remotes/docker/docker-copy-back.dto';

const mockUseAllProjects = jest.fn();
const mockUseWorkspaces = jest.fn();
const mockUseSelectedProject = jest.fn();
jest.mock('@/ui/hooks/useAllProjects', () => ({
  useAllProjects: () => mockUseAllProjects(),
  useWorkspaces: () => mockUseWorkspaces(),
}));
jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => mockUseSelectedProject(),
}));
jest.mock('@/ui/hooks/useHomeSocket', () => ({ useHomeSocket: jest.fn() }));
const toastSpy = jest.fn();
jest.mock('@/ui/hooks/use-toast', () => ({ useToast: () => ({ toast: toastSpy }) }));

const GROUP = '1234567890abcdef';
const noDocker = (): DockerSyncState => ({
  availability: { available: true, side: null, reason: null },
  imported: false,
  groups: [],
});
const docker = (name: string): DockerSyncState => ({
  availability: { available: true, side: null, reason: null },
  imported: true,
  groups: [
    {
      key: GROUP,
      itemNames: [name],
      volumes: [name],
      bindPaths: [],
      state: 'both-changed',
      needsChoice: true,
    },
  ],
});
const dialog = () => screen.getByRole('dialog', { name: 'Disconnect all from lab-vm' });
const reviewButton = () => within(dialog()).getByRole('button', { name: 'Review Disconnect all' });
async function review() {
  await waitFor(() => expect(reviewButton()).toBeEnabled());
  await userEvent.click(reviewButton());
}

beforeEach(() => {
  resetRemoteVmFixture({
    useSelectedProject: mockUseSelectedProject,
    useAllProjects: mockUseAllProjects,
    useWorkspaces: mockUseWorkspaces,
    toast: toastSpy,
  });
  fx.remotesData = [{ ...REMOTE, online: true, versionMatches: true, version: '0.23.4' }];
  fx.bindingsData = [
    { projectId: 'p1', remoteId: 'r1', state: 'remote' },
    { projectId: 'p2', remoteId: 'r1', state: 'remote' },
  ];
  fx.overrides.readDockerSyncState = async () => noDocker();
});

it('checks all projects, keeps identical Docker group keys separate and submits one reviewed batch', async () => {
  fx.allProjects.push({ id: 'p3', name: 'Plain Project', rootPath: '/tmp/p3', workspaceId: 'w1' });
  fx.bindingsData.push({ projectId: 'p3', remoteId: 'r1', state: 'remote' });
  fx.overrides.readDockerSyncState = async (projectId) =>
    projectId === 'p3' ? noDocker() : docker(projectId === 'p1' ? 'first-db' : 'second-db');
  renderSection('/?disconnectAll=r1&keep=1');
  await screen.findByRole('table', { name: 'Docker data for Project One' });
  await waitFor(() => expect(fx.calls.readRemoteProjectLanes).toHaveLength(3));
  expect(reviewButton()).toBeDisabled();
  expect(within(dialog()).getAllByText('Choices needed')).toHaveLength(2);
  await userEvent.click(within(dialog()).getByRole('combobox', { name: 'Choice for first-db' }));
  await userEvent.click(
    await screen.findByRole('option', { name: "Copy the VM's data to this PC" }),
  );
  expect(reviewButton()).toBeDisabled();
  await userEvent.click(within(dialog()).getByRole('button', { name: /Project Two/ }));
  await userEvent.click(within(dialog()).getByRole('combobox', { name: 'Choice for second-db' }));
  await userEvent.click(await screen.findByRole('option', { name: "Keep this PC's data" }));
  await userEvent.click(within(dialog()).getByRole('button', { name: /Plain Project/ }));
  expect(within(dialog()).queryByRole('table')).not.toBeInTheDocument();
  await review();
  const summary = within(dialog()).getByRole('region', { name: 'Review Disconnect all' });
  expect(summary).toHaveTextContent('Project One');
  expect(summary).toHaveTextContent('first-db: Copy the VM’s data to this PC');
  expect(summary).toHaveTextContent('second-db: Keep this PC’s data');
  expect(summary).toHaveTextContent('Plain Project');
  await userEvent.click(within(dialog()).getByRole('button', { name: 'Disconnect all' }));
  await waitFor(() =>
    expect(fx.calls.disconnectAll).toEqual([
      [
        'r1',
        {
          force: false,
          projects: [
            { projectId: 'p1', dockerCopyBack: { choices: { [GROUP]: 'copy-home' } } },
            { projectId: 'p2', dockerCopyBack: { choices: { [GROUP]: 'keep-home' } } },
            { projectId: 'p3' },
          ],
        },
      ],
    ]),
  );
  expect(fx.calls.detachProject).toHaveLength(0);
  await screen.findByRole('dialog', { name: /Disconnect all/ });
  expect(new URLSearchParams(fx.search).has('disconnectAll')).toBe(false);
  expect(new URLSearchParams(fx.search).get('keep')).toBe('1');
});

it('waits for an unselected project check before allowing review', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  fx.overrides.readRemoteProjectLanes = async (_remoteId, projectId) => {
    if (projectId === 'p2') await gate;
    return { lanes: [] };
  };
  renderSection('/?disconnectAll=r1');
  await waitFor(() => expect(fx.calls.readRemoteProjectLanes).toHaveLength(2));
  expect(reviewButton()).toBeDisabled();
  release();
  await waitFor(() => expect(reviewButton()).toBeEnabled());
});

it.each(['file failures', 'file warning', 'lanes', 'unknown lanes', 'open operation'] as const)(
  'blocks review for %s on another project',
  async (kind) => {
    if (kind === 'file failures')
      fx.fileSyncFailures.p2 = fileSyncFailures({ home: { entries: [] } });
    if (kind === 'file warning')
      fx.bindingsData[1].fileSyncWarning = 'File sync will retry automatically.';
    if (kind === 'lanes')
      fx.overrides.readRemoteProjectLanes = async (_remoteId, projectId) => ({
        lanes:
          projectId === 'p2'
            ? [{ name: 'lane-two', path: '/lane', branch: 'work', dirty: false }]
            : [],
      });
    if (kind === 'unknown lanes')
      fx.overrides.readRemoteProjectLanes = async (_remoteId, projectId) => {
        if (projectId === 'p2') throw new Error('Lanes on the VM cannot be inspected.');
        return { lanes: [] };
      };
    if (kind === 'open operation')
      fx.operationsData = [
        { ...makeOperation(), remoteId: 'r1', projectId: 'p2', state: 'failed', kind: 'detach' },
      ];
    renderSection('/?disconnectAll=r1');
    await waitFor(() => expect(within(dialog()).getAllByText('Blocked').length).toBeGreaterThan(0));
    expect(reviewButton()).toBeDisabled();
    expect(fx.calls.disconnectAll).toHaveLength(0);
    if (kind !== 'open operation') {
      await userEvent.click(within(dialog()).getByRole('button', { name: /Project Two/ }));
      expect(within(dialog()).getByRole('alert')).toBeInTheDocument();
      if (kind.startsWith('file')) {
        await userEvent.click(within(dialog()).getByRole('button', { name: 'Fix file sync' }));
        expect(
          await screen.findByRole('dialog', { name: 'Fix file sync · Project Two' }),
        ).toBeInTheDocument();
      }
    }
  },
);

it('reviews offline loss warnings and submits forced children without Docker choices or VM reads', async () => {
  fx.remotesData[0].online = false;
  fx.bindingsData[0].hostCursor = new Date(Date.now() - 5 * 60_000).toISOString();
  fx.fileSyncStatus = { folders: [{ id: 'code:p1', needItems: 2, needBytes: 100 }] };
  renderSection('/?disconnectAll=r1');
  expect(
    await screen.findByText(
      'lab-vm cannot be reached. Force disconnect keeps the last home mirror without contacting the VM.',
    ),
  ).toBeInTheDocument();
  await review();
  expect(within(dialog()).getAllByText('What may be lost')).toHaveLength(2);
  expect(within(dialog()).getByText(/Changes since the last mirror/)).toBeInTheDocument();
  expect(within(dialog()).queryByRole('table')).not.toBeInTheDocument();
  await userEvent.click(within(dialog()).getByRole('button', { name: 'Force disconnect all' }));
  await waitFor(() =>
    expect(fx.calls.disconnectAll).toEqual([
      ['r1', { force: true, projects: [{ projectId: 'p1' }, { projectId: 'p2' }] }],
    ]),
  );
  expect(fx.calls.readDockerSyncState).toHaveLength(0);
  expect(fx.calls.readRemoteProjectLanes).toHaveLength(0);
  expect(fx.calls.readProjectFileSyncFailures).toHaveLength(0);
});

it.each(['row menu', 'drawer', 'Destroy refusal', 'notice'] as const)(
  'opens the exact VM from %s',
  async (entry) => {
    fx.remotesData.push({
      ...fx.remotesData[0],
      id: 'r2',
      name: 'other-vm',
      kind: 'proxmox',
      vmProviderConnectionId: 'pc1',
      vmIdentity: 'vm-2',
      vmSpec: { cores: 2, memory: 2048, disk: 16 },
    });
    fx.bindingsData[1].remoteId = 'r2';
    if (entry === 'notice')
      fx.noticesData = [
        { id: 'notice-2', remoteId: 'r2', fromUser: 'owner', action: 'destroy', at: 'now' },
      ];
    renderSection(entry === 'drawer' ? '/?vm=r2&keep=1' : '/?keep=1');
    if (entry === 'row menu') await pickVmMenu('other-vm', 'Disconnect all');
    if (entry === 'drawer')
      await userEvent.click(
        within(await screen.findByRole('dialog', { name: 'other-vm' })).getByRole('button', {
          name: 'Disconnect all',
        }),
      );
    if (entry === 'Destroy refusal') {
      await pickVmMenu('other-vm', 'Destroy VM');
      const refusal = screen.getByRole('dialog', { name: 'Destroy other-vm?' });
      expect(within(refusal).getByRole('button', { name: 'Destroy VM' })).toBeDisabled();
      await userEvent.click(within(refusal).getByRole('button', { name: 'Disconnect all' }));
    }
    if (entry === 'notice')
      await userEvent.click(await screen.findByRole('button', { name: 'Disconnect all' }));
    const batch = await screen.findByRole('dialog', { name: 'Disconnect all from other-vm' });
    const list = within(batch).getByRole('list', { name: 'Projects to disconnect' });
    expect(list).toHaveTextContent('Project Two');
    expect(list).not.toHaveTextContent('Project One');
    expect(new URLSearchParams(fx.search).get('disconnectAll')).toBe('r2');
    expect(new URLSearchParams(fx.search).get('keep')).toBe('1');
  },
);

it('uses collapsible project rows on small screens with one Docker detail table', async () => {
  const original = window.matchMedia;
  window.matchMedia = jest.fn().mockReturnValue({
    matches: false,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  });
  fx.overrides.readDockerSyncState = async (projectId) => docker(projectId);
  try {
    const view = renderSection('/?disconnectAll=r1');
    const batch = await screen.findByRole('dialog', { name: 'Disconnect all from lab-vm' });
    expect(within(batch).queryByRole('table')).not.toBeInTheDocument();
    const row = within(batch).getByRole('button', { name: /Project Two/ });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(
      await within(batch).findByRole('table', { name: 'Docker data for Project Two' }),
    ).toBeInTheDocument();
    expect(within(batch).getAllByRole('table')).toHaveLength(1);
    await userEvent.click(row);
    expect(within(batch).queryByRole('table')).not.toBeInTheDocument();
    view.unmount();
  } finally {
    window.matchMedia = original;
  }
});

it('keeps the review and choices when batch start is refused, then retries the same payload', async () => {
  fx.overrides.disconnectAll = async () => {
    throw new Error('The connected projects changed.');
  };
  renderSection('/?disconnectAll=r1');
  await screen.findByRole('dialog', { name: 'Disconnect all from lab-vm' });
  await review();
  await userEvent.click(within(dialog()).getByRole('button', { name: 'Disconnect all' }));
  expect(await within(dialog()).findByRole('alert')).toHaveTextContent(
    'The connected projects changed.',
  );
  expect(
    within(dialog()).getByRole('region', { name: 'Review Disconnect all' }),
  ).toBeInTheDocument();
  delete fx.overrides.disconnectAll;
  await userEvent.click(within(dialog()).getByRole('button', { name: 'Disconnect all' }));
  await waitFor(() => expect(fx.calls.disconnectAll).toHaveLength(2));
  expect(fx.calls.disconnectAll[0]).toEqual(fx.calls.disconnectAll[1]);
});

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RemoteOperationDto } from '@/ui/hooks/useRemoteOperations';
import {
  REMOTE,
  finishConnect,
  fx,
  makeOperation,
  pickVmMenu,
  projectRow,
  renderSection,
  resetRemoteVmFixture,
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

const READY = { ...REMOTE, online: true, versionMatches: true, logins: {} };

function projectRequests(): string[] {
  return fx.mockFetch.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.startsWith('/api/projects'));
}

// UI integration: the project rows join the all-workspace list, the bindings,
// the operations and each project's newest operation, as the page does.
describe('RemoteVmSection projects', () => {
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

  it('notes a list the server cut', async () => {
    fx.projectsTotal = 1500;
    renderSection();
    expect(await screen.findByText('Showing the first 1,000 projects.')).toBeInTheDocument();
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
    expect(
      await screen.findByText(
        'Project One: the copy on lab-vm was not removed. The VM refused to release the copy.',
      ),
    ).toBeInTheDocument();
  });

  it('offers Disconnect for a leftover disconnect', async () => {
    fx.remotesData = [READY];
    fx.bindingsData = [{ projectId: 'p1', remoteId: 'r1', state: 'detaching' }];
    renderSection();

    const row = await projectRow('Project One');
    await waitFor(() => expect(row).toHaveTextContent('Stuck while disconnecting'));
    await userEvent.click(within(row).getByRole('button', { name: 'Disconnect' }));
    expect(
      await screen.findByRole('dialog', { name: 'Disconnect Project One?' }),
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

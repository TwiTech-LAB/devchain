import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  REMOTE,
  fx,
  makeOperation,
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
const OLD = { ...READY, id: 'r2', name: 'old-vm', versionMatches: false };

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

  it('selects no VM when the chosen VM is not ready, not even the only ready one', async () => {
    fx.remotesData = [OLD, READY];
    renderSection('/?section=remote-vm&projectAction=p1&connectVm=r2');

    const dialog = await screen.findByRole('dialog', { name: 'Connect Project One' });
    expect(vmChoice(dialog, 'old-vm · Update needed')).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Update old-vm' })).toBeInTheDocument();
    expect(vmChoice(dialog, 'lab-vm')).toHaveAttribute('aria-pressed', 'false');
    expect(within(dialog).getByRole('button', { name: 'Next' })).toBeDisabled();
    await expectIntentConsumed();
  });

  it('keeps choosing the only ready VM when no VM is given', async () => {
    fx.remotesData = [OLD, READY];
    renderSection('/?section=remote-vm&projectAction=p1');

    const dialog = await screen.findByRole('dialog', { name: 'Connect Project One' });
    expect(vmChoice(dialog, 'lab-vm')).toHaveAttribute('aria-pressed', 'true');
    await expectIntentConsumed();
  });

  it('opens Connect with Connect held back when no VM is ready', async () => {
    renderSection('/?section=remote-vm&projectAction=p1');

    const dialog = await screen.findByRole('dialog', { name: 'Connect Project One' });
    expect(vmChoice(dialog, 'lab-vm · Not set up')).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Next' })).toBeDisabled();
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
    expect(await screen.findByRole('dialog', { name: 'Connect Project One' })).toBeInTheDocument();
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

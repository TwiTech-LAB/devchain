// The page with an in-memory API is the cheapest reliable layer for entry points,
// explicit Force confirmation, refreshed refusal context and Activity Retry routing.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  REMOTE,
  fx,
  makeOperation,
  pickVmMenu,
  renderSection,
  resetRemoteVmFixture,
} from './testing/remote-vm-section.fixture';
import type { SharedVmGuardContext } from './lib/remote-vm-contracts';
import { SharedVmGuardApiError } from './lib/remote-vm-errors';

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

function context(ids: string[] | 'unknown' = ['b1', 'b2']): SharedVmGuardContext {
  return {
    occupancy: {
      unavailable: false,
      instances: [
        {
          user: 'bob',
          port: 3001,
          version: '0.25.0',
          connectedCount: ids === 'unknown' ? 'unknown' : ids.length,
          connectedProjectIds: ids,
        },
      ],
    },
    lastRoster: null,
  };
}

beforeEach(() => {
  resetRemoteVmFixture({
    useSelectedProject: mockUseSelectedProject,
    useAllProjects: mockUseAllProjects,
    useWorkspaces: mockUseWorkspaces,
    toast: toastSpy,
  });
  fx.remotesData = [
    {
      ...REMOTE,
      kind: 'proxmox',
      online: true,
      vmProviderConnectionId: 'pc1',
      vmIdentity: 'vm-1',
      vmSpec: { cores: 2, memory: 2048, disk: 16 },
    },
  ];
  fx.overrides.readSharedVm = async () => context();
});

describe('Shared VM Reset and Destroy', () => {
  it('shows the cached roster in the drawer as context while offline', async () => {
    fx.remotesData[0] = {
      ...fx.remotesData[0],
      online: false,
      sharedVmRoster: {
        ownUser: 'alice',
        at: '2026-10-12T12:00:00Z',
        vmIdentity: 'vm-1',
        roster: { instances: context().occupancy.instances },
      },
    };
    renderSection('/?vm=r1');
    expect(await screen.findByText('Also on this VM: bob (2 projects)')).toBeInTheDocument();
    expect(screen.getByText('Last known roster; context only.')).toBeInTheDocument();
  });
  it.each(['Reset VM', 'Destroy VM'])(
    'blocks %s until one explicit confirmation and submits the displayed project set',
    async (action) => {
      renderSection();
      await pickVmMenu('lab-vm', action);
      const dialog = screen.getByRole('dialog');
      const button = within(dialog).getByRole('button', { name: action });
      const label =
        action === 'Reset VM'
          ? 'Force reset and accept the possible loss'
          : 'Force destroy and accept the possible loss';
      await waitFor(() =>
        expect(within(dialog).getByRole('checkbox', { name: label })).toBeEnabled(),
      );
      expect(
        within(dialog).getByRole('list', { name: 'Other users on this VM' }),
      ).toHaveTextContent('bob: 2 projects');
      expect(button).toBeDisabled();
      await userEvent.click(within(dialog).getByRole('checkbox', { name: label }));
      await userEvent.click(button);
      const calls = action === 'Reset VM' ? fx.calls.resetVm : fx.calls.destroyVm;
      await waitFor(() =>
        expect(calls).toContainEqual([
          'r1',
          expect.objectContaining({
            force: false,
            forceOccupied: true,
            confirmedOccupancy: context().occupancy,
          }),
        ]),
      );
    },
  );

  it('allows zero-project users without Force', async () => {
    fx.overrides.readSharedVm = async () => context([]);
    renderSection();
    await pickVmMenu('lab-vm', 'Destroy VM');
    const dialog = screen.getByRole('dialog');
    const button = within(dialog).getByRole('button', { name: 'Destroy VM' });
    await waitFor(() => expect(button).toBeEnabled());
    expect(within(dialog).queryByRole('checkbox', { name: /Force/ })).not.toBeInTheDocument();
    await userEvent.click(button);
    expect(fx.calls.destroyVm).toContainEqual([
      'r1',
      { force: false, forceOccupied: false, confirmedOccupancy: context([]).occupancy },
    ]);
  });

  it('uses one confirmation for both offline login loss and unknown occupancy', async () => {
    fx.remotesData[0] = { ...fx.remotesData[0], online: false };
    fx.overrides.readSharedVm = async () => ({
      occupancy: { unavailable: true, instances: [] },
      lastRoster: null,
    });
    renderSection();
    await pickVmMenu('lab-vm', 'Reset VM');
    const dialog = screen.getByRole('dialog');
    const force = within(dialog).getByRole('checkbox', { name: /Force reset/ });
    await waitFor(() => expect(force).toBeEnabled());
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(1);
    expect(within(dialog).getByRole('button', { name: 'Reset VM' })).toBeDisabled();
    await userEvent.click(force);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reset VM' }));
    expect(fx.calls.resetVm).toContainEqual([
      'r1',
      expect.objectContaining({
        force: true,
        forceOccupied: true,
        confirmedOccupancy: { unavailable: true, instances: [] },
      }),
    ]);
  });

  it('notifies other users with the optional message and leaves Force unconfirmed', async () => {
    fx.overrides.notifySharedVm = async () => ({
      results: [
        { user: 'bob', delivered: true },
        { user: 'carol', delivered: false },
      ],
    });
    renderSection();
    await pickVmMenu('lab-vm', 'Reset VM');
    const dialog = screen.getByRole('dialog');
    const notify = within(dialog).getByRole('button', { name: 'Notify them' });
    await waitFor(() => expect(notify).toBeEnabled());
    await userEvent.type(
      within(dialog).getByLabelText('Optional message to the other users'),
      'Please save work',
    );
    await userEvent.click(notify);
    expect(fx.calls.notifySharedVm).toContainEqual([
      'r1',
      { action: 'reset', message: 'Please save work' },
    ]);
    expect(
      await within(dialog).findByText('bob: notice sent; carol: could not notify'),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Reset VM' })).toBeDisabled();
    expect(fx.calls.resetVm).toEqual([]);
  });

  it('requires a second confirmation when a refusal supplies an equal-count replacement', async () => {
    fx.overrides.destroyVm = async () => {
      throw new SharedVmGuardApiError('bob has new projects', context(['b1', 'b3']));
    };
    renderSection();
    await pickVmMenu('lab-vm', 'Destroy VM');
    const dialog = screen.getByRole('dialog');
    const force = within(dialog).getByRole('checkbox', { name: /Force destroy/ });
    await waitFor(() => expect(force).toBeEnabled());
    await userEvent.click(force);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Destroy VM' }));
    await within(dialog).findByText('bob has new projects');
    expect(force).not.toBeChecked();
    expect(within(dialog).getByRole('button', { name: 'Destroy VM' })).toBeDisabled();
    await userEvent.click(force);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Destroy VM' }));
    expect(fx.calls.destroyVm[1]).toEqual([
      'r1',
      expect.objectContaining({ confirmedOccupancy: context(['b1', 'b3']).occupancy }),
    ]);
  });

  it.each(['reset_vm', 'destroy_vm'] as const)(
    'opens a fresh confirmation from Activity and retries the same %s operation',
    async (kind) => {
      fx.operationsData = [
        {
          ...makeOperation(),
          kind,
          projectId: null,
          state: 'failed',
          steps: [
            {
              id: 'destroy',
              label: 'Destroy VM',
              state: 'failed',
              error: { code: 'VM_SHARED_PROJECTS_CONNECTED', message: 'bob has new projects' },
            },
          ],
        },
      ];
      renderSection();
      await userEvent.click(await screen.findByRole('button', { name: /^Activity/ }));
      const title = kind === 'reset_vm' ? 'Reset · lab-vm' : 'Destroy · lab-vm';
      await userEvent.click(
        await within(screen.getByRole('dialog')).findByRole('button', {
          name: new RegExp(`^${title}`),
        }),
      );
      await userEvent.click(
        within(screen.getByRole('dialog')).getByRole('button', { name: 'Retry' }),
      );
      const dialog = await screen.findByRole('dialog', {
        name: kind === 'reset_vm' ? 'Reset lab-vm?' : 'Destroy lab-vm?',
      });
      const force = within(dialog).getByRole('checkbox', { name: /Force .* and accept/ });
      await waitFor(() => expect(force).toBeEnabled());
      expect(fx.calls.retryOperation).toEqual([]);
      await userEvent.click(force);
      await userEvent.click(
        within(dialog).getByRole('button', {
          name: kind === 'reset_vm' ? 'Reset VM' : 'Destroy VM',
        }),
      );
      await waitFor(() =>
        expect(fx.calls.retryOperation).toContainEqual([
          'op1',
          { vm: { force: false, forceOccupied: true, confirmedOccupancy: context().occupancy } },
        ]),
      );
      expect(fx.calls.resetVm).toEqual([]);
      expect(fx.calls.destroyVm).toEqual([]);
    },
  );

  it('allows explicit login-loss recovery when the failed pull precedes a health update', async () => {
    fx.overrides.readSharedVm = async () => context([]);
    fx.operationsData = [
      {
        ...makeOperation(),
        kind: 'destroy_vm',
        projectId: null,
        state: 'failed',
        steps: [
          {
            id: 'pull_families',
            label: 'Save logins',
            state: 'failed',
            error: { code: 'REMOTE_OFFLINE', message: 'The final login pull failed' },
          },
        ],
      },
    ];
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: /^Activity/ }));
    await userEvent.click(
      await within(screen.getByRole('dialog')).findByRole('button', { name: /^Destroy · lab-vm/ }),
    );
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Retry' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Destroy lab-vm?' });
    const force = within(dialog).getByRole('checkbox', {
      name: 'Force destruction while the VM is unreachable',
    });
    await waitFor(() => expect(force).toBeEnabled());
    expect(within(dialog).getByRole('button', { name: 'Destroy VM' })).toBeDisabled();
    await userEvent.click(force);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Destroy VM' }));
    await waitFor(() =>
      expect(fx.calls.retryOperation).toContainEqual([
        'op1',
        { vm: { force: true, forceOccupied: false, confirmedOccupancy: context([]).occupancy } },
      ]),
    );
    expect(fx.calls.destroyVm).toEqual([]);
  });
});

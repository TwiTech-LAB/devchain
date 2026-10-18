// Page interaction is the cheapest layer that retains the notice query,
// socket refresh, URL entry callback and Dismiss response handling together.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  fx,
  REMOTE,
  renderSection,
  resetRemoteVmFixture,
} from './testing/remote-vm-section.fixture';

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

const NOTICE = {
  id: 'f319eabe-5470-42b5-81b4-8e4dc2ed00b0',
  remoteId: REMOTE.id,
  fromUser: 'owner',
  action: 'reset' as const,
  message: 'Maintenance',
  at: '2026-10-12T15:00:00Z',
};

beforeEach(() => {
  resetRemoteVmFixture({
    useSelectedProject: mockUseSelectedProject,
    useAllProjects: mockUseAllProjects,
    useWorkspaces: mockUseWorkspaces,
    toast: toastSpy,
  });
  fx.remotesData = [REMOTE];
});

it('loads a polled notice through the socket and opens Disconnect all for its VM', async () => {
  renderSection('/?tab=overview&keep=1');
  await waitFor(() => expect(fx.calls.listNotices).toHaveLength(1));
  fx.noticesData = [NOTICE];
  act(() =>
    fx.messageHandler?.({ topic: 'remotes', type: 'notices', payload: { remoteId: REMOTE.id } }),
  );
  const button = await screen.findByRole('button', { name: 'Disconnect all' });
  expect(
    within(button.closest('li')!).getByRole('button', { name: 'Dismiss' }),
  ).toBeInTheDocument();
  await userEvent.click(button);
  expect(new URLSearchParams(fx.search).get('disconnectAll')).toBe(REMOTE.id);
  expect(new URLSearchParams(fx.search).get('keep')).toBe('1');
  expect(
    await screen.findByRole('dialog', { name: `Disconnect all from ${REMOTE.name}` }),
  ).toBeInTheDocument();
});

it('dismisses a notice through home and removes it after the VM accepts', async () => {
  fx.noticesData = [NOTICE];
  renderSection();
  await userEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
  await waitFor(() => expect(fx.calls.dismissNotice).toEqual([[REMOTE.id, NOTICE.id]]));
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument(),
  );
});

it('keeps a notice visible with the VM refusal when Dismiss fails', async () => {
  fx.noticesData = [NOTICE];
  fx.overrides.dismissNotice = async () => {
    throw new Error('The VM is offline');
  };
  renderSection();
  await userEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The VM is offline');
  expect(screen.getByRole('button', { name: 'Dismiss' })).toBeEnabled();
});

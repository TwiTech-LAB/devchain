import { act, render, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RemoteOperationDto } from '@/ui/hooks/useRemoteOperations';
import { ActivityDialog, useActivityView, type ActivityView } from './ActivityDialog';
import type { ActivityActions } from './OperationDetail';

const NAMES = {
  remotes: new Map([['r1', 'lab-vm']]),
  projects: new Map([['p1', 'Project One']]),
};

function operation(overrides: Partial<RemoteOperationDto>): RemoteOperationDto {
  return {
    id: 'op',
    kind: 'attach',
    remoteId: 'r1',
    projectId: 'p1',
    state: 'running',
    steps: [{ id: 'a', label: 'Copy project', state: 'running', error: null }],
    details: {},
    createdAt: '2026-09-28T10:00:00.000Z',
    updatedAt: '2026-09-28T10:00:00.000Z',
    ...overrides,
  };
}

const RUNNING = operation({ id: 'running' });
const FAILED = operation({
  id: 'failed',
  kind: 'update_logins',
  projectId: null,
  state: 'failed',
  steps: [
    {
      id: 'preflight',
      label: 'Check the VM',
      state: 'failed',
      error: { message: 'Agents are running.', code: null },
    },
  ],
});
const DONE = operation({ id: 'done', kind: 'update_host', projectId: null, state: 'done' });

const ACTIONS: ActivityActions = {
  retry: jest.fn(),
  cancel: jest.fn(),
  reauth: jest.fn(),
  openLogin: jest.fn(),
  disconnectInstead: jest.fn(),
  forceDisconnect: jest.fn(),
};

function renderDialog(
  view: ActivityView | null,
  callbacks: Partial<Record<string, jest.Mock>> = {},
) {
  const handlers = {
    onOpenList: jest.fn(),
    onOpenDetail: jest.fn(),
    onClose: jest.fn(),
    ...callbacks,
  };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ActivityDialog
        view={view}
        operations={[RUNNING, FAILED, DONE]}
        recentFinished={[DONE]}
        names={NAMES}
        pending={false}
        error={null}
        actions={ACTIONS}
        {...handlers}
      />
    </QueryClientProvider>,
  );
  return handlers;
}

// Component rendering is the cheapest layer for the list groups and the
// navigation between modes; the page spec covers when each mode opens.
describe('ActivityDialog', () => {
  it('groups running, failed and recently finished operations', async () => {
    const { onOpenDetail } = renderDialog({ mode: 'list' });
    const dialog = screen.getByRole('dialog', { name: 'Activity' });

    const running = within(dialog).getByRole('region', { name: 'Running' });
    expect(within(running).getByRole('button')).toHaveTextContent('Connect · Project One');
    expect(within(running).getByRole('button')).toHaveTextContent('Step 1 of 1: Copy project');

    const failed = within(dialog).getByRole('region', { name: 'Needs attention' });
    expect(within(failed).getByRole('button')).toHaveTextContent('Change logins · lab-vm');
    expect(within(failed).getByRole('button')).toHaveTextContent('Agents are running.');

    const finished = within(dialog).getByRole('region', { name: 'Finished' });
    await userEvent.click(within(finished).getByRole('button', { name: /Update · lab-vm/ }));
    expect(onOpenDetail).toHaveBeenCalledWith('done');
  });

  it('says so when there is no activity', () => {
    render(
      <ActivityDialog
        view={{ mode: 'list' }}
        operations={[]}
        recentFinished={[]}
        names={NAMES}
        pending={false}
        error={null}
        actions={ACTIONS}
        onOpenList={jest.fn()}
        onOpenDetail={jest.fn()}
        onClose={jest.fn()}
      />,
    );
    expect(screen.getByText('No activity yet.')).toBeInTheDocument();
  });

  it('shows a detail with a back link when it came from the list', async () => {
    const { onOpenList } = renderDialog({ mode: 'detail', operationId: 'failed', fromList: true });
    const dialog = screen.getByRole('dialog', { name: 'Change logins · lab-vm' });
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Agents are running.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'All activity' }));
    expect(onOpenList).toHaveBeenCalled();
  });

  it('has no back link on a detail opened directly', () => {
    renderDialog({ mode: 'detail', operationId: 'running', fromList: false });
    expect(screen.getByRole('dialog', { name: 'Connect · Project One' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'All activity' })).not.toBeInTheDocument();
  });

  it('says so when the operation is no longer loaded', () => {
    renderDialog({ mode: 'detail', operationId: 'gone', fromList: false });
    expect(screen.getByText('This operation is no longer in the list.')).toBeInTheDocument();
  });

  it('closes without cancelling anything', async () => {
    const { onClose } = renderDialog({ mode: 'detail', operationId: 'running', fromList: false });
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
    expect(ACTIONS.cancel).not.toHaveBeenCalled();
  });
});

describe('useActivityView', () => {
  const inRouter = ({ children }: { children: ReactNode }) => (
    <MemoryRouter>{children}</MemoryRouter>
  );

  it('opens a detail with a back link only when the list was open', () => {
    const { result } = renderHook(() => useActivityView(), { wrapper: inRouter });
    act(() => result.current.openDetail('a'));
    expect(result.current.view).toEqual({ mode: 'detail', operationId: 'a', fromList: false });
    act(() => result.current.openList());
    act(() => result.current.openDetail('b'));
    expect(result.current.view).toEqual({ mode: 'detail', operationId: 'b', fromList: true });
    act(() => result.current.close());
    expect(result.current.view).toBeNull();
  });

  it('keeps the open view when the page remounts under the same router', () => {
    // A backend switch remounts the page below the router (BackendBoundary's key).
    let latest = {} as ReturnType<typeof useActivityView>;
    function Page() {
      latest = useActivityView();
      return null;
    }
    const { rerender } = render(inRouter({ children: <Page key="home" /> }));
    act(() => latest.openList());
    act(() => latest.openDetail('a'));
    rerender(inRouter({ children: <Page key="vm" /> }));
    expect(latest.view).toEqual({ mode: 'detail', operationId: 'a', fromList: true });
  });
});

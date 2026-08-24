import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import type { ManagedSubtaskSyncHealth } from '@/ui/lib/managed-subtask-sync';
import { ManagedSubtaskSyncPanel } from './ManagedSubtaskSyncPanel';

const health: ManagedSubtaskSyncHealth = {
  provider: 'clickup',
  enabled: true,
  syncSettingRevision: 2,
  status: 'needs_attention',
  counts: { total: 2, pending: 1, outcomeUnknown: 1, needsAttention: 0, orphanRisk: 0 },
  items: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      epicId: 'epic-verify',
      phase: 'outcome_unknown',
      tombstoneState: 'active',
      safeErrorCode: 'provider_timeout',
      retryAt: null,
      remoteTaskId: 'task-1',
      openInSourceUrl: 'https://app.clickup.com/t/task-1',
      canVerify: true,
      canRetry: false,
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      epicId: 'epic-retry',
      phase: 'pre_dispatch',
      tombstoneState: 'active',
      safeErrorCode: 'provider_busy',
      retryAt: null,
      remoteTaskId: 'task-2',
      openInSourceUrl: 'https://evil.example/task-2',
      canVerify: false,
      canRetry: true,
    },
  ],
  truncated: false,
};

describe('ManagedSubtaskSyncPanel', () => {
  it('supports keyboard pause/resume with a stable accessible name and focus', async () => {
    const user = userEvent.setup();
    const onToggle = jest.fn(async () => undefined);
    render(
      <ManagedSubtaskSyncPanel
        provider="clickup"
        enabled={false}
        onToggle={onToggle}
        onVerify={jest.fn()}
        onRetry={jest.fn()}
      />,
    );

    await user.tab();
    const syncSwitch = screen.getByRole('switch', {
      name: 'Sync DevChain sub-epics as managed subtasks',
    });
    expect(syncSwitch).toHaveFocus();
    await user.keyboard(' ');

    expect(onToggle).toHaveBeenCalledWith(true);
    expect(syncSwitch).toHaveFocus();
    expect(await screen.findByRole('status')).toHaveTextContent(/sync resumed/i);
  });

  it('renders bounded health and follows backend recovery actions and safe URLs', async () => {
    const user = userEvent.setup();
    const onVerify = jest.fn(async () => undefined);
    const onRetry = jest.fn(async () => undefined);
    const view = render(
      <ManagedSubtaskSyncPanel
        provider="clickup"
        enabled
        health={health}
        onToggle={jest.fn()}
        onVerify={onVerify}
        onRetry={onRetry}
      />,
    );

    expect(screen.getAllByText('Needs attention')).toHaveLength(2);
    expect(screen.getByText('Unconfirmed').nextElementSibling).toHaveTextContent('1');
    expect(screen.getByRole('link', { name: /epic epic-verify in source/i })).toHaveAttribute(
      'href',
      'https://app.clickup.com/t/task-1',
    );
    expect(
      screen.queryByRole('link', { name: /epic epic-retry in source/i }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /verify clickup.*epic-verify/i }));
    await user.click(screen.getByRole('button', { name: /retry clickup.*epic-retry/i }));

    expect(onVerify).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
    expect(onRetry).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222');
    expect(await axe(view.baseElement)).toHaveNoViolations();
  });

  it('shows the persisted verification failure instead of a generic unknown message', () => {
    render(
      <ManagedSubtaskSyncPanel
        provider="clickup"
        enabled
        health={{
          ...health,
          items: [
            {
              ...health.items[0]!,
              safeErrorCode: 'remote_verification_mismatch',
            },
          ],
        }}
        onToggle={jest.fn()}
        onVerify={jest.fn()}
        onRetry={jest.fn()}
      />,
    );

    expect(
      screen.getByText(
        'The provider returned different title or description content after the write.',
      ),
    ).toBeInTheDocument();
  });

  it('disables the switch and announces its mutation state', () => {
    render(
      <ManagedSubtaskSyncPanel
        provider="jira"
        enabled
        isUpdating
        onToggle={jest.fn()}
        onVerify={jest.fn()}
        onRetry={jest.fn()}
      />,
    );

    expect(
      screen.getByRole('switch', { name: 'Sync DevChain sub-epics as managed subtasks' }),
    ).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Updating Jira sync setting');
  });
});

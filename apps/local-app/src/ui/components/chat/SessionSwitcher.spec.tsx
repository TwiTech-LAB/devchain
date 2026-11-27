import { fireEvent, render, screen } from '@testing-library/react';
import type { ProfileProviderConfig } from '@/ui/lib/provider-configs';
import type { SessionTreeNode } from '@/ui/lib/sessions';
import { SessionSwitcher } from './SessionSwitcher';
import type { SessionsTableProps } from './SessionsTable';

const node = {
  id: 'session-1',
  name: 'Older session',
  kind: 'session',
  providerNameAtLaunch: 'codex',
  startedAt: '2026-01-01T00:00:00.000Z',
} as SessionTreeNode;
const switchConfig = { id: 'cfg-codex', name: 'codex-default' } as ProfileProviderConfig;

jest.mock('@/ui/hooks/useAgentSessionTree', () => ({
  useAgentSessionTree: () => ({ byId: new Map(), savePoints: undefined }),
}));

// The table owns the row rules; the switcher owns the replacement dialog.
jest.mock('./SessionsTable', () => ({
  SessionsTable: ({ onRestore }: SessionsTableProps) => (
    <>
      <button onClick={() => onRestore(node, switchConfig)}>Restore on another provider</button>
      <button onClick={() => onRestore(node, undefined)}>Restore on this provider</button>
    </>
  ),
}));

function renderSwitcher() {
  const handleRestoreSession = jest.fn();
  render(
    <SessionSwitcher
      agentId="agent-1"
      agentName="Coder"
      projectId="project-1"
      liveSessionId="live-1"
      liveSessionName="Live"
      currentProviderName="claude"
      controls={
        {
          handleRestoreSession,
          restoringSessionIds: {},
          forkingSessionIds: {},
          rollingBackSessionIds: {},
          savingSessionIds: {},
        } as unknown as SessionSwitcherControls
      }
      open
      onOpenChange={jest.fn()}
      onRead={jest.fn()}
      onDialogOpenChange={jest.fn()}
    />,
  );
  return handleRestoreSession;
}

type SessionSwitcherControls = React.ComponentProps<typeof SessionSwitcher>['controls'];

describe('SessionSwitcher restore', () => {
  it('replaces the live session and passes the config the dialog showed', () => {
    const handleRestoreSession = renderSwitcher();
    fireEvent.click(screen.getByRole('button', { name: 'Restore on another provider' }));
    expect(handleRestoreSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(handleRestoreSession).toHaveBeenCalledWith(
      'session-1',
      'agent-1',
      'live-1',
      'cfg-codex',
    );
  });

  it('passes no config for a restore on the same provider', () => {
    const handleRestoreSession = renderSwitcher();
    fireEvent.click(screen.getByRole('button', { name: 'Restore on this provider' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(handleRestoreSession).toHaveBeenCalledWith('session-1', 'agent-1', 'live-1', undefined);
  });
});

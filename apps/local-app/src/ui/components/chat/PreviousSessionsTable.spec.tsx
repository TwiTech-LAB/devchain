import { fireEvent, render, screen } from '@testing-library/react';
import type { ProfileProviderConfig } from '@/ui/lib/provider-configs';
import type { SavePointAvailability, SessionTreeNode } from '@/ui/lib/sessions';
import { PreviousSessionsTable } from './PreviousSessionsTable';
import type { SessionsTableProps } from './SessionsTable';

const node: SessionTreeNode = {
  id: 'session-1',
  name: 'Previous session',
  kind: 'session',
  status: 'stopped',
  parentSessionId: null,
  providerSessionId: 'provider-session-1',
  providerNameAtLaunch: 'claude',
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: null,
  lastActivityAt: null,
  sizeBytes: null,
  transcriptAvailable: true,
  beforeRollback: false,
};
const savePoint: SessionTreeNode = {
  ...node,
  id: 'save-1',
  name: 'Checkpoint',
  kind: 'save_point',
  parentSessionId: node.id,
};
const availability: SavePointAvailability = { available: true };
const switchConfig = { id: 'cfg-codex', name: 'codex-default' } as ProfileProviderConfig;

jest.mock('./SessionsTable', () => ({
  SessionsTable: ({ children, onRead, onRestore, onFork, onRollback }: SessionsTableProps) => (
    <>
      {children}
      <button onClick={() => onRead(node)}>Read transcript</button>
      <button onClick={() => onRestore(node, undefined)}>Restore session</button>
      <button onClick={() => onRestore(node, switchConfig)}>Restore on another provider</button>
      <button onClick={() => onFork(node, availability)}>Fork</button>
      <button onClick={() => onRollback(node, savePoint, false, undefined)}>Roll back</button>
    </>
  ),
}));

// Stub the shared table to exercise the launch screen's heading and ID-based callbacks.
it('provides the heading and forwards the DevChain ID for each row action', () => {
  const onRead = jest.fn();
  const onRestore = jest.fn();
  const onStartFromHere = jest.fn();
  const onRollback = jest.fn();
  render(
    <PreviousSessionsTable
      agentId="agent-1"
      projectId="project-1"
      onRead={onRead}
      onRestore={onRestore}
      onStartFromHere={onStartFromHere}
      onRollback={onRollback}
      currentProviderName="claude"
      restoringSessionIds={{}}
      forkingSessionIds={{}}
      rollingBackSessionIds={{}}
    />,
  );

  expect(screen.getByText('Previous sessions')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Read transcript' }));
  fireEvent.click(screen.getByRole('button', { name: 'Restore session' }));
  fireEvent.click(screen.getByRole('button', { name: 'Fork' }));
  fireEvent.click(screen.getByRole('button', { name: 'Roll back' }));
  expect(onRead).toHaveBeenCalledWith(node.id);
  expect(onRestore).toHaveBeenCalledWith(node.id);
  expect(onStartFromHere).toHaveBeenCalledWith(node.id, availability);
  expect(onRollback).toHaveBeenCalledWith(node.id, savePoint.id, false, 'Checkpoint');
});

describe('restore on another provider', () => {
  function renderTable(onRestore = jest.fn(), onDialogOpenChange = jest.fn()) {
    render(
      <PreviousSessionsTable
        agentId="agent-1"
        agentName="Coder"
        projectId="project-1"
        onRead={jest.fn()}
        onRestore={onRestore}
        onStartFromHere={jest.fn()}
        onRollback={jest.fn()}
        currentProviderName="claude"
        restoringSessionIds={{}}
        forkingSessionIds={{}}
        rollingBackSessionIds={{}}
        onDialogOpenChange={onDialogOpenChange}
      />,
    );
    return { onRestore, onDialogOpenChange };
  }

  it('restores only after the confirm, with the config the dialog showed', () => {
    const { onRestore, onDialogOpenChange } = renderTable();
    fireEvent.click(screen.getByRole('button', { name: 'Restore on another provider' }));
    expect(onRestore).not.toHaveBeenCalled();
    expect(onDialogOpenChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(onRestore).toHaveBeenCalledWith(node.id, 'cfg-codex');
    expect(onDialogOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('restores nothing when the dialog is cancelled', () => {
    const { onRestore, onDialogOpenChange } = renderTable();
    fireEvent.click(screen.getByRole('button', { name: 'Restore on another provider' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onRestore).not.toHaveBeenCalled();
    expect(onDialogOpenChange).toHaveBeenLastCalledWith(false);
  });
});

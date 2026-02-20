import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Socket } from 'socket.io-client';
import { InlineTerminalPanel } from './InlineTerminalPanel';
import { getAppSocket, getWorktreeSocket } from '@/ui/lib/socket';

const closeWindowMock = jest.fn();

let activeWorktreeName: string | null = null;

jest.mock('@/ui/hooks/useWorktreeTab', () => ({
  useOptionalWorktreeTab: () => ({
    activeWorktree: activeWorktreeName
      ? {
          id: `wt-${activeWorktreeName}`,
          name: activeWorktreeName,
          devchainProjectId: `project-${activeWorktreeName}`,
        }
      : null,
    setActiveWorktree: jest.fn(),
    apiBase: activeWorktreeName ? `/wt/${encodeURIComponent(activeWorktreeName)}` : '',
    worktrees: [],
    worktreesLoading: false,
  }),
}));

jest.mock('@/ui/terminal-windows', () => ({
  useTerminalWindows: () => ({
    closeWindow: closeWindowMock,
  }),
}));

jest.mock('@/ui/lib/socket', () => ({
  getAppSocket: jest.fn(),
  getWorktreeSocket: jest.fn(),
  releaseAppSocket: jest.fn(),
  releaseWorktreeSocket: jest.fn(),
}));

let lastTerminalProps: Record<string, unknown> | null = null;

jest.mock('@/ui/components/Terminal', () => {
  const React = jest.requireActual('react') as typeof import('react');

  return {
    Terminal: React.forwardRef(function MockTerminal(
      props: Record<string, unknown>,
      ref: React.Ref<{ focus: () => void; clear: () => void; fit: () => void }>,
    ) {
      lastTerminalProps = props;
      const handle = {
        focus: jest.fn(),
        clear: jest.fn(),
        fit: jest.fn(),
      };
      if (typeof ref === 'function') {
        ref(handle);
      } else if (ref && typeof ref === 'object') {
        (ref as React.MutableRefObject<typeof handle | null>).current = handle;
      }
      return <div data-testid="inline-terminal" />;
    }),
  };
});

const getAppSocketMock = getAppSocket as jest.MockedFunction<typeof getAppSocket>;
const getWorktreeSocketMock = getWorktreeSocket as jest.MockedFunction<typeof getWorktreeSocket>;

function createMockSocket(): Socket {
  return {
    connected: true,
    on: jest.fn(),
    off: jest.fn(),
    emit: jest.fn(),
  } as unknown as Socket;
}

describe('InlineTerminalPanel', () => {
  beforeEach(() => {
    activeWorktreeName = null;
    lastTerminalProps = null;
    closeWindowMock.mockReset();
    jest.clearAllMocks();

    const defaultSocket = createMockSocket();
    getAppSocketMock.mockReturnValue(defaultSocket);
  });

  it('renders empty state when session is unavailable', () => {
    render(<InlineTerminalPanel sessionId={null} isWindowOpen={false} />);
    expect(screen.getByText(/Agent must be online/i)).toBeInTheDocument();
  });

  it('closes worktree floating window by windowId when reopening inline', () => {
    render(
      <InlineTerminalPanel
        sessionId="session-wt-1"
        windowId="worktree:feature-auth:session-wt-1"
        isWindowOpen={true}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Reopen terminal in chat/i }));

    expect(closeWindowMock).toHaveBeenCalledWith('worktree:feature-auth:session-wt-1');
  });

  it('uses app socket when no worktree is active', () => {
    const appSocket = createMockSocket();
    getAppSocketMock.mockReturnValue(appSocket);

    render(<InlineTerminalPanel sessionId="session-1" isWindowOpen={false} />);

    expect(getAppSocketMock).toHaveBeenCalled();
    expect(getWorktreeSocketMock).not.toHaveBeenCalled();
    expect(lastTerminalProps?.socket).toBe(appSocket);
  });

  it('selects worktree socket when a worktree tab is active', () => {
    activeWorktreeName = 'feature-auth';
    const worktreeSocket = createMockSocket();
    getWorktreeSocketMock.mockReturnValue(worktreeSocket);

    render(<InlineTerminalPanel sessionId="session-1" isWindowOpen={false} />);

    expect(getWorktreeSocketMock).toHaveBeenCalledWith('feature-auth');
    expect(lastTerminalProps?.socket).toBe(worktreeSocket);
  });

  it('uses socket prop over worktree auto-selection', () => {
    activeWorktreeName = 'feature-auth';
    const propSocket = createMockSocket();

    render(<InlineTerminalPanel sessionId="session-1" isWindowOpen={false} socket={propSocket} />);

    expect(getAppSocketMock).not.toHaveBeenCalled();
    expect(getWorktreeSocketMock).not.toHaveBeenCalled();
    expect(lastTerminalProps?.socket).toBe(propSocket);
  });
});

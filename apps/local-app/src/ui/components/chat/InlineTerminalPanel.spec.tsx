import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { InlineTerminalPanel } from './InlineTerminalPanel';

const closeWindowMock = jest.fn();

jest.mock('@/ui/terminal-windows', () => ({
  useTerminalWindows: () => ({
    closeWindow: closeWindowMock,
  }),
}));

let lastTerminalHandle: {
  focus: jest.Mock;
  clear: jest.Mock;
  fit: jest.Mock;
  insertPromptText: jest.Mock;
} | null = null;

jest.mock('@/ui/components/Terminal', () => {
  const React = jest.requireActual('react') as typeof import('react');

  return {
    Terminal: React.forwardRef(function MockTerminal(
      _props: Record<string, unknown>,
      ref: React.Ref<{
        focus: () => void;
        clear: () => void;
        fit: () => void;
        insertPromptText: (text: string) => Promise<void>;
      }>,
    ) {
      const handle = {
        focus: jest.fn(),
        clear: jest.fn(),
        fit: jest.fn(),
        insertPromptText: jest.fn().mockResolvedValue(undefined),
      };
      lastTerminalHandle = handle;
      if (typeof ref === 'function') {
        ref(handle);
      } else if (ref && typeof ref === 'object') {
        (ref as React.MutableRefObject<typeof handle | null>).current = handle;
      }
      return <div data-testid="inline-terminal" />;
    }),
  };
});

describe('InlineTerminalPanel', () => {
  beforeEach(() => {
    lastTerminalHandle = null;
    closeWindowMock.mockReset();
    jest.clearAllMocks();
  });

  it('renders empty state when session is unavailable', () => {
    render(<InlineTerminalPanel sessionId={null} isWindowOpen={false} />);
    expect(screen.getByText(/Agent must be online/i)).toBeInTheDocument();
  });

  it('closes the floating window by windowId when reopening inline', () => {
    render(<InlineTerminalPanel sessionId="session-1" windowId="session-1" isWindowOpen={true} />);

    fireEvent.click(screen.getByRole('button', { name: /Reopen terminal in chat/i }));

    expect(closeWindowMock).toHaveBeenCalledWith('session-1');
  });

  it('exposes the mounted handle and marks the terminal shortcut scope', () => {
    const terminalRef = React.createRef<NonNullable<typeof lastTerminalHandle>>();

    render(
      <InlineTerminalPanel sessionId="session-1" isWindowOpen={false} terminalRef={terminalRef} />,
    );

    expect(terminalRef.current).toBe(lastTerminalHandle);
    expect(screen.getByTestId('inline-terminal').parentElement).toHaveAttribute(
      'data-inline-terminal-input',
    );
  });

  // -------------------------------------------------------------------------
  // Tab toggle (Terminal / Session)
  // -------------------------------------------------------------------------

  it('renders terminal visible by default (activeTab omitted)', async () => {
    render(<InlineTerminalPanel sessionId="session-1" isWindowOpen={false} />);

    expect(screen.getByTestId('inline-terminal')).toBeInTheDocument();
    expect(screen.queryByTestId('session-tab-content')).not.toBeInTheDocument();

    {
      const terminalContainer = screen.getByTestId('inline-terminal').parentElement!;
      expect(terminalContainer.style.display).not.toBe('none');
      expect(screen.queryByTestId('session-tab-content')).not.toBeInTheDocument();
    }
  });

  it('refits terminal when terminal tab becomes active', () => {
    jest.useFakeTimers();
    const { rerender } = render(
      <InlineTerminalPanel sessionId="session-1" isWindowOpen={false} activeTab="session" />,
    );

    rerender(
      <InlineTerminalPanel sessionId="session-1" isWindowOpen={false} activeTab="terminal" />,
    );

    jest.runOnlyPendingTimers();

    expect(lastTerminalHandle?.fit).toHaveBeenCalled();
    expect(lastTerminalHandle?.focus).toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('keeps terminal mounted when switching to session tab (no unmount)', () => {
    const { rerender } = render(
      <InlineTerminalPanel sessionId="session-1" isWindowOpen={false} activeTab="terminal" />,
    );

    // Terminal is visible
    expect(screen.getByTestId('inline-terminal')).toBeInTheDocument();

    const terminal = screen.getByTestId('inline-terminal');
    // Switch to session tab
    rerender(
      <InlineTerminalPanel sessionId="session-1" isWindowOpen={false} activeTab="session" />,
    );

    // Terminal is still in the DOM (CSS hidden), not unmounted
    expect(screen.getByTestId('inline-terminal')).toBeInTheDocument();
    const terminalContainer = screen.getByTestId('inline-terminal').parentElement!;
    expect(terminalContainer.style.display).toBe('none');
    expect(screen.getByTestId('inline-terminal')).toBe(terminal);
    expect(screen.getByTestId('session-tab-content')).toBeInTheDocument();
    expect(screen.getByText(/Session viewer loading/)).toBeInTheDocument();
  });

  it('renders custom sessionContent when provided and session tab active', () => {
    render(
      <InlineTerminalPanel
        sessionId="session-1"
        isWindowOpen={false}
        activeTab="session"
        sessionContent={<div data-testid="custom-viewer">Custom Session Viewer</div>}
      />,
    );

    expect(screen.getByTestId('custom-viewer')).toBeInTheDocument();
    expect(screen.getByText('Custom Session Viewer')).toBeInTheDocument();
  });
});

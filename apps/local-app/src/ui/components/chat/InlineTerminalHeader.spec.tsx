import React from 'react';
import { axe } from 'jest-axe';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InlineTerminalHeader } from './InlineTerminalHeader';

jest.mock('@/ui/components/session-reader/InlineSessionSummaryChip', () => {
  const actual = jest.requireActual('@/ui/components/session-reader/InlineSessionSummaryChip');
  return {
    ...actual,
    InlineSessionSummaryChip: (props: Record<string, unknown>) => (
      <div data-testid="session-chip" data-active-tab={props.activeTab} />
    ),
  };
});

const defaultProps = {
  onBackToChat: jest.fn(),
};

describe('InlineTerminalHeader', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Basic rendering
  // ---------------------------------------------------------------------------

  it('renders static Terminal label when no tab toggle', () => {
    render(<InlineTerminalHeader {...defaultProps} />);

    expect(screen.getByText('Terminal')).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('renders agent name', () => {
    render(<InlineTerminalHeader {...defaultProps} agentName="Coder" />);

    expect(screen.getByText(/Coder/)).toBeInTheDocument();
  });

  it('hides agent name when null', () => {
    render(<InlineTerminalHeader {...defaultProps} agentName={null} />);

    expect(screen.queryByText('·')).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Chat toggle
  // ---------------------------------------------------------------------------

  it('shows back-to-chat button by default', () => {
    render(<InlineTerminalHeader {...defaultProps} />);

    expect(screen.getByRole('button', { name: /Back to chat messages/i })).toBeInTheDocument();
  });

  it('hides back-to-chat button when showChatToggle is false', () => {
    render(<InlineTerminalHeader {...defaultProps} showChatToggle={false} />);

    expect(
      screen.queryByRole('button', { name: /Back to chat messages/i }),
    ).not.toBeInTheDocument();
  });

  it('calls onBackToChat when chat button clicked', () => {
    const onBack = jest.fn();
    render(<InlineTerminalHeader {...defaultProps} onBackToChat={onBack} />);

    fireEvent.click(screen.getByRole('button', { name: /Back to chat messages/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // Open window button
  // ---------------------------------------------------------------------------

  it('renders open-window button when onOpenWindow provided', () => {
    render(<InlineTerminalHeader {...defaultProps} onOpenWindow={jest.fn()} />);

    expect(screen.getByRole('button', { name: /Open terminal in window/i })).toBeInTheDocument();
  });

  it('hides open-window button when onOpenWindow omitted', () => {
    render(<InlineTerminalHeader {...defaultProps} />);

    expect(
      screen.queryByRole('button', { name: /Open terminal in window/i }),
    ).not.toBeInTheDocument();
  });

  it('renders the prompt button immediately before Window with shortcut metadata', () => {
    render(
      <InlineTerminalHeader {...defaultProps} onOpenPrompts={jest.fn()} onOpenWindow={jest.fn()} />,
    );

    const promptButton = screen.getByRole('button', { name: /Open custom prompts/i });
    const windowButton = screen.getByRole('button', { name: /Open terminal in window/i });
    expect(promptButton).toHaveAttribute('aria-keyshortcuts', 'Alt+Shift+P');
    expect(promptButton.compareDocumentPosition(windowButton)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('hides the prompt button when no eligible callback is provided', () => {
    render(<InlineTerminalHeader {...defaultProps} />);

    expect(screen.queryByRole('button', { name: /Open custom prompts/i })).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Tab toggle (requires hasTranscript + onTabChange)
  // ---------------------------------------------------------------------------

  it('shows tab toggle when hasTranscript and onTabChange provided', () => {
    render(
      <InlineTerminalHeader
        {...defaultProps}
        hasTranscript={true}
        onTabChange={jest.fn()}
        activeTab="terminal"
      />,
    );

    expect(screen.getByRole('tablist', { name: /Terminal panel tabs/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Terminal' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Session' })).toBeInTheDocument();
  });

  it('hides tab toggle when hasTranscript is false', () => {
    render(
      <InlineTerminalHeader {...defaultProps} hasTranscript={false} onTabChange={jest.fn()} />,
    );

    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('hides tab toggle when onTabChange omitted', () => {
    render(<InlineTerminalHeader {...defaultProps} hasTranscript={true} />);

    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('marks Terminal tab as selected when activeTab is terminal', () => {
    render(
      <InlineTerminalHeader
        {...defaultProps}
        hasTranscript={true}
        onTabChange={jest.fn()}
        activeTab="terminal"
      />,
    );

    expect(screen.getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Session' })).toHaveAttribute('aria-selected', 'false');
  });

  it('marks Session tab as selected when activeTab is session', () => {
    render(
      <InlineTerminalHeader
        {...defaultProps}
        hasTranscript={true}
        onTabChange={jest.fn()}
        activeTab="session"
      />,
    );

    expect(screen.getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: 'Session' })).toHaveAttribute('aria-selected', 'true');
  });

  it('calls onTabChange with "terminal" when Terminal tab clicked', () => {
    const onTabChange = jest.fn();
    render(
      <InlineTerminalHeader
        {...defaultProps}
        hasTranscript={true}
        onTabChange={onTabChange}
        activeTab="session"
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Terminal' }));
    expect(onTabChange).toHaveBeenCalledWith('terminal');
  });

  it('calls onTabChange with "session" when Session tab clicked', () => {
    const onTabChange = jest.fn();
    render(
      <InlineTerminalHeader
        {...defaultProps}
        hasTranscript={true}
        onTabChange={onTabChange}
        activeTab="terminal"
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Session' }));
    expect(onTabChange).toHaveBeenCalledWith('session');
  });

  // ---------------------------------------------------------------------------
  // Session chip
  // ---------------------------------------------------------------------------

  it('renders session chip when sessionChip prop provided', () => {
    render(
      <InlineTerminalHeader
        {...defaultProps}
        sessionChip={{
          metrics:
            {} as unknown as import('@/modules/session-reader/dtos/unified-session.types').UnifiedMetrics,
          activeTab: 'terminal',
          onSwitchToSession: jest.fn(),
        }}
      />,
    );

    expect(screen.getByTestId('session-chip')).toBeInTheDocument();
  });

  it('hides session chip when sessionChip omitted', () => {
    render(<InlineTerminalHeader {...defaultProps} />);

    expect(screen.queryByTestId('session-chip')).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Session name/ID chip
  // ---------------------------------------------------------------------------

  const SESSION_ID = '550e8400-e29b-41d4-a716-446655440099';

  function renderWithQueryClient(ui: React.ReactElement) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
  }

  it('renders session name chip with short ID when no name', () => {
    renderWithQueryClient(
      <InlineTerminalHeader {...defaultProps} sessionId={SESSION_ID} sessionName={null} />,
    );

    expect(screen.getByRole('button', { name: /Rename session/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Copy session ID/i })).toBeInTheDocument();
  });

  it('renders session name when provided', () => {
    renderWithQueryClient(
      <InlineTerminalHeader {...defaultProps} sessionId={SESSION_ID} sessionName="My Session" />,
    );

    expect(screen.getByText('My Session')).toBeInTheDocument();
  });

  it('hides session name chip when sessionId is omitted', () => {
    renderWithQueryClient(<InlineTerminalHeader {...defaultProps} />);

    expect(screen.queryByRole('button', { name: /Rename session/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy session ID/i })).not.toBeInTheDocument();
  });

  it('enters edit mode on chip click', () => {
    renderWithQueryClient(
      <InlineTerminalHeader
        {...defaultProps}
        sessionId={SESSION_ID}
        sessionName="Test"
        projectId="proj-1"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Rename session/i }));
    expect(screen.getByRole('textbox', { name: /Session name/i })).toBeInTheDocument();
  });

  it('exits edit mode on Escape', () => {
    renderWithQueryClient(
      <InlineTerminalHeader
        {...defaultProps}
        sessionId={SESSION_ID}
        sessionName="Test"
        projectId="proj-1"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Rename session/i }));
    const input = screen.getByRole('textbox', { name: /Session name/i });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: /Session name/i })).not.toBeInTheDocument();
  });

  it('truncates long session names at 16 chars', () => {
    renderWithQueryClient(
      <InlineTerminalHeader
        {...defaultProps}
        sessionId={SESSION_ID}
        sessionName="This is a very long session name"
      />,
    );

    const chipButton = screen.getByRole('button', { name: /Rename session/i });
    expect(chipButton.textContent!.length).toBeLessThanOrEqual(17);
  });

  // ---------------------------------------------------------------------------
  // Unlogged-time action and Visible Items ownership
  // ---------------------------------------------------------------------------

  const UNLOGGED_KEY = 'devchain:headerUnloggedTimeVisible';
  const CHIP_KEY = 'devchain:chipVisibleItems';

  function headerRoot(): HTMLElement {
    return document.querySelector('[tabindex="-1"]') as HTMLElement;
  }

  async function openMenu() {
    fireEvent.contextMenu(headerRoot());
    await waitFor(() => {
      expect(screen.getByText('Visible Items')).toBeInTheDocument();
    });
  }

  function renderHeader(unloggedTime?: { minutes: number; onAssign: () => void } | null) {
    return renderWithQueryClient(
      <InlineTerminalHeader
        {...defaultProps}
        agentName="Coder"
        unloggedTime={unloggedTime ?? null}
      />,
    );
  }

  beforeEach(() => {
    window.localStorage.removeItem(UNLOGGED_KEY);
    window.localStorage.removeItem(CHIP_KEY);
  });

  it('shows the unlogged action with icon, amount, exact tooltip, and aria-label', async () => {
    const onAssign = jest.fn();
    renderHeader({ minutes: 90, onAssign });

    const action = screen.getByRole('button', {
      name: /Log unlogged time to an Epic \(1h 30m\)/i,
    });
    expect(action).toHaveTextContent('1h 30m');
    expect(action.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(action.querySelector('svg')).toHaveClass('text-amber-700', 'dark:text-amber-500');

    jest.useFakeTimers();
    try {
      fireEvent.pointerMove(action);
      act(() => {
        jest.advanceTimersByTime(350);
      });
      await waitFor(() => {
        expect(screen.getAllByText('1h 30m not logged to an Epic.').length).toBeGreaterThan(0);
      });
    } finally {
      jest.useRealTimers();
    }

    fireEvent.click(action);
    expect(onAssign).toHaveBeenCalledTimes(1);
  });

  it('hides amounts below ten minutes but keeps the menu checkbox', async () => {
    renderHeader({ minutes: 9, onAssign: jest.fn() });

    expect(
      screen.queryByRole('button', { name: /Log unlogged time to an Epic/i }),
    ).not.toBeInTheDocument();

    await openMenu();
    expect(screen.getByText('Unlogged time')).toBeInTheDocument();
  });

  it('defaults the Unlogged time preference on and persists an opt-out', async () => {
    renderHeader({ minutes: 10, onAssign: jest.fn() });

    expect(
      screen.getByRole('button', { name: /Log unlogged time to an Epic/i }),
    ).toBeInTheDocument();

    await openMenu();
    fireEvent.click(screen.getByText('Unlogged time'));

    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: /Log unlogged time to an Epic/i }),
      ).not.toBeInTheDocument();
    });
    expect(window.localStorage.getItem(UNLOGGED_KEY)).toBe('false');

    // Re-enabling through the same menu restores the action.
    await openMenu();
    fireEvent.click(screen.getByText('Unlogged time'));
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Log unlogged time to an Epic/i }),
      ).toBeInTheDocument();
    });
    expect(window.localStorage.getItem(UNLOGGED_KEY)).toBe('true');
  });

  it('restores a persisted opt-out on mount', () => {
    window.localStorage.setItem(UNLOGGED_KEY, 'false');
    renderHeader({ minutes: 10, onAssign: jest.fn() });

    expect(
      screen.queryByRole('button', { name: /Log unlogged time to an Epic/i }),
    ).not.toBeInTheDocument();
  });

  it('falls back to the default when stored preferences are malformed', () => {
    window.localStorage.setItem(UNLOGGED_KEY, '{not-json');
    renderHeader({ minutes: 10, onAssign: jest.fn() });

    expect(
      screen.getByRole('button', { name: /Log unlogged time to an Epic/i }),
    ).toBeInTheDocument();
  });

  it('omits the Unlogged time checkbox when capability is not declared', async () => {
    renderHeader(null);

    await openMenu();
    expect(screen.queryByText('Unlogged time')).not.toBeInTheDocument();
  });

  it('keeps the menu reachable without metrics, amount, or visible action', async () => {
    renderHeader(null);

    await openMenu();
    expect(screen.getByText('Visible Items')).toBeInTheDocument();
  });

  it('exposes a focusable root through the connected ref', () => {
    const ref = React.createRef<HTMLDivElement>();
    renderWithQueryClient(
      <InlineTerminalHeader {...defaultProps} agentName="Coder" headerRef={ref} />,
    );

    const root = headerRoot();
    expect(root).toBe(ref.current);
    expect(root).toHaveAttribute('tabindex', '-1');

    act_focus(root);
    expect(document.activeElement).toBe(root);
  });

  it('opens the Visible Items menu with Shift+F10 from the root', async () => {
    renderHeader({ minutes: 10, onAssign: jest.fn() });

    fireEvent.keyDown(headerRoot(), { key: 'F10', shiftKey: true });
    await waitFor(() => {
      expect(screen.getByText('Visible Items')).toBeInTheDocument();
    });
  });

  it('stays axe-clean with the unlogged action present', async () => {
    const { container } = renderHeader({ minutes: 10, onAssign: jest.fn() });

    expect(await axe(container)).toHaveNoViolations();
  });
});

function act_focus(element: HTMLElement) {
  element.focus();
}

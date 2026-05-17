import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InlineTerminalHeader } from './InlineTerminalHeader';

jest.mock('@/ui/components/session-reader/InlineSessionSummaryChip', () => ({
  InlineSessionSummaryChip: (props: Record<string, unknown>) => (
    <div data-testid="session-chip" data-active-tab={props.activeTab} />
  ),
}));

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
});

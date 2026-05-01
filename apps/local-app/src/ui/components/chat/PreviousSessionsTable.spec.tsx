import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { PreviousSessionsTable } from './PreviousSessionsTable';
import type { SessionHistoryItem } from '@/ui/hooks/useAgentSessionHistory';

// Mock the hook so the component never makes real fetch calls
jest.mock('@/ui/hooks/useAgentSessionHistory');

// Mock useToast — we only care that it's callable, not that toasts render
jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

import { useAgentSessionHistory } from '@/ui/hooks/useAgentSessionHistory';
const mockUseAgentSessionHistory = useAgentSessionHistory as jest.MockedFunction<
  typeof useAgentSessionHistory
>;

function makeItem(overrides: Partial<SessionHistoryItem> = {}): SessionHistoryItem {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    providerSessionId: null,
    providerNameAtLaunch: 'claude',
    status: 'stopped',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T01:00:00.000Z',
    lastActivityAt: '2026-01-01T00:55:00.000Z',
    sizeBytes: 2048,
    transcriptAvailable: true,
    ...overrides,
  };
}

function defaultHookReturn(
  overrides: Partial<ReturnType<typeof useAgentSessionHistory>> = {},
): ReturnType<typeof useAgentSessionHistory> {
  return {
    items: [],
    total: 0,
    hasMore: false,
    isLoading: false,
    isFetchingMore: false,
    isError: false,
    loadMore: jest.fn() as unknown as ReturnType<typeof useAgentSessionHistory>['loadMore'],
    refetch: jest.fn() as unknown as ReturnType<typeof useAgentSessionHistory>['refetch'],
    ...overrides,
  };
}

describe('PreviousSessionsTable', () => {
  const onRead = jest.fn();
  const onRestore = jest.fn();

  const defaultProps = {
    agentId: 'agent-1',
    projectId: 'project-1',
    onRead,
    onRestore,
    currentProviderName: 'claude',
    restoringSessionIds: {},
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAgentSessionHistory.mockReturnValue(defaultHookReturn());
  });

  it('renders skeleton rows while loading', () => {
    mockUseAgentSessionHistory.mockReturnValue(defaultHookReturn({ isLoading: true }));
    const { container } = render(<PreviousSessionsTable {...defaultProps} />);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('shows inline error state with retry button when isError', () => {
    mockUseAgentSessionHistory.mockReturnValue(defaultHookReturn({ isError: true }));
    render(<PreviousSessionsTable {...defaultProps} />);
    expect(screen.getByText(/Failed to load previous sessions/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('calls refetch when retry button is clicked', () => {
    const refetch = jest.fn();
    mockUseAgentSessionHistory.mockReturnValue(
      defaultHookReturn({
        isError: true,
        refetch: refetch as unknown as ReturnType<typeof useAgentSessionHistory>['refetch'],
      }),
    );
    render(<PreviousSessionsTable {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('shows empty state when items is empty', () => {
    render(<PreviousSessionsTable {...defaultProps} />);
    expect(screen.getByText(/No previous sessions for this agent yet/i)).toBeInTheDocument();
  });

  it('renders a row for each item', () => {
    const items = [
      makeItem({ id: '00000000-0000-0000-0000-000000000001' }),
      makeItem({ id: '00000000-0000-0000-0000-000000000002', sizeBytes: null }),
    ];
    mockUseAgentSessionHistory.mockReturnValue(defaultHookReturn({ items, total: 2 }));
    render(<PreviousSessionsTable {...defaultProps} />);
    expect(screen.getByText('00000000…0001')).toBeInTheDocument();
    expect(screen.getByText('00000000…0002')).toBeInTheDocument();
  });

  it('shows — for null sizeBytes', () => {
    const items = [makeItem({ sizeBytes: null })];
    mockUseAgentSessionHistory.mockReturnValue(defaultHookReturn({ items, total: 1 }));
    render(<PreviousSessionsTable {...defaultProps} />);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('calls onRead with the session ID when the eye button is clicked', () => {
    const sessionId = '00000000-0000-0000-0000-000000000099';
    const items = [
      makeItem({ id: sessionId, transcriptAvailable: true, providerSessionId: 'prov-1' }),
    ];
    mockUseAgentSessionHistory.mockReturnValue(defaultHookReturn({ items, total: 1 }));
    render(<PreviousSessionsTable {...defaultProps} />);
    fireEvent.click(screen.getByTitle('Read transcript'));
    expect(onRead).toHaveBeenCalledWith(sessionId);
  });

  it('does not render a Read button when transcriptAvailable is false', () => {
    const items = [makeItem({ transcriptAvailable: false })];
    mockUseAgentSessionHistory.mockReturnValue(defaultHookReturn({ items, total: 1 }));
    render(<PreviousSessionsTable {...defaultProps} />);
    expect(screen.queryByTitle('Read transcript')).not.toBeInTheDocument();
  });

  it('shows Load more button when hasMore is true', () => {
    const items = [makeItem()];
    mockUseAgentSessionHistory.mockReturnValue(
      defaultHookReturn({ items, total: 5, hasMore: true }),
    );
    render(<PreviousSessionsTable {...defaultProps} />);
    expect(screen.getByRole('button', { name: /load more/i })).toBeInTheDocument();
  });

  it('calls loadMore when Load more is clicked', () => {
    const loadMore = jest.fn();
    const items = [makeItem()];
    mockUseAgentSessionHistory.mockReturnValue(
      defaultHookReturn({
        items,
        total: 5,
        hasMore: true,
        loadMore: loadMore as unknown as ReturnType<typeof useAgentSessionHistory>['loadMore'],
      }),
    );
    render(<PreviousSessionsTable {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it('hides Load more button when hasMore is false', () => {
    const items = [makeItem()];
    mockUseAgentSessionHistory.mockReturnValue(
      defaultHookReturn({ items, total: 1, hasMore: false }),
    );
    render(<PreviousSessionsTable {...defaultProps} />);
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
  });

  // -----------------------------------------------------------------------
  // Restore button
  // -----------------------------------------------------------------------

  it('calls onRestore with session ID when Restore button is clicked', () => {
    const sessionId = '00000000-0000-0000-0000-000000000042';
    const items = [
      makeItem({ id: sessionId, providerSessionId: 'prov-42', providerNameAtLaunch: 'claude' }),
    ];
    mockUseAgentSessionHistory.mockReturnValue(defaultHookReturn({ items, total: 1 }));
    render(<PreviousSessionsTable {...defaultProps} currentProviderName="claude" />);
    fireEvent.click(screen.getByRole('button', { name: /restore session/i }));
    expect(onRestore).toHaveBeenCalledWith(sessionId);
  });

  it('disables Restore button when providerSessionId is null', () => {
    const items = [makeItem({ providerSessionId: null })];
    mockUseAgentSessionHistory.mockReturnValue(defaultHookReturn({ items, total: 1 }));
    render(<PreviousSessionsTable {...defaultProps} />);
    const btn = screen.getByRole('button', { name: /cannot restore/i });
    expect(btn).toBeDisabled();
  });

  it('disables Restore button when provider has changed', () => {
    const items = [makeItem({ providerSessionId: 'prov-1', providerNameAtLaunch: 'claude' })];
    mockUseAgentSessionHistory.mockReturnValue(defaultHookReturn({ items, total: 1 }));
    render(<PreviousSessionsTable {...defaultProps} currentProviderName="gemini" />);
    const btn = screen.getByRole('button', { name: /cannot restore/i });
    expect(btn).toBeDisabled();
  });

  it('enables Restore button when provider names match case-insensitively (Claude vs claude)', () => {
    const items = [makeItem({ providerSessionId: 'prov-1', providerNameAtLaunch: 'claude' })];
    mockUseAgentSessionHistory.mockReturnValue(defaultHookReturn({ items, total: 1 }));
    render(<PreviousSessionsTable {...defaultProps} currentProviderName="Claude" />);
    const btn = screen.getByRole('button', { name: /restore session/i });
    expect(btn).not.toBeDisabled();
  });

  it('shows spinner on Restore button when session is restoring', () => {
    const sessionId = '00000000-0000-0000-0000-000000000055';
    const items = [
      makeItem({ id: sessionId, providerSessionId: 'prov-55', providerNameAtLaunch: 'claude' }),
    ];
    mockUseAgentSessionHistory.mockReturnValue(defaultHookReturn({ items, total: 1 }));
    render(
      <PreviousSessionsTable
        {...defaultProps}
        currentProviderName="claude"
        restoringSessionIds={{ [sessionId]: true }}
      />,
    );
    const btn = screen.getByRole('button', { name: /restore session/i });
    expect(btn).toBeDisabled();
    // spinner svg should be present (animate-spin class)
    expect(btn.querySelector('.animate-spin')).toBeInTheDocument();
  });
});

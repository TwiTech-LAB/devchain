import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { PreviousSessionsTable } from './PreviousSessionsTable';
import type { SessionHistoryItem } from '@/ui/hooks/useAgentSessionHistory';

// Mock the hook so the component never makes real fetch calls
jest.mock('@/ui/hooks/useAgentSessionHistory');

jest.mock('@/ui/lib/sessions', () => ({
  renameSession: jest.fn(),
  deleteSessionHistoryItem: jest.fn(),
}));

jest.mock('@tanstack/react-query', () => {
  const actual = jest.requireActual('@tanstack/react-query');
  return {
    ...actual,
    useMutation: (config: Record<string, unknown>) => ({
      mutate: (vars: Record<string, unknown>) => {
        const onMutate = config?.onMutate as (() => unknown) | undefined;
        const onSuccess = config?.onSuccess as
          | ((data: unknown, vars: Record<string, unknown>) => unknown)
          | undefined;
        if (onMutate) onMutate();
        if (onSuccess) onSuccess({}, vars);
      },
      mutateAsync: jest.fn(),
      isPending: false,
      isLoading: false,
      isError: false,
    }),
    useQueryClient: () => ({
      cancelQueries: jest.fn(),
      getQueriesData: jest.fn(() => []),
      setQueryData: jest.fn(),
      invalidateQueries: jest.fn().mockResolvedValue(undefined),
    }),
  };
});

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
    name: null,
    ...overrides,
  };
}

function defaultHookReturn(
  overrides: Partial<ReturnType<typeof useAgentSessionHistory>> = {},
): ReturnType<typeof useAgentSessionHistory> {
  return {
    items: [],
    total: 0,
    currentPage: 1,
    totalPages: 1,
    hasNext: false,
    hasPrev: false,
    isLoading: false,
    isFetching: false,
    isError: false,
    goNext: jest.fn(),
    goPrev: jest.fn(),
    resetToFirstPage: jest.fn(),
    refetch: jest.fn(),
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
        refetch,
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

  it('shows pagination footer with Page X of Y', () => {
    const items = [makeItem()];
    mockUseAgentSessionHistory.mockReturnValue(
      defaultHookReturn({ items, total: 5, currentPage: 1, totalPages: 3, hasNext: true }),
    );
    render(<PreviousSessionsTable {...defaultProps} />);
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
  });

  it('calls goNext when Next button is clicked', () => {
    const goNext = jest.fn();
    const items = [makeItem()];
    mockUseAgentSessionHistory.mockReturnValue(
      defaultHookReturn({
        items,
        total: 5,
        currentPage: 1,
        totalPages: 3,
        hasNext: true,
        goNext,
      }),
    );
    render(<PreviousSessionsTable {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(goNext).toHaveBeenCalledTimes(1);
  });

  it('calls goPrev when Prev button is clicked', () => {
    const goPrev = jest.fn();
    const items = [makeItem()];
    mockUseAgentSessionHistory.mockReturnValue(
      defaultHookReturn({
        items,
        total: 5,
        currentPage: 2,
        totalPages: 3,
        hasPrev: true,
        goPrev,
      }),
    );
    render(<PreviousSessionsTable {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /prev/i }));
    expect(goPrev).toHaveBeenCalledTimes(1);
  });

  it('disables Prev on page 1 and Next on last page', () => {
    const items = [makeItem()];
    mockUseAgentSessionHistory.mockReturnValue(
      defaultHookReturn({
        items,
        total: 1,
        currentPage: 1,
        totalPages: 1,
        hasPrev: false,
        hasNext: false,
      }),
    );
    render(<PreviousSessionsTable {...defaultProps} />);
    expect(screen.getByRole('button', { name: /prev/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();
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

  // -----------------------------------------------------------------------
  // Inline rename
  // -----------------------------------------------------------------------

  it('shows short ID when name is null', () => {
    const items = [makeItem({ id: '00000000-0000-0000-0000-000000000001', name: null })];
    mockUseAgentSessionHistory.mockReturnValue(defaultHookReturn({ items, total: 1 }));
    render(<PreviousSessionsTable {...defaultProps} />);
    expect(screen.getByText('00000000…0001')).toBeInTheDocument();
  });

  it('shows provider session ID when captured', () => {
    const items = [
      makeItem({
        id: '00000000-0000-0000-0000-000000000001',
        providerSessionId: '019e210d-408b-7c42-a48a-6854a9ce161a',
        name: null,
      }),
    ];
    mockUseAgentSessionHistory.mockReturnValue(defaultHookReturn({ items, total: 1 }));
    render(<PreviousSessionsTable {...defaultProps} />);
    expect(screen.getByText('019e210d…161a')).toBeInTheDocument();
    expect(screen.queryByText('00000000…0001')).not.toBeInTheDocument();
  });

  it('shows name when set', () => {
    const items = [makeItem({ id: '00000000-0000-0000-0000-000000000001', name: 'My Session' })];
    mockUseAgentSessionHistory.mockReturnValue(defaultHookReturn({ items, total: 1 }));
    render(<PreviousSessionsTable {...defaultProps} />);
    expect(screen.getByText('My Session')).toBeInTheDocument();
  });

  it('clicking session cell opens inline input for rename', () => {
    const items = [makeItem({ name: 'Old Name' })];
    mockUseAgentSessionHistory.mockReturnValue(defaultHookReturn({ items, total: 1 }));
    render(<PreviousSessionsTable {...defaultProps} />);
    fireEvent.click(screen.getByText('Old Name'));
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.value).toBe('Old Name');
  });

  it('Escape cancels edit without saving', () => {
    const items = [makeItem({ name: 'Original' })];
    mockUseAgentSessionHistory.mockReturnValue(defaultHookReturn({ items, total: 1 }));
    render(<PreviousSessionsTable {...defaultProps} />);
    fireEvent.click(screen.getByText('Original'));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Changed' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.getByText('Original')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  // -----------------------------------------------------------------------
  // Copy session ID button
  // -----------------------------------------------------------------------

  it('renders Copy button in every row', () => {
    const items = [makeItem()];
    mockUseAgentSessionHistory.mockReturnValue(defaultHookReturn({ items, total: 1 }));
    render(<PreviousSessionsTable {...defaultProps} />);
    expect(screen.getByRole('button', { name: /copy session id/i })).toBeInTheDocument();
  });

  it('copies full UUID to clipboard on click', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const items = [makeItem({ id: 'full-uuid-1234' })];
    mockUseAgentSessionHistory.mockReturnValue(defaultHookReturn({ items, total: 1 }));
    render(<PreviousSessionsTable {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /copy session id/i }));
    expect(writeText).toHaveBeenCalledWith('full-uuid-1234');
  });

  it('copies provider session ID when captured', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const items = [
      makeItem({
        id: 'devchain-session-id',
        providerSessionId: 'provider-session-id',
      }),
    ];
    mockUseAgentSessionHistory.mockReturnValue(defaultHookReturn({ items, total: 1 }));
    render(<PreviousSessionsTable {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /copy session id/i }));
    expect(writeText).toHaveBeenCalledWith('provider-session-id');
  });

  // -----------------------------------------------------------------------
  // Delete session record
  // -----------------------------------------------------------------------

  it('renders Delete button in every row', () => {
    const items = [makeItem()];
    mockUseAgentSessionHistory.mockReturnValue(defaultHookReturn({ items, total: 1 }));
    render(<PreviousSessionsTable {...defaultProps} />);
    expect(screen.getByRole('button', { name: /delete session record/i })).toBeInTheDocument();
  });

  it('opens confirmation dialog when Delete button is clicked', () => {
    const items = [makeItem()];
    mockUseAgentSessionHistory.mockReturnValue(defaultHookReturn({ items, total: 1 }));
    render(<PreviousSessionsTable {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /delete session record/i }));
    expect(screen.getByText('Delete session record')).toBeInTheDocument();
    expect(screen.getByText(/removes the session from DevChain/i)).toBeInTheDocument();
  });

  it('Cancel closes the dialog without calling delete', () => {
    const items = [makeItem()];
    mockUseAgentSessionHistory.mockReturnValue(defaultHookReturn({ items, total: 1 }));
    render(<PreviousSessionsTable {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /delete session record/i }));
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(screen.queryByText('Delete session record')).not.toBeInTheDocument();
  });

  // -----------------------------------------------------------------------
  // Delete page-step-back regression (remediation cf31eda4)
  //
  // Verifies that deleting the sole row on page 2+ passes wasLastOnPage=true
  // through the mutation so that onSuccess calls goPrev() instead of the
  // old stale-closure goToPageOnDelete().
  // -----------------------------------------------------------------------

  it('calls goPrev when deleting sole row on page 2+', async () => {
    const goPrev = jest.fn();
    const item = makeItem({ id: 'sole-item-on-page-2' });
    mockUseAgentSessionHistory.mockReturnValue(
      defaultHookReturn({
        items: [item],
        total: 21,
        currentPage: 2,
        totalPages: 2,
        hasPrev: true,
        goPrev,
      }),
    );
    render(<PreviousSessionsTable {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /delete session record/i }));
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    await new Promise((r) => setTimeout(r, 0));

    expect(goPrev).toHaveBeenCalledTimes(1);
  });

  it('does not call goPrev when deleting a row on page 1', async () => {
    const goPrev = jest.fn();
    const item = makeItem({ id: 'item-on-page-1' });
    mockUseAgentSessionHistory.mockReturnValue(
      defaultHookReturn({
        items: [item],
        total: 1,
        currentPage: 1,
        totalPages: 1,
        goPrev,
      }),
    );
    render(<PreviousSessionsTable {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /delete session record/i }));
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    await new Promise((r) => setTimeout(r, 0));

    expect(goPrev).not.toHaveBeenCalled();
  });

  it('does not call goPrev when deleting a non-last row on page 2+', async () => {
    const goPrev = jest.fn();
    const items = [makeItem({ id: 'item-a' }), makeItem({ id: 'item-b' })];
    mockUseAgentSessionHistory.mockReturnValue(
      defaultHookReturn({
        items,
        total: 22,
        currentPage: 2,
        totalPages: 2,
        hasPrev: true,
        goPrev,
      }),
    );
    render(<PreviousSessionsTable {...defaultProps} />);
    fireEvent.click(screen.getAllByRole('button', { name: /delete session record/i })[0]);
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    await new Promise((r) => setTimeout(r, 0));

    expect(goPrev).not.toHaveBeenCalled();
  });
});

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TerminalDock } from './TerminalDock';
import type { TerminalWindowState } from '@/ui/terminal-windows';
import type { ActiveSession } from '@/ui/lib/sessions';

// Mock useTerminalWindows hook
const mockRestoreWindow = jest.fn();
const mockFocusWindow = jest.fn();
const mockMinimizeWindow = jest.fn();
let mockWindows: TerminalWindowState[] = [];
let mockFocusedWindowId: string | null = null;

jest.mock('@/ui/terminal-windows', () => ({
  useTerminalWindows: () => ({
    windows: mockWindows,
    focusedWindowId: mockFocusedWindowId,
    restoreWindow: mockRestoreWindow,
    focusWindow: mockFocusWindow,
    minimizeWindow: mockMinimizeWindow,
  }),
}));

// Mock useSelectedProject hook
jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({
    selectedProjectId: 'test-project-id',
  }),
}));

// Mock useToast hook
jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({
    toast: jest.fn(),
  }),
}));

// Mock sessions API to prevent actual network calls
const mockFetchAgentSummary = jest.fn().mockResolvedValue({ id: 'agent-1', name: 'Test Agent' });
jest.mock('@/ui/lib/sessions', () => ({
  fetchActiveSessions: jest.fn().mockResolvedValue([]),
  fetchAgentSummary: (...args: unknown[]) => mockFetchAgentSummary(...args),
  terminateSession: jest.fn().mockResolvedValue(undefined),
}));

function createMockSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    id: 'session-1',
    epicId: null,
    agentId: null,
    tmuxSessionId: null,
    status: 'running',
    startedAt: new Date().toISOString(),
    endedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockWindow(overrides: Partial<TerminalWindowState> = {}): TerminalWindowState {
  return {
    id: 'window-1',
    title: 'Test Window',
    sessionId: 'session-1',
    minimized: false,
    maximized: false,
    zIndex: 1000,
    bounds: { x: 0, y: 0, width: 720, height: 420 },
    content: null,
    details: [{ label: 'Agent', value: 'TestAgent' }],
    ...overrides,
  };
}

function renderWithQueryClient(ui: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

const defaultProps = {
  expanded: false,
  sessions: [] as ActiveSession[],
  activeSessionId: null,
  openSessionIds: [] as string[],
  onToggle: jest.fn(),
  onOpenSession: jest.fn(),
  onSessionsChange: jest.fn(),
  onSessionTerminated: jest.fn(),
};

describe('TerminalDock collapsed bar pills', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWindows = [];
    mockFocusedWindowId = null;
  });

  describe('Pills render for open windows', () => {
    it('renders pills for each open terminal window with correct agent names', () => {
      const session1 = createMockSession({ id: 'session-1', status: 'running' });
      const session2 = createMockSession({ id: 'session-2', status: 'running' });

      mockWindows = [
        createMockWindow({
          id: 'window-1',
          sessionId: 'session-1',
          minimized: false,
          details: [{ label: 'Agent', value: 'Agent One' }],
        }),
        createMockWindow({
          id: 'window-2',
          sessionId: 'session-2',
          minimized: true,
          details: [{ label: 'Agent', value: 'Agent Two' }],
        }),
      ];

      renderWithQueryClient(
        <TerminalDock {...defaultProps} expanded={false} sessions={[session1, session2]} />,
      );

      // Both pills should render with agent names
      expect(screen.getByText('Agent One')).toBeInTheDocument();
      expect(screen.getByText('Agent Two')).toBeInTheDocument();
    });

    it('falls back to subtitle when Agent detail not found', () => {
      const session = createMockSession({ id: 'session-1' });

      mockWindows = [
        createMockWindow({
          id: 'window-1',
          sessionId: 'session-1',
          subtitle: 'Subtitle Agent',
          details: [], // No Agent detail
        }),
      ];

      renderWithQueryClient(
        <TerminalDock {...defaultProps} expanded={false} sessions={[session]} />,
      );

      expect(screen.getByText('Subtitle Agent')).toBeInTheDocument();
    });

    it('falls back to session ID prefix when no agent name or subtitle', () => {
      const session = createMockSession({ id: 'abcd1234-5678-9abc-def0-123456789abc' });

      mockWindows = [
        createMockWindow({
          id: 'window-1',
          sessionId: 'abcd1234-5678-9abc-def0-123456789abc',
          subtitle: undefined,
          details: [],
        }),
      ];

      renderWithQueryClient(
        <TerminalDock {...defaultProps} expanded={false} sessions={[session]} />,
      );

      expect(screen.getByText('abcd1234')).toBeInTheDocument();
    });
  });

  describe('Focused window pill styling', () => {
    it('has aria-pressed="true" for focused visible window', () => {
      const session = createMockSession({ id: 'session-1' });

      mockWindows = [
        createMockWindow({
          id: 'window-1',
          sessionId: 'session-1',
          minimized: false,
          details: [{ label: 'Agent', value: 'Focused Agent' }],
        }),
      ];
      mockFocusedWindowId = 'window-1';

      renderWithQueryClient(
        <TerminalDock {...defaultProps} expanded={false} sessions={[session]} />,
      );

      const pill = screen.getByRole('button', { name: /focused agent/i });
      expect(pill).toHaveAttribute('aria-pressed', 'true');
    });

    it('has primary styling classes for focused window', () => {
      const session = createMockSession({ id: 'session-1' });

      mockWindows = [
        createMockWindow({
          id: 'window-1',
          sessionId: 'session-1',
          minimized: false,
          details: [{ label: 'Agent', value: 'Focused Agent' }],
        }),
      ];
      mockFocusedWindowId = 'window-1';

      renderWithQueryClient(
        <TerminalDock {...defaultProps} expanded={false} sessions={[session]} />,
      );

      const pill = screen.getByRole('button', { name: /focused agent/i });
      expect(pill).toHaveClass('bg-primary');
      expect(pill).toHaveClass('text-primary-foreground');
    });
  });

  describe('Visible but not focused window pill styling', () => {
    it('has aria-pressed="false" for visible but not focused window', () => {
      const session = createMockSession({ id: 'session-1' });

      mockWindows = [
        createMockWindow({
          id: 'window-1',
          sessionId: 'session-1',
          minimized: false,
          details: [{ label: 'Agent', value: 'Visible Agent' }],
        }),
      ];
      mockFocusedWindowId = null; // Not focused

      renderWithQueryClient(
        <TerminalDock {...defaultProps} expanded={false} sessions={[session]} />,
      );

      const pill = screen.getByRole('button', { name: /visible agent/i });
      expect(pill).toHaveAttribute('aria-pressed', 'false');
    });

    it('has secondary styling classes for visible but not focused window', () => {
      const session = createMockSession({ id: 'session-1' });

      mockWindows = [
        createMockWindow({
          id: 'window-1',
          sessionId: 'session-1',
          minimized: false,
          details: [{ label: 'Agent', value: 'Visible Agent' }],
        }),
      ];
      mockFocusedWindowId = null; // Not focused

      renderWithQueryClient(
        <TerminalDock {...defaultProps} expanded={false} sessions={[session]} />,
      );

      const pill = screen.getByRole('button', { name: /visible agent/i });
      expect(pill).toHaveClass('bg-secondary');
      expect(pill).toHaveClass('text-secondary-foreground');
    });
  });

  describe('Minimized window pill styling', () => {
    it('has aria-pressed="false" for minimized window', () => {
      const session = createMockSession({ id: 'session-1' });

      mockWindows = [
        createMockWindow({
          id: 'window-1',
          sessionId: 'session-1',
          minimized: true,
          details: [{ label: 'Agent', value: 'Minimized Agent' }],
        }),
      ];

      renderWithQueryClient(
        <TerminalDock {...defaultProps} expanded={false} sessions={[session]} />,
      );

      const pill = screen.getByRole('button', { name: /minimized agent/i });
      expect(pill).toHaveAttribute('aria-pressed', 'false');
    });

    it('has muted styling classes for minimized window', () => {
      const session = createMockSession({ id: 'session-1' });

      mockWindows = [
        createMockWindow({
          id: 'window-1',
          sessionId: 'session-1',
          minimized: true,
          details: [{ label: 'Agent', value: 'Minimized Agent' }],
        }),
      ];

      renderWithQueryClient(
        <TerminalDock {...defaultProps} expanded={false} sessions={[session]} />,
      );

      const pill = screen.getByRole('button', { name: /minimized agent/i });
      expect(pill).toHaveClass('bg-muted');
    });
  });

  describe('Click minimized pill calls restoreWindow', () => {
    it('calls restoreWindow with window ID when clicking minimized pill', () => {
      const session = createMockSession({ id: 'session-1' });

      mockWindows = [
        createMockWindow({
          id: 'window-abc',
          sessionId: 'session-1',
          minimized: true,
          details: [{ label: 'Agent', value: 'Click Me Agent' }],
        }),
      ];

      renderWithQueryClient(
        <TerminalDock {...defaultProps} expanded={false} sessions={[session]} />,
      );

      const pill = screen.getByRole('button', { name: /click me agent/i });
      fireEvent.click(pill);

      expect(mockRestoreWindow).toHaveBeenCalledTimes(1);
      expect(mockRestoreWindow).toHaveBeenCalledWith('window-abc');
      expect(mockFocusWindow).not.toHaveBeenCalled();
      expect(mockMinimizeWindow).not.toHaveBeenCalled();
    });
  });

  describe('Click visible but not focused pill calls focusWindow', () => {
    it('calls focusWindow with window ID when clicking visible but not focused pill', () => {
      const session = createMockSession({ id: 'session-1' });

      mockWindows = [
        createMockWindow({
          id: 'window-xyz',
          sessionId: 'session-1',
          minimized: false,
          details: [{ label: 'Agent', value: 'Focus Me Agent' }],
        }),
      ];
      mockFocusedWindowId = null; // Not focused

      renderWithQueryClient(
        <TerminalDock {...defaultProps} expanded={false} sessions={[session]} />,
      );

      const pill = screen.getByRole('button', { name: /focus me agent/i });
      fireEvent.click(pill);

      expect(mockFocusWindow).toHaveBeenCalledTimes(1);
      expect(mockFocusWindow).toHaveBeenCalledWith('window-xyz');
      expect(mockRestoreWindow).not.toHaveBeenCalled();
      expect(mockMinimizeWindow).not.toHaveBeenCalled();
    });
  });

  describe('Click focused pill calls minimizeWindow', () => {
    it('calls minimizeWindow with window ID when clicking focused pill', () => {
      const session = createMockSession({ id: 'session-1' });

      mockWindows = [
        createMockWindow({
          id: 'window-focused',
          sessionId: 'session-1',
          minimized: false,
          details: [{ label: 'Agent', value: 'Focused Agent' }],
        }),
      ];
      mockFocusedWindowId = 'window-focused'; // This window is focused

      renderWithQueryClient(
        <TerminalDock {...defaultProps} expanded={false} sessions={[session]} />,
      );

      const pill = screen.getByRole('button', { name: /focused agent/i });
      fireEvent.click(pill);

      expect(mockMinimizeWindow).toHaveBeenCalledTimes(1);
      expect(mockMinimizeWindow).toHaveBeenCalledWith('window-focused');
      expect(mockFocusWindow).not.toHaveBeenCalled();
      expect(mockRestoreWindow).not.toHaveBeenCalled();
    });
  });

  describe('No pills when no open windows', () => {
    it('renders no pills when no terminal windows are open', () => {
      const session = createMockSession({ id: 'session-1' });
      mockWindows = [];

      renderWithQueryClient(
        <TerminalDock {...defaultProps} expanded={false} sessions={[session]} />,
      );

      // Summary text should exist (new format: "N sessions")
      expect(screen.getByText('1 session')).toBeInTheDocument();

      // No pill buttons should exist (only the header toggle button)
      const buttons = screen.getAllByRole('button');
      expect(buttons).toHaveLength(1); // Only the header toggle button
      expect(buttons[0]).toHaveAttribute('aria-expanded', 'false');
    });

    it('renders no pills when windows exist but none have sessionId', () => {
      mockWindows = [
        createMockWindow({
          id: 'window-1',
          sessionId: undefined, // No sessionId
          details: [{ label: 'Agent', value: 'No Session' }],
        }),
      ];

      renderWithQueryClient(<TerminalDock {...defaultProps} expanded={false} sessions={[]} />);

      // No pill buttons should exist
      const buttons = screen.getAllByRole('button');
      expect(buttons).toHaveLength(1); // Only the header toggle button
    });
  });

  describe('Status dot colors', () => {
    it('shows green status dot for running session', () => {
      const session = createMockSession({ id: 'session-1', status: 'running' });

      mockWindows = [
        createMockWindow({
          id: 'window-1',
          sessionId: 'session-1',
          details: [{ label: 'Agent', value: 'Running Agent' }],
        }),
      ];

      renderWithQueryClient(
        <TerminalDock {...defaultProps} expanded={false} sessions={[session]} />,
      );

      const pill = screen.getByRole('button', { name: /running agent/i });
      const statusDot = pill.querySelector('span.rounded-full');
      expect(statusDot).toHaveClass('bg-emerald-500');
    });

    it('shows gray status dot for non-running session', () => {
      const session = createMockSession({ id: 'session-1', status: 'stopped' });

      mockWindows = [
        createMockWindow({
          id: 'window-1',
          sessionId: 'session-1',
          details: [{ label: 'Agent', value: 'Stopped Agent' }],
        }),
      ];

      renderWithQueryClient(
        <TerminalDock {...defaultProps} expanded={false} sessions={[session]} />,
      );

      const pill = screen.getByRole('button', { name: /stopped agent/i });
      const statusDot = pill.querySelector('span.rounded-full');
      expect(statusDot).toHaveClass('bg-muted-foreground');
    });
  });

  describe('Provider icon rendering', () => {
    it('renders provider icon when providerIcon detail exists', () => {
      const session = createMockSession({ id: 'session-1' });
      const mockIconUri = 'data:image/svg+xml;base64,abc123';

      mockWindows = [
        createMockWindow({
          id: 'window-1',
          sessionId: 'session-1',
          details: [
            { label: 'Agent', value: 'Agent With Icon' },
            { label: 'providerIcon', value: mockIconUri },
          ],
        }),
      ];

      renderWithQueryClient(
        <TerminalDock {...defaultProps} expanded={false} sessions={[session]} />,
      );

      const pill = screen.getByRole('button', { name: /agent with icon/i });
      const img = pill.querySelector('img');
      expect(img).toBeInTheDocument();
      expect(img).toHaveAttribute('src', mockIconUri);
    });

    it('does not render img when providerIcon detail is missing', () => {
      const session = createMockSession({ id: 'session-1' });

      mockWindows = [
        createMockWindow({
          id: 'window-1',
          sessionId: 'session-1',
          details: [{ label: 'Agent', value: 'Agent No Icon' }],
        }),
      ];

      renderWithQueryClient(
        <TerminalDock {...defaultProps} expanded={false} sessions={[session]} />,
      );

      const pill = screen.getByRole('button', { name: /agent no icon/i });
      const img = pill.querySelector('img');
      expect(img).not.toBeInTheDocument();
    });
  });

  describe('Label status dot indicator', () => {
    it('shows green status dot when data loaded (not fetching, no error)', async () => {
      mockWindows = [];

      renderWithQueryClient(<TerminalDock {...defaultProps} expanded={false} sessions={[]} />);

      // Wait for query to settle and find the status dot (● character)
      await waitFor(() => {
        const statusDot = screen.getByText('●');
        expect(statusDot).toHaveClass('text-emerald-500');
      });
    });

    it('shows label in "N sessions" format', () => {
      const sessions = [
        createMockSession({ id: 'session-1' }),
        createMockSession({ id: 'session-2' }),
        createMockSession({ id: 'session-3' }),
      ];
      mockWindows = [];

      renderWithQueryClient(
        <TerminalDock {...defaultProps} expanded={false} sessions={sessions} />,
      );

      expect(screen.getByText('3 sessions')).toBeInTheDocument();
    });

    it('shows singular "session" for single session', () => {
      const session = createMockSession({ id: 'session-1' });
      mockWindows = [];

      renderWithQueryClient(
        <TerminalDock {...defaultProps} expanded={false} sessions={[session]} />,
      );

      expect(screen.getByText('1 session')).toBeInTheDocument();
    });

    it('shows "0 sessions" when no sessions exist', () => {
      mockWindows = [];

      renderWithQueryClient(<TerminalDock {...defaultProps} expanded={false} sessions={[]} />);

      expect(screen.getByText('0 sessions')).toBeInTheDocument();
    });
  });

  describe('Double-click to toggle', () => {
    it('calls onToggle when double-clicking on header bar', async () => {
      const user = userEvent.setup();
      const onToggle = jest.fn();
      mockWindows = [];

      renderWithQueryClient(
        <TerminalDock {...defaultProps} expanded={false} sessions={[]} onToggle={onToggle} />,
      );

      // Find the header bar container (h-12 div)
      const headerBar = screen.getByLabelText('Terminal session dock').firstChild as Element;
      await user.dblClick(headerBar);

      // userEvent.dblClick fires: click(detail=1) → click(detail=2) → dblclick
      // Header bar only has onDoubleClick, no onClick, so only dblclick triggers onToggle
      expect(onToggle).toHaveBeenCalledTimes(1);
    });

    it('works in both directions: collapsed to expanded', async () => {
      const user = userEvent.setup();
      const onToggle = jest.fn();
      mockWindows = [];

      renderWithQueryClient(
        <TerminalDock {...defaultProps} expanded={false} sessions={[]} onToggle={onToggle} />,
      );

      const headerBar = screen.getByLabelText('Terminal session dock').firstChild as Element;
      await user.dblClick(headerBar);

      expect(onToggle).toHaveBeenCalledTimes(1);
    });

    it('works in both directions: expanded to collapsed', async () => {
      const user = userEvent.setup();
      const onToggle = jest.fn();
      mockWindows = [];

      renderWithQueryClient(
        <TerminalDock {...defaultProps} expanded={true} sessions={[]} onToggle={onToggle} />,
      );

      const headerBar = screen.getByLabelText('Terminal session dock').firstChild as Element;
      await user.dblClick(headerBar);

      expect(onToggle).toHaveBeenCalledTimes(1);
    });

    it('does NOT double-toggle when double-clicking on header toggle button', async () => {
      const user = userEvent.setup();
      const onToggle = jest.fn();
      mockWindows = [];

      renderWithQueryClient(
        <TerminalDock {...defaultProps} expanded={false} sessions={[]} onToggle={onToggle} />,
      );

      const toggleButton = screen.getByRole('button', { name: /expand terminal dock/i });
      await user.dblClick(toggleButton);

      // userEvent.dblClick fires: click(detail=1) → click(detail=2) → dblclick
      // Each click triggers onToggle, but header onDoubleClick is guarded by closest('button')
      // Result: 2 toggles from the two clicks (but no extra from dblclick event)
      expect(onToggle).toHaveBeenCalledTimes(2);
    });

    it('does NOT call header onToggle when double-clicking on session pill', async () => {
      const user = userEvent.setup();
      const onToggle = jest.fn();
      const session = createMockSession({ id: 'session-1' });

      mockWindows = [
        createMockWindow({
          id: 'window-1',
          sessionId: 'session-1',
          minimized: false,
          details: [{ label: 'Agent', value: 'Test Agent' }],
        }),
      ];
      mockFocusedWindowId = 'window-1'; // Focused so clicks toggle minimize

      renderWithQueryClient(
        <TerminalDock
          {...defaultProps}
          expanded={false}
          sessions={[session]}
          onToggle={onToggle}
        />,
      );

      const pill = screen.getByRole('button', { name: /test agent/i });
      await user.dblClick(pill);

      // Double-click on pill button should NOT trigger the header bar toggle
      // Pill has its own click handler for focus/minimize, but not onToggle
      expect(onToggle).not.toHaveBeenCalled();
    });

    it('single click on header toggle button works normally', async () => {
      const user = userEvent.setup();
      const onToggle = jest.fn();
      mockWindows = [];

      renderWithQueryClient(
        <TerminalDock {...defaultProps} expanded={false} sessions={[]} onToggle={onToggle} />,
      );

      const toggleButton = screen.getByRole('button', { name: /expand terminal dock/i });
      await user.click(toggleButton);

      expect(onToggle).toHaveBeenCalledTimes(1);
    });
  });

  describe('Agent summary query optimization', () => {
    it('does NOT call fetchAgentSummary when dock is collapsed (expanded=false)', async () => {
      mockFetchAgentSummary.mockClear();
      const session = createMockSession({ id: 'session-1', agentId: 'agent-123' });
      mockWindows = [];

      renderWithQueryClient(
        <TerminalDock {...defaultProps} expanded={false} sessions={[session]} />,
      );

      // Wait a tick for any queries to potentially fire
      await waitFor(() => {
        expect(mockFetchAgentSummary).not.toHaveBeenCalled();
      });
    });

    it('calls fetchAgentSummary when dock is expanded (expanded=true)', async () => {
      mockFetchAgentSummary.mockClear();
      const session = createMockSession({ id: 'session-1', agentId: 'agent-456' });
      mockWindows = [];

      renderWithQueryClient(
        <TerminalDock {...defaultProps} expanded={true} sessions={[session]} />,
      );

      await waitFor(() => {
        expect(mockFetchAgentSummary).toHaveBeenCalledWith('agent-456');
      });
    });

    it('calls fetchAgentSummary for each unique agent when expanded', async () => {
      mockFetchAgentSummary.mockClear();
      const session1 = createMockSession({ id: 'session-1', agentId: 'agent-a' });
      const session2 = createMockSession({ id: 'session-2', agentId: 'agent-b' });
      const session3 = createMockSession({ id: 'session-3', agentId: 'agent-a' }); // Duplicate
      mockWindows = [];

      renderWithQueryClient(
        <TerminalDock
          {...defaultProps}
          expanded={true}
          sessions={[session1, session2, session3]}
        />,
      );

      await waitFor(() => {
        // Should deduplicate: only 2 unique agents
        expect(mockFetchAgentSummary).toHaveBeenCalledTimes(2);
        expect(mockFetchAgentSummary).toHaveBeenCalledWith('agent-a');
        expect(mockFetchAgentSummary).toHaveBeenCalledWith('agent-b');
      });
    });
  });
});

import React from 'react';
import { render, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TerminalSessionWindowContent } from './TerminalSessionWindow';
import type { ActiveSession } from '@/ui/lib/sessions';
import { renameSession } from '@/ui/lib/sessions';

const mockUpdateWindowMeta = jest.fn();
const mockSetWindowHandle = jest.fn();
const mockToast = jest.fn();

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({ selectedProjectId: 'project-1' }),
}));

jest.mock('@/ui/lib/sessions', () => ({
  ...jest.requireActual('@/ui/lib/sessions'),
  renameSession: jest.fn().mockResolvedValue({}),
  terminateSession: jest.fn().mockResolvedValue({}),
  fetchAgentSummary: jest.fn().mockResolvedValue(null),
  fetchEpicSummary: jest.fn().mockResolvedValue(null),
  fetchProfileSummary: jest.fn().mockResolvedValue(null),
  fetchProjectSummary: jest.fn().mockResolvedValue(null),
  fetchProviderSummary: jest.fn().mockResolvedValue(null),
}));

jest.mock('@/ui/components/Terminal', () => ({
  Terminal: React.forwardRef((_props: unknown, ref: React.ForwardedRef<unknown>) => {
    React.useImperativeHandle(ref, () => ({}));
    return React.createElement('div', { 'data-testid': 'terminal' });
  }),
}));

jest.mock('@/ui/components/shared/ConfirmDialog', () => ({
  ConfirmDialog: ({ open }: { open: boolean }) =>
    open ? React.createElement('div', { 'data-testid': 'confirm-dialog' }) : null,
}));

jest.mock('@/ui/lib/providers', () => ({
  getProviderIconDataUri: () => null,
}));

jest.mock('@/ui/components/terminal-dock/TerminalDock', () => ({
  TERMINAL_SESSIONS_QUERY_KEY: ['terminalSessions'],
}));

jest.mock('./TerminalWindowsContext', () => ({
  useTerminalWindows: () => ({
    updateWindowMeta: mockUpdateWindowMeta,
    setWindowHandle: mockSetWindowHandle,
  }),
}));

function makeSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    epicId: null,
    agentId: 'agent-1',
    tmuxSessionId: 'tmux-1',
    status: 'running',
    startedAt: '2026-01-01T00:00:00Z',
    endedAt: null,
    name: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function createWrapper(qc?: QueryClient) {
  const client =
    qc ?? new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('TerminalSessionWindowContent', () => {
  const defaultProps = {
    session: makeSession(),
    onRequestClose: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    [null, '00000000…0001'],
    ['My Session', 'My Session'],
  ])('sets Session detail from name=%s', (name, label) => {
    render(<TerminalSessionWindowContent {...defaultProps} session={makeSession({ name })} />, {
      wrapper: createWrapper(),
    });

    expect(mockUpdateWindowMeta).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-000000000001',
      expect.objectContaining({
        details: expect.arrayContaining([
          expect.objectContaining({ label: 'Session', value: label }),
        ]),
      }),
    );
  });

  it('copy detail calls clipboard.writeText with full UUID', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(
      <TerminalSessionWindowContent
        {...defaultProps}
        session={makeSession({ id: 'full-uuid-1234-5678' })}
      />,
      { wrapper: createWrapper() },
    );

    const lastCall = mockUpdateWindowMeta.mock.calls[mockUpdateWindowMeta.mock.calls.length - 1];
    const details = lastCall[1].details;
    const sessionDetail = details.find((d: { label: string }) => d.label === 'Session');

    await act(async () => {
      await sessionDetail.onCopyId();
    });

    expect(writeText).toHaveBeenCalledWith('full-uuid-1234-5678');
  });

  // R4 regression (epic 5b9c46e1): rename with no pre-seeded dock cache must not
  // trigger "Query data cannot be undefined" and must still update the display.
  it('rename works without pre-seeded cache and emits no undefined-data warning (R4)', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const session = makeSession({ name: null });
    // DO NOT seed terminalSessionsQueryKey — this is the no-cache path.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

    render(<TerminalSessionWindowContent {...defaultProps} session={session} />, {
      wrapper: createWrapper(qc),
    });

    const getLatestSessionDetail = () => {
      const lastCallIdx = mockUpdateWindowMeta.mock.calls.length - 1;
      const call = mockUpdateWindowMeta.mock.calls[lastCallIdx];
      return call[1].details.find((d: { label: string }) => d.label === 'Session');
    };

    expect(getLatestSessionDetail().value).toBe('00000000…0001');

    const sessionDetail = getLatestSessionDetail();
    act(() => {
      sessionDetail.onRenameStart();
    });

    const afterStart = getLatestSessionDetail();
    act(() => {
      afterStart.onDraftChange('My Session');
    });

    const afterDraft = getLatestSessionDetail();
    await act(async () => {
      afterDraft.onRenameKeyDown({ key: 'Enter' } as React.KeyboardEvent<HTMLInputElement>);
    });

    expect(renameSession).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-000000000001',
      'project-1',
      'My Session',
      expect.any(Function),
    );

    const undefinedWarnings = consoleError.mock.calls.filter((args) =>
      args.some((arg) => typeof arg === 'string' && arg.includes('Query data cannot be undefined')),
    );
    expect(undefinedWarnings).toHaveLength(0);

    consoleError.mockRestore();
  });

  it('reflects renamed name in updateWindowMeta after successful rename (R2 regression)', async () => {
    const session = makeSession({ name: null });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const queryKey = ['terminalSessions', 'project-1'];
    qc.setQueryData(queryKey, [session]);

    render(<TerminalSessionWindowContent {...defaultProps} session={session} />, {
      wrapper: createWrapper(qc),
    });

    const getLatestSessionDetail = () => {
      const lastCallIdx = mockUpdateWindowMeta.mock.calls.length - 1;
      const call = mockUpdateWindowMeta.mock.calls[lastCallIdx];
      return call[1].details.find((d: { label: string }) => d.label === 'Session');
    };

    expect(getLatestSessionDetail().value).toBe('00000000…0001');

    const sessionDetail = getLatestSessionDetail();
    act(() => {
      sessionDetail.onRenameStart();
    });

    const afterStart = getLatestSessionDetail();
    act(() => {
      afterStart.onDraftChange('My Session');
    });

    const afterDraft = getLatestSessionDetail();
    await act(async () => {
      afterDraft.onRenameKeyDown({ key: 'Enter' } as React.KeyboardEvent<HTMLInputElement>);
    });

    expect(renameSession).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-000000000001',
      'project-1',
      'My Session',
      expect.any(Function),
    );

    const latestDetail = getLatestSessionDetail();
    expect(latestDetail.value).toBe('My Session');
  });

  // R3 regression (epic 5b9c46e1): start-edit-after-prior-rename
  it('onRenameStart seeds draft from cached name, not stale prop (R3 Test A)', async () => {
    const session = makeSession({ name: null });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const queryKey = ['terminalSessions', 'project-1'];
    qc.setQueryData(queryKey, [{ ...session, name: 'My Session' }]);

    render(<TerminalSessionWindowContent {...defaultProps} session={session} />, {
      wrapper: createWrapper(qc),
    });

    const getLatestSessionDetail = () => {
      const lastCallIdx = mockUpdateWindowMeta.mock.calls.length - 1;
      const call = mockUpdateWindowMeta.mock.calls[lastCallIdx];
      return call[1].details.find((d: { label: string }) => d.label === 'Session');
    };

    await act(async () => {});

    expect(getLatestSessionDetail().value).toBe('My Session');

    const sessionDetail = getLatestSessionDetail();
    act(() => {
      sessionDetail.onRenameStart();
    });

    const afterStart = getLatestSessionDetail();
    expect(afterStart.draftName).toBe('My Session');
  });

  // R3 regression (epic 5b9c46e1): failed-second-rename-rolls-back-to-cache
  it('failed rename rolls back to cached name, not stale prop (R3 Test B)', async () => {
    (renameSession as jest.Mock).mockRejectedValueOnce(new Error('Network error'));

    const session = makeSession({ name: null });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const queryKey = ['terminalSessions', 'project-1'];
    qc.setQueryData(queryKey, [{ ...session, name: 'My Session' }]);

    render(<TerminalSessionWindowContent {...defaultProps} session={session} />, {
      wrapper: createWrapper(qc),
    });

    const getLatestSessionDetail = () => {
      const lastCallIdx = mockUpdateWindowMeta.mock.calls.length - 1;
      const call = mockUpdateWindowMeta.mock.calls[lastCallIdx];
      return call[1].details.find((d: { label: string }) => d.label === 'Session');
    };

    await act(async () => {});

    expect(getLatestSessionDetail().value).toBe('My Session');

    const sessionDetail = getLatestSessionDetail();
    act(() => {
      sessionDetail.onRenameStart();
    });

    const afterStart = getLatestSessionDetail();
    act(() => {
      afterStart.onDraftChange('Other');
    });

    const afterDraft = getLatestSessionDetail();
    await act(async () => {
      afterDraft.onRenameKeyDown({ key: 'Enter' } as React.KeyboardEvent<HTMLInputElement>);
    });

    const afterReject = getLatestSessionDetail();
    expect(afterReject.value).toBe('My Session');
  });
});

import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type {
  ExternalEditSessionView,
  ExternalSessionWriteOutcome,
} from '@/modules/external-integrations/models/external-edit-session.models';
import { useExternalRichDescriptionEdit } from './useExternalRichDescriptionEdit';
import * as richApi from '@/ui/lib/external-rich-edit';

// Hook-level orchestration with the API boundary mocked: session lifecycle,
// outcome mapping, draft preservation, and cache invalidation are cheapest
// to verify here; rendering behavior belongs to the component suite.

jest.mock('@/ui/lib/external-rich-edit', () => ({
  ...jest.requireActual('@/ui/lib/external-rich-edit'),
  readRichDescription: jest.fn(),
  createDescriptionSession: jest.fn(),
  touchSession: jest.fn(),
  saveSession: jest.fn(),
  verifySession: jest.fn(),
  reloadSession: jest.fn(),
  executeCommentDelete: jest.fn(),
}));

const readRichDescription = richApi.readRichDescription as jest.Mock;
const createDescriptionSession = richApi.createDescriptionSession as jest.Mock;
const saveSession = richApi.saveSession as jest.Mock;
const verifySession = richApi.verifySession as jest.Mock;
const reloadSession = richApi.reloadSession as jest.Mock;

const EPOCH = { connectionId: 'connection-1', generation: 1 } as const;

function sessionView(overrides: Partial<ExternalEditSessionView> = {}): ExternalEditSessionView {
  return {
    sessionId: 'session-1',
    kind: 'description_edit',
    provider: 'jira',
    remoteTaskId: 'KAN-1',
    remoteCommentId: null,
    state: 'editable',
    revision: 0,
    baselineFingerprint: 'fp',
    createdAt: '2026-08-22T00:00:00.000Z',
    lastActivityAt: '2026-08-22T00:00:00.000Z',
    idleExpiresAt: '2026-08-22T00:15:00.000Z',
    absoluteExpiresAt: '2026-08-22T02:00:00.000Z',
    ...overrides,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const DOCUMENT = {
  version: 1,
  blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'draft', marks: [] }] }],
};

function renderEdit() {
  return renderHook(
    () => useExternalRichDescriptionEdit('jira', EPOCH, 'KAN-1' as never, { enabled: true }),
    { wrapper },
  );
}

describe('useExternalRichDescriptionEdit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    readRichDescription.mockResolvedValue({
      document: DOCUMENT,
      fingerprint: 'fp',
      supported: true,
      readOnlyReason: null,
      canEdit: true,
      canDeleteOwnedComments: true,
    });
    createDescriptionSession.mockResolvedValue(sessionView());
    saveSession.mockResolvedValue({
      outcome: 'saved',
      revision: 1,
      session: sessionView({ revision: 1, state: 'editable' }),
    });
    verifySession.mockResolvedValue({ session: sessionView(), remoteState: null, reason: null });
    reloadSession.mockResolvedValue({ status: 'reloaded', session: sessionView({ revision: 1 }) });
  });

  it('loads the stateless read without creating a session', async () => {
    const { result } = renderEdit();
    await waitFor(() => expect(result.current.description?.supported).toBe(true));
    expect(createDescriptionSession).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe('idle');
  });

  it('opens a session on explicit edit and tracks the revision', async () => {
    const { result } = renderEdit();
    act(() => result.current.startEdit());
    await waitFor(() => expect(result.current.state.phase).toBe('editing'));
    expect(result.current.state.revision).toBe(0);
  });

  it('a verified save reports saved, clears the draft, and invalidates caches', async () => {
    const { result } = renderEdit();
    act(() => result.current.startEdit());
    await waitFor(() => expect(result.current.state.phase).toBe('editing'));

    act(() => result.current.saveDraft(DOCUMENT));
    act(() => result.current.submitSave());
    await waitFor(() => expect(result.current.state.phase).toBe('saved'));
    expect(saveSession).toHaveBeenCalledWith(expect.anything(), 'session-1', expect.anything(), 0);
    expect(result.current.state.revision).toBe(1);
    expect(result.current.draft).toBeNull();
  });

  it('an unknown outcome offers verify and same-payload retry only', async () => {
    saveSession.mockResolvedValue({
      outcome: 'outcome_unknown',
      session: sessionView({ state: 'outcome_unknown' }),
    } satisfies ExternalSessionWriteOutcome);
    const { result } = renderEdit();
    act(() => result.current.startEdit());
    await waitFor(() => expect(result.current.state.phase).toBe('editing'));
    act(() => result.current.saveDraft(DOCUMENT));
    act(() => result.current.submitSave());
    await waitFor(() => expect(result.current.state.phase).toBe('unknown'));

    // A different payload cannot dispatch through retrySamePayload's guard;
    // the same payload retries through the same mutation.
    act(() => result.current.retrySamePayload());
    await waitFor(() => expect(saveSession).toHaveBeenCalledTimes(2));
    expect(saveSession.mock.calls[1]![2]).toEqual(saveSession.mock.calls[0]![2]);
  });

  it('divergence blocks save and reload re-baselines the editor', async () => {
    saveSession.mockResolvedValue({
      outcome: 'pre_dispatch_rejected',
      reason: 'diverged',
      session: sessionView({ state: 'diverged' }),
    } satisfies ExternalSessionWriteOutcome);
    const { result } = renderEdit();
    act(() => result.current.startEdit());
    await waitFor(() => expect(result.current.state.phase).toBe('editing'));
    act(() => result.current.saveDraft(DOCUMENT));
    act(() => result.current.submitSave());
    await waitFor(() => expect(result.current.state.phase).toBe('diverged'));

    act(() => result.current.reload.mutate());
    await waitFor(() => expect(result.current.state.phase).toBe('editing'));
    expect(result.current.state.revision).toBe(1);
  });

  it('session expiry preserves the browser draft and refresh opens a new session', async () => {
    saveSession.mockResolvedValue({
      outcome: 'pre_dispatch_rejected',
      reason: 'session_expired',
      session: null,
    } satisfies ExternalSessionWriteOutcome);
    createDescriptionSession
      .mockResolvedValueOnce(sessionView())
      .mockResolvedValueOnce(sessionView({ sessionId: 'session-2', revision: 3 }));

    const { result } = renderEdit();
    act(() => result.current.startEdit());
    await waitFor(() => expect(result.current.state.phase).toBe('editing'));
    act(() => result.current.saveDraft(DOCUMENT));
    act(() => result.current.submitSave());
    await waitFor(() => expect(result.current.state.phase).toBe('expired'));

    // The draft survives the dead session.
    expect(result.current.draft).not.toBeNull();

    createDescriptionSession.mockClear();
    act(() => result.current.refreshSession());
    await waitFor(() => expect(result.current.state.session?.sessionId).toBe('session-2'));
    expect(result.current.state.revision).toBe(3);
    // The draft is still there for the user to re-save.
    expect(result.current.draft).not.toBeNull();
  });

  it('cancel clears the edit state and the draft', async () => {
    const { result } = renderEdit();
    act(() => result.current.startEdit());
    await waitFor(() => expect(result.current.state.phase).toBe('editing'));
    act(() => result.current.saveDraft(DOCUMENT));
    act(() => result.current.cancelEdit());
    expect(result.current.state.phase).toBe('idle');
    expect(result.current.draft).toBeNull();
  });

  it('verify success after unknown commits the save', async () => {
    saveSession.mockResolvedValue({
      outcome: 'outcome_unknown',
      session: sessionView({ state: 'outcome_unknown' }),
    } satisfies ExternalSessionWriteOutcome);
    verifySession.mockResolvedValue({
      session: sessionView({ revision: 1, state: 'editable' }),
      remoteState: 'new_payload',
      reason: null,
    });
    const { result } = renderEdit();
    act(() => result.current.startEdit());
    await waitFor(() => expect(result.current.state.phase).toBe('editing'));
    act(() => result.current.saveDraft(DOCUMENT));
    act(() => result.current.submitSave());
    await waitFor(() => expect(result.current.state.phase).toBe('unknown'));

    act(() => result.current.verify.mutate());
    await waitFor(() => expect(result.current.state.phase).toBe('saved'));
    expect(result.current.state.revision).toBe(1);
    expect(result.current.draft).toBeNull();
  });
});

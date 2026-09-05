import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ExternalTaskCommentPage } from '@/modules/external-integrations/models/external-provider.models';
import { useOwnedCommentActions } from './useOwnedCommentActions';
import * as richApi from '@/ui/lib/external-rich-edit';

// Hook-level contract with the API boundary mocked: edit page-in-place
// patching, delete page-one resets for known and unknown outcomes, lookup
// failure → refresh_required, and per-comment independence.

jest.mock('@/ui/lib/external-rich-edit', () => ({
  ...jest.requireActual('@/ui/lib/external-rich-edit'),
  readRichDescription: jest.fn(),
  createDescriptionSession: jest.fn(),
  createCommentEditSession: jest.fn(),
  createCommentDeleteSession: jest.fn(),
  touchSession: jest.fn(),
  saveSession: jest.fn(),
  verifySession: jest.fn(),
  reloadSession: jest.fn(),
  executeCommentDelete: jest.fn(),
}));

const createCommentEditSession = richApi.createCommentEditSession as jest.Mock;
const createCommentDeleteSession = richApi.createCommentDeleteSession as jest.Mock;
const saveSession = richApi.saveSession as jest.Mock;
const verifySession = richApi.verifySession as jest.Mock;
const executeCommentDelete = richApi.executeCommentDelete as jest.Mock;

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const EPOCH = 'connection-1:1';
const OTHER_EPOCH = 'connection-2:7';
const DOCUMENT = {
  version: 1,
  blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'edited', marks: [] }] }],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function page(comments: Array<Record<string, unknown>>): ExternalTaskCommentPage {
  return { comments: comments as never, nextCursor: null };
}

function comment(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    remoteId: id,
    author: { remoteId: '183', displayName: 'Me' },
    body: `body-${id}`,
    bodyTruncated: false,
    rich: { document: DOCUMENT, supported: true },
    lookupToken: `token-${id}`,
    owned: true,
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: null,
    ...overrides,
  };
}

const SESSION = {
  sessionId: 'session-1',
  kind: 'comment_edit',
  provider: 'clickup',
  remoteTaskId: 'task-1',
  remoteCommentId: 'c1',
  state: 'editable',
  revision: 0,
  baselineFingerprint: 'fp',
  createdAt: '',
  lastActivityAt: '',
  idleExpiresAt: '',
  absoluteExpiresAt: '',
};

describe('useOwnedCommentActions', () => {
  function setup() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    client.setQueryData(
      ['external-my-work', 'clickup', 'connection-1:1', 'task-comments', 'task-1'],
      {
        pages: [page([comment('c2'), comment('c1')])],
        pageParams: [null],
      },
    );
    client.setQueryData(
      ['external-my-work', 'clickup', 'connection-2:7', 'task-comments', 'task-2'],
      {
        pages: [page([comment('b1')])],
        pageParams: [null],
      },
    );
    const resetSpy = jest.spyOn(client, 'resetQueries');
    const setDataSpy = jest.spyOn(client, 'setQueryData');
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const hook = renderHook(
      ({ projectId, connectionEpoch, taskId }) =>
        useOwnedCommentActions('clickup', connectionEpoch, taskId, {
          projectId,
          richEditEnabled: true,
          ownedDeleteEnabled: true,
        }),
      {
        wrapper,
        initialProps: {
          projectId: PROJECT_ID,
          connectionEpoch: EPOCH,
          taskId: 'task-1',
        },
      },
    );
    return { hook, resetSpy, setDataSpy, client };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    createCommentEditSession.mockResolvedValue(SESSION);
    createCommentDeleteSession.mockResolvedValue({ ...SESSION, kind: 'comment_delete' });
    saveSession.mockResolvedValue({
      outcome: 'saved',
      revision: 1,
      session: { ...SESSION, revision: 1 },
    });
    verifySession.mockResolvedValue({ session: SESSION, remoteState: null, reason: null });
    executeCommentDelete.mockResolvedValue({
      outcome: 'deleted',
      session: { ...SESSION, kind: 'comment_delete', state: 'invalidated' },
    });
  });

  it('starts disabled when the capability gates are off', () => {
    const client = new QueryClient();
    const { result } = renderHook(
      () =>
        useOwnedCommentActions('clickup', EPOCH, 'task-1', {
          projectId: PROJECT_ID,
          richEditEnabled: false,
          ownedDeleteEnabled: false,
        }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );
    act(() => result.current.edit.start(comment('c1') as never));
    expect(createCommentEditSession).not.toHaveBeenCalled();
    act(() => result.current.delete.request(comment('c1') as never));
    expect(result.current.delete.status).toBe('idle');
  });

  it('edit success patches only the matching remoteId in the loaded page', async () => {
    const { hook, setDataSpy, resetSpy } = setup();
    act(() => hook.result.current.edit.start(comment('c1') as never));
    await waitFor(() => expect(hook.result.current.edit.state.status).toBe('editing'));

    act(() => hook.result.current.edit.setDraft({ document: DOCUMENT }));
    act(() => hook.result.current.edit.submit());
    await waitFor(() => expect(hook.result.current.edit.state.status).toBe('saved'));

    expect(saveSession).toHaveBeenCalledWith(
      expect.anything(),
      PROJECT_ID,
      'session-1',
      expect.anything(),
      0,
    );
    // Commit patches the page in place; the comments query is never reset.
    expect(resetSpy).not.toHaveBeenCalled();
    const patchCall = setDataSpy.mock.calls.find((call) => typeof call[1] === 'function');
    expect(patchCall).toBeDefined();
    const patched = (patchCall![1] as (data: unknown) => unknown)({
      pages: [page([comment('c2'), comment('c1')])],
      pageParams: [null],
    }) as { pages: Array<{ comments: Array<{ remoteId: string }> }> };
    expect(patched.pages[0]!.comments.map((c) => c.remoteId)).toEqual(['c2', 'c1']);
  });

  it('a lookup miss maps to refresh_required, never a retry loop', async () => {
    createCommentEditSession.mockRejectedValue(
      new Error('The comment could not be found. Refresh and try again.'),
    );
    const { hook } = setup();
    act(() => hook.result.current.edit.start(comment('c1') as never));
    await waitFor(() => expect(hook.result.current.edit.state.status).toBe('refresh_required'));
    // Submit is unavailable in refresh_required.
    act(() => hook.result.current.edit.submit());
    expect(saveSession).not.toHaveBeenCalled();
  });

  it('ignores a deferred edit-session error after switching presentation scope', async () => {
    const opening = deferred<typeof SESSION>();
    createCommentEditSession.mockReturnValueOnce(opening.promise);
    const { hook } = setup();

    act(() => hook.result.current.edit.start(comment('c1') as never));
    await waitFor(() => expect(hook.result.current.edit.state.status).toBe('opening'));
    hook.rerender({
      projectId: OTHER_PROJECT_ID,
      connectionEpoch: OTHER_EPOCH,
      taskId: 'task-2',
    });
    await waitFor(() => expect(hook.result.current.edit.state.status).toBe('idle'));
    expect(hook.result.current.edit.pending).toBe(false);

    await act(async () => opening.reject(new Error('Project A lookup failed')));
    await waitFor(() => expect(hook.result.current.edit.pending).toBe(false));
    expect(hook.result.current.edit.target).toBeNull();
    expect(hook.result.current.edit.state).toEqual({
      status: 'idle',
      session: null,
      error: null,
    });
  });

  it('does not patch Project B cache when a Project A save settles late', async () => {
    const saved = deferred<Awaited<ReturnType<typeof richApi.saveSession>>>();
    saveSession.mockReturnValueOnce(saved.promise);
    const { hook, setDataSpy, client } = setup();

    act(() => hook.result.current.edit.start(comment('c1') as never));
    await waitFor(() => expect(hook.result.current.edit.state.status).toBe('editing'));
    act(() => hook.result.current.edit.setDraft({ document: DOCUMENT }));
    act(() => hook.result.current.edit.submit());
    await waitFor(() => expect(hook.result.current.edit.state.status).toBe('saving'));
    setDataSpy.mockClear();

    hook.rerender({
      projectId: OTHER_PROJECT_ID,
      connectionEpoch: OTHER_EPOCH,
      taskId: 'task-2',
    });
    await waitFor(() => expect(hook.result.current.edit.state.status).toBe('idle'));
    expect(hook.result.current.edit.pending).toBe(false);
    await act(async () =>
      saved.resolve({
        outcome: 'saved',
        revision: 1,
        session: { ...SESSION, revision: 1 },
      }),
    );
    await waitFor(() => expect(hook.result.current.edit.pending).toBe(false));

    expect(hook.result.current.edit.target).toBeNull();
    expect(hook.result.current.edit.state.status).toBe('idle');
    expect(setDataSpy).not.toHaveBeenCalled();
    expect(
      client.getQueryData([
        'external-my-work',
        'clickup',
        'connection-2:7',
        'task-comments',
        'task-2',
      ]),
    ).toEqual({ pages: [page([comment('b1')])], pageParams: [null] });
  });

  it('an unknown edit outcome offers verify and same-payload retry', async () => {
    saveSession.mockResolvedValue({
      outcome: 'outcome_unknown',
      session: { ...SESSION, state: 'outcome_unknown' },
    });
    const { hook } = setup();
    act(() => hook.result.current.edit.start(comment('c1') as never));
    await waitFor(() => expect(hook.result.current.edit.state.status).toBe('editing'));
    act(() => hook.result.current.edit.setDraft({ document: DOCUMENT }));
    act(() => hook.result.current.edit.submit());
    await waitFor(() => expect(hook.result.current.edit.state.status).toBe('unknown'));

    act(() => hook.result.current.edit.retrySamePayload());
    await waitFor(() => expect(saveSession).toHaveBeenCalledTimes(2));

    act(() => hook.result.current.edit.verify());
    await waitFor(() => expect(verifySession).toHaveBeenCalled());
  });

  it('a known delete resets the comments query to page one', async () => {
    const { hook, resetSpy } = setup();
    act(() => hook.result.current.delete.request(comment('c1') as never));
    expect(hook.result.current.delete.status).toBe('confirming');
    act(() => hook.result.current.delete.confirm(comment('c1') as never));
    await waitFor(() => expect(hook.result.current.delete.status).toBe('deleted'));
    expect(executeCommentDelete).toHaveBeenCalledTimes(1);
    expect(resetSpy).toHaveBeenCalledWith(expect.objectContaining({ exact: true }));
  });

  it('an unknown delete also resets to page one and stays confirmable', async () => {
    executeCommentDelete.mockResolvedValue({
      outcome: 'outcome_unknown',
      session: { ...SESSION, kind: 'comment_delete', state: 'outcome_unknown' },
    });
    const { hook, resetSpy } = setup();
    act(() => hook.result.current.delete.confirm(comment('c1') as never));
    await waitFor(() => expect(hook.result.current.delete.status).toBe('unknown'));
    expect(hook.result.current.delete.unknown).toBe(true);
    expect(resetSpy).toHaveBeenCalled();
  });

  it('does not reset Project B cache when a Project A delete settles late', async () => {
    const deletion = deferred<Awaited<ReturnType<typeof richApi.executeCommentDelete>>>();
    executeCommentDelete.mockReturnValueOnce(deletion.promise);
    const { hook, resetSpy } = setup();

    act(() => hook.result.current.delete.confirm(comment('c1') as never));
    await waitFor(() => expect(executeCommentDelete).toHaveBeenCalledTimes(1));
    hook.rerender({
      projectId: OTHER_PROJECT_ID,
      connectionEpoch: OTHER_EPOCH,
      taskId: 'task-2',
    });
    await waitFor(() => expect(hook.result.current.delete.status).toBe('idle'));
    expect(hook.result.current.delete.pending).toBe(false);
    resetSpy.mockClear();

    await act(async () =>
      deletion.resolve({
        outcome: 'deleted',
        session: { ...SESSION, kind: 'comment_delete', state: 'invalidated' },
      }),
    );
    await waitFor(() => expect(hook.result.current.delete.pending).toBe(false));
    expect(hook.result.current.delete.status).toBe('idle');
    expect(hook.result.current.delete.target).toBeNull();
    expect(resetSpy).not.toHaveBeenCalled();
  });

  it('one comment edit does not lock another comment or the composer', async () => {
    const { hook } = setup();
    act(() => hook.result.current.edit.start(comment('c1') as never));
    await waitFor(() => expect(hook.result.current.edit.state.status).toBe('editing'));
    // The second comment still starts its own independent flow.
    act(() => hook.result.current.edit.start(comment('c2') as never));
    await waitFor(() =>
      expect(createCommentEditSession).toHaveBeenCalledWith(
        expect.anything(),
        PROJECT_ID,
        'clickup',
        'task-1',
        'c2',
        'token-c2',
      ),
    );
  });
});

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ExternalTaskComment } from '@/modules/external-integrations/models/external-provider.models';
import { OwnedCommentItem } from './OwnedCommentItem';
import type { useOwnedCommentActions } from '@/ui/hooks/board/useOwnedCommentActions';

// Component-level contract: gate independence, owned-only affordances,
// irreversible confirmation flow, read-only fallbacks, and the timestamp
// asymmetry statement. The editor module is mocked (no ProseMirror).

jest.mock('@/ui/components/board/rich/ExternalRichEditor', () => ({
  ExternalRichEditor: jest.fn(() => <div data-testid="rich-editor-mock" />),
}));

type Actions = ReturnType<typeof useOwnedCommentActions>;

function comment(overrides: Partial<ExternalTaskComment> = {}): ExternalTaskComment {
  return {
    remoteId: 'c1',
    author: { remoteId: '183', displayName: 'Me' },
    body: 'plain body',
    bodyTruncated: false,
    rich: {
      document: {
        version: 1,
        blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'rich body', marks: [] }] }],
      },
      supported: true,
    },
    lookupToken: 'token-c1',
    owned: true,
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: null,
    ...overrides,
  };
}

function actionsWith(overrides: Partial<Actions> = {}): Actions {
  return {
    edit: {
      target: null,
      state: { status: 'idle', session: null, error: null },
      draft: null,
      setDraft: jest.fn(),
      start: jest.fn(),
      close: jest.fn(),
      submit: jest.fn(),
      retrySamePayload: jest.fn(),
      verify: jest.fn(),
      pending: false,
      commitEditToCache: jest.fn(),
    },
    delete: {
      target: null,
      status: 'idle',
      error: null,
      unknown: false,
      request: jest.fn(),
      confirm: jest.fn(),
      cancel: jest.fn(),
      dismiss: jest.fn(),
      pending: false,
    },
    ...overrides,
  } as Actions;
}

function item(
  commentValue: ExternalTaskComment,
  actions: Actions,
  capabilities: { richEdit: boolean; ownedDelete: boolean },
  isOwned = true,
): ReactNode {
  const client = new QueryClient();
  return (
    <QueryClientProvider client={client}>
      <ol>
        <OwnedCommentItem
          comment={commentValue}
          actions={actions}
          capabilities={capabilities}
          isOwned={isOwned}
        />
      </ol>
    </QueryClientProvider>
  );
}

describe('OwnedCommentItem', () => {
  it('shows Edit and Delete in one menu for a server-confirmed owned supported comment', async () => {
    const user = userEvent.setup();
    render(item(comment(), actionsWith(), { richEdit: true, ownedDelete: true }));
    const trigger = screen.getByRole('button', { name: /comment actions for comment by me/i });
    expect(trigger).toHaveClass('h-10', 'w-10');
    expect(screen.queryByRole('menuitem', { name: 'Edit' })).toBeNull();
    await user.click(trigger);
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
  });

  it('hides both actions for comments owned by someone else', () => {
    render(item(comment(), actionsWith(), { richEdit: true, ownedDelete: true }, false));
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('applies the capability gates independently', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      item(comment(), actionsWith(), { richEdit: false, ownedDelete: true }),
    );
    await user.click(screen.getByRole('button', { name: /comment actions/i }));
    expect(screen.queryByRole('menuitem', { name: 'Edit' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
    await user.keyboard('{Escape}');

    rerender(item(comment(), actionsWith(), { richEdit: true, ownedDelete: false }));
    await user.click(screen.getByRole('button', { name: /comment actions/i }));
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull();
  });

  it('hides Edit for an unsupported rich body (read-only), keeps Delete per gate', async () => {
    const user = userEvent.setup();
    const unsupported = comment({
      rich: { supported: false, readOnlyReason: 'unsupported_node' },
    });
    render(item(unsupported, actionsWith(), { richEdit: true, ownedDelete: true }));
    await user.click(screen.getByRole('button', { name: /comment actions/i }));
    expect(screen.queryByRole('menuitem', { name: 'Edit' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
    // The plain bounded preview renders.
    expect(screen.getByText('plain body')).toBeInTheDocument();
  });

  it('renders the rich document when supported', () => {
    render(item(comment(), actionsWith(), { richEdit: false, ownedDelete: false }));
    expect(screen.getByText('rich body')).toBeInTheDocument();
  });

  it('keeps the truncated-body notice on the plain fallback', () => {
    const truncated = comment({
      bodyTruncated: true,
      rich: null,
    });
    render(item(truncated, actionsWith(), { richEdit: false, ownedDelete: false }));
    expect(screen.getByText(/comment was shortened/i)).toBeInTheDocument();
  });

  it('Delete requires the irreversible confirmation; Cancel aborts without dispatch', async () => {
    const user = userEvent.setup();
    const actions = actionsWith({
      delete: {
        ...actionsWith().delete,
        target: 'c1',
        status: 'confirming',
        request: jest.fn(),
        confirm: jest.fn(),
        cancel: jest.fn(),
        dismiss: jest.fn(),
        pending: false,
      },
    });
    // request() flips the hook to confirming; the dialog is open on render.
    render(item(comment(), actions, { richEdit: true, ownedDelete: true }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/cannot be undone/i);

    const cancelButton = within(dialog).getByRole('button', { name: 'Cancel' });
    await user.click(cancelButton);
    await waitFor(() => expect(actions.delete.cancel).toHaveBeenCalled());
    expect(actions.delete.confirm).not.toHaveBeenCalled();
  });

  it('confirming dispatches exactly one delete', async () => {
    const user = userEvent.setup();
    const confirm = jest.fn();
    const actions = actionsWith({
      delete: {
        ...actionsWith().delete,
        target: 'c1',
        status: 'confirming',
        confirm,
        cancel: jest.fn(),
        dismiss: jest.fn(),
      },
    });
    render(item(comment(), actions, { richEdit: true, ownedDelete: true }));
    // The dialog renders because status is confirming with a target.
    await user.click(await screen.findByRole('button', { name: 'Delete comment' }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(comment());
  });

  it('states the edited-timestamp asymmetry without fabricating a timestamp', () => {
    // A provider-reported edit time renders the marker.
    const edited = comment({ updatedAt: '2026-08-22T01:00:00.000Z' });
    const view = render(item(edited, actionsWith(), { richEdit: false, ownedDelete: false }));
    expect(view.container.textContent).toContain('(edited)');

    // Without one, no marker is invented.
    view.rerender(item(comment(), actionsWith(), { richEdit: false, ownedDelete: false }));
    expect(view.container.textContent).not.toContain('(edited)');
  });

  it('formats the visible timestamp without seconds and preserves the exact value', () => {
    const createdAt = '2026-08-22T12:21:15.000Z';
    render(item(comment({ createdAt }), actionsWith(), { richEdit: false, ownedDelete: false }));
    const time = screen.getByText(
      new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date(createdAt)),
    );
    expect(time).toHaveAttribute('datetime', createdAt);
    expect(time).toHaveAttribute('title');
    expect(time.textContent).not.toContain(':15');
  });

  it('an editing comment renders the lazy editor surface with Save and Cancel', async () => {
    const actions = actionsWith({
      edit: {
        ...actionsWith().edit,
        target: 'c1',
        state: {
          status: 'editing',
          session: {
            sessionId: 'session-1',
            kind: 'comment_edit',
            provider: 'jira',
            remoteTaskId: 'KAN-1',
            remoteCommentId: 'c1',
            state: 'editable',
            revision: 0,
            baselineFingerprint: 'fp',
            createdAt: '',
            lastActivityAt: '',
            idleExpiresAt: '',
            absoluteExpiresAt: '',
          },
          error: null,
        },
      },
    });
    render(item(comment(), actions, { richEdit: true, ownedDelete: true }));
    expect(await screen.findByTestId('rich-editor-mock')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('refresh_required shows the refresh notice and no Save', async () => {
    const actions = actionsWith({
      edit: {
        ...actionsWith().edit,
        target: 'c1',
        state: { status: 'refresh_required', session: null, error: null },
      },
    });
    render(item(comment(), actions, { richEdit: true, ownedDelete: true }));
    await screen.findByTestId('rich-editor-mock');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByText(/comment list changed/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy my draft' })).toBeInTheDocument();
  });
});

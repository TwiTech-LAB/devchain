import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import type { ExternalTaskDetail } from '@/modules/external-integrations/models/external-provider.models';
import type {
  ExternalEditSessionView,
  ExternalSessionWriteOutcome,
} from '@/modules/external-integrations/models/external-edit-session.models';
import { ExternalTaskRichDescription } from './ExternalTaskRichDescription';
import type { useExternalRichDescriptionEdit } from '@/ui/hooks/board/useExternalRichDescriptionEdit';

// Component-level contract: states, affordances, lazy editor import, dirty
// close, fallbacks, and titles-untouched rendering. The editor module is
// mocked so the suite never loads ProseMirror.

const EditorMockImpl = jest.fn(() => (
  <div data-testid="rich-editor-mock" aria-label="Edit task description" role="textbox" />
));

jest.mock('./rich/ExternalRichEditor', () => ({
  // The component consumes this module through a default-import lazy(); the
  // mock mirrors both shapes so the dynamic import resolves synchronously.
  __esModule: true,
  default: EditorMockImpl,
  ExternalRichEditor: EditorMockImpl,
}));

const editorMock = EditorMockImpl;

type Controller = ReturnType<typeof useExternalRichDescriptionEdit>;

const DETAIL = {
  description: 'Plain fallback text',
  descriptionTruncated: false,
} as unknown as ExternalTaskDetail;

const DOCUMENT = {
  version: 1,
  blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'rich body', marks: [] }] }],
};

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
    createdAt: '',
    lastActivityAt: '',
    idleExpiresAt: '',
    absoluteExpiresAt: '',
    ...overrides,
  };
}

function controllerWith(overrides: Partial<Controller> = {}): Controller {
  return {
    description: {
      document: DOCUMENT,
      fingerprint: 'fp',
      supported: true,
      readOnlyReason: null,
      canEdit: true,
      canDeleteOwnedComments: true,
    },
    descriptionLoading: false,
    descriptionError: null,
    state: {
      phase: 'idle',
      session: null,
      lastOutcome: null,
      verifyRemoteState: null,
      revision: 0,
      error: null,
    },
    draft: null,
    startEdit: jest.fn(),
    cancelEdit: jest.fn(),
    saveDraft: jest.fn(),
    submitSave: jest.fn(),
    retrySamePayload: jest.fn(),
    refreshSession: jest.fn(),
    verify: { mutate: jest.fn(), isPending: false } as never,
    reload: { mutate: jest.fn(), isPending: false } as never,
    savePending: false,
    verifyPending: false,
    reloadPending: false,
    openPending: false,
    ...overrides,
  } as Controller;
}

function section(controller: Controller): ReactNode {
  return (
    <ExternalTaskRichDescription
      detail={DETAIL}
      controller={controller}
      provider="jira"
      webUrl="https://test.atlassian.net/browse/KAN-1"
    />
  );
}

describe('ExternalTaskRichDescription', () => {
  beforeEach(() => {
    editorMock.mockClear();
  });

  it('renders supported content read-only with an Edit affordance and no editor import', () => {
    render(section(controllerWith()));
    expect(screen.getByText('rich body')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(editorMock).not.toHaveBeenCalled();
  });

  it('unsupported content shows the plain fallback, no Edit, and Open in source', () => {
    const controller = controllerWith({
      description: {
        document: null,
        fingerprint: null,
        supported: false,
        readOnlyReason: 'unsupported_content',
        canEdit: false,
        canDeleteOwnedComments: true,
      },
    });
    render(section(controller));
    expect(screen.getByText('Plain fallback text')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    const open = screen.getByRole('link', { name: /open in source/i });
    expect(open).toHaveAttribute('href', 'https://test.atlassian.net/browse/KAN-1');
    expect(screen.getByText(/cannot safely edit/i)).toBeInTheDocument();
  });

  it('canEdit=false (capability NO_GO) hides Edit even for supported content', () => {
    const controller = controllerWith({
      description: {
        document: DOCUMENT,
        fingerprint: 'fp',
        supported: true,
        readOnlyReason: null,
        canEdit: false,
        canDeleteOwnedComments: false,
      },
    });
    render(section(controller));
    expect(screen.getByText('rich body')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('editing renders the lazy editor (loaded only after Edit) with Save and Cancel', async () => {
    const controller = controllerWith({
      draft: { document: DOCUMENT },
      state: {
        phase: 'editing',
        session: sessionView(),
        lastOutcome: null,
        verifyRemoteState: null,
        revision: 0,
        error: null,
      },
    });
    render(section(controller));
    expect(await screen.findByTestId('rich-editor-mock')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('Save is disabled while pending, clean, or diverged', () => {
    const base = {
      lastOutcome: null,
      verifyRemoteState: null,
      revision: 0,
      error: null,
    };
    const cases: Array<Partial<Controller>> = [
      {
        savePending: true,
        draft: { document: DOCUMENT },
        state: { phase: 'saving', session: sessionView(), ...base },
      },
      { draft: null, state: { phase: 'editing', session: sessionView(), ...base } },
      {
        draft: { document: DOCUMENT },
        state: { phase: 'diverged', session: sessionView({ state: 'diverged' }), ...base },
      },
    ];
    for (const overrides of cases) {
      const { unmount } = render(section(controllerWith(overrides)));
      expect(screen.getByRole('button', { name: /^Save$|^Saving…$/ })).toBeDisabled();
      unmount();
    }
  });

  it('dirty Cancel asks for confirmation; Keep editing returns without discarding', async () => {
    const user = userEvent.setup();
    const controller = controllerWith({
      draft: { document: DOCUMENT },
      state: {
        phase: 'editing',
        session: sessionView(),
        lastOutcome: null,
        verifyRemoteState: null,
        revision: 0,
        error: null,
      },
    });
    render(section(controller));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/discard your changes/i);

    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(controller.cancelEdit).not.toHaveBeenCalled();
  });

  it('confirmed discard cancels the edit session', async () => {
    const user = userEvent.setup();
    const controller = controllerWith({
      draft: { document: DOCUMENT },
      state: {
        phase: 'editing',
        session: sessionView(),
        lastOutcome: null,
        verifyRemoteState: null,
        revision: 0,
        error: null,
      },
    });
    render(section(controller));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(await screen.findByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect(controller.cancelEdit).toHaveBeenCalledTimes(1));
  });

  it('divergence keeps Save blocked and offers Copy my draft plus Reload remote', () => {
    const controller = controllerWith({
      draft: { document: DOCUMENT },
      state: {
        phase: 'diverged',
        session: sessionView({ state: 'diverged' }),
        lastOutcome: null,
        verifyRemoteState: null,
        revision: 0,
        error: null,
      },
    });
    render(section(controller));
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Copy my draft' })).toBeInTheDocument();
    const reload = screen.getByRole('button', { name: /reload remote/i });
    expect(reload).toBeInTheDocument();
  });

  it('outcome_unknown offers Verify and Retry same content plus Open in source', () => {
    const controller = controllerWith({
      draft: { document: DOCUMENT },
      state: {
        phase: 'unknown',
        session: sessionView({ state: 'outcome_unknown' }),
        lastOutcome: {
          outcome: 'outcome_unknown',
          session: sessionView({ state: 'outcome_unknown' }),
        },
        verifyRemoteState: null,
        revision: 0,
        error: null,
      },
    });
    render(section(controller));
    expect(screen.getByRole('button', { name: /verify/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry same content' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open in source/i })).toBeInTheDocument();
  });

  it('saved_unverified offers Verify without a retry button', () => {
    const controller = controllerWith({
      draft: { document: DOCUMENT },
      state: {
        phase: 'blocked',
        session: sessionView({ state: 'saved_unverified' }),
        lastOutcome: {
          outcome: 'saved_unverified',
          session: sessionView({ state: 'saved_unverified' }),
        },
        verifyRemoteState: null,
        revision: 0,
        error: null,
      },
    });
    render(section(controller));
    expect(screen.getByRole('button', { name: /verify/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry same content' })).toBeNull();
  });

  it('session expiry preserves the draft with Copy my draft and Refresh session', () => {
    const controller = controllerWith({
      draft: { document: DOCUMENT },
      state: {
        phase: 'expired',
        session: null,
        lastOutcome: null,
        verifyRemoteState: null,
        revision: 0,
        error: null,
      },
    });
    render(section(controller));
    expect(screen.getByRole('button', { name: /refresh session/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy my draft' })).toBeInTheDocument();
    expect(screen.getByText(/draft is preserved locally/i)).toBeInTheDocument();
  });

  it('saved phase announces success and renders the verified content', () => {
    const controller = controllerWith({
      state: {
        phase: 'saved',
        session: sessionView({ revision: 1 }),
        lastOutcome: null,
        verifyRemoteState: null,
        revision: 1,
        error: null,
      },
    });
    render(section(controller));
    expect(screen.getByRole('status')).toHaveTextContent(/saved/i);
    expect(screen.getByText('rich body')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
  });

  it('identity rejection suppresses rich rendering, cached content, and Edit', () => {
    const controller = controllerWith();
    render(
      <ExternalTaskRichDescription
        detail={DETAIL}
        controller={controller}
        provider="jira"
        webUrl="https://test.atlassian.net/browse/KAN-1"
        identityAccepted={false}
      />,
    );
    // Cached rich data must not surface; the plain fallback renders instead.
    expect(screen.queryByText('rich body')).toBeNull();
    expect(screen.getByText('Plain fallback text')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(controller.startEdit).not.toHaveBeenCalled();
  });

  it('never renders an editable title or heading input', () => {
    render(section(controllerWith()));
    expect(screen.queryByRole('textbox', { name: /title/i })).toBeNull();
    expect(screen.getByText('rich body').tagName).not.toBe('INPUT');
  });

  it('writes outcome sessions through to the editor key so a new session remounts it', async () => {
    void ({} satisfies ExternalSessionWriteOutcome);
    const controller = controllerWith({
      state: {
        phase: 'editing',
        session: sessionView({ sessionId: 'session-9' }),
        lastOutcome: null,
        verifyRemoteState: null,
        revision: 0,
        error: null,
      },
    });
    render(section(controller));
    await screen.findByTestId('rich-editor-mock');
    // The mocked editor received the canonical initial document.
    expect(editorMock).toHaveBeenCalledWith(
      expect.objectContaining({ ariaLabel: 'Edit task description' }),
      expect.anything(),
    );
  });
});

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import type {
  ExternalTaskComment,
  ExternalTaskDetail,
} from '@/modules/external-integrations/models/external-provider.models';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ExternalTaskDetailDialog } from './ExternalTaskDetailDialog';

const useExternalTaskControllerMock = jest.fn();

jest.mock('../../hooks/board/useExternalTaskController', () => ({
  useExternalTaskController: (...args: unknown[]) => useExternalTaskControllerMock(...args),
}));

const useExternalSubtaskStatusEditorMock = jest.fn();

jest.mock('../../hooks/board/useExternalSubtaskStatusEditor', () => ({
  useExternalSubtaskStatusEditor: (...args: unknown[]) =>
    useExternalSubtaskStatusEditorMock(...args),
}));

const detail: ExternalTaskDetail = {
  remoteId: 'ENG-1',
  remoteKey: 'ENG-1',
  title: '<script>alert(1)</script> Ship workspace',
  description: '<img src=x onerror=alert(1)> bounded plain text',
  descriptionTruncated: false,
  status: {
    remoteId: 'status-progress',
    remoteStatusIds: ['status-progress'],
    name: 'In Progress',
    color: '#6b778c',
    category: 'active',
    position: 0,
  },
  dueAt: null,
  priority: { name: 'High', color: '#ef4444' },
  subtasks: [],
  subtasksTruncated: false,
  taskTotalDurationMs: 5_400_000,
  webUrl: 'https://acme.atlassian.net/browse/ENG-1',
  location: { scopeKey: 'acme.atlassian.net', workAreaId: 'board-1', workAreaName: 'Sprint' },
  allowedStatuses: [
    {
      actionValue: '31',
      actionLabel: 'Finish',
      remoteId: 'status-done',
      remoteStatusIds: ['status-done'],
      name: 'Released',
      color: '#36b37e',
      category: 'completed',
      position: 0,
    },
  ],
  actions: [
    { action: 'change_status', supported: true },
    { action: 'add_comment', supported: true },
    { action: 'log_time', supported: true },
  ],
  linkState: { linked: false, epicId: null },
};

function controllerValue(overrides: Record<string, unknown> = {}) {
  return {
    detail: { data: detail, isLoading: false, isError: false, error: null },
    identityAccepted: true,
    identityMismatch: false,
    comments: {
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
      isSuccess: true,
      hasNextPage: false,
      isFetchingNextPage: false,
      isFetchNextPageError: false,
      isRefetching: false,
      refetch: jest.fn(),
    },
    chronologicalComments: [],
    loadEarlier: jest.fn(),
    commentText: '',
    setCommentText: jest.fn(),
    commentsMessage: null,
    mutation: {
      mutate: jest.fn(),
      reset: jest.fn(),
      isPending: false,
      isError: false,
      error: null,
      variables: undefined,
      data: undefined,
    },
    ...overrides,
  };
}

function renderDialog(props: Partial<React.ComponentProps<typeof ExternalTaskDetailDialog>> = {}) {
  // The app mounts every route inside one QueryClientProvider; the comments
  // panel's owned-comment actions hook requires the same context here.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <ExternalTaskDetailDialog
          provider="jira"
          taskId="ENG-1"
          open
          connectionEpoch="connection-jira-a:1"
          onOpenChange={jest.fn()}
          {...props}
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const useExternalTaskTimeEntriesMock = jest.fn();
const useEpicTimeDetailMock = jest.fn();

jest.mock('@/ui/hooks/board/useExternalTaskTimeEntries', () => ({
  useExternalTaskTimeEntries: (...args: unknown[]) =>
    (useExternalTaskTimeEntriesMock as unknown as (...a: unknown[]) => unknown)(...args),
}));

jest.mock('@/ui/hooks/useEpicTimeDetail', () => ({
  useEpicTimeDetail: (...args: unknown[]) => useEpicTimeDetailMock(...args),
}));

const useExternalRichDescriptionEditMock = jest.fn();

jest.mock('@/ui/hooks/board/useExternalRichDescriptionEdit', () => ({
  useExternalRichDescriptionEdit: (...args: unknown[]) =>
    (useExternalRichDescriptionEditMock as unknown as (...a: unknown[]) => unknown)(...args),
}));

// Layer: UI component unit (jsdom + RTL). This spec owns the dialog's
// composition contract — panel admission behind the identity gate, status
// wiring into the lazy child-status controller, layout, and focus — so a
// mounted render is the cheapest reliable layer; the controller, comments,
// time, and rich-edit hooks are mocked because each has its own suite.
describe('ExternalTaskDetailDialog', () => {
  beforeEach(() => {
    useExternalTaskControllerMock.mockReset();
    useExternalTaskControllerMock.mockReturnValue(controllerValue());
    useExternalSubtaskStatusEditorMock.mockReset();
    useExternalSubtaskStatusEditorMock.mockReturnValue({
      editor: null,
      activate: jest.fn(),
      retry: jest.fn(),
      deactivate: jest.fn(),
      selectStatus: jest.fn(),
      isStatusPending: false,
    });
    useExternalTaskTimeEntriesMock.mockReset();
    useExternalTaskTimeEntriesMock.mockReturnValue({
      history: {
        data: undefined,
        isLoading: false,
        isError: false,
        error: null,
        refetch: jest.fn(),
      },
      create: { isPending: false, isError: false, error: null, isSuccess: false, data: undefined },
      createOrigin: null,
      submitCreate: jest.fn(),
      delete: { isPending: false, isError: false, error: null, isSuccess: false, data: undefined },
      submitDelete: jest.fn(),
      verify: { isPending: false, isSuccess: false, data: undefined },
      verifyUnknown: jest.fn(),
      acknowledge: { isPending: false },
      acknowledgeUnknown: jest.fn(),
      unknownOperationId: null,
      blockedByUnknown: false,
      canVerifyUnknown: false,
      writeBlocked: false,
    });
    useEpicTimeDetailMock.mockReset();
    useEpicTimeDetailMock.mockReturnValue({
      admitted: false,
      summary: undefined,
      query: { isLoading: false, isError: false },
    });
    useExternalRichDescriptionEditMock.mockReset();
    useExternalRichDescriptionEditMock.mockReturnValue({
      description: undefined,
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
      verify: { mutate: jest.fn(), isPending: false },
      reload: { mutate: jest.fn(), isPending: false },
      savePending: false,
      verifyPending: false,
      reloadPending: false,
      openPending: false,
    });
  });

  it('keeps the viewport fallback and uses a minmax 70/30 desktop workspace', async () => {
    const { baseElement } = renderDialog();

    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('h-[calc(100vh-2rem)]');
    expect(dialog.className).toContain('supports-[height:100dvh]:h-[calc(100dvh-2rem)]');
    expect(dialog.className).toContain('w-[calc(100vw-2rem)]');

    const columns = dialog.querySelector('.grid.min-h-0.flex-1');
    expect(columns?.className).toContain('lg:grid-cols-[minmax(0,7fr)_minmax(0,3fr)]');
    expect(columns?.className).toContain('grid-cols-1');
    expect(columns?.className).toContain('overflow-y-auto');
    expect(columns?.className).toContain('lg:overflow-hidden');
    expect(Array.from(columns?.children ?? [])).toHaveLength(2);
    for (const child of Array.from(columns?.children ?? [])) {
      expect(child.className).toContain('min-w-0');
    }

    expect(baseElement.querySelector('script')).toBeNull();
    expect(baseElement.querySelector('img')).toBeNull();
    await expect(axe(baseElement)).resolves.toHaveNoViolations();
  });

  it('shows header identity, source action, DevChain action, and an accessible Close', async () => {
    const onCreate = jest.fn();
    const user = userEvent.setup();
    renderDialog({ onCreateDevChainTask: onCreate });

    expect(screen.getByRole('dialog', { name: detail.title })).toBeInTheDocument();
    expect(screen.getByText('Jira · ENG-1 · Sprint')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open in source/i })).toHaveAttribute(
      'href',
      detail.webUrl,
    );

    await user.click(screen.getByRole('button', { name: 'Create DevChain task' }));
    expect(onCreate).toHaveBeenCalledWith(detail);

    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('shows one responsive details band and updates status immediately on selection', async () => {
    const user = userEvent.setup();
    const value = controllerValue();
    useExternalTaskControllerMock.mockReturnValue(value);
    renderDialog();

    const detailsBand = screen.getByRole('region', {
      name: /task details/i,
    });
    expect(detailsBand).toBeInTheDocument();
    expect(within(detailsBand).getAllByText('Status')).toHaveLength(1);
    expect(within(detailsBand).getAllByText('Priority')).toHaveLength(1);
    expect(within(detailsBand).getAllByText('Due')).toHaveLength(1);
    expect(detailsBand.querySelector('dl')?.className).toContain('sm:grid-cols-3');
    expect(screen.queryByRole('heading', { name: 'Properties' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /activity/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /more|overflow/i })).not.toBeInTheDocument();

    const status = screen.getByRole('combobox', { name: 'Status' });
    expect(status).toHaveDisplayValue('In Progress');
    expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument();
    await user.selectOptions(status, '31');
    expect(value.mutation.mutate).toHaveBeenCalledTimes(1);
    expect(value.mutation.mutate).toHaveBeenCalledWith(
      {
        action: 'change_status',
        input: { status: '31' },
      },
      { onError: expect.any(Function) },
    );
    expect(status).toHaveDisplayValue('Finish (Released)');

    expect(screen.getByText('High')).toBeInTheDocument();
    expect(screen.getByText('None')).toBeInTheDocument();
  });

  it('disables status while an update is pending', () => {
    useExternalTaskControllerMock.mockReturnValue(
      controllerValue({
        mutation: {
          mutate: jest.fn(),
          reset: jest.fn(),
          isPending: true,
          isError: false,
          error: null,
          variables: { action: 'change_status', input: { status: '31' } },
          data: undefined,
        },
      }),
    );
    renderDialog();

    expect(screen.getByRole('combobox', { name: 'Status' })).toBeDisabled();
  });

  it('restores the current status when an immediate update fails', async () => {
    const user = userEvent.setup();
    const mutate = jest.fn((_request: unknown, options?: { onError?: () => void }) =>
      options?.onError?.(),
    );
    useExternalTaskControllerMock.mockReturnValue(
      controllerValue({
        mutation: {
          mutate,
          reset: jest.fn(),
          isPending: false,
          isError: true,
          error: new Error('Transition failed.'),
          variables: { action: 'change_status', input: { status: '31' } },
          data: undefined,
        },
      }),
    );
    renderDialog();

    const status = screen.getByRole('combobox', { name: 'Status' });
    await user.selectOptions(status, '31');

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(status).toHaveDisplayValue('In Progress');
    expect(screen.getByRole('alert')).toHaveTextContent('Transition failed.');
  });

  it('shows the transition label beside the destination name and keeps duplicate destinations distinct', async () => {
    const user = userEvent.setup();
    const value = controllerValue({
      detail: {
        data: {
          ...detail,
          allowedStatuses: [
            {
              actionValue: '31',
              actionLabel: 'Finish',
              remoteId: 'status-done',
              remoteStatusIds: ['status-done'],
              name: 'Released',
              color: '#36b37e',
              category: 'completed',
              position: 0,
            },
            {
              actionValue: '61',
              actionLabel: 'Fast-track',
              remoteId: 'status-done',
              remoteStatusIds: ['status-done'],
              name: 'Released',
              color: '#36b37e',
              category: 'completed',
              position: 1,
            },
            {
              actionValue: 'Ship It',
              remoteId: 'ship',
              remoteStatusIds: ['ship'],
              name: 'Ship It',
              color: '#7c4dff',
              category: 'active',
              position: 2,
            },
          ],
        },
        isLoading: false,
        isError: false,
        error: null,
      },
    });
    useExternalTaskControllerMock.mockReturnValue(value);
    renderDialog();

    const status = screen.getByRole('combobox', { name: 'Status' });
    const options = within(status).getAllByRole('option') as HTMLOptionElement[];
    expect(options.map((option) => option.textContent)).toEqual([
      'In Progress',
      'Finish (Released)',
      'Fast-track (Released)',
      'Ship It',
    ]);

    await user.selectOptions(status, '61');
    expect(value.mutation.mutate).toHaveBeenCalledWith(
      {
        action: 'change_status',
        input: { status: '61' },
      },
      { onError: expect.any(Function) },
    );
  });

  it('keeps description primary and composes collapsed time with lazy history', () => {
    renderDialog();

    const descriptionHeading = screen.getByRole('heading', { name: 'Description' });
    expect(descriptionHeading).toBeInTheDocument();
    expect(descriptionHeading.closest('section')).toHaveClass('border', 'bg-card');
    expect(screen.getByText(detail.description!)).toBeInTheDocument();

    const timeHeading = screen.getByRole('heading', { name: 'Time tracked' });
    expect(timeHeading.closest('section')).toHaveTextContent('1h 30m');
    expect(screen.getByRole('button', { name: 'Expand Time tracked' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByRole('form', { name: 'Log time' })).toBeNull();
    expect(screen.getByText('Recent time entries', { selector: 'summary' })).not.toBeVisible();
  });

  it('renders subtasks with status-only controls between Description and Time tracked', async () => {
    const activate = jest.fn();
    useExternalSubtaskStatusEditorMock.mockReturnValue({
      editor: null,
      activate,
      retry: jest.fn(),
      deactivate: jest.fn(),
      selectStatus: jest.fn(),
      isStatusPending: false,
    });
    useExternalTaskControllerMock.mockReturnValue(
      controllerValue({
        detail: {
          data: {
            ...detail,
            subtasks: [
              {
                remoteId: '10001',
                remoteKey: 'ENG-2',
                title: 'Nested child card',
                status: { remoteId: 'st-progress', name: 'In Progress', category: 'active' },
                webUrl: 'https://acme.atlassian.net/browse/ENG-2',
              },
              {
                remoteId: '10002',
                remoteKey: 'ENG-3',
                title: 'Unlinked child card',
                status: { name: 'Done', category: 'completed' },
                webUrl: null,
              },
            ],
          },
          isLoading: false,
          isError: false,
          error: null,
        },
      }),
    );
    renderDialog();

    const description = screen.getByRole('heading', { name: 'Description' });
    const subtasksHeading = screen.getByRole('heading', { name: 'Subtasks' });
    const timeHeading = screen.getByRole('heading', { name: 'Time tracked' });
    expect(description.compareDocumentPosition(subtasksHeading)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(subtasksHeading.compareDocumentPosition(timeHeading)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    const panel = screen.getByRole('region', { name: 'Subtasks' });
    expect(within(panel).getByText('ENG-2')).toBeInTheDocument();
    expect(within(panel).getByText('Nested child card')).toBeInTheDocument();
    expect(within(panel).getByText('In Progress')).toBeInTheDocument();
    expect(within(panel).getByText('ENG-3')).toBeInTheDocument();
    expect(within(panel).getByText('Done')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'Open ENG-2 in source' })).toHaveAttribute(
      'href',
      'https://acme.atlassian.net/browse/ENG-2',
    );
    expect(within(panel).queryByRole('link', { name: /ENG-3/i })).not.toBeInTheDocument();

    // Child rows expose status controls only: no comment, time, import,
    // DevChain-link, or bulk actions may appear inside the panel.
    const buttons = within(panel).getAllByRole('button');
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button).toHaveAccessibleName(/Change status for ENG-\d/);
    }
    expect(within(panel).queryAllByRole('form')).toHaveLength(0);
    expect(within(panel).queryAllByRole('combobox')).toHaveLength(0);
    expect(within(panel).getAllByRole('link')).toHaveLength(1);

    // The row status control runs through the lazy child-status controller.
    await userEvent.setup().click(screen.getByRole('button', { name: 'Change status for ENG-2' }));
    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledWith('10001');
    expect(useExternalSubtaskStatusEditorMock).toHaveBeenCalledWith('jira', {
      connectionEpoch: 'connection-jira-a:1',
      parentTaskId: 'ENG-1',
      enabled: true,
    });
  });

  it('renders no Subtasks panel for a task without children', () => {
    renderDialog();

    expect(screen.queryByRole('region', { name: 'Subtasks' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Subtasks' })).not.toBeInTheDocument();
  });

  it('keeps the Subtasks panel with only the incomplete notice for a partial empty list', () => {
    useExternalTaskControllerMock.mockReturnValue(
      controllerValue({
        detail: {
          data: { ...detail, subtasks: [], subtasksTruncated: true },
          isLoading: false,
          isError: false,
          error: null,
        },
      }),
    );
    renderDialog();

    const panel = screen.getByRole('region', { name: 'Subtasks' });
    expect(
      within(panel).getByText(
        'Incomplete list — the provider did not return every direct subtask.',
      ),
    ).toBeInTheDocument();
    expect(within(panel).queryByRole('listitem')).not.toBeInTheDocument();
  });

  it('composes the comments panel in the Comments column', () => {
    useExternalTaskControllerMock.mockReturnValue(controllerValue({ chronologicalComments: [] }));
    renderDialog();

    const history = screen.getByRole('region', { name: 'Comments history' });
    expect(history).toHaveClass(
      'max-h-96',
      'flex-none',
      'overflow-y-auto',
      'overscroll-contain',
      'lg:max-h-none',
      'lg:flex-1',
    );
    const commentsHeading = screen.getByRole('heading', { name: 'Comments' });
    expect(commentsHeading.closest('section')).toHaveClass('flex-none', 'lg:flex-1');
    expect(screen.getByRole('textbox', { name: 'Comment' })).toBeInTheDocument();
  });

  it('announces status success with an existing theme role', () => {
    useExternalTaskControllerMock.mockReturnValue(
      controllerValue({
        mutation: {
          mutate: jest.fn(),
          reset: jest.fn(),
          isPending: false,
          isError: false,
          error: null,
          variables: { action: 'change_status', input: { status: '31' } },
          data: { remoteTaskId: 'ENG-1', action: 'change_status', succeeded: true, refresh: [] },
        },
      }),
    );
    renderDialog();

    const success = screen.getByText('Status updated.');
    expect(success).toHaveAttribute('role', 'status');
    expect(success).toHaveClass('text-primary');
  });

  it('renders detail loading and error states without breaking the layout', () => {
    useExternalTaskControllerMock.mockReturnValue(
      controllerValue({
        detail: { data: undefined, isLoading: true, isError: false, error: null },
      }),
    );
    const first = renderDialog();
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent('Loading task detail');
    first.unmount();

    useExternalTaskControllerMock.mockReturnValue(
      controllerValue({
        detail: {
          data: undefined,
          isLoading: false,
          isError: true,
          error: new Error('Task detail could not be loaded.'),
        },
      }),
    );
    renderDialog();
    expect(screen.getByRole('alert')).toHaveTextContent('Task detail unavailable');
    expect(screen.getByText('Jira · Loading task detail')).toBeInTheDocument();
  });

  it('keeps remaining actions and a linked DevChain action intact', () => {
    useExternalTaskControllerMock.mockReturnValue(
      controllerValue({
        detail: {
          data: {
            ...detail,
            linkState: { linked: true, epicId: 'epic-1' },
          },
          isLoading: false,
          isError: false,
          error: null,
        },
        mutation: {
          mutate: jest.fn(),
          reset: jest.fn(),
          isPending: false,
          isError: true,
          error: new Error('Transition requires fields. Complete it in Jira.'),
          variables: { action: 'change_status', input: { status: '31' } },
          data: undefined,
        },
      }),
    );
    renderDialog();

    expect(screen.getByRole('link', { name: 'Open linked DevChain task' })).toHaveAttribute(
      'href',
      '/epics/epic-1',
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Transition requires fields');
    expect(screen.queryByRole('button', { name: 'Create DevChain task' })).not.toBeInTheDocument();
  });

  it('renders unsupported status and time actions read-only with guidance', () => {
    useExternalTaskControllerMock.mockReturnValue(
      controllerValue({
        detail: {
          data: {
            ...detail,
            allowedStatuses: [],
            actions: detail.actions.map((action) =>
              action.action === 'change_status' ? { ...action, supported: false } : action,
            ),
          },
          isLoading: false,
          isError: false,
          error: null,
        },
      }),
    );
    renderDialog();

    expect(screen.getByText(detail.description!)).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Status' })).not.toBeInTheDocument();
    expect(screen.getByText(detail.status.name)).toBeInTheDocument();
  });

  it('keeps the time section as a quiet summary when the provider cannot track time', async () => {
    useExternalTaskControllerMock.mockReturnValue(
      controllerValue({
        detail: {
          data: {
            ...detail,
            actions: detail.actions.map((action) =>
              action.action === 'log_time' ? { ...action, supported: false } : action,
            ),
          },
          isLoading: false,
          isError: false,
          error: null,
        },
      }),
    );
    const { baseElement } = renderDialog();
    const user = userEvent.setup();

    const timeSection = screen.getByRole('heading', { name: 'Time tracked' }).closest('section');
    expect(timeSection).toHaveTextContent('1h 30m');
    await user.click(screen.getByRole('button', { name: 'Expand Time tracked' }));
    expect(timeSection).toHaveTextContent('Time tracking is unavailable.');
    expect(screen.queryByRole('form', { name: 'Log time' })).not.toBeInTheDocument();
    expect(
      screen.queryByText('Recent time entries', { selector: 'summary' }),
    ).not.toBeInTheDocument();
    await expect(axe(baseElement)).resolves.toHaveNoViolations();
  });

  it('returns focus to the supplied target on close', async () => {
    const user = userEvent.setup();
    const card = document.createElement('button');
    card.textContent = 'Open task card';
    document.body.appendChild(card);
    card.focus();
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <MemoryRouter>
          <QueryClientProvider client={new QueryClient()}>
            <ExternalTaskDetailDialog
              provider="jira"
              taskId="ENG-1"
              open={open}
              onOpenChange={setOpen}
              connectionEpoch="connection-jira-a:1"
              returnFocusTo={() => card}
            />
          </QueryClientProvider>
        </MemoryRouter>
      );
    }
    render(<Harness />);

    await user.keyboard('{Escape}');

    await waitFor(() => expect(card).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
    card.remove();
  });

  it('returns focus to its own heading when no target is supplied', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <MemoryRouter>
          <QueryClientProvider client={new QueryClient()}>
            <ExternalTaskDetailDialog
              provider="jira"
              taskId="ENG-1"
              open={open}
              onOpenChange={setOpen}
              connectionEpoch="connection-jira-a:1"
            />
          </QueryClientProvider>
        </MemoryRouter>
      );
    }
    render(<Harness />);
    // The heading unmounts with the dialog, so observe the focus call itself
    // rather than post-unmount document.activeElement.
    const heading = screen.getByRole('heading', { name: detail.title });
    const focusSpy = jest.spyOn(heading, 'focus');

    await user.keyboard('{Escape}');

    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it('publishes the Import focus target preferring the Create button, then clears it', () => {
    const onImportFocusTargetReady = jest.fn();
    const { unmount } = renderDialog({ onImportFocusTargetReady });

    const resolver = onImportFocusTargetReady.mock.calls[0][0] as () => HTMLElement | null;
    expect(resolver()).toBe(screen.getByRole('button', { name: 'Create DevChain task' }));

    unmount();
    expect(onImportFocusTargetReady).toHaveBeenLastCalledWith(null);
  });

  it('falls back to the heading for the Import target without a Create button', () => {
    const onImportFocusTargetReady = jest.fn();
    useExternalTaskControllerMock.mockReturnValue(
      controllerValue({
        detail: {
          data: { ...detail, linkState: { linked: true, epicId: 'epic-1' } },
          isLoading: false,
          isError: false,
          error: null,
        },
      }),
    );
    renderDialog({ onImportFocusTargetReady });

    const resolver = onImportFocusTargetReady.mock.calls[0][0] as () => HTMLElement | null;
    expect(resolver()).toBe(screen.getByRole('heading', { name: detail.title }));
  });

  it('shows the linked-task mismatch state with a route back and no cached comments, composer, or actions', () => {
    const cachedComment: ExternalTaskComment = {
      remoteId: 'C1',
      author: { remoteId: 'author-c1', displayName: 'Author C1' },
      body: 'Cached comment body',
      bodyTruncated: false,
      createdAt: '2026-08-20T12:00:00.000Z',
      updatedAt: null,
    };
    useExternalTaskControllerMock.mockReturnValue(
      controllerValue({
        identityAccepted: false,
        identityMismatch: true,
        detail: { data: undefined, isLoading: false, isError: false, error: null },
        comments: {
          data: { pages: [{ comments: [cachedComment], nextCursor: null }], pageParams: [null] },
        },
        chronologicalComments: [cachedComment],
      }),
    );
    renderDialog({ expectedLinkedEpicId: 'epic-1' });

    expect(useExternalTaskControllerMock).toHaveBeenCalledWith('jira', 'ENG-1', {
      enabled: true,
      connectionEpoch: 'connection-jira-a:1',
      expectedLinkedEpicId: 'epic-1',
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Linked task unavailable for the current connection',
    );
    expect(screen.getByText('Jira · Linked task unavailable')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open expected DevChain task' })).toHaveAttribute(
      'href',
      '/epics/epic-1',
    );
    expect(screen.queryByText('Cached comment body')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Comments history' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Comment' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create DevChain task' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Open linked DevChain task' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /open in source/i })).not.toBeInTheDocument();
    // An identity mismatch admits no subtask row and no child status action.
    expect(screen.queryByRole('region', { name: 'Subtasks' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /change status for/i })).not.toBeInTheDocument();
  });

  it('renders the accepted linked workspace and admits its estimate only after expansion', async () => {
    useExternalTaskControllerMock.mockReturnValue(
      controllerValue({
        detail: {
          data: { ...detail, linkState: { linked: true, epicId: 'epic-1' } },
          isLoading: false,
          isError: false,
          error: null,
        },
      }),
    );
    renderDialog({ expectedLinkedEpicId: 'epic-1' });

    expect(screen.getByRole('dialog', { name: detail.title })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open in source/i })).toHaveAttribute(
      'href',
      detail.webUrl,
    );
    expect(
      screen.queryByRole('link', { name: 'Open linked DevChain task' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create DevChain task' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Comments' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Comment' })).toBeInTheDocument();
    expect(useEpicTimeDetailMock).toHaveBeenCalledWith('epic-1', { enabled: false });

    await userEvent.setup().click(screen.getByRole('button', { name: 'Expand Time tracked' }));
    expect(useEpicTimeDetailMock).toHaveBeenLastCalledWith('epic-1', { enabled: true });
  });
});

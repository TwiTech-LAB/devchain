import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import type { ExternalTaskSubtaskSummary } from '@/modules/external-integrations/models/external-provider.models';
import { ExternalTaskSubtasksPanel } from './ExternalTaskSubtasksPanel';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

// Layer: UI component unit. The lazy status controller is mocked because this
// spec owns the row-rendering contract for each controller state; the
// controller has its own suite.
const useExternalSubtaskStatusEditorMock = jest.fn();

jest.mock('../../hooks/board/useExternalSubtaskStatusEditor', () => ({
  useExternalSubtaskStatusEditor: (...args: unknown[]) =>
    useExternalSubtaskStatusEditorMock(...args),
}));

function subtask(overrides: Partial<ExternalTaskSubtaskSummary> = {}): ExternalTaskSubtaskSummary {
  return {
    remoteId: '10001',
    remoteKey: 'ENG-2',
    title: 'Ship the subtasks panel',
    status: { remoteId: 'st-progress', name: 'In Progress', category: 'active' },
    webUrl: 'https://acme.atlassian.net/browse/ENG-2',
    ...overrides,
  };
}

const transitionOption = {
  actionValue: '31',
  actionLabel: 'Finish',
  remoteId: 'status-done',
  remoteStatusIds: ['status-done'],
  name: 'Released',
  color: '#36b37e',
  category: 'completed' as const,
  position: 0,
};

function editorValue(overrides: Record<string, unknown> = {}) {
  return {
    editor: null,
    activate: jest.fn(),
    retry: jest.fn(),
    deactivate: jest.fn(),
    selectStatus: jest.fn(),
    isStatusPending: false,
    ...overrides,
  };
}

function renderPanel(props: Partial<React.ComponentProps<typeof ExternalTaskSubtasksPanel>> = {}) {
  return render(
    <ExternalTaskSubtasksPanel
      projectId={PROJECT_ID}
      provider="jira"
      subtasks={[subtask()]}
      subtasksTruncated={false}
      connectionEpoch="connection-jira-a:1"
      parentTaskId="ENG-1"
      identityAccepted
      {...props}
    />,
  );
}

describe('ExternalTaskSubtasksPanel', () => {
  beforeEach(() => {
    useExternalSubtaskStatusEditorMock.mockReset();
    useExternalSubtaskStatusEditorMock.mockReturnValue(editorValue());
  });

  it('renders every direct child with key, title, and status', async () => {
    const { baseElement } = renderPanel({
      subtasks: [
        subtask(),
        subtask({
          remoteId: '10002',
          remoteKey: 'ENG-3',
          title: 'Keep orphan subtasks visible',
          status: { name: 'Done', category: 'completed' },
        }),
      ],
    });

    const panel = screen.getByRole('region', { name: 'Subtasks' });
    const rows = within(panel).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(panel).getByText('ENG-2')).toBeInTheDocument();
    expect(within(panel).getByText('Ship the subtasks panel')).toBeInTheDocument();
    expect(within(panel).getByText('In Progress')).toBeInTheDocument();
    expect(within(panel).getByText('ENG-3')).toBeInTheDocument();
    expect(within(panel).getByText('Keep orphan subtasks visible')).toBeInTheDocument();
    expect(within(panel).getByText('Done')).toBeInTheDocument();
    await expect(axe(baseElement)).resolves.toHaveNoViolations();
  });

  it('admits the lazy status editor only behind the identity gate', () => {
    renderPanel({ identityAccepted: false });

    expect(useExternalSubtaskStatusEditorMock).toHaveBeenCalledWith('jira', {
      projectId: PROJECT_ID,
      connectionEpoch: 'connection-jira-a:1',
      parentTaskId: 'ENG-1',
      enabled: false,
    });
    const panel = screen.getByRole('region', { name: 'Subtasks' });
    expect(within(panel).queryByRole('button')).not.toBeInTheDocument();
    expect(within(panel).getByText('In Progress')).toBeInTheDocument();
  });

  it('wires the status editor to the panel scope and activates a row lazily', async () => {
    const user = userEvent.setup();
    const activate = jest.fn();
    useExternalSubtaskStatusEditorMock.mockReturnValue(editorValue({ activate }));
    renderPanel();

    expect(useExternalSubtaskStatusEditorMock).toHaveBeenCalledWith('jira', {
      projectId: PROJECT_ID,
      connectionEpoch: 'connection-jira-a:1',
      parentTaskId: 'ENG-1',
      enabled: true,
    });
    await user.click(screen.getByRole('button', { name: 'Change status for ENG-2' }));
    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledWith('10001');
  });

  it('exposes no comment, time, import, DevChain-link, or bulk controls on rows', () => {
    renderPanel();

    const panel = screen.getByRole('region', { name: 'Subtasks' });
    const buttons = within(panel).getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAccessibleName('Change status for ENG-2');
    expect(within(panel).queryAllByRole('combobox')).toHaveLength(0);
    expect(within(panel).queryAllByRole('form')).toHaveLength(0);
    expect(within(panel).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(panel).getAllByRole('link')).toHaveLength(1);
  });

  it('shows local loading inside the activated row before fresh options appear', () => {
    useExternalSubtaskStatusEditorMock.mockReturnValue(
      editorValue({
        editor: { taskId: '10001', phase: 'loading' },
      }),
    );
    renderPanel();

    expect(screen.getByRole('status')).toHaveTextContent('Loading status options');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByText('In Progress')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /change status/i })).not.toBeInTheDocument();
  });

  it('renders the native select with the child detail status and exact transition labels', async () => {
    const user = userEvent.setup();
    const selectStatus = jest.fn();
    useExternalSubtaskStatusEditorMock.mockReturnValue(
      editorValue({
        editor: {
          taskId: '10001',
          phase: 'ready',
          currentStatus: {
            remoteId: 'st-progress',
            remoteStatusIds: ['st-progress'],
            name: 'In Progress',
            color: '#6b778c',
            category: 'active',
            position: 0,
          },
          options: [
            transitionOption,
            {
              actionValue: 'ship',
              remoteId: 'ship',
              remoteStatusIds: ['ship'],
              name: 'Ship It',
              color: '#7c4dff',
              category: 'active',
              position: 1,
            },
          ],
        },
        selectStatus,
      }),
    );
    renderPanel();

    const select = screen.getByRole('combobox', { name: 'Change status for ENG-2' });
    const options = within(select).getAllByRole('option') as HTMLOptionElement[];
    expect(options.map((option) => option.textContent)).toEqual([
      'In Progress',
      'Finish (Released)',
      'Ship It',
    ]);
    expect(options[0].disabled).toBe(true);

    await user.selectOptions(select, '31');
    expect(selectStatus).toHaveBeenCalledTimes(1);
    expect(selectStatus).toHaveBeenCalledWith('31');
  });

  it.each([
    [
      'unsupported status changes',
      {
        taskId: '10001',
        phase: 'unavailable',
        currentStatus: { name: 'In Progress' },
        reason: 'unsupported',
      },
      'Status changes are unavailable for this subtask.',
    ],
    [
      'no transitions',
      {
        taskId: '10001',
        phase: 'unavailable',
        currentStatus: { name: 'In Progress' },
        reason: 'no_transitions',
      },
      'No status changes are available for this subtask.',
    ],
  ])('keeps a row read-only for %s', (_case, editor, expectedText) => {
    useExternalSubtaskStatusEditorMock.mockReturnValue(editorValue({ editor }));
    renderPanel();

    expect(screen.getByText(expectedText)).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /change status|retry/i })).not.toBeInTheDocument();
  });

  it('disables every child activation while one status write is pending', () => {
    useExternalSubtaskStatusEditorMock.mockReturnValue(
      editorValue({
        editor: {
          taskId: '10001',
          phase: 'pending',
          selectedStatus: transitionOption,
        },
        isStatusPending: true,
      }),
    );
    renderPanel({
      subtasks: [subtask(), subtask({ remoteId: '10002', remoteKey: 'ENG-3', title: 'Second' })],
    });

    expect(screen.getByText('Finish (Released)')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Updating status');
    const other = screen.getByRole('button', { name: 'Change status for ENG-3' });
    expect(other).toBeDisabled();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('keeps a failure local to its row and retries with a fresh read', async () => {
    const user = userEvent.setup();
    const retry = jest.fn();
    const guidance =
      'DevChain cannot reconstruct this subtask in assigned work. Refresh the connected board, or open the task in the provider and change it there.';
    useExternalSubtaskStatusEditorMock.mockReturnValue(
      editorValue({
        editor: {
          taskId: '10001',
          phase: 'error',
          error: new Error(guidance),
        },
        retry,
      }),
    );
    renderPanel();

    expect(screen.getByRole('alert')).toHaveTextContent(guidance);
    expect(screen.getByRole('link', { name: 'Open ENG-2 in source' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('holds the confirmed label and announces success until refreshed detail replaces it', () => {
    useExternalSubtaskStatusEditorMock.mockReturnValue(
      editorValue({
        editor: { taskId: '10001', phase: 'success', confirmedStatus: transitionOption },
      }),
    );
    const { rerender } = renderPanel();

    expect(screen.getByText('Finish (Released)')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Subtask status updated.');

    rerender(
      <ExternalTaskSubtasksPanel
        projectId={PROJECT_ID}
        provider="jira"
        subtasks={[
          subtask({
            status: { remoteId: 'status-done', name: 'Released', category: 'completed' },
          }),
        ]}
        subtasksTruncated={false}
        connectionEpoch="connection-jira-a:1"
        parentTaskId="ENG-1"
        identityAccepted
      />,
    );

    expect(screen.queryByText('Finish (Released)')).not.toBeInTheDocument();
    expect(screen.getByText('Released')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('replaces the hold for a second confirmed transition on the same child', () => {
    const fastTrackOption = {
      actionValue: '61',
      actionLabel: 'Fast-track',
      remoteId: 'status-shipped',
      remoteStatusIds: ['status-shipped'],
      name: 'Shipped',
      color: '#7c4dff',
      category: 'active' as const,
      position: 0,
    };
    useExternalSubtaskStatusEditorMock.mockReturnValue(
      editorValue({
        editor: { taskId: '10001', phase: 'success', confirmedStatus: transitionOption },
      }),
    );
    const { rerender } = renderPanel();

    expect(screen.getByText('Finish (Released)')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Subtask status updated.');

    // First refreshed summary replaces the first hold.
    rerender(
      <ExternalTaskSubtasksPanel
        projectId={PROJECT_ID}
        provider="jira"
        subtasks={[
          subtask({
            status: { remoteId: 'status-done', name: 'Released', category: 'completed' },
          }),
        ]}
        subtasksTruncated={false}
        connectionEpoch="connection-jira-a:1"
        parentTaskId="ENG-1"
        identityAccepted
      />,
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    // A second confirmed transition on the same child holds its own label.
    useExternalSubtaskStatusEditorMock.mockReturnValue(
      editorValue({
        editor: { taskId: '10001', phase: 'success', confirmedStatus: fastTrackOption },
      }),
    );
    rerender(
      <ExternalTaskSubtasksPanel
        projectId={PROJECT_ID}
        provider="jira"
        subtasks={[
          subtask({
            status: { remoteId: 'status-done', name: 'Released', category: 'completed' },
          }),
        ]}
        subtasksTruncated={false}
        connectionEpoch="connection-jira-a:1"
        parentTaskId="ENG-1"
        identityAccepted
      />,
    );

    expect(screen.getByText('Fast-track (Shipped)')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Subtask status updated.');

    // The second refreshed summary replaces the second hold.
    rerender(
      <ExternalTaskSubtasksPanel
        projectId={PROJECT_ID}
        provider="jira"
        subtasks={[
          subtask({
            status: { remoteId: 'status-shipped', name: 'Shipped', category: 'active' },
          }),
        ]}
        subtasksTruncated={false}
        connectionEpoch="connection-jira-a:1"
        parentTaskId="ENG-1"
        identityAccepted
      />,
    );

    expect(screen.queryByText('Fast-track (Shipped)')).not.toBeInTheDocument();
    expect(screen.getByText('Shipped')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('clears a held label when the workspace scope changes under a colliding child id', () => {
    useExternalSubtaskStatusEditorMock.mockReturnValue(
      editorValue({
        editor: { taskId: '10001', phase: 'success', confirmedStatus: transitionOption },
      }),
    );
    const { rerender } = renderPanel();

    expect(screen.getByText('Finish (Released)')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Subtask status updated.');

    rerender(
      <ExternalTaskSubtasksPanel
        projectId={PROJECT_ID}
        provider="jira"
        subtasks={[subtask()]}
        subtasksTruncated={false}
        connectionEpoch="connection-jira-b:2"
        parentTaskId="ENG-9"
        identityAccepted
      />,
    );

    expect(screen.queryByText('Finish (Released)')).not.toBeInTheDocument();
    expect(screen.getByText('In Progress')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('links only accepted source URLs and keeps rejected URLs as plain rows', () => {
    renderPanel({
      subtasks: [
        subtask(),
        subtask({
          remoteId: '10003',
          remoteKey: 'ENG-4',
          title: 'No safe link',
          webUrl: 'https://evil.example.com/browse/ENG-4',
        }),
        subtask({
          remoteId: '10004',
          remoteKey: 'ENG-5',
          title: 'No link at all',
          webUrl: null,
        }),
      ],
    });

    const panel = screen.getByRole('region', { name: 'Subtasks' });
    expect(within(panel).getByRole('link', { name: 'Open ENG-2 in source' })).toHaveAttribute(
      'href',
      'https://acme.atlassian.net/browse/ENG-2',
    );
    expect(within(panel).queryByRole('link', { name: /ENG-4/i })).not.toBeInTheDocument();
    expect(within(panel).queryByRole('link', { name: /ENG-5/i })).not.toBeInTheDocument();
    expect(within(panel).getByText('No safe link')).toBeInTheDocument();
    expect(within(panel).getByText('No link at all')).toBeInTheDocument();
  });

  it('renders no panel for an empty complete list', () => {
    renderPanel({ subtasks: [], subtasksTruncated: false });

    expect(screen.queryByRole('region', { name: 'Subtasks' })).not.toBeInTheDocument();
  });

  it('shows the incomplete notice for a partial result, including zero rows', () => {
    const { rerender } = renderPanel({
      subtasks: [subtask()],
      subtasksTruncated: true,
    });

    expect(
      screen.getByText('Incomplete list — the provider did not return every direct subtask.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Subtasks' })).toBeInTheDocument();

    rerender(
      <ExternalTaskSubtasksPanel
        projectId={PROJECT_ID}
        provider="jira"
        subtasks={[]}
        subtasksTruncated
        connectionEpoch="connection-jira-a:1"
        parentTaskId="ENG-1"
        identityAccepted
      />,
    );

    expect(
      screen.getByText('Incomplete list — the provider did not return every direct subtask.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  });

  it('has no accessibility violations with an open row editor', async () => {
    useExternalSubtaskStatusEditorMock.mockReturnValue(
      editorValue({
        editor: {
          taskId: '10001',
          phase: 'ready',
          currentStatus: {
            remoteId: 'st-progress',
            remoteStatusIds: ['st-progress'],
            name: 'In Progress',
            color: '#6b778c',
            category: 'active',
            position: 0,
          },
          options: [transitionOption],
        },
      }),
    );
    const { baseElement } = renderPanel();

    await expect(axe(baseElement)).resolves.toHaveNoViolations();
  });
});

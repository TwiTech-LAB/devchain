import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { useState } from 'react';
import type { ExternalTaskDetail } from '@/modules/external-integrations/models/external-provider.models';
import { ExternalTaskImportDialog } from './ExternalTaskImportDialog';

const useExternalTaskImportMock = jest.fn();
jest.mock('../../hooks/board/useExternalTaskImport', () => ({
  useExternalTaskImport: (...args: unknown[]) => useExternalTaskImportMock(...args),
}));

const detail: ExternalTaskDetail = {
  remoteId: 'task-1',
  remoteKey: 'CU-1',
  title: '<script>Remote title</script>',
  description: '<img>Remote description',
  descriptionTruncated: false,
  status: { remoteId: 'open', name: 'OPEN', color: '#777777', category: 'active', position: 0 },
  dueAt: null,
  priority: null,
  webUrl: 'https://app.clickup.com/t/task-1',
  location: { scopeKey: 'workspace-1', workAreaId: 'list-1', workAreaName: 'Sprint' },
  allowedStatuses: [],
  actions: [],
  linkState: { linked: false, epicId: null },
};

const projects = {
  data: {
    items: [
      { id: 'project-1', name: 'Product' },
      { id: 'project-2', name: 'Platform' },
    ],
  },
};

function controllerValue(projectItems = projects.data.items) {
  return {
    projects: { data: { items: projectItems } },
    statuses: {
      data: {
        items: [
          {
            id: 'status-1',
            projectId: 'project-1',
            label: 'New',
            color: '#777777',
            position: 0,
          },
        ],
      },
      isLoading: false,
    },
    mutation: {
      mutate: jest.fn(),
      reset: jest.fn(),
      isPending: false,
      isError: false,
      error: null,
    },
  };
}

describe('ExternalTaskImportDialog', () => {
  it.each([true, false])(
    'prefills safe text and navigates from the minimal response when created=%s',
    async (created) => {
      const user = userEvent.setup();
      const mutate = jest.fn();
      const onImported = jest.fn();
      useExternalTaskImportMock.mockReturnValue({
        projects: { data: { items: [{ id: 'project-1', name: 'Product' }] } },
        statuses: {
          data: {
            items: [
              {
                id: 'status-1',
                projectId: 'project-1',
                label: 'New',
                color: '#777777',
                position: 0,
              },
            ],
          },
          isLoading: false,
        },
        mutation: { mutate, reset: jest.fn(), isPending: false, isError: false, error: null },
      });

      const { baseElement } = render(
        <ExternalTaskImportDialog
          provider="clickup"
          detail={detail}
          open
          enabled
          connectionEpoch="connection-clickup-a:1"
          onOpenChange={jest.fn()}
          onImported={onImported}
        />,
      );

      expect(screen.getByLabelText('Title')).toHaveValue(detail.title);
      expect(screen.getByLabelText('Description')).toHaveValue(detail.description);
      expect(baseElement.querySelector('script')).toBeNull();
      expect(screen.getByRole('button', { name: 'Create task' })).toBeDisabled();

      await user.selectOptions(screen.getByLabelText('Project'), 'project-1');
      await user.selectOptions(screen.getByLabelText('Status'), 'status-1');
      await user.clear(screen.getByLabelText('Title'));
      await user.type(screen.getByLabelText('Title'), 'Edited title');
      await user.click(screen.getByRole('button', { name: 'Create task' }));

      expect(mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'project-1',
          statusId: 'status-1',
          title: 'Edited title',
        }),
        expect.objectContaining({ onSuccess: expect.any(Function) }),
      );
      const mutationOptions = mutate.mock.calls[0][1];
      const epicId = created ? 'new-epic' : 'existing-epic';
      mutationOptions.onSuccess({ epic: { id: epicId, projectId: 'project-1' }, created });
      expect(onImported).toHaveBeenCalledWith(epicId);
      expect(await axe(baseElement)).toHaveNoViolations();
    },
  );

  it.each([
    ['escape key', async (user: ReturnType<typeof userEvent.setup>) => user.keyboard('{Escape}')],
    [
      'cancel button',
      async (user: ReturnType<typeof userEvent.setup>) =>
        user.click(screen.getByRole('button', { name: 'Cancel' })),
    ],
  ])('closing via %s restores focus to the supplied target', async (_case, close) => {
    const user = userEvent.setup();
    useExternalTaskImportMock.mockReturnValue({
      projects: { data: { items: [] } },
      statuses: { data: undefined, isLoading: false },
      mutation: {
        mutate: jest.fn(),
        reset: jest.fn(),
        isPending: false,
        isError: false,
        error: null,
      },
    });
    const origin = document.createElement('button');
    origin.textContent = 'Create DevChain task';
    document.body.appendChild(origin);
    origin.focus();
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <ExternalTaskImportDialog
          provider="clickup"
          detail={detail}
          open={open}
          enabled
          connectionEpoch="connection-clickup-a:1"
          onOpenChange={setOpen}
          onImported={jest.fn()}
          returnFocusTo={() => origin}
        />
      );
    }
    render(<Harness />);

    await close(user);

    // Radix's default close-focus target for a triggerless dialog is body;
    // the explicit target must win.
    await waitFor(() => expect(origin).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
    origin.remove();
  });
});

describe('ExternalTaskImportDialog project preselection', () => {
  beforeEach(() => {
    useExternalTaskImportMock.mockReset();
    useExternalTaskImportMock.mockReturnValue(controllerValue());
  });

  function renderDialog(overrides: Partial<Parameters<typeof ExternalTaskImportDialog>[0]> = {}) {
    return render(
      <ExternalTaskImportDialog
        provider="clickup"
        detail={detail}
        open
        enabled
        connectionEpoch="connection-clickup-a:1"
        onOpenChange={jest.fn()}
        onImported={jest.fn()}
        {...overrides}
      />,
    );
  }

  it('preselects the initial project, leaves status empty, and starts the status wiring', () => {
    renderDialog({ initialProjectId: 'project-2' });

    expect(screen.getByLabelText('Project')).toHaveValue('project-2');
    expect(screen.getByLabelText('Status')).toHaveValue('');
    expect(screen.getByLabelText('Status')).toBeEnabled();
    // The preselected project reaches the import hook, which scopes the
    // project status query.
    expect(useExternalTaskImportMock).toHaveBeenCalledWith(
      'clickup',
      detail,
      'project-2',
      expect.anything(),
    );
  });

  it('preserves an empty selection when no initial project is supplied', () => {
    renderDialog();

    expect(screen.getByLabelText('Project')).toHaveValue('');
    expect(useExternalTaskImportMock).toHaveBeenLastCalledWith(
      'clickup',
      detail,
      '',
      expect.anything(),
    );
  });

  it('keeps a manual project choice when the initial project changes while open', async () => {
    const user = userEvent.setup();
    const { rerender } = renderDialog({ initialProjectId: 'project-1' });

    await user.selectOptions(screen.getByLabelText('Project'), 'project-2');

    rerender(
      <ExternalTaskImportDialog
        provider="clickup"
        detail={detail}
        open
        enabled
        connectionEpoch="connection-clickup-a:1"
        onOpenChange={jest.fn()}
        onImported={jest.fn()}
        initialProjectId="project-1"
      />,
    );

    expect(screen.getByLabelText('Project')).toHaveValue('project-2');
  });

  it('clears a stale preselection once the project list resolves without it', async () => {
    useExternalTaskImportMock.mockReturnValue({
      projects: { data: undefined },
      statuses: { data: undefined, isLoading: false },
      mutation: {
        mutate: jest.fn(),
        reset: jest.fn(),
        isPending: false,
        isError: false,
        error: null,
      },
    });
    const { rerender } = renderDialog({ initialProjectId: 'deleted-project' });

    useExternalTaskImportMock.mockReturnValue(
      controllerValue([{ id: 'project-1', name: 'Product' }]),
    );
    rerender(
      <ExternalTaskImportDialog
        provider="clickup"
        detail={detail}
        open
        enabled
        connectionEpoch="connection-clickup-a:1"
        onOpenChange={jest.fn()}
        onImported={jest.fn()}
        initialProjectId="deleted-project"
      />,
    );

    await waitFor(() => expect(screen.getByLabelText('Project')).toHaveValue(''));
    expect(useExternalTaskImportMock).toHaveBeenLastCalledWith(
      'clickup',
      detail,
      '',
      expect.anything(),
    );
  });

  it('reopens with the then-current selected project', async () => {
    const user = userEvent.setup();
    function Harness({ initialProjectId }: { initialProjectId: string | undefined }) {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Reopen
          </button>
          <ExternalTaskImportDialog
            provider="clickup"
            detail={detail}
            open={open}
            enabled
            connectionEpoch="connection-clickup-a:1"
            onOpenChange={setOpen}
            onImported={jest.fn()}
            initialProjectId={initialProjectId}
          />
        </>
      );
    }
    const { rerender } = render(<Harness initialProjectId="project-1" />);
    expect(screen.getByLabelText('Project')).toHaveValue('project-1');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Project')).not.toBeInTheDocument();

    rerender(<Harness initialProjectId="project-2" />);
    await user.click(screen.getByRole('button', { name: 'Reopen' }));

    expect(screen.getByLabelText('Project')).toHaveValue('project-2');
  });

  it('keeps the preselected form free of accessibility violations', async () => {
    const { baseElement } = renderDialog({ initialProjectId: 'project-1' });

    expect(await axe(baseElement)).toHaveNoViolations();
  });
});

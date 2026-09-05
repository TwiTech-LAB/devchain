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

function controllerValue() {
  return {
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

function renderDialog(overrides: Partial<Parameters<typeof ExternalTaskImportDialog>[0]> = {}) {
  return render(
    <ExternalTaskImportDialog
      provider="clickup"
      detail={detail}
      open
      enabled
      connectionEpoch="connection-clickup-a:1"
      projectId="project-1"
      projectName="Product"
      onOpenChange={jest.fn()}
      onImported={jest.fn()}
      {...overrides}
    />,
  );
}

describe('ExternalTaskImportDialog', () => {
  beforeEach(() => {
    useExternalTaskImportMock.mockReset();
    useExternalTaskImportMock.mockReturnValue(controllerValue());
  });

  it.each([true, false])(
    'fixes the form to the Board project and navigates when created=%s',
    async (created) => {
      const user = userEvent.setup();
      const controller = controllerValue();
      const onImported = jest.fn();
      useExternalTaskImportMock.mockReturnValue(controller);
      const { baseElement } = renderDialog({ onImported });

      expect(screen.getByText('Product')).toBeInTheDocument();
      expect(screen.queryByRole('combobox', { name: 'Project' })).not.toBeInTheDocument();
      expect(screen.getByLabelText('Title')).toHaveValue(detail.title);
      expect(screen.getByLabelText('Description')).toHaveValue(detail.description);
      expect(baseElement.querySelector('script')).toBeNull();

      await user.selectOptions(screen.getByLabelText('Status'), 'status-1');
      await user.clear(screen.getByLabelText('Title'));
      await user.type(screen.getByLabelText('Title'), 'Edited title');
      await user.click(screen.getByRole('button', { name: 'Create task' }));

      expect(controller.mutation.mutate).toHaveBeenCalledWith(
        {
          statusId: 'status-1',
          title: 'Edited title',
          description: detail.description,
        },
        expect.objectContaining({ onSuccess: expect.any(Function) }),
      );
      const mutationOptions = controller.mutation.mutate.mock.calls[0]![1];
      const epicId = created ? 'new-epic' : 'existing-epic';
      mutationOptions.onSuccess({ epic: { id: epicId, projectId: 'project-1' }, created });
      expect(onImported).toHaveBeenCalledWith(epicId);
      expect(useExternalTaskImportMock).toHaveBeenLastCalledWith(
        'clickup',
        detail,
        'project-1',
        expect.objectContaining({ projectName: 'Product' }),
      );
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
          projectId="project-1"
          projectName="Product"
          onOpenChange={setOpen}
          onImported={jest.fn()}
          returnFocusTo={() => origin}
        />
      );
    }
    render(<Harness />);

    await close(user);
    await waitFor(() => expect(origin).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
    origin.remove();
  });

  it('resets status when the owning Board project changes', async () => {
    const user = userEvent.setup();
    const { rerender } = renderDialog();
    await user.selectOptions(screen.getByLabelText('Status'), 'status-1');

    rerender(
      <ExternalTaskImportDialog
        provider="clickup"
        detail={detail}
        open
        enabled
        connectionEpoch="connection-clickup-b:2"
        projectId="project-2"
        projectName="Platform"
        onOpenChange={jest.fn()}
        onImported={jest.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByLabelText('Status')).toHaveValue(''));
    expect(screen.getByText('Platform')).toBeInTheDocument();
    expect(useExternalTaskImportMock).toHaveBeenLastCalledWith(
      'clickup',
      detail,
      'project-2',
      expect.objectContaining({ projectName: 'Platform' }),
    );
  });

  it('stays unavailable without an owning Board project', () => {
    renderDialog({ projectId: null, projectName: null });
    expect(screen.getByRole('button', { name: 'Create task' })).toBeDisabled();
    expect(useExternalTaskImportMock).toHaveBeenLastCalledWith(
      'clickup',
      detail,
      null,
      expect.anything(),
    );
  });

  it('has no accessibility violations', async () => {
    const { baseElement } = renderDialog();
    expect(await axe(baseElement)).toHaveNoViolations();
  });
});

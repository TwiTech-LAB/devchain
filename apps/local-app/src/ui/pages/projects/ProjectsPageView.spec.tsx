import { render } from '@testing-library/react';
import type {
  ProjectsDialogsModel,
  ProjectsPagePresentation,
  ProjectsTableModel,
} from './projects-page-presentation';
import { ProjectsPageView } from './ProjectsPageView';

const tableSpy = jest.fn();
const dialogsSpy = jest.fn();

jest.mock('./ProjectsTable', () => ({
  ProjectsTable: (props: unknown) => {
    tableSpy(props);
    return <div data-testid="table" />;
  },
}));

jest.mock('./ProjectsDialogs', () => ({
  ProjectsDialogs: (props: unknown) => {
    dialogsSpy(props);
    return <div data-testid="dialogs" />;
  },
}));

describe('ProjectsPageView', () => {
  it('passes only each semantic region to its direct consumer', () => {
    const table: ProjectsTableModel = {
      search: '',
      changeSearch: jest.fn(),
      sortField: 'name',
      sortOrder: 'asc',
      toggleSort: jest.fn(),
      openCreate: jest.fn(),
      openCreateInWorkspace: jest.fn(),
      requestProjectMove: jest.fn(),
      openCreateWorkspace: jest.fn(),
      notice: null,
      statusMessage: '',
      drag: {
        projectId: null,
        sourceWorkspaceId: null,
        targetWorkspaceId: null,
        start: jest.fn(),
        enterWorkspace: jest.fn(),
        leaveWorkspace: jest.fn(),
        dropOnWorkspace: jest.fn(),
        end: jest.fn(),
      },
      content: { kind: 'unavailable', failedData: ['projects'], retry: jest.fn() },
    };
    const dialogs = {} as ProjectsDialogsModel;
    const presentation = { table, dialogs } satisfies ProjectsPagePresentation;

    render(<ProjectsPageView presentation={presentation} />);

    expect(tableSpy).toHaveBeenCalledWith({ model: table });
    expect(dialogsSpy).toHaveBeenCalledWith({ model: dialogs });
  });
});

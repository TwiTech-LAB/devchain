import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Project, ProjectWorkspace } from '@/ui/pages/projects/lib/project-contracts';
import { ProjectList, type ProjectListRow } from './ProjectList';
import type { ProjectStatus } from './remote-status';

function workspace(id: string, name: string): ProjectWorkspace {
  return {
    id,
    name,
    isDefault: id === 'w1',
    position: 0,
    projectCount: 0,
    deviceGrantCount: 0,
    createdAt: '',
    updatedAt: '',
  };
}

function row(id: string, name: string, workspaceId: string, onVm: boolean): ProjectListRow {
  const project: Project = {
    id,
    workspaceId,
    name,
    description: null,
    rootPath: `/work/${id}`,
    createdAt: '',
    updatedAt: '',
  };
  const status: ProjectStatus = onVm
    ? {
        state: 'remote',
        label: 'On lab-vm',
        note: 'Files in sync',
        tone: 'ok',
        action: { kind: 'disconnect', label: 'Disconnect' },
        operation: null,
        remoteId: 'r1',
      }
    : {
        state: 'local',
        label: 'This PC',
        note: null,
        tone: 'neutral',
        action: { kind: 'connect', label: 'Connect', disabledReason: null },
        operation: null,
        remoteId: null,
      };
  return { project, status, onVm };
}

const ROWS = [
  row('p1', 'Billing', 'w1', true),
  row('p2', 'api-gateway', 'w1', false),
  row('p3', 'Blog', 'w2', false),
];
const WORKSPACES = [workspace('w1', 'Main'), workspace('w2', 'Side')];

function renderList(
  props: Partial<Parameters<typeof ProjectList>[0]> = {},
): ReturnType<typeof jest.fn> {
  const renderAction = jest.fn((item: ProjectListRow) => (
    <button type="button">{item.status.action?.label}</button>
  ));
  render(
    <ProjectList
      rows={ROWS}
      workspaces={WORKSPACES}
      loading={false}
      error={null}
      truncated={false}
      renderAction={renderAction}
      {...props}
    />,
  );
  return renderAction;
}

function visibleNames(): string[] {
  const list = screen.queryByRole('list', { name: 'Projects' });
  return list
    ? within(list)
        .getAllByRole('listitem')
        .map((item) => item.getAttribute('aria-label')!)
    : [];
}

async function choose(trigger: string, option: string) {
  await userEvent.click(screen.getByRole('combobox', { name: trigger }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

// Component unit: the filters are pure list logic inside one component; the
// page spec covers the data that feeds it.
describe('ProjectList', () => {
  it('lists every row, VM projects first, with its workspace, state and the caller’s action', () => {
    const renderAction = renderList();
    expect(visibleNames()).toEqual(['Billing', 'api-gateway', 'Blog']);
    const billing = screen.getByRole('listitem', { name: 'Billing' });
    expect(billing).toHaveTextContent('Main');
    expect(billing).toHaveTextContent('On lab-vm');
    expect(billing).toHaveTextContent('Files in sync');
    expect(within(billing).getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
    expect(renderAction).toHaveBeenCalledTimes(3);
  });

  it('lists projects on a VM first and sorts each group by name', () => {
    renderList({
      rows: [
        row('a', 'api-gateway', 'w1', false),
        row('b', 'Zeta', 'w1', true),
        row('c', 'Blog', 'w1', false),
        row('d', 'Admin', 'w1', true),
      ],
    });
    expect(visibleNames()).toEqual(['Admin', 'Zeta', 'api-gateway', 'Blog']);
  });

  it.each([
    ['On VMs', ['Billing']],
    ['This PC', ['api-gateway', 'Blog']],
  ])('filters by location: %s', async (option, names) => {
    renderList();
    await choose('Show projects', option);
    expect(visibleNames()).toEqual(names);
  });

  it('filters by workspace and hides the workspace name inside one', async () => {
    renderList();
    await choose('Workspace', 'Side');
    expect(visibleNames()).toEqual(['Blog']);
    expect(screen.getByRole('listitem', { name: 'Blog' })).not.toHaveTextContent('Side');
  });

  it('searches by name', async () => {
    renderList();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search projects' }), 'bil');
    expect(visibleNames()).toEqual(['Billing']);
  });

  it('combines the filters', async () => {
    renderList();
    await choose('Show projects', 'This PC');
    await choose('Workspace', 'Main');
    expect(visibleNames()).toEqual(['api-gateway']);
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search projects' }), 'blog');
    expect(visibleNames()).toEqual([]);
    expect(screen.getByText('No project matches these filters.')).toBeInTheDocument();
  });

  it('hides the workspace filter and names with one workspace', () => {
    renderList({ workspaces: [WORKSPACES[0]] });
    expect(screen.queryByRole('combobox', { name: 'Workspace' })).not.toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: 'Billing' })).not.toHaveTextContent('Main');
  });

  it('notes a cut list', () => {
    renderList({ truncated: true });
    expect(screen.getByText('Showing the first 1,000 projects.')).toBeInTheDocument();
  });

  it('says so without projects', () => {
    renderList({ rows: [] });
    expect(screen.getByText('No projects yet.')).toBeInTheDocument();
  });
});

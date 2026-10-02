import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { RemoteListItemDto } from '@/modules/remotes/dtos/remote.dto';
import type { RemoteProjectBindingRow } from '@/ui/lib/backend-provider';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '../ui/context-menu';
import { ProjectVmContextMenu } from './ProjectVmContextMenu';

const mockUseSelectedProject = jest.fn();
jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => mockUseSelectedProject(),
}));

let mockRemotes: RemoteListItemDto[] = [];
let mockBindings: RemoteProjectBindingRow[] = [];
let mockLoading = false;
jest.mock('@/ui/hooks/useRemotes', () => ({
  useRemotes: () => ({
    remotes: mockRemotes,
    remotesLoading: mockLoading,
    bindings: mockBindings,
    bindingsLoading: false,
    bindingByProjectId: new Map(mockBindings.map((binding) => [binding.projectId, binding])),
  }),
}));

const READY = {
  id: 'r1',
  name: 'lab-vm',
  baseUrl: 'http://10.0.0.5:4000',
  kind: 'address',
  createdAt: '',
  updatedAt: '',
  online: true,
  apiKeyRejected: false,
  version: '1.0.0',
  versionMatches: true,
  homePathMatches: true,
  lastSeenAt: null,
  lastOperation: null,
  logins: {},
} as unknown as RemoteListItemDto;

function vm(overrides: Partial<RemoteListItemDto>): RemoteListItemDto {
  return { ...READY, ...overrides } as RemoteListItemDto;
}

function openMenu() {
  render(
    <MemoryRouter>
      <ContextMenu>
        <ContextMenuTrigger>Cloud</ContextMenuTrigger>
        <ContextMenuContent>
          <ProjectVmContextMenu />
        </ContextMenuContent>
      </ContextMenu>
    </MemoryRouter>,
  );
  fireEvent.contextMenu(screen.getByText('Cloud'));
  return screen.getByRole('menu');
}

const item = (menu: HTMLElement, name: string | RegExp) =>
  within(menu).getByRole('menuitem', { name });

beforeEach(() => {
  mockUseSelectedProject.mockReturnValue({ selectedProject: { id: 'p1', name: 'Project One' } });
  mockRemotes = [READY];
  mockBindings = [];
  mockLoading = false;
});

// Component: the menu is a pure function of the selected project, VMs and
// bindings; the hooks that load them are mocked at their boundary.
describe('ProjectVmContextMenu', () => {
  it('asks for a project when none is selected', () => {
    mockUseSelectedProject.mockReturnValue({ selectedProject: undefined });
    expect(item(openMenu(), 'Select a project first')).toHaveAttribute('data-disabled');
  });

  it('shows Loading while the VMs load', () => {
    mockLoading = true;
    const loading = item(openMenu(), 'Loading…');
    expect(loading).toHaveAttribute('data-disabled');
    expect(loading.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it.each([
    ['no binding', []],
    ['a failed binding', [{ projectId: 'p1', remoteId: 'gone', state: 'failed' }]],
  ])('offers Add VM with %s and no VM', (_name, bindings) => {
    mockRemotes = [];
    mockBindings = bindings;
    expect(item(openMenu(), 'Add VM')).toHaveAttribute('href', '/cloud?section=remote-vm&tab=vms');
  });

  it('does not offer a destroyed VM, so Add VM shows', () => {
    mockRemotes = [
      vm({
        baseUrl: null,
        lastOperation: { id: 'o', kind: 'destroy_vm', state: 'done', updatedAt: '' },
      } as Partial<RemoteListItemDto>),
    ];
    expect(item(openMenu(), 'Add VM')).toBeInTheDocument();
  });

  it.each([
    ['no binding', []],
    ['a failed binding', [{ projectId: 'p1', remoteId: 'r1', state: 'failed' }]],
  ])('lists every VM under Connect to VM with %s', async (_name, bindings) => {
    mockBindings = bindings;
    mockRemotes = [
      READY,
      vm({ id: 'r2', name: 'off-vm', online: false }),
      vm({ id: 'r3', name: 'bad-key', apiKeyRejected: true }),
      vm({ id: 'r4', name: 'old-vm', versionMatches: false }),
      vm({ id: 'r5', name: 'other-home', homePathMatches: false }),
    ];
    const menu = openMenu();
    await userEvent.click(item(menu, 'Connect to VM'));

    const vms = await screen.findAllByRole('menu');
    const sub = vms[vms.length - 1];
    expect(item(sub, 'lab-vm')).toHaveAttribute(
      'href',
      '/cloud?section=remote-vm&projectAction=p1&connectVm=r1',
    );
    expect(item(sub, 'lab-vm')).not.toHaveAttribute('data-disabled');
    for (const name of [
      'off-vm · Offline',
      'bad-key · API key rejected',
      'old-vm · Update needed',
      'other-home · Home folder differs',
    ]) {
      const blocked = item(sub, name);
      expect(blocked).toHaveAttribute('data-disabled');
      expect(blocked).not.toHaveAttribute('href');
    }
  });

  it('offers Disconnect from the VM of a remote project', () => {
    mockBindings = [{ projectId: 'p1', remoteId: 'r1', state: 'remote' }];
    expect(item(openMenu(), 'Disconnect from lab-vm')).toHaveAttribute(
      'href',
      '/cloud?section=remote-vm&projectAction=p1',
    );
  });

  it('names the VM by its id when the VM is not listed', () => {
    mockRemotes = [];
    mockBindings = [{ projectId: 'p1', remoteId: 'r9', state: 'remote' }];
    expect(item(openMenu(), 'Disconnect from r9')).toBeInTheDocument();
  });

  it.each([
    ['attaching', 'Connecting to lab-vm…'],
    ['detaching', 'Disconnecting from lab-vm…'],
  ])('shows a %s project as busy and links to its activity', (state, label) => {
    mockBindings = [{ projectId: 'p1', remoteId: 'r1', state }];
    const menu = openMenu();

    const busy = item(menu, label);
    expect(busy).toHaveAttribute('data-disabled');
    expect(busy.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(item(menu, 'View activity')).toHaveAttribute(
      'href',
      '/cloud?section=remote-vm&projectAction=p1',
    );
    expect(within(menu).queryByRole('menuitem', { name: /Connect to VM/ })).toBeNull();
  });

  it('shows no spinner on items while nothing runs', () => {
    mockBindings = [{ projectId: 'p1', remoteId: 'r1', state: 'remote' }];
    const settled = item(openMenu(), 'Disconnect from lab-vm');
    expect(settled.querySelector('svg.animate-spin')).toBeNull();
  });
});

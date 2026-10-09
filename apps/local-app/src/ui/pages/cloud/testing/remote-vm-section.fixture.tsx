import { useEffect, useRef } from 'react';
import { render, screen, waitFor, within, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { useHomeSocket } from '@/ui/hooks/useHomeSocket';
import { runtimeInfoQueryKey } from '@/ui/hooks/useRuntime';
import { projectsQueryKeys } from '@/ui/pages/projects/lib/project-query-keys';
import { RemoteVmApiProvider } from '../lib/remote-vm-api-context';
import { InMemoryRemoteVmApi } from '../../../../../test/helpers/in-memory-remote-vm-api';
import { RemoteVmSection } from '../RemoteVmSection';

export {
  PROXMOX_CONNECTION,
  REMOTE,
  makeOperation,
  type TestRemote,
} from '../../../../../test/helpers/in-memory-remote-vm-api';

type MessageHandler = (envelope: unknown) => void;

const PROJECTS = [
  { id: 'p1', name: 'Project One', rootPath: '/tmp/p1' },
  { id: 'p2', name: 'Project Two', rootPath: '/tmp/p2' },
];

/** Shared render harness; each reset creates independent API and router state. */
function createFixture() {
  return Object.assign(new InMemoryRemoteVmApi(), {
    messageHandler: undefined as MessageHandler | undefined,
    socketHandlers: new Set<MessageHandler>(),
    search: '',
    pathname: '',
    navigate: undefined as unknown as NavigateFunction,
    allProjects: PROJECTS.map((project) => ({ ...project, workspaceId: 'w1' })),
    projectsTotal: null as number | null,
    workspaces: [{ id: 'w1', name: 'Main', isDefault: true }],
    projectReadCount: 0,
    projectsReadGate: null as Promise<void> | null,
  });
}

export let fx = createFixture();

function useFixtureAllProjects() {
  const fixture = fx;
  const query = useQuery({
    queryKey: projectsQueryKeys.allWorkspaces(),
    queryFn: async () => {
      fixture.projectReadCount += 1;
      await fixture.projectsReadGate;
      return {
        items: fixture.allProjects,
        total: fixture.projectsTotal ?? fixture.allProjects.length,
      };
    },
  });
  return {
    projects: query.data?.items ?? [],
    total: query.data?.total ?? 0,
    truncated: (query.data?.total ?? 0) > (query.data?.items.length ?? 0),
    loading: query.isLoading,
    error: query.error,
  };
}

function LocationProbe() {
  const location = useLocation();
  fx.search = location.search;
  fx.pathname = location.pathname;
  fx.navigate = useNavigate();
  return null;
}

/** Renders the page at `path`, e.g. `/?tab=proxmox`; `fx.search` follows the URL and `fx.navigate` changes it. */
export function renderSection(path = '/'): RenderResult {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(runtimeInfoQueryKey, { version: '0.23.4' });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={queryClient}>
        <RemoteVmApiProvider api={fx}>
          <RemoteVmSection />
          <LocationProbe />
        </RemoteVmApiProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

/** Opens a tab when another tab shows. */
async function openTab(name: string | RegExp): Promise<void> {
  const tab = screen.getByRole('tab', { name });
  if (tab.getAttribute('aria-selected') !== 'true') await userEvent.click(tab);
}

/** The VM rows live on the VMs tab. */
const openVmsTab = () => openTab(/^VMs/);

/** The row of a VM in the VMs box. */
export async function vmRow(name: string): Promise<HTMLElement> {
  await openVmsTab();
  return within(await screen.findByRole('list', { name: 'VMs' })).findByRole('listitem', {
    name,
  });
}

/** A VM's name button in the Overview tab's VM summary; waits until the summary loads. */
export async function overviewVmButton(name: string): Promise<HTMLElement> {
  return within(await screen.findByRole('list', { name: 'VMs' })).findByRole('button', { name });
}

/** The row of a project in the Projects tab's list. */
export async function projectRow(name: string): Promise<HTMLElement> {
  await openTab(/^Projects/);
  return within(await screen.findByRole('list', { name: 'Projects' })).findByRole('listitem', {
    name,
  });
}

/** Opens a project's File sync settings from its row and returns the dialog. */
export async function openFileSyncSettings(name: string): Promise<HTMLElement> {
  await userEvent.click(
    within(await projectRow(name)).getByRole('button', { name: 'File sync settings' }),
  );
  return screen.findByRole('dialog', { name: `File sync settings · ${name}` });
}

/** Opens a VM's ⋯ menu and returns its item names. */
export async function openVmMenu(name: string): Promise<string[]> {
  await openVmsTab();
  await userEvent.click(await screen.findByRole('button', { name: `More actions for ${name}` }));
  return (await screen.findAllByRole('menuitem')).map((item) => item.textContent ?? '');
}

/** Opens a VM's ⋯ menu and picks one item. */
export async function pickVmMenu(name: string, item: string): Promise<void> {
  await openVmMenu(name);
  await userEvent.click(screen.getByRole('menuitem', { name: item }));
}

/** Opens the VMs tab's Add VM menu and picks one item. */
export async function pickAddVmMenu(item: string): Promise<void> {
  await openVmsTab();
  await userEvent.click(await screen.findByRole('button', { name: 'Add VM' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: item }));
}

/** Opens the Add your own VM flow from the VMs tab's Add VM menu. */
export const addOwnVm = () => pickAddVmMenu('Add your own VM');

/** Walks an open Connect flow to its end with the choices it holds, and presses Connect. */
export async function finishConnect(dialog: HTMLElement): Promise<void> {
  await userEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
  const next = await within(dialog).findByRole('button', { name: 'Next' });
  await waitFor(() => expect(next).toBeEnabled());
  await userEvent.click(next);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
}

/** Picks a provider's login in a dialog's login step. */
export async function chooseLogin(
  dialog: HTMLElement,
  provider: string,
  option: string,
): Promise<void> {
  await userEvent.click(within(dialog).getByRole('combobox', { name: `${provider} login choice` }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

export function resetRemoteVmFixture(mocks: {
  useSelectedProject: jest.Mock;
  useAllProjects: jest.Mock;
  useWorkspaces: jest.Mock;
  toast: jest.Mock;
}): void {
  fx = createFixture();
  const fixture = fx;
  fixture.messageHandler = (envelope) => {
    for (const handler of fixture.socketHandlers) handler(envelope);
  };
  mocks.useSelectedProject
    .mockReset()
    .mockReturnValue({ projects: PROJECTS, projectsLoading: false, activateProject: jest.fn() });
  mocks.useAllProjects.mockReset().mockImplementation(useFixtureAllProjects);
  mocks.useWorkspaces
    .mockReset()
    .mockImplementation(() => ({ workspaces: fixture.workspaces, loading: false, error: null }));
  jest
    .mocked(useHomeSocket)
    .mockClear()
    .mockImplementation((handlers) => {
      const latest = useRef(handlers);
      latest.current = handlers;
      useEffect(() => {
        const deliver: MessageHandler = (envelope) =>
          (latest.current.message as MessageHandler)?.(envelope);
        fixture.socketHandlers.add(deliver);
        return () => {
          fixture.socketHandlers.delete(deliver);
        };
      }, []);
      return {} as ReturnType<typeof useHomeSocket>;
    });
  mocks.toast.mockClear();
}

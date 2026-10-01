import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DockerPlan, DockerPlanItem } from '@/modules/remotes/docker/docker-plan.dto';
import {
  DOCKER_TEMPORARY_NOTE,
  DOCKER_WRITABLE_LAYER_NOTE,
} from '@/modules/remotes/docker/docker-plan.dto';
import type { RemoteListItemDto } from '@/modules/remotes/dtos/remote.dto';
import { DEFAULT_FILE_SYNC_IGNORES } from '@/modules/file-sync/file-sync.dto';
import { apiFetch } from '@/ui/lib/api-transport';
import type { Project } from '@/ui/pages/projects/lib/project-contracts';
import { ConnectDialog, type ConnectRequest } from './ConnectDialog';
import type { ProjectListRow } from './ProjectList';
import type { ProjectState, VmStatus } from './remote-status';

jest.mock('@/ui/lib/api-transport', () => ({
  HOME_BACKEND: 'home',
  apiFetch: jest.fn(),
}));

const mockApiFetch = jest.mocked(apiFetch);

const REMOTE = {
  id: 'r1',
  name: 'lab-vm',
  baseUrl: 'http://127.0.0.1:3001',
  kind: 'address',
  createdAt: '',
  updatedAt: '',
  online: true,
  version: '1.0.0',
  versionMatches: true,
  vmProviderConnectionId: null,
} as RemoteListItemDto;

function item(overrides: Partial<DockerPlanItem> = {}): DockerPlanItem {
  return {
    id: 'web',
    kind: 'container',
    name: 'web',
    composeProject: 'acme',
    linkedReasons: ['com.docker.compose.project.working_dir'],
    defaultSelected: true,
    selectedMode: 'container-and-data',
    choices: ['container-and-data'],
    temporary: false,
    images: [{ id: 'sha256:1', architecture: 'x86_64', size: { bytes: 2048, unknown: false } }],
    mounts: [
      {
        kind: 'named-volume',
        source: 'web-data',
        destination: '/data',
        readOnly: false,
        size: { bytes: 4096, unknown: false },
      },
    ],
    writerGroup: [],
    alsoStops: [],
    blockers: [],
    warnings: [],
    notes: [DOCKER_WRITABLE_LAYER_NOTE],
    writableLayer: { bytes: 512, unknown: false },
    targetAction: 'create',
    ...overrides,
  };
}

function plan(overrides: Partial<DockerPlan> = {}): DockerPlan {
  return {
    projectId: 'p1',
    remoteId: 'r1',
    scannedAt: '2026-09-27T10:00:00.000Z',
    availability: { available: true, side: null, reason: null },
    apiVersion: '1.47',
    items: [item()],
    filesystems: [
      {
        filesystemId: 'fs1',
        paths: ['/var/lib/docker'],
        requiredBytes: 4096,
        headroomBytes: 0,
        freeBytes: 1_048_576,
        unknown: false,
        status: 'fits',
      },
    ],
    fit: 'fits',
    canConnect: true,
    warnings: [],
    managedExclusions: [],
    reconnect: null,
    estimate: {
      minSeconds: 120,
      maxSeconds: 480,
      probeBytes: 16_777_216,
      loadTailKnown: false,
      approximate: true,
    },
    ...overrides,
  };
}

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function vmStatus(state: VmStatus['state'], label: string): VmStatus {
  return { state, label, note: null, tone: 'ok', action: null, operation: null, chips: [] };
}

function projectRow(
  id: string,
  name: string,
  workspaceId: string,
  state: ProjectState = 'local',
): ProjectListRow {
  const project: Project = {
    id,
    workspaceId,
    name,
    description: null,
    rootPath: `/work/${id}`,
    createdAt: '',
    updatedAt: '',
  };
  return {
    project,
    status: {
      state,
      label: state === 'remote' ? 'On lab-vm' : 'This PC',
      note: null,
      tone: 'neutral',
      action: null,
      operation: null,
      remoteId: null,
    },
    onVm: state === 'remote',
  };
}

const PROJECTS = {
  rows: [projectRow('p1', 'Project One', 'w1')],
  workspaces: [],
  loading: false,
  error: null,
  truncated: false,
};

function renderFlow(props: Partial<Parameters<typeof ConnectDialog>[0]> = {}) {
  const handlers = { onClose: jest.fn(), onUpdateVm: jest.fn(), onConnect: jest.fn() };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ConnectDialog
        initialProjectId="p1"
        remotes={[REMOTE]}
        statuses={new Map([['r1', vmStatus('ready', 'Ready')]])}
        projects={PROJECTS}
        pending={false}
        error={null}
        {...handlers}
        {...props}
      />
    </QueryClientProvider>,
  );
  return handlers;
}

/** The project's ignore list on the server, and the saves the flow sent. */
let ignores: string[];
let ignoreSaves: Array<string[] | null>;
let ignoreSaveError: string | null;

/** Answers the ignore-list routes; every other call goes to `plans`. */
function route(plans: (url: string, init?: RequestInit) => Promise<Response>) {
  mockApiFetch.mockImplementation(async (url, init) => {
    if (String(url).endsWith('/ignores')) {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { ignores: string[] | null };
        ignoreSaves.push(body.ignores);
        if (ignoreSaveError) return response({ message: ignoreSaveError }, 400);
      }
      return response({ ignores });
    }
    return plans(String(url), init);
  });
}

const next = () => userEvent.click(screen.getByRole('button', { name: 'Next' }));

/** Opens the Files step of a flow that starts from Project One. */
async function renderDialog(onConnect = jest.fn()) {
  renderFlow({
    onConnect: (request: ConnectRequest) => onConnect(request.remoteId, request.docker),
  });
  await next();
}

/** Review, then Connect. */
async function connect() {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
  await next();
  await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
}

function row(name: string): HTMLElement {
  return screen.getByText(name).closest('li')!;
}

/** Each plan call resolves only when its deferred is; index 0 is the initial load. */
function deferredPlans() {
  const deferreds: Array<(body: unknown) => void> = [];
  route(
    () =>
      new Promise<Response>((resolve) => {
        deferreds.push((body) => resolve(response(body)));
      }),
  );
  return deferreds;
}

beforeEach(() => {
  ignores = [...DEFAULT_FILE_SYNC_IGNORES];
  ignoreSaves = [];
  ignoreSaveError = null;
  mockApiFetch.mockReset();
  route(async () => response(plan()));
});

describe('ConnectDialog Docker section', () => {
  it('lists only linked containers with their defaults and data classes', async () => {
    route(async () =>
      response(
        plan({
          items: [
            item(),
            item({
              id: 'db-old',
              name: 'db-old',
              linkedReasons: [],
              composeProject: null,
              defaultSelected: false,
              selectedMode: null,
            }),
          ],
        }),
      ),
    );
    await renderDialog();

    await screen.findByText('Linked to this project');
    const linked = within(screen.getByText('Linked to this project').parentElement!);
    expect(within(linked.getByText('web').closest('li')!).getByRole('checkbox')).toBeChecked();
    expect(
      screen.getByText('Containers that are not linked to this project stay on this PC.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('db-old')).not.toBeInTheDocument();
    expect(screen.queryByText('Other containers on this PC')).not.toBeInTheDocument();
    expect(screen.getByText(/Linked by Compose label/)).toBeInTheDocument();
    const webRow = screen.getByText('web').closest('li')!;
    expect(within(webRow).getByText(/named volume web-data → \/data, 4\.0 KB/)).toBeInTheDocument();
    expect(within(webRow).getByText(/image sha256:1 \(x86_64\), 2\.0 KB/)).toBeInTheDocument();
  });

  it('shows every note and warning it is given, each once', async () => {
    route(async () =>
      response(
        plan({
          items: [
            item({
              id: 'rm1',
              name: 'rm1',
              temporary: true,
              defaultSelected: false,
              selectedMode: null,
              notes: [
                DOCKER_TEMPORARY_NOTE,
                DOCKER_WRITABLE_LAYER_NOTE,
                'compose up recreates their containers on the VM',
                'the agent builds them on the VM',
              ],
              warnings: [{ code: 'home-uid', message: 'The VM runs as a different uid.' }],
            }),
          ],
          warnings: [{ code: 'unreadable-unselected-folder', message: '/state/db is unreadable.' }],
        }),
      ),
    );
    await renderDialog();

    await screen.findByText('compose up recreates their containers on the VM');
    const rmRow = row('rm1');
    expect(within(rmRow).getAllByText(DOCKER_TEMPORARY_NOTE)).toHaveLength(1);
    expect(within(rmRow).getAllByText(DOCKER_WRITABLE_LAYER_NOTE)).toHaveLength(1);
    expect(within(rmRow).getByText('the agent builds them on the VM')).toBeInTheDocument();
    expect(within(rmRow).getByText('The VM runs as a different uid.')).toBeInTheDocument();
    expect(screen.getByText('/state/db is unreadable.')).toBeInTheDocument();
  });

  it('submits the selected items with their modes', async () => {
    const onConnect = jest.fn();
    route(async () =>
      response(
        plan({
          items: [
            item(),
            item({
              id: 'legacy',
              name: 'legacy',
              defaultSelected: false,
              selectedMode: null,
              choices: ['container-and-data', 'without-data'],
            }),
            item({
              id: 'gpu',
              name: 'gpu',
              defaultSelected: false,
              selectedMode: null,
              choices: ['data-only'],
            }),
            item({
              id: 'store',
              name: 'store',
              defaultSelected: false,
              selectedMode: null,
              choices: ['without-data'],
            }),
          ],
        }),
      ),
    );
    await renderDialog(onConnect);

    await screen.findByText('Docker containers');
    await userEvent.click(screen.getByRole('checkbox', { name: 'web' }));
    await userEvent.click(screen.getByRole('checkbox', { name: /legacy/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'gpu' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'store' }));
    expect(screen.getByText('Mode: Copy its data only')).toBeInTheDocument();
    expect(screen.getByText('Mode: Copy without its data')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('combobox', { name: 'Mode for legacy' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Copy without its data' }));

    await connect();

    expect(onConnect).toHaveBeenCalledWith('r1', {
      items: [
        { id: 'legacy', mode: 'without-data' },
        { id: 'gpu', mode: 'data-only' },
        { id: 'store', mode: 'without-data' },
      ],
    });
  });

  it('disables Connect while a re-plan is pending and re-enables on its answer', async () => {
    const deferreds = deferredPlans();
    const onConnect = jest.fn();
    const legacy = item({
      id: 'legacy',
      name: 'legacy',
      defaultSelected: false,
      selectedMode: null,
    });
    const two = plan({ items: [item(), legacy] });
    await renderDialog(onConnect);

    await act(async () => deferreds[0](two));
    await screen.findByText('Docker containers');
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();

    await userEvent.click(screen.getByRole('checkbox', { name: 'legacy' }));
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();

    await act(async () => deferreds[1](two));
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it('ignores a late answer to an older plan request', async () => {
    const deferreds = deferredPlans();
    const onConnect = jest.fn();
    const legacy = item({
      id: 'legacy',
      name: 'legacy',
      defaultSelected: false,
      selectedMode: null,
    });
    const two = plan({ items: [item(), legacy] });
    await renderDialog(onConnect);

    await act(async () => deferreds[0](two));
    await screen.findByText('Docker containers');

    // Check and uncheck legacy: request 2 (both selected) then request 3
    // (only web). The newest answer applies; the older one must not.
    await userEvent.click(screen.getByRole('checkbox', { name: 'legacy' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'legacy' }));
    await act(async () => deferreds[2](two));
    await act(async () => deferreds[1]({ ...two, canConnect: false, fit: 'refused' }));

    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it('cannot check an item without choices and shows its reasons', async () => {
    route(async () =>
      response(
        plan({
          items: [
            item({
              id: 'odd',
              name: 'odd',
              defaultSelected: true,
              selectedMode: null,
              choices: [],
              blockers: [{ code: 'architecture-mismatch', message: 'The image is arm64.' }],
            }),
          ],
        }),
      ),
    );
    const onConnect = jest.fn();
    await renderDialog(onConnect);

    const checkbox = await screen.findByRole('checkbox', { name: 'odd' });
    expect(checkbox).toBeDisabled();
    expect(checkbox).not.toBeChecked();
    expect(screen.getByText('The image is arm64.')).toBeInTheDocument();

    await connect();
    expect(onConnect).toHaveBeenCalledWith('r1', undefined);
  });

  it('disables Connect and shows the server numbers on a fit refusal', async () => {
    route(async () =>
      response(
        plan({
          canConnect: false,
          fit: 'refused',
          filesystems: [
            {
              filesystemId: 'fs1',
              paths: ['/var/lib/docker'],
              requiredBytes: 900,
              headroomBytes: 100,
              freeBytes: 500,
              unknown: false,
              status: 'refused',
            },
          ],
        }),
      ),
    );
    await renderDialog();

    expect(
      await screen.findByText('Needs 900 B on /var/lib/docker, but only 500 B is free.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Resolve the Docker space or blockers above, or clear the Docker selections/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('warns above 80% with the server numbers, without disabling Connect', async () => {
    route(async () =>
      response(
        plan({
          fit: 'warning',
          filesystems: [
            {
              filesystemId: 'fs1',
              paths: ['/var/lib/docker'],
              requiredBytes: 900,
              headroomBytes: 100,
              freeBytes: 1000,
              unknown: false,
              status: 'warning',
            },
          ],
        }),
      ),
    );
    await renderDialog();

    expect(
      await screen.findByText('Uses more than 80% of /var/lib/docker: needs 900 B of 1000 B free.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it('shows the estimate range and the unknown-space filesystem', async () => {
    route(async () =>
      response(
        plan({
          filesystems: [
            {
              filesystemId: null,
              paths: ['/home/vm/state'],
              requiredBytes: 4096,
              headroomBytes: 0,
              freeBytes: null,
              unknown: true,
              status: 'unknown',
            },
          ],
        }),
      ),
    );
    await renderDialog();

    expect(await screen.findByText(/Estimated copy time: 2 min–8 min/)).toBeInTheDocument();
    expect(
      screen.getByText('Free space is unknown on /home/vm/state; the need is at least 4.0 KB.'),
    ).toBeInTheDocument();
  });

  it('lists the containers the server says the Connect also stops', async () => {
    route(async () =>
      response(
        plan({
          items: [
            item({ writerGroup: ['web', 'db-old'], alsoStops: ['db-old'] }),
            item({
              id: 'db-old',
              name: 'db-old',
              linkedReasons: [],
              defaultSelected: false,
              selectedMode: null,
            }),
          ],
        }),
      ),
    );
    await renderDialog();

    expect(await screen.findByText('Connect also stops: db-old.')).toBeInTheDocument();
  });

  it('lists no extra stops when the server reports none for a writer group', async () => {
    route(async () =>
      response(
        plan({
          items: [
            item({ writerGroup: ['web', 'db-old'], alsoStops: [] }),
            item({
              id: 'db-old',
              name: 'db-old',
              linkedReasons: [],
              defaultSelected: false,
              selectedMode: null,
            }),
          ],
        }),
      ),
    );
    await renderDialog();

    expect(await screen.findByText('web')).toBeInTheDocument();
    expect(screen.queryByText(/Connect also stops/)).not.toBeInTheDocument();
  });

  it('discloses what a reconnect replaces and the loss it causes', async () => {
    route(async () =>
      response(
        plan({
          reconnect: {
            importedAt: '2026-09-20T08:00:00.000Z',
            replacing: ['web'],
            lossNotice: 'VM changes that were never copied back will be lost.',
          },
        }),
      ),
    );
    await renderDialog();

    const note = await screen.findByRole('note', { name: 'Reconnect replacement' });
    expect(within(note).getByText(/Replaces the VM's copy from/)).toBeInTheDocument();
    expect(within(note).getByText('web')).toBeInTheDocument();
    expect(
      within(note).getByText('VM changes that were never copied back will be lost.'),
    ).toBeInTheDocument();
  });

  it.each([
    [
      'rootless',
      { code: 'rootless', message: 'The local Docker engine is rootless and unsupported.' },
      null as 'home' | 'remote' | null,
    ],
    [
      'a tcp host',
      { code: 'remote-docker-host', message: 'DOCKER_HOST uses tcp://, which is not supported.' },
      'home' as 'home' | 'remote' | null,
    ],
  ])('shows the availability reason for %s', async (_label, reason, side) => {
    route(async () =>
      response(plan({ availability: { available: false, side, reason }, items: [] })),
    );
    await renderDialog();

    expect(await screen.findByText(reason.message)).toBeInTheDocument();
  });

  it('hints at Install Docker when the VM has none', async () => {
    route(async () =>
      response(
        plan({
          availability: {
            available: false,
            side: 'remote',
            reason: { code: 'remote-no-docker', message: 'The VM has no Docker.' },
          },
          items: [],
          canConnect: false,
        }),
      ),
    );
    const onConnect = jest.fn();
    await renderDialog(onConnect);

    expect(
      await screen.findByText(
        'The VM needs Docker; use Update VM with Install Docker before connecting with containers.',
      ),
    ).toBeInTheDocument();

    await connect();

    expect(onConnect).toHaveBeenCalledWith('r1', undefined);
  });

  it('keeps Connect working without Docker items when the plan cannot be read', async () => {
    route(async () => response({ message: 'route missing' }, 500));
    const onConnect = jest.fn();
    await renderDialog(onConnect);

    expect(
      await screen.findByText(/Docker import is unavailable: route missing/),
    ).toBeInTheDocument();
    await connect();

    expect(onConnect).toHaveBeenCalledWith('r1', undefined);
  });

  it('renders without React key warnings', async () => {
    const errors: string[] = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((value) => {
      errors.push(String(value));
    });
    route(async () =>
      response(
        plan({
          items: [
            item({
              id: 'dupe',
              name: 'dupe',
              blockers: [
                { code: 'same', message: 'One.' },
                { code: 'same', message: 'Two.' },
              ],
              images: [
                { id: 'sha256:same', architecture: 'x86_64', size: { bytes: 1, unknown: false } },
                { id: 'sha256:same', architecture: 'x86_64', size: { bytes: 1, unknown: false } },
              ],
            }),
          ],
          warnings: [
            { code: 'dup', message: 'A.' },
            { code: 'dup', message: 'B.' },
          ],
          filesystems: [
            {
              filesystemId: null,
              paths: ['/a'],
              requiredBytes: 1,
              headroomBytes: 0,
              freeBytes: null,
              unknown: true,
              status: 'unknown',
            },
            {
              filesystemId: null,
              paths: ['/b'],
              requiredBytes: 1,
              headroomBytes: 0,
              freeBytes: null,
              unknown: true,
              status: 'unknown',
            },
          ],
        }),
      ),
    );
    try {
      await renderDialog();
      await screen.findByText('Two.');
    } finally {
      spy.mockRestore();
    }
    expect(errors.filter((line) => line.includes('unique "key" prop'))).toEqual([]);
  });
});

// Component tests exercise the real section and dialog gate with only HTTP mocked.
it.each(['both-changed', 'unknown'] as const)(
  'requires one consistent group choice for %s data before Connect',
  async (dataState) => {
    const onConnect = jest.fn();
    route(async (_url, init) => {
      const input = JSON.parse(String(init?.body));
      const choice = input.items?.[0]?.dataChoice;
      return response(
        plan({
          canConnect: Boolean(choice),
          items: ['web', 'reader'].map((id) =>
            item({
              id,
              name: id,
              dataState,
              dataGroup: ['web', 'reader'],
              dataChoiceRequired: true,
              dataChoice: choice,
              blockers: choice
                ? []
                : [{ code: 'data-choice-required', message: 'Choose which copy to keep.' }],
            }),
          ),
        }),
      );
    });
    await renderDialog(onConnect);
    const select = await screen.findByRole('combobox', { name: 'Shared data choice for web' });
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await userEvent.click(select);
    await userEvent.click(await screen.findByRole('option', { name: 'Keep VM copy' }));
    expect(
      screen.getByRole('combobox', { name: 'Shared data choice for reader' }),
    ).toHaveTextContent('Keep VM copy');
    const planCalls = () =>
      mockApiFetch.mock.calls.filter(([url]) => String(url).endsWith('/plan'));
    expect(JSON.parse(String(planCalls().at(-1)?.[1]?.body)).items).toEqual([
      { id: 'web', mode: 'container-and-data', dataChoice: 'keep-vm' },
      { id: 'reader', mode: 'container-and-data', dataChoice: 'keep-vm' },
    ]);
    await userEvent.click(screen.getByRole('combobox', { name: 'Shared data choice for reader' }));
    await userEvent.click(
      await screen.findByRole('option', { name: "Replace with this PC's data" }),
    );
    expect(screen.getByRole('combobox', { name: 'Shared data choice for web' })).toHaveTextContent(
      "Replace with this PC's data",
    );
    await connect();
    expect(onConnect).toHaveBeenCalledWith('r1', {
      items: [
        { id: 'web', mode: 'container-and-data', dataChoice: 'replace-home' },
        { id: 'reader', mode: 'container-and-data', dataChoice: 'replace-home' },
      ],
    });
  },
);

describe('ConnectDialog Project and VM', () => {
  const vms = () => screen.getByRole('group', { name: 'VM' });

  /** Accepts the only ready VM, walks to Review, then changes the VMs' health. */
  async function reviewThenHealth(first: VmStatus['state'], second: VmStatus['state']) {
    const onConnect = jest.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const remotes = [REMOTE, { ...REMOTE, id: 'r2', name: 'other-vm' }];
    const tree = (statuses: Map<string, VmStatus>) => (
      <QueryClientProvider client={client}>
        <ConnectDialog
          initialProjectId="p1"
          remotes={remotes}
          statuses={statuses}
          projects={PROJECTS}
          pending={false}
          error={null}
          onClose={jest.fn()}
          onUpdateVm={jest.fn()}
          onConnect={onConnect}
        />
      </QueryClientProvider>
    );
    const view = render(
      tree(
        new Map([
          ['r1', vmStatus('ready', 'Ready')],
          ['r2', vmStatus('offline', 'Offline')],
        ]),
      ),
    );
    await next();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    await next();
    view.rerender(
      tree(
        new Map([
          ['r1', vmStatus(first, first)],
          ['r2', vmStatus(second, second)],
        ]),
      ),
    );
    return onConnect;
  }

  it('keeps the accepted VM when another one becomes ready', async () => {
    const onConnect = await reviewThenHealth('ready', 'ready');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(onConnect).toHaveBeenCalledWith(expect.objectContaining({ remoteId: 'r1' }));
  });

  it('never moves the project to another VM when the accepted one goes offline', async () => {
    const onConnect = await reviewThenHealth('offline', 'ready');
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
    expect(
      screen.getByText('lab-vm can no longer take the project (Offline). Go back and choose a VM.'),
    ).toBeInTheDocument();
    expect(onConnect).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await userEvent.click(within(vms()).getByRole('button', { name: /other-vm/ }));
    await next();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    await next();
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(onConnect).toHaveBeenCalledWith(expect.objectContaining({ remoteId: 'r2' }));
  });

  it('offers only a ready VM, preselected, and names why the others are not', async () => {
    const remotes = [
      REMOTE,
      { ...REMOTE, id: 'r2', name: 'off-vm' },
      { ...REMOTE, id: 'r3', name: 'old-vm' },
      { ...REMOTE, id: 'r4', name: 'other-home' },
      { ...REMOTE, id: 'r5', name: 'new-vm' },
    ];
    const { onUpdateVm } = renderFlow({
      remotes,
      statuses: new Map([
        ['r1', vmStatus('ready', 'Ready')],
        ['r2', vmStatus('offline', 'Offline since yesterday')],
        ['r3', vmStatus('update-needed', 'Update needed')],
        ['r4', vmStatus('home-mismatch', 'Home folder differs')],
        ['r5', vmStatus('busy', 'Setting up')],
      ]),
    });

    expect(screen.getByText('Project One')).toBeInTheDocument();
    expect(within(vms()).getByRole('button', { name: 'lab-vm' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    for (const name of [
      'off-vm · Offline',
      'old-vm · Update needed',
      'other-home · Home folder differs',
      'new-vm · Setting up',
    ]) {
      expect(within(vms()).getByRole('button', { name })).toBeDisabled();
    }
    await userEvent.click(within(vms()).getByRole('button', { name: 'Update old-vm' }));
    expect(onUpdateVm).toHaveBeenCalledWith('r3');
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it('waits for a VM when none is ready', () => {
    renderFlow({ statuses: new Map([['r1', vmStatus('offline', 'Never reached')]]) });

    expect(within(vms()).getByRole('button', { name: 'lab-vm · Offline' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('never swaps an explicit VM that is not ready for the only ready one', async () => {
    const { onUpdateVm } = renderFlow({
      initialRemoteId: 'r2',
      remotes: [REMOTE, { ...REMOTE, id: 'r2', name: 'old-vm' }],
      statuses: new Map([
        ['r1', vmStatus('ready', 'Ready')],
        ['r2', vmStatus('update-needed', 'Update needed')],
      ]),
    });

    expect(within(vms()).getByRole('button', { name: 'lab-vm' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(within(vms()).getByRole('button', { name: 'old-vm · Update needed' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await userEvent.click(within(vms()).getByRole('button', { name: 'Update old-vm' }));
    expect(onUpdateVm).toHaveBeenCalledWith('r2');
  });

  it('picks the project from every workspace when it starts from a VM', async () => {
    const { onConnect } = renderFlow({
      initialProjectId: undefined,
      initialRemoteId: 'r1',
      remotes: [REMOTE, { ...REMOTE, id: 'r2', name: 'second-vm' }],
      statuses: new Map([
        ['r1', vmStatus('ready', 'Ready')],
        ['r2', vmStatus('ready', 'Ready')],
      ]),
      projects: {
        rows: [
          projectRow('p1', 'Alpha', 'w1'),
          projectRow('p2', 'Bound', 'w1', 'remote'),
          projectRow('p3', 'Gamma', 'w2', 'cleanup-failed'),
          projectRow('p4', 'Delta', 'w2'),
        ],
        workspaces: [
          {
            id: 'w1',
            name: 'Main',
            isDefault: true,
            projectCount: 2,
            createdAt: '',
            updatedAt: '',
          },
          {
            id: 'w2',
            name: 'Side',
            isDefault: false,
            projectCount: 2,
            createdAt: '',
            updatedAt: '',
          },
        ] as never,
        loading: false,
        error: null,
        truncated: false,
      },
    });

    expect(screen.getByRole('dialog', { name: 'Connect a project to lab-vm' })).toBeInTheDocument();
    // The picker starts in its search field, not on the first filter.
    expect(screen.getByRole('searchbox', { name: 'Search projects' })).toHaveFocus();
    // The VM the flow opened from is preselected, even with two ready VMs.
    expect(within(vms()).getByRole('button', { name: 'lab-vm' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const picker = screen.getByRole('list', { name: 'Projects' });
    expect(
      within(picker)
        .getAllByRole('listitem')
        .map((item) => item.getAttribute('aria-label')),
    ).toEqual(['Alpha', 'Delta', 'Gamma']);
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();

    await userEvent.click(within(picker).getByRole('button', { name: 'Choose Alpha' }));
    await userEvent.click(within(picker).getByRole('button', { name: 'Choose Delta' }));
    expect(within(picker).getByRole('button', { name: 'Choose Delta' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await next();
    await connect();

    expect(onConnect).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p4', remoteId: 'r1' }),
    );
  });
});

describe('ConnectDialog Files', () => {
  const chips = () =>
    within(screen.getByRole('list', { name: 'Ignore patterns' }))
      .getAllByRole('listitem')
      .map((item) => item.textContent);

  it('edits the list locally, keeps the edits across Back, and saves them before the attach', async () => {
    const order: string[] = [];
    renderFlow({ onConnect: () => order.push('attach') });
    route(async () => response(plan()));
    const put = mockApiFetch.getMockImplementation()!;
    mockApiFetch.mockImplementation(async (url, init, options) => {
      if (init?.method === 'PUT') order.push('save');
      return put(url, init, options);
    });
    await next();

    await screen.findByRole('list', { name: 'Ignore patterns' });
    expect(chips()).toEqual([...DEFAULT_FILE_SYNC_IGNORES]);
    await userEvent.type(screen.getByLabelText('Add a pattern'), '*.log{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Remove (?d)dist' }));
    expect(chips()).toContain('*.log');
    expect(chips()).not.toContain('(?d)dist');

    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await next();
    expect(chips()).toContain('*.log');
    expect(ignoreSaves).toEqual([]);

    await connect();
    const review = screen.getByRole('region', { name: 'File list changes' });
    expect(review).toHaveTextContent('+ *.log');
    expect(review).toHaveTextContent('− (?d)dist');
    expect(ignoreSaves).toEqual([
      [...DEFAULT_FILE_SYNC_IGNORES.filter((pattern) => pattern !== '(?d)dist'), '*.log'],
    ]);
    expect(order).toEqual(['save', 'attach']);
  });

  it('restores the defaults locally and saves null', async () => {
    ignores = ['secrets/'];
    const { onConnect } = renderFlow();
    await next();

    await screen.findByRole('list', { name: 'Ignore patterns' });
    expect(chips()).toEqual(['secrets/']);
    await userEvent.click(screen.getByRole('button', { name: 'Restore defaults' }));
    expect(chips()).toEqual([...DEFAULT_FILE_SYNC_IGNORES]);
    expect(ignoreSaves).toEqual([]);

    await connect();
    expect(screen.getByRole('region', { name: 'File list changes' })).toHaveTextContent(
      'Connect restores the default list.',
    );
    expect(ignoreSaves).toEqual([null]);
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it('stops the Connect when the list cannot be saved and says why on Review', async () => {
    ignoreSaveError = 'A pattern is too long.';
    const { onConnect } = renderFlow();
    await next();

    await userEvent.type(await screen.findByLabelText('Add a pattern'), 'tmp{Enter}');
    await connect();

    expect(await screen.findByRole('alert')).toHaveTextContent('A pattern is too long.');
    expect(onConnect).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled();
  });

  it('saves nothing without an edit', async () => {
    const first = renderFlow();
    await next();
    await screen.findByRole('list', { name: 'Ignore patterns' });
    await connect();
    expect(first.onConnect).toHaveBeenCalledTimes(1);
    expect(ignoreSaves).toEqual([]);
  });

  it('leaves the list unchanged on Cancel', async () => {
    const { onClose } = renderFlow();
    await next();
    await userEvent.type(await screen.findByLabelText('Add a pattern'), 'tmp{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalled();
    expect(ignoreSaves).toEqual([]);
  });

  it('refuses a pattern that is already in the list', async () => {
    renderFlow();
    await next();
    await userEvent.type(await screen.findByLabelText('Add a pattern'), '(?d)dist{Enter}');

    expect(screen.getByRole('alert')).toHaveTextContent('(?d)dist is already in the list.');
    expect(chips().filter((pattern) => pattern === '(?d)dist')).toHaveLength(1);
  });

  it('edits the saved list when Connect opens again with the same cache', async () => {
    const saved = () => ignoreSaves.at(-1) ?? ignores;
    mockApiFetch.mockImplementation(async (url, init) => {
      if (init?.method === 'PUT')
        ignoreSaves.push((JSON.parse(String(init.body)) as { ignores: string[] }).ignores);
      if (String(url).endsWith('/ignores')) return response({ ignores: saved() });
      return response(plan());
    });
    ignores = ['node_modules'];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onConnect = jest.fn();
    const tree = (open: boolean) => (
      <QueryClientProvider client={client}>
        {open && (
          <ConnectDialog
            initialProjectId="p1"
            remotes={[REMOTE]}
            statuses={new Map([['r1', vmStatus('ready', 'Ready')]])}
            projects={PROJECTS}
            pending={false}
            error={null}
            onClose={jest.fn()}
            onUpdateVm={jest.fn()}
            onConnect={onConnect}
          />
        )}
      </QueryClientProvider>
    );
    const view = render(tree(true));
    await next();
    await userEvent.type(await screen.findByLabelText('Add a pattern'), '.env{Enter}');
    await connect();
    await waitFor(() => expect(onConnect).toHaveBeenCalledTimes(1));

    view.rerender(tree(false));
    view.rerender(tree(true));
    await next();
    await screen.findByText('.env');
    await userEvent.type(await screen.findByLabelText('Add a pattern'), '*.log{Enter}');
    await connect();
    await waitFor(() => expect(onConnect).toHaveBeenCalledTimes(2));
    expect(ignoreSaves).toEqual([
      ['node_modules', '.env'],
      ['node_modules', '.env', '*.log'],
    ]);
  });

  it('saves an order change and says so on Review', async () => {
    ignores = ['!keep.log', '*.log'];
    renderFlow();
    await next();
    await screen.findByRole('list', { name: 'Ignore patterns' });
    await userEvent.click(screen.getByRole('button', { name: 'Remove !keep.log' }));
    await userEvent.type(screen.getByLabelText('Add a pattern'), '!keep.log{Enter}');
    expect(chips()).toEqual(['*.log', '!keep.log']);

    await connect();
    expect(screen.getByRole('region', { name: 'File list changes' })).toHaveTextContent(
      'The order of the patterns changes. Syncthing applies the first one that matches.',
    );
    expect(ignoreSaves).toEqual([['*.log', '!keep.log']]);
  });

  it('shows the secrets note', async () => {
    renderFlow();
    await next();
    expect(
      await screen.findByText(
        '.env files and other secrets sync unless you add a rule. Git history comes from the VM to this PC only.',
      ),
    ).toBeInTheDocument();
  });
});

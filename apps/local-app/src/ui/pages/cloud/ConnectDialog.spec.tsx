import { useCallback, useState } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import type {
  DockerPlan,
  DockerPlanItem,
  DockerSelectionItem,
} from '@/modules/remotes/docker/docker-plan.dto';
import {
  DOCKER_TEMPORARY_NOTE,
  DOCKER_WRITABLE_LAYER_NOTE,
} from '@/modules/remotes/docker/docker-plan.dto';
import type { ConnectChoicesDto } from '@/modules/remotes/connect-choices.dto';
import type { RemoteListItemDto } from '@/modules/remotes/dtos/remote.dto';
import type { ExclusionSuggestion } from '@/modules/file-sync/sync-path-inspection.dto';
import { DEFAULT_FILE_SYNC_IGNORES } from '@/modules/file-sync/file-sync.dto';
import { HOME_BACKEND, apiFetch } from '@/ui/lib/api-transport';
import type { Project } from '@/ui/pages/projects/lib/project-contracts';
import { ConnectDialog, type ConnectRequest } from './ConnectDialog';
import { ConnectOwnerProblems } from './ConnectOwnerProblems';
import { IgnoreListEditor } from './IgnoreListEditor';
import type { ProjectListRow } from './ProjectList';
import type { ProjectState, VmStatus } from './remote-status';
import { exclusion as suggestion } from './testing/file-sync-failures.fixture';

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
    dataSize: { bytes: 4096, unknown: false },
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
    copySize: { bytes: 6144, unknown: false },
    fit: 'fits',
    canConnect: true,
    warnings: [],
    managedExclusions: [],
    codePaths: [],
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

type FlowProps = Partial<Parameters<typeof ConnectDialog>[0]>;

/** The handlers, and `rerender` with changed props on the same query client. */
function renderFlow(
  props: FlowProps = {},
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  const handlers = { onClose: jest.fn(), onUpdateVm: jest.fn(), onConnect: jest.fn() };
  const tree = (current: FlowProps) => (
    <QueryClientProvider client={client}>
      <ConnectDialog
        initialProjectId="p1"
        remotes={[REMOTE]}
        statuses={new Map([['r1', vmStatus('ready', 'Ready')]])}
        projects={PROJECTS}
        pending={false}
        error={null}
        {...handlers}
        {...current}
      />
    </QueryClientProvider>
  );
  const view = render(tree(props));
  return {
    ...handlers,
    rerender: (changed: FlowProps) => view.rerender(tree({ ...props, ...changed })),
  };
}

/** The project's ignore list on the server, and the saves the flow sent. */
let ignores: string[];
let ignoreSaves: Array<string[] | null>;
let ignoreSaveError: string | null;
let connectChoices: Record<
  string,
  Omit<ConnectChoicesDto, 'git'> & Partial<Pick<ConnectChoicesDto, 'git'>>
>;
let suggestions: {
  groups: ExclusionSuggestion[];
  overLimit: boolean;
  vm?: 'unavailable';
  home?: { rootPath: string };
};
let suggestionFailure: boolean;

/** Answers the ignore-list routes; every other call goes to `plans`. */
function route(
  plans: (url: string, init?: RequestInit) => Promise<Response>,
  presence: () => Promise<Response> = async () => response({ state: 'present' }),
) {
  mockApiFetch.mockImplementation(async (url, init) => {
    if (String(url).endsWith('/docker/presence')) return presence();
    if (String(url).endsWith('/suggestions')) {
      if (suggestionFailure) throw new Error('PC scan failed');
      return response(suggestions);
    }
    if (String(url).endsWith('/connect-choices')) {
      const projectId = String(url).split('/')[3];
      return response(connectChoices[projectId] ?? { includeDocker: false });
    }
    if (String(url).endsWith('/ignores')) {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { ignores: string[] | null };
        ignoreSaves.push(body.ignores);
        if (ignoreSaveError) return response({ message: ignoreSaveError }, 400);
      }
      return response({ ignores, revision: 0 });
    }
    return plans(String(url), init);
  });
}

const next = async () => {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
};
const includeDocker = () =>
  userEvent.click(screen.getByRole('checkbox', { name: 'Include Docker containers' }));
const planCalls = () => mockApiFetch.mock.calls.filter(([url]) => String(url).endsWith('/plan'));
const lastPlanItems = () => JSON.parse(String(planCalls().at(-1)?.[1]?.body)).items;

/** Opens the Files step of a flow that starts from Project One, opted into Docker. */
async function renderDialog(onConnect = jest.fn()) {
  renderFlow({
    onConnect: (request: ConnectRequest) => onConnect(request.remoteId, request.docker),
  });
  await next();
  await includeDocker();
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

/** Holds the project's ignore-list read or save until the test answers it. */
function holdIgnores(call: 'read' | 'save') {
  let answer!: (value: Response) => void;
  const passThrough = mockApiFetch.getMockImplementation()!;
  mockApiFetch.mockImplementation(async (url, init, options) => {
    if (String(url).endsWith('/ignores') && (init?.method === 'PUT') === (call === 'save')) {
      return new Promise<Response>((resolve) => {
        answer = resolve;
      });
    }
    return passThrough(url, init, options);
  });
  return (value: Response) => answer(value);
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
  connectChoices = {};
  suggestions = { groups: [], overLimit: false };
  suggestionFailure = false;
  mockApiFetch.mockReset();
  route(async () => response(plan()));
});

// Components are the cheapest layer that verifies pre-fill, user input and the submitted request together.
describe('ConnectDialog remembered choices', () => {
  const twoVms = {
    remotes: [REMOTE, { ...REMOTE, id: 'r2', name: 'second-vm' }],
    statuses: new Map([
      ['r1', vmStatus('ready', 'Ready')],
      ['r2', vmStatus('ready', 'Ready')],
    ]),
  };

  it.each([
    { cached: null, state: 'absent' },
    { cached: null, state: 'present' },
    { cached: 'absent', state: 'present' },
    { cached: 'present', state: 'absent' },
  ] as const)(
    'waits for deferred presence $state with cached $cached before acting on saved Docker on',
    async ({ cached, state }) => {
      connectChoices.p1 = { includeDocker: true };
      let answerPresence!: (value: Response) => void;
      let answerPlan!: (value: Response) => void;
      route(
        () =>
          new Promise<Response>((resolve) => {
            answerPlan = resolve;
          }),
        () =>
          new Promise<Response>((resolve) => {
            answerPresence = resolve;
          }),
      );
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      if (cached) client.setQueryData([HOME_BACKEND, 'docker-presence', 'p1'], { state: cached });
      const { onConnect } = renderFlow({}, client);
      await next();
      expect(
        screen.queryByRole('checkbox', { name: 'Include Docker containers' }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
      expect(planCalls()).toHaveLength(0);

      await act(async () => answerPresence(response({ state })));
      if (state === 'present') {
        expect(
          await screen.findByRole('checkbox', { name: 'Include Docker containers' }),
        ).toBeChecked();
        await waitFor(() => expect(planCalls()).toHaveLength(1));
        expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
        await act(async () => answerPlan(response(plan())));
        await screen.findByRole('checkbox', { name: 'web' });
      } else {
        expect(
          screen.queryByRole('checkbox', { name: 'Include Docker containers' }),
        ).not.toBeInTheDocument();
        expect(planCalls()).toHaveLength(0);
      }
      await connect();
      expect(onConnect).toHaveBeenCalledWith({
        projectId: 'p1',
        remoteId: 'r1',
        docker:
          state === 'present' ? { items: [{ id: 'web', mode: 'container-and-data' }] } : undefined,
      });
    },
  );

  it.each([
    { cached: null, result: 'unknown' },
    { cached: null, result: 'network' },
    { cached: null, result: 'server' },
    { cached: 'absent', result: 'network' },
    { cached: 'absent', result: 'server' },
  ] as const)(
    'offers Docker and restores the saved choice when presence is $result with cached $cached',
    async ({ cached, result }) => {
      connectChoices.p1 = { includeDocker: true };
      route(
        async () => response(plan()),
        async () => {
          if (result === 'network') throw new Error('offline');
          return result === 'server'
            ? response({ message: 'unavailable' }, 503)
            : response({ state: 'unknown' });
        },
      );
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      if (cached) client.setQueryData([HOME_BACKEND, 'docker-presence', 'p1'], { state: cached });
      renderFlow({}, client);
      await next();
      expect(
        await screen.findByRole('checkbox', { name: 'Include Docker containers' }),
      ).toBeChecked();
      expect(await screen.findByRole('checkbox', { name: 'web' })).toBeChecked();
      expect(planCalls()).toHaveLength(1);
    },
  );

  it('reads presence once for a project across VM switches', async () => {
    renderFlow({ ...twoVms, initialRemoteId: 'r1' });
    await next();
    await screen.findByRole('checkbox', { name: 'Include Docker containers' });
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await userEvent.click(screen.getByRole('button', { name: 'second-vm' }));
    await next();
    expect(screen.getByRole('checkbox', { name: 'Include Docker containers' })).not.toBeChecked();
    expect(
      mockApiFetch.mock.calls.filter(([url]) => String(url).endsWith('/docker/presence')),
    ).toHaveLength(1);
  });

  it('keeps a deselected container across a browser reconnect on Review', async () => {
    connectChoices.p1 = { includeDocker: true };
    let presenceReads = 0;
    route(
      async () => response(plan()),
      () => {
        presenceReads++;
        // A second read stays open, so a reconnect refetch would hide and reset the section.
        return presenceReads === 1
          ? Promise.resolve(response({ state: 'present' }))
          : new Promise<Response>(() => undefined);
      },
    );
    const { onConnect } = renderFlow();
    try {
      await next();
      await userEvent.click(await screen.findByRole('checkbox', { name: 'web' }));
      await waitFor(() => expect(lastPlanItems()).toEqual([]));
      await next();
      await act(async () => onlineManager.setOnline(false));
      await act(async () => {
        onlineManager.setOnline(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(presenceReads).toBe(1);
      await waitFor(() => expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled());
      await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
      expect(onConnect).toHaveBeenCalledWith({
        projectId: 'p1',
        remoteId: 'r1',
        docker: undefined,
      });
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it('pre-fills the VM and toggle and submits the first plan’s restored inclusion and mode', async () => {
    connectChoices.p1 = { remoteId: 'r2', includeDocker: true };
    const excluded = item({ id: 'db', name: 'db', defaultSelected: false, selectedMode: null });
    route(async () =>
      response(
        plan({
          remoteId: 'r2',
          items: [
            item({ selectedMode: 'without-data', choices: ['container-and-data', 'without-data'] }),
            excluded,
          ],
        }),
      ),
    );
    const { onConnect } = renderFlow(twoVms);
    await next();
    expect(screen.getByRole('checkbox', { name: 'Include Docker containers' })).toBeChecked();
    expect(await screen.findByRole('checkbox', { name: 'web' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'db' })).not.toBeChecked();
    expect(screen.getByRole('combobox', { name: 'Mode for web' })).toHaveTextContent(
      'Copy without its data',
    );
    await connect();
    expect(planCalls()).toHaveLength(1);
    expect(JSON.parse(String(planCalls()[0][1]?.body))).toEqual({ remoteId: 'r2' });
    expect(onConnect).toHaveBeenCalledWith({
      projectId: 'p1',
      remoteId: 'r2',
      docker: { items: [{ id: 'web', mode: 'without-data' }] },
    });
  });

  it.each([true, false])(
    'honors an explicit VM over history when the explicit VM is ready: %s',
    async (ready) => {
      connectChoices.p1 = { remoteId: 'r2', includeDocker: false };
      renderFlow({
        ...twoVms,
        initialRemoteId: 'r1',
        statuses: new Map([
          ['r1', vmStatus(ready ? 'ready' : 'offline', ready ? 'Ready' : 'Offline')],
          ['r2', vmStatus('ready', 'Ready')],
        ]),
      });
      await waitFor(() =>
        expect(mockApiFetch).toHaveBeenCalledWith(
          '/api/projects/p1/connect-choices',
          expect.anything(),
          { backend: 'home' },
        ),
      );
      await waitFor(() =>
        expect(screen.queryByText('Reading the Connect choices…')).not.toBeInTheDocument(),
      );
      expect(screen.getByRole('button', { name: 'second-vm' })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
      expect(screen.getByRole('button', { name: 'Next' })).toHaveProperty('disabled', !ready);
    },
  );

  it('preserves a VM picked by the user when the remembered choices arrive later', async () => {
    const passThrough = mockApiFetch.getMockImplementation()!;
    let resolve!: (body: Response) => void;
    mockApiFetch.mockImplementation((url, init, options) =>
      String(url).endsWith('/connect-choices')
        ? new Promise<Response>((answer) => {
            resolve = answer;
          })
        : passThrough(url, init, options),
    );
    const { onConnect } = renderFlow(twoVms);
    await userEvent.click(screen.getByRole('button', { name: 'lab-vm' }));
    await act(async () => resolve(response({ remoteId: 'r2', includeDocker: false })));
    await next();
    await connect();
    expect(onConnect).toHaveBeenCalledWith(expect.objectContaining({ remoteId: 'r1' }));
  });

  it('applies each project’s remembered VM once as the project picker changes', async () => {
    connectChoices.p1 = { remoteId: 'r1', includeDocker: false };
    connectChoices.p2 = { remoteId: 'r2', includeDocker: false };
    renderFlow({
      ...twoVms,
      initialProjectId: undefined,
      projects: {
        ...PROJECTS,
        rows: [projectRow('p1', 'Alpha', 'w1'), projectRow('p2', 'Beta', 'w1')],
      },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Choose Alpha' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'lab-vm' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: 'second-vm' }));
    await userEvent.click(screen.getByRole('button', { name: 'Choose Beta' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'second-vm' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Choose Alpha' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'second-vm' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('connects with file sync and keeps exclusions when a remembered Docker choice meets mismatched ids', async () => {
    connectChoices.p1 = { remoteId: 'r1', includeDocker: true };
    ignores = ['/state', '/private-output', ...DEFAULT_FILE_SYNC_IGNORES];
    route(async () =>
      response(
        plan({
          availability: {
            available: false,
            side: 'remote',
            reason: { code: 'vm-user-mismatch', message: 'The user ids differ.' },
            userMismatch: { homeUid: 1000, homeGid: 1000, vmUid: 1001, vmGid: 1000 },
          },
          items: [],
          canConnect: false,
        }),
      ),
    );
    const { onConnect } = renderFlow();
    await next();
    await screen.findByRole('note', { name: 'Docker availability' });
    expect(screen.getByRole('checkbox', { name: 'Include Docker containers' })).toBeChecked();
    await connect();

    expect(onConnect).toHaveBeenCalledWith({ projectId: 'p1', remoteId: 'r1', docker: undefined });
    expect(ignores).toEqual(['/state', '/private-output', ...DEFAULT_FILE_SYNC_IGNORES]);
    expect(ignoreSaves).toEqual([]);
    expect(planCalls()).toHaveLength(1);
  });

  it('keeps the current plan’s data default and requires privileged acceptance anew', async () => {
    connectChoices.p1 = { remoteId: 'r1', includeDocker: true };
    route(async () =>
      response(
        plan({
          canConnect: false,
          items: [
            item({
              privileged: true,
              dataState: 'in-sync',
              dataAction: 'keep-vm',
              blockers: [{ code: 'privileged-not-accepted', message: 'Accept Run privileged' }],
            }),
          ],
        }),
      ),
    );
    renderFlow();
    await next();
    expect(await screen.findByRole('combobox', { name: 'Data choice for web' })).toHaveTextContent(
      'Keep VM copy',
    );
    expect(screen.getByRole('checkbox', { name: /Run privileged/ })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(planCalls()).toHaveLength(1);
  });
});

describe('ConnectDialog Docker section', () => {
  it('reads no Docker plan until the user opts in', async () => {
    const { onConnect } = renderFlow();
    await next();

    expect(screen.getByRole('checkbox', { name: 'Include Docker containers' })).not.toBeChecked();
    expect(screen.queryByText('Reading Docker containers…')).not.toBeInTheDocument();
    await connect();

    expect(planCalls()).toHaveLength(0);
    expect(onConnect).toHaveBeenCalledWith(expect.objectContaining({ docker: undefined }));
  });

  it('blocks Next while the opted-in read runs and releases it on the answer', async () => {
    const deferreds = deferredPlans();
    await renderDialog();

    expect(screen.getByText('Reading Docker containers…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // The shared pieces carry the motion: a spinner on the line and on Next.
    const reading = screen.getByText('Reading Docker containers…');
    expect(reading).toHaveRole('status');

    await act(async () => deferreds[0](plan()));
    await screen.findByText('Docker containers');
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it('spins on Next and beside the heading while a plan change runs', async () => {
    const deferreds = deferredPlans();
    await renderDialog();
    await act(async () =>
      deferreds[0](plan({ items: [item({ choices: ['container-and-data', 'without-data'] })] })),
    );
    await screen.findByText('Docker containers');

    await userEvent.click(screen.getByRole('combobox', { name: 'Mode for web' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Copy without its data' }));

    const next = screen.getByRole('button', { name: 'Next' });
    expect(next).toBeDisabled();

    const updating = screen.getByText('Updating the plan…');
    expect(updating).toHaveRole('status');

    // The status line sits beside the heading, whose text stays untouched.

    await act(async () => deferreds[1](plan()));

    expect(screen.queryByText('Updating the plan…')).not.toBeInTheDocument();
    expect(next).toBeEnabled();
  });

  it('drops the read and its late answer when the user opts out', async () => {
    const deferreds = deferredPlans();
    const onConnect = jest.fn();
    await renderDialog(onConnect);

    await includeDocker();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
    await act(async () => deferreds[0](plan()));

    expect(screen.queryByText('Docker containers')).not.toBeInTheDocument();
    await connect();
    expect(onConnect).toHaveBeenCalledWith('r1', undefined);
  });

  it('drops the selection and a pending re-plan when the user opts out', async () => {
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
    await userEvent.click(await screen.findByRole('checkbox', { name: 'legacy' }));
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();

    await includeDocker();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
    await act(async () => deferreds[1](two));

    expect(screen.queryByText('Docker containers')).not.toBeInTheDocument();
    await connect();
    expect(onConnect).toHaveBeenCalledWith('r1', undefined);
  });

  it('starts a fresh read when the user opts in again', async () => {
    const deferreds = deferredPlans();
    await renderDialog();
    await act(async () => deferreds[0](plan()));
    await screen.findByText('Docker containers');

    await includeDocker();
    await includeDocker();

    expect(planCalls()).toHaveLength(2);
    expect(screen.getByText('Reading Docker containers…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await act(async () => deferreds[1](plan()));
    expect(within(row('web')).getByRole('checkbox')).toBeChecked();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

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
    // One line: the image and the volume, with the details closed.
    const webRow = row('web');
    expect(within(webRow).getByText('6.0 KB')).toBeInTheDocument();
    expect(within(webRow).queryByText(/Linked by/)).not.toBeInTheDocument();

    const details = within(webRow).getByRole('button', { name: 'Details for web' });
    await userEvent.click(details);
    expect(details).toHaveAttribute('aria-expanded', 'true');
    expect(within(webRow).getByText(/Linked by Compose label/)).toBeInTheDocument();
    expect(within(webRow).getByText(/named volume web-data → \/data, 4\.0 KB/)).toBeInTheDocument();
    expect(within(webRow).getByText(/image sha256:1 \(x86_64\), 2\.0 KB/)).toBeInTheDocument();

    await userEvent.click(details);
    expect(within(webRow).queryByText(/Linked by/)).not.toBeInTheDocument();
  });

  // Component rendering verifies the labels and omitted size as users see them in Details.
  it('labels synced project code without sizes and project data with its size in Details', async () => {
    route(async () =>
      response(
        plan({
          items: [
            item({
              mounts: [
                {
                  kind: 'project-code',
                  source: '/project/plugins',
                  destination: '/plugins',
                  readOnly: false,
                  size: { bytes: 0, unknown: true },
                },
                {
                  kind: 'project-code',
                  source: '/project/configuration',
                  destination: '/configuration',
                  readOnly: true,
                  size: { bytes: 0, unknown: false },
                },
                {
                  kind: 'project-bind',
                  source: '/project/state',
                  destination: '/state',
                  readOnly: false,
                  size: { bytes: 8192, unknown: false },
                },
              ],
            }),
          ],
        }),
      ),
    );
    await renderDialog();
    await userEvent.click(await screen.findByRole('button', { name: 'Details for web' }));
    const details = within(row('web'));
    expect(
      details.getByText('in-project folder, synced by file sync /project/plugins → /plugins'),
    ).toBeInTheDocument();
    expect(
      details.getByText(
        'in-project folder, synced by file sync /project/configuration → /configuration (read-only)',
      ),
    ).toBeInTheDocument();
    expect(
      details.getByText('in-project data folder /project/state → /state, 8.0 KB'),
    ).toBeInTheDocument();
  });

  // Rendering is the cheapest layer that verifies which image sizes reach the dialog row.
  it('sizes each line by what its mode copies', async () => {
    route(async () =>
      response(
        plan({
          items: [
            item({ id: 'legacy', name: 'legacy', choices: ['container-and-data', 'without-data'] }),
            item({ id: 'kept', name: 'kept', dataAction: 'keep-vm' }),
            item({
              id: 'built',
              name: 'built',
              dataAction: 'keep-vm',
              images: [
                {
                  id: 'sha256:built',
                  architecture: 'x86_64',
                  size: { bytes: 2048, unknown: true },
                  notCopied: true,
                },
              ],
            }),
            item({ id: 'grow', name: 'grow', dataSize: { bytes: 1024, unknown: true } }),
          ],
        }),
      ),
    );
    await renderDialog();

    await screen.findByText('Docker containers');
    expect(within(row('legacy')).getByText('6.0 KB')).toBeInTheDocument();
    // Keep VM copy copies no data; a partly unknown size is a lower bound.
    expect(within(row('kept')).getByText('2.0 KB')).toBeInTheDocument();
    expect(within(row('built')).getByText('0 B')).toBeInTheDocument();
    expect(within(row('grow')).getByText('at least 3.0 KB')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('combobox', { name: 'Mode for legacy' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Copy without its data' }));
    expect(within(row('legacy')).getByText('2.0 KB')).toBeInTheDocument();
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
              warnings: [
                { code: 'architecture-mismatch', message: 'The image architecture differs.' },
              ],
            }),
          ],
          warnings: [{ code: 'unreadable-unselected-folder', message: '/state/db is unreadable.' }],
        }),
      ),
    );
    await renderDialog();

    await screen.findByText('Docker containers');
    const rmRow = row('rm1');
    // Warnings stay in view; notes open with the details.
    expect(within(rmRow).getByText('The image architecture differs.')).toBeInTheDocument();
    expect(within(rmRow).queryByText(DOCKER_TEMPORARY_NOTE)).not.toBeInTheDocument();
    await userEvent.click(within(rmRow).getByRole('button', { name: 'Details for rm1' }));
    expect(within(rmRow).getAllByText(DOCKER_TEMPORARY_NOTE)).toHaveLength(1);
    expect(within(rmRow).getAllByText(DOCKER_WRITABLE_LAYER_NOTE)).toHaveLength(1);
    expect(within(rmRow).getByText('the agent builds them on the VM')).toBeInTheDocument();
    expect(within(rmRow).getByText('The image architecture differs.')).toBeInTheDocument();
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

  it('totals what the selected containers add on the VM, and hides the total with none', async () => {
    route(async () =>
      response(
        plan({
          items: [item(), item({ id: 'db', name: 'db' })],
          copySize: { bytes: 5 * 1024 * 1024, unknown: true },
        }),
      ),
    );
    await renderDialog();

    expect(
      await screen.findByText('Total for 2 selected containers: at least 5.0 MB on the VM.'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: 'web' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'db' }));
    expect(screen.queryByText(/Total for/)).not.toBeInTheDocument();
  });

  it('notes non-git shared project files on each row that copies them and once in the total', async () => {
    const tmp = {
      kind: 'project-bind' as const,
      source: '/project/tmp',
      destination: '/tmp',
      readOnly: false,
      size: { bytes: 2 * 1024 * 1024, unknown: false },
    };
    route(async () =>
      response(
        plan({
          items: [
            item({ id: 'www', name: 'www', mounts: [tmp] }),
            item({ id: 'scheduler', name: 'scheduler', mounts: [tmp] }),
            item({ id: 'db', name: 'db' }),
          ],
          copySize: { bytes: 3 * 1024 * 1024, unknown: false },
        }),
      ),
    );
    await renderDialog();

    const note = 'incl. 2.0 MB of non-git shared project files (tmp)';
    expect(
      await screen.findByText(`Total for 3 selected containers: 3.0 MB on the VM, ${note}.`),
    ).toBeInTheDocument();
    expect(within(row('www')).getByText(note)).toBeInTheDocument();
    expect(within(row('scheduler')).getByText(note)).toBeInTheDocument();
    expect(within(row('db')).queryByText(/non-git/)).not.toBeInTheDocument();
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
      await userEvent.click(screen.getByRole('button', { name: 'Details for dupe' }));
      await screen.findByText(/Writable layer/);
    } finally {
      spy.mockRestore();
    }
    expect(errors.filter((line) => line.includes('unique "key" prop'))).toEqual([]);
  });
});

// Component tests exercise the real section and dialog gate with only HTTP mocked.
describe('privileged container acceptance', () => {
  const label =
    'Run privileged: root access on the VM. If the container does not need it, remove it before you connect.';
  const blocker = {
    code: 'privileged-not-accepted',
    message: 'Accept Run privileged for this container, or pick Copy its data only.',
  };
  const answer = (selections?: DockerSelectionItem[], names = ['web']) => {
    const selected: DockerSelectionItem[] =
      selections ?? names.map((id) => ({ id, mode: 'container-and-data' }));
    const items = names.map((id) => {
      const selection = selected.find((s) => s.id === id);
      const needsAcceptance =
        selection && selection.mode !== 'data-only' && !selection.acceptPrivileged;
      return item({
        id,
        name: id,
        privileged: true,
        dataState: 'no-record',
        dataGroup: names,
        choices: ['container-and-data', 'without-data', 'data-only'],
        selectedMode: selection?.mode ?? null,
        blockers: needsAcceptance ? [blocker] : [],
      });
    });
    return plan({ items, canConnect: items.every((i) => i.blockers.length === 0) });
  };
  const routePrivileged = (names = ['web']) =>
    route(async (_url, init) => {
      const input = JSON.parse(String(init?.body)) as { items?: DockerSelectionItem[] };
      return response(answer(input.items, names));
    });

  it.each(['container-and-data', 'without-data'] as const)(
    'requires the checkbox for %s and sends acceptance in the plan and Connect',
    async (mode) => {
      routePrivileged();
      const onConnect = jest.fn();
      await renderDialog(onConnect);
      await screen.findByRole('checkbox', { name: label });
      if (mode === 'without-data') {
        await userEvent.click(screen.getByRole('combobox', { name: 'Mode for web' }));
        await userEvent.click(await screen.findByRole('option', { name: 'Start with empty data' }));
      }
      const checkbox = screen.getByRole('checkbox', { name: label });
      expect(checkbox).not.toBeChecked();
      expect(checkbox).toHaveAttribute('aria-invalid', 'true');
      expect(checkbox).toHaveClass('ring-status-warn');
      expect(row('web')).toHaveClass('border-status-warn');
      expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
      expect(screen.queryByText(blocker.message)).not.toBeInTheDocument();

      await userEvent.click(checkbox);

      expect(checkbox).toBeChecked();
      expect(checkbox).toHaveAttribute('aria-invalid', 'false');
      expect(checkbox).not.toHaveClass('ring-status-warn');
      expect(row('web')).not.toHaveClass('border-status-warn');
      expect(lastPlanItems()).toEqual([{ id: 'web', mode, acceptPrivileged: true }]);
      await connect();
      expect(onConnect).toHaveBeenCalledWith('r1', {
        items: [{ id: 'web', mode, acceptPrivileged: true }],
      });
    },
  );

  it('hides acceptance for data-only and requires it again when returning to a container mode', async () => {
    routePrivileged();
    await renderDialog();
    await userEvent.click(await screen.findByRole('combobox', { name: 'Mode for web' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Copy its data only' }));
    expect(screen.queryByRole('checkbox', { name: label })).not.toBeInTheDocument();
    expect(row('web')).not.toHaveClass('border-status-warn');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    expect(lastPlanItems()).toEqual([{ id: 'web', mode: 'data-only' }]);

    await userEvent.click(screen.getByRole('combobox', { name: 'Mode for web' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Container and data' }));
    expect(screen.getByRole('checkbox', { name: label })).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(screen.queryByText(blocker.message)).not.toBeInTheDocument();
  });

  it('omits the checkbox for ordinary containers and privileged items with only data-only choices', async () => {
    route(async () =>
      response(
        plan({
          items: [
            item(),
            item({
              id: 'device',
              name: 'device',
              privileged: true,
              choices: ['data-only'],
              selectedMode: 'data-only',
              blockers: [{ code: 'runtime-bound', message: 'Container cannot move: Devices' }],
            }),
          ],
        }),
      ),
    );
    await renderDialog();
    await screen.findByText('Docker containers');
    expect(screen.queryByRole('checkbox', { name: label })).not.toBeInTheDocument();
    expect(screen.getByText('Container cannot move: Devices')).toBeInTheDocument();
  });

  it('marks acceptance required only while the privileged item is selected', async () => {
    routePrivileged();
    await renderDialog();
    const checkbox = await screen.findByRole('checkbox', { name: label });
    await userEvent.click(screen.getByRole('checkbox', { name: 'web' }));
    expect(checkbox).toBeDisabled();
    expect(checkbox).toHaveAttribute('aria-invalid', 'false');
    expect(checkbox).not.toHaveClass('ring-status-warn');
    expect(row('web')).not.toHaveClass('border-status-warn');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());

    await userEvent.click(screen.getByRole('checkbox', { name: 'web' }));
    expect(checkbox).toBeEnabled();
    expect(checkbox).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('keeps acceptance separate for each container even when the items share a data group', async () => {
    routePrivileged(['web', 'reader']);
    const onConnect = jest.fn();
    await renderDialog(onConnect);
    await screen.findAllByRole('checkbox', { name: label });
    await userEvent.click(within(row('web')).getByRole('checkbox', { name: label }));
    expect(within(row('reader')).getByRole('checkbox', { name: label })).not.toBeChecked();
    expect(within(row('reader')).getByRole('checkbox', { name: label })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(lastPlanItems()).toEqual([
      { id: 'web', mode: 'container-and-data', acceptPrivileged: true },
      { id: 'reader', mode: 'container-and-data' },
    ]);

    await userEvent.click(within(row('reader')).getByRole('checkbox', { name: label }));
    await connect();
    expect(onConnect).toHaveBeenCalledWith('r1', {
      items: [
        { id: 'web', mode: 'container-and-data', acceptPrivileged: true },
        { id: 'reader', mode: 'container-and-data', acceptPrivileged: true },
      ],
    });
  });

  it('waits for the server verdict and ignores a late accepted plan after the tick is removed', async () => {
    const deferreds = deferredPlans();
    const onConnect = jest.fn();
    await renderDialog(onConnect);
    await act(async () => deferreds[0](answer()));
    const checkbox = await screen.findByRole('checkbox', { name: label });

    await userEvent.click(checkbox);
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toHaveAttribute('aria-busy', 'true');
    await userEvent.click(checkbox);
    expect(lastPlanItems()).toEqual([{ id: 'web', mode: 'container-and-data' }]);
    await act(async () => deferreds[2](answer()));
    await act(async () =>
      deferreds[1](answer([{ id: 'web', mode: 'container-and-data', acceptPrivileged: true }])),
    );
    expect(checkbox).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();

    await userEvent.click(checkbox);
    await act(async () =>
      deferreds[3](answer([{ id: 'web', mode: 'container-and-data', acceptPrivileged: true }])),
    );
    await connect();
    expect(onConnect).toHaveBeenCalledWith('r1', {
      items: [{ id: 'web', mode: 'container-and-data', acceptPrivileged: true }],
    });
  });
});

it.each(['both-changed'] as const)(
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
    const select = await screen.findByRole('combobox', { name: 'Data choice for web' });
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    // The choice Connect waits for is marked until it is made.
    expect(select).toHaveAttribute('aria-invalid', 'true');
    await userEvent.click(select);
    await userEvent.click(await screen.findByRole('option', { name: 'Keep VM copy' }));
    expect(select).toHaveAttribute('aria-invalid', 'false');
    expect(screen.getByRole('combobox', { name: 'Data choice for reader' })).toHaveTextContent(
      'Keep VM copy',
    );
    expect(lastPlanItems()).toEqual([
      { id: 'web', mode: 'container-and-data', dataChoice: 'keep-vm' },
      { id: 'reader', mode: 'container-and-data', dataChoice: 'keep-vm' },
    ]);
    await userEvent.click(screen.getByRole('combobox', { name: 'Data choice for reader' }));
    await userEvent.click(
      await screen.findByRole('option', { name: "Replace with this PC's data" }),
    );
    expect(screen.getByRole('combobox', { name: 'Data choice for web' })).toHaveTextContent(
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

it.each([
  ['vm-newer', 'keep-vm', 'Keep VM copy'],
  ['home-newer', 'replace-home', "Replace with this PC's data"],
] as const)(
  'preselects the plan default for %s data the VM holds, without a mode choice',
  async (dataState, dataAction, label) => {
    const onConnect = jest.fn();
    route(async () => response(plan({ items: [item({ dataState, dataAction })] })));
    await renderDialog(onConnect);
    const select = await screen.findByRole('combobox', { name: 'Data choice for web' });
    expect(select).toHaveTextContent(label);
    expect(select).toHaveAttribute('aria-invalid', 'false');
    expect(screen.queryByRole('combobox', { name: 'Mode for web' })).not.toBeInTheDocument();
    await connect();
    // An untouched default is the server's own; only a changed choice is sent.
    expect(onConnect).toHaveBeenCalledWith('r1', {
      items: [{ id: 'web', mode: 'container-and-data' }],
    });
  },
);

it('names a copy without data "Start with empty data" when the VM holds none of it', async () => {
  route(async () =>
    response(
      plan({
        items: [item({ dataState: 'no-record', choices: ['container-and-data', 'without-data'] })],
      }),
    ),
  );
  await renderDialog();
  await userEvent.click(await screen.findByRole('combobox', { name: 'Mode for web' }));
  expect(await screen.findByRole('option', { name: 'Start with empty data' })).toBeInTheDocument();
  expect(screen.queryByRole('combobox', { name: 'Data choice for web' })).not.toBeInTheDocument();
});

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

  // Component tests verify the suggestions request, draft edits and final save together.
  it('merges default suggestions in order, keeps them across Back and saves them before Connect', async () => {
    suggestions.groups = [
      suggestion({
        pathCount: 2,
        pathSample: ['logs', 'other-logs'],
        home: { ...suggestion().vm!, owner: { uid: 48, name: 'uid 48' } },
      }),
      suggestion({
        path: 'cache',
        side: 'home',
        home: { ...suggestion().vm!, owner: { uid: 48, name: 'uid 48' } },
        vm: null,
        owner: { uid: 48, name: 'uid 48' },
        pattern: '(?d)/cache',
        patterns: ['(?d)/cache'],
        pathCount: 1,
        selected: false,
        reasonKind: 'foreignOwner',
      }),
    ];
    const { onConnect } = renderFlow();
    expect(
      mockApiFetch.mock.calls.filter(([url]) => String(url).endsWith('/suggestions')),
    ).toHaveLength(0);
    await next();
    const selected = await screen.findByRole('checkbox', { name: 'Exclude logs on the VM' });
    await waitFor(() => expect(selected).toBeChecked());
    const section = screen.getByRole('region', { name: 'Files that cannot sync' });
    await userEvent.click(screen.getByRole('button', { name: 'Details for logs on the VM' }));
    await userEvent.click(screen.getByRole('button', { name: 'Details for cache on this PC' }));
    expect(section).toHaveTextContent('the VM · owned by root · owned by another user');
    expect(section).toHaveTextContent('3 files in this group · 2 paths');
    expect(section).toHaveTextContent('3 files in this group · 1 path');
    expect(section).toHaveTextContent('this PC · owned by uid 48 · owned by another user');
    expect(section).toHaveTextContent('keeps 1 tracked file');
    expect(section).toHaveTextContent('/logs/keep.txt');
    expect(section).toHaveTextContent('root owns files in 1 group on the VM');
    expect(screen.getByRole('checkbox', { name: 'Exclude cache on this PC' })).not.toBeChecked();
    expect(chips().slice(-2)).toEqual(['!/logs/keep.txt', '(?d)/logs']);
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await next();
    const calls = mockApiFetch.mock.calls.filter(([url]) => String(url).endsWith('/suggestions'));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      '/api/projects/p1/file-sync/suggestions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ remoteId: 'r1' }),
      }),
      { backend: 'home' },
    ]);
    await connect();
    expect(screen.getByRole('region', { name: 'File list changes' })).toHaveTextContent(
      '+ !/logs/keep.txt',
    );
    expect(ignoreSaves).toEqual([[...ignores, '!/logs/keep.txt', '(?d)/logs']]);
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it('removes an unticked group and appends an opted-in group after manual edits', async () => {
    suggestions.groups = [suggestion()];
    renderFlow();
    await next();
    const checkbox = await screen.findByRole('checkbox', { name: 'Exclude logs on the VM' });
    await waitFor(() => expect(checkbox).toBeChecked());
    await userEvent.type(screen.getByLabelText('Add a pattern'), 'manual{Enter}');
    await userEvent.click(checkbox);
    expect(chips()).toEqual([...ignores, 'manual']);
    await userEvent.click(checkbox);
    expect(chips().slice(-3)).toEqual(['manual', '!/logs/keep.txt', '(?d)/logs']);
    await userEvent.click(checkbox);
    await connect();
    expect(ignoreSaves).toEqual([[...ignores, 'manual']]);
  });

  it.each([
    ['blockedBy', { blockedBy: '!/logs', patterns: [] }, 'Your list has !/logs'],
    ['gitUnchecked', { gitUnchecked: true, patterns: [] }, 'Git could not be checked.'],
    [
      'chown',
      { chown: { vm: 'sudo chown -R alice /project/logs' }, patterns: [] },
      'the VM: sudo chown -R alice /project/logs',
    ],
  ] satisfies Array<[string, Partial<ExclusionSuggestion>, string]>)(
    'shows %s guidance without offering an exclusion or blocking Connect',
    async (_, overrides, message) => {
      suggestions.groups = [suggestion({ ...overrides, patterns: [...overrides.patterns] })];
      const { onConnect } = renderFlow();
      await next();
      const section = await screen.findByRole('region', { name: 'Files that cannot sync' });
      if ('gitUnchecked' in overrides && overrides.gitUnchecked)
        await userEvent.click(screen.getByRole('button', { name: 'Details for logs on the VM' }));
      if ('chown' in overrides && overrides.chown)
        await userEvent.click(
          screen.getByRole('button', { name: /Files Git tracks \(cannot be excluded\)/ }),
        );
      await waitFor(() => expect(section).toHaveTextContent(message));
      expect(within(section).queryByRole('checkbox')).not.toBeInTheDocument();
      if ('chown' in overrides && overrides.chown) {
        const user = userEvent.setup();
        const copy = jest.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
        await user.click(screen.getByRole('button', { name: 'Copy command for logs on the VM' }));
        expect(copy).toHaveBeenCalledWith(overrides.chown.vm);
        expect(section).toHaveTextContent(overrides.chown.vm!);
        copy.mockRestore();
      }
      await connect();
      expect(ignoreSaves).toEqual([]);
      expect(onConnect).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['overLimit', 'unavailable', 'failed'] as const)(
    'keeps Connect available when suggestions are %s',
    async (failure) => {
      suggestions.groups = [suggestion()];
      if (failure === 'overLimit')
        suggestions.groups = [
          suggestion({
            patterns: [],
            patternError: 'These paths cannot fit within the remaining exclusion pattern limit.',
          }),
        ];
      if (failure === 'unavailable') {
        suggestions.vm = 'unavailable';
        suggestions.groups = [];
      }
      if (failure === 'failed') suggestionFailure = true;
      const { onConnect } = renderFlow();
      await next();
      const message =
        failure === 'overLimit'
          ? 'These suggestions would pass the limit of 200 patterns.'
          : failure === 'unavailable'
            ? 'DevChain could not scan the VM.'
            : 'DevChain could not scan this PC.';
      await screen.findByText(message);
      expect(chips()).toEqual(ignores);
      await connect();
      expect(ignoreSaves).toEqual([]);
      expect(onConnect).toHaveBeenCalledTimes(1);
    },
  );

  it('waits for suggestions and refuses the whole merge if edits fill the pattern limit', async () => {
    ignores = Array.from({ length: 198 }, (_, index) => `pattern-${index}`);
    const passThrough = mockApiFetch.getMockImplementation()!;
    let answer!: (value: Response) => void;
    mockApiFetch.mockImplementation((url, init, options) =>
      String(url).endsWith('/suggestions')
        ? new Promise<Response>((resolve) => {
            answer = resolve;
          })
        : passThrough(url, init, options),
    );
    const { onConnect } = renderFlow();
    await next();
    await screen.findByLabelText('Add a pattern');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Add a pattern'), 'manual{Enter}');
    await act(async () => answer(response({ groups: [suggestion()], overLimit: false })));
    await screen.findByText('These suggestions would pass the limit of 200 patterns.');
    expect(chips()).toEqual([...ignores, 'manual']);
    await connect();
    expect(ignoreSaves).toEqual([[...ignores, 'manual']]);
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it('continues after an unresolved scan times out and ignores its late defaults', async () => {
    jest.useFakeTimers();
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const passThrough = mockApiFetch.getMockImplementation()!;
    let answer!: (value: Response) => void;
    let scanSignal: AbortSignal | null | undefined;
    mockApiFetch.mockImplementation((url, init, options) => {
      if (String(url).endsWith('/suggestions')) {
        scanSignal = init?.signal;
        return new Promise<Response>((resolve) => {
          answer = resolve;
        });
      }
      return passThrough(url, init, options);
    });
    try {
      const { onConnect } = renderFlow();
      await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
      await user.click(screen.getByRole('button', { name: 'Next' }));
      await screen.findByLabelText('Add a pattern');
      await user.type(screen.getByLabelText('Add a pattern'), 'manual{Enter}');
      expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
      await act(async () => {
        jest.advanceTimersByTime(14_999);
      });
      expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
      await act(async () => {
        jest.advanceTimersByTime(1);
      });
      expect(screen.getByText('DevChain could not scan this PC.')).toBeInTheDocument();
      expect(scanSignal?.aborted).toBe(true);
      expect(chips()).toEqual([...ignores, 'manual']);
      await user.click(screen.getByRole('button', { name: 'Next' }));
      await act(async () => answer(response({ groups: [suggestion()], overLimit: false })));
      const review = screen.getByRole('region', { name: 'File list changes' });
      expect(review).toHaveTextContent('+ manual');
      expect(review).not.toHaveTextContent('logs');
      await user.click(screen.getByRole('button', { name: 'Connect' }));
      await waitFor(() => expect(onConnect).toHaveBeenCalledTimes(1));
      expect(ignoreSaves).toEqual([[...ignores, 'manual']]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('spins on the file-list line and on Next while the list reads', async () => {
    const answerIgnores = holdIgnores('read');
    renderFlow();
    await next();

    const reading = screen.getByText('Reading the file list…');
    expect(reading).toHaveRole('status');

    await act(async () => answerIgnores(response({ ignores, revision: 0 })));
    await screen.findByRole('list', { name: 'Ignore patterns' });
    expect(screen.queryByText('Reading the file list…')).not.toBeInTheDocument();
  });

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

  // This flow test verifies that the editor surfaces shared validation and prevents a draft edit.
  it('refuses a syntactically invalid ignore pattern', async () => {
    renderFlow();
    await next();
    const input = await screen.findByLabelText('Add a pattern');
    await userEvent.type(input, 'broken[[');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Invalid ignore pattern:');
    expect(chips()).not.toContain('broken[');
    await userEvent.clear(input);
    await userEvent.type(input, '*.log{Enter}');
    expect(chips()).toContain('*.log');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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
      if (String(url).endsWith('/ignores')) return response({ ignores: saved(), revision: 0 });
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
});

describe('ConnectDialog Connect button', () => {
  it('spins on Connect while it starts, with the Starting… label', async () => {
    const flow = renderFlow();
    await next();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    await next();
    flow.rerender({ pending: true });

    const connect = screen.getByRole('button', { name: 'Starting…' });
    expect(connect).toBeDisabled();
  });

  it('spins on Connect while it saves the list, with the Saving… label', async () => {
    const answerSave = holdIgnores('save');
    renderFlow();
    await next();
    await userEvent.type(await screen.findByLabelText('Add a pattern'), 'tmp{Enter}');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    await next();

    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

    const connect = screen.getByRole('button', { name: 'Saving…' });
    expect(connect).toBeDisabled();

    await act(async () => answerSave(response({})));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument(),
    );
  });
});

// The real choices hook must carry the API Git state into Review.
it.each(['missing', 'present'] as const)(
  'shows repository creation in Review only when Git is %s',
  async (git) => {
    connectChoices.p1 = { includeDocker: false, git };
    renderFlow();
    await next();
    await next();
    const review = within(screen.getByRole('region', { name: 'What happens' }));
    const note = review.queryByText(
      'DevChain creates a Git repository in this project (git init). File sync needs one.',
    );
    if (git === 'missing') expect(note).toBeInTheDocument();
    else expect(note).not.toBeInTheDocument();
  },
);

// The card and real scan hook verify contribution preservation across scan responses.
describe('Connect file-sync exclusions and ownership', () => {
  const patterns = () =>
    within(screen.getByRole('list', { name: 'Ignore patterns' }))
      .getAllByRole('listitem')
      .map((item) => item.textContent);
  const homeGroup = (path: string, overrides: Partial<ExclusionSuggestion> = {}) =>
    suggestion({
      path,
      side: 'home',
      home: { ...suggestion().vm!, path },
      vm: null,
      pattern: `(?d)/${path}`,
      patterns: [`(?d)/${path}`],
      ...overrides,
    });
  function FileCard({ refreshKey }: { refreshKey: number }) {
    const [list, setList] = useState(ignores);
    const [manual, setManual] = useState(ignores);
    const onPending = useCallback(() => {}, []);
    const onPatterns = useCallback((patterns: string[], selected: boolean) => {
      setList((current) =>
        selected
          ? [...new Set([...current, ...patterns])]
          : current.filter((pattern) => !patterns.includes(pattern)),
      );
    }, []);
    return (
      <>
        <ConnectOwnerProblems
          projectId="p1"
          remoteId="r1"
          list={list}
          disabled={false}
          manualPatterns={manual}
          onPatterns={onPatterns}
          onPending={onPending}
          refreshKey={refreshKey}
        />
        <IgnoreListEditor
          list={list}
          disabled={false}
          onChange={(draft) => {
            setManual((current) => [
              ...current.filter((pattern) => draft.list.includes(pattern)),
              ...draft.list.filter((pattern) => !list.includes(pattern)),
            ]);
            setList(draft.list);
          }}
        />
      </>
    );
  }
  const renderCard = () => {
    const view = render(<FileCard refreshKey={0} />);
    return { rescan: () => view.rerender(<FileCard refreshKey={1} />) };
  };

  it.each(['initial', 'retyped'])(
    'preserves a %s manual pattern through untick and a resolved rescan',
    async (origin) => {
      const keep = '(?d)/code';
      const exclude = '!/code/keep.txt';
      if (origin === 'initial') ignores.push(keep);
      suggestions.groups = [homeGroup('code', { patterns: [exclude, keep] })];
      const { rescan } = renderCard();
      const checkbox = await screen.findByRole('checkbox', { name: 'Exclude code on this PC' });
      await waitFor(() => expect(checkbox).toBeChecked());
      if (origin === 'retyped') {
        await userEvent.click(screen.getByRole('button', { name: `Remove ${keep}` }));
        await userEvent.type(screen.getByLabelText('Add a pattern'), `${keep}{Enter}`);
      }
      await userEvent.click(checkbox);
      expect(checkbox).not.toBeChecked();
      expect(patterns()).toContain(keep);
      expect(patterns()).not.toContain(exclude);
      await userEvent.click(checkbox);
      suggestions.groups = [];
      rescan();
      await waitFor(() => expect(patterns()).not.toContain(exclude));
      expect(patterns()).toEqual(origin === 'initial' ? ignores : [...ignores, keep]);
    },
  );

  it('shows tracked-file ownership repair when files cannot be excluded', async () => {
    suggestions.groups = [
      homeGroup('code', {
        pattern: undefined,
        patterns: [],
        selected: false,
        chown: { home: "sudo chown -R alice '/work/p1/code'" },
      }),
    ];
    renderFlow();
    await next();
    await userEvent.click(
      await screen.findByRole('button', { name: /Files Git tracks \(cannot be excluded\)/ }),
    );
    const command = screen.getByRole('button', { name: 'Copy command for code on this PC' });
    expect(command).toBeEnabled();
    expect(screen.getByRole('region', { name: 'Files that cannot sync' })).toHaveTextContent(
      "sudo chown -R alice '/work/p1/code'",
    );
    expect(
      screen.queryByRole('checkbox', { name: 'Exclude code on this PC' }),
    ).not.toBeInTheDocument();
  });

  it('lists only the owners that block sync', async () => {
    suggestions.groups = [
      homeGroup('code', {
        vm: {
          ...suggestion().vm!,
          path: 'code',
          owner: { uid: 1000, name: 'alice' },
          foreignOwner: false,
        },
      }),
    ];
    renderFlow();
    await next();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Details for code on this PC' }),
    );
    const section = screen.getByRole('region', { name: 'Files that cannot sync' });
    expect(section).toHaveTextContent('this PC · owned by root · owned by another user');
    expect(section).not.toHaveTextContent('the VM · owned by alice');
  });

  it('retains patterns that another ticked group needs through untick and rescan', async () => {
    const shared = '(?d)/code';
    const keep = '!/code/keep.txt';
    suggestions.groups = [
      homeGroup('code', { patterns: [keep, shared] }),
      suggestion({ path: 'vm-code', pattern: shared, patterns: [shared] }),
    ];
    const { rescan } = renderCard();
    const home = await screen.findByRole('checkbox', { name: 'Exclude code on this PC' });
    await waitFor(() => expect(home).toBeChecked());
    await userEvent.click(home);
    expect(patterns()).toEqual([...ignores, shared]);
    expect(screen.getByRole('checkbox', { name: 'Exclude vm-code on the VM' })).toBeChecked();
    await userEvent.click(home);
    expect(patterns()).toEqual(expect.arrayContaining([...ignores, keep, shared]));
    expect(patterns()).toHaveLength(ignores.length + 2);
    suggestions.groups = [suggestion({ path: 'vm-code', pattern: shared, patterns: [shared] })];
    rescan();
    await waitFor(() => expect(patterns()).toEqual([...ignores, shared]));
  });

  it('retains VM contributions when the rescan cannot reach the VM', async () => {
    suggestions.groups = [homeGroup('code'), suggestion()];
    const { rescan } = renderCard();
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'Exclude logs on the VM' })).toBeChecked(),
    );
    const before = patterns();
    suggestions.groups = [homeGroup('code')];
    suggestions.vm = 'unavailable';
    rescan();
    await screen.findByText('DevChain could not scan the VM.');
    expect(patterns()).toEqual(before);
  });

  // The shared list behavior is checked through each card list without duplicating primitive tests.
  it.each(['exclusions', 'keeps', 'tracked'])(
    'collapses and expands the %s list after five items',
    async (kind) => {
      if (kind === 'exclusions')
        suggestions.groups = Array.from({ length: 6 }, (_, i) => homeGroup(`folder-${i}`));
      if (kind === 'keeps')
        suggestions.groups = [
          homeGroup('code', {
            patterns: [...Array.from({ length: 6 }, (_, i) => `!/code/keep-${i}.txt`), '(?d)/code'],
          }),
        ];
      if (kind === 'tracked')
        suggestions.groups = Array.from({ length: 6 }, (_, i) =>
          homeGroup(`tracked-${i}`, {
            patterns: [],
            chown: { home: `sudo chown 1000 tracked-${i}` },
          }),
        );
      renderFlow();
      await next();
      await screen.findByRole('region', { name: 'Files that cannot sync' });
      if (kind === 'keeps')
        await userEvent.click(
          await screen.findByRole('button', { name: 'Details for code on this PC' }),
        );
      if (kind === 'tracked') {
        const tracked = await screen.findByRole('button', {
          name: /Files Git tracks \(cannot be excluded\)/,
        });
        expect(tracked).toHaveAttribute('aria-expanded', 'false');
        await userEvent.click(tracked);
      }
      const name =
        kind === 'exclusions'
          ? 'exclusion groups'
          : kind === 'keeps'
            ? 'tracked files kept for code'
            : 'tracked files to repair';
      const more = await screen.findByRole('button', { name: `Show 1 more ${name}` });
      const last = () =>
        kind === 'exclusions'
          ? screen.queryByRole('checkbox', { name: 'Exclude folder-5 on this PC' })
          : screen.queryByText(kind === 'keeps' ? '/code/keep-5.txt' : 'tracked-5', {
              exact: true,
            });
      expect(last()).not.toBeInTheDocument();
      expect(more).toHaveAttribute('aria-expanded', 'false');
      await userEvent.click(more);
      expect(last()).toBeInTheDocument();
      expect(more).toHaveAttribute('aria-expanded', 'true');
      await userEvent.click(more);
      expect(last()).not.toBeInTheDocument();
    },
  );
});

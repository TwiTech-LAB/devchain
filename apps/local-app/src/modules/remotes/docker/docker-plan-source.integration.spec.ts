// A fake Unix engine exercises the real client, inspect projection and local size walk without Docker.
import { Test } from '@nestjs/testing';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, mkdir, writeFile, symlink, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerEngineClient, DockerEngineError } from '../../core/controllers/docker-engine.client';
import { DockerPlanSourceService } from './docker-plan-source.service';
import { FakeProcessExecutor } from '../../terminal/services/process-executor/fake-process-executor';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { measureDockerBind } from './docker-plan-files';
import { DEFAULT_COMPOSE_FILES } from './docker-project-compose';
import type { CannedResponse } from '../../terminal/services/process-executor/fake-process-executor';

let git: FakeProcessExecutor;
let root: string;
let server: Server;
let client: DockerEngineClient;
let source: DockerPlanSourceService;
let containers: Array<Record<string, unknown>>;
let requests: string[];
let silent: boolean;
const container = (
  id: string,
  mounts: unknown[] = [],
  host: Record<string, unknown> = {},
  config: Record<string, unknown> = {},
) => ({
  Id: id,
  Name: `/${id}`,
  Image: 'image',
  Config: { User: '1000', Labels: {}, Env: ['SECRET=must-never-escape'], ...config },
  HostConfig: host,
  Mounts: mounts,
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'docker-plan-'));
  await mkdir(join(root, 'project'));
  await writeFile(join(root, 'project', 'data'), 'abc');
  containers = [];
  requests = [];
  silent = false;
  git = new FakeProcessExecutor();
  git.setDefaultResponse({ type: 'failure', exitCode: 128 });
  const module = await Test.createTestingModule({
    providers: [DockerPlanSourceService, { provide: ProcessExecutor, useValue: git }],
  }).compile();
  source = module.get(DockerPlanSourceService);
  jest.spyOn(source, 'homePath').mockReturnValue(root);
  jest.spyOn(source, 'uid').mockReturnValue(1000);
  jest.spyOn(source, 'compose').mockResolvedValue(null);
  server = createServer((req, res) => {
    const path = req.url ?? '';
    requests.push(path);
    if (silent) return;
    if (path === '/containers/json?all=true')
      return res.end(
        JSON.stringify(
          containers.map((c) => ({
            Id: c.Id,
            Labels: (c.Config as { Labels?: Record<string, string> }).Labels,
            Mounts: c.Mounts,
          })),
        ),
      );
    if (path === '/system/df?type=image&type=volume')
      return res.end(
        JSON.stringify({
          Images: [{ Id: 'image', Size: 100 }],
          Volumes: [
            { Name: 'named', UsageData: { Size: 9 } },
            { Name: 'anonymous', UsageData: { Size: 5 } },
          ],
        }),
      );
    if (path === '/volumes')
      return res.end(
        JSON.stringify({
          Volumes: [
            { Name: 'named', Driver: 'local' },
            { Name: 'anonymous', Driver: 'local' },
          ],
        }),
      );
    if (path.startsWith('/containers/')) {
      const inspect = containers.find((c) => path.split('?')[0] === `/containers/${c.Id}/json`);
      return res.end(
        JSON.stringify({
          ...inspect,
          ...(path.endsWith('?size=true') && { SizeRw: inspect?.SizeRw ?? 17 }),
        }),
      );
    }
    if (path === '/images/image/json' || path === '/images/present/json')
      return res.end(JSON.stringify({ Id: 'image', Architecture: 'amd64' }));
    res.statusCode = 404;
    res.end('{}');
  });
  server.listen(join(root, 'engine.sock'));
  await once(server, 'listening');
  client = new DockerEngineClient(join(root, 'engine.sock'));
  jest.spyOn(source, 'socket').mockResolvedValue(join(root, 'engine.sock'));
});
afterEach(async () => {
  jest.restoreAllMocks();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await rm(root, { recursive: true, force: true });
});
it('scans each mount class, linked vs other containers, writer groups, SizeRw and uid without leaking settings', async () => {
  const bind = (Source: string, RW = true) => ({ Type: 'bind', Source, Destination: '/data', RW });
  containers = [
    container(
      'linked',
      [
        bind(join(root, 'project')),
        bind(join(root, 'else')),
        bind('/etc/cert', false),
        bind('/srv/db'),
        { Type: 'volume', Name: 'named', Source: '/docker/named', Destination: '/db', RW: true },
        {
          Type: 'volume',
          Name: 'anonymous',
          Source: '/docker/anonymous',
          Destination: '/anon',
          RW: true,
        },
      ],
      { Binds: ['named:/db'] },
    ),
    container('other', [{ Type: 'volume', Name: 'named', Destination: '/db', RW: true }], {
      Binds: ['named:/db'],
    }),
  ];
  const result = await source.scan(client, join(root, 'project'));
  expect(result.items[0].mounts.map((m) => m.kind)).toEqual([
    'project-code',
    'home-bind',
    'readonly-external-bind',
    'external-bind',
    'named-volume',
    'anonymous-volume',
  ]);
  expect(result.items[0].linkedReasons).toContain(`bind:${join(root, 'project')}`);
  expect(result.items[1].linkedReasons).toEqual([]);
  expect(result.items[0].writerGroup).toEqual(['linked', 'other']);
  expect(result.items[0].writableLayer).toEqual({ bytes: 17, unknown: false });
  expect(result.items[1].writableLayer).toEqual({ bytes: 0, unknown: true });
  expect(requests).toContain('/system/df?type=image&type=volume');
  expect(requests.filter((r) => /^\/containers\/[^/]+\/json/.test(r))).toEqual([
    '/containers/linked/json?size=true',
    '/containers/other/json',
  ]);
  expect(result.items[0].warnings).toEqual([]);
  expect(JSON.stringify(result)).not.toContain('must-never-escape');
});
// The scanner boundary is the cheapest layer that reads Compose labels and service intent together.
it.each(['project-build', 'explicit-image', 'outside-build', 'unreadable'])(
  'marks only a rebuildable Compose service: %s',
  async (scenario) => {
    const project = join(root, 'project');
    containers = [
      container(
        'web',
        [],
        {},
        {
          Labels: {
            'com.docker.compose.project': 'app',
            'com.docker.compose.project.working_dir': project,
            'com.docker.compose.project.config_files': join(project, 'custom.yaml'),
            'com.docker.compose.service': 'web',
          },
        },
      ),
    ];
    jest.mocked(source.compose).mockImplementation(async (_directory, options) => {
      if (!options?.files) return null;
      if (scenario === 'unreadable') throw new Error('Cannot read Compose');
      return {
        name: 'app',
        services: {
          web: {
            build: { context: scenario === 'outside-build' ? `${project}-other` : project },
            ...(scenario === 'explicit-image' ? { image: 'app:latest' } : {}),
          },
        },
      };
    });
    const scanned = await source.scan(client, project);
    expect(scanned.items[0].buildsFromProject ?? false).toBe(scenario === 'project-build');
  },
);

it.each(['com.docker.compose.project.working_dir', 'com.docker.compose.project.config_files'])(
  'links from %s only at directory boundaries',
  async (label) => {
    containers = [
      container('linked', [], {}, { Labels: { [label]: join(root, 'project', 'compose.yaml') } }),
      container(
        'other',
        [],
        {},
        { Labels: { [label]: join(root, 'project-other', 'compose.yaml') } },
      ),
    ];
    const result = await source.scan(client, join(root, 'project'));
    expect(result.items[0].linkedReasons).toEqual([label]);
    expect(result.items[1].linkedReasons).toEqual([]);
  },
);
it.each([{ Devices: [{ PathOnHost: '/dev/a' }] }])(
  'classifies runtime-bound settings (%#)',
  async (host) => {
    containers = [container('c', [], host)];
    const result = await source.scan(client, join(root, 'project'));
    expect(result.items[0].blockers[0].code).toBe('runtime-bound');
  },
);
it.each([true, undefined])('flags only privileged containers (%s)', async (privileged) => {
  containers = [container('c', [], { Privileged: privileged })];
  const result = await source.scan(client, join(root, 'project'));
  expect(result.items[0].privileged).toBe(privileged === true ? true : undefined);
  expect(result.items[0].blockers).toEqual([]);
});
it('never measures external read-only binds such as a host root mount', async () => {
  const measure = jest.spyOn(source, 'measure').mockResolvedValue({ bytes: 5, unknown: false });
  containers = [
    container('host', [
      { Type: 'bind', Source: '/', Destination: '/rootfs', RW: false },
      { Type: 'bind', Source: '/var/lib/docker', Destination: '/docker', RW: false },
    ]),
  ];
  const result = await source.scan(client, join(root, 'project'));
  expect(measure).not.toHaveBeenCalled();
  expect(result.items[0].mounts.map((m) => m.size)).toEqual([
    { bytes: 0, unknown: true },
    { bytes: 0, unknown: true },
  ]);
});

// The scanner layer verifies classification before any filesystem measurement or writer grouping.
it.each<{
  label: string;
  response: CannedResponse;
  readOnly: boolean;
  kind: 'project-code' | 'project-bind';
}>([
  {
    label: 'tracked folder',
    response: { type: 'success', stdout: 'plugins/main.py\0' },
    readOnly: false,
    kind: 'project-code',
  },
  {
    label: 'tracked file',
    response: { type: 'success', stdout: 'plugins\0' },
    readOnly: false,
    kind: 'project-code',
  },
  { label: 'ignored folder', response: { type: 'success' }, readOnly: false, kind: 'project-bind' },
  {
    label: 'untracked read-only folder',
    response: { type: 'success' },
    readOnly: true,
    kind: 'project-bind',
  },
  {
    label: 'placeholder files only',
    response: { type: 'success', stdout: 'plugins/.gitkeep\0plugins/.keep\0plugins/.gitignore\0' },
    readOnly: false,
    kind: 'project-bind',
  },
  {
    label: 'placeholder and code',
    response: { type: 'success', stdout: 'plugins/.gitkeep\0plugins/app.py\0' },
    readOnly: false,
    kind: 'project-code',
  },
  {
    label: 'truncated placeholders',
    response: { type: 'output-bytes', stdout: 'plugins/.gitkeep\0'.repeat(300) },
    readOnly: false,
    kind: 'project-code',
  },
  {
    label: 'no git writable',
    response: { type: 'failure', exitCode: 128 },
    readOnly: false,
    kind: 'project-bind',
  },
  {
    label: 'no git read-only',
    response: { type: 'failure', exitCode: 128 },
    readOnly: true,
    kind: 'project-code',
  },
  { label: 'git timeout', response: { type: 'timeout' }, readOnly: false, kind: 'project-bind' },
])('$label is $kind', async ({ response, readOnly, kind }) => {
  git.setDefaultResponse(response);
  const path = join(root, 'project', 'plugins');
  const measure = jest.spyOn(source, 'measure').mockResolvedValue({ bytes: 10, unknown: false });
  containers = [
    container('app', [{ Type: 'bind', Source: path, Destination: '/plugins', RW: !readOnly }]),
  ];
  const scanned = await source.scan(client, join(root, 'project'));
  expect(scanned.items[0].mounts[0]).toMatchObject({ kind });
  expect(scanned.items[0].linkedReasons).toEqual([`bind:${path}`]);
  expect(scanned.codePaths).toEqual(kind === 'project-code' ? [path] : []);
  if (kind === 'project-code') {
    expect(measure).not.toHaveBeenCalled();
    expect(scanned.items[0].mounts[0].size).toEqual({ bytes: 0, unknown: false });
  } else expect(measure).toHaveBeenCalledWith(path, undefined);
  expect(git.calls).toEqual([
    expect.objectContaining({
      argv: ['git', 'ls-files', '-z', '--', ':(literal)plugins'],
      cwd: join(root, 'project'),
      mode: 'pipe',
      outputLimits: { maxBytes: 4096 },
    }),
  ]);
});

it('uses a literal pathspec for paths containing git pattern characters', async () => {
  git.setDefaultResponse({ type: 'success', stdout: 'plugins[1]/app.py\0' });
  containers = [
    container('app', [
      {
        Type: 'bind',
        Source: join(root, 'project', 'plugins[1]'),
        Destination: '/plugins',
        RW: true,
      },
    ]),
  ];
  await source.scan(client, join(root, 'project'));
  expect(git.calls[0].argv).toEqual(['git', 'ls-files', '-z', '--', ':(literal)plugins[1]']);
});

it('keeps the project root code without asking git, even with copy-back overrides', async () => {
  const path = join(root, 'project');
  containers = [
    container('app', [{ Type: 'bind', Source: `${path}/`, Destination: '/app', RW: true }]),
  ];
  const scanned = await source.scan(client, path, undefined, { dataBindPaths: [path] });
  expect(scanned.items[0].mounts[0].kind).toBe('project-code');
  expect(git.calls).toEqual([]);
});

it.each([true, false])('falls back on a thrown git failure, read-only %s', async (readOnly) => {
  jest.spyOn(git, 'run').mockRejectedValue(new Error('git missing'));
  containers = [
    container('app', [
      {
        Type: 'bind',
        Source: join(root, 'project', 'plugins'),
        Destination: '/app',
        RW: !readOnly,
      },
    ]),
  ];
  const scanned = await source.scan(client, join(root, 'project'));
  expect(scanned.items[0].mounts[0].kind).toBe(readOnly ? 'project-code' : 'project-bind');
});

it.each([true, false])(
  "classifies tracked code inside another item's data folder as data, code first %s",
  async (codeFirst) => {
    const data = join(root, 'project', 'state');
    const code = join(data, 'plugins');
    const bind = (Source: string) => ({ Type: 'bind', Source, Destination: '/data', RW: true });
    const entries = [container('code', [bind(code)]), container('data', [bind(data)])];
    containers = codeFirst ? entries : entries.reverse();
    const responses: CannedResponse[] = [
      { type: 'success', stdout: 'state/plugins/main.py\0' },
      { type: 'success' },
    ];
    git.enqueueResponse(...(codeFirst ? responses : responses.reverse()));
    const measure = jest.spyOn(source, 'measure').mockResolvedValue({ bytes: 10, unknown: false });
    const scanned = await source.scan(client, join(root, 'project'));
    expect(scanned.items.flatMap((i) => i.mounts).map((m) => m.kind)).toEqual([
      'project-bind',
      'project-bind',
    ]);
    expect(scanned.codePaths).toEqual([]);
    expect(measure).toHaveBeenCalledWith(code, undefined);
  },
);

it('rechecks git and the root Compose file on each scan even when sizes are reused', async () => {
  const path = join(root, 'project', 'plugins');
  containers = [container('app', [{ Type: 'bind', Source: path, Destination: '/app', RW: true }])];
  git.enqueueResponse({ type: 'success', stdout: 'plugins/app.py\0' }, { type: 'success' });
  const measure = jest.spyOn(source, 'measure').mockResolvedValue({ bytes: 10, unknown: false });
  expect((await source.scan(client, join(root, 'project'))).items[0].mounts[0].kind).toBe(
    'project-code',
  );
  expect(
    (await source.scan(client, join(root, 'project'), undefined, { reuse: true })).items[0]
      .mounts[0].kind,
  ).toBe('project-bind');
  expect(git.calls).toHaveLength(2);
  expect(source.compose).toHaveBeenCalledTimes(2);
  expect(measure).toHaveBeenCalledTimes(1);
});

it('classifies previous imports without git as data, including a current read-only mount', async () => {
  const path = join(root, 'project', 'plugins');
  containers = [container('app', [{ Type: 'bind', Source: path, Destination: '/app', RW: false }])];
  const scanned = await source.scan(client, join(root, 'project'), undefined, {
    previousBindPaths: [path],
  });
  expect(scanned.items[0].mounts[0].kind).toBe('project-bind');
  expect(scanned.codePaths).toEqual([]);
});
it('groups only writers of copied data: shared volumes and project or home folders', async () => {
  // External binds are never measured into a writer relation; skip the size walk of `/`.
  jest.spyOn(source, 'measure').mockResolvedValue({ bytes: 0, unknown: false });
  const bind = (Source: string, RW = true, Destination = '/data') => ({
    Type: 'bind',
    Source,
    Destination,
    RW,
  });
  const named = { Type: 'volume', Name: 'named', Destination: '/db', RW: true };
  const pg = join(root, 'project', 'pg');
  containers = [
    container('db', [bind(pg), bind('/etc/localtime', false, '/etc/localtime'), named], {
      Binds: ['named:/db'],
    }),
    container('clock', [bind('/etc/localtime', false, '/etc/localtime')]),
    container('host', [bind('/', false, '/host')]),
    container('volume-writer', [named], { Binds: ['named:/db'] }),
    container('folder-writer', [bind(join(pg, 'sub'))]),
    container('folder-reader', [bind(pg, false)]),
    container('reader-a', [bind(join(root, 'shared'), false)]),
    container('reader-b', [bind(join(root, 'shared'), false)]),
  ];
  const groups = Object.fromEntries(
    (await source.scan(client, join(root, 'project'))).items.map((i) => [i.id, i.writerGroup]),
  );
  expect(groups.db).toEqual(['db', 'folder-reader', 'folder-writer', 'volume-writer']);
  expect(groups.clock).toEqual(['clock']);
  expect(groups.host).toEqual(['host']);
  expect(groups['reader-a']).toEqual(['reader-a']);
  expect(groups['reader-b']).toEqual(['reader-b']);
});

it('marks unsupported settings as cannot-move only on their containers, with no secret values', async () => {
  containers = [
    container('ok', []),
    container('c', [], { FutureSetting: 'never-log-this-value' }),
    container('odd', [], { VolumesFrom: ['secret-volume-reference'] }),
  ];
  const result = await source.scan(client, join(root, 'project'));
  expect(result.items.find((i) => i.id === 'ok')!.blockers).toEqual([]);
  expect(result.items.find((i) => i.id === 'odd')!.blockers).toEqual([
    {
      code: 'runtime-bound',
      message: expect.stringMatching(/^odd: unsupported setting .+VolumesFrom$/),
    },
  ]);
  expect(JSON.stringify(result)).not.toContain('secret-volume-reference');
  expect(result.items.find((i) => i.id === 'c')!.blockers).toEqual([
    { code: 'runtime-bound', message: 'c: unsupported setting HostConfig.FutureSetting' },
  ]);
  expect(JSON.stringify(result)).not.toContain('never-log-this-value');
});
it('identifies temporary containers without recreatable settings', async () => {
  containers = [container('c', [], { AutoRemove: true })];
  const result = await source.scan(client, join(root, 'project'));
  expect(result.items[0]).toMatchObject({
    temporary: true,
    blockers: [],
    notes: expect.arrayContaining([expect.stringContaining('only its named volumes move')]),
  });
});
it('down Compose projects contribute existing volumes/present images and disclose build services', async () => {
  jest.mocked(source.compose).mockResolvedValue({
    name: 'project',
    services: { web: { image: 'present' }, worker: { build: '.' } },
    volumes: { data: { name: 'named' }, absent: {} },
  });
  const result = await source.scan(client, join(root, 'project'));
  expect(result.items).toHaveLength(1);
  expect(result.items[0]).toMatchObject({
    kind: 'compose-project',
    images: [{ id: 'image' }],
    mounts: [{ source: 'named' }],
    notes: expect.arrayContaining([expect.stringContaining('agent builds them on the VM')]),
  });
});
it('walks files without following symlinks and retains partial sizes on missing paths', async () => {
  await symlink('/etc', join(root, 'project', 'outside'));
  expect(await measureDockerBind(join(root, 'project'))).toEqual({ bytes: 3, unknown: false });
  expect(await measureDockerBind(join(root, 'missing'))).toEqual({ bytes: 0, unknown: true });
});

it('falls back to default configuration when Compose rejects all profiles, preserving file and environment options', async () => {
  jest.mocked(source.compose).mockRestore();
  const bin = join(root, 'bin');
  await mkdir(bin);
  const cli = join(bin, 'docker');
  await writeFile(
    cli,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$COMPOSE_TEST_LOG"
for arg in "$@"; do
  if [ "$arg" = "--profile" ]; then exit 1; fi
done
[ "$COMPOSE_TEST_VALUE" = "passed" ] || exit 2
printf '%s' '{"name":"fallback","services":{}}'
`,
    { mode: 0o755 },
  );
  expect(
    await source.compose(root, {
      files: [join(root, 'custom.yaml')],
      allProfiles: true,
      env: {
        ...process.env,
        PATH: bin,
        COMPOSE_TEST_VALUE: 'passed',
        COMPOSE_TEST_LOG: join(root, 'argv.log'),
      },
    }),
  ).toEqual({ name: 'fallback', services: {} });
  expect((await readFile(join(root, 'argv.log'), 'utf8')).trim().split('\n')).toEqual([
    `compose --project-directory ${root} -f ${join(root, 'custom.yaml')} --profile * config --format json`,
    `compose --project-directory ${root} -f ${join(root, 'custom.yaml')} config --format json`,
  ]);
});

// The fake Unix engine proves discovery's HTTP contract without real Docker or the plan scan.
describe('presence', () => {
  it.each(DEFAULT_COMPOSE_FILES)('finds root %s without contacting Docker', async (name) => {
    await writeFile(join(root, 'project', name), 'services: {}');
    expect(await source.presence(join(root, 'project'))).toEqual({ state: 'present' });
    expect(requests).toEqual([]);
    expect(source.socket).not.toHaveBeenCalled();
  });

  it.each([
    'com.docker.compose.project.working_dir',
    'com.docker.compose.project.config_files',
    'root-bind',
    'subfolder-bind',
  ])('finds a container linked by %s using only the list', async (reason) => {
    const project = join(root, 'project');
    containers = [
      container(
        'stopped',
        reason.endsWith('bind')
          ? [{ Type: 'bind', Source: reason === 'root-bind' ? project : join(project, 'data') }]
          : [],
        {},
        { Labels: reason.endsWith('bind') ? {} : { [reason]: project } },
      ),
    ];
    expect(await source.presence(project)).toEqual({ state: 'present' });
    expect(requests).toEqual(['/containers/json?all=true']);
  });

  it('ignores unrelated containers, volume mounts, nested Compose files and a Dockerfile', async () => {
    const project = join(root, 'project');
    await writeFile(join(project, 'Dockerfile'), 'FROM scratch');
    await mkdir(join(project, 'nested'));
    await writeFile(join(project, 'nested', 'compose.yaml'), 'services: {}');
    containers = [
      container(
        'other',
        [
          { Type: 'bind', Source: `${project}-other` },
          { Type: 'volume', Source: project },
        ],
        {},
        { Labels: { 'com.docker.compose.project.working_dir': `${project}-other` } },
      ),
    ];
    expect(await source.presence(project)).toEqual({ state: 'absent' });
    expect(requests).toEqual(['/containers/json?all=true']);
  });

  it.each(['tcp://remote:2375', 'npipe://unsupported'])(
    'ignores unsupported endpoint %s',
    async (host) => {
      jest.mocked(source.socket).mockRejectedValue(new DockerEngineError('unsupported', host));
      expect(await source.presence(join(root, 'project'))).toEqual({ state: 'absent' });
      expect(requests).toEqual([]);
    },
  );

  it('reports absent when there is no socket', async () => {
    jest.mocked(source.socket).mockResolvedValue(join(root, 'missing.sock'));
    expect(await source.presence(join(root, 'project'))).toEqual({ state: 'absent' });
  });

  (process.getuid?.() === 0 ? it.skip : it)(
    'reports absent when the socket is inaccessible',
    async () => {
      await chmod(join(root, 'engine.sock'), 0);
      expect(await source.presence(join(root, 'project'))).toEqual({ state: 'absent' });
    },
  );

  it('reports unknown when an accessible engine fails to answer', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Keep an accessible path so failure is not classified as a missing socket.
    await writeFile(join(root, 'engine.sock'), '');
    expect(await source.presence(join(root, 'project'))).toEqual({ state: 'unknown' });
  });

  it.each(['socket', 'list'])(
    'bounds %s discovery with the five-second deadline',
    async (stage) => {
      const deadline = new AbortController();
      const timeout = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
      silent = true;
      let socketRequested: () => void = () => undefined;
      const requested =
        stage === 'list'
          ? once(server, 'request')
          : new Promise<void>((resolve) => {
              socketRequested = resolve;
            });
      if (stage === 'socket') {
        jest.mocked(source.socket).mockImplementation(() => {
          socketRequested();
          return new Promise(() => {});
        });
      }
      const presence = source.presence(join(root, 'project'));
      await requested;
      deadline.abort(new Error('deadline'));
      expect(await presence).toEqual({ state: 'unknown' });
      expect(timeout).toHaveBeenCalledWith(5000);
    },
  );

  it('propagates caller cancellation while listing', async () => {
    silent = true;
    const controller = new AbortController();
    const requested = once(server, 'request');
    const presence = source.presence(join(root, 'project'), controller.signal);
    const rejection = expect(presence).rejects.toThrow();
    await requested;
    controller.abort(new Error('request abandoned'));
    await rejection;
  });
});

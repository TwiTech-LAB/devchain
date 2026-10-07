import * as fs from 'node:fs/promises';
import { HostDockerService } from './host-docker.service';
import { DockerScanRequestSchema } from './host-docker.dto';
import { DockerArchiveJournal } from '../../core/controllers/docker-archive-journal';
import { DockerEngineClient } from '../../core/controllers/docker-engine.client';

jest.mock('node:fs/promises', () => ({
  ...jest.requireActual('node:fs/promises'),
  stat: jest.fn(),
  readFile: jest.fn(),
}));
afterEach(() => jest.restoreAllMocks());

it.each([
  { paths: ['relative'] },
  { paths: ['/etc/../hosts'] },
  { paths: ['/etc//hosts'] },
  { paths: ['/x\0y'] },
  { networks: ['invalid name'] },
])('refuses invalid or unbounded scan paths %#', (input) => {
  expect(DockerScanRequestSchema.safeParse(input).success).toBe(false);
});
it('accepts bounded outside-home paths and defaults the optional path list', () => {
  expect(DockerScanRequestSchema.parse({})).toEqual({ paths: [] });
  expect(DockerScanRequestSchema.safeParse({ paths: Array(64).fill('/etc/hosts') }).success).toBe(
    true,
  );
});
it('marks single files, and reports EACCES and other stat errors as unknown while ENOENT is absent', async () => {
  const engine = {
    info: jest.fn(async () => ({ Architecture: 'arm64' })),
    json: jest.fn(async (_method, path) => (path === '/volumes' ? { Volumes: null } : [])),
  } as unknown as DockerEngineClient;
  jest.spyOn(DockerEngineClient, 'connect').mockResolvedValue(engine);
  jest.mocked(fs.stat).mockImplementation(async (path) => {
    if (path === '/outside/link') return { isFile: () => false } as never;
    if (path === '/outside/file') return { isFile: () => true } as never;
    throw Object.assign(new Error('private detail'), {
      code: path === '/missing' ? 'ENOENT' : path === '/denied' ? 'EACCES' : 'EIO',
    });
  });
  const result = await new HostDockerService({} as DockerArchiveJournal).scan([
    '/outside/link',
    '/outside/file',
    '/denied',
    '/missing',
    '/io-error',
  ]);
  expect(result.paths).toEqual([
    { path: '/outside/link', exists: true },
    { path: '/outside/file', exists: true, file: true },
    { path: '/denied', unknown: true },
    { path: '/missing', exists: false },
    { path: '/io-error', unknown: true },
  ]);
  expect(fs.stat).toHaveBeenCalledWith('/outside/link');
  expect(result.routes).toBeUndefined();
});

// The scan boundary verifies the proc reader and projection without an HTTP server.
it('returns only on-link non-default IPv4 routes when networks are requested', async () => {
  jest.mocked(fs.readFile)
    .mockResolvedValue(`Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT
eth0 00001FAC 00000000 0001 0 0 0 0000FFFF 0 0 0
docker0 000011AC 00000000 0001 0 0 0 0000FFFF 0 0 0
eth0 00000000 01001FAC 0003 0 0 0 00000000 0 0 0
eth0 00000000 00000000 0001 0 0 0 00000000 0 0 0
tun0 00000000 01001FAC 0003 0 0 0 00000080 0 0 0
tun0 00000080 01001FAC 0003 0 0 0 00000080 0 0 0
eth0 000010AC 01001FAC 0003 0 0 0 0000F0FF 0 0 0
tun0 00000000 00000000 0003 0 0 0 00000080 0 0 0
eth0 000010AC 01001FAC 0001 0 0 0 0000F0FF 0 0 0`);
  const json = jest.fn(async (_method: string, path: string) =>
    path === '/volumes' ? { Volumes: [] } : [],
  );
  jest.spyOn(DockerEngineClient, 'connect').mockResolvedValue({
    connectedInfo: { Architecture: 'amd64' },
    json,
  } as unknown as DockerEngineClient);
  const result = await new HostDockerService({} as DockerArchiveJournal).scan(
    [],
    undefined,
    undefined,
    undefined,
    [],
  );
  expect(result.routes).toEqual(['172.31.0.0/16', '172.17.0.0/16']);
  expect(fs.readFile).toHaveBeenCalledWith('/proc/net/route', {
    encoding: 'utf8',
    signal: undefined,
  });
});

// Unit layer checks the engine request boundary without running an HTTP server.
it('inspects only data holders and performs no archive or content reads', async () => {
  const json = jest.fn(async (_method: string, path: string) => {
    if (path === '/volumes') return { Volumes: [] };
    if (path === '/containers/json?all=true')
      return [
        {
          Id: 'volume-holder',
          Names: ['/db'],
          Mounts: [{ Type: 'volume', Name: 'data', Destination: '/data' }],
        },
        {
          Id: 'bind-holder',
          Names: ['/web'],
          Mounts: [{ Type: 'bind', Source: '/home/state/nested', Destination: '/data' }],
        },
        { Id: 'unrelated', Names: ['/other'], Mounts: [] },
      ];
    if (path === '/containers/volume-holder/json')
      return {
        Created: '2026-09-01T00:00:00Z',
        State: { StartedAt: '2026-09-02T00:00:00Z', Running: false },
        Config: { Env: ['PRIVATE'] },
      };
    if (path === '/containers/bind-holder/json') throw new Error('unanswering engine');
    throw new Error(`Unexpected data access: ${path}`);
  });
  const stream = jest.fn();
  jest.spyOn(DockerEngineClient, 'connect').mockResolvedValue({
    connectedInfo: { Architecture: 'amd64' },
    json,
    stream,
  } as unknown as DockerEngineClient);
  jest.mocked(fs.stat).mockResolvedValue({} as never);
  const archives = { create: jest.fn() };
  const result = await new HostDockerService(archives as unknown as DockerArchiveJournal).scan(
    ['/home/state'],
    undefined,
    undefined,
    ['data'],
  );
  expect(json.mock.calls.map((c) => c[1])).toEqual([
    '/containers/json?all=true',
    '/volumes',
    '/containers/volume-holder/json',
    '/containers/bind-holder/json',
  ]);
  expect(result.containers[0].metadata).toEqual({
    created: '2026-09-01T00:00:00Z',
    startedAt: '2026-09-02T00:00:00Z',
    running: false,
  });
  expect(result.containers[1].metadata).toEqual({});
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
  expect(stream).not.toHaveBeenCalled();
  expect(archives.create).not.toHaveBeenCalled();
});

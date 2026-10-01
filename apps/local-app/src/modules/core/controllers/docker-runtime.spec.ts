// Unit layer bounds optional Docker probes and verifies the process-wide version cache.
import { EventEmitter } from 'node:events';

const mockExec = jest.fn();
const mockRead = jest.fn();
const mockStatfs = jest.fn();
const mockStat = jest.fn();
const mockRequest = jest.fn();
jest.mock('node:child_process', () => ({ execFile: (...args: unknown[]) => mockExec(...args) }));
jest.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => mockRead(...args),
  statfs: (...args: unknown[]) => mockStatfs(...args),
  stat: (...args: unknown[]) => mockStat(...args),
}));
const mockResolveSocket = jest.fn().mockResolvedValue('/resolved/docker.sock');
jest.mock('./docker-engine.client', () => ({
  ...jest.requireActual('./docker-engine.client'),
  resolveDockerSocket: () => mockResolveSocket(),
}));
jest.mock('node:http', () => ({ request: (...args: unknown[]) => mockRequest(...args) }));

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  mockExec.mockImplementation((_command, args, _options, callback) =>
    callback(null, args[0] === 'compose' ? '2.40\n' : 'Docker version 29.0, build abc\n'),
  );
  mockRead.mockImplementation(async (path) =>
    path === '/etc/group' ? 'docker:x:1234:alice\n' : 'root = "/images"',
  );
  mockStat.mockImplementation(async (path) => ({ dev: path === '/images' ? 22n : 11n }));
  mockStatfs.mockResolvedValue({ bavail: 12, bsize: 1024 });
  mockRequest.mockImplementation((options, callback) => {
    const req = new EventEmitter() as EventEmitter & {
      end: () => void;
      destroy: (error: Error) => void;
    };
    req.destroy = (error) => {
      req.emit('error', error);
      req.emit('close');
    };
    req.end = () => {
      const response = Object.assign(new EventEmitter(), {
        setEncoding: jest.fn(),
        statusCode: 200,
      });
      callback(response);
      response.emit(
        'data',
        options.path === '/_ping'
          ? 'OK'
          : '{"DockerRootDir":"/var/lib/docker","Driver":"overlayfs","DriverStatus":[["driver-type","io.containerd.snapshotter.v1"]]}',
      );
      response.emit('end');
      req.emit('close');
    };
    return req;
  });
});
afterEach(() => jest.restoreAllMocks());

it('caches versions, polls only ping/info, and reads actual process groups', async () => {
  jest.spyOn(process, 'getgroups').mockReturnValue([1234]);
  const { readDockerRuntime } = await import('./docker-runtime');
  expect(await readDockerRuntime()).toEqual({
    installed: true,
    engineVersion: '29.0',
    composeVersion: '2.40',
    userInGroup: true,
    dataRootFreeBytes: 12288,
    capacity: {
      dockerRoot: { path: '/var/lib/docker', filesystemId: '11', freeBytes: 12288 },
      imageStore: { path: '/images', filesystemId: '22', freeBytes: 12288 },
      home: { path: expect.any(String), filesystemId: '11', freeBytes: 12288 },
    },
  });
  await readDockerRuntime();
  expect(mockExec).toHaveBeenCalledTimes(2);
  expect(mockRequest.mock.calls.map(([options]) => options.path)).toEqual([
    '/_ping',
    '/info',
    '/_ping',
    '/info',
  ]);
  expect(mockStatfs).toHaveBeenCalledTimes(6);
  expect(
    mockRequest.mock.calls.every(([options]) => options.socketPath === '/resolved/docker.sock'),
  ).toBe(true);
  jest.spyOn(process, 'getgroups').mockReturnValue([1001]);
  expect((await readDockerRuntime()).userInGroup).toBe(false);
});

it('reports an unreachable socket without rejecting runtime health', async () => {
  mockRequest.mockImplementation(() => {
    throw new Error('EACCES');
  });
  const { readDockerRuntime } = await import('./docker-runtime');
  await expect(readDockerRuntime()).resolves.toMatchObject({
    installed: false,
    dataRootFreeBytes: null,
  });
});

it('recovers socket availability without repeating version commands', async () => {
  const requestImpl = mockRequest.getMockImplementation();
  mockRequest.mockImplementationOnce(() => {
    throw new Error('ECONNREFUSED');
  });
  const { readDockerRuntime } = await import('./docker-runtime');
  expect((await readDockerRuntime()).installed).toBe(false);
  mockRequest.mockImplementation(requestImpl!);
  expect((await readDockerRuntime()).installed).toBe(true);
  expect(mockExec).toHaveBeenCalledTimes(2);
});

it('reports missing Compose as unavailable and tolerates inaccessible data roots', async () => {
  mockExec.mockImplementation((_command, args, _options, callback) =>
    callback(args[0] === 'compose' ? new Error('missing') : null, '29'),
  );
  mockStatfs.mockRejectedValue(new Error('EACCES'));
  const { readDockerRuntime } = await import('./docker-runtime');
  await expect(readDockerRuntime()).resolves.toMatchObject({
    installed: false,
    composeVersion: null,
    dataRootFreeBytes: null,
  });
});

it('reports partial capacity without failing runtime or inventing zero free bytes', async () => {
  mockStatfs.mockImplementation(async (path) => {
    if (path === '/images') throw new Error('EACCES');
    return { bavail: 2, bsize: 1024 };
  });
  const { readDockerRuntime } = await import('./docker-runtime');
  const result = await readDockerRuntime();
  expect(result.capacity?.imageStore).toBeNull();
  expect(result.capacity?.dockerRoot?.freeBytes).toBe(2048);
  expect(result.capacity?.home?.filesystemId).toBe(result.capacity?.dockerRoot?.filesystemId);
});

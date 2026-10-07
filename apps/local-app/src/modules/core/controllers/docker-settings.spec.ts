// Pure projection tests exercise the compatibility policy without an engine or framework.
import {
  CANNOT_MOVE_FIELDS,
  CONFIG_ALLOWLIST,
  HOST_CONFIG_ALLOWLIST,
  INSPECT_ONLY_FIELDS,
  DockerContainerInspect,
  projectDockerCreate,
} from './docker-settings';

const equalSettings = (actual: unknown, expected: unknown): boolean =>
  JSON.stringify(actual) === JSON.stringify(expected);

const inspect = (host: Record<string, unknown> = {}): DockerContainerInspect => ({
  Image: 'sha256:abc',
  Config: { Image: 'image:tag', Env: ['SECRET=value'], User: '1234:2345' },
  HostConfig: host,
});

it('preserves config at root, image identity, host settings and only network names/aliases', () => {
  const original = inspect({
    Binds: ['/project:/app:ro'],
    Mounts: [{ Type: 'volume', Source: 'db', Target: '/data' }],
    PortBindings: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '8000' }] },
    RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
    NetworkMode: 'project-net',
  });
  original.NetworkSettings = {
    Networks: {
      'project-net': {
        Aliases: ['db'],
        NetworkID: 'network-id',
        EndpointID: 'endpoint-id',
        IPAddress: '172.17.0.2',
        Gateway: '172.17.0.1',
        MacAddress: 'mac',
        DNSNames: ['generated'],
      },
    },
  };
  const projected = projectDockerCreate(original);
  expect(
    equalSettings(projected, {
      ...original.Config,
      Image: 'sha256:abc',
      HostConfig: original.HostConfig,
      NetworkingConfig: { EndpointsConfig: { 'project-net': { Aliases: ['db'] } } },
    }),
  ).toBe(true);
  expect(Object.keys(projected)).not.toContain('Config');
  expect(projected.HostConfig).not.toBe(original.HostConfig);
});

const configCases = {
  Hostname: 'service',
  Domainname: 'internal',
  User: '1234:2345',
  AttachStdin: true,
  AttachStdout: true,
  AttachStderr: true,
  ExposedPorts: { '8080/tcp': {} },
  Tty: true,
  OpenStdin: true,
  StdinOnce: true,
  Env: ['TOKEN=synthetic'],
  Cmd: ['sleep', '300'],
  Healthcheck: { Test: ['CMD', 'true'], Interval: 30000000000 },
  ArgsEscaped: false,
  Image: 'image:tag',
  Volumes: { '/data': {} },
  WorkingDir: '/app',
  Entrypoint: ['/entrypoint'],
  NetworkDisabled: false,
  OnBuild: ['RUN true'],
  Labels: { 'com.docker.compose.project': 'project' },
  StopSignal: 'SIGTERM',
  StopTimeout: 30,
  Shell: ['/bin/sh', '-c'],
};
const hostCases = {
  Binds: ['data:/data'],
  Mounts: [{ Type: 'volume', Source: 'data', Target: '/data' }],
  PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }] },
  RestartPolicy: { Name: 'always', MaximumRetryCount: 0 },
  NetworkMode: 'project-net',
  Privileged: true,
  LogConfig: { Type: 'json-file', Config: { 'max-size': '10m' } },
  AutoRemove: false,
  VolumeDriver: 'local',
  VolumesFrom: null,
  ConsoleSize: [40, 120],
  CapAdd: ['NET_ADMIN'],
  CapDrop: ['CHOWN'],
  Dns: ['1.1.1.1'],
  DnsOptions: ['ndots:1'],
  DnsSearch: ['internal'],
  ExtraHosts: ['service:127.0.0.1'],
  GroupAdd: ['2345'],
  OomScoreAdj: 100,
  ReadonlyRootfs: true,
  PublishAllPorts: true,
  ShmSize: 67108864,
  Sysctls: { 'net.ipv4.ip_forward': '1' },
  Tmpfs: { '/tmp': 'rw,size=64m' },
  Ulimits: [{ Name: 'nofile', Soft: 1024, Hard: 4096 }],
  Init: true,
  Isolation: 'default',
  MaskedPaths: ['/proc/kcore'],
  ReadonlyPaths: ['/proc/sys'],
  CgroupnsMode: 'private',
  CpuShares: 512,
  Memory: 268435456,
  NanoCpus: 1000000000,
  CpuPeriod: 100000,
  CpuQuota: 50000,
  CpuRealtimePeriod: 1000000,
  CpuRealtimeRuntime: 950000,
  CpusetCpus: '0-1',
  CpusetMems: '0',
  MemoryReservation: 134217728,
  MemorySwap: -1,
  MemorySwappiness: 10,
  OomKillDisable: true,
  PidsLimit: 128,
  StorageOpt: { size: '1G' },
  BlkioWeight: 500,
};
it('keeps reviewed allowlists aligned with realistic settings fixtures', () => {
  expect([...CONFIG_ALLOWLIST].sort()).toEqual(Object.keys(configCases).sort());
  expect([...HOST_CONFIG_ALLOWLIST].sort()).toEqual(Object.keys(hostCases).sort());
});
it.each(Object.entries(configCases))('preserves Config.%s', (field, value) => {
  const original = inspect();
  original.Config[field] = value;
  expect(
    equalSettings(projectDockerCreate(original)[field], field === 'Image' ? 'sha256:abc' : value),
  ).toBe(true);
});
it.each(Object.entries(hostCases))('preserves HostConfig.%s', (field, value) => {
  expect(
    (projectDockerCreate(inspect({ [field]: value })).HostConfig as Record<string, unknown>)[field],
  ).toEqual(value);
});
it('refuses volume dependencies that cannot be recreated by identity', () => {
  expect(() => projectDockerCreate(inspect({ VolumesFrom: ['other'] }))).toThrow(
    'unsupported setting HostConfig.VolumesFrom',
  );
});
it('preserves a false privileged setting without refusing the container', () => {
  expect(projectDockerCreate(inspect({ Privileged: false })).HostConfig).toEqual({
    Privileged: false,
  });
});

it.each(INSPECT_ONLY_FIELDS)('strips inspect-only %s', (field) => {
  const original = inspect();
  if (field === 'NetworkSettings') original.NetworkSettings = { Networks: {} };
  else original[field] = 'runtime-value';
  expect(Object.keys(projectDockerCreate(original))).not.toContain(field);
});

const triggers: Record<(typeof CANNOT_MOVE_FIELDS)[number], unknown> = {
  Devices: [{ PathOnHost: '/dev/null' }],
  Binds: ['/run/docker.sock:/socket:ro'],
  Mounts: [{ Type: 'bind', Source: '/var/run/docker.sock', Target: '/socket' }],
  NetworkMode: 'host',
  DeviceRequests: [{ Count: -1 }],
  PidMode: 'host',
  IpcMode: 'host',
  UsernsMode: 'host',
  Runtime: 'nvidia',
  CgroupParent: 'custom',
  SecurityOpt: ['seccomp=unconfined'],
  Links: ['other:db'],
};
it.each(CANNOT_MOVE_FIELDS)('refuses cannot-move trigger %s', (field) => {
  expect(() => projectDockerCreate(inspect({ [field]: triggers[field] }))).toThrow(
    'Container cannot move:',
  );
});
it.each(['container:abc'])('refuses network mode %s', (NetworkMode) => {
  expect(() => projectDockerCreate(inspect({ NetworkMode }))).toThrow('cannot move');
});
it('detects a nonstandard resolved Docker socket source', () => {
  expect(() =>
    projectDockerCreate(
      inspect({ Binds: ['/run/user/1000/engine.sock:/sock'] }),
      '/run/user/1000/engine.sock',
    ),
  ).toThrow('Docker socket');
});
it('allows default runtime and namespaces but refuses temporary containers', () => {
  expect(() =>
    projectDockerCreate(
      inspect({
        Runtime: 'runc',
        IpcMode: 'private',
        PidMode: '',
        UsernsMode: '',
        SecurityOpt: null,
        Devices: [],
        Privileged: false,
      }),
    ),
  ).not.toThrow();
  expect(() => projectDockerCreate(inspect({ AutoRemove: true }))).toThrow('temporary container');
});
it.each(['Config', 'HostConfig', 'root'] as const)(
  'refuses unknown active fields in %s without values',
  (where) => {
    const original = inspect();
    if (where === 'root') original.FutureSetting = 'secret-value';
    else original[where].FutureSetting = 'secret-value';
    expect(() => projectDockerCreate(original)).toThrow(
      `unsupported setting ${where === 'root' ? '' : `${where}.`}FutureSetting`,
    );
    try {
      projectDockerCreate(original);
    } catch (error) {
      expect(String(error)).not.toContain('secret-value');
    }
  },
);
it('preserves requested IPv4 addresses and aliases without generated addresses', () => {
  const original = inspect();
  const ipam = { IPv4Address: '10.0.0.3' };
  original.NetworkSettings = {
    Networks: { net: { Aliases: ['db'], IPAMConfig: ipam, IPAddress: '10.0.0.3' } },
  };
  const projected = projectDockerCreate(original);
  expect(projected.NetworkingConfig).toEqual({
    EndpointsConfig: { net: { Aliases: ['db'], IPAMConfig: ipam } },
  });
  const endpoints = (
    projected.NetworkingConfig as { EndpointsConfig: Record<string, { IPAMConfig: unknown }> }
  ).EndpointsConfig;
  expect(endpoints.net.IPAMConfig).not.toBe(ipam);
});
it.each([
  ['IPv6Address', 'fd00::3'],
  ['LinkLocalIPs', ['169.254.1.3']],
  ['FutureSetting', 'secret-value'],
])('refuses active IPAMConfig.%s by name', (field, value) => {
  const original = inspect();
  original.NetworkSettings = {
    Networks: { net: { IPAMConfig: { IPv4Address: '10.0.0.3', [field]: value } } },
  };
  expect(() => projectDockerCreate(original)).toThrow(
    `unsupported setting NetworkSettings.Networks.net.IPAMConfig.${field}`,
  );
});
it.each([{}, null, { IPv4Address: '', IPv6Address: '', LinkLocalIPs: [] }])(
  'keeps an empty IPAMConfig from requesting an address',
  (ipam) => {
    const original = inspect();
    original.NetworkSettings = { Networks: { net: { IPAMConfig: ipam } } };
    expect(projectDockerCreate(original).NetworkingConfig).toEqual({
      EndpointsConfig: { net: {} },
    });
  },
);
it('rejects nested unreviewed mount options', () => {
  expect(() =>
    projectDockerCreate(
      inspect({
        Mounts: [
          { Type: 'bind', Source: '/app', Target: '/app', BindOptions: { FutureOption: true } },
        ],
      }),
    ),
  ).toThrow('unsupported setting HostConfig.Mounts.BindOptions.FutureOption');
});

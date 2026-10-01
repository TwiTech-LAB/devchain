import { posix } from 'node:path';
import { DockerEngineError } from './docker-engine.client';

export type DockerSettings = Record<string, unknown>;
export interface DockerContainerInspect extends DockerSettings {
  Config: DockerSettings;
  HostConfig: DockerSettings;
  Image: string;
  NetworkSettings?: { Networks?: Record<string, DockerSettings> };
}

export const CONFIG_ALLOWLIST = [
  'Hostname',
  'Domainname',
  'User',
  'AttachStdin',
  'AttachStdout',
  'AttachStderr',
  'ExposedPorts',
  'Tty',
  'OpenStdin',
  'StdinOnce',
  'Env',
  'Cmd',
  'Healthcheck',
  'ArgsEscaped',
  'Image',
  'Volumes',
  'WorkingDir',
  'Entrypoint',
  'NetworkDisabled',
  'OnBuild',
  'Labels',
  'StopSignal',
  'StopTimeout',
  'Shell',
] as const;
export const HOST_CONFIG_ALLOWLIST = [
  'Binds',
  'Mounts',
  'PortBindings',
  'RestartPolicy',
  'NetworkMode',
  'LogConfig',
  'AutoRemove',
  'VolumeDriver',
  'VolumesFrom',
  'ConsoleSize',
  'CapAdd',
  'CapDrop',
  'Dns',
  'DnsOptions',
  'DnsSearch',
  'ExtraHosts',
  'GroupAdd',
  'OomScoreAdj',
  'ReadonlyRootfs',
  'PublishAllPorts',
  'ShmSize',
  'Sysctls',
  'Tmpfs',
  'Ulimits',
  'Init',
  'Isolation',
  'MaskedPaths',
  'ReadonlyPaths',
  'CgroupnsMode',
  'CpuShares',
  'Memory',
  'NanoCpus',
  'CpuPeriod',
  'CpuQuota',
  'CpuRealtimePeriod',
  'CpuRealtimeRuntime',
  'CpusetCpus',
  'CpusetMems',
  'MemoryReservation',
  'MemorySwap',
  'MemorySwappiness',
  'OomKillDisable',
  'PidsLimit',
  'StorageOpt',
  'BlkioWeight',
] as const;
export const CANNOT_MOVE_FIELDS = [
  'Devices',
  'Binds',
  'Mounts',
  'NetworkMode',
  'Privileged',
  'DeviceRequests',
  'PidMode',
  'IpcMode',
  'UsernsMode',
  'Runtime',
  'CgroupParent',
  'SecurityOpt',
  'Links',
] as const;
export const INSPECT_ONLY_FIELDS = [
  'Id',
  'Created',
  'State',
  'Path',
  'Args',
  'ResolvConfPath',
  'HostnamePath',
  'HostsPath',
  'LogPath',
  'GraphDriver',
  'Storage',
  'Mounts',
  'NetworkSettings',
  'Size',
  'SizeRw',
  'SizeRootFs',
  'Name',
  'RestartCount',
  'Driver',
  'Platform',
  'AppArmorProfile',
  'ProcessLabel',
  'MountLabel',
  'ExecIDs',
  'ImageManifestDescriptor',
] as const;

function set(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === '' || value === 0)
    return false;
  if (Array.isArray(value)) return value.some(set);
  if (typeof value === 'object') return Object.values(value).some(set);
  return true;
}
function unsupported(name: string): never {
  // Report field paths only; values may contain credentials.
  throw new DockerEngineError('unsupported', `unsupported setting ${name}`);
}
function object(value: unknown, name: string): DockerSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unsupported(name);
  return value as DockerSettings;
}
function checkFields(values: DockerSettings, allowed: readonly string[], prefix: string): void {
  for (const [key, value] of Object.entries(values)) {
    if (set(value) && !allowed.includes(key)) unsupported(`${prefix}${key}`);
  }
}
function cannotMove(field: string): never {
  throw new DockerEngineError('cannot-move', `Container cannot move: ${field}`);
}

function dockerSocket(path: unknown, socketPath: string): boolean {
  if (typeof path !== 'string') return false;
  const normalized = posix.normalize(path);
  return normalized === posix.normalize(socketPath) || posix.basename(normalized) === 'docker.sock';
}

/** Mount identities are preserved here; the import planner owns destination remapping. */
export function projectDockerCreate(
  inspect: DockerContainerInspect,
  socketPath = '/var/run/docker.sock',
): DockerSettings {
  checkFields(inspect, [...INSPECT_ONLY_FIELDS, 'Config', 'HostConfig', 'Image'], '');
  const config = object(inspect.Config, 'Config');
  const host = object(inspect.HostConfig, 'HostConfig');
  checkFields(config, CONFIG_ALLOWLIST, 'Config.');
  checkFields(host, [...HOST_CONFIG_ALLOWLIST, ...CANNOT_MOVE_FIELDS], 'HostConfig.');
  for (const field of [
    'Devices',
    'Privileged',
    'DeviceRequests',
    'CgroupParent',
    'SecurityOpt',
    'Links',
  ]) {
    if (set(host[field])) cannotMove(`HostConfig.${field}`);
  }
  if (host.NetworkMode === 'host' || String(host.NetworkMode).startsWith('container:'))
    cannotMove('HostConfig.NetworkMode');
  for (const field of ['PidMode', 'IpcMode', 'UsernsMode']) {
    if (host[field] === 'host') cannotMove(`HostConfig.${field}`);
    if (set(host[field]) && !['private', 'shareable'].includes(String(host[field])))
      unsupported(`HostConfig.${field}`);
  }
  if (set(host.Runtime) && host.Runtime !== 'runc') cannotMove('HostConfig.Runtime');
  if (set(host.VolumesFrom)) unsupported('HostConfig.VolumesFrom');
  if (host.CgroupnsMode === 'host') unsupported('HostConfig.CgroupnsMode');
  if (set(host.Isolation) && host.Isolation !== 'default') unsupported('HostConfig.Isolation');
  if (host.AutoRemove === true) cannotMove('HostConfig.AutoRemove (temporary container)');

  if (Array.isArray(host.Binds))
    for (const bind of host.Binds) {
      if (typeof bind !== 'string') unsupported('HostConfig.Binds');
      if (
        bind
          .split(':')
          .slice(0, 2)
          .some((path) => dockerSocket(path, socketPath))
      )
        cannotMove('HostConfig.Binds (Docker socket)');
    }
  if (Array.isArray(host.Mounts))
    for (const entry of host.Mounts) {
      const mount = object(entry, 'HostConfig.Mounts');
      checkFields(
        mount,
        [
          'Type',
          'Source',
          'Target',
          'ReadOnly',
          'Consistency',
          'BindOptions',
          'VolumeOptions',
          'TmpfsOptions',
        ],
        'HostConfig.Mounts.',
      );
      if (
        mount.Type === 'bind' &&
        (dockerSocket(mount.Source, socketPath) || dockerSocket(mount.Target, socketPath))
      )
        cannotMove('HostConfig.Mounts (Docker socket)');
      if (!['bind', 'volume', 'tmpfs'].includes(String(mount.Type)))
        unsupported('HostConfig.Mounts.Type');
      for (const [key, fields] of Object.entries({
        BindOptions: [
          'Propagation',
          'NonRecursive',
          'CreateMountpoint',
          'ReadOnlyNonRecursive',
          'ReadOnlyForceRecursive',
        ],
        VolumeOptions: ['NoCopy', 'Labels', 'Subpath', 'DriverConfig'],
        TmpfsOptions: ['SizeBytes', 'Mode', 'Options'],
      }))
        if (mount[key])
          checkFields(
            object(mount[key], `HostConfig.Mounts.${key}`),
            fields,
            `HostConfig.Mounts.${key}.`,
          );
    }
  for (const [key, fields] of Object.entries({
    RestartPolicy: ['Name', 'MaximumRetryCount'],
    LogConfig: ['Type', 'Config'],
  }))
    if (host[key])
      checkFields(object(host[key], `HostConfig.${key}`), fields, `HostConfig.${key}.`);
  if (config.Healthcheck)
    checkFields(
      object(config.Healthcheck, 'Config.Healthcheck'),
      ['Test', 'Interval', 'Timeout', 'Retries', 'StartPeriod', 'StartInterval'],
      'Config.Healthcheck.',
    );

  const endpoints: Record<string, { Aliases?: unknown }> = {};
  for (const [name, endpoint] of Object.entries(inspect.NetworkSettings?.Networks ?? {})) {
    // IPAMConfig is requested state, unlike generated IPAddress/Gateway. Do not silently lose it.
    checkFields(
      endpoint,
      [
        'Aliases',
        'IPAMConfig',
        'Links',
        'DriverOpts',
        'GwPriority',
        'NetworkID',
        'EndpointID',
        'Gateway',
        'IPAddress',
        'IPPrefixLen',
        'IPv6Gateway',
        'GlobalIPv6Address',
        'GlobalIPv6PrefixLen',
        'MacAddress',
        'DNSNames',
      ],
      `NetworkSettings.Networks.${name}.`,
    );
    for (const field of ['IPAMConfig', 'Links', 'DriverOpts', 'GwPriority'])
      if (set(endpoint[field])) unsupported(`NetworkSettings.Networks.${name}.${field}`);
    endpoints[name] =
      endpoint.Aliases == null ? {} : { Aliases: structuredClone(endpoint.Aliases) };
  }
  const projectedHost: DockerSettings = {};
  for (const key of new Set([
    ...HOST_CONFIG_ALLOWLIST,
    'PidMode',
    'IpcMode',
    'UsernsMode',
    'Runtime',
  ])) {
    if (host[key] !== undefined) projectedHost[key] = structuredClone(host[key]);
  }
  return {
    ...structuredClone(config),
    Image: inspect.Image,
    HostConfig: projectedHost,
    NetworkingConfig: { EndpointsConfig: endpoints },
  };
}

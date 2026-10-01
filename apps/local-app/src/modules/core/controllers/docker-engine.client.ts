import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { request, type ClientRequest } from 'node:http';
import { request as requestHttps } from 'node:https';
import type { PinnedTlsOptions } from '../../remotes/transport/remote-tls';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export type DockerErrorCode =
  | 'cannot-move'
  | 'unsupported'
  | 'incompatible-api'
  | 'unavailable'
  | 'cancelled'
  | 'not-found'
  | 'conflict'
  | 'engine-error'
  | 'invalid-response';

export class DockerEngineError extends Error {
  constructor(
    readonly code: DockerErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'DockerEngineError';
  }
}
export function isDockerNotFound(error: unknown): boolean {
  return error instanceof DockerEngineError && error.code === 'not-found';
}
/** The application error code for an engine failure, e.g. `DOCKER_NOT_FOUND`. */
export function dockerErrorCode(code: DockerErrorCode): string {
  return `DOCKER_${code.toUpperCase().replace(/-/g, '_')}`;
}

export interface DockerInfo {
  Architecture?: string;
  ID?: string;
  Driver: string;
  DriverStatus?: string[][];
  DockerRootDir: string;
  SecurityOptions?: string[];
  OperatingSystem?: string;
}
export interface DockerVersion {
  ApiVersion: string;
  MinAPIVersion: string;
}
export interface DockerDiskUsage {
  Volumes?: Array<{ Name: string; UsageData?: { Size: number; RefCount: number } }>;
  Images?: Array<{ Id: string; Size: number; SharedSize: number; Containers?: number }>;
  Containers?: Array<{ Id: string; SizeRw: number; SizeRootFs?: number }>;
  LayersSize?: number;
  BuildCache?: Array<{ ID: string; Size: number; Shared?: boolean }>;
}

function contextHost(): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    execFile(
      'docker',
      ['context', 'inspect'],
      { timeout: 3000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) return resolve(undefined);
        try {
          const contexts = JSON.parse(stdout);
          const host = contexts?.[0]?.Endpoints?.docker?.Host;
          if (typeof host !== 'string') throw new Error();
          resolve(host);
        } catch {
          reject(new DockerEngineError('unsupported', 'Invalid Docker context endpoint'));
        }
      },
    );
  });
}

// `docker context inspect` runs once per process, not per runtime poll or host Docker route:
// its environment cannot change in-process, and the Install Docker action restarts DevChain.
// Only an answer is kept; a failed or timed-out lookup is tried again next time.
let processContextHost: Promise<string | undefined> | undefined;

function cachedContextHost(): Promise<string | undefined> {
  processContextHost ??= contextHost().then(
    (host) => {
      if (host === undefined) processContextHost = undefined;
      return host;
    },
    (error: unknown) => {
      processContextHost = undefined;
      throw error;
    },
  );
  return processContextHost;
}

export async function resolveDockerSocket(
  options: {
    env?: NodeJS.ProcessEnv;
    inspectContext?: () => Promise<string | undefined>;
  } = {},
): Promise<string> {
  const inspectContext = options.inspectContext ?? cachedContextHost;
  const host = (options.env ?? process.env).DOCKER_HOST || (await inspectContext());
  if (!host) return '/var/run/docker.sock';
  if (host.startsWith('tcp://') || host.startsWith('ssh://')) {
    throw new DockerEngineError(
      'unsupported',
      'Docker tcp:// and ssh:// hosts are unsupported; use a local Unix socket',
    );
  }
  if (
    !host.startsWith('unix:///') ||
    host.includes('\0') ||
    host.includes('?') ||
    host.includes('#')
  ) {
    throw new DockerEngineError(
      'unsupported',
      'Docker requires an absolute unix:// socket endpoint',
    );
  }
  return host.slice('unix://'.length);
}

export function assertSupportedDocker(info: DockerInfo): void {
  if (info.SecurityOptions?.some((option) => /(?:^|[=,])rootless(?:$|,)/i.test(option))) {
    throw new DockerEngineError('unsupported', 'Rootless Docker engines are unsupported');
  }
  if (info.OperatingSystem?.includes('Docker Desktop')) {
    throw new DockerEngineError('unsupported', 'Docker Desktop engines are unsupported');
  }
}

export async function resolveDockerImageStore(
  info: DockerInfo,
  readConfig: () => Promise<string> = () => readFile('/etc/containerd/config.toml', 'utf8'),
): Promise<string> {
  if (
    info.DriverStatus?.some(
      ([key, value]) => key === 'driver-type' && value === 'io.containerd.snapshotter.v1',
    )
  ) {
    let config: string;
    try {
      config = await readConfig();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '/var/lib/containerd';
      throw new DockerEngineError(
        'unavailable',
        'Cannot read containerd image-store configuration',
      );
    }
    // Only a top-level root configures the daemon; plugin roots describe different stores.
    const topLevel = config.split(/^\s*\[/m)[0];
    const rootLine = topLevel.match(/^\s*root\s*=\s*(.*)$/m)?.[1];
    if (!rootLine) return '/var/lib/containerd';
    const root = rootLine.match(/^(?:"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$/);
    const path = root?.[1] ?? root?.[2];
    if (!path?.startsWith('/'))
      throw new DockerEngineError('unsupported', 'Unsupported containerd root configuration');
    return path;
  }
  if (info.Driver === 'overlay2' && info.DockerRootDir?.startsWith('/')) return info.DockerRootDir;
  throw new DockerEngineError('unsupported', 'Unsupported Docker image store');
}

function versionTuple(version: string): number[] {
  if (!/^\d+\.\d+$/.test(version))
    throw new DockerEngineError('invalid-response', 'Invalid Docker API version');
  return version.split('.').map(Number);
}
function compareVersions(a: string, b: string): number {
  const [am, an] = versionTuple(a);
  const [bm, bn] = versionTuple(b);
  return am - bm || an - bn;
}

export async function negotiateDockerApi(
  a: DockerEngineClient,
  b: DockerEngineClient,
  signal?: AbortSignal,
): Promise<string> {
  const [av, bv] = await Promise.all([a.version(signal), b.version(signal)]);
  const max = selectDockerApiVersion(av, bv);
  a.apiVersion = b.apiVersion = max;
  return max;
}

export function selectDockerApiVersion(av: DockerVersion, bv: DockerVersion): string {
  const max = compareVersions(av.ApiVersion, bv.ApiVersion) <= 0 ? av.ApiVersion : bv.ApiVersion;
  if (compareVersions(max, av.MinAPIVersion) < 0 || compareVersions(max, bv.MinAPIVersion) < 0) {
    throw new DockerEngineError(
      'incompatible-api',
      'Docker engines have no compatible API version',
    );
  }
  return max;
}

function transportError(signal?: AbortSignal): DockerEngineError {
  return signal?.aborted
    ? new DockerEngineError('cancelled', 'Docker request cancelled')
    : new DockerEngineError('unavailable', 'Docker engine connection failed');
}

export interface DockerRequestOptions {
  body?: Readable | Buffer | string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  unversioned?: boolean;
  /** Receives the response's HTTP trailers before the returned stream ends. */
  onTrailers?: (trailers: NodeJS.Dict<string>) => void;
}

/** No application dependencies, and no implicit header, body or socket deadline. */
export class DockerEngineClient {
  apiVersion?: string;
  /** The `/info` answer `connect()` read, so callers need not ask the engine again. */
  connectedInfo?: DockerInfo;
  constructor(
    readonly socketPath: string,
    private readonly baseUrl?: string,
    private readonly defaultHeaders: Record<string, string> = {},
    private readonly tls?: PinnedTlsOptions,
  ) {}

  /** A VM's Docker routes over HTTPS pinned to the VM certificate. */
  static forHttp(
    baseUrl: string,
    tls: PinnedTlsOptions,
    headers: Record<string, string> = {},
  ): DockerEngineClient {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:')
      throw new DockerEngineError('unsupported', 'Unsupported Docker transport protocol');
    return new DockerEngineClient('', baseUrl.replace(/\/+$/, ''), headers, tls);
  }

  static async connect(signal?: AbortSignal): Promise<DockerEngineClient> {
    const client = new DockerEngineClient(await resolveDockerSocket());
    client.connectedInfo = await client.info(signal);
    return client;
  }

  stream(method: string, path: string, options: DockerRequestOptions = {}): Promise<Readable> {
    return new Promise((resolve, reject) => {
      let output: PassThrough | undefined;
      let req: ClientRequest | undefined;
      let answered = false;
      const fail = () => {
        const error = transportError(options.signal);
        if (output) output.destroy(error);
        else reject(error);
      };
      try {
        const url = this.baseUrl ? new URL(this.baseUrl) : undefined;
        req = (url ? requestHttps : request)(
          {
            ...(url
              ? {
                  protocol: url.protocol,
                  hostname: url.hostname.replace(/^\[(.*)\]$/, '$1'),
                  port: url.port,
                  ...this.tls,
                }
              : { socketPath: this.socketPath }),
            method,
            path: `${url ? url.pathname.replace(/\/+$/, '') : ''}${!options.unversioned && this.apiVersion ? `/v${this.apiVersion}` : ''}${path}`,
            headers: { ...this.defaultHeaders, ...options.headers },
            signal: options.signal,
            agent: false,
            timeout: 0,
          },
          (res) => {
            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
              // Engine messages may echo create payloads (including Env); never decode or retain them.
              const status = res.statusCode;
              const code =
                status === 404 ? 'not-found' : status === 409 ? 'conflict' : 'engine-error';
              reject(
                new DockerEngineError(
                  code,
                  `Docker engine request failed (HTTP ${status ?? 0})`,
                  status,
                ),
              );
              res.destroy();
              if (options.body instanceof Readable) options.body.destroy();
              return;
            }
            answered = true;
            output = new PassThrough();
            res.on('error', fail);
            // Registered before the pipe, so the trailers are known when `output` ends.
            if (options.onTrailers) res.on('end', () => options.onTrailers!(res.trailers));
            output.on('close', () => {
              if (!res.complete) req?.destroy();
            });
            res.pipe(output);
            resolve(output);
          },
        );
        req.on('error', fail);
        if (options.body instanceof Readable) {
          // The engine answers an archive PUT once it reads the tar's end marker and may
          // close before the rest of the body arrives; a 2xx answer is the outcome.
          void pipeline(options.body, req).catch(() => {
            if (!answered) fail();
          });
        } else req.end(options.body);
      } catch {
        req?.destroy();
        if (options.body instanceof Readable) options.body.destroy();
        fail();
      }
    });
  }

  async json<T>(
    method: string,
    path: string,
    body?: unknown,
    options: Omit<DockerRequestOptions, 'body'> = {},
  ): Promise<T> {
    const stream = await this.stream(method, path, {
      ...options,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...options.headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) {
        stream.destroy();
        throw new DockerEngineError('invalid-response', 'Docker JSON response exceeds limit');
      }
      chunks.push(Buffer.from(chunk));
    }
    if (!bytes) return undefined as T;
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
    } catch {
      throw new DockerEngineError('invalid-response', 'Invalid Docker JSON response');
    }
  }

  async version(signal?: AbortSignal): Promise<DockerVersion> {
    const value = await this.json<DockerVersion>('GET', '/version', undefined, {
      signal,
      unversioned: true,
    });
    if (!value || typeof value.ApiVersion !== 'string' || typeof value.MinAPIVersion !== 'string')
      throw new DockerEngineError('invalid-response', 'Invalid Docker API version');
    versionTuple(value.ApiVersion);
    versionTuple(value.MinAPIVersion);
    return { ApiVersion: value.ApiVersion, MinAPIVersion: value.MinAPIVersion };
  }
  async info(signal?: AbortSignal): Promise<DockerInfo> {
    const info = await this.json<DockerInfo>('GET', '/info', undefined, { signal });
    assertSupportedDocker(info);
    return info;
  }
  diskUsage(signal?: AbortSignal): Promise<DockerDiskUsage> {
    return this.json('GET', '/system/df', undefined, { signal });
  }
}

/** A missing resource is `undefined`; every other failure is thrown. */
export async function optionalDockerJson<T>(
  client: DockerEngineClient,
  path: string,
  signal?: AbortSignal,
): Promise<T | undefined> {
  try {
    return await client.json<T>('GET', path, undefined, { signal });
  } catch (error) {
    if (isDockerNotFound(error)) return undefined;
    throw error;
  }
}

/** Starts or stops a container. 304: already in that state; 404: gone, such as a removed `--rm` one. */
export async function changeDockerContainerState(
  client: DockerEngineClient,
  id: string,
  action: 'start' | 'stop',
  signal?: AbortSignal,
): Promise<void> {
  try {
    await client.json('POST', `/containers/${encodeURIComponent(id)}/${action}`, undefined, {
      signal,
    });
  } catch (error) {
    if (!isDockerNotFound(error) && !(error instanceof DockerEngineError && error.status === 304))
      throw error;
  }
}

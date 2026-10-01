import { execFile } from 'node:child_process';
import { readFile, statfs, stat } from 'node:fs/promises';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { z } from 'zod';
import {
  assertSupportedDocker,
  resolveDockerSocket,
  resolveDockerImageStore,
  type DockerInfo,
} from './docker-engine.client';

export const DockerFilesystemSchema = z.object({
  path: z.string(),
  filesystemId: z.string(),
  freeBytes: z.number().nonnegative(),
});
export type DockerFilesystem = z.infer<typeof DockerFilesystemSchema>;

export const DockerRuntimeSchema = z.object({
  installed: z.boolean(),
  engineVersion: z.string().nullable(),
  composeVersion: z.string().nullable(),
  userInGroup: z.boolean(),
  dataRootFreeBytes: z.number().nonnegative().nullable(),
  capacity: z
    .object({
      dockerRoot: DockerFilesystemSchema.nullable(),
      imageStore: DockerFilesystemSchema.nullable(),
      home: DockerFilesystemSchema.nullable(),
    })
    .optional(),
});
export type DockerRuntime = z.infer<typeof DockerRuntimeSchema>;

const unavailable: DockerRuntime = {
  installed: false,
  engineVersion: null,
  composeVersion: null,
  userInGroup: false,
  dataRootFreeBytes: null,
};
let versions: Promise<{ engineVersion: string | null; composeVersion: string | null }> | undefined;

function version(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 750, maxBuffer: 64 * 1024 }, (error, stdout) => {
      resolve(error ? null : stdout.trim() || null);
    });
  });
}

function dockerGet(socketPath: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 1024 * 1024) req.destroy(new Error('Docker response too large'));
      });
      res.on('error', reject);
      res.on('end', () =>
        res.statusCode === 200 ? resolve(body) : reject(new Error('Docker unavailable')),
      );
    });
    const timeout = setTimeout(() => req.destroy(new Error('Docker timeout')), 750);
    req.on('close', () => clearTimeout(timeout));
    req.on('error', reject);
    req.end();
  });
}

/** Failures describe Docker only; they must never fail the runtime health endpoint. */
export async function readDockerRuntime(): Promise<DockerRuntime> {
  const result: DockerRuntime = {
    ...unavailable,
    capacity: { dockerRoot: null, imageStore: null, home: await dockerFilesystem(homedir()) },
  };
  try {
    versions ??= Promise.all([
      version('dockerd', ['--version']).then(
        (output) => output?.match(/Docker version ([^,\s]+)/)?.[1] ?? null,
      ),
      version('docker', ['compose', 'version', '--short']),
    ]).then(([engineVersion, composeVersion]) => ({ engineVersion, composeVersion }));
    Object.assign(result, await versions);
    const groups = await readFile('/etc/group', 'utf8');
    const gid = groups
      .split('\n')
      .find((line) => line.startsWith('docker:'))
      ?.split(':')[2];
    result.userInGroup = gid !== undefined && Boolean(process.getgroups?.().includes(Number(gid)));
    const socketPath = await resolveDockerSocket();
    if ((await dockerGet(socketPath, '/_ping')).trim() !== 'OK') return result;
    const info: DockerInfo = JSON.parse(await dockerGet(socketPath, '/info'));
    assertSupportedDocker(info);
    result.installed = Boolean(result.engineVersion && result.composeVersion);
    const parsed = z.object({ DockerRootDir: z.string().startsWith('/') }).safeParse(info);
    if (parsed.success) {
      result.capacity!.dockerRoot = await dockerFilesystem(parsed.data.DockerRootDir);
      result.dataRootFreeBytes = result.capacity!.dockerRoot?.freeBytes ?? null;
      try {
        const imageStore = await resolveDockerImageStore(info);
        // overlay2 stores images under DockerRootDir: one sample serves both.
        result.capacity!.imageStore =
          imageStore === parsed.data.DockerRootDir
            ? result.capacity!.dockerRoot
            : await dockerFilesystem(imageStore);
      } catch {
        /* Unknown stores remain unknown for fit checks. */
      }
    }
  } catch {
    /* Docker is optional, including access to its data directory. */
  }
  return result;
}

export async function dockerFilesystem(path: string): Promise<DockerFilesystem | null> {
  try {
    const [space, identity] = await Promise.all([statfs(path), stat(path, { bigint: true })]);
    return { path, filesystemId: identity.dev.toString(), freeBytes: space.bavail * space.bsize };
  } catch {
    return null;
  }
}

import { Inject, Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { getEnvConfig } from '../../../common/config/env.config';
import { getDbConfig } from '../../storage/db/db.config';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import {
  generateHostInstallBlock,
  type HostInstallBlockOptions,
  type HostInstallPins,
} from './host-install-block';

const SOURCE_PACK_TIMEOUT_MS = 120_000;

export interface HostInstallInputs {
  pins: HostInstallPins;
  bootstrapTgzBase64: string;
  bootstrapUnit: string;
  sysctlConfig: string;
  aptPreference: string;
}

export type HostInstallRenderOptions = Omit<
  HostInstallBlockOptions,
  keyof HostInstallInputs | 'pins'
>;

export interface HostInstallPaths {
  moduleDirectory: string;
  cwd: string;
  dataDirectory: string;
}

export const HOST_INSTALL_PATHS = Symbol('HOST_INSTALL_PATHS');

const HOST_INSTALL_FILES = [
  'devchain-host-bootstrap.tgz',
  'devchain-bootstrap.service',
  '60-devchain-inotify.conf',
  'devchain-no-session-bus.pref',
  'pins.json',
] as const;

function hasHostInstallFiles(directory: string): boolean {
  return HOST_INSTALL_FILES.every((file) => existsSync(join(directory, file)));
}

function ancestorDirectories(...starts: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const start of starts) {
    let current = resolve(start);
    while (!seen.has(current)) {
      seen.add(current);
      result.push(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return result;
}

export function findHostInstallDist(moduleDirectory: string): string | null {
  // Packed inputs belong to this server only when it runs from the same dist folder
  // (<package>/dist/server/...), whatever the install path contains (for example
  // ~/src/npm-global). A build output elsewhere, such as <repo>/dist in a source
  // checkout, is not this server's.
  const modulePath = resolve(moduleDirectory);
  for (const root of ancestorDirectories(modulePath)) {
    const dist = join(root, 'dist');
    if (!modulePath.startsWith(dist + sep)) continue;
    const directory = join(dist, 'host-install');
    if (hasHostInstallFiles(directory)) return directory;
  }
  return null;
}

function findRepositoryRoot(moduleDirectory: string, cwd: string): string | null {
  for (const root of ancestorDirectories(moduleDirectory, cwd)) {
    if (existsSync(join(root, 'apps/host-image/versions.env'))) return root;
  }
  return null;
}

export function parseVersionsEnv(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error(`Invalid host image version pin at line ${index + 1}`);
    values[match[1]] = match[2].trim().replace(/^("|')(.*)\1$/, '$2');
  }
  for (const name of ['NODE_VERSION', 'SYNCTHING_VERSION', 'NPM_REGISTRY']) {
    if (!values[name]) throw new Error(`Host image version pin ${name} is missing`);
  }
  return values;
}

export function parseAptPackages(contents: string): string[] {
  const lines = contents.split(/\r?\n/);
  const first = lines.findIndex((line) =>
    /^\s*apt-get\s+install\s+-y\s+--no-install-recommends(?:\s|\\|$)/.test(line),
  );
  if (first < 0) throw new Error('Host image apt package list is missing');

  const packages: string[] = [];
  for (let index = first; index < lines.length; index += 1) {
    let line = lines[index].replace(/\s+#.*$/, '').trim();
    const continued = line.endsWith('\\');
    if (continued) line = line.slice(0, -1).trim();
    if (index === first) {
      line = line.replace(/^apt-get\s+install\s+-y\s+--no-install-recommends/, '').trim();
    }
    packages.push(...line.split(/\s+/).filter((name) => name && !name.startsWith('-')));
    if (!continued) break;
  }
  if (packages.length === 0) throw new Error('Host image apt package list is empty');
  return packages;
}

@Injectable()
export class HostInstallService {
  private sourceInputsPromise: Promise<HostInstallInputs> | null = null;
  private readonly paths: HostInstallPaths;

  constructor(
    private readonly processExecutor: ProcessExecutor,
    @Optional() @Inject(HOST_INSTALL_PATHS) paths?: HostInstallPaths,
  ) {
    this.paths =
      paths ??
      ({
        moduleDirectory: __dirname,
        cwd: process.cwd(),
        dataDirectory: dirname(getDbConfig().dbPath),
      } satisfies HostInstallPaths);
  }

  async render(options: HostInstallRenderOptions): Promise<string> {
    const inputs = await this.loadInputs();
    const registry = getEnvConfig().HOST_NPM_REGISTRY;
    return generateHostInstallBlock({
      ...inputs,
      pins: { ...inputs.pins, ...(registry ? { npmRegistry: registry } : {}) },
      ...options,
    });
  }

  async loadInputs(): Promise<HostInstallInputs> {
    const distDirectory = findHostInstallDist(this.paths.moduleDirectory);
    if (distDirectory) return this.readInputs(distDirectory);

    const repositoryRoot = findRepositoryRoot(this.paths.moduleDirectory, this.paths.cwd);
    if (!repositoryRoot) {
      throw new Error('Host-install inputs are unavailable outside a source checkout');
    }
    if (!this.sourceInputsPromise) {
      this.sourceInputsPromise = this.packSourceInputs(repositoryRoot);
    }
    return this.sourceInputsPromise;
  }

  private async readInputs(directory: string): Promise<HostInstallInputs> {
    const [archive, unit, sysctl, aptPreference, pinsText] = await Promise.all([
      readFile(join(directory, 'devchain-host-bootstrap.tgz')),
      readFile(join(directory, 'devchain-bootstrap.service'), 'utf8'),
      readFile(join(directory, '60-devchain-inotify.conf'), 'utf8'),
      readFile(join(directory, 'devchain-no-session-bus.pref'), 'utf8'),
      readFile(join(directory, 'pins.json'), 'utf8'),
    ]);
    return {
      pins: JSON.parse(pinsText) as HostInstallPins,
      bootstrapTgzBase64: archive.toString('base64'),
      bootstrapUnit: unit,
      sysctlConfig: sysctl,
      aptPreference,
    };
  }

  private async packSourceInputs(repositoryRoot: string): Promise<HostInstallInputs> {
    const bootstrapRoot = join(repositoryRoot, 'apps/host-bootstrap');
    await mkdir(this.paths.dataDirectory, { recursive: true });

    const packageJson = JSON.parse(await readFile(join(bootstrapRoot, 'package.json'), 'utf8')) as {
      name?: unknown;
      version?: unknown;
    };
    if (typeof packageJson.name !== 'string' || typeof packageJson.version !== 'string') {
      throw new Error('Host bootstrap package metadata is incomplete');
    }

    const result = await this.processExecutor.run({
      argv: [
        'npm',
        'pack',
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        this.paths.dataDirectory,
      ],
      mode: 'pipe',
      cwd: bootstrapRoot,
      timeout: SOURCE_PACK_TIMEOUT_MS,
      outputLimits: { maxBytes: 1_000_000 },
    });
    if (!result.success || result.timedOut) {
      throw new Error(
        `Could not pack host bootstrap package: ${result.stderr || 'npm pack failed'}`,
      );
    }

    let packed: unknown;
    try {
      packed = JSON.parse(result.stdout);
    } catch {
      throw new Error('npm pack returned invalid JSON for the host bootstrap package');
    }
    const filename =
      Array.isArray(packed) && typeof packed[0] === 'object' && packed[0] !== null
        ? (packed[0] as { filename?: unknown }).filename
        : undefined;
    if (typeof filename !== 'string' || basename(filename) !== filename) {
      throw new Error('npm pack did not report a host bootstrap tarball');
    }

    const archive = await readFile(join(this.paths.dataDirectory, filename));
    const versions = parseVersionsEnv(
      await readFile(join(repositoryRoot, 'apps/host-image/versions.env'), 'utf8'),
    );
    const aptPackages = parseAptPackages(
      await readFile(join(repositoryRoot, 'apps/host-image/customize.sh'), 'utf8'),
    );
    const pins: HostInstallPins = {
      nodeVersion: versions.NODE_VERSION,
      syncthingVersion: versions.SYNCTHING_VERSION,
      npmRegistry: versions.NPM_REGISTRY,
      bootstrap: {
        package: packageJson.name,
        version: packageJson.version,
        sha256: createHash('sha256').update(archive).digest('hex'),
      },
      aptPackages,
    };
    return {
      pins,
      bootstrapTgzBase64: archive.toString('base64'),
      bootstrapUnit: await readFile(
        join(bootstrapRoot, 'systemd/devchain-bootstrap.service'),
        'utf8',
      ),
      sysctlConfig: await readFile(
        join(repositoryRoot, 'apps/host-image/files/60-devchain-inotify.conf'),
        'utf8',
      ),
      aptPreference: await readFile(
        join(repositoryRoot, 'apps/host-image/files/devchain-no-session-bus.pref'),
        'utf8',
      ),
    };
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { isAbsolute, resolve } from 'node:path';
import { FileSyncManagedExclusionsStore } from '../../file-sync/file-sync-managed-exclusions.store';
import { codeIgnores } from '../../file-sync/file-sync.dto';
import { FileSyncService } from '../../file-sync/file-sync.service';
import { firstMatch } from '../../file-sync/ignore-pattern-matcher';
import {
  ancestors,
  SyncRelativePathSchema,
  type SyncPathInspection,
} from '../../file-sync/sync-path-inspection.dto';
import { SyncPathInspector } from '../../file-sync/sync-path-inspector';
import { STORAGE_SERVICE, type ProjectStorage } from '../../storage/interfaces/storage.interface';
import { strictlyWithin, within } from '../docker/docker-plan-files';
import {
  DockerAvailabilityError,
  DockerPlanSourceService,
} from '../docker/docker-plan-source.service';
import { DockerImportInventoryStore } from '../operations/docker-import-inventory.store';
import { RemoteHostClient } from '../operations/remote-host.client';
import { REMOTE_HEALTH_PORT, type RemoteHealthPort } from '../ports/remote-health.port';
import type { ManagedExclusionReason, ManagedExclusionRow } from './remote-file-sync.dto';

type Side = 'home' | 'vm';
type MountSide = Side | 'compose';
interface Bind {
  name: string;
  source: string;
}
interface HomeContainer {
  Id: string;
  Names: string[];
  Mounts?: { Type: string; Source?: string }[];
}

function binds(
  name: string,
  mounts: readonly { type?: string; source?: string }[],
  directory?: string,
): Bind[] {
  return mounts.flatMap(({ type, source }) => {
    if (!type) throw new Error('Unknown mount type');
    if (type !== 'bind') return [];
    if (!source || (!directory && !isAbsolute(source))) throw new Error('Unknown bind source');
    return [{ name, source: directory ? resolve(directory, source) : source }];
  });
}

function ownership(
  inspection: SyncPathInspection,
  path: string,
  side: Side,
): ManagedExclusionReason | undefined {
  if (!inspection.exists && side === 'vm') return;
  const entry = inspection.entries.find((item) => item.path === path);
  if (!inspection.exists || !entry || entry.incomplete || inspection.hiddenPaths?.includes(path))
    return { kind: 'unchecked', cause: `${side}-inspection-incomplete` };
  if (entry.foreignOwners.length)
    return { kind: 'permissions', side, owners: entry.foreignOwners.map((owner) => owner.name) };
}

// Socket discovery and filesystem reads may stay pending even after the caller cancels.
async function boundedRead<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([cancelled, action()]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

@Injectable()
export class ManagedExclusionsCheckService {
  constructor(
    private readonly managed: FileSyncManagedExclusionsStore,
    private readonly inventory: DockerImportInventoryStore,
    @Inject(STORAGE_SERVICE) private readonly storage: ProjectStorage,
    @Inject(REMOTE_HEALTH_PORT) private readonly health: RemoteHealthPort,
    private readonly source: DockerPlanSourceService,
    private readonly host: RemoteHostClient,
    private readonly inspector: SyncPathInspector,
    private readonly files: FileSyncService,
  ) {}

  async evaluate(
    projectId: string,
    remoteId?: string,
    signal?: AbortSignal,
  ): Promise<ManagedExclusionRow[]> {
    const patterns = this.managed.get(projectId);
    if (!patterns.length) return [];
    const items = remoteId ? (this.inventory.get(projectId, remoteId)?.items ?? []) : [];
    const rows = patterns.map((pattern) => ({
      pattern,
      containers: items.filter((item) => item.bindPaths.includes(pattern)).map((item) => item.name),
    }));
    const unchecked = (cause: string): ManagedExclusionRow[] =>
      rows.map((row) => ({ ...row, status: 'stays', reason: { kind: 'unchecked', cause } }));
    if (!remoteId) return unchecked('not-connected');
    const health = this.health.getState(remoteId);
    if (health.apiKeyRejected) return unchecked('api-key-rejected');
    if (!health.online) return unchecked('offline');
    if (!health.versionMatches) return unchecked('version-mismatch');

    const deadline = AbortSignal.timeout(120_000);
    const scanSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const { rootPath } = await this.storage.getProject(projectId);
    const reasons = new Map<string, ManagedExclusionReason>();
    for (const pattern of patterns) {
      if (!pattern.startsWith('/') || !SyncRelativePathSchema.safeParse(pattern.slice(1)).success)
        reasons.set(pattern, { kind: 'unchecked', cause: 'invalid-path' });
      // Literal filesystem checks cannot prove coverage of a glob or a rewritten ignore rule.
      else if (/[*?\[\]{}]/.test(pattern) || pattern !== pattern.trim().normalize('NFC'))
        reasons.set(pattern, { kind: 'unchecked', cause: 'nonliteral-pattern' });
    }

    const pending = () => patterns.filter((pattern) => !reasons.has(pattern));
    for (const side of ['home', 'vm', 'compose'] as const) {
      const candidates = pending();
      if (!candidates.length) break;
      try {
        const mounted = await boundedRead(scanSignal, () =>
          this.mountedBinds(side, rootPath, remoteId, scanSignal),
        );
        const sources = mounted.filter((bind) => strictlyWithin(rootPath, bind.source));
        for (const pattern of candidates) {
          const folder = resolve(rootPath, pattern.slice(1));
          const holder = sources.find(
            ({ source }) => within(folder, source) || within(source, folder),
          );
          if (holder) reasons.set(pattern, { kind: 'docker', side, name: holder.name });
        }
      } catch {
        for (const pattern of candidates)
          reasons.set(pattern, { kind: 'unchecked', cause: `${side}-mounts-unavailable` });
      }
    }

    for (const pattern of pending()) {
      const reason = await this.checkOwners(rootPath, pattern.slice(1), remoteId, scanSignal);
      if (reason) reasons.set(pattern, reason);
    }

    // Removing a managed folder also clears the exclusion records beneath it.
    const retained = [...reasons.keys()];
    for (const pattern of pending().sort((a, b) => a.length - b.length)) {
      const parent = ancestors(pattern.slice(1))
        .reverse()
        .map((path) => '/' + path)
        .find((path) => reasons.has(path));
      if (parent) reasons.set(pattern, { kind: 'covered', by: parent });
      else if (retained.some((child) => child.startsWith(pattern + '/')))
        reasons.set(pattern, { kind: 'unchecked', cause: 'retained-descendant' });
    }
    const installed = codeIgnores(
      patterns.filter((pattern) => reasons.has(pattern)),
      this.files.getIgnores(projectId),
    );
    return rows.map((row) => {
      const reason = reasons.get(row.pattern);
      if (reason) return { ...row, status: 'stays', reason };
      const match = firstMatch(installed, row.pattern.slice(1));
      return {
        ...row,
        status: 'will-remove',
        ...(match.kind === 'matched' && match.ignored && { remainingRule: installed[match.index] }),
      };
    });
  }

  private async checkOwners(
    root: string,
    path: string,
    remoteId: string,
    signal: AbortSignal,
  ): Promise<ManagedExclusionReason | undefined> {
    for (const side of ['home', 'vm'] as const) {
      try {
        const result = await boundedRead(signal, () =>
          side === 'home'
            ? this.inspector.inspect(root, false, [path], undefined, undefined, {
                signal,
                requestedTreesOnly: true,
              })
            : this.host.syncInspect(
                remoteId,
                { path: root, scan: false, paths: [path], requestedTreesOnly: true },
                signal,
              ),
        );
        const reason = ownership(result, path, side);
        if (reason) return reason;
      } catch {
        return { kind: 'unchecked', cause: `${side}-inspection-unavailable` };
      }
    }
  }

  private async mountedBinds(
    side: MountSide,
    root: string,
    remoteId: string,
    signal: AbortSignal,
  ): Promise<Bind[]> {
    if (side === 'compose') {
      const config = await this.source.compose(root, { allProfiles: true, strict: true, signal });
      return Object.entries(config?.services ?? {}).flatMap(([name, service]) =>
        binds(name, service.volumes ?? [], root),
      );
    }
    if (side === 'vm') {
      const { containers } = await this.host.dockerScan(remoteId, [], { signal });
      return containers.flatMap((container) => binds(container.name, container.mounts));
    }
    try {
      const client = await this.source.connect(signal);
      signal.throwIfAborted();
      const containers = await client.json<HomeContainer[]>(
        'GET',
        '/containers/json?all=true',
        undefined,
        { signal },
      );
      return containers.flatMap((container) =>
        binds(
          container.Names[0]?.replace(/^\//, '') ?? container.Id,
          (container.Mounts ?? []).map((mount) => ({ type: mount.Type, source: mount.Source })),
        ),
      );
    } catch (error) {
      if (error instanceof DockerAvailabilityError && error.reason === 'no-socket') return [];
      throw error;
    }
  }
}

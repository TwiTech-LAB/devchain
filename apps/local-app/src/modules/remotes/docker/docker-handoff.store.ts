import type { DockerImportInventory } from '../operations/docker-import-inventory.store';
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  DockerPlanItem,
  DockerSelectionMode,
  DockerDataGroup,
  DockerDataState,
} from './docker-plan.dto';

export interface DockerHandoffItem {
  id: string;
  name: string;
  kind: DockerPlanItem['kind'];
  mode: DockerSelectionMode;
  temporary: boolean;
  targetAction: DockerPlanItem['targetAction'];
  /** A VM container is created from captured settings. */
  createsContainer: boolean;
  imageIds: string[];
  volumes: string[];
  /** Absolute bind sources whose data this item copies. */
  binds: string[];
  sizeBytes: number | null;
}
export interface DockerHandoffVolume {
  name: string;
  /** The image the never-started archive helpers run on both engines. */
  helperImage: string;
  sizeBytes: number;
}
export interface DockerHandoffBind {
  path: string;
  /** In-project data subtrees are emptied on the VM before restore. */
  replace: boolean;
  helperImage: string;
  sizeBytes: number;
}
export interface DockerHandoffNetwork {
  name: string;
  labels: Record<string, string>;
  internal: boolean;
  attachable: boolean;
  options: Record<string, string>;
}

/**
 * What one Connect's Docker steps decided and did. Secret-free by design: it
 * is written after every VM or home change, so retry and cancel act on what
 * really happened even after a crash. Settings with Env live apart (0600).
 */
export interface DockerHandoffRecord {
  inventoryBefore?: DockerImportInventory | null;
  dataGroups?: DockerDataGroup[];
  keptGroups?: DockerDataGroup[];
  discardedHomeGroups?: DockerDataGroup[];
  keptInventory?: DockerImportInventory['items'];
  ensureVolumes?: string[];
  ensureBinds?: string[];
  copiedData?: { volumes: string[]; binds: string[] };
  inventoryStampedAt?: string;
  apiVersion: string;
  projectRoot: string;
  items: DockerHandoffItem[];
  images: Array<{ id: string; sizeBytes: number }>;
  volumes: DockerHandoffVolume[];
  binds: DockerHandoffBind[];
  /** Home containers to stop: the selected ones and their writer groups. */
  stopIds: string[];
  /** Home containers this operation stopped while they ran; `name` identifies a failed restart. */
  stopped: Array<{ id: string; temporary: boolean; name?: string }>;
  networks: DockerHandoffNetwork[];
  verified: { images: string[]; volumes: string[]; binds: string[]; containers: string[] };
  /**
   * VM resources this attempt may have created. Volumes and containers are recorded
   * before their create call; a network only once the VM answered that it created it.
   */
  created: { volumes: string[]; networks: string[]; containers: string[] };
  /** Previously imported VM volumes this attempt deleted; a cancel cannot bring them back. */
  replaced: string[];
  bytesTotal: number;
}
/** One data group a Disconnect's copy-back decided on, once, from the change check. */
export interface DockerCopyBackGroup {
  /** `dockerDataGroupKey` of the group's members. */
  key: string;
  /** The group's item names, for messages. */
  label: string;
  state: DockerDataState;
  action: 'copy-home' | 'keep-home' | 'skip';
  /** The members to copy: those present on the VM. */
  volumes: string[];
  bindPaths: string[];
  /** Image IDs of the group's items; the helpers run one present on each engine. */
  images: string[];
  sizeBytes: number;
}
/** What one Disconnect's copy-back decided and did; written before each home change. */
export interface DockerCopyBackRecord {
  apiVersion: string;
  groups: DockerCopyBackGroup[];
  /** Home containers of the project: linked to it, or imported at Connect. */
  projectContainers: string[];
  /** Groups whose home data may have been emptied; recorded before the first clear. */
  started: string[];
  /** Verified groups: the members copied and the time of their inventory stamp. */
  verified: Record<string, { at: string; volumes: string[]; bindPaths: string[] }>;
  /** Groups to copy that had nothing on the VM. */
  absent: string[];
  /** When "Keep home data" choices were applied to the inventory. */
  keptAt?: string;
  /**
   * Taken just before the change check that decided the actions. A home holder
   * created or started later is a change the decision never saw.
   */
  decidedAt: string;
}
export interface DockerCapturedContainer {
  name: string;
  config: Record<string, unknown>;
}

@Injectable()
export class DockerHandoffStore {
  readonly directory: string;

  constructor(dataDirectory = process.env.DB_PATH || join(homedir(), '.devchain')) {
    this.directory = join(dataDirectory, 'docker-operations');
  }

  async read(operationId: string): Promise<DockerHandoffRecord | null> {
    return this.readJson(this.path(operationId, 'record'));
  }
  async write(operationId: string, record: DockerHandoffRecord): Promise<void> {
    await this.writeJson(this.path(operationId, 'record'), record);
  }
  async readSettings(operationId: string): Promise<Record<string, DockerCapturedContainer>> {
    return (await this.readJson(this.path(operationId, 'settings'))) ?? {};
  }
  async writeSettings(
    operationId: string,
    settings: Record<string, DockerCapturedContainer>,
  ): Promise<void> {
    await this.writeJson(this.path(operationId, 'settings'), settings);
  }
  async removeSettings(operationId: string): Promise<void> {
    await rm(this.path(operationId, 'settings'), { force: true });
  }
  async readCopyBack(operationId: string): Promise<DockerCopyBackRecord | null> {
    return this.readJson(this.path(operationId, 'copy-back'));
  }
  async writeCopyBack(operationId: string, record: DockerCopyBackRecord): Promise<void> {
    await this.writeJson(this.path(operationId, 'copy-back'), record);
  }
  async remove(operationId: string): Promise<void> {
    await this.removeSettings(operationId);
    await rm(this.path(operationId, 'copy-back'), { force: true });
    await rm(this.path(operationId, 'record'), { force: true });
  }

  private path(operationId: string, kind: 'record' | 'settings' | 'copy-back'): string {
    if (!/^[0-9a-zA-Z-]+$/.test(operationId)) throw new Error('Invalid operation id');
    return join(this.directory, `${operationId}.${kind}.json`);
  }
  private async readJson<T>(path: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('Docker operation record is unreadable');
    }
  }
  /** Atomic and owner-only: a crash leaves the old or the new file, never a torn one. */
  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type Database from 'better-sqlite3';
import { NotFoundError, ValidationError } from '../../../common/errors/error-types';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { DEFAULT_PROJECT_WORKSPACE_ID } from '../../storage/db/schema';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import { TransactionRunner } from '../../storage/db/transaction-runner';
import {
  PAIRED_DEVICE_WORKSPACE_ACCESS_REVOKED_EVENT,
  type PairedDeviceWorkspaceAccessRevokedEvent,
} from '../events/paired-device-workspace-access.events';
import { E2eeDeviceStoreService } from './e2ee-device-store.service';

export interface PairedDeviceWorkspaceAccess {
  readonly kid: string;
  /** False means the legacy/new-device implicit Default-only policy is active. */
  readonly explicit: boolean;
  /** The effective access subset, whether implicit or explicitly persisted. */
  readonly workspaceIds: string[];
}

/**
 * The ONE workspace-access predicate. Shared by RPC authorization
 * (`MobileRpcWorkspaceAccessService.assertWorkspaceAllowed`) and notification
 * recipient enumeration (`NotificationRecipientResolverService`) so implicit
 * Default-only and explicit-grant semantics can never diverge between the two
 * callers. Pure — takes the resolved access snapshot, not a kid.
 */
export function canAccessWorkspace(
  access: Pick<PairedDeviceWorkspaceAccess, 'workspaceIds'>,
  workspaceId: string,
): boolean {
  return access.workspaceIds.includes(workspaceId);
}

@Injectable()
export class PairedDeviceWorkspaceAccessService {
  private readonly sqlite: Database.Database;
  private readonly transactionRunner: TransactionRunner;

  constructor(
    @Inject(DB_CONNECTION) db: BetterSQLite3Database,
    private readonly devices: E2eeDeviceStoreService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.sqlite = getRawSqliteClient(db);
    this.transactionRunner = new TransactionRunner(this.sqlite);
  }

  getAccess(kid: string): PairedDeviceWorkspaceAccess {
    this.assertKnownDevice(kid);
    return this.readAccess(kid);
  }

  async updateAccess(kid: string, workspaceIds: string[]): Promise<PairedDeviceWorkspaceAccess> {
    if (workspaceIds.length === 0) {
      throw new ValidationError('At least one workspace must remain accessible');
    }
    if (new Set(workspaceIds).size !== workspaceIds.length) {
      throw new ValidationError('workspaceIds must not contain duplicates');
    }

    const { result, removedWorkspaceIds } = await this.transactionRunner.runImmediateQueued(() => {
      this.assertKnownDevice(kid);
      const rows = this.sqlite.prepare('SELECT id FROM project_workspaces').all() as Array<{
        id: string;
      }>;
      const known = new Set(rows.map((row) => row.id));
      const unknown = workspaceIds.find((workspaceId) => !known.has(workspaceId));
      if (unknown !== undefined) {
        throw new NotFoundError('Project workspace', unknown);
      }

      const previous = this.readAccess(kid).workspaceIds;
      this.sqlite
        .prepare('DELETE FROM paired_device_workspace_grants WHERE device_kid = ?')
        .run(kid);
      const insert = this.sqlite.prepare(
        'INSERT INTO paired_device_workspace_grants (device_kid, workspace_id) VALUES (?, ?)',
      );
      for (const workspaceId of workspaceIds) insert.run(kid, workspaceId);

      const selected = new Set(workspaceIds);
      return {
        result: { kid, explicit: true, workspaceIds: [...workspaceIds] },
        removedWorkspaceIds: previous.filter((workspaceId) => !selected.has(workspaceId)),
      };
    });

    if (removedWorkspaceIds.length > 0) {
      const event: PairedDeviceWorkspaceAccessRevokedEvent = {
        deviceKid: kid,
        reason: 'workspace-access-updated',
        workspaceIds: removedWorkspaceIds,
      };
      this.eventEmitter.emit(PAIRED_DEVICE_WORKSPACE_ACCESS_REVOKED_EVENT, event);
    }
    return result;
  }

  private assertKnownDevice(kid: string): void {
    if (!this.devices.get(kid)) throw new NotFoundError('E2EE device', kid);
  }

  private readAccess(kid: string): PairedDeviceWorkspaceAccess {
    const rows = this.sqlite
      .prepare(
        `SELECT grant_row.workspace_id AS workspaceId
         FROM paired_device_workspace_grants grant_row
         INNER JOIN project_workspaces workspace ON workspace.id = grant_row.workspace_id
         WHERE grant_row.device_kid = ?
         ORDER BY workspace.position, workspace.id`,
      )
      .all(kid) as Array<{ workspaceId: string }>;
    if (rows.length === 0) {
      return { kid, explicit: false, workspaceIds: [DEFAULT_PROJECT_WORKSPACE_ID] };
    }
    return { kid, explicit: true, workspaceIds: rows.map((row) => row.workspaceId) };
  }
}

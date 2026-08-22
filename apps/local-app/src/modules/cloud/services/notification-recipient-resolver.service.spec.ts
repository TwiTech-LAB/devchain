// Module-unit with REAL :memory: SQLite for the paired-device directory + workspace
// grants (the access semantics under test are SQL-backed); the project lookup is
// stubbed because only `.workspaceId` is consumed. This is the cheapest reliable layer
// for the event-time enumeration logic — the bridge integration spec covers the
// end-to-end gate.
import Database from 'better-sqlite3';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { NotFoundError } from '../../../common/errors/error-types';
import { DEFAULT_PROJECT_WORKSPACE_ID } from '../../storage/db/schema';
import { E2eeDeviceStoreService } from '../../e2ee/services/e2ee-device-store.service';
import {
  PairedDeviceWorkspaceAccessService,
  canAccessWorkspace,
} from '../../e2ee/services/paired-device-workspace-access.service';
import { NotificationRecipientResolverService } from './notification-recipient-resolver.service';

const SECOND_WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const ROUTING_A = 'a'.repeat(43);
const ROUTING_B = 'b'.repeat(43);
const TS = '2026-08-22T00:00:00.000Z';

const pub = (fill: number) => Buffer.from(new Uint8Array(32).fill(fill)).toString('base64');

describe('NotificationRecipientResolverService', () => {
  let sqlite: Database.Database;
  let deviceStore: E2eeDeviceStoreService;
  let deviceAccess: PairedDeviceWorkspaceAccessService;
  let resolver: NotificationRecipientResolverService;
  let workspaceByProject: Map<string, string>;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE settings (
        id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, value TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE project_workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, is_default INTEGER NOT NULL,
        position INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE paired_device_workspace_grants (
        device_kid TEXT NOT NULL, workspace_id TEXT NOT NULL,
        PRIMARY KEY (device_kid, workspace_id),
        FOREIGN KEY (workspace_id) REFERENCES project_workspaces(id) ON DELETE CASCADE
      );
    `);
    const insertWorkspace = sqlite.prepare(
      `INSERT INTO project_workspaces
       (id, name, is_default, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insertWorkspace.run(DEFAULT_PROJECT_WORKSPACE_ID, 'Default', 1, 0, TS, TS);
    insertWorkspace.run(SECOND_WORKSPACE_ID, 'Second', 0, 1, TS, TS);

    const db = drizzle(sqlite);
    deviceStore = new E2eeDeviceStoreService(db);
    deviceAccess = new PairedDeviceWorkspaceAccessService(db, deviceStore, new EventEmitter2());

    workspaceByProject = new Map([
      ['proj-default', DEFAULT_PROJECT_WORKSPACE_ID],
      ['proj-second', SECOND_WORKSPACE_ID],
    ]);
    const storageStub = {
      getProject: async (projectId: string) => {
        const workspaceId = workspaceByProject.get(projectId);
        if (workspaceId === undefined) throw new NotFoundError('Project', projectId);
        return { id: projectId, workspaceId };
      },
    };

    resolver = new NotificationRecipientResolverService(
      storageStub as never,
      deviceStore,
      deviceAccess,
    );
  });

  afterEach(() => {
    sqlite.close();
  });

  function addDevice(kid: string, routingKid?: string): void {
    deviceStore.add({ kid, publicKeyB64: pub(kid.length) });
    if (routingKid) deviceStore.setNotificationRoutingKid(kid, routingKid);
  }

  it('includes a bound device with implicit Default-only access for a Default-workspace project', async () => {
    addDevice('kid-a', ROUTING_A); // no explicit grants → implicit Default-only

    await expect(resolver.resolveProjectRecipientRoutingKids('proj-default')).resolves.toEqual([
      ROUTING_A,
    ]);
    await expect(resolver.resolveProjectRecipientRoutingKids('proj-second')).resolves.toEqual([]);
  });

  it('honors explicit workspace grants through the same shared predicate', async () => {
    addDevice('kid-b', ROUTING_B);
    deviceAccess.updateAccess('kid-b', [SECOND_WORKSPACE_ID]);

    await expect(resolver.resolveProjectRecipientRoutingKids('proj-second')).resolves.toEqual([
      ROUTING_B,
    ]);
    await expect(resolver.resolveProjectRecipientRoutingKids('proj-default')).resolves.toEqual([]);
  });

  it('never includes a device without a bound routing kid, even with workspace access', async () => {
    addDevice('kid-c'); // access but NO routing kid bound

    await expect(resolver.resolveProjectRecipientRoutingKids('proj-default')).resolves.toEqual([]);
  });

  it('returns distinct target sets for two phones with different grants', async () => {
    addDevice('kid-a', ROUTING_A); // implicit Default
    addDevice('kid-b', ROUTING_B);
    deviceAccess.updateAccess('kid-b', [SECOND_WORKSPACE_ID]);

    await expect(resolver.resolveProjectRecipientRoutingKids('proj-default')).resolves.toEqual([
      ROUTING_A,
    ]);
    await expect(resolver.resolveProjectRecipientRoutingKids('proj-second')).resolves.toEqual([
      ROUTING_B,
    ]);
  });

  it('deduplicates one routing kid shared by two device rows', async () => {
    addDevice('kid-a', ROUTING_A);
    addDevice('kid-a2', ROUTING_A); // same install re-adopted: same routing kid

    await expect(resolver.resolveProjectRecipientRoutingKids('proj-default')).resolves.toEqual([
      ROUTING_A,
    ]);
  });

  it('returns [] for an unknown (deleted) project — caller must not enqueue', async () => {
    addDevice('kid-a', ROUTING_A);

    await expect(resolver.resolveProjectRecipientRoutingKids('missing')).resolves.toEqual([]);
  });

  it('grant revocation changes only FUTURE snapshots (next resolution excludes the device)', async () => {
    addDevice('kid-b', ROUTING_B);
    deviceAccess.updateAccess('kid-b', [DEFAULT_PROJECT_WORKSPACE_ID, SECOND_WORKSPACE_ID]);
    await expect(resolver.resolveProjectRecipientRoutingKids('proj-second')).resolves.toEqual([
      ROUTING_B,
    ]);

    await deviceAccess.updateAccess('kid-b', [DEFAULT_PROJECT_WORKSPACE_ID]);
    await expect(resolver.resolveProjectRecipientRoutingKids('proj-second')).resolves.toEqual([]);
    // The Default-workspace project is unaffected.
    await expect(resolver.resolveProjectRecipientRoutingKids('proj-default')).resolves.toEqual([
      ROUTING_B,
    ]);
  });

  it('unpairing changes only FUTURE snapshots (next resolution excludes the device)', async () => {
    addDevice('kid-b', ROUTING_B);
    deviceAccess.updateAccess('kid-b', [SECOND_WORKSPACE_ID]);
    await expect(resolver.resolveProjectRecipientRoutingKids('proj-second')).resolves.toEqual([
      ROUTING_B,
    ]);

    deviceStore.revoke('kid-b');
    await expect(resolver.resolveProjectRecipientRoutingKids('proj-second')).resolves.toEqual([]);
  });

  it('a project move changes only FUTURE snapshots (same device, new workspace membership)', async () => {
    addDevice('kid-b', ROUTING_B);
    deviceAccess.updateAccess('kid-b', [DEFAULT_PROJECT_WORKSPACE_ID]);
    await expect(resolver.resolveProjectRecipientRoutingKids('proj-default')).resolves.toEqual([
      ROUTING_B,
    ]);

    // The project moves into the second workspace.
    workspaceByProject.set('proj-default', SECOND_WORKSPACE_ID);
    await expect(resolver.resolveProjectRecipientRoutingKids('proj-default')).resolves.toEqual([]);
  });

  it('exposes only routing kids — no paired-device records', async () => {
    addDevice('kid-a', ROUTING_A);
    const kids = await resolver.resolveProjectRecipientRoutingKids('proj-default');
    expect(kids.every((kid) => typeof kid === 'string')).toBe(true);
    expect(kids).not.toContain('kid-a');
  });

  it('the shared predicate is the one the RPC authorization path uses', () => {
    // Direct pin of the ONE predicate: implicit Default-only and explicit grants.
    expect(
      canAccessWorkspace(
        { workspaceIds: [DEFAULT_PROJECT_WORKSPACE_ID] },
        DEFAULT_PROJECT_WORKSPACE_ID,
      ),
    ).toBe(true);
    expect(
      canAccessWorkspace({ workspaceIds: [DEFAULT_PROJECT_WORKSPACE_ID] }, SECOND_WORKSPACE_ID),
    ).toBe(false);
    expect(
      canAccessWorkspace(
        { workspaceIds: [DEFAULT_PROJECT_WORKSPACE_ID, SECOND_WORKSPACE_ID] },
        SECOND_WORKSPACE_ID,
      ),
    ).toBe(true);
  });
});

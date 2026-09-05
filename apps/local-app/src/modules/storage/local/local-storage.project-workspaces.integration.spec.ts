import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { ConflictError, NotFoundError, ValidationError } from '../../../common/errors/error-types';
import { DEFAULT_PROJECT_WORKSPACE_ID } from '../db/schema';
import type { Project, ProjectWorkspace } from '../models/domain.models';
import { LocalStorageService } from './local-storage.service';

const MIGRATIONS_FOLDER = join(__dirname, '../../../../drizzle');

describe('LocalStorageService project workspaces', () => {
  let sqlite: Database.Database;
  let service: LocalStorageService;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    sqlite.pragma('foreign_keys = ON');
    service = new LocalStorageService(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  function projectInput(name: string, workspaceId?: string) {
    return {
      name,
      description: null,
      rootPath: `/tmp/${name.toLowerCase().replaceAll(' ', '-')}`,
      isTemplate: false,
      ...(workspaceId === undefined ? {} : { workspaceId }),
    };
  }

  async function createWorkspace(name: string): Promise<ProjectWorkspace> {
    return service.createProjectWorkspace(name);
  }

  function holdTransaction(): { held: Promise<void>; release: () => void } {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      held: service.runInTransaction(async () => gate),
      release,
    };
  }

  function grant(deviceKid: string, workspaceId: string): void {
    sqlite
      .prepare(
        'INSERT INTO paired_device_workspace_grants (device_kid, workspace_id) VALUES (?, ?)',
      )
      .run(deviceKid, workspaceId);
  }

  function projectWorkspaceId(projectId: string): string {
    return (
      sqlite.prepare('SELECT workspace_id FROM projects WHERE id = ?').get(projectId) as {
        workspace_id: string;
      }
    ).workspace_id;
  }

  function deviceGrants(deviceKid: string): string[] {
    return (
      sqlite
        .prepare(
          `SELECT workspace_id
           FROM paired_device_workspace_grants
           WHERE device_kid = ?
           ORDER BY workspace_id`,
        )
        .all(deviceKid) as Array<{ workspace_id: string }>
    ).map((row) => row.workspace_id);
  }

  it('creates, renames, counts, and deterministically orders workspaces', async () => {
    const defaultWorkspace = await service.getProjectWorkspace(DEFAULT_PROJECT_WORKSPACE_ID);
    expect(defaultWorkspace).toMatchObject({
      id: DEFAULT_PROJECT_WORKSPACE_ID,
      name: 'Default',
      isDefault: true,
      position: 0,
      projectCount: 0,
      deviceGrantCount: 0,
    });

    const engineering = await createWorkspace('  Engineering  ');
    const product = await createWorkspace('Product');
    expect(engineering).toMatchObject({ name: 'Engineering', isDefault: false, position: 1 });
    expect(product.position).toBe(2);
    await expect(createWorkspace('engineering')).rejects.toBeInstanceOf(ConflictError);
    await expect(createWorkspace(' '.repeat(2))).rejects.toBeInstanceOf(ValidationError);

    const renamedDefault = await service.renameProjectWorkspace(
      DEFAULT_PROJECT_WORKSPACE_ID,
      'Primary',
    );
    expect(renamedDefault).toMatchObject({ name: 'Primary', isDefault: true });

    const reordered = await service.reorderProjectWorkspaces([
      product.id,
      engineering.id,
      DEFAULT_PROJECT_WORKSPACE_ID,
    ]);
    expect(reordered.map(({ id, position }) => ({ id, position }))).toEqual([
      { id: product.id, position: 0 },
      { id: engineering.id, position: 1 },
      { id: DEFAULT_PROJECT_WORKSPACE_ID, position: 2 },
    ]);
  });

  it('rejects stale, incomplete, duplicate, and unknown reorder sets without partial writes', async () => {
    const engineering = await createWorkspace('Engineering');
    const original = await service.listProjectWorkspaces();

    await expect(
      service.reorderProjectWorkspaces([DEFAULT_PROJECT_WORKSPACE_ID]),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.reorderProjectWorkspaces([engineering.id, engineering.id]),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.reorderProjectWorkspaces([engineering.id, 'missing-workspace']),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(await service.listProjectWorkspaces()).toEqual(original);
  });

  it('defaults omitted membership, validates explicit membership, and maps all six read paths', async () => {
    const engineering = await createWorkspace('Engineering');
    const defaultProject = await service.createProject(projectInput('Default Project'));
    const explicitProject = await service.createProject(
      projectInput('Engineering Project', engineering.id),
    );
    const shellId = randomUUID();
    const shell = await service.runInTransaction(() =>
      service.createProjectShell(projectInput('Engineering Shell', engineering.id), {
        projectId: shellId,
      }),
    );

    expect(defaultProject.workspaceId).toBe(DEFAULT_PROJECT_WORKSPACE_ID);
    expect(explicitProject.workspaceId).toBe(engineering.id);
    expect(shell.workspaceId).toBe(engineering.id);
    await expect(service.createProject(projectInput('Unknown', 'missing'))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      service.createProjectShell(projectInput('Unknown Shell', 'missing')),
    ).rejects.toBeInstanceOf(NotFoundError);

    const mapped: Array<Project | null | undefined> = [
      await service.getProject(shell.id),
      await service.findProjectByPath(shell.rootPath),
      await service.getProjectByRootPath(shell.rootPath),
      await service.findProjectContainingPath(`${shell.rootPath}/nested/file.ts`),
      (await service.listProjects()).items.find((project) => project.id === shell.id),
      (await service.getProjectsByIdPrefix(shell.id.slice(0, 8))).find(
        (project) => project.id === shell.id,
      ),
    ];
    expect(mapped).toHaveLength(6);
    expect(mapped.every((project) => project?.workspaceId === engineering.id)).toBe(true);

    const listed = await service.listProjectWorkspaces();
    expect(
      listed.find((workspace) => workspace.id === DEFAULT_PROJECT_WORKSPACE_ID)?.projectCount,
    ).toBe(1);
    expect(listed.find((workspace) => workspace.id === engineering.id)?.projectCount).toBe(2);
  });

  it('filters project items and total by workspace membership', async () => {
    const engineering = await createWorkspace('Engineering');
    await service.createProject(projectInput('Default Project'));
    await service.createProject(projectInput('Engineering One', engineering.id));
    await service.createProject(projectInput('Engineering Two', engineering.id));

    const filtered = await service.listProjects({ workspaceId: engineering.id, limit: 1 });

    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0].workspaceId).toBe(engineering.id);
    expect(filtered.total).toBe(2);
  });

  it('validates and writes project membership through queued or joined admission', async () => {
    const engineering = await createWorkspace('Engineering');
    const project = await service.createProject(projectInput('Movable'));

    const moved = await service.updateProject(project.id, { workspaceId: engineering.id });
    expect(moved.workspaceId).toBe(engineering.id);
    await expect(
      service.updateProject(project.id, { workspaceId: 'unknown-workspace' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect((await service.getProject(project.id)).workspaceId).toBe(engineering.id);

    const shellId = randomUUID();
    await expect(
      service.runInTransaction(async () => {
        await service.createProjectShell(projectInput('Rolled Back Shell', engineering.id), {
          projectId: shellId,
        });
        throw new Error('rollback shell');
      }),
    ).rejects.toThrow('rollback shell');
    expect(sqlite.prepare('SELECT id FROM projects WHERE id = ?').get(shellId)).toBeUndefined();
  });

  it('rejects invalid deletes and atomically moves projects while deduplicating grants', async () => {
    const engineering = await createWorkspace('Engineering');
    const product = await createWorkspace('Product');
    const project = await service.createProject(
      projectInput('Engineering Project', engineering.id),
    );
    grant('device-a', DEFAULT_PROJECT_WORKSPACE_ID);
    grant('device-a', engineering.id);
    grant('device-b', engineering.id);
    grant('device-c', product.id);

    await expect(
      service.deleteProjectWorkspace(DEFAULT_PROJECT_WORKSPACE_ID, engineering.id),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(service.deleteProjectWorkspace(engineering.id, '')).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      service.deleteProjectWorkspace(engineering.id, engineering.id),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.deleteProjectWorkspace(engineering.id, 'missing-workspace'),
    ).rejects.toBeInstanceOf(NotFoundError);

    const deleted = await service.deleteProjectWorkspace(
      engineering.id,
      DEFAULT_PROJECT_WORKSPACE_ID,
    );
    expect(deleted).toEqual({ movedProjectCount: 1, remappedDeviceGrantCount: 2 });
    expect(projectWorkspaceId(project.id)).toBe(DEFAULT_PROJECT_WORKSPACE_ID);
    expect(deviceGrants('device-a')).toEqual([DEFAULT_PROJECT_WORKSPACE_ID]);
    expect(deviceGrants('device-b')).toEqual([DEFAULT_PROJECT_WORKSPACE_ID]);
    expect(deviceGrants('device-c')).toEqual([product.id]);
    await expect(service.getProjectWorkspace(engineering.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('rolls back project and grant moves when replacement-delete fails', async () => {
    const engineering = await createWorkspace('Engineering');
    const project = await service.createProject(
      projectInput('Engineering Project', engineering.id),
    );
    grant('device-a', engineering.id);
    sqlite.exec(`
      CREATE TRIGGER fail_workspace_delete
      BEFORE DELETE ON project_workspaces
      BEGIN
        SELECT RAISE(FAIL, 'injected workspace delete failure');
      END;
    `);

    await expect(
      service.deleteProjectWorkspace(engineering.id, DEFAULT_PROJECT_WORKSPACE_ID),
    ).rejects.toThrow('injected workspace delete failure');
    expect(projectWorkspaceId(project.id)).toBe(engineering.id);
    expect(deviceGrants('device-a')).toEqual([engineering.id]);
    await expect(service.getProjectWorkspace(engineering.id)).resolves.toMatchObject({
      id: engineering.id,
    });
  });

  it('returns the owning project and its whole workspace, ordered by project id', async () => {
    const engineering = await createWorkspace('Engineering');
    const product = await createWorkspace('Product');
    const owner = await service.createProject(projectInput('Owner', engineering.id));
    const peer = await service.createProject(projectInput('Peer', engineering.id));
    const template = await service.createProject({
      ...projectInput('Template', engineering.id),
      isTemplate: true,
    });
    await service.createProject(projectInput('Elsewhere', product.id));

    const snapshot = await service.getProjectWorkspaceSnapshot(owner.id);
    const ids = snapshot.map((project) => project.id);

    expect(new Set(ids)).toEqual(new Set([owner.id, peer.id, template.id]));
    expect(ids).toEqual([...ids].sort());
    expect(snapshot.every((project) => project.workspaceId === engineering.id)).toBe(true);
    expect(snapshot.find((project) => project.id === owner.id)).toMatchObject({
      name: 'Owner',
      isTemplate: false,
    });
    expect(snapshot.find((project) => project.id === template.id)?.isTemplate).toBe(true);
  });

  it('returns templates and more than one hundred workspace projects without truncation', async () => {
    const engineering = await createWorkspace('Engineering Bulk');
    await service.createProject(projectInput('Default Workspace Project'));
    const bulkIds = new Set<string>();
    for (let index = 0; index < 105; index += 1) {
      const project = await service.createProject(projectInput(`Bulk ${index}`, engineering.id));
      bulkIds.add(project.id);
    }
    const template = await service.createProject({
      ...projectInput('Bulk Template', engineering.id),
      isTemplate: true,
    });

    const snapshot = await service.getProjectWorkspaceSnapshot(template.id);
    const ids = snapshot.map((project) => project.id);

    expect(ids).toHaveLength(106);
    expect(new Set(ids)).toEqual(new Set([...bulkIds, template.id]));
    expect(ids).toEqual([...ids].sort());
    expect(snapshot.every((project) => project.workspaceId === engineering.id)).toBe(true);
  });

  it('throws NotFoundError when the owning project does not exist', async () => {
    await expect(service.getProjectWorkspaceSnapshot(randomUUID())).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('serializes both delete-versus-move orderings without orphaning membership or grants', async () => {
    const deleteFirstWorkspace = await createWorkspace('Delete First');
    const deleteFirstProject = await service.createProject(projectInput('Delete First Project'));
    grant('delete-first-device', deleteFirstWorkspace.id);

    const firstBlocker = holdTransaction();
    const deleteFirst = service.deleteProjectWorkspace(
      deleteFirstWorkspace.id,
      DEFAULT_PROJECT_WORKSPACE_ID,
    );
    const rejectedMove = service.updateProject(deleteFirstProject.id, {
      workspaceId: deleteFirstWorkspace.id,
    });
    firstBlocker.release();
    await expect(deleteFirst).resolves.toEqual({
      movedProjectCount: 0,
      remappedDeviceGrantCount: 1,
    });
    await expect(rejectedMove).rejects.toBeInstanceOf(NotFoundError);
    await firstBlocker.held;
    expect(projectWorkspaceId(deleteFirstProject.id)).toBe(DEFAULT_PROJECT_WORKSPACE_ID);
    expect(deviceGrants('delete-first-device')).toEqual([DEFAULT_PROJECT_WORKSPACE_ID]);

    const moveFirstWorkspace = await createWorkspace('Move First');
    const moveFirstProject = await service.createProject(projectInput('Move First Project'));
    grant('move-first-device', moveFirstWorkspace.id);

    const secondBlocker = holdTransaction();
    const acceptedMove = service.updateProject(moveFirstProject.id, {
      workspaceId: moveFirstWorkspace.id,
    });
    const moveFirstDelete = service.deleteProjectWorkspace(
      moveFirstWorkspace.id,
      DEFAULT_PROJECT_WORKSPACE_ID,
    );
    secondBlocker.release();
    await expect(acceptedMove).resolves.toMatchObject({ workspaceId: moveFirstWorkspace.id });
    await expect(moveFirstDelete).resolves.toEqual({
      movedProjectCount: 1,
      remappedDeviceGrantCount: 1,
    });
    await secondBlocker.held;
    expect(projectWorkspaceId(moveFirstProject.id)).toBe(DEFAULT_PROJECT_WORKSPACE_ID);
    expect(deviceGrants('move-first-device')).toEqual([DEFAULT_PROJECT_WORKSPACE_ID]);
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

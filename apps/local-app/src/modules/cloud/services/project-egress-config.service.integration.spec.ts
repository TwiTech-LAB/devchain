// Backend integration: real SQLite is the cheapest reliable proof of this persisted contract.
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import { GUEST_SANDBOX_ROOT_PATH } from '../../guests/constants';
import { LocalStorageService } from '../../storage/local/local-storage.service';
import { ProjectEgressConfigService } from './project-egress-config.service';

const MIGRATIONS_FOLDER = join(__dirname, '../../../../drizzle');
const ENABLED_PROJECTS_KEY = 'cloud.egress.enabledProjects';
const DEFAULT_ENABLED_KEY = 'cloud.egress.newProjectsDefaultEnabled';
const TS = '2026-07-31T00:00:00.000Z';

describe('ProjectEgressConfigService', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;
  let storage: LocalStorageService;
  let service: ProjectEgressConfigService;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    db = drizzle(sqlite);
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    sqlite.pragma('foreign_keys = ON');
    storage = new LocalStorageService(db);
    service = new ProjectEgressConfigService(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  function upsertSetting(key: string, value: unknown): void {
    sqlite
      .prepare(
        `INSERT INTO settings (id, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(randomUUID(), key, JSON.stringify(value), TS, TS);
  }

  function enableNewProjectDefault(): void {
    upsertSetting(DEFAULT_ENABLED_KEY, true);
  }

  async function createProject(name: string, rootPath = `/tmp/${name}`) {
    return storage.createProject({ name, rootPath, description: null });
  }

  it('fails closed without the marker while allowing explicit live-project booleans', async () => {
    const project = await createProject('existing');

    expect(service.isEnabled(project.id)).toBe(false);

    enableNewProjectDefault();
    expect(service.isEnabled(project.id)).toBe(true);

    service.setEnabled(project.id, true);
    expect(service.isEnabled(project.id)).toBe(true);

    service.setEnabled(project.id, false);
    expect(service.isEnabled(project.id)).toBe(false);
  });

  it('defaults projects created after the marker through both storage insertion paths to enabled', async () => {
    enableNewProjectDefault();

    const regularProject = await createProject('regular');
    const shellProject = await storage.runInTransaction(() =>
      storage.createProjectShell({
        name: 'template-shell',
        rootPath: '/tmp/template-shell',
        description: null,
      }),
    );

    expect(service.isEnabled(regularProject.id)).toBe(true);
    expect(service.isEnabled(shellProject.id)).toBe(true);
    expect(service.hasAnyEnabled()).toBe(true);
  });

  it('preserves baselined false and applies fresh explicit overrides without a settings cache', async () => {
    const project = await createProject('baselined');
    upsertSetting(ENABLED_PROJECTS_KEY, { [project.id]: false });
    enableNewProjectDefault();

    expect(service.isEnabled(project.id)).toBe(false);

    upsertSetting(ENABLED_PROJECTS_KEY, { [project.id]: true });
    expect(service.isEnabled(project.id)).toBe(true);

    service.setEnabled(project.id, false);
    expect(service.isEnabled(project.id)).toBe(false);
  });

  it('parses overrides entry-tolerantly and keeps raw stale keys inert', async () => {
    const implicitProject = await createProject('implicit');
    const explicitProject = await createProject('explicit');
    const staleProjectId = randomUUID();
    enableNewProjectDefault();
    upsertSetting(ENABLED_PROJECTS_KEY, {
      [explicitProject.id]: true,
      [implicitProject.id]: 'invalid',
      [staleProjectId]: true,
      invalidStaleEntry: null,
    });

    expect(service.getAll()).toEqual({
      [explicitProject.id]: true,
      [staleProjectId]: true,
    });
    expect(service.isEnabled(explicitProject.id)).toBe(true);
    expect(service.isEnabled(implicitProject.id)).toBe(true);
    expect(service.isEnabled(staleProjectId)).toBe(false);
  });

  it('queries project existence on every call and ignores deleted overrides in hasAnyEnabled', async () => {
    enableNewProjectDefault();
    expect(service.hasAnyEnabled()).toBe(false);

    const project = await createProject('temporary');
    expect(service.isEnabled(project.id)).toBe(true);
    expect(service.hasAnyEnabled()).toBe(true);

    service.setEnabled(project.id, true);
    await storage.deleteProject(project.id);

    expect(service.isEnabled(project.id)).toBe(false);
    expect(service.hasAnyEnabled()).toBe(false);
    expect(service.getAll()).toEqual({ [project.id]: true });
  });

  it('keeps an implicit Guest Sandbox disabled but honors only its current-row override', async () => {
    enableNewProjectDefault();
    const firstSandbox = await createProject('guest-1', GUEST_SANDBOX_ROOT_PATH);

    expect(service.isEnabled(firstSandbox.id)).toBe(false);
    expect(service.hasAnyEnabled()).toBe(false);

    service.setEnabled(firstSandbox.id, true);
    expect(service.isEnabled(firstSandbox.id)).toBe(true);
    expect(service.hasAnyEnabled()).toBe(true);

    await storage.deleteProject(firstSandbox.id);
    const recreatedSandbox = await createProject('guest-2', GUEST_SANDBOX_ROOT_PATH);

    expect(recreatedSandbox.id).not.toBe(firstSandbox.id);
    expect(service.isEnabled(firstSandbox.id)).toBe(false);
    expect(service.isEnabled(recreatedSandbox.id)).toBe(false);
    expect(service.hasAnyEnabled()).toBe(false);
    expect(service.getAll()).toEqual({ [firstSandbox.id]: true });
  });
});

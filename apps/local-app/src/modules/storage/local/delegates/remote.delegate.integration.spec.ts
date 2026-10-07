import { createTestDatabase } from '../../../../common/test/test-database.helper';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { IntegrationCredentialCipher } from '../integration-credential-cipher';
import { RemoteApiKeyService } from '../../../remotes/auth/remote-api-key.service';
import Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { join } from 'path';
import { LocalStorageService } from '../local-storage.service';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../../../common/errors/error-types';
import { certificateFingerprint } from '../../../../common/tls/certificate';
import { fixtureTls } from '../../../../common/test/tls-fixture';
import type { Project } from '../../models/domain.models';

describe('RemoteStorageDelegate (integration)', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;
  let service: LocalStorageService;
  let secrets: string;

  beforeEach(() => {
    sqlite = createTestDatabase().sqlite;
    db = drizzle(sqlite);
    sqlite.pragma('foreign_keys = ON');
    secrets = mkdtempSync(join(tmpdir(), 'remote-key-storage-'));
    service = new LocalStorageService(
      db,
      new IntegrationCredentialCipher({ secretDirectory: secrets, machineIdentity: 'test' }),
    );
  });

  afterEach(() => {
    sqlite.close();
    rmSync(secrets, { recursive: true, force: true });
  });

  async function seedProject(name = 'Test Project'): Promise<Project> {
    return service.createProject({
      name,
      rootPath: `/tmp/${name.toLowerCase().replace(/\s+/g, '-')}`,
      description: null,
      isTemplate: false,
    });
  }

  function insertBinding(projectId: string, remoteId: string): void {
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO remote_project_bindings
          (project_id, remote_id, state, host_cursor, created_at, updated_at)
         VALUES (?, ?, 'remote', NULL, ?, ?)`,
      )
      .run(projectId, remoteId, now, now);
  }

  describe('createRemote / listRemotes / getRemote', () => {
    it('creates a remote and lists it back', async () => {
      const remote = await service.createRemote({
        name: 'home-nas',
        baseUrl: 'http://192.168.1.5:9080',
        kind: 'address',
      });

      expect(remote).toMatchObject({
        name: 'home-nas',
        baseUrl: 'http://192.168.1.5:9080',
        kind: 'address',
      });

      const list = await service.listRemotes();
      expect(list.items).toHaveLength(1);
      expect(list.items[0].id).toBe(remote.id);
      expect(await service.getRemote(remote.id)).toEqual(remote);
    });

    it('rejects duplicate names case-insensitively', async () => {
      await service.createRemote({ name: 'home-nas', baseUrl: 'http://10.0.0.1', kind: 'address' });

      await expect(
        service.createRemote({ name: 'Home-NAS', baseUrl: 'http://10.0.0.2', kind: 'address' }),
      ).rejects.toThrow(ConflictError);
    });

    it('throws NotFoundError for a missing remote', async () => {
      await expect(service.getRemote('does-not-exist')).rejects.toThrow(NotFoundError);
    });
  });

  // Real SQLite and cipher verify secrecy and concurrent create-if-absent semantics.
  it('persists one encrypted key across concurrent claims and restarts without exposing it', async () => {
    const remote = await service.createRemote({
      name: 'keyed',
      kind: 'address',
      baseUrl: 'http://host',
    });
    const keys = new RemoteApiKeyService(service);
    const peer = new RemoteApiKeyService(service);
    const values = await Promise.all([
      keys.getOrCreate(remote.id),
      peer.getOrCreate(remote.id),
      keys.getOrCreate(remote.id),
    ]);
    expect(new Set(values).size).toBe(1);
    expect(values[0]).toMatch(/^dck_[A-Za-z0-9_-]{43}$/);
    const row = sqlite
      .prepare('SELECT credential_ciphertext FROM remotes WHERE id = ?')
      .get(remote.id) as { credential_ciphertext: string };
    expect(row.credential_ciphertext).not.toContain(values[0]);
    expect(row.credential_ciphertext).toMatch(/^v1:/);
    expect(await new RemoteApiKeyService(service).getOrCreate(remote.id)).toBe(values[0]);
    for (const result of [await service.getRemote(remote.id), await service.listRemotes()]) {
      expect(JSON.stringify(result)).not.toContain(values[0]);
      expect(JSON.stringify(result)).not.toContain(row.credential_ciphertext);
      expect(JSON.stringify(result)).not.toContain('credential');
    }
    await keys.save(remote.id, 'dck_replacement');
    expect(await keys.headers(remote.id)).toEqual({ authorization: 'Bearer dck_replacement' });
    await expect(keys.get('missing')).rejects.toThrow(NotFoundError);
    await expect(keys.save('missing', 'secret')).rejects.toThrow(NotFoundError);
  });

  describe('VM certificate', () => {
    it('stores the certificate with its fingerprint, and clears it', async () => {
      const remote = await service.createRemote({
        name: 'vm',
        baseUrl: 'https://10.0.0.1:3000',
        kind: 'address',
      });
      expect(remote).toMatchObject({ tlsCertificate: null, tlsFingerprint: null });

      const stored = await service.updateRemoteTlsCertificate(remote.id, fixtureTls.cert);
      expect(stored.tlsCertificate).toBe(fixtureTls.cert);
      expect(stored.tlsFingerprint).toBe(certificateFingerprint(fixtureTls.cert));
      expect(stored.tlsFingerprint).toMatch(/^[0-9A-F]{64}$/);
      expect((await service.listRemotes()).items[0]).toEqual(stored);

      const cleared = await service.updateRemoteTlsCertificate(remote.id, null);
      expect(cleared).toMatchObject({ tlsCertificate: null, tlsFingerprint: null });
    });

    it('stores a certificate given at creation', async () => {
      const remote = await service.createRemote({
        name: 'vm',
        baseUrl: 'https://10.0.0.1:3000',
        kind: 'address',
        tlsCertificate: fixtureTls.cert,
      });
      expect(remote.tlsFingerprint).toBe(certificateFingerprint(fixtureTls.cert));
    });

    it('refuses text that is not a certificate', async () => {
      const remote = await service.createRemote({
        name: 'vm',
        baseUrl: 'https://10.0.0.1:3000',
        kind: 'address',
      });
      await expect(
        service.updateRemoteTlsCertificate(remote.id, 'not a certificate'),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        service.createRemote({
          name: 'other',
          baseUrl: 'https://10.0.0.2:3000',
          kind: 'address',
          tlsCertificate: fixtureTls.key,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('updateRemoteName', () => {
    it('renames a remote', async () => {
      const remote = await service.createRemote({
        name: 'home-nas',
        baseUrl: 'http://10.0.0.1',
        kind: 'address',
      });

      const renamed = await service.updateRemoteName(remote.id, 'renamed-nas');
      expect(renamed.name).toBe('renamed-nas');
      expect(renamed.id).toBe(remote.id);
    });

    it('rejects a rename that collides with another remote', async () => {
      await service.createRemote({ name: 'taken', baseUrl: 'http://10.0.0.1', kind: 'address' });
      const other = await service.createRemote({
        name: 'other',
        baseUrl: 'http://10.0.0.2',
        kind: 'address',
      });

      await expect(service.updateRemoteName(other.id, 'taken')).rejects.toThrow(ConflictError);
    });
  });

  describe('deleteRemote', () => {
    it('deletes a remote with no bindings', async () => {
      const remote = await service.createRemote({
        name: 'home-nas',
        baseUrl: 'http://10.0.0.1',
        kind: 'address',
      });

      await service.deleteRemote(remote.id);
      await expect(service.getRemote(remote.id)).rejects.toThrow(NotFoundError);
    });

    it('refuses to delete a remote referenced by a project binding', async () => {
      const remote = await service.createRemote({
        name: 'home-nas',
        baseUrl: 'http://10.0.0.1',
        kind: 'address',
      });
      const project = await seedProject();
      insertBinding(project.id, remote.id);

      await expect(service.deleteRemote(remote.id)).rejects.toThrow(ConflictError);
      expect(await service.getRemote(remote.id)).toBeTruthy();
    });
  });

  describe('listRemoteProjectBindings', () => {
    it('lists every binding', async () => {
      const remote = await service.createRemote({
        name: 'home-nas',
        baseUrl: 'http://10.0.0.1',
        kind: 'address',
      });
      const project = await seedProject();
      insertBinding(project.id, remote.id);

      const bindings = await service.listRemoteProjectBindings();
      expect(bindings).toEqual([
        expect.objectContaining({
          projectId: project.id,
          remoteId: remote.id,
          state: 'remote',
          hostCursor: null,
        }),
      ]);
    });
  });

  describe('remote_project_bindings foreign keys', () => {
    it('cascades on project delete and restricts on remote delete', async () => {
      const remote = await service.createRemote({
        name: 'home-nas',
        baseUrl: 'http://10.0.0.1',
        kind: 'address',
      });
      const project = await seedProject();
      insertBinding(project.id, remote.id);

      // Deleting the project is refused while the binding exists (project.delegate guard).
      await expect(service.deleteProject(project.id)).rejects.toThrow(ConflictError);

      // Direct SQL delete on the remote is restricted by the FK (app-level guard is in deleteRemote).
      expect(() => sqlite.prepare('DELETE FROM remotes WHERE id = ?').run(remote.id)).toThrow(
        /FOREIGN KEY constraint failed/,
      );

      sqlite.prepare('DELETE FROM remote_project_bindings WHERE project_id = ?').run(project.id);
      await service.deleteProject(project.id);
      expect(
        sqlite.prepare('SELECT 1 FROM remote_project_bindings WHERE remote_id = ?').get(remote.id),
      ).toBeUndefined();
    });
  });

  describe('binding writes', () => {
    it('creates an attaching binding and refuses a second one for the project', async () => {
      const project = await seedProject();
      const remote = await service.createRemote({
        name: 'vm-1',
        baseUrl: 'http://10.0.0.1:3000',
        kind: 'address',
      });

      const binding = await service.createRemoteProjectBinding({
        projectId: project.id,
        remoteId: remote.id,
      });

      expect(binding).toMatchObject({
        projectId: project.id,
        state: 'attaching',
        hostCursor: null,
      });
      await expect(
        service.createRemoteProjectBinding({ projectId: project.id, remoteId: remote.id }),
      ).rejects.toMatchObject({
        statusCode: 409,
        details: { code: 'REMOTE_BINDING_EXISTS', state: 'attaching' },
      });
    });

    it('updates state and cursor independently and deletes the row once', async () => {
      const project = await seedProject();
      const remote = await service.createRemote({
        name: 'vm-1',
        baseUrl: 'http://10.0.0.1:3000',
        kind: 'address',
      });
      await service.createRemoteProjectBinding({ projectId: project.id, remoteId: remote.id });

      await service.updateRemoteProjectBinding(project.id, { hostCursor: '2026-09-22T00:00:00Z' });
      const updated = await service.updateRemoteProjectBinding(project.id, { state: 'remote' });

      expect(updated).toMatchObject({ state: 'remote', hostCursor: '2026-09-22T00:00:00Z' });
      expect(await service.deleteRemoteProjectBinding(project.id)).toMatchObject({
        state: 'remote',
      });
      expect(await service.deleteRemoteProjectBinding(project.id)).toBeNull();
      expect(await service.getRemoteProjectBinding(project.id)).toBeNull();
      await expect(
        service.updateRemoteProjectBinding(project.id, { state: 'remote' }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('remote operations', () => {
    const steps = [
      {
        id: 'one',
        label: 'One',
        state: 'pending' as const,
        startedAt: null,
        endedAt: null,
        error: null,
      },
    ];

    it('allows one running or failed operation per project and any number of finished ones', async () => {
      const project = await seedProject();
      const remote = await service.createRemote({
        name: 'vm-1',
        baseUrl: 'http://10.0.0.1:3000',
        kind: 'address',
      });
      const input = { kind: 'attach' as const, remoteId: remote.id, projectId: project.id, steps };

      const first = await service.createRemoteOperation({ ...input, details: { a: 1 } });
      await expect(service.createRemoteOperation({ ...input, details: {} })).rejects.toMatchObject({
        details: { code: 'REMOTE_OPERATION_IN_PROGRESS', operationId: first.id },
      });

      await service.updateRemoteOperation(first.id, { state: 'failed' });
      await expect(service.createRemoteOperation({ ...input, details: {} })).rejects.toBeInstanceOf(
        ConflictError,
      );

      await service.updateRemoteOperation(first.id, { state: 'cancelled' });
      const second = await service.createRemoteOperation({ ...input, details: {} });
      await service.updateRemoteOperation(second.id, { state: 'done' });
      const third = await service.createRemoteOperation({ ...input, details: {} });

      expect(third.state).toBe('running');
      expect(
        (await service.listRemoteOperations({ projectId: project.id })).map((op) => op.id).sort(),
      ).toEqual([first.id, second.id, third.id].sort());
      expect(
        (await service.listRemoteOperations({ states: ['running'] })).map((op) => op.id),
      ).toEqual([third.id]);
    });

    it('round-trips steps and details as JSON and keeps unspecified fields on update', async () => {
      const remote = await service.createRemote({
        name: 'vm-1',
        baseUrl: 'http://10.0.0.1:3000',
        kind: 'address',
      });
      const created = await service.createRemoteOperation({
        kind: 'update_host',
        remoteId: remote.id,
        projectId: null,
        steps,
        details: { force: true },
      });

      const updated = await service.updateRemoteOperation(created.id, {
        steps: [{ ...steps[0], state: 'failed', error: { message: 'boom', code: 'X' } }],
      });

      expect(updated).toMatchObject({
        kind: 'update_host',
        projectId: null,
        state: 'running',
        details: { force: true },
        steps: [{ id: 'one', state: 'failed', error: { message: 'boom', code: 'X' } }],
      });
      expect(await service.getRemoteOperation(created.id)).toEqual(updated);
    });

    it('applies an update with expectedState only while the operation is in that state', async () => {
      const remote = await service.createRemote({
        name: 'vm-1',
        baseUrl: 'http://10.0.0.1:3000',
        kind: 'address',
      });
      const created = await service.createRemoteOperation({
        kind: 'update_host',
        remoteId: remote.id,
        projectId: null,
        steps,
        details: {},
      });

      await expect(
        service.updateRemoteOperation(created.id, { state: 'cancelled', expectedState: 'failed' }),
      ).rejects.toMatchObject({
        details: {
          code: 'REMOTE_OPERATION_STATE_CHANGED',
          operationId: created.id,
          state: 'running',
        },
      });
      expect((await service.getRemoteOperation(created.id)).state).toBe('running');

      await service.updateRemoteOperation(created.id, { state: 'failed' });
      const cancelled = await service.updateRemoteOperation(created.id, {
        state: 'cancelled',
        expectedState: 'failed',
      });
      expect(cancelled.state).toBe('cancelled');
    });

    it('keeps the history of a deleted project with a null project id', async () => {
      const project = await seedProject();
      const remote = await service.createRemote({
        name: 'vm-1',
        baseUrl: 'http://10.0.0.1:3000',
        kind: 'address',
      });
      const operation = await service.createRemoteOperation({
        kind: 'attach',
        remoteId: remote.id,
        projectId: project.id,
        steps,
        details: {},
      });

      await service.deleteProject(project.id);

      expect((await service.getRemoteOperation(operation.id)).projectId).toBeNull();
    });
  });
});

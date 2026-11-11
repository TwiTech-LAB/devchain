import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetEnvConfig } from '../../common/config/env.config';
import { AllExceptionsFilter } from '../../common/filters/http-exception.filter';
import { createTestDatabase } from '../../common/test/test-database.helper';
import { ProviderAdapterFactory } from '../providers/adapters/provider-adapter.factory';
import { STORAGE_SERVICE } from '../storage/interfaces/storage.interface';
import { LocalStorageService } from '../storage/local/local-storage.service';
import {
  VAULT_ENTRY_DOMAIN,
  VAULT_ENTRY_VALUE_FIELD,
  VaultEntriesService,
} from './vault-entries.service';
import { VaultAccessService } from './vault-access.service';
import { VAULT_SESSION_OVERLAY } from './vault-session-overlay';
import { VaultEntriesController } from './vault-entries.controller';
import { VAULT_OPTIONS, VaultKeyService } from './vault-key.service';
import { VAULT_KEYSTORE, VaultKeystoreUnavailableError } from './vault-keystore';

// One HTTP pass over the entry, grant and access routes: body validation, error mapping,
// the write-only contract, the home-only rule and the locked-write guard. Storage rules have their own
// integration spec; name rules have a unit spec.
describe('Vault entry routes', () => {
  let app: NestFastifyApplication;
  let sqlite: Database.Database;
  let vault: VaultKeyService;
  let root: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'devchain-vault-entries-api-'));
    const database = createTestDatabase();
    sqlite = database.sqlite;
    sqlite
      .prepare(
        `INSERT INTO projects (id, name, root_path, created_at, updated_at)
         VALUES ('A', 'Project A', '/tmp/A', 'T', 'T')`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO agent_profiles (id, project_id, name, family_slug, created_at, updated_at)
         VALUES ('profile-1', 'A', 'Coder', 'coder', 'T', 'T')`,
      )
      .run();
    const unavailable = () => Promise.reject(new VaultKeystoreUnavailableError());
    const module = await Test.createTestingModule({
      controllers: [VaultEntriesController],
      providers: [
        VaultKeyService,
        VaultEntriesService,
        VaultAccessService,
        { provide: VAULT_SESSION_OVERLAY, useValue: { valuesFor: () => [] } },
        { provide: STORAGE_SERVICE, useValue: new LocalStorageService(database.db) },
        {
          provide: VAULT_KEYSTORE,
          useValue: {
            isAvailable: () => false,
            read: unavailable,
            write: unavailable,
            remove: unavailable,
          },
        },
        { provide: VAULT_OPTIONS, useValue: { fileKeyDirectory: join(root, 'vault') } },
        {
          provide: ProviderAdapterFactory,
          useValue: { getSupportedProviders: () => [], getAdapter: () => ({}) },
        },
      ],
    }).compile();
    vault = module.get(VaultKeyService);
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    await vault.setup('file');
  });

  afterAll(async () => {
    await app.close();
    sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });

  const create = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/vault/entries', payload });

  it('creates, updates, replaces and deletes entries without returning a value', async () => {
    const canaries = ['secret-canary-1', 'file-canary-1\nline 2\n', 'secret-canary-2'];
    const secret = await create({
      projects: [{ projectId: 'A', mode: 'all' }],
      name: 'API_TOKEN',
      kind: 'secret',
      description: 'Token for the tracker',
      value: canaries[0],
    });
    const file = await create({
      projects: [],
      name: 'SERVICE_ACCOUNT',
      kind: 'file',
      description: 'JSON key',
      value: canaries[1],
    });
    expect(secret.statusCode).toBe(201);
    expect(file.json()).toMatchObject({ kind: 'file', projectId: null, revision: 1 });
    const secretId = secret.json().id as string;
    const fileId = file.json().id as string;

    const responses = [
      secret,
      file,
      await app.inject({
        method: 'PATCH',
        url: `/api/vault/entries/${secretId}`,
        payload: { description: 'Renamed token' },
      }),
      await app.inject({
        method: 'PUT',
        url: `/api/vault/entries/${secretId}/value`,
        payload: { value: canaries[2] },
      }),
      await app.inject({ method: 'GET', url: '/api/vault/entries?projectId=A' }),
      await app.inject({ method: 'GET', url: `/api/vault/entries/${secretId}/grants` }),
      await app.inject({
        method: 'PUT',
        url: '/api/vault/projects/A/grants',
        payload: { entries: [{ entryId: fileId, mode: 'families', familySlugs: ['coder'] }] },
      }),
      await app.inject({
        method: 'PATCH',
        url: `/api/vault/entries/${secretId}`,
        payload: { projects: [] },
      }),
      await app.inject({ method: 'GET', url: '/api/vault/grants?projectId=A' }),
    ];
    for (const response of responses) {
      expect(response.statusCode).toBeLessThan(300);
      for (const canary of canaries) expect(response.body).not.toContain(canary.slice(0, 13));
      expect(response.body).not.toContain('valueCiphertext');
    }
    expect(responses[3].json()).toMatchObject({ description: 'Renamed token', revision: 2 });
    expect(responses[4].json().map((row: { name: string }) => row.name)).toEqual([
      'API_TOKEN',
      'SERVICE_ACCOUNT',
    ]);
    expect(responses[6].json()).toContainEqual({
      entryId: fileId,
      projectId: 'A',
      familySlug: 'coder',
      familyMatched: true,
    });
    expect(responses[7].json()).toMatchObject({ projectId: 'A' });
    expect(responses[8].json()).toEqual([
      { entryId: fileId, projectId: 'A', familySlug: 'coder', familyMatched: true },
    ]);

    const rows = JSON.stringify(sqlite.prepare('SELECT * FROM vault_entries').all());
    for (const canary of canaries) expect(rows).not.toContain(canary.slice(0, 13));
    const stored = sqlite
      .prepare('SELECT value_ciphertext FROM vault_entries WHERE id = ?')
      .get(secretId) as { value_ciphertext: string };
    expect(
      vault
        .decrypt(VAULT_ENTRY_DOMAIN, secretId, VAULT_ENTRY_VALUE_FIELD, stored.value_ciphertext)
        .toString('utf8'),
    ).toBe(canaries[2]);

    const removed = await app.inject({ method: 'DELETE', url: `/api/vault/entries/${fileId}` });
    expect(removed.statusCode).toBe(204);
    const missing = await app.inject({ method: 'DELETE', url: `/api/vault/entries/${fileId}` });
    expect(missing.statusCode).toBe(404);
  });

  it('creates a gated entry and lists and removes its family approvals', async () => {
    const created = await create({
      projects: [{ projectId: 'A', mode: 'all' }],
      name: 'GATED_TOKEN',
      kind: 'secret',
      description: 'Needs approval',
      value: 'x',
      approvalRequired: true,
    });
    expect(created.json()).toMatchObject({ approvalRequired: true, revision: 1 });
    const id = created.json().id as string;
    sqlite
      .prepare(
        `INSERT INTO vault_use_family_approvals (id, entry_id, project_id, family_slug, created_at)
         VALUES ('approval-1', ?, 'A', 'coder', 'T')`,
      )
      .run(id);
    const approvals = `/api/vault/entries/${id}/approvals`;

    expect((await app.inject({ method: 'GET', url: approvals })).json()).toEqual([
      { entryId: id, projectId: 'A', familySlug: 'coder', createdAt: 'T' },
    ]);
    const removed = await app.inject({ method: 'DELETE', url: `${approvals}/A/coder` });
    expect([removed.statusCode, removed.json()]).toEqual([200, []]);
    const again = await app.inject({ method: 'DELETE', url: `${approvals}/A/coder` });
    expect(again.statusCode).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/api/vault/entries/nope/approvals' })).statusCode,
    ).toBe(404);
    await app.inject({ method: 'DELETE', url: `/api/vault/entries/${id}` });
  });

  it('refuses reserved names, bad values and unknown families with a clear error', async () => {
    const reserved = await create({
      projects: [],
      name: 'DEVCHAIN_TOKEN',
      kind: 'secret',
      description: 'Reserved',
      value: 'reserved-canary',
    });
    expect(reserved.statusCode).toBe(400);
    expect(reserved.json()).toMatchObject({
      message: 'The name DEVCHAIN_TOKEN is reserved by DevChain or a provider.',
      details: { code: 'VAULT_ENTRY_NAME_RESERVED' },
    });

    const multiline = await create({
      projects: [],
      name: 'MULTI',
      kind: 'secret',
      description: 'Has a newline',
      value: 'multiline-canary\nsecond',
    });
    expect(multiline.statusCode).toBe(400);
    expect(multiline.body).not.toContain('multiline-canary');

    const noDescription = await create({
      projects: [],
      name: 'NO_DESCRIPTION',
      kind: 'secret',
      description: '   ',
      value: 'x',
    });
    expect(noDescription.statusCode).toBe(400);

    const global = await create({
      projects: [],
      name: 'GLOBAL_KEY',
      kind: 'secret',
      description: 'Global',
      value: 'x',
    });
    const globalId = global.json().id as string;
    const grant = await app.inject({
      method: 'PUT',
      url: '/api/vault/projects/A/grants',
      payload: { entries: [{ entryId: globalId, mode: 'families', familySlugs: ['ghost'] }] },
    });
    expect(grant.statusCode).toBe(400);
    expect(grant.json().details).toEqual({
      code: 'VAULT_GRANT_UNKNOWN_FAMILY',
      familySlugs: ['ghost'],
    });

    const twice = await app.inject({
      method: 'PATCH',
      url: `/api/vault/entries/${globalId}`,
      payload: {
        projects: [
          { projectId: 'A', mode: 'all' },
          { projectId: 'A', mode: 'all' },
        ],
      },
    });
    expect(twice.statusCode).toBe(400);

    const removed = await app.inject({
      method: 'PUT',
      url: `/api/vault/entries/${globalId}/grants`,
      payload: { projectId: 'A', mode: 'all' },
    });
    expect(removed.statusCode).toBe(404);
  });

  it('saves the Vault access of a project with its grants, all or none', async () => {
    const put = (payload: Record<string, unknown>) =>
      app.inject({ method: 'PUT', url: '/api/vault/projects/A/grants', payload });
    const access = async () =>
      (await app.inject({ method: 'GET', url: '/api/vault/access?projectId=A' })).json();
    const entryId = (
      await create({
        projects: [],
        name: 'ACCESS_KEY',
        kind: 'secret',
        description: 'Saved with access',
        value: 'x',
      })
    ).json().id as string;

    const saved = await put({
      entries: [{ entryId, mode: 'all' }],
      access: { mode: 'families', familySlugs: [' Coder '] },
    });
    expect(saved.json()).toContainEqual(expect.objectContaining({ entryId, familySlug: null }));
    expect(await access()).toEqual([{ projectId: 'A', familySlug: 'coder', familyMatched: true }]);

    // A failing grant rolls the access change back.
    const failed = await put({
      entries: [{ entryId, mode: 'families', familySlugs: ['ghost'] }],
      access: { mode: 'all' },
    });
    expect([failed.statusCode, failed.json().details.code]).toEqual([
      400,
      'VAULT_GRANT_UNKNOWN_FAMILY',
    ]);
    expect(await access()).toEqual([{ projectId: 'A', familySlug: 'coder', familyMatched: true }]);

    const unknown = await put({
      entries: [],
      access: { mode: 'families', familySlugs: ['ghost'] },
    });
    expect([unknown.statusCode, unknown.json().details]).toEqual([
      400,
      { code: 'VAULT_ACCESS_UNKNOWN_FAMILY', familySlugs: ['ghost'] },
    ]);
    expect(
      (await put({ entries: [], access: { mode: 'all', familySlugs: ['coder'] } })).statusCode,
    ).toBe(400);

    expect((await put({ entries: [{ entryId, mode: 'none' }] })).statusCode).toBe(200);
    expect(await access()).toHaveLength(1);
    expect((await put({ entries: [], access: { mode: 'none' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/vault/access' })).json()).toEqual([]);

    const removed = await app.inject({
      method: 'PUT',
      url: '/api/vault/projects/A/access',
      payload: { mode: 'all' },
    });
    expect(removed.statusCode).toBe(404);
  });

  describe('while the Vault is locked', () => {
    let entryId: string;

    beforeAll(async () => {
      entryId = (
        await create({
          projects: [],
          name: 'GUARDED_KEY',
          kind: 'secret',
          description: 'Guarded',
          value: 'x',
        })
      ).json().id as string;
      sqlite
        .prepare(
          `INSERT INTO remotes (id, name, base_url, kind, created_at, updated_at)
           VALUES ('vm-1', 'VM', 'https://10.0.0.9', 'address', 'T', 'T')`,
        )
        .run();
    });

    afterAll(() => {
      sqlite.prepare('DELETE FROM remote_project_bindings').run();
      sqlite.prepare('DELETE FROM remotes').run();
    });

    const bind = (state: string | null) => {
      sqlite.prepare('DELETE FROM remote_project_bindings').run();
      if (state) {
        sqlite
          .prepare(
            `INSERT INTO remote_project_bindings (project_id, remote_id, state, created_at, updated_at)
             VALUES ('A', 'vm-1', ?, 'T', 'T')`,
          )
          .run(state);
      }
    };
    const accessWrites = () => [
      {
        method: 'PUT' as const,
        url: '/api/vault/projects/A/grants',
        payload: { entries: [{ entryId, mode: 'families', familySlugs: ['coder'] }] },
      },
      {
        method: 'PATCH' as const,
        url: `/api/vault/entries/${entryId}`,
        payload: { projects: [{ projectId: 'A', mode: 'all' }] },
      },
      {
        method: 'PATCH' as const,
        url: `/api/vault/entries/${entryId}`,
        payload: { approvalRequired: true },
      },
      {
        method: 'PUT' as const,
        url: '/api/vault/projects/A/grants',
        payload: { entries: [], access: { mode: 'all' } },
      },
      { method: 'DELETE' as const, url: `/api/vault/entries/${entryId}/approvals/A/coder` },
      { method: 'DELETE' as const, url: `/api/vault/entries/${entryId}` },
    ];
    /** Each write and its status; the deletes run only with `withDelete`. */
    const statuses = async (withDelete: boolean) => {
      const result: Array<[string, number]> = [];
      for (const write of accessWrites()) {
        if (write.method === 'DELETE' && !withDelete) continue;
        result.push([write.method, (await app.inject(write)).statusCode]);
      }
      return result;
    };

    it('refuses access-affecting writes while a project runs on a VM', async () => {
      bind('remote');
      const state = jest.spyOn(vault, 'getState').mockReturnValue('locked');
      try {
        for (const write of accessWrites()) {
          const response = await app.inject(write);
          expect([write.url, response.statusCode]).toEqual([write.url, 409]);
          expect(response.json()).toMatchObject({
            message: expect.stringContaining('Unlock the Vault first.'),
            details: { code: 'VAULT_LOCKED_REMOTE_ACCESS' },
          });
        }
        const describe = await app.inject({
          method: 'PATCH',
          url: `/api/vault/entries/${entryId}`,
          payload: { description: 'Still editable' },
        });
        expect(describe.statusCode).toBe(200);
      } finally {
        state.mockRestore();
      }
      expect(
        (await app.inject({ method: 'GET', url: `/api/vault/entries/${entryId}/grants` })).json(),
      ).toEqual([]);
      expect(
        (await app.inject({ method: 'GET', url: '/api/vault/entries' }))
          .json()
          .find((row: { id: string }) => row.id === entryId),
      ).toMatchObject({ approvalRequired: false });
    });

    it('allows the same writes unlocked, and locked when no project runs on a VM', async () => {
      const ok = [
        ['PUT', 200],
        ['PATCH', 200],
        ['PATCH', 200],
        ['PUT', 200],
      ];
      bind('remote');
      expect(await statuses(false)).toEqual(ok);

      bind('detaching');
      const state = jest.spyOn(vault, 'getState').mockReturnValue('locked');
      try {
        expect(await statuses(true)).toEqual([...ok, ['DELETE', 200], ['DELETE', 204]]);
      } finally {
        state.mockRestore();
      }
    });
  });

  describe('on a claimed VM', () => {
    let savedEtcDir: string | undefined;
    let id: string;

    beforeAll(async () => {
      id = (
        await create({
          projects: [],
          name: 'HOME_KEY',
          kind: 'secret',
          description: 'Made at home',
          value: 'x',
        })
      ).json().id as string;
      const etcDir = join(root, 'host-etc');
      mkdirSync(etcDir);
      writeFileSync(join(etcDir, 'claim.json'), '{}');
      savedEtcDir = process.env.DEVCHAIN_HOST_ETC_DIR;
      process.env.DEVCHAIN_HOST_ETC_DIR = etcDir;
      resetEnvConfig();
    });

    afterAll(() => {
      process.env.DEVCHAIN_HOST_ETC_DIR = savedEtcDir;
      resetEnvConfig();
    });

    it('refuses every write route', async () => {
      const writes = [
        {
          method: 'POST' as const,
          url: '/api/vault/entries',
          payload: {
            projects: [],
            name: 'VM_KEY',
            kind: 'secret',
            description: 'd',
            value: 'x',
          },
        },
        { method: 'PATCH' as const, url: `/api/vault/entries/${id}`, payload: { name: 'X' } },
        { method: 'PUT' as const, url: `/api/vault/entries/${id}/value`, payload: { value: 'x' } },
        { method: 'DELETE' as const, url: `/api/vault/entries/${id}` },
        { method: 'DELETE' as const, url: `/api/vault/entries/${id}/approvals/A/coder` },
        {
          method: 'PUT' as const,
          url: '/api/vault/projects/A/grants',
          payload: { entries: [{ entryId: id, mode: 'all' }] },
        },
      ];
      for (const write of writes) {
        const response = await app.inject(write);
        expect([write.url, response.statusCode]).toEqual([write.url, 403]);
        expect(response.json().details).toEqual({ code: 'VAULT_HOME_ONLY' });
      }
    });
  });
});

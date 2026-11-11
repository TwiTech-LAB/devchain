import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AllExceptionsFilter } from '../../common/filters/http-exception.filter';
import { createTestDatabase } from '../../common/test/test-database.helper';
import { RuntimeDirectoryService } from '../runtime-directory/runtime-directory.service';
import { STORAGE_SERVICE } from '../storage/interfaces/storage.interface';
import { LocalStorageService } from '../storage/local/local-storage.service';
import { VaultStoreKey } from '../storage/local/vault-store-key';
import { VaultController } from './vault.controller';
import { VAULT_OPTIONS, VaultKeyService } from './vault-key.service';
import { VAULT_KEYSTORE, VaultKeystoreUnavailableError } from './vault-keystore';
import { VaultStoreMigrationService } from './vault-store-migration.service';
import { VaultVmCacheService } from './vault-vm-cache.service';

// One HTTP pass over the route group: body validation, error mapping and the
// rule that a recovery code leaves REST only until the user confirms it.
describe('Vault routes', () => {
  let app: NestFastifyApplication;
  let sqlite: Database.Database;
  let root: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'devchain-vault-api-'));
    const database = createTestDatabase();
    sqlite = database.sqlite;
    const unavailable = () => Promise.reject(new VaultKeystoreUnavailableError());
    const module = await Test.createTestingModule({
      controllers: [VaultController],
      providers: [
        VaultKeyService,
        VaultStoreMigrationService,
        VaultStoreKey,
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
          provide: RuntimeDirectoryService,
          useValue: { getStatus: async () => ({ protection: 'disk', lingerHint: true }) },
        },
        { provide: VaultVmCacheService, useValue: { isClaimedHost: () => false } },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('sets up, shows the recovery code until confirmed, and validates bodies', async () => {
    const before = await app.inject({ method: 'GET', url: '/api/vault/status' });
    expect(before.json()).toEqual({
      state: 'not_set_up',
      protection: null,
      reason: 'keystore_unavailable',
      keystoreAvailable: false,
      recoveryCodePending: false,
      runtime: { protection: 'disk', lingerHint: true },
      storeMigration: { state: 'not_applicable', stores: [] },
    });

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/vault/setup',
      payload: { mode: 'keystore' },
    });
    expect(invalid.statusCode).toBe(400);

    const setup = await app.inject({
      method: 'POST',
      url: '/api/vault/setup',
      payload: { mode: 'file' },
    });
    expect(setup.statusCode).toBe(200);
    const code = setup.json().recoveryCode as string;
    expect(setup.json()).toMatchObject({ state: 'unlocked', protection: 'file' });
    expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/);

    const again = await app.inject({
      method: 'POST',
      url: '/api/vault/setup',
      payload: { mode: 'recovery' },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().details).toEqual({ code: 'VAULT_ALREADY_SET_UP' });

    const pending = await app.inject({ method: 'GET', url: '/api/vault/status' });
    expect(pending.json().recoveryCode).toBe(code);

    const confirmed = await app.inject({ method: 'POST', url: '/api/vault/recovery/confirm' });
    expect(confirmed.json()).toMatchObject({ recoveryCodePending: false });

    const unlock = await app.inject({
      method: 'POST',
      url: '/api/vault/unlock',
      payload: { recoveryCode: code },
    });
    const after = await app.inject({ method: 'GET', url: '/api/vault/status' });
    for (const response of [confirmed, unlock, after]) {
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(code);
      expect(response.json()).not.toHaveProperty('recoveryCode');
    }
  });
});

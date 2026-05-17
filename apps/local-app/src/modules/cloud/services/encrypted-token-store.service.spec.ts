import { Test, TestingModule } from '@nestjs/testing';
import { EncryptedTokenStoreService } from './encrypted-token-store.service';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { CloudTokens } from '../types';

describe('EncryptedTokenStoreService', () => {
  let service: EncryptedTokenStoreService;
  let sqlite: Database.Database;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    const db = drizzle(sqlite);

    const module: TestingModule = await Test.createTestingModule({
      providers: [EncryptedTokenStoreService, { provide: DB_CONNECTION, useValue: db }],
    }).compile();

    service = module.get<EncryptedTokenStoreService>(EncryptedTokenStoreService);
  });

  afterEach(() => {
    sqlite.close();
  });

  const sampleTokens: CloudTokens = {
    accessToken: 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.test-access',
    refreshToken: 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.test-refresh',
    userId: '550e8400-e29b-41d4-a716-446655440000',
    email: 'test@example.com',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };

  it('should return null when no tokens stored', () => {
    expect(service.retrieve()).toBeNull();
  });

  it('should store and retrieve tokens (encryption round-trip)', () => {
    service.store(sampleTokens);
    const retrieved = service.retrieve();

    expect(retrieved).not.toBeNull();
    expect(retrieved!.accessToken).toBe(sampleTokens.accessToken);
    expect(retrieved!.refreshToken).toBe(sampleTokens.refreshToken);
    expect(retrieved!.userId).toBe(sampleTokens.userId);
    expect(retrieved!.email).toBe(sampleTokens.email);
    expect(retrieved!.expiresAt).toBe(sampleTokens.expiresAt);
  });

  it('should store encrypted data, not plaintext', () => {
    service.store(sampleTokens);

    const row = sqlite
      .prepare("SELECT value FROM settings WHERE key = 'cloud.tokens.encrypted'")
      .get() as { value: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.value).not.toContain(sampleTokens.accessToken);
    expect(row!.value).not.toContain(sampleTokens.refreshToken);
    expect(row!.value).not.toContain(sampleTokens.userId);
  });

  it('should overwrite previous tokens on re-store', () => {
    service.store(sampleTokens);

    const updatedTokens: CloudTokens = {
      ...sampleTokens,
      accessToken: 'updated-access-token',
      userId: '660e8400-e29b-41d4-a716-446655440001',
    };

    service.store(updatedTokens);
    const retrieved = service.retrieve();

    expect(retrieved!.accessToken).toBe('updated-access-token');
    expect(retrieved!.userId).toBe('660e8400-e29b-41d4-a716-446655440001');
  });

  it('should clear tokens', () => {
    service.store(sampleTokens);
    expect(service.retrieve()).not.toBeNull();

    service.clear();
    expect(service.retrieve()).toBeNull();
  });

  it('should produce different ciphertexts for the same plaintext (random IV)', () => {
    service.store(sampleTokens);
    const row1 = sqlite
      .prepare("SELECT value FROM settings WHERE key = 'cloud.tokens.encrypted'")
      .get() as { value: string };

    service.store(sampleTokens);
    const row2 = sqlite
      .prepare("SELECT value FROM settings WHERE key = 'cloud.tokens.encrypted'")
      .get() as { value: string };

    expect(row1.value).not.toBe(row2.value);
  });

  it('should survive store persistence across service instances', () => {
    service.store(sampleTokens);

    // Create a new instance pointing at the same DB
    const db = drizzle(sqlite);
    const service2 = new EncryptedTokenStoreService(db);

    const retrieved = service2.retrieve();
    expect(retrieved).not.toBeNull();
    expect(retrieved!.userId).toBe(sampleTokens.userId);
  });
});

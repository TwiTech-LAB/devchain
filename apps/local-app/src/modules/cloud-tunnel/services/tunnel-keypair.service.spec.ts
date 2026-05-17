/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
import { createPublicKey, verify } from 'crypto';
import { TunnelKeypairService } from './tunnel-keypair.service';

describe('TunnelKeypairService', () => {
  let service: TunnelKeypairService;
  let mockSqlite: any;
  let storedRows: Record<string, string>;

  beforeEach(() => {
    storedRows = {};
    mockSqlite = {
      prepare: jest.fn((sql: string) => {
        if (sql.includes('INSERT')) {
          return {
            run: jest.fn((settingsKey: string, value: string) => {
              storedRows[settingsKey] = value;
            }),
          };
        }
        if (sql.includes('SELECT')) {
          return {
            get: jest.fn((key: string) => {
              return storedRows[key] ? { value: storedRows[key] } : undefined;
            }),
          };
        }
        return { run: jest.fn(), get: jest.fn() };
      }),
    };

    const mockDb = {} as any;
    jest
      .spyOn(require('../../storage/db/sqlite-raw'), 'getRawSqliteClient')
      .mockReturnValue(mockSqlite);

    service = new TunnelKeypairService(mockDb);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should generate a valid Ed25519 keypair', async () => {
    const kp = await service.generate();
    expect(kp.publicKey).toBeDefined();
    expect(kp.privateKey).toBeDefined();

    const pubKeyDer = Buffer.from(kp.publicKey, 'base64');
    const pubKey = createPublicKey({ key: pubKeyDer, format: 'der', type: 'spki' });
    expect(pubKey.asymmetricKeyType).toBe('ed25519');
  });

  it('should persist keypair encrypted on generate', async () => {
    await service.generate();
    expect(storedRows['cloud.tunnel.keypair']).toBeDefined();
    expect(typeof storedRows['cloud.tunnel.keypair']).toBe('string');
  });

  it('should return existing keypair on getOrCreate second call', async () => {
    const first = await service.getOrCreate();
    const second = await service.getOrCreate();
    expect(first.publicKey).toBe(second.publicKey);
    expect(first.privateKey).toBe(second.privateKey);
  });

  it('should produce a verifiable Ed25519 signature', async () => {
    const kp = await service.generate();
    const payload = 'test-nonce-12345' + '' + '2026-01-01T00:00:00Z';
    const signature = await service.sign(payload, kp.privateKey);

    const pubKeyDer = Buffer.from(kp.publicKey, 'base64');
    const pubKey = createPublicKey({ key: pubKeyDer, format: 'der', type: 'spki' });

    const isValid = verify(null, Buffer.from(payload), pubKey, Buffer.from(signature, 'base64'));
    expect(isValid).toBe(true);
  });
});

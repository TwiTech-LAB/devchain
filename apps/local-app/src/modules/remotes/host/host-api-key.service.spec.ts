import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { HostApiKeyService } from './host-api-key.service';
import { createLogger } from '../../../common/logging/logger';

jest.mock('node:fs', () => ({
  ...jest.requireActual('node:fs'),
  statSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  renameSync: jest.fn(),
  unlinkSync: jest.fn(),
}));
jest.mock('../../../common/logging/logger', () => ({
  createLogger: jest.fn(() => ({ warn: jest.fn() })),
}));

const key = `dck_${'a'.repeat(43)}`;
const rejectionLogger = jest.mocked(createLogger).mock.results[0].value;
const nextKey = `dck_${'b'.repeat(43)}`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const peer = (
  address = '192.0.2.10',
  authorization?: string,
  url = '/api/host/stats',
  method = 'GET',
) =>
  ({
    socket: { remoteAddress: address },
    headers: { authorization, 'x-forwarded-for': '127.0.0.1' },
    url,
    method,
  }) as unknown as IncomingMessage;

// Mocked filesystem metadata makes cache and failure branches deterministic without a server.
describe('HostApiKeyService admission', () => {
  let service: HostApiKeyService;
  let content: string;
  let mtime: number;
  beforeEach(async () => {
    jest.clearAllMocks();
    content = `${hash(key)}\n`;
    mtime = 1;
    jest
      .mocked(fs.statSync)
      .mockImplementation(
        () => ({ mtimeMs: mtime, size: content.length, ino: 1, isFile: () => true }) as fs.Stats,
      );
    jest
      .mocked(fs.readFileSync)
      .mockImplementation((path) =>
        String(path).endsWith('claim.json')
          ? JSON.stringify({ homePath: '/home/claimed' })
          : content,
      );
    const module = await Test.createTestingModule({ providers: [HostApiKeyService] }).compile();
    service = module.get(HostApiKeyService);
  });

  it('requires the correct bearer on HTTP and sockets and ignores forwarded loopback', () => {
    for (const transport of ['http', 'socket'] as const) {
      expect(service.allows(peer(), transport)).toBe(false);
      expect(service.allows(peer(undefined, `Bearer ${nextKey}`), transport)).toBe(false);
      expect(service.allows(peer(undefined, `Bearer ${key}`), transport)).toBe(true);
    }
  });

  it.each(['127.0.0.1', '127.20.30.40', '::1', '::ffff:127.0.0.1'])(
    'allows raw loopback %s',
    (address) => {
      expect(service.allows(peer(address), 'http')).toBe(true);
      expect(service.allows(peer(address), 'socket')).toBe(true);
    },
  );

  it('opens only GET runtime for HTTP', () => {
    expect(service.allows(peer(undefined, undefined, '/api/runtime?probe=1'), 'http')).toBe(true);
    expect(service.allows(peer(undefined, undefined, '/api/runtime', 'POST'), 'http')).toBe(false);
    expect(service.allows(peer(undefined, undefined, '/api/runtime/extra'), 'http')).toBe(false);
    expect(service.allows(peer(undefined, undefined, '/api/runtime'), 'socket')).toBe(false);
  });

  it('leaves home admission unchanged when claim.json is absent', () => {
    jest.mocked(fs.statSync).mockImplementation(() => {
      throw Object.assign(new Error(), { code: 'ENOENT' });
    });
    expect(service.allows(peer(), 'http')).toBe(true);
    expect(service.allows(peer(), 'socket')).toBe(true);
  });

  it.each(['EACCES', 'EIO'])('fails closed when the claim cannot be checked: %s', (code) => {
    jest.mocked(fs.statSync).mockImplementation(() => {
      throw Object.assign(new Error(), { code });
    });
    expect(service.allows(peer(undefined, `Bearer ${key}`), 'http')).toBe(false);
  });

  it.each(['not-json', '{}', '{"homePath":"relative"}'])(
    'fails closed for malformed claim %s',
    (claim) => {
      jest.mocked(fs.readFileSync).mockReturnValue(claim);
      expect(service.allows(peer(undefined, `Bearer ${key}`), 'http')).toBe(false);
    },
  );

  it.each(['', 'bad\n', `${'A'.repeat(64)}\n`, hash(key), `${hash(key)}\nextra`])(
    'fails closed for malformed key file %p',
    (invalid) => {
      content = invalid;
      expect(service.allows(peer(undefined, `Bearer ${key}`), 'http')).toBe(false);
    },
  );

  it('invalidates a cached key if its file disappears or becomes unreadable', () => {
    expect(service.allows(peer(undefined, `Bearer ${key}`), 'http')).toBe(true);
    jest.mocked(fs.statSync).mockImplementation((path) => {
      if (String(path).endsWith('host-api-key'))
        throw Object.assign(new Error(), { code: 'ENOENT' });
      return {} as fs.Stats;
    });
    expect(service.allows(peer(undefined, `Bearer ${key}`), 'http')).toBe(false);
  });

  it('stats each check, caches unchanged digests and reloads after an on-disk reset', () => {
    expect(service.allows(peer(undefined, `Bearer ${key}`), 'http')).toBe(true);
    expect(service.allows(peer(undefined, `Bearer ${key}`), 'http')).toBe(true);
    expect(
      jest
        .mocked(fs.readFileSync)
        .mock.calls.filter(([path]) => String(path).endsWith('host-api-key')),
    ).toHaveLength(1);
    expect(
      jest.mocked(fs.statSync).mock.calls.filter(([path]) => String(path).endsWith('host-api-key')),
    ).toHaveLength(2);
    content = `${hash(nextKey)}\n`;
    mtime++;
    expect(service.allows(peer(undefined, `Bearer ${key}`), 'http')).toBe(false);
    expect(service.allows(peer(undefined, `Bearer ${nextKey}`), 'socket')).toBe(true);
  });

  it('requires the current key even on loopback for rotation', () => {
    expect(service.allows(peer('127.0.0.1'), 'http', true)).toBe(false);
    expect(service.allows(peer('127.0.0.1', `Bearer ${key}`), 'http', true)).toBe(true);
    expect(() => service.rotate(peer(), hash(nextKey))).toThrow('Host API key rejected');
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('writes an exclusive 0600 temporary file and atomically renames it', () => {
    service.rotate(peer(undefined, `Bearer ${key}`), hash(nextKey));
    const temp = jest.mocked(fs.writeFileSync).mock.calls[0][0];
    expect(fs.writeFileSync).toHaveBeenCalledWith(temp, `${hash(nextKey)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    expect(fs.renameSync).toHaveBeenCalledWith(temp, '/home/claimed/.devchain/host-api-key');
  });

  it('sanitizes write failures and cleans up the temporary file', () => {
    jest.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw new Error(`secret ${key}`);
    });
    expect(() => service.rotate(peer(undefined, `Bearer ${key}`), hash(nextKey))).toThrow(
      'Could not replace the host API key',
    );
    expect(fs.unlinkSync).toHaveBeenCalled();
  });

  it('logs only peer, method and path without the header or query', () => {
    service.allows(peer(undefined, `Bearer ${nextKey}`, `/health?key=${nextKey}`), 'http');
    const logger = rejectionLogger;
    expect(logger.warn).toHaveBeenLastCalledWith(
      { peer: '192.0.2.10', method: 'GET', path: '/health' },
      'Host API key rejected',
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(nextKey);
  });
});

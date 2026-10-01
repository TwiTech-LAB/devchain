import { createServer } from 'node:http';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import * as config from '../../../common/config/env.config';
import { registerHostTls, resolveHostTls } from './host-tls.setup';

const FIXTURES = join(__dirname, '../../../../../host-bootstrap/test/fixtures');

describe('resolveHostTls', () => {
  let root: string;
  let etcDir: string;
  let keyFile: string;
  let certFile: string;

  const claim = () => {
    mkdirSync(etcDir, { recursive: true });
    writeFileSync(join(etcDir, 'claim.json'), '{}');
  };
  const resolve = (over: Partial<Parameters<typeof resolveHostTls>[0]> = {}) =>
    resolveHostTls({
      DEVCHAIN_HOST_ETC_DIR: etcDir,
      DEVCHAIN_HOST_TLS_KEY_FILE: keyFile,
      DEVCHAIN_HOST_TLS_CERT_FILE: certFile,
      ...over,
    });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'host-tls-'));
    etcDir = join(root, 'etc');
    keyFile = join(root, 'key.pem');
    certFile = join(root, 'cert.pem');
    copyFileSync(join(FIXTURES, 'tls/key.pem'), keyFile);
    copyFileSync(join(FIXTURES, 'tls/cert.pem'), certFile);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('is off on a home instance without TLS paths', () => {
    expect(
      resolve({ DEVCHAIN_HOST_TLS_KEY_FILE: undefined, DEVCHAIN_HOST_TLS_CERT_FILE: undefined }),
    ).toBeNull();
  });

  it('refuses a claimed VM without TLS paths', () => {
    claim();
    expect(() =>
      resolve({ DEVCHAIN_HOST_TLS_KEY_FILE: undefined, DEVCHAIN_HOST_TLS_CERT_FILE: undefined }),
    ).toThrow(/claimed.*not set/);
  });

  it('counts unreadable host state as claimed', () => {
    // A file where the directory should be: stat fails with ENOTDIR, not ENOENT.
    writeFileSync(etcDir, '');
    expect(() =>
      resolve({ DEVCHAIN_HOST_TLS_KEY_FILE: undefined, DEVCHAIN_HOST_TLS_CERT_FILE: undefined }),
    ).toThrow(/claimed/);
  });

  it('refuses one path without the other', () => {
    expect(() => resolve({ DEVCHAIN_HOST_TLS_CERT_FILE: undefined })).toThrow(/both/);
    expect(() => resolve({ DEVCHAIN_HOST_TLS_KEY_FILE: undefined })).toThrow(/both/);
  });

  it('refuses a missing certificate on a claimed VM and names the file', () => {
    claim();
    rmSync(certFile);
    expect(() => resolve()).toThrow(`Cannot read the TLS certificate ${certFile} (ENOENT)`);
  });

  it('refuses an unreadable key', () => {
    if (process.getuid?.() === 0) return; // root reads mode 000 files
    chmodSync(keyFile, 0o000);
    expect(() => resolve()).toThrow(`Cannot read the TLS key ${keyFile} (EACCES)`);
  });

  it('refuses a key and a certificate that are not one pair', () => {
    copyFileSync(join(FIXTURES, 'tls-other/cert.pem'), certFile);
    expect(() => resolve()).toThrow(/not a usable pair/);
  });

  it('returns the pair on a claimed VM', () => {
    claim();
    expect(resolve()).toMatchObject({ keyFile, certFile, secureContext: expect.anything() });
  });

  it('treats blank env values as unset', () => {
    const saved = { ...process.env };
    try {
      process.env.DEVCHAIN_HOST_ETC_DIR = etcDir;
      process.env.DEVCHAIN_HOST_TLS_KEY_FILE = '  ';
      process.env.DEVCHAIN_HOST_TLS_CERT_FILE = '';
      config.resetEnvConfig();
      expect(config.getEnvConfig()).toMatchObject({
        DEVCHAIN_HOST_TLS_KEY_FILE: undefined,
        DEVCHAIN_HOST_TLS_CERT_FILE: undefined,
      });
      expect(resolveHostTls()).toBeNull();
    } finally {
      process.env = saved;
      config.resetEnvConfig();
    }
  });
});

describe('registerHostTls', () => {
  afterEach(() => jest.restoreAllMocks());

  it('leaves the server untouched without TLS paths', () => {
    const env = config.getEnvConfig();
    jest.spyOn(config, 'getEnvConfig').mockReturnValue({
      ...env,
      DEVCHAIN_HOST_ETC_DIR: join(tmpdir(), 'devchain-no-such-etc'),
      DEVCHAIN_HOST_TLS_KEY_FILE: undefined,
      DEVCHAIN_HOST_TLS_CERT_FILE: undefined,
    });
    const server = createServer();
    const listeners = server.listeners('connection');
    registerHostTls({ getHttpServer: () => server } as unknown as INestApplication);
    expect(server.listeners('connection')).toEqual(listeners);
  });

  it('puts the front on the server with TLS paths', () => {
    const env = config.getEnvConfig();
    jest.spyOn(config, 'getEnvConfig').mockReturnValue({
      ...env,
      DEVCHAIN_HOST_TLS_KEY_FILE: join(FIXTURES, 'tls/key.pem'),
      DEVCHAIN_HOST_TLS_CERT_FILE: join(FIXTURES, 'tls/cert.pem'),
    });
    const server = createServer();
    const [httpListener] = server.listeners('connection');
    registerHostTls({ getHttpServer: () => server } as unknown as INestApplication);
    expect(server.listeners('connection')).toHaveLength(1);
    expect(server.listeners('connection')[0]).not.toBe(httpListener);
  });
});

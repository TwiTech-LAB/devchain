import { BadRequestException } from '@nestjs/common';
import { parseProxmoxConnectionString } from './connection-string';

describe('parseProxmoxConnectionString', () => {
  const caPem = [
    '-----BEGIN CERTIFICATE-----',
    'c2VsZi1zaWduZWQtY2E=',
    '-----END CERTIFICATE-----',
  ].join('\n');

  function connectionString(overrides: Record<string, string> = {}) {
    const params = new URLSearchParams({
      pool: 'devchain',
      storage: 'local-lvm',
      imageStorage: 'local',
      bridge: 'vmbr0',
      fp: 'ab'.repeat(32),
      token: 'devchain@pve!agent:private:secret',
      ca: Buffer.from(caPem).toString('base64'),
      ...overrides,
    });
    return `devchain-proxmox://pve.example.test:8006/pve1?${params}`;
  }

  it('parses each field into the provider contract without retaining the input string', () => {
    const raw = connectionString();
    const parsed = parseProxmoxConnectionString(raw);

    expect(parsed).toMatchObject({
      kind: 'proxmox',
      name: 'Proxmox pve.example.test',
      apiUrl: 'https://pve.example.test:8006',
      node: 'pve1',
      pool: 'devchain',
      storage: 'local-lvm',
      imageStorage: 'local',
      bridge: 'vmbr0',
      vmidMin: 100,
      vmidMax: 999_999_999,
      namePrefix: 'devchain-',
      tag: 'devchain',
      sslFingerprint: 'AB:'.repeat(31) + 'AB',
      caPem,
      tokenId: 'devchain@pve!agent',
      tokenSecret: 'private:secret',
    });
    expect(JSON.stringify(parsed)).not.toContain(raw);
  });

  it.each([
    ['missing field', { pool: '' }],
    ['malformed fingerprint', { fp: 'not-a-sha256-fingerprint' }],
    ['unexpected field', { unexpected: 'value' }],
    ['wrong token id', { token: 'root@pam!admin:private-secret' }],
    ['malformed CA bundle', { ca: Buffer.from('not a certificate').toString('base64') }],
  ])('rejects %s without including token contents in the error', (_case, overrides) => {
    const raw = connectionString(overrides as Record<string, string>);
    try {
      parseProxmoxConnectionString(raw);
      throw new Error('expected a bad request');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as Error).message).not.toContain('private');
    }
  });

  it('rejects duplicate query parameters', () => {
    const raw = connectionString().replace('?pool=', '?pool=other&pool=');
    expect(() => parseProxmoxConnectionString(raw)).toThrow(BadRequestException);
  });

  it('rejects path and host fields that cannot form a safe Proxmox API origin', () => {
    for (const raw of [
      connectionString().replace('/pve1?', '/node%2fother?'),
      connectionString().replace(
        '://pve.example.test:8006',
        '://user:password@pve.example.test:8006',
      ),
      connectionString().replace(':8006/', '/'),
    ]) {
      expect(() => parseProxmoxConnectionString(raw)).toThrow(BadRequestException);
    }
  });
});

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageError } from '../../../common/errors/error-types';
import type { IntegrationCredentials } from '../models/domain.models';
import {
  DEFAULT_INTEGRATION_SECRET_FILE,
  IntegrationCredentialCipher,
} from './integration-credential-cipher';

describe('IntegrationCredentialCipher', () => {
  let secretDirectory: string;
  let cipher: IntegrationCredentialCipher;

  beforeEach(() => {
    secretDirectory = mkdtempSync(join(tmpdir(), 'devchain-integration-credentials-'));
    cipher = new IntegrationCredentialCipher({
      secretDirectory,
      machineIdentity: 'test-host:test-user',
    });
  });

  afterEach(() => {
    rmSync(secretDirectory, { recursive: true, force: true });
  });

  it.each<IntegrationCredentials>([
    { provider: 'clickup', token: 'clickup-secret-token' },
    {
      provider: 'jira',
      siteUrl: 'https://acme.atlassian.net',
      email: 'admin@example.com',
      token: 'jira-secret-token',
    },
  ])('round-trips $provider credentials without plaintext in storage', (credentials) => {
    const encrypted = cipher.encrypt(credentials);

    expect(encrypted).toMatch(/^v1:/);
    expect(encrypted).not.toContain(credentials.token);
    if (credentials.provider === 'jira') {
      expect(encrypted).not.toContain(credentials.email);
    }
    expect(cipher.decrypt(encrypted)).toEqual(credentials);
  });

  it('uses a random IV for every encryption', () => {
    const credentials: IntegrationCredentials = {
      provider: 'clickup',
      token: 'same-secret',
    };

    expect(cipher.encrypt(credentials)).not.toBe(cipher.encrypt(credentials));
  });

  it('creates and maintains a private integration-only key file', () => {
    cipher.encrypt({ provider: 'clickup', token: 'secret' });
    const secretFile = join(secretDirectory, 'secret.key');

    expect(readFileSync(secretFile)).toHaveLength(32);
    expect(statSync(secretDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(secretFile).mode & 0o777).toBe(0o600);
    expect(DEFAULT_INTEGRATION_SECRET_FILE).toMatch(/\.devchain[\\/]integrations[\\/]secret\.key$/);
    expect(DEFAULT_INTEGRATION_SECRET_FILE).not.toContain(`${join('.devchain', 'cloud')}`);
  });

  it('fails closed on tampered ciphertext without exposing protected values', () => {
    const credentials: IntegrationCredentials = {
      provider: 'jira',
      siteUrl: 'https://acme.atlassian.net',
      email: 'private@example.com',
      token: 'private-token',
    };
    const encrypted = cipher.encrypt(credentials);
    const tampered = `${encrypted.slice(0, -2)}AA`;

    expect(() => cipher.decrypt(tampered)).toThrow(StorageError);
    try {
      cipher.decrypt(tampered);
    } catch (error) {
      expect((error as Error).message).toBe('Unable to decrypt integration credentials.');
      expect((error as Error).message).not.toContain(credentials.email);
      expect((error as Error).message).not.toContain(credentials.token);
    }
  });
});

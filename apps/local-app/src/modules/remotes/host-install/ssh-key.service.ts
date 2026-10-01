import { Inject, Injectable, Optional } from '@nestjs/common';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { utils } from 'ssh2';
import {
  MAX_SSH_PUBLIC_KEY_BYTES,
  parseSshPublicKey,
} from '../../../common/validation/ssh-public-key';
import { getIntegrationAdmission } from '../../../common/config/integration-admission';
import { ValidationError } from '../../../common/errors/error-types';
import {
  MAX_SSH_PRIVATE_KEY_BYTES,
  type InstallHostData,
} from '../operations/remote-operation.dto';
import { fingerprintFor, type SshCredentials } from './ssh-runner';

export const SSH_KEY_DIRECTORY = Symbol('SSH_KEY_DIRECTORY');
export interface AvailableSshKey {
  name: string;
  type: string | null;
  encrypted: boolean;
}

export interface AvailableSshPublicKey {
  name: string;
  type: string;
  fingerprint: string;
  comment: string;
  content: string;
}

export interface ResolvedSshCredentials {
  credentials: SshCredentials;
  keyName?: string;
}

type SshInput = InstallHostData['ssh'];
type InspectedSshKey = AvailableSshKey & { privateKey: string };

@Injectable()
export class SshKeyService {
  private readonly directory: string;

  constructor(@Optional() @Inject(SSH_KEY_DIRECTORY) directory?: string) {
    this.directory = directory ?? join(homedir(), '.ssh');
  }

  async list(): Promise<AvailableSshKey[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch {
      return [];
    }

    const keys = await Promise.all(names.map((name) => this.inspect(name)));
    return keys
      .filter((key): key is InspectedSshKey => key !== null)
      .map((key) => ({ name: key.name, type: key.type, encrypted: key.encrypted }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async listPublic(): Promise<AvailableSshPublicKey[]> {
    const names = await readdir(this.directory).catch(() => [] as string[]);
    const keys = await Promise.all(
      names
        .filter((name) => name.endsWith('.pub'))
        .map(async (name): Promise<AvailableSshPublicKey | null> => {
          try {
            const path = await this.containedKeyPath(name, MAX_SSH_PUBLIC_KEY_BYTES);
            if (!path) return null;
            const content = (await readFile(path, 'utf8')).trim();
            const parsed = parseSshPublicKey(content);
            if (!parsed) return null;
            const fingerprint = fingerprintFor(Buffer.from(parsed.body, 'base64'));
            return { name, type: parsed.type, fingerprint, comment: parsed.comment, content };
          } catch {
            return null;
          }
        }),
    );
    return keys
      .filter((key): key is AvailableSshPublicKey => key !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async resolve(input: SshInput): Promise<ResolvedSshCredentials> {
    if (input.keyName !== undefined) {
      const admission = getIntegrationAdmission();
      if (!admission.allowed) {
        throw new ValidationError(
          'SSH keys from this PC are unavailable when DevChain is not bound to loopback.',
          { reason: admission.reason },
        );
      }
      assertSafeKeyName(input.keyName);
      const inspected = await this.inspect(input.keyName, true);
      if (!inspected) {
        throw new ValidationError('The selected SSH key is no longer available.', {
          reason: 'ssh_key_unavailable',
        });
      }
      validatePrivateKey(inspected.privateKey, input.passphrase, input.keyName);
      return {
        keyName: input.keyName,
        credentials: credentialsWithPrivateKey(input, inspected.privateKey),
      };
    }

    if (input.privateKey !== undefined) {
      validatePrivateKey(input.privateKey, input.passphrase);
    }
    return { credentials: input };
  }

  private async inspect(name: string, strictName = false): Promise<InspectedSshKey | null> {
    try {
      const path = await this.containedKeyPath(name, MAX_SSH_PRIVATE_KEY_BYTES);
      if (!path) return null;

      const contents = await readFile(path);
      const privateKey = contents.toString('utf8');
      const parsed = utils.parseKey(contents);
      if (parsed instanceof Error) {
        if (!isMissingPassphraseError(parsed)) return null;
        return {
          name,
          type: await this.publicKeyType(`${name}.pub`),
          encrypted: true,
          privateKey,
        };
      }
      if (!parsed.isPrivateKey()) return null;
      return { name, type: parsed.type, encrypted: false, privateKey };
    } catch (error) {
      if (strictName && error instanceof ValidationError) throw error;
      return null;
    }
  }

  /**
   * The key file's path when it is a regular, non-empty file of at most
   * `maxBytes` directly inside the SSH directory, not reached through a
   * symlink; null otherwise. An unsafe name throws.
   */
  private async containedKeyPath(name: string, maxBytes: number): Promise<string | null> {
    assertSafeKeyName(name);
    const directory = await realpath(this.directory);
    const path = join(this.directory, name);
    const stats = await lstat(path);
    if (!stats.isFile() || stats.size === 0 || stats.size > maxBytes) return null;
    const resolved = await realpath(path);
    if (dirname(resolved) !== directory || basename(resolved) !== name) return null;
    return path;
  }

  private async publicKeyType(name: string): Promise<string | null> {
    try {
      const path = join(this.directory, name);
      const stats = await lstat(path);
      if (!stats.isFile() || stats.size === 0 || stats.size > MAX_SSH_PRIVATE_KEY_BYTES)
        return null;
      const token = (await readFile(path, 'utf8')).trim().split(/\s+/, 1)[0];
      return token || null;
    } catch {
      return null;
    }
  }
}

function assertSafeKeyName(name: string): void {
  if (
    !name ||
    name !== basename(name) ||
    name.includes('..') ||
    name.includes('/') ||
    name.includes('\\')
  ) {
    throw new ValidationError('Choose an SSH key by its file name.', {
      reason: 'ssh_key_name_invalid',
    });
  }
}

function validatePrivateKey(privateKey: string, passphrase?: string, keyName?: string): void {
  const parsed = utils.parseKey(privateKey, passphrase);
  if (!(parsed instanceof Error) && parsed.isPrivateKey()) return;

  if (parsed instanceof Error && isMissingPassphraseError(parsed)) {
    throw new ValidationError(
      `${keyName ? `SSH key ${keyName}` : 'The SSH private key'} is encrypted; enter its passphrase.`,
      { reason: 'ssh_key_passphrase_required' },
    );
  }
  throw new ValidationError(
    passphrase
      ? 'The SSH private key could not be opened. Check its passphrase and format.'
      : 'The SSH private key is invalid.',
    { reason: 'ssh_key_invalid' },
  );
}

function isMissingPassphraseError(error: Error): boolean {
  return /^Encrypted .*key detected, but no passphrase given$/i.test(error.message);
}

function credentialsWithPrivateKey(input: SshInput, privateKey: string): SshCredentials {
  return {
    user: input.user,
    privateKey,
    ...(input.passphrase !== undefined ? { passphrase: input.passphrase } : {}),
    ...(input.sudoPassword !== undefined ? { sudoPassword: input.sudoPassword } : {}),
  };
}

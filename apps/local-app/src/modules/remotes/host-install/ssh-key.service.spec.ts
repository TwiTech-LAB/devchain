/**
 * Test layer: filesystem-backed service unit. A temporary .ssh directory is the
 * cheapest layer that exercises lstat, realpath containment, size bounds, and
 * ssh2's real key parser together without exposing the developer's home.
 */
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { utils } from 'ssh2';
import { createHash } from 'node:crypto';
import { resetEnvConfig } from '../../../common/config/env.config';
import { MAX_SSH_PRIVATE_KEY_BYTES } from '../operations/remote-operation.dto';
import { SshKeyService } from './ssh-key.service';

describe('SshKeyService', () => {
  let root: string;
  let directory: string;
  let service: SshKeyService;
  let rsa: { private: string; public: string };
  let encrypted: { private: string; public: string };
  const originalHost = process.env.HOST;

  beforeEach(async () => {
    process.env.HOST = '127.0.0.1';
    resetEnvConfig();
    root = await mkdtemp(join(tmpdir(), 'devchain-ssh-keys-'));
    directory = join(root, '.ssh');
    await mkdir(directory);
    service = new SshKeyService(directory);
    rsa = utils.generateKeyPairSync('rsa', { bits: 2_048 });
    encrypted = utils.generateKeyPairSync('ed25519', {
      passphrase: 'correct-passphrase',
      cipher: 'aes256-ctr',
      rounds: 16,
    });
  });

  afterEach(async () => {
    if (originalHost === undefined) delete process.env.HOST;
    else process.env.HOST = originalHost;
    resetEnvConfig();
    await rm(root, { recursive: true, force: true });
  });

  it('lists only bounded private key files and returns metadata without content', async () => {
    await writeFile(join(directory, 'id_rsa'), rsa.private);
    await writeFile(join(directory, 'id_rsa.pub'), rsa.public);
    await writeFile(join(directory, 'id_ed25519'), encrypted.private);
    await writeFile(join(directory, 'id_ed25519.pub'), encrypted.public);
    for (const name of ['config', 'known_hosts', 'authorized_keys']) {
      await writeFile(join(directory, name), 'not a private key');
    }
    const outside = join(root, 'outside-key');
    await writeFile(outside, rsa.private);
    await symlink(outside, join(directory, 'escaped-key'));
    await writeFile(
      join(directory, 'oversized-key'),
      Buffer.alloc(MAX_SSH_PRIVATE_KEY_BYTES + 1, 65),
    );

    const keys = await service.list();

    expect(keys).toEqual([
      { name: 'id_ed25519', type: 'ssh-ed25519', encrypted: true },
      { name: 'id_rsa', type: 'ssh-rsa', encrypted: false },
    ]);
    expect(JSON.stringify(keys)).not.toContain('PRIVATE KEY');
  });

  it('lists standalone public keys with fingerprints and skips invalid, oversized and symlinked files', async () => {
    const content = `${rsa.public} workstation`;
    await writeFile(join(directory, 'standalone.pub'), `${content}\n`);
    await writeFile(join(directory, 'private.pub'), rsa.private);
    await writeFile(join(directory, 'invalid.pub'), 'ssh-ed25519 AAAA');
    await writeFile(join(directory, 'large.pub'), 'x'.repeat(16_385));
    const outside = join(root, 'outside.pub');
    await writeFile(outside, encrypted.public);
    await symlink(outside, join(directory, 'escaped.pub'));
    const fingerprint = `SHA256:${createHash('sha256')
      .update(Buffer.from(rsa.public.split(' ')[1], 'base64'))
      .digest('base64')
      .replace(/=+$/, '')}`;
    await expect(service.listPublic()).resolves.toEqual([
      { name: 'standalone.pub', type: 'ssh-rsa', fingerprint, comment: 'workstation', content },
    ]);
  });

  it('resolves a listed key only with the correct passphrase', async () => {
    await writeFile(join(directory, 'id_ed25519'), encrypted.private);

    await expect(service.resolve({ user: 'ubuntu', keyName: 'id_ed25519' })).rejects.toMatchObject({
      statusCode: 400,
      details: { reason: 'ssh_key_passphrase_required' },
    });
    await expect(
      service.resolve({ user: 'ubuntu', keyName: 'id_ed25519', passphrase: 'wrong' }),
    ).rejects.toMatchObject({ statusCode: 400, details: { reason: 'ssh_key_invalid' } });

    const resolved = await service.resolve({
      user: 'ubuntu',
      keyName: 'id_ed25519',
      passphrase: 'correct-passphrase',
      sudoPassword: 'sudo-secret',
    });
    expect(resolved).toEqual({
      keyName: 'id_ed25519',
      credentials: {
        user: 'ubuntu',
        privateKey: encrypted.private,
        passphrase: 'correct-passphrase',
        sudoPassword: 'sudo-secret',
      },
    });
  });

  it.each(['../outside-key', 'folder/id_rsa', '..', 'id..rsa'])(
    'refuses the unsafe key name %s',
    async (keyName) => {
      await expect(service.resolve({ user: 'ubuntu', keyName })).rejects.toMatchObject({
        statusCode: 400,
        details: { reason: 'ssh_key_name_invalid' },
      });
    },
  );

  it('refuses unknown files and symlink escapes', async () => {
    const outside = join(root, 'outside-key');
    await writeFile(outside, rsa.private);
    await symlink(outside, join(directory, 'escaped-key'));

    for (const keyName of ['missing-key', 'escaped-key']) {
      await expect(service.resolve({ user: 'ubuntu', keyName })).rejects.toMatchObject({
        statusCode: 400,
        details: { reason: 'ssh_key_unavailable' },
      });
    }
  });

  it('refuses local key names on a non-loopback bind but still accepts pasted keys', async () => {
    await writeFile(join(directory, 'id_rsa'), rsa.private);
    process.env.HOST = '0.0.0.0';
    resetEnvConfig();

    await expect(service.resolve({ user: 'ubuntu', keyName: 'id_rsa' })).rejects.toMatchObject({
      statusCode: 400,
      details: { reason: 'non_loopback_host' },
    });
    await expect(
      service.resolve({ user: 'ubuntu', privateKey: rsa.private }),
    ).resolves.toMatchObject({ credentials: { privateKey: rsa.private } });
  });

  it('rejects an invalid pasted private key before SSH is attempted', async () => {
    await expect(
      service.resolve({ user: 'ubuntu', privateKey: 'not a key' }),
    ).rejects.toMatchObject({
      statusCode: 400,
      details: { reason: 'ssh_key_invalid' },
    });
  });

  it('validates the passphrase for a pasted encrypted private key', async () => {
    await expect(
      service.resolve({ user: 'ubuntu', privateKey: encrypted.private }),
    ).rejects.toMatchObject({ details: { reason: 'ssh_key_passphrase_required' } });
    await expect(
      service.resolve({ user: 'ubuntu', privateKey: encrypted.private, passphrase: 'wrong' }),
    ).rejects.toMatchObject({ details: { reason: 'ssh_key_invalid' } });
    await expect(
      service.resolve({
        user: 'ubuntu',
        privateKey: encrypted.private,
        passphrase: 'correct-passphrase',
      }),
    ).resolves.toMatchObject({ credentials: { privateKey: encrypted.private } });
  });
});

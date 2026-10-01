// Layer: unit. Real SSH wire encodings exercise the browser-compatible parser
// without a filesystem, HTTP server or SSH process.
import { utils } from 'ssh2';
import { parseSshPublicKey, SshPublicKeysSchema } from './ssh-public-key';
import {
  ClaimRemoteSchema,
  InstallHostSchema,
} from '../../modules/remotes/operations/remote-operation.dto';
import { CreateVmSchema, ResetVmSchema } from '../../modules/remotes/operations/vm-operations.dto';

describe('SSH public key validation', () => {
  const ed25519 = utils.generateKeyPairSync('ed25519').public;
  it.each([
    ['ed25519', {}],
    ['rsa', { bits: 2048 }],
    ['ecdsa', { bits: 256 }],
    ['ecdsa', { bits: 384 }],
    ['ecdsa', { bits: 521 }],
  ] as const)('accepts OpenSSH %s keys %j and preserves comments', (type, options) => {
    const content = `${utils.generateKeyPairSync(type, options).public} user@PC`;
    expect(parseSshPublicKey(content)).toMatchObject({
      type: content.split(' ')[0],
      comment: 'user@PC',
    });
  });
  it.each([
    'ssh-ed25519 AAAA',
    `ssh-rsa ${ed25519.split(' ')[1]}`,
    `${ed25519}\n${ed25519}`,
    `from="PC" ${ed25519}`,
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'ssh-unknown aaaa',
    `${ed25519}\u0000`,
  ])('refuses malformed keys %#', (key) => {
    expect(parseSshPublicKey(key)).toBeNull();
    expect(SshPublicKeysSchema.safeParse([key]).success).toBe(false);
  });
  it('carries optional keys through every strict setup request schema', () => {
    const requests = [
      [ClaimRemoteSchema, { baseUrl: 'https://vm:3000', certificateFingerprint: 'AB'.repeat(32) }],
      [
        InstallHostSchema,
        { address: 'vm', ssh: { user: 'admin', password: 'secret' }, minDiskGib: 8 },
      ],
      [CreateVmSchema, { name: 'vm', cores: 2, memory: 4096, disk: 30 }],
      [ResetVmSchema, {}],
    ] as const;
    for (const [schema, request] of requests) {
      expect(schema.parse({ ...request, sshPublicKeys: [ed25519] })).toMatchObject({
        sshPublicKeys: [ed25519],
      });
      expect(schema.safeParse(request).success).toBe(true);
      expect(schema.safeParse({ ...request, sshPublicKeys: ['not a key'] }).success).toBe(false);
    }
  });
});

import { generateKeyPairSync } from 'node:crypto';

function sshField(value: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length);
  return Buffer.concat([length, value]);
}

/**
 * A fresh OpenSSH ed25519 public key line, such as `ssh-ed25519 AAAA…`. Use it
 * instead of ssh2's `utils.generateKeyPairSync('ed25519').public`: ssh2 drops a
 * leading zero byte from about 1 in 256 public keys, and the strict key
 * validator correctly rejects the resulting 31-byte key.
 */
export function generateEd25519PublicKey(): string {
  const { publicKey } = generateKeyPairSync('ed25519');
  // An ed25519 SPKI DER ends with the 32 raw public key bytes.
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const blob = Buffer.concat([sshField(Buffer.from('ssh-ed25519')), sshField(raw)]);
  return `ssh-ed25519 ${blob.toString('base64')}`;
}

import { z } from 'zod';

export const MAX_SSH_PUBLIC_KEY_BYTES = 16_384;
export const SSH_PUBLIC_KEY_MESSAGE =
  'Enter a single OpenSSH public key, such as ssh-ed25519 AAAA…; private keys and key options are not accepted.';

const KEY_TYPES = new Set([
  'ssh-ed25519',
  'ssh-rsa',
  'ssh-dss',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com',
]);

const ECDSA_POINT_BYTES: Record<string, number> = { nistp256: 65, nistp384: 97, nistp521: 133 };

/** The single source of the accepted key types; options parsing relies on it too. */
export function isKnownSshKeyType(type: string): boolean {
  return KEY_TYPES.has(type);
}

export interface SshPublicKey {
  type: string;
  body: string;
  comment: string;
}

export function parseSshPublicKey(content: string): SshPublicKey | null {
  if (content.length > MAX_SSH_PUBLIC_KEY_BYTES || /[\r\n\x00-\x08\x0b-\x1f\x7f]/.test(content))
    return null;
  const match = /^([^\s]+)[ \t]+([A-Za-z0-9+/]+={0,2})(?:[ \t]+(.*))?$/.exec(content.trim());
  if (!match || !KEY_TYPES.has(match[1])) return null;
  const [, type, body, comment = ''] = match;
  try {
    const binary = atob(body);
    if (btoa(binary).replace(/=+$/, '') !== body.replace(/=+$/, '')) return null;
    let offset = 0;
    const field = (): string => {
      if (offset + 4 > binary.length) throw new Error('Truncated key');
      const length =
        binary.charCodeAt(offset) * 0x1000000 +
        (binary.charCodeAt(offset + 1) << 16) +
        (binary.charCodeAt(offset + 2) << 8) +
        binary.charCodeAt(offset + 3);
      offset += 4;
      if (length === 0 || offset + length > binary.length) throw new Error('Invalid key field');
      const value = binary.slice(offset, offset + length);
      offset += length;
      return value;
    };
    if (field() !== type) return null;
    if (type.includes('ed25519')) {
      if (field().length !== 32) return null;
    } else if (type.includes('ecdsa')) {
      const curve = type.match(/nistp(256|384|521)/)![0];
      if (field() !== curve) return null;
      const point = field();
      if (point.length !== ECDSA_POINT_BYTES[curve] || point.charCodeAt(0) !== 4) return null;
    } else {
      const count = type === 'ssh-rsa' ? 2 : 4;
      for (let index = 0; index < count; index++) field();
    }
    if (type.startsWith('sk-')) field();
    return offset === binary.length ? { type, body, comment } : null;
  } catch {
    return null;
  }
}

export const SshPublicKeySchema = z
  .string()
  .max(MAX_SSH_PUBLIC_KEY_BYTES)
  .refine((value) => parseSshPublicKey(value) !== null, SSH_PUBLIC_KEY_MESSAGE)
  .transform((value) => value.trim());

export const SshPublicKeysSchema = z.array(SshPublicKeySchema).max(32);

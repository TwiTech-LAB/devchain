import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import type { VaultKdfParams, VaultKeySlotKind } from '../storage/models/domain.models';

export const VAULT_KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const ENVELOPE_FORMAT = 'v1';

/** 160 random bits: 32 Crockford base32 characters, shown in groups of four. */
const RECOVERY_CODE_BYTES = 20;
const RECOVERY_CODE_LENGTH = 32;
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 32 MiB per derivation; the recovery code itself carries the entropy. */
const SCRYPT_DEFAULTS = { N: 32768, r: 8, p: 1 } as const;
const SCRYPT_SALT_BYTES = 16;

export class VaultEnvelopeError extends Error {
  constructor(message = 'The sealed value cannot be opened.') {
    super(message);
    this.name = 'VaultEnvelopeError';
  }
}

export function generateVaultKey(): Buffer {
  return randomBytes(VAULT_KEY_LENGTH);
}

/**
 * The AAD of one stored value. Each part must be non-empty and free of `|`, so
 * two different bindings can never produce the same AAD string.
 */
export function valueAad(
  domain: string,
  recordId: string,
  field: string,
  dekVersion: number,
): string {
  for (const part of [domain, recordId, field]) {
    if (part.length === 0 || part.includes('|')) {
      throw new VaultEnvelopeError('Vault AAD parts must be non-empty and must not contain "|".');
    }
  }
  return `devchain-vault|${domain}|${recordId}|${field}|${dekVersion}`;
}

/** The AAD of one wrapped data key: a wrapped copy cannot move to another slot. */
export function slotAad(
  vaultId: string,
  slotId: string,
  kind: VaultKeySlotKind,
  dekVersion: number,
): string {
  return `devchain-vault-slot|${vaultId}|${slotId}|${kind}|${dekVersion}`;
}

/** `v1:<dek version>:<base64 iv|tag|ciphertext>` under AES-256-GCM. */
export function seal(key: Buffer, dekVersion: number, aad: string, plaintext: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: AUTH_TAG_LENGTH });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const body = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  return `${ENVELOPE_FORMAT}:${dekVersion}:${body}`;
}

function parseEnvelope(envelope: string): { dekVersion: number; body: Buffer } {
  const parts = envelope.split(':');
  const dekVersion = Number(parts[1]);
  if (
    parts.length !== 3 ||
    parts[0] !== ENVELOPE_FORMAT ||
    !Number.isSafeInteger(dekVersion) ||
    dekVersion < 1
  ) {
    throw new VaultEnvelopeError('Unsupported Vault envelope format.');
  }
  return { dekVersion, body: Buffer.from(parts[2], 'base64') };
}

export function envelopeDekVersion(envelope: string): number {
  return parseEnvelope(envelope).dekVersion;
}

/** Throws `VaultEnvelopeError` for a wrong key, a wrong AAD or a damaged envelope. */
export function open(key: Buffer, aad: string, envelope: string): Buffer {
  const { body } = parseEnvelope(envelope);
  if (body.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new VaultEnvelopeError();
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, body.subarray(0, IV_LENGTH), {
      authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(body.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH));
    return Buffer.concat([
      decipher.update(body.subarray(IV_LENGTH + AUTH_TAG_LENGTH)),
      decipher.final(),
    ]);
  } catch {
    throw new VaultEnvelopeError();
  }
}

export function generateRecoveryCode(): string {
  const bytes = randomBytes(RECOVERY_CODE_BYTES);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.match(/.{4}/g)!.join('-');
}

/**
 * The 20 secret bytes of a typed recovery code, or null when the text cannot be
 * one. Case, spaces and dashes do not matter; O reads as 0 and I or L as 1.
 */
export function parseRecoveryCode(input: string): Buffer | null {
  const normalized = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (normalized.length !== RECOVERY_CODE_LENGTH) return null;
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of normalized) {
    const index = CROCKFORD_ALPHABET.indexOf(char);
    if (index < 0) return null;
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function newRecoveryKdfParams(): VaultKdfParams {
  return {
    algorithm: 'scrypt',
    salt: randomBytes(SCRYPT_SALT_BYTES).toString('base64'),
    ...SCRYPT_DEFAULTS,
  };
}

export function deriveRecoveryKek(secret: Buffer, params: VaultKdfParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      secret,
      Buffer.from(params.salt, 'base64'),
      VAULT_KEY_LENGTH,
      { N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

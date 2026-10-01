import { X509Certificate } from 'node:crypto';

/** Node's colon-separated `fingerprint256` as upper-case hex without colons. */
export function fingerprintHex(fingerprint256: string): string {
  return fingerprint256.replace(/:/g, '').toUpperCase();
}

/** The upper-case hex SHA-256 fingerprint of a PEM certificate, without colons. */
export function certificateFingerprint(pem: string): string {
  return fingerprintHex(new X509Certificate(pem).fingerprint256);
}

/** One certificate (PEM, or DER bytes) in canonical PEM form; throws when it does not parse as one. */
export function normalizeCertificate(certificate: string | Buffer): string {
  return new X509Certificate(certificate).toString();
}

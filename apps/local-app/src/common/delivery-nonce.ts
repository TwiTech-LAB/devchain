import { randomBytes } from 'crypto';

/**
 * Generate a 7-char hex nonce for delivery confirmation.
 * 28 bits of randomness — sufficient for uniqueness within a session.
 */
export function generateDeliveryNonce(): string {
  return randomBytes(4).toString('hex').slice(0, 7);
}

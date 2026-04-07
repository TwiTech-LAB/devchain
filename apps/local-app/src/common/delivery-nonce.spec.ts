import { generateDeliveryNonce } from './delivery-nonce';

describe('generateDeliveryNonce', () => {
  it('returns a 7-character hex string', () => {
    const nonce = generateDeliveryNonce();
    expect(nonce).toHaveLength(7);
    expect(nonce).toMatch(/^[0-9a-f]{7}$/);
  });

  it('returns unique values on consecutive calls', () => {
    const samples = Array.from({ length: 20 }, () => generateDeliveryNonce());
    const unique = new Set(samples);
    // With 28 bits of entropy the probability of any collision in 20 calls
    // is negligible (~20^2 / 2^29 ≈ 0.00007), so we expect all 20 to differ.
    expect(unique.size).toBe(samples.length);
  });
});

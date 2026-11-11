import {
  generateRecoveryCode,
  generateVaultKey,
  open,
  parseRecoveryCode,
  seal,
  valueAad,
  VaultEnvelopeError,
} from './vault-crypto';

// Pure unit: envelope and recovery-code formats need no storage or DI.
describe('vault crypto', () => {
  it('opens an envelope only under the key and AAD it was sealed with', () => {
    const key = generateVaultKey();
    const envelope = seal(key, 1, 'aad-a', Buffer.from('canary'));

    expect(open(key, 'aad-a', envelope).toString()).toBe('canary');
    expect(() => open(key, 'aad-b', envelope)).toThrow(VaultEnvelopeError);
    expect(() => open(generateVaultKey(), 'aad-a', envelope)).toThrow(VaultEnvelopeError);
  });

  it.each([
    ['an unknown format version', (envelope: string) => envelope.replace(/^v1:/, 'v2:')],
    ['a missing data-key version', (envelope: string) => envelope.replace(/^v1:1:/, 'v1::')],
    ['a truncated body', (envelope: string) => envelope.slice(0, 12)],
  ])('refuses an envelope with %s', (_label, damage) => {
    const key = generateVaultKey();
    const envelope = seal(key, 1, 'aad', Buffer.from('canary'));
    expect(() => open(key, 'aad', damage(envelope))).toThrow(VaultEnvelopeError);
  });

  it('refuses AAD parts that could make two bindings collide', () => {
    expect(() => valueAad('domain', 'a|b', 'field', 1)).toThrow(VaultEnvelopeError);
    expect(() => valueAad('domain', '', 'field', 1)).toThrow(VaultEnvelopeError);
  });

  it('reads a recovery code typed in lower case, with spaces, O for 0 and L for 1', () => {
    const code = generateRecoveryCode();
    const typed = code.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l');

    expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(parseRecoveryCode(typed)).toEqual(parseRecoveryCode(code));
    expect(parseRecoveryCode(code)).toHaveLength(20);
  });

  it.each([
    ['too short', 'ABCD-EFGH'],
    ['a letter outside the alphabet', 'U'.repeat(32)],
  ])('refuses a recovery code that is %s', (_label, code) => {
    expect(parseRecoveryCode(code)).toBeNull();
  });
});

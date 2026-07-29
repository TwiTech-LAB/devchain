import { CreateProviderConfigSchema, UpdateProviderConfigSchema } from './dto';

describe('provider configuration context-window env validation', () => {
  it.each(['1', '1000000', '10000000'])('accepts valid value %s', (value) => {
    expect(
      UpdateProviderConfigSchema.safeParse({
        env: { DEVCHAIN_CONTEXT_WINDOW_TOKENS: value },
      }).success,
    ).toBe(true);
  });

  it.each(['', '0', '-1', '1.5', '10000001', '9007199254740992'])(
    'rejects invalid value %j without including it in the message',
    (value) => {
      const result = UpdateProviderConfigSchema.safeParse({
        env: { DEVCHAIN_CONTEXT_WINDOW_TOKENS: value },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toEqual(['env', 'DEVCHAIN_CONTEXT_WINDOW_TOKENS']);
        expect(result.error.issues[0].message).toBe(
          'DEVCHAIN_CONTEXT_WINDOW_TOKENS must be a positive integer no greater than 10000000.',
        );
      }
    },
  );

  it('applies the same validation on create', () => {
    expect(
      CreateProviderConfigSchema.safeParse({
        providerId: 'provider-1',
        name: 'default',
        env: { DEVCHAIN_CONTEXT_WINDOW_TOKENS: 'invalid' },
      }).success,
    ).toBe(false);
  });
});

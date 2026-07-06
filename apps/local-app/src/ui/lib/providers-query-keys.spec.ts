import { providersQueryKeys } from './providers-query-keys';

describe('providersQueryKeys', () => {
  describe('list', () => {
    it('produces the canonical global provider-list key', () => {
      expect(providersQueryKeys.list()).toEqual(['providers']);
    });

    it('returns the same key shape on every call (no params, no scoping)', () => {
      expect(providersQueryKeys.list()).toEqual(providersQueryKeys.list());
    });
  });

  describe('preflight', () => {
    it('scopes by rootPath when provided', () => {
      expect(providersQueryKeys.preflight('/repo/x')).toEqual([
        'preflight',
        'providers-page',
        '/repo/x',
      ]);
    });

    it('falls back to the global scope when rootPath is absent or empty', () => {
      expect(providersQueryKeys.preflight()).toEqual(['preflight', 'providers-page', 'global']);
      expect(providersQueryKeys.preflight(undefined)).toEqual([
        'preflight',
        'providers-page',
        'global',
      ]);
    });

    it('preserves an explicit empty-string rootPath verbatim (does not coerce to global)', () => {
      // The original code used `rootPath ?? 'global'`, so only null/undefined
      // fall back. An empty string is a real (if unusual) value and must round-trip.
      expect(providersQueryKeys.preflight('')).toEqual(['preflight', 'providers-page', '']);
    });
  });

  describe('preflightAll (broad invalidation prefix)', () => {
    it('is a strict prefix of every preflight(rootPath) variant', () => {
      const broad = providersQueryKeys.preflightAll();
      expect(broad).toEqual(['preflight', 'providers-page']);

      const scoped = providersQueryKeys.preflight('/repo/x');
      // TanStack prefix-match: broad must equal the first len(broad) elements of scoped.
      expect(scoped.slice(0, broad.length)).toEqual(broad);
      expect(providersQueryKeys.preflight().slice(0, broad.length)).toEqual(broad);
    });
  });
});

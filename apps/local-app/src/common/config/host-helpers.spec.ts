import { getRuntimeInternalBaseUrl } from './host-helpers';

describe('host-helpers', () => {
  describe('getRuntimeInternalBaseUrl', () => {
    it.each([
      [{ HOST: '0.0.0.0', PORT: 3000 }, 'http://127.0.0.1:3000'],
      [{ HOST: '::', PORT: 4000 }, 'http://[::1]:4000'],
    ])('getRuntimeInternalBaseUrl(%j) = %s', (config, expected) => {
      expect(getRuntimeInternalBaseUrl(config)).toBe(expected);
    });
  });
});

/**
 * Host helper conformance tests migrated to packages/shared/src/host-resolver.spec.ts
 *
 * All normalizeHost, isWildcardHost, isNonLoopbackHost, connectableHost,
 * formatHostForUrl, buildInternalBaseUrl, and buildDisplayUrls tests
 * now live in the @devchain/shared conformance suite (92 tests).
 *
 * This file verifies the dynamic import path works from CJS context.
 */

const path = require('path');

// TODO [quarantine]: Requires --experimental-vm-modules (Node flag) for CJS→ESM dynamic import.
// Jest cannot support this without NODE_OPTIONS=--experimental-vm-modules.
// Conformance coverage exists in packages/shared/src/host-resolver.spec.ts (92 tests).
// Backlog [b5344e51]: re-enable when test runner supports --experimental-vm-modules
describe.skip('HostResolver CJS dynamic import', () => {
  it('resolves HostResolver from @devchain/shared via dynamic import', async () => {
    const { HostResolver } = await import('@devchain/shared');
    expect(HostResolver).toBeDefined();
    expect(typeof HostResolver.buildInternalBaseUrl).toBe('function');
    expect(typeof HostResolver.normalizeHost).toBe('function');
    expect(typeof HostResolver.isWildcardHost).toBe('function');
    expect(typeof HostResolver.connectableHost).toBe('function');
    expect(typeof HostResolver.formatHostForUrl).toBe('function');
    expect(typeof HostResolver.isNonLoopbackHost).toBe('function');
    expect(typeof HostResolver.buildDisplayUrls).toBe('function');
  });

  it('produces identical results for key cases', async () => {
    const { HostResolver } = await import('@devchain/shared');
    expect(HostResolver.buildInternalBaseUrl({ host: '0.0.0.0', port: 3000 })).toBe(
      'http://127.0.0.1:3000',
    );
    expect(HostResolver.buildInternalBaseUrl({ host: '::', port: 3000 })).toBe(
      'http://[::1]:3000',
    );
    expect(HostResolver.normalizeHost('')).toBe('127.0.0.1');
    expect(HostResolver.isNonLoopbackHost('192.168.1.10')).toBe(true);
    expect(HostResolver.isNonLoopbackHost('127.0.0.1')).toBe(false);
    expect(HostResolver.buildDisplayUrls({ host: '0.0.0.0', port: 3000 }).primary).toBe(
      'http://127.0.0.1:3000',
    );
  });
});

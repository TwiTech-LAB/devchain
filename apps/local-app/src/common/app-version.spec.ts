/**
 * The version /api/runtime reports, which the remote version gate compares.
 * Test layer: unit — a temp directory reproduces the published package layout.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('getAppVersion', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'app-version-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    jest.resetModules();
  });

  it('reads the package version in the published layout (dist/server/common)', () => {
    const packageRoot = join(root, 'lib', 'node_modules', 'devchain-cli');
    const commonDir = join(packageRoot, 'dist', 'server', 'common');
    mkdirSync(commonDir, { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'devchain-cli', version: '9.8.7' }),
    );
    // Evaluate the module as if it were installed there.
    jest.isolateModules(() => {
      jest.doMock('path', () => {
        const actual = jest.requireActual<typeof import('path')>('path');
        return {
          ...actual,
          join: (first: string, ...rest: string[]) =>
            actual.join(first === __dirname ? commonDir : first, ...rest),
        };
      });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getAppVersion } = require('./app-version') as typeof import('./app-version');
      expect(getAppVersion()).toBe('9.8.7');
    });
  });
});

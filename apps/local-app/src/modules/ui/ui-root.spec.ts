import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveUiAssetPaths, resolveUiRoot } from './ui-root';

describe('UI root resolution', () => {
  let fixtureRoot: string;

  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'devchain-ui-root-'));
  });

  afterEach(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it.each([
    ['apps/local-app/src/modules/ui', 'apps/local-app/dist/ui'],
    ['dist/server/modules/ui', 'dist/server/ui'],
  ])('resolves UI root from %s', async (runtimePath, uiPath) => {
    const runtimeDirectory = join(fixtureRoot, runtimePath);
    const expectedRoot = join(fixtureRoot, uiPath);
    await mkdir(runtimeDirectory, { recursive: true });
    await mkdir(expectedRoot, { recursive: true });
    await writeFile(join(expectedRoot, 'index.html'), 'source fixture', 'utf8');

    expect(resolveUiRoot(runtimeDirectory)).toBe(expectedRoot);
  });

  it('allowlists only top-level Vite asset files and the favicon', async () => {
    const root = join(fixtureRoot, 'ui');
    await mkdir(join(root, 'assets', 'nested'), { recursive: true });
    await Promise.all([
      writeFile(join(root, 'assets', 'app.js'), 'js', 'utf8'),
      writeFile(join(root, 'assets', 'app.css'), 'css', 'utf8'),
      writeFile(join(root, 'assets', '.hidden'), 'hidden', 'utf8'),
      writeFile(join(root, 'assets', 'nested', 'chunk.js'), 'nested', 'utf8'),
      writeFile(join(root, 'favicon.svg'), '<svg/>', 'utf8'),
    ]);

    expect(resolveUiAssetPaths(root)).toEqual(
      new Set(['assets/app.js', 'assets/app.css', 'favicon.svg']),
    );
  });
});

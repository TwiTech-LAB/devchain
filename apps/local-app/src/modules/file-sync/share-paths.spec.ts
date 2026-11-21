import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { assertSharePath, managedHomePaths, shareFolderId } from './share-paths';

// Unit over a real temporary home: links, missing folders and canonical paths are file-system
// behavior, so a mocked disk would hide the bugs these rules exist to catch.

const root = realpathSync(mkdtempSync(join(tmpdir(), 'devchain-share-paths-')));
const home = join(root, 'home');
const at = (path: string) => join(home, path);
const side = {
  devchainHome: at('.devchain'),
  projectRoots: [at('code/app'), home],
  otherShares: [at('shared/docs')],
};
// The Devin config follows XDG_CONFIG_HOME; the cases expect its default place under home.
const originalXdg = process.env.XDG_CONFIG_HOME;
delete process.env.XDG_CONFIG_HOME;

beforeAll(() => {
  for (const dir of ['real', 'code/app', '.claude/skills', 'shared/docs'])
    mkdirSync(at(dir), { recursive: true });
  symlinkSync(at('real'), at('link'));
});

afterAll(() => {
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  rmSync(root, { recursive: true, force: true });
});

describe('assertSharePath', () => {
  const managed = () => managedHomePaths(home);
  const managedOverlap = /overlaps (a file DevChain manages|the DevChain data folder)/;

  it.each<[string, () => string, RegExp]>([
    ['a relative path', () => 'notes', /not an absolute path/],
    ['a path outside home', () => join(root, 'outside'), /inside the home folder/],
    ['home itself', () => home, /home directory/],
    ['a linked target', () => at('link'), /is a link/],
    ['a path under a linked parent', () => at('link/child'), /is a link/],
    ['~/.devchain', () => at('.devchain'), /the DevChain data folder/],
    ['a folder inside ~/.devchain', () => at('.devchain/skills'), /the DevChain data folder/],
    ['a project root', () => at('code/app'), /a project folder/],
    ['a folder inside a project', () => at('code/app/src'), /a project folder/],
    ['a folder containing a project', () => at('code'), /a project folder/],
    ['another share', () => at('shared/docs'), /another shared folder/],
    ['a folder inside another share', () => at('shared/docs/a'), /another shared folder/],
    ['a folder containing another share', () => at('shared'), /another shared folder/],
    ['~/.claude, which holds managed files', () => at('.claude'), managedOverlap],
    ...managed().flatMap(
      (file): Array<[string, () => string, RegExp]> => [
        [`managed file ${file}`, () => file, managedOverlap],
        [`a path inside managed file ${file}`, () => join(file, 'child'), managedOverlap],
        [`the folder containing managed file ${file}`, () => dirname(file), managedOverlap],
      ],
    ),
  ])('refuses %s', async (_case, path, reason) => {
    await expect(assertSharePath(path(), side, home)).rejects.toThrow(reason);
  });

  it.each([
    ['a folder beside managed files', '.claude/skills'],
    ['a missing folder, resolved through its existing parent', 'notes/new/deeper'],
  ])('allows %s and returns its canonical path', async (_case, path) => {
    await expect(assertSharePath(at(path), side, home)).resolves.toBe(at(path));
  });
});

describe('shareFolderId', () => {
  it('is stable for one path and its unnormalized spelling, and differs between paths', () => {
    expect(shareFolderId(at('notes'))).toMatch(/^share:[0-9a-f]{16}$/);
    expect(shareFolderId(at('notes/'))).toBe(shareFolderId(at('x/../notes')));
    expect(shareFolderId(at('notes'))).not.toBe(shareFolderId(at('notes2')));
  });
});

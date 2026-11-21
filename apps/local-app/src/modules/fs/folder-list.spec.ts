import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listFolders } from './folder-list';

const root = mkdtempSync(join(tmpdir(), 'devchain-folder-list-'));
const home = join(root, 'home');
const outside = join(root, 'outside');
for (const dir of ['b', 'a', '.hidden', 'a/inner', 'locked'])
  mkdirSync(join(home, dir), { recursive: true });
mkdirSync(outside);
writeFileSync(join(home, 'file.txt'), 'x');
symlinkSync(join(home, 'a'), join(home, 'link-to-a'));
symlinkSync(outside, join(home, 'escape'));
symlinkSync(join(home, 'file.txt'), join(home, 'link-to-file'));
afterAll(() => {
  chmodSync(join(home, 'locked'), 0o755);
  rmSync(root, { recursive: true, force: true });
});

it('lists the subfolders of home by default, sorted, without files or hidden folders', async () => {
  const list = await listFolders({ showHidden: false }, home);
  expect(list.path).toBe(home);
  expect(list.parent).toBeNull();
  expect(list.entries.map((entry) => [entry.name, entry.link])).toEqual([
    ['a', false],
    ['b', false],
    ['escape', true],
    ['link-to-a', true],
    ['locked', false],
  ]);
});

it('lists hidden folders when asked', async () => {
  const list = await listFolders({ showHidden: true }, home);
  expect(list.entries[0]).toEqual({
    name: '.hidden',
    path: join(home, '.hidden'),
    hidden: true,
    link: false,
  });
});

it('returns the parent below home', async () => {
  const list = await listFolders({ path: join(home, 'a'), showHidden: false }, home);
  expect(list).toEqual({
    path: join(home, 'a'),
    parent: home,
    entries: [{ name: 'inner', path: join(home, 'a', 'inner'), hidden: false, link: false }],
  });
});

it.each([
  ['a path outside home', () => outside],
  ['the parent of home', () => root],
  ['a link that leaves home', () => join(home, 'escape')],
])('refuses %s', async (_what, path) => {
  await expect(listFolders({ path: path(), showHidden: false }, home)).rejects.toMatchObject({
    code: 'FS_LIST_OUTSIDE_HOME',
    statusCode: 403,
  });
});

it.each([
  ['a missing folder', 'missing', 'FS_LIST_NOT_FOUND', 404],
  ['a file', 'file.txt', 'FS_LIST_NOT_FOLDER', 400],
])('answers %s with an error code', async (_what, name, code, statusCode) => {
  await expect(
    listFolders({ path: join(home, name), showHidden: false }, home),
  ).rejects.toMatchObject({ code, statusCode });
});

const isRoot = process.getuid?.() === 0;
(isRoot ? it.skip : it)('answers an unreadable folder with an error code', async () => {
  chmodSync(join(home, 'locked'), 0o000);
  await expect(
    listFolders({ path: join(home, 'locked'), showHidden: false }, home),
  ).rejects.toMatchObject({ code: 'FS_LIST_UNREADABLE', statusCode: 403 });
});

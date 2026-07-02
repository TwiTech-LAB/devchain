import * as os from 'os';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, stat } from 'fs/promises';
import { join, dirname } from 'path';
import { AntigravityTrustedWorkspacesService } from './antigravity-trusted-workspaces.service';

// `os.homedir` is read-only, so mock the module and override homedir per-test.
jest.mock('os', () => {
  const actual = jest.requireActual('os');
  return { ...actual, homedir: jest.fn(() => actual.homedir()) };
});

describe('AntigravityTrustedWorkspacesService', () => {
  let home: string;
  let projectDir: string;
  let service: AntigravityTrustedWorkspacesService;

  const settingsPath = () => join(home, '.gemini', 'antigravity-cli', 'settings.json');
  const trustedFoldersPath = () => join(home, '.gemini', 'trustedFolders.json');

  const readJson = async (p: string) => JSON.parse(await readFile(p, 'utf-8'));
  const writeJson = async (p: string, value: unknown) => {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  };

  beforeEach(async () => {
    home = await mkdtemp(join(os.tmpdir(), 'agy-trust-home-'));
    projectDir = await mkdtemp(join(os.tmpdir(), 'agy-trust-proj-'));
    (os.homedir as jest.Mock).mockReturnValue(home);
    service = new AntigravityTrustedWorkspacesService();
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  it('writes the path into BOTH stores on a fresh install', async () => {
    const expected = await realpath(projectDir);

    const result = await service.ensure(projectDir);

    expect(result.success).toBe(true);
    expect(result.warnings).toEqual([]);

    const settings = await readJson(settingsPath());
    expect(settings.trustedWorkspaces).toEqual([expected]);

    const folders = await readJson(trustedFoldersPath());
    expect(folders[expected]).toBe('TRUST_FOLDER');
  });

  it('is idempotent — no duplicate entries on repeated calls', async () => {
    await service.ensure(projectDir);
    const result = await service.ensure(projectDir);

    expect(result.success).toBe(true);
    const settings = await readJson(settingsPath());
    expect(settings.trustedWorkspaces).toHaveLength(1);
    const folders = await readJson(trustedFoldersPath());
    expect(Object.keys(folders)).toHaveLength(1);
  });

  it('preserves existing settings keys and prior trustedWorkspaces entries', async () => {
    await writeJson(settingsPath(), {
      model: 'Gemini 3.5 Flash (High)',
      trustedWorkspaces: ['/some/other/path'],
    });
    const expected = await realpath(projectDir);

    await service.ensure(projectDir);

    const settings = await readJson(settingsPath());
    expect(settings.model).toBe('Gemini 3.5 Flash (High)');
    expect(settings.trustedWorkspaces).toEqual(['/some/other/path', expected]);
  });

  it('writes files atomically with mode 0600', async () => {
    await service.ensure(projectDir);
    const mode = (await stat(settingsPath())).mode & 0o777;
    expect(mode).toBe(0o600);
    const foldersMode = (await stat(trustedFoldersPath())).mode & 0o777;
    expect(foldersMode).toBe(0o600);
  });

  it('refuses to modify malformed settings.json (no data loss) and warns', async () => {
    await writeJson(settingsPath(), '{ this is not json');

    const result = await service.ensure(projectDir);

    expect(result.success).toBe(false);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'trusted_workspaces', code: 'AGY_SETTINGS_MALFORMED' }),
      ]),
    );
    // Original content untouched.
    expect(await readFile(settingsPath(), 'utf-8')).toBe('{ this is not json');
  });

  it('refuses to modify when trustedWorkspaces is not an array', async () => {
    await writeJson(settingsPath(), { trustedWorkspaces: 'oops' });

    const result = await service.ensure(projectDir);

    expect(result.success).toBe(false);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'AGY_TRUSTED_WORKSPACES_MALFORMED' }),
      ]),
    );
    const settings = await readJson(settingsPath());
    expect(settings.trustedWorkspaces).toBe('oops');
  });

  it('does not override an explicit DO_NOT_TRUST in trustedFolders, but still trusts the native store', async () => {
    const expected = await realpath(projectDir);
    await writeJson(trustedFoldersPath(), { [expected]: 'DO_NOT_TRUST' });

    const result = await service.ensure(projectDir);

    // Native agy store still trusts → overall success.
    expect(result.success).toBe(true);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'trusted_folders',
          code: 'AGY_TRUSTED_FOLDERS_DISTRUSTED',
        }),
      ]),
    );
    // trustedFolders NOT overridden.
    const folders = await readJson(trustedFoldersPath());
    expect(folders[expected]).toBe('DO_NOT_TRUST');
    // But the agy-native store was written.
    const settings = await readJson(settingsPath());
    expect(settings.trustedWorkspaces).toEqual([expected]);
  });

  it('surfaces a malformed trustedFolders.json as a warning without blocking the native store', async () => {
    await writeJson(trustedFoldersPath(), 'not json at all');

    const result = await service.ensure(projectDir);

    expect(result.success).toBe(true); // native store still written
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'trusted_folders',
          code: 'AGY_TRUSTED_FOLDERS_MALFORMED',
        }),
      ]),
    );
    expect(await readFile(trustedFoldersPath(), 'utf-8')).toBe('not json at all');
  });
});

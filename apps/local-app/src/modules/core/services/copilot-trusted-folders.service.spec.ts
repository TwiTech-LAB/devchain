import * as os from 'os';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, stat } from 'fs/promises';
import { join, dirname } from 'path';
import { CopilotTrustedFoldersService } from './copilot-trusted-folders.service';

// `os.homedir` is read-only, so mock the module and override homedir per-test.
jest.mock('os', () => {
  const actual = jest.requireActual('os');
  return { ...actual, homedir: jest.fn(() => actual.homedir()) };
});

const JSONC_HEADER =
  '// User settings belong in settings.json.\n// This file is managed automatically.';

describe('CopilotTrustedFoldersService', () => {
  let home: string;
  let projectDir: string;
  let service: CopilotTrustedFoldersService;

  const configPath = () => join(home, '.copilot', 'config.json');

  const readRaw = (p: string) => readFile(p, 'utf-8');
  const readJson = async (p: string) => {
    // Strip the JSONC comment header the same way copilot/the service does.
    const raw = await readRaw(p);
    const body = raw
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    return JSON.parse(body);
  };
  const writeRaw = async (p: string, value: string) => {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, value);
  };

  beforeEach(async () => {
    home = await mkdtemp(join(os.tmpdir(), 'copilot-trust-home-'));
    projectDir = await mkdtemp(join(os.tmpdir(), 'copilot-trust-proj-'));
    (os.homedir as jest.Mock).mockReturnValue(home);
    service = new CopilotTrustedFoldersService();
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  it('adds the realpath into trustedFolders[] on a fresh install (no config yet)', async () => {
    const expected = await realpath(projectDir);

    const result = await service.ensure(projectDir);

    expect(result.success).toBe(true);
    expect(result.warnings).toEqual([]);
    const config = await readJson(configPath());
    expect(config.trustedFolders).toEqual([expected]);
  });

  it('is idempotent — no duplicate entries on repeated calls', async () => {
    await service.ensure(projectDir);
    const result = await service.ensure(projectDir);

    expect(result.success).toBe(true);
    const config = await readJson(configPath());
    expect(config.trustedFolders).toHaveLength(1);
  });

  it('returns success without rewriting when the path is already trusted', async () => {
    const expected = await realpath(projectDir);
    await writeRaw(
      configPath(),
      `${JSONC_HEADER}\n${JSON.stringify({ trustedFolders: [expected] }, null, 2)}\n`,
    );

    const result = await service.ensure(projectDir);

    expect(result.success).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('preserves the JSONC comment header and ALL sibling keys (incl. https:// values)', async () => {
    const original = {
      firstLaunchAt: '2026-06-26T22:24:23.336Z',
      lastLoggedInUser: { host: 'https://github.com', login: 'vilnitsky' },
      loggedInUsers: [{ host: 'https://github.com', login: 'vilnitsky' }],
      trustedFolders: ['/existing/trusted'],
    };
    await writeRaw(configPath(), `${JSONC_HEADER}\n${JSON.stringify(original, null, 2)}\n`);
    const expected = await realpath(projectDir);

    const result = await service.ensure(projectDir);

    expect(result.success).toBe(true);
    const raw = await readRaw(configPath());
    // Comment header preserved verbatim.
    expect(raw.startsWith(JSONC_HEADER)).toBe(true);
    const config = await readJson(configPath());
    // Sibling keys (and the https:// URL values) preserved untouched.
    expect(config.firstLaunchAt).toBe('2026-06-26T22:24:23.336Z');
    expect(config.lastLoggedInUser).toEqual({ host: 'https://github.com', login: 'vilnitsky' });
    expect(config.loggedInUsers).toEqual([{ host: 'https://github.com', login: 'vilnitsky' }]);
    // New entry appended to the existing list.
    expect(config.trustedFolders).toEqual(['/existing/trusted', expected]);
  });

  it('writes the config atomically with mode 0600', async () => {
    await service.ensure(projectDir);
    const st = await stat(configPath());
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('refuses to modify a malformed config.json (no data loss) and warns', async () => {
    const garbage = `${JSONC_HEADER}\n{ this is not valid json `;
    await writeRaw(configPath(), garbage);

    const result = await service.ensure(projectDir);

    expect(result.success).toBe(false);
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'COPILOT_CONFIG_MALFORMED' }),
    ]);
    // File left byte-identical (no clobber).
    expect(await readRaw(configPath())).toBe(garbage);
  });

  it('refuses to modify when trustedFolders is not an array and warns', async () => {
    const original = `${JSONC_HEADER}\n${JSON.stringify({ trustedFolders: 'oops' }, null, 2)}\n`;
    await writeRaw(configPath(), original);

    const result = await service.ensure(projectDir);

    expect(result.success).toBe(false);
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'COPILOT_TRUSTED_FOLDERS_MALFORMED' }),
    ]);
    expect(await readRaw(configPath())).toBe(original);
  });

  it('refuses to modify when the root is not a JSON object and warns', async () => {
    const original = `${JSONC_HEADER}\n[1, 2, 3]\n`;
    await writeRaw(configPath(), original);

    const result = await service.ensure(projectDir);

    expect(result.success).toBe(false);
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'COPILOT_CONFIG_MALFORMED' }),
    ]);
    expect(await readRaw(configPath())).toBe(original);
  });

  it('preserves non-string entries already in trustedFolders (no data loss)', async () => {
    const original = { trustedFolders: ['/keep/me', 42] };
    await writeRaw(configPath(), `${JSONC_HEADER}\n${JSON.stringify(original, null, 2)}\n`);
    const expected = await realpath(projectDir);

    const result = await service.ensure(projectDir);

    expect(result.success).toBe(true);
    const config = await readJson(configPath());
    expect(config.trustedFolders).toEqual(['/keep/me', 42, expected]);
  });

  it('handles a config with no comment header (writes plain JSON)', async () => {
    await writeRaw(configPath(), `${JSON.stringify({ appTipShown: true }, null, 2)}\n`);
    const expected = await realpath(projectDir);

    const result = await service.ensure(projectDir);

    expect(result.success).toBe(true);
    const config = await readJson(configPath());
    expect(config.appTipShown).toBe(true);
    expect(config.trustedFolders).toEqual([expected]);
  });

  it('serializes concurrent ensure() calls without interleaving writes', async () => {
    const expected = await realpath(projectDir);
    const other = await mkdtemp(join(os.tmpdir(), 'copilot-trust-proj2-'));
    const otherExpected = await realpath(other);

    await Promise.all([service.ensure(projectDir), service.ensure(other)]);

    const config = await readJson(configPath());
    expect(config.trustedFolders).toEqual(expect.arrayContaining([expected, otherExpected]));
    expect(config.trustedFolders).toHaveLength(2);
    await rm(other, { recursive: true, force: true });
  });
});

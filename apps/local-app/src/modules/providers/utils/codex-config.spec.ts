import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fsPromises from 'fs/promises';
import { homedir } from 'os';
import { parse } from 'smol-toml';
import { ensureCodexProjectTrusted } from './codex-config';

jest.mock('fs/promises', () => {
  const actual = jest.requireActual<typeof import('fs/promises')>('fs/promises');
  return {
    ...actual,
    mkdir: jest.fn((path: string, options?: { mode?: number; recursive?: boolean }) =>
      actual.mkdir(path, options),
    ),
    chmod: jest.fn((path: string, mode: number) => actual.chmod(path, mode)),
    readFile: jest.fn((path: string, encoding: BufferEncoding) => actual.readFile(path, encoding)),
    realpath: jest.fn((path: string) => actual.realpath(path)),
    rename: jest.fn((oldPath: string, newPath: string) => actual.rename(oldPath, newPath)),
    stat: jest.fn((path: string) => actual.stat(path)),
    unlink: jest.fn((path: string) => actual.unlink(path)),
    writeFile: jest.fn(
      (path: string, data: string, options?: { encoding?: BufferEncoding; mode?: number }) =>
        actual.writeFile(path, data, options),
    ),
  };
});

jest.mock('os', () => ({
  ...jest.requireActual('os'),
  homedir: jest.fn(),
}));

const mockHomedir = homedir as jest.MockedFunction<typeof homedir>;
const mockChmod = jest.mocked(fsPromises.chmod);
const mockWriteFile = jest.mocked(fsPromises.writeFile);
const mockRename = jest.mocked(fsPromises.rename);

describe('Codex config project trust', () => {
  let homeDir: string;
  let originalCodexHome: string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    originalCodexHome = process.env.CODEX_HOME;
    delete process.env.CODEX_HOME;
    homeDir = mkdtempSync(join(tmpdir(), 'devchain-codex-config-'));
    mockHomedir.mockReturnValue(homeDir);
  });

  afterEach(() => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('creates trust entries for the registered and real project paths and skips an equal second write', async () => {
    const physicalPath = join(homeDir, 'physical project');
    const linkedPath = join(homeDir, 'linked project');
    mkdirSync(physicalPath);
    symlinkSync(physicalPath, linkedPath, 'dir');

    await expect(ensureCodexProjectTrusted(linkedPath)).resolves.toEqual({ success: true });

    const configPath = join(homeDir, '.codex', 'config.toml');
    const initialContent = readFileSync(configPath, 'utf-8');
    const parsed = parse(initialContent) as {
      projects: Record<string, { trust_level: string }>;
    };
    expect(parsed.projects[linkedPath]?.trust_level).toBe('trusted');
    expect(parsed.projects[physicalPath]?.trust_level).toBe('trusted');
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    expect(mockRename).toHaveBeenCalledTimes(1);

    mockWriteFile.mockClear();
    mockRename.mockClear();
    await expect(ensureCodexProjectTrusted(linkedPath)).resolves.toEqual({ success: true });

    expect(readFileSync(configPath, 'utf-8')).toBe(initialContent);
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockRename).not.toHaveBeenCalled();
  });

  it('uses the effective CODEX_HOME and does not write to the default Codex home', async () => {
    const projectPath = join(homeDir, 'project');
    const effectiveCodexHome = join(homeDir, 'provider-config', 'codex');
    const inheritedCodexHome = join(homeDir, 'inherited-codex');
    mkdirSync(projectPath);
    process.env.CODEX_HOME = inheritedCodexHome;

    await expect(
      ensureCodexProjectTrusted(projectPath, {
        env: { CODEX_HOME: effectiveCodexHome, HOME: join(homeDir, 'profile-home') },
      }),
    ).resolves.toEqual({ success: true });

    expect(readFileSync(join(effectiveCodexHome, 'config.toml'), 'utf-8')).toContain(
      `[projects."${projectPath}"]`,
    );
    expect(() => readFileSync(join(homeDir, '.codex', 'config.toml'), 'utf-8')).toThrow();
    expect(() => readFileSync(join(inheritedCodexHome, 'config.toml'), 'utf-8')).toThrow();
  });

  it('falls back to the launch HOME when CODEX_HOME is not set', async () => {
    const projectPath = join(homeDir, 'project');
    const launchHome = join(homeDir, 'launch-home');
    mkdirSync(projectPath);

    await expect(
      ensureCodexProjectTrusted(projectPath, { env: { HOME: launchHome } }),
    ).resolves.toEqual({ success: true });

    expect(readFileSync(join(launchHome, '.codex', 'config.toml'), 'utf-8')).toContain(
      'trust_level = "trusted"',
    );
  });

  it('updates an existing untrusted table while preserving all other bytes and comments', async () => {
    const projectPath = join(homeDir, 'project "quoted"');
    mkdirSync(projectPath);
    const codexHome = join(homeDir, '.codex');
    mkdirSync(codexHome);
    const configPath = join(codexHome, 'config.toml');
    const original = [
      '# Keep this file comment',
      'model = "o3" # Keep this inline comment',
      '',
      '[profiles.default]',
      'name = "personal"',
      'description = """',
      `[projects.${JSON.stringify(projectPath)}]`,
      'trust_level = "trusted"',
      '"""',
      '',
      `[projects.${JSON.stringify(projectPath)}] # keep this table comment`,
      'trust_level = "untrusted" # keep this assignment comment',
      'other = "keep this value"',
      '# Keep this section comment',
      '[notice]',
      'hide_gpt5_1_migration_prompt = true',
      '',
    ].join('\n');
    writeFileSync(configPath, original);
    chmodSync(configPath, 0o640);

    await expect(ensureCodexProjectTrusted(projectPath)).resolves.toEqual({ success: true });

    const expected = original.replace('trust_level = "untrusted"', 'trust_level = "trusted"');
    expect(readFileSync(configPath, 'utf-8')).toBe(expected);
    expect(statSync(configPath).mode & 0o777).toBe(0o640);
    expect(mockChmod).toHaveBeenCalledWith(
      expect.stringMatching(/config\.toml\.tmp\.[a-f0-9]+$/),
      0o640,
    );
    expect(parse(expected)).toEqual(parse(readFileSync(configPath, 'utf-8')));
  });

  it('appends the root project table when only a nested project table exists', async () => {
    const projectPath = join(homeDir, 'project');
    mkdirSync(projectPath);
    const codexHome = join(homeDir, '.codex');
    mkdirSync(codexHome);
    const configPath = join(codexHome, 'config.toml');
    const original = `[projects.${JSON.stringify(projectPath)}.metadata]\nlabel = "keep"\n`;
    writeFileSync(configPath, original);

    await expect(ensureCodexProjectTrusted(projectPath)).resolves.toEqual({ success: true });

    const config = parse(readFileSync(configPath, 'utf-8')) as {
      projects: Record<string, { metadata: { label: string }; trust_level: string }>;
    };
    expect(config.projects[projectPath]).toEqual({
      metadata: { label: 'keep' },
      trust_level: 'trusted',
    });
  });

  it('preserves CRLF line endings when updating a trust assignment', async () => {
    const projectPath = join(homeDir, 'project');
    mkdirSync(projectPath);
    const codexHome = join(homeDir, '.codex');
    mkdirSync(codexHome);
    const configPath = join(codexHome, 'config.toml');
    const original =
      `[projects.${JSON.stringify(projectPath)}]\r\n` + 'trust_level = "untrusted"\r\n';
    writeFileSync(configPath, original);

    await expect(ensureCodexProjectTrusted(projectPath)).resolves.toEqual({ success: true });

    expect(readFileSync(configPath, 'utf-8')).toBe(
      original.replace('trust_level = "untrusted"', 'trust_level = "trusted"'),
    );
  });

  it('leaves invalid TOML unchanged and returns a fixed-code warning result', async () => {
    const projectPath = join(homeDir, 'project');
    mkdirSync(projectPath);
    const codexHome = join(homeDir, '.codex');
    mkdirSync(codexHome);
    const configPath = join(codexHome, 'config.toml');
    const invalid = '[projects."unterminated]\ntrust_level = "trusted"\n';
    writeFileSync(configPath, invalid);

    await expect(ensureCodexProjectTrusted(projectPath)).resolves.toEqual({
      success: false,
      code: 'CODEX_TRUST_CONFIG_INVALID',
      message: 'Codex config contains invalid TOML.',
    });

    expect(readFileSync(configPath, 'utf-8')).toBe(invalid);
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockRename).not.toHaveBeenCalled();
  });

  it('serializes concurrent project updates to the same Codex config file', async () => {
    const projectA = join(homeDir, 'project-a');
    const projectB = join(homeDir, 'project-b');
    mkdirSync(projectA);
    mkdirSync(projectB);

    const results = await Promise.all([
      ensureCodexProjectTrusted(projectA),
      ensureCodexProjectTrusted(projectB),
    ]);

    expect(results).toEqual([{ success: true }, { success: true }]);
    const config = parse(readFileSync(join(homeDir, '.codex', 'config.toml'), 'utf-8')) as {
      projects: Record<string, { trust_level: string }>;
    };
    expect(config.projects[projectA]?.trust_level).toBe('trusted');
    expect(config.projects[projectB]?.trust_level).toBe('trusted');
  });
});

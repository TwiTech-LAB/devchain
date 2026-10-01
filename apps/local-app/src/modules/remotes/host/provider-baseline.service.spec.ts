import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fsPromises from 'fs/promises';
import { homedir } from 'os';
import { lock } from 'proper-lockfile';
import { HostHelperService } from './host-helper.service';
import {
  ProviderBaselineService,
  containsBaseline,
  mergeBaseline,
} from './provider-baseline.service';

const mockWarn = jest.fn();

jest.mock('fs/promises', () => {
  const actual = jest.requireActual<typeof import('fs/promises')>('fs/promises');
  return {
    ...actual,
    mkdir: jest.fn((path: string, options?: { mode?: number; recursive?: boolean }) =>
      actual.mkdir(path, options),
    ),
    readFile: jest.fn((path: string, encoding: BufferEncoding) => actual.readFile(path, encoding)),
    rename: jest.fn((oldPath: string, newPath: string) => actual.rename(oldPath, newPath)),
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

jest.mock('proper-lockfile', () => ({ lock: jest.fn() }));

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ warn: (...args: unknown[]) => mockWarn(...args) }),
}));

const mockHomedir = homedir as jest.MockedFunction<typeof homedir>;
const mockLock = lock as jest.MockedFunction<typeof lock>;

function createRelease(): Awaited<ReturnType<typeof lock>> {
  return jest.fn().mockResolvedValue(undefined) as unknown as Awaited<ReturnType<typeof lock>>;
}

describe('ProviderBaselineService', () => {
  let homeDir: string;
  let service: ProviderBaselineService;
  let isClaimedHost: jest.Mock<boolean, []>;

  beforeEach(() => {
    jest.clearAllMocks();
    homeDir = mkdtempSync(join(tmpdir(), 'devchain-provider-baseline-'));
    mockHomedir.mockReturnValue(homeDir);
    mockLock.mockResolvedValue(createRelease());
    isClaimedHost = jest.fn().mockReturnValue(true);
    service = new ProviderBaselineService({ isClaimedHost } as unknown as HostHelperService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('creates both Claude config files and preserves unrelated keys while merging env and attribution', async () => {
    const claudeConfigPath = join(homeDir, '.claude.json');
    const settingsDir = join(homeDir, '.claude');
    const settingsPath = join(settingsDir, 'settings.json');
    mkdirSync(settingsDir);
    writeFileSync(
      claudeConfigPath,
      JSON.stringify({ autoCompactEnabled: false, foreignState: { retained: true } }),
    );
    writeFileSync(
      settingsPath,
      JSON.stringify({
        customSetting: 'keep',
        skipDangerousModePermissionPrompt: false,
        attribution: { commit: 'old', pr: 'old', custom: 'keep' },
        env: { CUSTOM_ENV: 'keep', DISABLE_AUTOUPDATER: '0' },
      }),
    );

    await service.onApplicationBootstrap();

    expect(JSON.parse(readFileSync(claudeConfigPath, 'utf-8'))).toEqual({
      autoCompactEnabled: false,
      foreignState: { retained: true },
      hasCompletedOnboarding: true,
    });
    expect(JSON.parse(readFileSync(settingsPath, 'utf-8'))).toEqual({
      customSetting: 'keep',
      skipDangerousModePermissionPrompt: true,
      attribution: { commit: '', pr: '', custom: 'keep' },
      preferredNotifChannel: 'notifications_disabled',
      autoMemoryEnabled: false,
      promptSuggestionEnabled: false,
      env: { CUSTOM_ENV: 'keep', DISABLE_AUTOUPDATER: '1' },
    });
  });

  it('creates missing files and makes no content writes on a second start', async () => {
    await service.onApplicationBootstrap();

    const claudeConfigPath = join(homeDir, '.claude.json');
    const settingsPath = join(homeDir, '.claude', 'settings.json');
    const configBefore = readFileSync(claudeConfigPath, 'utf-8');
    const settingsBefore = readFileSync(settingsPath, 'utf-8');
    const writeFileSpy = jest.spyOn(fsPromises, 'writeFile');
    const renameSpy = jest.spyOn(fsPromises, 'rename');
    writeFileSpy.mockClear();
    renameSpy.mockClear();

    await service.onApplicationBootstrap();

    expect(readFileSync(claudeConfigPath, 'utf-8')).toBe(configBefore);
    expect(readFileSync(settingsPath, 'utf-8')).toBe(settingsBefore);
    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(renameSpy).not.toHaveBeenCalled();
  });

  it('leaves malformed files unchanged, logs warnings, and continues startup', async () => {
    const claudeConfigPath = join(homeDir, '.claude.json');
    const settingsDir = join(homeDir, '.claude');
    const settingsPath = join(settingsDir, 'settings.json');
    mkdirSync(settingsDir);
    writeFileSync(claudeConfigPath, '{ malformed claude config');
    writeFileSync(settingsPath, '{ malformed settings');

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();

    expect(readFileSync(claudeConfigPath, 'utf-8')).toBe('{ malformed claude config');
    expect(readFileSync(settingsPath, 'utf-8')).toBe('{ malformed settings');
    expect(mockWarn).toHaveBeenCalledTimes(2);
  });

  it('does not access config files on an unclaimed instance', async () => {
    isClaimedHost.mockReturnValue(false);
    const readSpy = jest.spyOn(fsPromises, 'readFile');
    const mkdirSpy = jest.spyOn(fsPromises, 'mkdir');
    const writeSpy = jest.spyOn(fsPromises, 'writeFile');
    const renameSpy = jest.spyOn(fsPromises, 'rename');

    await service.onApplicationBootstrap();

    expect(readSpy).not.toHaveBeenCalled();
    expect(mkdirSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
    expect(renameSpy).not.toHaveBeenCalled();
  });

  it('logs a Claude config lock failure and still applies settings without rejecting bootstrap', async () => {
    mockLock.mockRejectedValueOnce(new Error('lock timeout'));

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();

    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ errorType: 'io_error' }),
      'Could not apply the Claude config baseline',
    );
    expect(
      JSON.parse(readFileSync(join(homeDir, '.claude', 'settings.json'), 'utf-8')),
    ).toMatchObject({
      skipDangerousModePermissionPrompt: true,
      env: { DISABLE_AUTOUPDATER: '1' },
    });
  });
});

describe('baseline helpers', () => {
  // A key added to the baseline later must count as missing on a host that
  // holds only the older keys, so the next start writes it.
  const baseline = { flag: true, nested: { a: '1' }, addedLater: 'x' } as const;

  it('treats any missing baseline leaf, also a newly added one, as not applied', () => {
    expect(containsBaseline({ flag: true, nested: { a: '1' } }, baseline)).toBe(false);
    expect(containsBaseline({ flag: true, nested: {}, addedLater: 'x' }, baseline)).toBe(false);
    expect(
      containsBaseline(
        { flag: true, nested: { a: '1', b: 2 }, addedLater: 'x', other: 1 },
        baseline,
      ),
    ).toBe(true);
  });

  it('writes every baseline leaf and keeps other keys, also inside nested objects', () => {
    expect(mergeBaseline({ other: 1, flag: false, nested: { b: 2 } }, baseline)).toEqual({
      ok: true,
      value: { other: 1, flag: true, nested: { b: 2, a: '1' }, addedLater: 'x' },
    });
  });

  it('reports a nested baseline object that meets a non-object value', () => {
    expect(mergeBaseline({ nested: 'text' }, baseline)).toEqual({ ok: false, key: 'nested' });
  });
});

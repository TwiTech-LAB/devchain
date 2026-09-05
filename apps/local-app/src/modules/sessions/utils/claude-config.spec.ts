jest.mock('os', () => ({
  homedir: jest.fn(),
}));

jest.mock('fs/promises', () => ({
  readFile: jest.fn(),
  stat: jest.fn(),
  writeFile: jest.fn(),
  rename: jest.fn(),
  unlink: jest.fn(),
  realpath: jest.fn(),
}));

jest.mock('proper-lockfile', () => ({
  lock: jest.fn(),
}));

import { readFile, realpath, rename, stat, unlink, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { lock, type LockOptions } from 'proper-lockfile';
import {
  checkAutoCompactConfig,
  disableClaudeAutoCompact,
  enableClaudeAutoCompact,
  ensureClaudeProjectTrusted,
} from './claude-config';

const mockHomedir = homedir as jest.MockedFunction<typeof homedir>;
const mockReadFile = readFile as jest.MockedFunction<typeof readFile>;
const mockRealpath = realpath as jest.MockedFunction<typeof realpath>;
const mockStat = stat as jest.MockedFunction<typeof stat>;
const mockWriteFile = writeFile as jest.MockedFunction<typeof writeFile>;
const mockRename = rename as jest.MockedFunction<typeof rename>;
const mockUnlink = unlink as jest.MockedFunction<typeof unlink>;
const mockLock = lock as jest.MockedFunction<typeof lock>;

const CLAUDE_CONFIG_PATH = '/mock/home/.claude.json';
const TMP_PATH_PATTERN = /^\/mock\/home\/\.claude\.json\.tmp\.[0-9a-f]{8}$/;

function createEnoentError(): NodeJS.ErrnoException {
  const error = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

function createStatResult(mode: number): Awaited<ReturnType<typeof stat>> {
  return { mode } as Awaited<ReturnType<typeof stat>>;
}

function createRelease(): () => Promise<void> {
  return jest.fn().mockResolvedValue(undefined) as unknown as () => Promise<void>;
}

/**
 * Backing-store mock: reads reflect the latest write (including the post-write
 * verification reads), and a null initial value models a missing config file.
 */
function mockConfigBackingStore(initial: string | null): void {
  let content: string | null = initial;
  mockReadFile.mockImplementation(async () => {
    if (content === null) {
      throw createEnoentError();
    }
    return content;
  });
  mockWriteFile.mockImplementation(async (_path, data) => {
    content = data as string;
  });
}

describe('claude-config utils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHomedir.mockReturnValue('/mock/home');
    mockRealpath.mockImplementation(async (inputPath: string) => inputPath);
    mockReadFile.mockRejectedValue(createEnoentError());
    mockStat.mockResolvedValue(createStatResult(0o100600));
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    mockUnlink.mockResolvedValue(undefined);
    mockLock.mockImplementation(() => Promise.resolve(createRelease()));
  });

  describe('checkAutoCompactConfig', () => {
    it('returns true with configState valid when autoCompactEnabled is true', async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          autoCompactEnabled: true,
          someOtherField: 'keep-me',
        }),
      );

      const result = await checkAutoCompactConfig();

      expect(result).toEqual({ autoCompactEnabled: true, configState: 'valid' });
      expect(mockReadFile).toHaveBeenCalledWith(CLAUDE_CONFIG_PATH, 'utf-8');
    });

    it('returns false with configState valid when autoCompactEnabled is explicitly false', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ autoCompactEnabled: false }));
      await expect(checkAutoCompactConfig()).resolves.toEqual({
        autoCompactEnabled: false,
        configState: 'valid',
      });
    });

    it('returns true with configState valid when key is missing (Claude default is enabled)', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ anotherField: true }));
      await expect(checkAutoCompactConfig()).resolves.toEqual({
        autoCompactEnabled: true,
        configState: 'valid',
      });
    });

    it('returns true with configState missing when file is missing (Claude default is enabled)', async () => {
      mockReadFile.mockRejectedValue(createEnoentError());

      await expect(checkAutoCompactConfig()).resolves.toEqual({
        autoCompactEnabled: true,
        configState: 'missing',
      });
    });

    it('returns false with configState malformed on malformed JSON', async () => {
      mockReadFile.mockResolvedValue('{ not valid json');

      await expect(checkAutoCompactConfig()).resolves.toEqual({
        autoCompactEnabled: false,
        configState: 'malformed',
      });
    });

    it('returns configState malformed when top-level JSON is not an object', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify(['not', 'an', 'object']));

      await expect(checkAutoCompactConfig()).resolves.toEqual({
        autoCompactEnabled: false,
        configState: 'malformed',
      });
    });

    it('returns configState malformed on non-ENOENT I/O errors', async () => {
      mockReadFile.mockRejectedValue(new Error('EACCES: permission denied'));

      await expect(checkAutoCompactConfig()).resolves.toEqual({
        autoCompactEnabled: false,
        configState: 'malformed',
      });
    });
  });

  describe('cross-process locking', () => {
    it('locks with Claude-compatible lock options before reading', async () => {
      mockConfigBackingStore(null);

      const result = await ensureClaudeProjectTrusted('/proj/alpha');

      expect(result).toEqual({ success: true });
      expect(mockLock).toHaveBeenCalledWith(CLAUDE_CONFIG_PATH, {
        realpath: false,
        stale: 10_000,
        update: 5_000,
        retries: { retries: 12, factor: 1, minTimeout: 1_000, maxTimeout: 1_000 },
        onCompromised: expect.any(Function),
      });
    });

    it('returns io_error without reading or writing when the lock cannot be acquired', async () => {
      mockLock.mockRejectedValue(
        Object.assign(new Error('Lock file is already being held'), { code: 'ELOCKED' }),
      );

      const result = await ensureClaudeProjectTrusted('/proj/alpha');

      expect(result.success).toBe(false);
      expect(result.errorType).toBe('io_error');
      expect(mockReadFile).not.toHaveBeenCalled();
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('returns io_error when lock release fails even after a successful write', async () => {
      mockConfigBackingStore(null);
      mockLock.mockImplementation(() =>
        Promise.resolve(
          jest.fn().mockRejectedValue(new Error('rmdir failed')) as unknown as () => Promise<void>,
        ),
      );

      const result = await ensureClaudeProjectTrusted('/proj/alpha');

      expect(result.success).toBe(false);
      expect(result.errorType).toBe('io_error');
      expect(result.error).toContain('rmdir failed');
    });

    it('returns io_error instead of throwing asynchronously when the lock is compromised', async () => {
      let onCompromised: ((error: Error) => void) | undefined;
      mockLock.mockImplementation((_file: string, options?: LockOptions) => {
        onCompromised = options?.onCompromised;
        const release = async () => {
          onCompromised?.(new Error('Unable to update lock within the stale threshold'));
        };
        return Promise.resolve(release);
      });
      mockConfigBackingStore(null);

      const result = await ensureClaudeProjectTrusted('/proj/alpha');

      expect(result.success).toBe(false);
      expect(result.errorType).toBe('io_error');
      expect(result.error).toContain('compromised');
    });

    it('serializes concurrent trust and auto-compact mutations through one FIFO', async () => {
      let activeMutations = 0;
      mockLock.mockImplementation(() => {
        activeMutations += 1;
        expect(activeMutations).toBe(1);
        const release = () => {
          activeMutations -= 1;
          return Promise.resolve();
        };
        return Promise.resolve(release);
      });
      mockConfigBackingStore(null);

      const [trust, autoCompact] = await Promise.all([
        ensureClaudeProjectTrusted('/proj/alpha'),
        disableClaudeAutoCompact(),
      ]);

      expect(trust).toEqual({ success: true });
      expect(autoCompact).toEqual({ success: true });
      expect(activeMutations).toBe(0);
    });
  });

  describe('ensureClaudeProjectTrusted', () => {
    it('creates a new private config trusting both identities when config is missing', async () => {
      mockConfigBackingStore(null);
      mockRealpath.mockResolvedValue('/physical/alpha');

      const result = await ensureClaudeProjectTrusted('/proj/alpha');

      expect(result).toEqual({ success: true });
      const tempPath = mockWriteFile.mock.calls[0]?.[0] as string;
      expect(tempPath).toMatch(TMP_PATH_PATTERN);
      expect(mockWriteFile.mock.calls[0]?.[2]).toEqual({ encoding: 'utf-8', mode: 0o600 });
      expect(mockRename).toHaveBeenCalledWith(tempPath, CLAUDE_CONFIG_PATH);
      expect(mockStat).not.toHaveBeenCalled();
      const written = JSON.parse(mockWriteFile.mock.calls[0]?.[1] as string);
      expect(written).toEqual({
        projects: {
          '/proj/alpha': { hasTrustDialogAccepted: true },
          '/physical/alpha': { hasTrustDialogAccepted: true },
        },
      });
    });

    it('preserves unrelated config data and sibling project records', async () => {
      mockConfigBackingStore(
        JSON.stringify({
          autoCompactEnabled: true,
          theme: 'dark',
          oauth: { accountUuid: 'keep' },
          projects: {
            '/other/project': { hasTrustDialogAccepted: false, allowedTools: ['bash'] },
          },
        }),
      );

      const result = await ensureClaudeProjectTrusted('/proj/alpha');

      expect(result).toEqual({ success: true });
      expect(mockStat).toHaveBeenCalledWith(CLAUDE_CONFIG_PATH);
      const written = JSON.parse(mockWriteFile.mock.calls[0]?.[1] as string);
      expect(written).toEqual({
        autoCompactEnabled: true,
        theme: 'dark',
        oauth: { accountUuid: 'keep' },
        projects: {
          '/other/project': { hasTrustDialogAccepted: false, allowedTools: ['bash'] },
          '/proj/alpha': { hasTrustDialogAccepted: true },
        },
      });
    });

    it('preserves existing file permissions on the trust write', async () => {
      mockConfigBackingStore(JSON.stringify({}));
      mockStat.mockResolvedValue(createStatResult(0o100640));

      const result = await ensureClaudeProjectTrusted('/proj/alpha');

      expect(result).toEqual({ success: true });
      expect(mockWriteFile.mock.calls[0]?.[2]).toEqual({ encoding: 'utf-8', mode: 0o640 });
    });

    it('performs no write when both identities are already trusted', async () => {
      mockConfigBackingStore(
        JSON.stringify({
          projects: {
            '/proj/alpha': { hasTrustDialogAccepted: true, allowedTools: ['bash'] },
          },
        }),
      );

      const result = await ensureClaudeProjectTrusted('/proj/alpha');

      expect(result).toEqual({ success: true });
      expect(mockWriteFile).not.toHaveBeenCalled();
      expect(mockRename).not.toHaveBeenCalled();
    });

    it('writes only the missing identity when one of two is trusted', async () => {
      mockRealpath.mockResolvedValue('/physical/alpha');
      mockConfigBackingStore(
        JSON.stringify({
          projects: {
            '/proj/alpha': { hasTrustDialogAccepted: true, history: ['keep'] },
          },
        }),
      );

      const result = await ensureClaudeProjectTrusted('/proj/alpha');

      expect(result).toEqual({ success: true });
      const written = JSON.parse(mockWriteFile.mock.calls[0]?.[1] as string);
      expect(written.projects).toEqual({
        '/proj/alpha': { hasTrustDialogAccepted: true, history: ['keep'] },
        '/physical/alpha': { hasTrustDialogAccepted: true },
      });
    });

    it('falls back to the registered identity alone when realpath fails', async () => {
      mockRealpath.mockRejectedValue(createEnoentError());
      mockConfigBackingStore(null);

      const result = await ensureClaudeProjectTrusted('/proj/alpha');

      expect(result).toEqual({ success: true });
      const written = JSON.parse(mockWriteFile.mock.calls[0]?.[1] as string);
      expect(Object.keys(written.projects)).toEqual(['/proj/alpha']);
    });

    it('sanitizes malformed JSON errors and does not expose source contents', async () => {
      const secretSentinel = 'FAKE_SECRET_SENTINEL';
      mockConfigBackingStore(`{"oauthToken": ${secretSentinel}}`);

      const result = await ensureClaudeProjectTrusted('/proj/alpha');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid Claude config: malformed JSON');
      expect(result.error).not.toContain(secretSentinel);
      expect(result.errorType).toBe('invalid_config');
      expect(mockWriteFile).not.toHaveBeenCalled();
      expect(mockRename).not.toHaveBeenCalled();
    });

    it('returns invalid_config when top-level JSON is not an object', async () => {
      mockConfigBackingStore(JSON.stringify(['not', 'an', 'object']));

      const result = await ensureClaudeProjectTrusted('/proj/alpha');

      expect(result.success).toBe(false);
      expect(result.errorType).toBe('invalid_config');
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('returns invalid_config when projects is not an object', async () => {
      mockConfigBackingStore(JSON.stringify({ projects: ['not', 'an', 'object'] }));

      const result = await ensureClaudeProjectTrusted('/proj/alpha');

      expect(result.success).toBe(false);
      expect(result.errorType).toBe('invalid_config');
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('returns invalid_config when an existing project record is not an object', async () => {
      mockConfigBackingStore(JSON.stringify({ projects: { '/proj/alpha': 'not-an-object' } }));

      const result = await ensureClaudeProjectTrusted('/proj/alpha');

      expect(result.success).toBe(false);
      expect(result.errorType).toBe('invalid_config');
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('returns invalid_config when an unrelated sibling project record is not an object', async () => {
      mockConfigBackingStore(
        JSON.stringify({
          projects: {
            '/unrelated/project': 'not-an-object',
          },
        }),
      );

      const result = await ensureClaudeProjectTrusted('/proj/alpha');

      expect(result.success).toBe(false);
      expect(result.errorType).toBe('invalid_config');
      // Validation must reject before mode resolution or any temp write/rename.
      expect(mockStat).not.toHaveBeenCalled();
      expect(mockWriteFile).not.toHaveBeenCalled();
      expect(mockRename).not.toHaveBeenCalled();
    });

    it('re-merges once under the lock when post-write verification finds a stale file', async () => {
      const original = JSON.stringify({ other: true });
      const merged = `${JSON.stringify(
        { other: true, projects: { '/proj/alpha': { hasTrustDialogAccepted: true } } },
        null,
        2,
      )}\n`;
      mockReadFile
        .mockResolvedValueOnce(original) // mutation read
        .mockResolvedValueOnce(original) // first verification still sees pre-write content
        .mockResolvedValueOnce(original) // in-lock re-merge read
        .mockResolvedValueOnce(merged); // second verification sees the retried write

      const result = await ensureClaudeProjectTrusted('/proj/alpha');

      expect(result).toEqual({ success: true });
      expect(mockWriteFile).toHaveBeenCalledTimes(2);
    });

    it('returns io_error when verification keeps failing after the in-lock retry', async () => {
      const original = JSON.stringify({ other: true });
      mockReadFile
        .mockResolvedValueOnce(original)
        .mockResolvedValueOnce(original)
        .mockResolvedValueOnce(original)
        .mockResolvedValueOnce(original);

      const result = await ensureClaudeProjectTrusted('/proj/alpha');

      expect(result.success).toBe(false);
      expect(result.errorType).toBe('io_error');
      expect(mockWriteFile).toHaveBeenCalledTimes(2);
    });
  });

  describe('disableClaudeAutoCompact', () => {
    it('creates a new config file with restrictive mode when config file is missing', async () => {
      mockConfigBackingStore(null);

      const result = await disableClaudeAutoCompact();

      expect(result).toEqual({ success: true });
      expect(mockStat).not.toHaveBeenCalled();
      const tempPath = mockWriteFile.mock.calls[0]?.[0] as string;
      expect(tempPath).toMatch(TMP_PATH_PATTERN);
      expect(mockWriteFile).toHaveBeenCalledWith(tempPath, expect.any(String), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      expect(mockRename).toHaveBeenCalledWith(tempPath, CLAUDE_CONFIG_PATH);
    });

    it('sets autoCompactEnabled to false and preserves all other fields with atomic write', async () => {
      mockConfigBackingStore(
        JSON.stringify({
          autoCompactEnabled: true,
          theme: 'ocean',
          nested: { foo: 'bar' },
        }),
      );

      const result = await disableClaudeAutoCompact();

      expect(result).toEqual({ success: true });
      expect(mockStat).toHaveBeenCalledWith(CLAUDE_CONFIG_PATH);
      const tempPath = mockWriteFile.mock.calls[0]?.[0] as string;
      expect(tempPath).toMatch(TMP_PATH_PATTERN);
      expect(mockWriteFile).toHaveBeenCalledWith(tempPath, expect.any(String), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      expect(mockRename).toHaveBeenCalledWith(tempPath, CLAUDE_CONFIG_PATH);

      const written = mockWriteFile.mock.calls[0]?.[1] as string;
      expect(written.endsWith('\n')).toBe(true);
      expect(JSON.parse(written)).toEqual({
        autoCompactEnabled: false,
        theme: 'ocean',
        nested: { foo: 'bar' },
      });
    });

    it('preserves existing file permissions on atomic write', async () => {
      mockConfigBackingStore(JSON.stringify({ autoCompactEnabled: true, theme: 'ocean' }));
      mockStat.mockResolvedValue(createStatResult(0o100640));

      const result = await disableClaudeAutoCompact();

      expect(result).toEqual({ success: true });
      expect(mockWriteFile.mock.calls[0]?.[2]).toEqual({ encoding: 'utf-8', mode: 0o640 });
    });

    it('returns failure on malformed JSON and does not write', async () => {
      mockConfigBackingStore('{ malformed');

      const result = await disableClaudeAutoCompact();

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid Claude config: malformed JSON');
      expect(result.errorType).toBe('invalid_config');
      expect(mockWriteFile).not.toHaveBeenCalled();
      expect(mockRename).not.toHaveBeenCalled();
    });

    it('returns invalid_config when top-level JSON is not an object', async () => {
      mockConfigBackingStore(JSON.stringify(['not', 'an', 'object']));

      const result = await disableClaudeAutoCompact();

      expect(result.success).toBe(false);
      expect(result.errorType).toBe('invalid_config');
      expect(result.error).toContain('expected top-level JSON object');
      expect(mockWriteFile).not.toHaveBeenCalled();
      expect(mockRename).not.toHaveBeenCalled();
    });

    it('returns failure when rename fails and attempts tmp cleanup', async () => {
      mockConfigBackingStore(JSON.stringify({ autoCompactEnabled: true }));
      mockRename.mockRejectedValue(new Error('rename failed'));

      const result = await disableClaudeAutoCompact();

      const tempPath = mockWriteFile.mock.calls[0]?.[0] as string;
      expect(result.success).toBe(false);
      expect(result.error).toContain('rename failed');
      expect(result.errorType).toBe('io_error');
      expect(tempPath).toMatch(TMP_PATH_PATTERN);
      expect(mockUnlink).toHaveBeenCalledWith(tempPath);
    });

    it('returns io_error when reading config fails for non-ENOENT errors', async () => {
      mockReadFile.mockRejectedValue(new Error('EACCES: permission denied'));

      const result = await disableClaudeAutoCompact();

      expect(result.success).toBe(false);
      expect(result.errorType).toBe('io_error');
      expect(result.error).toContain('EACCES');
      expect(mockWriteFile).not.toHaveBeenCalled();
      expect(mockRename).not.toHaveBeenCalled();
    });

    it('returns io_error when the lock cannot be acquired', async () => {
      mockLock.mockRejectedValue(
        Object.assign(new Error('Lock file is already being held'), { code: 'ELOCKED' }),
      );

      const result = await disableClaudeAutoCompact();

      expect(result.success).toBe(false);
      expect(result.errorType).toBe('io_error');
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('returns io_error when lock release fails', async () => {
      mockConfigBackingStore(null);
      mockLock.mockImplementation(() =>
        Promise.resolve(
          jest.fn().mockRejectedValue(new Error('rmdir failed')) as unknown as () => Promise<void>,
        ),
      );

      const result = await disableClaudeAutoCompact();

      expect(result.success).toBe(false);
      expect(result.errorType).toBe('io_error');
      expect(result.error).toContain('rmdir failed');
    });
  });

  describe('enableClaudeAutoCompact', () => {
    it('sets autoCompactEnabled to true and preserves all other fields', async () => {
      mockConfigBackingStore(
        JSON.stringify({
          autoCompactEnabled: false,
          theme: 'dark',
          nested: { key: 'value' },
        }),
      );

      const result = await enableClaudeAutoCompact();

      expect(result).toEqual({ success: true });
      const tempPath = mockWriteFile.mock.calls[0]?.[0] as string;
      expect(tempPath).toMatch(TMP_PATH_PATTERN);
      expect(mockRename).toHaveBeenCalledWith(tempPath, CLAUDE_CONFIG_PATH);

      const written = mockWriteFile.mock.calls[0]?.[1] as string;
      expect(JSON.parse(written)).toEqual({
        autoCompactEnabled: true,
        theme: 'dark',
        nested: { key: 'value' },
      });
    });

    it('creates config with autoCompactEnabled true when file is missing', async () => {
      mockConfigBackingStore(null);

      const result = await enableClaudeAutoCompact();

      expect(result).toEqual({ success: true });
      const written = mockWriteFile.mock.calls[0]?.[1] as string;
      expect(JSON.parse(written)).toEqual({ autoCompactEnabled: true });
    });

    it('returns invalid_config on malformed JSON', async () => {
      mockConfigBackingStore('{ malformed');

      const result = await enableClaudeAutoCompact();

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid Claude config: malformed JSON');
      expect(result.errorType).toBe('invalid_config');
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('preserves existing file permissions on atomic write', async () => {
      mockConfigBackingStore(JSON.stringify({ autoCompactEnabled: false, theme: 'ocean' }));
      mockStat.mockResolvedValue(createStatResult(0o100640));

      const result = await enableClaudeAutoCompact();

      expect(result).toEqual({ success: true });
      expect(mockWriteFile.mock.calls[0]?.[2]).toEqual({ encoding: 'utf-8', mode: 0o640 });
    });

    it('returns io_error when rename fails and attempts tmp cleanup', async () => {
      mockConfigBackingStore(JSON.stringify({ autoCompactEnabled: false }));
      mockRename.mockRejectedValue(new Error('rename failed'));

      const result = await enableClaudeAutoCompact();

      const tempPath = mockWriteFile.mock.calls[0]?.[0] as string;
      expect(result.success).toBe(false);
      expect(result.error).toContain('rename failed');
      expect(result.errorType).toBe('io_error');
      expect(mockUnlink).toHaveBeenCalledWith(tempPath);
    });

    it('returns io_error when reading config fails for non-ENOENT errors', async () => {
      mockReadFile.mockRejectedValue(new Error('EACCES: permission denied'));

      const result = await enableClaudeAutoCompact();

      expect(result.success).toBe(false);
      expect(result.errorType).toBe('io_error');
      expect(result.error).toContain('EACCES');
      expect(mockWriteFile).not.toHaveBeenCalled();
      expect(mockRename).not.toHaveBeenCalled();
    });
  });
});

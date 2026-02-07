jest.mock('os', () => ({
  homedir: jest.fn(),
}));

jest.mock('fs/promises', () => ({
  readFile: jest.fn(),
  stat: jest.fn(),
  writeFile: jest.fn(),
  rename: jest.fn(),
  unlink: jest.fn(),
}));

import { readFile, rename, stat, unlink, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { checkClaudeAutoCompact, disableClaudeAutoCompact } from './claude-config';

const mockHomedir = homedir as jest.MockedFunction<typeof homedir>;
const mockReadFile = readFile as jest.MockedFunction<typeof readFile>;
const mockStat = stat as jest.MockedFunction<typeof stat>;
const mockWriteFile = writeFile as jest.MockedFunction<typeof writeFile>;
const mockRename = rename as jest.MockedFunction<typeof rename>;
const mockUnlink = unlink as jest.MockedFunction<typeof unlink>;

const CLAUDE_CONFIG_PATH = '/mock/home/.claude.json';

function createEnoentError(): NodeJS.ErrnoException {
  const error = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

function createStatResult(mode: number): Awaited<ReturnType<typeof stat>> {
  return { mode } as Awaited<ReturnType<typeof stat>>;
}

describe('claude-config utils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHomedir.mockReturnValue('/mock/home');
    mockStat.mockResolvedValue(createStatResult(0o100600));
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    mockUnlink.mockResolvedValue(undefined);
  });

  describe('checkClaudeAutoCompact', () => {
    it('returns true when autoCompactEnabled is true', async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          autoCompactEnabled: true,
          someOtherField: 'keep-me',
        }),
      );

      const result = await checkClaudeAutoCompact();

      expect(result).toEqual({ autoCompactEnabled: true });
      expect(mockReadFile).toHaveBeenCalledWith(CLAUDE_CONFIG_PATH, 'utf-8');
    });

    it('returns false when autoCompactEnabled is false or missing', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ autoCompactEnabled: false }));
      await expect(checkClaudeAutoCompact()).resolves.toEqual({ autoCompactEnabled: false });

      mockReadFile.mockResolvedValue(JSON.stringify({ anotherField: true }));
      await expect(checkClaudeAutoCompact()).resolves.toEqual({ autoCompactEnabled: false });
    });

    it('returns false when file is missing', async () => {
      mockReadFile.mockRejectedValue(createEnoentError());

      await expect(checkClaudeAutoCompact()).resolves.toEqual({ autoCompactEnabled: false });
    });

    it('returns false on malformed JSON', async () => {
      mockReadFile.mockResolvedValue('{ not valid json');

      await expect(checkClaudeAutoCompact()).resolves.toEqual({ autoCompactEnabled: false });
    });
  });

  describe('disableClaudeAutoCompact', () => {
    it('creates a new config file with restrictive mode when config file is missing', async () => {
      mockReadFile.mockRejectedValue(createEnoentError());
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_010);

      const result = await disableClaudeAutoCompact();
      const expectedTmpPath = `${CLAUDE_CONFIG_PATH}.tmp-${process.pid}-1700000000010`;

      expect(result).toEqual({ success: true });
      expect(mockStat).not.toHaveBeenCalled();
      expect(mockWriteFile).toHaveBeenCalledWith(expectedTmpPath, expect.any(String), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      expect(mockRename).toHaveBeenCalledWith(expectedTmpPath, CLAUDE_CONFIG_PATH);
      nowSpy.mockRestore();
    });

    it('sets autoCompactEnabled to false and preserves all other fields with atomic write', async () => {
      const config = {
        autoCompactEnabled: true,
        theme: 'ocean',
        nested: { foo: 'bar' },
      };
      mockReadFile.mockResolvedValue(JSON.stringify(config));
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

      const result = await disableClaudeAutoCompact();
      const expectedTmpPath = `${CLAUDE_CONFIG_PATH}.tmp-${process.pid}-1700000000000`;

      expect(result).toEqual({ success: true });
      expect(mockStat).toHaveBeenCalledWith(CLAUDE_CONFIG_PATH);
      expect(mockWriteFile).toHaveBeenCalledWith(expectedTmpPath, expect.any(String), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      expect(mockRename).toHaveBeenCalledWith(expectedTmpPath, CLAUDE_CONFIG_PATH);

      const written = mockWriteFile.mock.calls[0]?.[1] as string;
      expect(written.endsWith('\n')).toBe(true);
      expect(JSON.parse(written)).toEqual({
        autoCompactEnabled: false,
        theme: 'ocean',
        nested: { foo: 'bar' },
      });

      nowSpy.mockRestore();
    });

    it('preserves existing file permissions on atomic write', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ autoCompactEnabled: true, theme: 'ocean' }));
      mockStat.mockResolvedValue(createStatResult(0o100640));
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_005);

      const result = await disableClaudeAutoCompact();
      const expectedTmpPath = `${CLAUDE_CONFIG_PATH}.tmp-${process.pid}-1700000000005`;

      expect(result).toEqual({ success: true });
      expect(mockWriteFile).toHaveBeenCalledWith(expectedTmpPath, expect.any(String), {
        encoding: 'utf-8',
        mode: 0o640,
      });

      nowSpy.mockRestore();
    });

    it('returns failure on malformed JSON and does not write', async () => {
      mockReadFile.mockResolvedValue('{ malformed');

      const result = await disableClaudeAutoCompact();

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.errorType).toBe('invalid_config');
      expect(mockWriteFile).not.toHaveBeenCalled();
      expect(mockRename).not.toHaveBeenCalled();
    });

    it('returns invalid_config when top-level JSON is not an object', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify(['not', 'an', 'object']));

      const result = await disableClaudeAutoCompact();

      expect(result.success).toBe(false);
      expect(result.errorType).toBe('invalid_config');
      expect(result.error).toContain('expected top-level JSON object');
      expect(mockWriteFile).not.toHaveBeenCalled();
      expect(mockRename).not.toHaveBeenCalled();
    });

    it('returns failure when rename fails and attempts tmp cleanup', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ autoCompactEnabled: true }));
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_001);
      mockRename.mockRejectedValue(new Error('rename failed'));

      const result = await disableClaudeAutoCompact();
      const expectedTmpPath = `${CLAUDE_CONFIG_PATH}.tmp-${process.pid}-1700000000001`;

      expect(result.success).toBe(false);
      expect(result.error).toContain('rename failed');
      expect(result.errorType).toBe('io_error');
      expect(mockUnlink).toHaveBeenCalledWith(expectedTmpPath);

      nowSpy.mockRestore();
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
  });
});

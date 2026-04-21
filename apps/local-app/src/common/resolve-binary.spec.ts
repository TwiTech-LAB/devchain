import { resolveBinary } from './resolve-binary';

jest.mock('fs/promises', () => ({
  access: jest.fn(),
}));

jest.mock('child_process', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { promisify } = require('util');
  const asyncMock = jest.fn();
  const execFileMock = jest.fn();
  Object.defineProperty(execFileMock, promisify.custom, {
    value: asyncMock,
    writable: true,
  });
  return { execFile: execFileMock, __mockExecFileAsync: asyncMock };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const mockExecFileAsync = require('child_process').__mockExecFileAsync as jest.Mock;
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const mockAccess = require('fs/promises').access as jest.Mock;

const originalPlatform = process.platform;

afterEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(process, 'platform', { value: originalPlatform });
});

describe('resolveBinary', () => {
  it('returns null for empty name', async () => {
    expect(await resolveBinary('')).toBeNull();
  });

  describe('absolute path', () => {
    it('returns the path when executable', async () => {
      mockAccess.mockResolvedValue(undefined);

      const result = await resolveBinary('/usr/bin/claude');

      expect(result).toBe('/usr/bin/claude');
      expect(mockExecFileAsync).not.toHaveBeenCalled();
    });

    it('returns null when not executable', async () => {
      mockAccess.mockRejectedValue(new Error('EACCES'));

      const result = await resolveBinary('/usr/bin/claude');

      expect(result).toBeNull();
    });
  });

  describe('Unix PATH resolution', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
    });

    it('resolves via which and returns absolute path when executable', async () => {
      mockExecFileAsync.mockResolvedValue({ stdout: '/usr/local/bin/claude\n' });
      mockAccess.mockResolvedValue(undefined);

      const result = await resolveBinary('claude');

      expect(result).toBe('/usr/local/bin/claude');
      expect(mockExecFileAsync).toHaveBeenCalledWith('which', ['claude']);
    });

    it('returns null when which succeeds but access fails', async () => {
      mockExecFileAsync.mockResolvedValue({ stdout: '/usr/local/bin/claude\n' });
      mockAccess.mockRejectedValue(new Error('EACCES'));

      const result = await resolveBinary('claude');

      expect(result).toBeNull();
    });

    it('returns null when which fails (not on PATH)', async () => {
      mockExecFileAsync.mockRejectedValue(new Error('not found'));

      const result = await resolveBinary('nonexistent');

      expect(result).toBeNull();
    });

    it('returns null when which returns empty stdout', async () => {
      mockExecFileAsync.mockResolvedValue({ stdout: '' });

      const result = await resolveBinary('claude');

      expect(result).toBeNull();
    });

    it('takes the first line when which returns multiple paths', async () => {
      mockExecFileAsync.mockResolvedValue({
        stdout: '/usr/local/bin/claude\n/usr/bin/claude\n',
      });
      mockAccess.mockResolvedValue(undefined);

      const result = await resolveBinary('claude');

      expect(result).toBe('/usr/local/bin/claude');
    });
  });

  describe('Windows PATH resolution', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
    });

    it('uses where instead of which', async () => {
      mockExecFileAsync.mockResolvedValue({ stdout: 'C:\\Program Files\\claude.exe\r\n' });
      mockAccess.mockResolvedValue(undefined);

      const result = await resolveBinary('claude');

      expect(result).toBe('C:\\Program Files\\claude.exe');
      expect(mockExecFileAsync).toHaveBeenCalledWith('where', ['claude']);
    });

    it('returns null when where fails', async () => {
      mockExecFileAsync.mockRejectedValue(new Error('not found'));

      const result = await resolveBinary('claude');

      expect(result).toBeNull();
    });
  });
});

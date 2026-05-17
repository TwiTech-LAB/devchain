import { resolveBinary } from './resolve-binary';
import { FakeProcessExecutor } from '../modules/terminal/services/process-executor/fake-process-executor';

jest.mock('fs/promises', () => ({
  access: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const mockAccess = require('fs/promises').access as jest.Mock;

const originalPlatform = process.platform;

afterEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(process, 'platform', { value: originalPlatform });
});

describe('resolveBinary', () => {
  let fakeExecutor: FakeProcessExecutor;

  beforeEach(() => {
    fakeExecutor = new FakeProcessExecutor();
  });

  it('returns null for empty name', async () => {
    expect(await resolveBinary('', fakeExecutor)).toBeNull();
  });

  it('returns null for non-absolute name when no executor provided', async () => {
    expect(await resolveBinary('claude')).toBeNull();
  });

  describe('absolute path', () => {
    it('returns the path when executable', async () => {
      mockAccess.mockResolvedValue(undefined);

      const result = await resolveBinary('/usr/bin/claude', fakeExecutor);

      expect(result).toBe('/usr/bin/claude');
      expect(fakeExecutor.calls).toHaveLength(0);
    });

    it('returns null when not executable', async () => {
      mockAccess.mockRejectedValue(new Error('EACCES'));

      const result = await resolveBinary('/usr/bin/claude', fakeExecutor);

      expect(result).toBeNull();
    });
  });

  describe('Unix PATH resolution', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
    });

    it('resolves via which and returns absolute path when executable', async () => {
      fakeExecutor.enqueueResponse({ type: 'success', stdout: '/usr/local/bin/claude\n' });
      mockAccess.mockResolvedValue(undefined);

      const result = await resolveBinary('claude', fakeExecutor);

      expect(result).toBe('/usr/local/bin/claude');
      expect(fakeExecutor.calls[0].argv).toEqual(['which', 'claude']);
    });

    it('returns null when which succeeds but access fails', async () => {
      fakeExecutor.enqueueResponse({ type: 'success', stdout: '/usr/local/bin/claude\n' });
      mockAccess.mockRejectedValue(new Error('EACCES'));

      const result = await resolveBinary('claude', fakeExecutor);

      expect(result).toBeNull();
    });

    it('returns null when which fails (not on PATH)', async () => {
      fakeExecutor.enqueueResponse({ type: 'failure', exitCode: 1 });

      const result = await resolveBinary('nonexistent', fakeExecutor);

      expect(result).toBeNull();
    });

    it('returns null when which returns empty stdout', async () => {
      fakeExecutor.enqueueResponse({ type: 'success', stdout: '' });

      const result = await resolveBinary('claude', fakeExecutor);

      expect(result).toBeNull();
    });

    it('takes the first line when which returns multiple paths', async () => {
      fakeExecutor.enqueueResponse({
        type: 'success',
        stdout: '/usr/local/bin/claude\n/usr/bin/claude\n',
      });
      mockAccess.mockResolvedValue(undefined);

      const result = await resolveBinary('claude', fakeExecutor);

      expect(result).toBe('/usr/local/bin/claude');
    });
  });

  describe('Windows PATH resolution', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
    });

    it('uses where instead of which', async () => {
      fakeExecutor.enqueueResponse({
        type: 'success',
        stdout: 'C:\\Program Files\\claude.exe\r\n',
      });
      mockAccess.mockResolvedValue(undefined);

      const result = await resolveBinary('claude', fakeExecutor);

      expect(result).toBe('C:\\Program Files\\claude.exe');
      expect(fakeExecutor.calls[0].argv).toEqual(['where', 'claude']);
    });

    it('returns null when where fails', async () => {
      fakeExecutor.enqueueResponse({ type: 'failure', exitCode: 1 });

      const result = await resolveBinary('claude', fakeExecutor);

      expect(result).toBeNull();
    });
  });
});

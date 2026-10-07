import type { Stats } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { TranscriptPathValidator } from './transcript-path-validator.service';
import { ValidationError } from '../../../common/errors/error-types';

jest.mock('node:fs/promises');

const mockFs = fs as jest.Mocked<typeof fs>;
const homeDir = os.homedir();

function mockStat(overrides: { isFile: boolean; size: number }): Stats {
  return { isFile: () => overrides.isFile, size: overrides.size } as unknown as Stats;
}

describe('TranscriptPathValidator', () => {
  let validator: TranscriptPathValidator;

  beforeEach(() => {
    validator = new TranscriptPathValidator();
    jest.resetAllMocks();
  });

  describe('validateShape', () => {
    describe('valid paths', () => {
      it.each([
        { input: `${homeDir}/.claude/projects/my-project/session.jsonl`, provider: 'claude' },
        { input: `${homeDir}/.codex/sessions/abc123/transcript.json`, provider: 'codex' },
        { input: `${homeDir}/.local/share/opencode/opencode.db`, provider: 'opencode' },
        {
          input: `${homeDir}/.copilot/session-state/11111111-2222-3333-4444-555555555555/events.jsonl`,
          provider: 'copilot',
        },
      ])('accepts $provider root at $input', ({ input, provider }) => {
        expect(validator.validateShape(input, provider)).toBe(input);
      });

      it.each([
        {
          input: `${homeDir}/.copilot/session-state/abc/events.jsonl`,
          provider: 'claude',
          message: undefined,
        },
        {
          input: `${homeDir}/.local/share/opencode/opencode.db`,
          provider: 'claude',
          message: undefined,
        },
        {
          input: `${homeDir}/.config/something`,
          provider: 'claude',
          message: /outside allowed root/,
        },
        {
          input: `${homeDir}/.claude/projects/session.jsonl`,
          provider: 'codex',
          message: undefined,
        },
        { input: '/etc/passwd', provider: 'claude', message: undefined },
      ])('rejects $input outside $provider roots', ({ input, provider, message }) => {
        const validate = () => validator.validateShape(input, provider);
        expect(validate).toThrow(ValidationError);
        if (message) expect(validate).toThrow(message);
      });

      it('should resolve ~ to home directory', () => {
        const input = '~/.claude/projects/my-project/session.jsonl';
        const expected = path.join(homeDir, '.claude/projects/my-project/session.jsonl');
        const result = validator.validateShape(input, 'claude');
        expect(result).toBe(expected);
      });

      it('should normalize redundant slashes', () => {
        const input = `${homeDir}/.claude/projects//nested///session.jsonl`;
        const expected = path.join(homeDir, '.claude/projects/nested/session.jsonl');
        const result = validator.validateShape(input, 'claude');
        expect(result).toBe(expected);
      });

      it('should handle case-insensitive provider names', () => {
        const input = `${homeDir}/.claude/projects/proj/session.jsonl`;
        const result = validator.validateShape(input, 'Claude');
        expect(result).toBe(input);
      });

      it('should accept deeply nested paths within allowed root', () => {
        const input = `${homeDir}/.claude/projects/org/repo/a/b/c/session.jsonl`;
        const result = validator.validateShape(input, 'claude');
        expect(result).toBe(input);
      });
    });

    describe('directory traversal rejection', () => {
      it('should reject path with .. that escapes allowed root', () => {
        const input = `${homeDir}/.claude/projects/../../etc/passwd`;
        expect(() => validator.validateShape(input, 'claude')).toThrow(ValidationError);
        expect(() => validator.validateShape(input, 'claude')).toThrow(/outside allowed root/);
      });

      it('should reject path with encoded traversal %2e%2e', () => {
        const input = `${homeDir}/.claude/projects/%2e%2e/%2e%2e/etc/passwd`;
        expect(() => validator.validateShape(input, 'claude')).toThrow(ValidationError);
        expect(() => validator.validateShape(input, 'claude')).toThrow(/encoded traversal/);
      });

      it('should reject path with mixed-case encoded traversal %2E%2E', () => {
        const input = `${homeDir}/.claude/projects/%2E%2E/secret`;
        expect(() => validator.validateShape(input, 'claude')).toThrow(ValidationError);
      });

      it('should reject path that resolves outside root after .. collapsing', () => {
        const input = `${homeDir}/.claude/projects/../../../tmp/evil`;
        expect(() => validator.validateShape(input, 'claude')).toThrow(ValidationError);
      });

      it('should allow .. that stays within the allowed root', () => {
        const input = `${homeDir}/.claude/projects/a/b/../c/session.jsonl`;
        const result = validator.validateShape(input, 'claude');
        expect(result).toBe(path.join(homeDir, '.claude/projects/a/c/session.jsonl'));
      });

      it('should reject Copilot path with .. that escapes the .copilot root', () => {
        const input = `${homeDir}/.copilot/session-state/../../etc/passwd`;
        expect(() => validator.validateShape(input, 'copilot')).toThrow(ValidationError);
        expect(() => validator.validateShape(input, 'copilot')).toThrow(/outside allowed root/);
      });
    });

    describe('control character rejection', () => {
      it.each([
        {
          name: 'should reject path with null byte',
          input: `${homeDir}/.claude/projects/session\x00.jsonl`,
          message: /null bytes/,
        },
        {
          name: 'should reject path with control characters',
          input: `${homeDir}/.claude/projects/session\x01.jsonl`,
          message: /control characters/,
        },
        {
          name: 'should reject path with escape character',
          input: `${homeDir}/.claude/projects/session\x1B.jsonl`,
          message: undefined,
        },
        {
          name: 'should reject path with DEL character',
          input: `${homeDir}/.claude/projects/session\x7F.jsonl`,
          message: undefined,
        },
      ])('$name', ({ input, message }) => {
        const validate = () => validator.validateShape(input, 'claude');
        expect(validate).toThrow(ValidationError);
        if (message) expect(validate).toThrow(message);
      });
    });

    describe('unknown provider rejection', () => {
      it('should reject unknown provider name', () => {
        const input = `${homeDir}/.claude/projects/session.jsonl`;
        expect(() => validator.validateShape(input, 'unknown')).toThrow(ValidationError);
        expect(() => validator.validateShape(input, 'unknown')).toThrow(/Unknown provider/);
      });
    });

    describe('path outside allowed roots', () => {
      it('should reject empty path', () => {
        expect(() => validator.validateShape('', 'claude')).toThrow(ValidationError);
        expect(() => validator.validateShape('', 'claude')).toThrow(/non-empty string/);
      });
    });
  });

  describe('validateForRead', () => {
    const validPath = `${homeDir}/.claude/projects/my-project/session.jsonl`;

    it('should return real path for valid existing file', async () => {
      mockFs.realpath.mockResolvedValueOnce(validPath);
      mockFs.stat.mockResolvedValueOnce(mockStat({ isFile: true, size: 1024 }));

      const result = await validator.validateForRead(validPath, 'claude');
      expect(result).toBe(validPath);
    });

    it('should throw if file does not exist (realpath fails)', async () => {
      mockFs.realpath.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const err = await validator.validateForRead(validPath, 'claude').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toMatch(/does not exist/);
      expect((err as ValidationError).details).toMatchObject({
        category: 'file-access',
        path: validPath,
        reason: 'missing',
        fsCode: 'ENOENT',
      });
    });

    it('distinguishes inaccessible files from not-yet-created files', async () => {
      mockFs.realpath.mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }));

      const err = await validator.validateForRead(validPath, 'claude').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).details).toMatchObject({
        category: 'file-access',
        path: validPath,
        reason: 'unavailable',
        fsCode: 'EACCES',
      });
    });

    it('should throw if symlink resolves outside allowed root', async () => {
      mockFs.realpath.mockResolvedValueOnce('/tmp/evil-symlink-target');

      const err = await validator.validateForRead(validPath, 'claude').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toMatch(/outside allowed root/);
    });

    it('should throw if path is not a regular file', async () => {
      mockFs.realpath.mockResolvedValueOnce(validPath);
      mockFs.stat.mockResolvedValueOnce(mockStat({ isFile: false, size: 0 }));

      const err = await validator.validateForRead(validPath, 'claude').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toMatch(/not a regular file/);
    });

    it('should accept files larger than 100MB (no size cap)', async () => {
      mockFs.realpath.mockResolvedValueOnce(validPath);
      mockFs.stat.mockResolvedValueOnce(mockStat({ isFile: true, size: 150 * 1024 * 1024 }));

      const result = await validator.validateForRead(validPath, 'claude');
      expect(result).toBe(validPath);
    });

    it('should reject shape-invalid paths before checking filesystem', async () => {
      await expect(validator.validateForRead('/etc/passwd', 'claude')).rejects.toThrow(
        ValidationError,
      );
      expect(mockFs.realpath).not.toHaveBeenCalled();
      expect(mockFs.stat).not.toHaveBeenCalled();
    });
  });
});

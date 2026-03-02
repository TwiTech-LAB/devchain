import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { TranscriptPathValidator } from './transcript-path-validator.service';
import { ValidationError } from '../../../common/errors/error-types';

jest.mock('node:fs/promises');

const mockFs = fs as jest.Mocked<typeof fs>;
const homeDir = os.homedir();

function mockStat(overrides: { isFile: boolean; size: number }): fs.Stats {
  return { isFile: () => overrides.isFile, size: overrides.size } as unknown as fs.Stats;
}

describe('TranscriptPathValidator', () => {
  let validator: TranscriptPathValidator;

  beforeEach(() => {
    validator = new TranscriptPathValidator();
    jest.resetAllMocks();
  });

  describe('validateShape', () => {
    describe('valid paths', () => {
      it('should accept a valid Claude transcript path', () => {
        const input = `${homeDir}/.claude/projects/my-project/session.jsonl`;
        const result = validator.validateShape(input, 'claude');
        expect(result).toBe(input);
      });

      it('should accept a valid Codex transcript path', () => {
        const input = `${homeDir}/.codex/sessions/abc123/transcript.json`;
        const result = validator.validateShape(input, 'codex');
        expect(result).toBe(input);
      });

      it('should accept a valid Gemini transcript path', () => {
        const input = `${homeDir}/.gemini/tmp/session-data.jsonl`;
        const result = validator.validateShape(input, 'gemini');
        expect(result).toBe(input);
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
    });

    describe('control character rejection', () => {
      it('should reject path with null byte', () => {
        const input = `${homeDir}/.claude/projects/session\x00.jsonl`;
        expect(() => validator.validateShape(input, 'claude')).toThrow(ValidationError);
        expect(() => validator.validateShape(input, 'claude')).toThrow(/null bytes/);
      });

      it('should reject path with control characters', () => {
        const input = `${homeDir}/.claude/projects/session\x01.jsonl`;
        expect(() => validator.validateShape(input, 'claude')).toThrow(ValidationError);
        expect(() => validator.validateShape(input, 'claude')).toThrow(/control characters/);
      });

      it('should reject path with escape character', () => {
        const input = `${homeDir}/.claude/projects/session\x1B.jsonl`;
        expect(() => validator.validateShape(input, 'claude')).toThrow(ValidationError);
      });

      it('should reject path with DEL character', () => {
        const input = `${homeDir}/.claude/projects/session\x7F.jsonl`;
        expect(() => validator.validateShape(input, 'claude')).toThrow(ValidationError);
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
      it('should reject path outside provider root', () => {
        const input = `${homeDir}/.config/something`;
        expect(() => validator.validateShape(input, 'claude')).toThrow(ValidationError);
        expect(() => validator.validateShape(input, 'claude')).toThrow(/outside allowed root/);
      });

      it('should reject Claude path with Codex provider', () => {
        const input = `${homeDir}/.claude/projects/session.jsonl`;
        expect(() => validator.validateShape(input, 'codex')).toThrow(ValidationError);
      });

      it('should reject absolute path outside home directory', () => {
        const input = '/etc/passwd';
        expect(() => validator.validateShape(input, 'claude')).toThrow(ValidationError);
      });

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
      mockFs.realpath.mockRejectedValueOnce(new Error('ENOENT'));

      const err = await validator.validateForRead(validPath, 'claude').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toMatch(/does not exist/);
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

    it('should accept files larger than 10MB (no size cap)', async () => {
      mockFs.realpath.mockResolvedValueOnce(validPath);
      mockFs.stat.mockResolvedValueOnce(mockStat({ isFile: true, size: 50 * 1024 * 1024 }));

      const result = await validator.validateForRead(validPath, 'claude');
      expect(result).toBe(validPath);
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

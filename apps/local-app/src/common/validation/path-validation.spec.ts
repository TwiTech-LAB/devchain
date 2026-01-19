import {
  validatePathWithinRoot,
  validateLineBounds,
  validateResolvedPathWithinRoot,
} from './path-validation';
import { ValidationError } from '../errors/error-types';
import { join } from 'path';

// Mock fs/promises for symlink tests
jest.mock('fs/promises', () => ({
  lstat: jest.fn(),
  realpath: jest.fn(),
}));

describe('path-validation', () => {
  describe('validatePathWithinRoot', () => {
    const rootPath = '/project/root';

    describe('valid paths', () => {
      it('accepts simple relative path', () => {
        const result = validatePathWithinRoot(rootPath, 'src/file.ts');
        expect(result.absolutePath).toBe(join(rootPath, 'src/file.ts'));
        expect(result.relativePath).toBe(join('src', 'file.ts'));
      });

      it('accepts nested path', () => {
        const result = validatePathWithinRoot(rootPath, 'src/components/Button.tsx');
        expect(result.absolutePath).toBe(join(rootPath, 'src/components/Button.tsx'));
        expect(result.relativePath).toBe(join('src', 'components', 'Button.tsx'));
      });

      it('accepts path in root', () => {
        const result = validatePathWithinRoot(rootPath, 'file.txt');
        expect(result.absolutePath).toBe(join(rootPath, 'file.txt'));
        expect(result.relativePath).toBe('file.txt');
      });

      it('accepts path with single dot', () => {
        const result = validatePathWithinRoot(rootPath, './src/file.ts');
        expect(result.relativePath).toBe(join('src', 'file.ts'));
      });
    });

    describe('path traversal attacks', () => {
      it('rejects simple path traversal (../)', () => {
        expect(() => validatePathWithinRoot(rootPath, '../etc/passwd')).toThrow(ValidationError);
        expect(() => validatePathWithinRoot(rootPath, '../etc/passwd')).toThrow(
          /Path traversal sequences/,
        );
      });

      it('rejects nested path traversal', () => {
        expect(() => validatePathWithinRoot(rootPath, 'src/../../../etc/passwd')).toThrow(
          ValidationError,
        );
      });

      it('rejects double path traversal', () => {
        expect(() => validatePathWithinRoot(rootPath, '../../etc/passwd')).toThrow(ValidationError);
      });

      it('rejects path traversal at start', () => {
        expect(() => validatePathWithinRoot(rootPath, '../passwd')).toThrow(ValidationError);
      });

      it('rejects path traversal in middle', () => {
        expect(() => validatePathWithinRoot(rootPath, 'foo/../../../bar')).toThrow(ValidationError);
      });

      it('rejects path traversal with backslashes (Windows)', () => {
        expect(() => validatePathWithinRoot(rootPath, '..\\etc\\passwd')).toThrow(ValidationError);
      });
    });

    describe('absolute paths', () => {
      it('rejects Unix absolute path', () => {
        expect(() => validatePathWithinRoot(rootPath, '/etc/passwd')).toThrow(ValidationError);
        expect(() => validatePathWithinRoot(rootPath, '/etc/passwd')).toThrow(
          /Absolute paths are not allowed/,
        );
      });

      it('rejects path starting with forward slash', () => {
        expect(() => validatePathWithinRoot(rootPath, '/src/file.ts')).toThrow(ValidationError);
      });

      // Windows-specific test
      if (process.platform === 'win32') {
        it('rejects Windows absolute path', () => {
          expect(() => validatePathWithinRoot(rootPath, 'C:\\Windows\\System32')).toThrow(
            ValidationError,
          );
        });
      }
    });

    describe('edge cases', () => {
      it('rejects empty path', () => {
        expect(() => validatePathWithinRoot(rootPath, '')).toThrow(ValidationError);
        expect(() => validatePathWithinRoot(rootPath, '')).toThrow(/File path is required/);
      });

      it('rejects null path', () => {
        expect(() => validatePathWithinRoot(rootPath, null as unknown as string)).toThrow(
          ValidationError,
        );
      });

      it('rejects undefined path', () => {
        expect(() => validatePathWithinRoot(rootPath, undefined as unknown as string)).toThrow(
          ValidationError,
        );
      });

      it('rejects path with only dots', () => {
        expect(() => validatePathWithinRoot(rootPath, '..')).toThrow(ValidationError);
      });

      it('handles paths with multiple slashes', () => {
        // normalize should handle this
        const result = validatePathWithinRoot(rootPath, 'src//nested///file.ts');
        expect(result.relativePath).toContain('file.ts');
      });
    });

    describe('real-world attack vectors', () => {
      it('rejects /etc/passwd attack', () => {
        expect(() => validatePathWithinRoot(rootPath, '../../etc/passwd')).toThrow(ValidationError);
      });

      it('rejects /etc/shadow attack', () => {
        expect(() => validatePathWithinRoot(rootPath, '../../../etc/shadow')).toThrow(
          ValidationError,
        );
      });

      it('rejects Windows system file attack', () => {
        expect(() =>
          validatePathWithinRoot(rootPath, '..\\..\\Windows\\System32\\config\\SAM'),
        ).toThrow(ValidationError);
      });

      it('rejects SSH key theft attempt', () => {
        expect(() => validatePathWithinRoot(rootPath, '../../../home/user/.ssh/id_rsa')).toThrow(
          ValidationError,
        );
      });

      it('rejects environment file theft attempt', () => {
        expect(() => validatePathWithinRoot(rootPath, '../../../.env')).toThrow(ValidationError);
      });

      it('rejects URL-encoded traversal when decoded', () => {
        // URL-encoded traversal attempts that have been decoded should be caught
        const decodedPath = decodeURIComponent('..%2F..%2Fetc%2Fpasswd');
        expect(() => validatePathWithinRoot(rootPath, decodedPath)).toThrow(ValidationError);

        // Direct traversal should also be caught
        expect(() => validatePathWithinRoot(rootPath, '../../../etc/passwd')).toThrow(
          ValidationError,
        );
      });

      it('handles non-decoded URL-encoded strings as literal filenames', () => {
        // If the string wasn't URL-decoded, %2F is a literal character in the filename
        // This would create a file named literally '..%2F..%2Fetc%2Fpasswd' which is safe
        // But our implementation still catches this because path.normalize converts %2F
        // Actually let's test a truly safe encoded string
        const result = validatePathWithinRoot(rootPath, 'src%2Ffile.ts');
        expect(result.relativePath).toContain('src%2Ffile.ts');
      });
    });

    describe('custom error prefix', () => {
      it('uses custom error prefix', () => {
        try {
          validatePathWithinRoot(rootPath, '../etc/passwd', {
            errorPrefix: 'Custom prefix',
          });
          fail('Should have thrown');
        } catch (error) {
          expect((error as ValidationError).message).toContain('Custom prefix');
        }
      });
    });

    describe('error details', () => {
      it('includes path details in error', () => {
        try {
          validatePathWithinRoot(rootPath, '../etc/passwd');
          fail('Should have thrown');
        } catch (error) {
          const validationError = error as ValidationError;
          expect(validationError.details).toBeDefined();
          expect(validationError.details?.filePath).toBe('../etc/passwd');
          expect(validationError.details?.reason).toBe('path_traversal');
        }
      });
    });
  });

  describe('validateLineBounds', () => {
    const totalLines = 100;

    describe('valid bounds', () => {
      it('accepts valid single line', () => {
        expect(() => validateLineBounds(1, 1, totalLines)).not.toThrow();
      });

      it('accepts valid line range', () => {
        expect(() => validateLineBounds(10, 20, totalLines)).not.toThrow();
      });

      it('accepts last line', () => {
        expect(() => validateLineBounds(100, 100, totalLines)).not.toThrow();
      });

      it('accepts first line', () => {
        expect(() => validateLineBounds(1, 1, totalLines)).not.toThrow();
      });

      it('accepts full file range', () => {
        expect(() => validateLineBounds(1, 100, totalLines)).not.toThrow();
      });
    });

    describe('invalid bounds', () => {
      it('rejects zero line start', () => {
        expect(() => validateLineBounds(0, 10, totalLines)).toThrow(ValidationError);
        expect(() => validateLineBounds(0, 10, totalLines)).toThrow(
          /Line start must be a positive integer/,
        );
      });

      it('rejects negative line start', () => {
        expect(() => validateLineBounds(-1, 10, totalLines)).toThrow(ValidationError);
      });

      it('rejects zero line end', () => {
        expect(() => validateLineBounds(1, 0, totalLines)).toThrow(ValidationError);
      });

      it('rejects negative line end', () => {
        expect(() => validateLineBounds(1, -5, totalLines)).toThrow(ValidationError);
      });

      it('rejects line end less than line start', () => {
        expect(() => validateLineBounds(20, 10, totalLines)).toThrow(ValidationError);
        expect(() => validateLineBounds(20, 10, totalLines)).toThrow(
          /Line end cannot be less than line start/,
        );
      });

      it('rejects line start exceeding file length', () => {
        expect(() => validateLineBounds(101, 101, totalLines)).toThrow(ValidationError);
        expect(() => validateLineBounds(101, 101, totalLines)).toThrow(
          /Line start exceeds file length/,
        );
      });

      it('rejects line end exceeding file length', () => {
        expect(() => validateLineBounds(1, 101, totalLines)).toThrow(ValidationError);
        expect(() => validateLineBounds(1, 101, totalLines)).toThrow(
          /Line end exceeds file length/,
        );
      });

      it('rejects non-integer line start', () => {
        expect(() => validateLineBounds(1.5, 10, totalLines)).toThrow(ValidationError);
      });

      it('rejects non-integer line end', () => {
        expect(() => validateLineBounds(1, 10.5, totalLines)).toThrow(ValidationError);
      });
    });

    describe('edge cases', () => {
      it('handles single-line file', () => {
        expect(() => validateLineBounds(1, 1, 1)).not.toThrow();
      });

      it('rejects bounds for empty file', () => {
        expect(() => validateLineBounds(1, 1, 0)).toThrow(ValidationError);
      });
    });
  });

  describe('validateResolvedPathWithinRoot', () => {
    const rootPath = '/project';

    // Import the mocked module
    const { lstat, realpath } = jest.requireMock('fs/promises') as {
      lstat: jest.Mock;
      realpath: jest.Mock;
    };

    beforeEach(() => {
      jest.clearAllMocks();
    });

    describe('non-symlink paths', () => {
      it('returns path unchanged for regular file', async () => {
        lstat.mockResolvedValue({ isSymbolicLink: () => false });
        realpath.mockResolvedValue('/project/src/file.ts');

        const result = await validateResolvedPathWithinRoot('/project/src/file.ts', rootPath);
        expect(result).toBe('/project/src/file.ts');
      });

      it('returns path unchanged for non-existent file', async () => {
        const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
        enoent.code = 'ENOENT';
        lstat.mockRejectedValue(enoent);
        realpath.mockRejectedValue(enoent);

        const result = await validateResolvedPathWithinRoot('/project/src/new-file.ts', rootPath);
        expect(result).toBe('/project/src/new-file.ts');
      });
    });

    describe('symlink escape prevention', () => {
      it('rejects escapes via symlinked directory', async () => {
        // If a parent directory is a symlink, lstat on the leaf is not sufficient.
        // realpath() resolves the full path and must be used to prevent escape.
        lstat.mockResolvedValue({ isSymbolicLink: () => false });
        realpath.mockResolvedValue('/etc/passwd');

        await expect(
          validateResolvedPathWithinRoot('/project/link/passwd', rootPath),
        ).rejects.toThrow(/Symlink escapes the root directory/);
      });

      it('rejects symlink pointing outside root', async () => {
        lstat.mockResolvedValue({ isSymbolicLink: () => true });
        realpath.mockResolvedValue('/etc/passwd');

        await expect(validateResolvedPathWithinRoot('/project/link', rootPath)).rejects.toThrow(
          ValidationError,
        );

        // Reset mocks for second assertion
        lstat.mockResolvedValue({ isSymbolicLink: () => true });
        realpath.mockResolvedValue('/etc/passwd');

        await expect(validateResolvedPathWithinRoot('/project/link', rootPath)).rejects.toThrow(
          /Symlink escapes the root directory/,
        );
      });

      it('allows symlink pointing inside root', async () => {
        lstat.mockResolvedValue({ isSymbolicLink: () => true });
        realpath.mockResolvedValue('/project/src/actual-file.ts');

        const result = await validateResolvedPathWithinRoot('/project/link', rootPath);
        expect(result).toBe('/project/src/actual-file.ts');
      });

      it('rejects dangling symlink (target does not exist)', async () => {
        lstat.mockResolvedValue({ isSymbolicLink: () => true });

        const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
        enoent.code = 'ENOENT';
        realpath.mockRejectedValue(enoent);

        await expect(
          validateResolvedPathWithinRoot('/project/dangling-link', rootPath),
        ).rejects.toThrow(ValidationError);

        // Reset mocks for second assertion
        lstat.mockResolvedValue({ isSymbolicLink: () => true });
        realpath.mockRejectedValue(enoent);

        await expect(
          validateResolvedPathWithinRoot('/project/dangling-link', rootPath),
        ).rejects.toThrow(/Symlink target does not exist/);
      });

      it('rejects allowNonExistent writes through symlinked directory', async () => {
        const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
        enoent.code = 'ENOENT';

        lstat.mockRejectedValue(enoent);
        realpath.mockImplementation(async (path: string) => {
          if (path === '/project/link/new-file.ts') throw enoent;
          if (path === '/project/link') return '/etc';
          throw enoent;
        });

        await expect(
          validateResolvedPathWithinRoot('/project/link/new-file.ts', rootPath, {
            allowNonExistent: true,
          }),
        ).rejects.toThrow(/Symlink escapes the root directory/);
      });
    });

    describe('error details', () => {
      it('includes symlink details in error', async () => {
        lstat.mockResolvedValue({ isSymbolicLink: () => true });
        realpath.mockResolvedValue('/outside/file.txt');

        try {
          await validateResolvedPathWithinRoot('/project/evil-link', rootPath);
          fail('Should have thrown');
        } catch (error) {
          const validationError = error as ValidationError;
          expect(validationError.details).toBeDefined();
          expect(validationError.details?.path).toBe('/project/evil-link');
          expect(validationError.details?.realPath).toBe('/outside/file.txt');
          expect(validationError.details?.reason).toBe('symlink_escape');
        }
      });
    });
  });
});

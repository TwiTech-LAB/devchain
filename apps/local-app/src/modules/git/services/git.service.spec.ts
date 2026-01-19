import { Test, TestingModule } from '@nestjs/testing';
import { GitService } from './git.service';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { ValidationError, IOError } from '../../../common/errors/error-types';
import { existsSync, statSync } from 'fs';
import { execFile } from 'child_process';

// Mock fs module
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn(),
  statSync: jest.fn(),
}));

// Mock child_process
jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const mockStatSync = statSync as jest.MockedFunction<typeof statSync>;
const mockExecFile = execFile as unknown as jest.Mock;

describe('GitService', () => {
  let service: GitService;
  let mockStorage: {
    getProject: jest.Mock;
  };

  const mockProject = {
    id: 'project-1',
    rootPath: '/home/user/my-project',
    name: 'Test Project',
  };

  beforeEach(async () => {
    mockStorage = {
      getProject: jest.fn().mockResolvedValue(mockProject),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GitService,
        {
          provide: STORAGE_SERVICE,
          useValue: mockStorage,
        },
      ],
    }).compile();

    service = module.get<GitService>(GitService);
  });

  afterEach(() => {
    // Use resetAllMocks to clear both call history AND mock implementations
    // This prevents order-dependent behavior from persistent mockImplementation calls
    jest.resetAllMocks();
  });

  describe('validation', () => {
    it('should throw ValidationError if project is not a git repository', async () => {
      mockExistsSync.mockReturnValue(false);

      await expect(service.resolveRef('project-1', 'main')).rejects.toThrow(ValidationError);
      await expect(service.resolveRef('project-1', 'main')).rejects.toThrow(
        'Project is not a git repository',
      );
    });

    it('should throw ValidationError for paths outside project root', async () => {
      await expect(
        service.getFileContent('project-1', 'main', '../../../etc/passwd'),
      ).rejects.toThrow(ValidationError);
      await expect(
        service.getFileContent('project-1', 'main', '../../../etc/passwd'),
      ).rejects.toThrow('File path is outside project root');
    });

    it('should accept paths within project root', async () => {
      mockExistsSync.mockReturnValue(true);
      // Mock git command to return file content (validation should pass)
      mockExecFile.mockImplementationOnce((cmd, args, opts, cb) => {
        cb(null, { stdout: 'file content' });
      });

      // This should not throw ValidationError for a valid path within project
      const result = await service.getFileContent('project-1', 'main', 'src/index.ts');
      expect(result).toBe('file content');
    });

    it('should reject paths that share prefix but are outside project root', async () => {
      await expect(
        service.getFileContent('project-1', 'main', '/home/user/my-project2/evil.ts'),
      ).rejects.toThrow(ValidationError);
      await expect(
        service.getFileContent('project-1', 'main', '/home/user/my-project2/evil.ts'),
      ).rejects.toThrow('File path is outside project root');
    });
  });

  describe('isGitRepository', () => {
    it('should return true if .git directory exists', async () => {
      mockExistsSync.mockReturnValue(true);

      const result = await service.isGitRepository('project-1');

      expect(result).toBe(true);
      expect(mockExistsSync).toHaveBeenCalledWith('/home/user/my-project/.git');
    });

    it('should return false if .git directory does not exist', async () => {
      mockExistsSync.mockReturnValue(false);

      const result = await service.isGitRepository('project-1');

      expect(result).toBe(false);
    });

    it('should return false if project does not exist', async () => {
      mockStorage.getProject.mockRejectedValue(new Error('Project not found'));

      const result = await service.isGitRepository('project-1');

      expect(result).toBe(false);
    });
  });

  describe('service instantiation', () => {
    it('should be defined', () => {
      expect(service).toBeDefined();
    });

    it('should have all required methods', () => {
      expect(service.resolveRef).toBeDefined();
      expect(service.listCommits).toBeDefined();
      expect(service.listBranches).toBeDefined();
      expect(service.listTags).toBeDefined();
      expect(service.getDiff).toBeDefined();
      expect(service.getChangedFiles).toBeDefined();
      expect(service.getFileContent).toBeDefined();
      expect(service.isGitRepository).toBeDefined();
      expect(service.getCurrentBranch).toBeDefined();
      expect(service.getWorkingTreeChanges).toBeDefined();
      expect(service.getWorkingTreeDiff).toBeDefined();
      expect(service.getCommitDiff).toBeDefined();
      expect(service.getCommitChangedFiles).toBeDefined();
    });
  });

  describe('getWorkingTreeChanges', () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
    });

    it('should return staged, unstaged, and untracked files', async () => {
      // Mock staged changes
      mockExecFile
        .mockImplementationOnce((cmd, args, opts, cb) => {
          // staged numstat
          cb(null, { stdout: '10\t5\tsrc/file1.ts\n' });
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          // staged name-status
          cb(null, { stdout: 'M\tsrc/file1.ts\n' });
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          // unstaged numstat
          cb(null, { stdout: '3\t2\tsrc/file2.ts\n' });
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          // unstaged name-status
          cb(null, { stdout: 'M\tsrc/file2.ts\n' });
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          // untracked
          cb(null, { stdout: 'new-file.ts\nanother-file.ts\n' });
        });

      const result = await service.getWorkingTreeChanges('project-1');

      expect(result.staged).toHaveLength(1);
      expect(result.staged[0]).toEqual({
        path: 'src/file1.ts',
        status: 'modified',
        additions: 10,
        deletions: 5,
      });
      expect(result.unstaged).toHaveLength(1);
      expect(result.unstaged[0]).toEqual({
        path: 'src/file2.ts',
        status: 'modified',
        additions: 3,
        deletions: 2,
      });
      expect(result.untracked).toEqual(['new-file.ts', 'another-file.ts']);
    });

    it('should return empty arrays when working tree is clean', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, cb) => {
        cb(null, { stdout: '' });
      });

      const result = await service.getWorkingTreeChanges('project-1');

      expect(result.staged).toEqual([]);
      expect(result.unstaged).toEqual([]);
      expect(result.untracked).toEqual([]);
    });

    it('should filter to staged only', async () => {
      mockExecFile
        .mockImplementationOnce((cmd, args, opts, cb) => {
          cb(null, { stdout: '10\t5\tsrc/file1.ts\n' });
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          cb(null, { stdout: 'M\tsrc/file1.ts\n' });
        });

      const result = await service.getWorkingTreeChanges('project-1', 'staged');

      expect(result.staged).toHaveLength(1);
      expect(result.unstaged).toEqual([]);
      expect(result.untracked).toEqual([]);
    });

    it('should filter to unstaged only', async () => {
      mockExecFile
        .mockImplementationOnce((cmd, args, opts, cb) => {
          cb(null, { stdout: '3\t2\tsrc/file2.ts\n' });
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          cb(null, { stdout: 'M\tsrc/file2.ts\n' });
        });

      const result = await service.getWorkingTreeChanges('project-1', 'unstaged');

      expect(result.staged).toEqual([]);
      expect(result.unstaged).toHaveLength(1);
      expect(result.untracked).toEqual([]);
    });
  });

  describe('getWorkingTreeData', () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
      mockStatSync.mockReturnValue({ size: 1000 } as ReturnType<typeof statSync>);
    });

    it('should return combined changes and diff with single git ls-files call', async () => {
      mockExecFile
        .mockImplementationOnce((cmd, args, opts, cb) => {
          // staged numstat
          cb(null, { stdout: '10\t5\tsrc/file1.ts\n' });
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          // staged name-status
          cb(null, { stdout: 'M\tsrc/file1.ts\n' });
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          // staged diff
          cb(null, { stdout: 'diff --git a/staged.ts b/staged.ts\n...\n' });
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          // unstaged numstat
          cb(null, { stdout: '3\t2\tsrc/file2.ts\n' });
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          // unstaged name-status
          cb(null, { stdout: 'M\tsrc/file2.ts\n' });
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          // unstaged diff
          cb(null, { stdout: 'diff --git a/unstaged.ts b/unstaged.ts\n...\n' });
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          // ls-files --others (ONLY ONE CALL)
          cb(null, { stdout: 'new-file.ts\n' });
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          // git diff --no-index --numstat (binary check)
          cb(null, { stdout: '10\t0\tnew-file.ts\n' });
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          // git diff --no-index for actual diff (exits with code 1 for differences)
          const error = new Error('exit 1') as Error & { stdout: string; code: number };
          error.code = 1;
          error.stdout = 'diff --git a/new-file.ts b/new-file.ts\n...\n';
          cb(error);
        });

      const result = await service.getWorkingTreeData('project-1');

      // Verify changes
      expect(result.changes.staged).toHaveLength(1);
      expect(result.changes.staged[0].path).toBe('src/file1.ts');
      expect(result.changes.unstaged).toHaveLength(1);
      expect(result.changes.unstaged[0].path).toBe('src/file2.ts');
      expect(result.changes.untracked).toEqual(['new-file.ts']);

      // Verify diff contains all parts
      expect(result.diff).toContain('staged.ts');
      expect(result.diff).toContain('unstaged.ts');

      // Verify ls-files was called only ONCE
      const lsFilesCalls = mockExecFile.mock.calls.filter(
        (call) => call[1] && call[1].includes('ls-files'),
      );
      expect(lsFilesCalls).toHaveLength(1);
    });

    it('should handle filter=staged without calling ls-files', async () => {
      mockExecFile
        .mockImplementationOnce((cmd, args, opts, cb) => {
          cb(null, { stdout: '10\t5\tsrc/file1.ts\n' });
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          cb(null, { stdout: 'M\tsrc/file1.ts\n' });
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          cb(null, { stdout: 'diff --git a/staged.ts\n' });
        });

      const result = await service.getWorkingTreeData('project-1', 'staged');

      expect(result.changes.staged).toHaveLength(1);
      expect(result.changes.unstaged).toEqual([]);
      expect(result.changes.untracked).toEqual([]);

      // ls-files should NOT be called for staged filter
      const lsFilesCalls = mockExecFile.mock.calls.filter(
        (call) => call[1] && call[1].includes('ls-files'),
      );
      expect(lsFilesCalls).toHaveLength(0);
    });
  });

  describe('getWorkingTreeDiff', () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
      mockStatSync.mockReturnValue({ size: 1000 } as ReturnType<typeof statSync>);
    });

    it('should return combined staged and unstaged diff', async () => {
      mockExecFile
        .mockImplementationOnce((cmd, args, opts, cb) => {
          cb(null, { stdout: 'diff --git a/staged.ts b/staged.ts\n...\n' });
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          cb(null, { stdout: 'diff --git a/unstaged.ts b/unstaged.ts\n...\n' });
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          // ls-files --others for untracked
          cb(null, { stdout: '' });
        });

      const result = await service.getWorkingTreeDiff('project-1');

      expect(result.diff).toContain('staged.ts');
      expect(result.diff).toContain('unstaged.ts');
      expect(result.untrackedDiffsCapped).toBe(false);
    });

    it('should return only staged diff with filter', async () => {
      mockExecFile.mockImplementationOnce((cmd, args, opts, cb) => {
        cb(null, { stdout: 'diff --git a/staged.ts b/staged.ts\n...\n' });
      });

      const result = await service.getWorkingTreeDiff('project-1', 'staged');

      expect(result.diff).toContain('staged.ts');
    });

    it('should include untracked file diffs when filter is all', async () => {
      mockExecFile
        .mockImplementationOnce((cmd, args, opts, cb) => {
          // staged diff
          cb(null, { stdout: '' });
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          // unstaged diff
          cb(null, { stdout: '' });
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          // ls-files --others for untracked
          cb(null, { stdout: 'new-file.ts\n' });
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          // git diff --no-index --numstat (binary check)
          cb(null, { stdout: '10\t0\tnew-file.ts\n' });
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          // git diff --no-index for actual diff (exits with code 1 for differences)
          const error = new Error('exit 1') as Error & { stdout: string; code: number };
          error.code = 1;
          error.stdout =
            'diff --git a/new-file.ts b/new-file.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new-file.ts\n@@ -0,0 +1 @@\n+content\n';
          cb(error);
        });

      const result = await service.getWorkingTreeDiff('project-1');

      expect(result.diff).toContain('new-file.ts');
      expect(result.diff).toContain('new file mode');
      expect(result.untrackedTotal).toBe(1);
      expect(result.untrackedProcessed).toBe(1);
      expect(result.untrackedDiffsCapped).toBe(false);
    });

    it('should generate placeholder diff for binary untracked files', async () => {
      mockExecFile
        .mockImplementationOnce((cmd, args, opts, cb) => {
          cb(null, { stdout: '' }); // staged
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          cb(null, { stdout: '' }); // unstaged
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          cb(null, { stdout: 'image.png\n' }); // ls-files --others
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          // Binary file detection: numstat shows -\t-\t for binary
          cb(null, { stdout: '-\t-\timage.png\n' });
        });

      const result = await service.getWorkingTreeDiff('project-1');

      expect(result.diff).toContain('image.png');
      expect(result.diff).toContain('Binary file');
    });

    it('should generate placeholder diff for large untracked files', async () => {
      // Mock large file (2MB)
      mockStatSync.mockReturnValue({ size: 2 * 1024 * 1024 } as ReturnType<typeof statSync>);

      mockExecFile
        .mockImplementationOnce((cmd, args, opts, cb) => {
          cb(null, { stdout: '' }); // staged
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          cb(null, { stdout: '' }); // unstaged
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          cb(null, { stdout: 'large-file.ts\n' }); // ls-files --others
        });

      const result = await service.getWorkingTreeDiff('project-1');

      expect(result.diff).toContain('large-file.ts');
      expect(result.diff).toContain('File too large');
      expect(result.diff).toContain('2.00MB');
    });

    it('should not include untracked diffs when filter is staged', async () => {
      mockExecFile.mockImplementationOnce((cmd, args, opts, cb) => {
        cb(null, { stdout: 'diff --git a/staged.ts b/staged.ts\n...\n' });
      });

      const result = await service.getWorkingTreeDiff('project-1', 'staged');

      // Should only have the staged diff call, not ls-files for untracked
      expect(mockExecFile).toHaveBeenCalledTimes(1);
      expect(result.diff).toContain('staged.ts');
    });

    it('should not include untracked diffs when filter is unstaged', async () => {
      mockExecFile.mockImplementationOnce((cmd, args, opts, cb) => {
        cb(null, { stdout: 'diff --git a/unstaged.ts b/unstaged.ts\n...\n' });
      });

      const result = await service.getWorkingTreeDiff('project-1', 'unstaged');

      // Should only have the unstaged diff call, not ls-files for untracked
      expect(mockExecFile).toHaveBeenCalledTimes(1);
      expect(result.diff).toContain('unstaged.ts');
    });

    it('should skip untracked files that no longer exist', async () => {
      mockExecFile
        .mockImplementationOnce((cmd, args, opts, cb) => {
          cb(null, { stdout: '' }); // staged
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          cb(null, { stdout: '' }); // unstaged
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          cb(null, { stdout: 'deleted-file.ts\n' }); // ls-files --others
        });

      // File no longer exists (deleted after ls-files ran)
      mockExistsSync.mockImplementation((path: string) => {
        if (typeof path === 'string' && path.includes('deleted-file.ts')) {
          return false;
        }
        return true; // .git exists
      });

      const result = await service.getWorkingTreeDiff('project-1');

      // Should not contain the deleted file
      expect(result.diff).not.toContain('deleted-file.ts');
    });

    it('should skip file gracefully when exit code 2 occurs (IOError caught per-file)', async () => {
      // This test verifies that:
      // 1. Exit code 2 causes IOError to be thrown by execGit (not swallowed by allowNonZero)
      // 2. The per-file error handling catches it gracefully
      // 3. The problematic file is skipped, method completes without crashing
      mockExecFile
        .mockImplementationOnce((cmd, args, opts, cb) => {
          cb(null, { stdout: '' }); // staged diff
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          cb(null, { stdout: '' }); // unstaged diff
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          // ls-files returns untracked file
          cb(null, { stdout: 'problem-file.ts\n' });
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          // Binary check succeeds (not binary)
          cb(null, { stdout: '10\t0\tproblem-file.ts\n' });
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          // git diff --no-index exits with code 2 (real error, e.g., file not found)
          // This should cause IOError to be thrown (not swallowed by allowNonZero)
          // But the per-file try/catch handles it gracefully
          const error = new Error('fatal: unable to read file') as Error & {
            code: number;
            stdout?: string;
            stderr?: string;
          };
          error.code = 2;
          error.stderr = 'fatal: unable to read file';
          cb(error);
        });

      // Method completes without throwing (per-file errors are caught)
      const result = await service.getWorkingTreeDiff('project-1');

      // File was counted but its diff was not included (skipped due to error)
      expect(result.untrackedTotal).toBe(1);
      expect(result.untrackedProcessed).toBe(1);
      expect(result.diff).toBe(''); // No diff because the file errored
    });
  });

  describe('getCommitDiff', () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
    });

    it('should return diff for a valid commit', async () => {
      mockExecFile.mockImplementationOnce((cmd, args, opts, cb) => {
        cb(null, { stdout: 'diff --git a/file.ts b/file.ts\n+++ added line\n' });
      });

      const result = await service.getCommitDiff('project-1', 'abc1234');

      expect(result).toContain('diff --git');
      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        ['show', 'abc1234', '--format='],
        expect.any(Object),
        expect.any(Function),
      );
    });

    it('should throw ValidationError for invalid SHA format', async () => {
      await expect(service.getCommitDiff('project-1', 'invalid!sha')).rejects.toThrow(
        ValidationError,
      );
      await expect(service.getCommitDiff('project-1', 'invalid!sha')).rejects.toThrow(
        'Invalid commit SHA',
      );
    });

    it('should accept full 40-char SHA', async () => {
      mockExecFile.mockImplementationOnce((cmd, args, opts, cb) => {
        cb(null, { stdout: 'diff content' });
      });

      const sha = 'a'.repeat(40);
      await expect(service.getCommitDiff('project-1', sha)).resolves.toBeDefined();
    });
  });

  describe('getCommitChangedFiles', () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
    });

    it('should return changed files for a commit', async () => {
      mockExecFile
        .mockImplementationOnce((cmd, args, opts, cb) => {
          // numstat
          cb(null, { stdout: '15\t3\tsrc/component.tsx\n' });
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          // name-status
          cb(null, { stdout: 'A\tsrc/component.tsx\n' });
        });

      const result = await service.getCommitChangedFiles('project-1', 'abc1234');

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        path: 'src/component.tsx',
        status: 'added',
        additions: 15,
        deletions: 3,
      });
    });

    it('should throw ValidationError for invalid SHA', async () => {
      await expect(service.getCommitChangedFiles('project-1', '../../../')).rejects.toThrow(
        ValidationError,
      );
    });
  });

  describe('line parsing edge cases (CRLF handling)', () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
      mockStatSync.mockReturnValue({ size: 1000 } as ReturnType<typeof statSync>);
    });

    it('should handle CRLF line endings in untracked file list', async () => {
      // Helper to create binary check and diff mocks for a file
      const addFileMocks = (fileName: string) => {
        mockExecFile
          .mockImplementationOnce((cmd, args, opts, cb) => {
            // Binary check (numstat)
            cb(null, { stdout: `10\t0\t${fileName}\n` });
          })
          .mockImplementationOnce((cmd, args, opts, cb) => {
            // Actual diff (exits with code 1)
            const error = new Error('exit 1') as Error & { stdout: string; code: number };
            error.code = 1;
            error.stdout = `diff --git a/${fileName} b/${fileName}\n+content\n`;
            cb(error);
          });
      };

      mockExecFile
        .mockImplementationOnce((cmd, args, opts, cb) => {
          cb(null, { stdout: '' }); // staged diff
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          cb(null, { stdout: '' }); // unstaged diff
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          // Windows-style CRLF line endings
          cb(null, { stdout: 'file1.ts\r\nfile2.ts\r\nfile3.ts\r\n' });
        });

      // Add mocks for each of the 3 files
      addFileMocks('file1.ts');
      addFileMocks('file2.ts');
      addFileMocks('file3.ts');

      const result = await service.getWorkingTreeDiff('project-1');

      expect(result.untrackedTotal).toBe(3);
      expect(result.diff).not.toContain('\r');
    });

    it('should handle mixed line endings in git output', async () => {
      const addFileMocks = (fileName: string) => {
        mockExecFile
          .mockImplementationOnce((cmd, args, opts, cb) => {
            cb(null, { stdout: `10\t0\t${fileName}\n` });
          })
          .mockImplementationOnce((cmd, args, opts, cb) => {
            const error = new Error('exit 1') as Error & { stdout: string; code: number };
            error.code = 1;
            error.stdout = `diff --git a/${fileName} b/${fileName}\n+content\n`;
            cb(error);
          });
      };

      mockExecFile
        .mockImplementationOnce((cmd, args, opts, cb) => {
          cb(null, { stdout: '' });
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          cb(null, { stdout: '' });
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          // Mixed: some lines with CRLF, some with just LF
          cb(null, { stdout: 'file1.ts\r\nfile2.ts\nfile3.ts\r\n' });
        });

      addFileMocks('file1.ts');
      addFileMocks('file2.ts');
      addFileMocks('file3.ts');

      const result = await service.getWorkingTreeDiff('project-1');

      expect(result.untrackedTotal).toBe(3);
    });

    it('should filter empty lines from git output', async () => {
      const addFileMocks = (fileName: string) => {
        mockExecFile
          .mockImplementationOnce((cmd, args, opts, cb) => {
            cb(null, { stdout: `10\t0\t${fileName}\n` });
          })
          .mockImplementationOnce((cmd, args, opts, cb) => {
            const error = new Error('exit 1') as Error & { stdout: string; code: number };
            error.code = 1;
            error.stdout = `diff --git a/${fileName} b/${fileName}\n+content\n`;
            cb(error);
          });
      };

      mockExecFile
        .mockImplementationOnce((cmd, args, opts, cb) => {
          cb(null, { stdout: '' });
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          cb(null, { stdout: '' });
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          // Output with empty lines that could result from trailing newlines
          cb(null, { stdout: 'file1.ts\n\nfile2.ts\n\n' });
        });

      addFileMocks('file1.ts');
      addFileMocks('file2.ts');

      const result = await service.getWorkingTreeDiff('project-1');

      // Should only count actual files, not empty strings
      expect(result.untrackedTotal).toBe(2);
    });

    it('should handle CRLF in getWorkingTreeChanges untracked files', async () => {
      mockExecFile
        .mockImplementationOnce((cmd, args, opts, cb) => {
          cb(null, { stdout: '' }); // staged numstat
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          cb(null, { stdout: '' }); // staged name-status
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          cb(null, { stdout: '' }); // unstaged numstat
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          cb(null, { stdout: '' }); // unstaged name-status
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          // CRLF line endings in untracked list
          cb(null, { stdout: 'new-file.ts\r\nanother-file.ts\r\n' });
        });

      const result = await service.getWorkingTreeChanges('project-1');

      expect(result.untracked).toEqual(['new-file.ts', 'another-file.ts']);
      expect(result.untracked).not.toContain('');
    });

    it('should handle CRLF in changed files parsing', async () => {
      mockExecFile
        .mockImplementationOnce((cmd, args, opts, cb) => {
          // numstat with CRLF
          cb(null, { stdout: '10\t5\tsrc/file1.ts\r\n3\t2\tsrc/file2.ts\r\n' });
        })
        .mockImplementationOnce((cmd, args, opts, cb) => {
          // name-status with CRLF
          cb(null, { stdout: 'M\tsrc/file1.ts\r\nA\tsrc/file2.ts\r\n' });
        });

      const result = await service.getCommitChangedFiles('project-1', 'abc1234');

      expect(result).toHaveLength(2);
      expect(result[0].path).toBe('src/file1.ts');
      expect(result[1].path).toBe('src/file2.ts');
    });
  });

  describe('execGit exit code handling', () => {
    // Git exit codes: 0 = success, 1 = diff found (not an error), 2+ = real error
    // allowNonZero option should only tolerate exit code 1, not 2+

    it('should throw IOError for exit code 2 even with allowNonZero and stdout present', async () => {
      // exit code 2 = git error (e.g., invalid argument, ambiguous ref, file not found)
      // allowNonZero only tolerates exit code 1 (diff found)
      const error = new Error('Command failed') as Error & {
        code: number;
        stdout: string;
        stderr: string;
      };
      error.code = 2;
      error.stdout = 'some output that should be ignored';
      error.stderr = 'fatal: some error';

      mockExistsSync.mockReturnValue(true);
      mockExecFile.mockImplementationOnce((cmd, args, opts, cb) => {
        cb(error);
      });
      mockStorage.getProject.mockResolvedValueOnce({ rootPath: '/project' });

      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private method for testing
        (service as any).execGit(
          'project-id',
          ['diff', '--no-index', '--', '/dev/null', 'file.txt'],
          { allowNonZero: true },
        ),
      ).rejects.toThrow(IOError);
    });

    it('should include exit code in IOError metadata', async () => {
      const error = new Error('Command failed') as Error & {
        code: number;
        stdout: string;
        stderr: string;
      };
      error.code = 2;
      error.stdout = '';
      error.stderr = 'fatal: error';

      mockExistsSync.mockReturnValue(true);
      mockExecFile.mockImplementationOnce((cmd, args, opts, cb) => {
        cb(error);
      });
      mockStorage.getProject.mockResolvedValueOnce({ rootPath: '/project' });

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private method for testing
        await (service as any).execGit('project-id', ['diff'], { allowNonZero: true });
        fail('Expected IOError to be thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(IOError);
        expect((err as IOError).details).toMatchObject({ code: 2 });
      }
    });

    it('should NOT throw for exit code 1 when allowNonZero is true', async () => {
      // exit code 1 = diff found, not an error
      const error = new Error('Command failed') as Error & {
        code: number;
        stdout: string;
        stderr: string;
      };
      error.code = 1;
      error.stdout = 'diff --git a/file.txt b/file.txt\n-old\n+new';
      error.stderr = '';

      mockExistsSync.mockReturnValue(true);
      mockExecFile.mockImplementationOnce((cmd, args, opts, cb) => {
        cb(error);
      });
      mockStorage.getProject.mockResolvedValueOnce({ rootPath: '/project' });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private method for testing
      const result = await (service as any).execGit('project-id', ['diff'], {
        allowNonZero: true,
      });
      expect(result).toContain('diff --git');
    });

    it('should throw IOError for exit code 128 (fatal git error)', async () => {
      // exit code 128 = fatal error (e.g., not a git repo, invalid object)
      const error = new Error('Command failed') as Error & {
        code: number;
        stdout: string;
        stderr: string;
      };
      error.code = 128;
      error.stdout = '';
      error.stderr = 'fatal: not a git repository';

      mockExistsSync.mockReturnValue(true);
      mockExecFile.mockImplementationOnce((cmd, args, opts, cb) => {
        cb(error);
      });
      mockStorage.getProject.mockResolvedValueOnce({ rootPath: '/project' });

      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private method for testing
        (service as any).execGit('project-id', ['status'], { allowNonZero: true }),
      ).rejects.toThrow(IOError);

      mockExistsSync.mockReturnValue(true);
      mockExecFile.mockImplementationOnce((cmd, args, opts, cb) => {
        cb(error);
      });
      mockStorage.getProject.mockResolvedValueOnce({ rootPath: '/project' });
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private method for testing
        await (service as any).execGit('project-id', ['status'], { allowNonZero: true });
      } catch (err) {
        expect((err as IOError).details).toMatchObject({ code: 128 });
      }
    });
  });
});

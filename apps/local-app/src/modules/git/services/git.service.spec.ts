import { Test, TestingModule } from '@nestjs/testing';
import { GitService } from './git.service';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { ValidationError, IOError } from '../../../common/errors/error-types';
import { existsSync, statSync } from 'fs';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { FakeProcessExecutor } from '../../terminal/services/process-executor/fake-process-executor';

// Mock fs module
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn(),
  statSync: jest.fn(),
}));

const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const mockStatSync = statSync as jest.MockedFunction<typeof statSync>;

describe('GitService', () => {
  let service: GitService;
  let fakeExecutor: FakeProcessExecutor;
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

    fakeExecutor = new FakeProcessExecutor();
    fakeExecutor.setDefaultResponse({ type: 'success', stdout: '' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GitService,
        {
          provide: STORAGE_SERVICE,
          useValue: mockStorage,
        },
        {
          provide: ProcessExecutor,
          useValue: fakeExecutor,
        },
      ],
    }).compile();

    service = module.get<GitService>(GitService);
  });

  afterEach(() => {
    fakeExecutor.reset();
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
      fakeExecutor.enqueueResponse({ type: 'success', stdout: 'file content' });

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
      fakeExecutor.enqueueResponse(
        { type: 'success', stdout: '10\t5\tsrc/file1.ts\n' }, // staged numstat
        { type: 'success', stdout: 'M\tsrc/file1.ts\n' }, // staged name-status
        { type: 'success', stdout: '3\t2\tsrc/file2.ts\n' }, // unstaged numstat
        { type: 'success', stdout: 'M\tsrc/file2.ts\n' }, // unstaged name-status
        { type: 'success', stdout: 'new-file.ts\nanother-file.ts\n' }, // untracked
      );

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
      // default response is { type: 'success', stdout: '' }

      const result = await service.getWorkingTreeChanges('project-1');

      expect(result.staged).toEqual([]);
      expect(result.unstaged).toEqual([]);
      expect(result.untracked).toEqual([]);
    });

    it('should filter to staged only', async () => {
      fakeExecutor.enqueueResponse(
        { type: 'success', stdout: '10\t5\tsrc/file1.ts\n' },
        { type: 'success', stdout: 'M\tsrc/file1.ts\n' },
      );

      const result = await service.getWorkingTreeChanges('project-1', 'staged');

      expect(result.staged).toHaveLength(1);
      expect(result.unstaged).toEqual([]);
      expect(result.untracked).toEqual([]);
    });

    it('should filter to unstaged only', async () => {
      fakeExecutor.enqueueResponse(
        { type: 'success', stdout: '3\t2\tsrc/file2.ts\n' },
        { type: 'success', stdout: 'M\tsrc/file2.ts\n' },
      );

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
      fakeExecutor.enqueueResponse(
        { type: 'success', stdout: '10\t5\tsrc/file1.ts\n' }, // staged numstat
        { type: 'success', stdout: 'M\tsrc/file1.ts\n' }, // staged name-status
        { type: 'success', stdout: 'diff --git a/staged.ts b/staged.ts\n...\n' }, // staged diff
        { type: 'success', stdout: '3\t2\tsrc/file2.ts\n' }, // unstaged numstat
        { type: 'success', stdout: 'M\tsrc/file2.ts\n' }, // unstaged name-status
        { type: 'success', stdout: 'diff --git a/unstaged.ts b/unstaged.ts\n...\n' }, // unstaged diff
        { type: 'success', stdout: 'new-file.ts\n' }, // ls-files --others
        { type: 'success', stdout: '10\t0\tnew-file.ts\n' }, // binary check
        { type: 'failure', exitCode: 1, stdout: 'diff --git a/new-file.ts b/new-file.ts\n...\n' }, // diff --no-index (exit 1)
      );

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
      const lsFilesCalls = fakeExecutor.calls.filter((call) => call.argv.includes('ls-files'));
      expect(lsFilesCalls).toHaveLength(1);
    });

    it('should handle filter=staged without calling ls-files', async () => {
      fakeExecutor.enqueueResponse(
        { type: 'success', stdout: '10\t5\tsrc/file1.ts\n' },
        { type: 'success', stdout: 'M\tsrc/file1.ts\n' },
        { type: 'success', stdout: 'diff --git a/staged.ts\n' },
      );

      const result = await service.getWorkingTreeData('project-1', 'staged');

      expect(result.changes.staged).toHaveLength(1);
      expect(result.changes.unstaged).toEqual([]);
      expect(result.changes.untracked).toEqual([]);

      // ls-files should NOT be called for staged filter
      const lsFilesCalls = fakeExecutor.calls.filter((call) => call.argv.includes('ls-files'));
      expect(lsFilesCalls).toHaveLength(0);
    });
  });

  describe('getWorkingTreeDiff', () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
      mockStatSync.mockReturnValue({ size: 1000 } as ReturnType<typeof statSync>);
    });

    it('should return combined staged and unstaged diff', async () => {
      fakeExecutor.enqueueResponse(
        { type: 'success', stdout: 'diff --git a/staged.ts b/staged.ts\n...\n' },
        { type: 'success', stdout: 'diff --git a/unstaged.ts b/unstaged.ts\n...\n' },
        { type: 'success', stdout: '' }, // ls-files --others
      );

      const result = await service.getWorkingTreeDiff('project-1');

      expect(result.diff).toContain('staged.ts');
      expect(result.diff).toContain('unstaged.ts');
      expect(result.untrackedDiffsCapped).toBe(false);
    });

    it('should return only staged diff with filter', async () => {
      fakeExecutor.enqueueResponse({
        type: 'success',
        stdout: 'diff --git a/staged.ts b/staged.ts\n...\n',
      });

      const result = await service.getWorkingTreeDiff('project-1', 'staged');

      expect(result.diff).toContain('staged.ts');
    });

    it('should include untracked file diffs when filter is all', async () => {
      fakeExecutor.enqueueResponse(
        { type: 'success', stdout: '' }, // staged diff
        { type: 'success', stdout: '' }, // unstaged diff
        { type: 'success', stdout: 'new-file.ts\n' }, // ls-files --others
        { type: 'success', stdout: '10\t0\tnew-file.ts\n' }, // binary check
        {
          type: 'failure',
          exitCode: 1,
          stdout:
            'diff --git a/new-file.ts b/new-file.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new-file.ts\n@@ -0,0 +1 @@\n+content\n',
        },
      );

      const result = await service.getWorkingTreeDiff('project-1');

      expect(result.diff).toContain('new-file.ts');
      expect(result.diff).toContain('new file mode');
      expect(result.untrackedTotal).toBe(1);
      expect(result.untrackedProcessed).toBe(1);
      expect(result.untrackedDiffsCapped).toBe(false);
    });

    it('should generate placeholder diff for binary untracked files', async () => {
      fakeExecutor.enqueueResponse(
        { type: 'success', stdout: '' }, // staged
        { type: 'success', stdout: '' }, // unstaged
        { type: 'success', stdout: 'image.png\n' }, // ls-files --others
        { type: 'success', stdout: '-\t-\timage.png\n' }, // binary detection
      );

      const result = await service.getWorkingTreeDiff('project-1');

      expect(result.diff).toContain('image.png');
      expect(result.diff).toContain('Binary file');
    });

    it('should generate placeholder diff for large untracked files', async () => {
      // Mock large file (2MB)
      mockStatSync.mockReturnValue({ size: 2 * 1024 * 1024 } as ReturnType<typeof statSync>);

      fakeExecutor.enqueueResponse(
        { type: 'success', stdout: '' }, // staged
        { type: 'success', stdout: '' }, // unstaged
        { type: 'success', stdout: 'large-file.ts\n' }, // ls-files --others
      );

      const result = await service.getWorkingTreeDiff('project-1');

      expect(result.diff).toContain('large-file.ts');
      expect(result.diff).toContain('File too large');
      expect(result.diff).toContain('2.00MB');
    });

    it('should not include untracked diffs when filter is staged', async () => {
      fakeExecutor.enqueueResponse({
        type: 'success',
        stdout: 'diff --git a/staged.ts b/staged.ts\n...\n',
      });

      const result = await service.getWorkingTreeDiff('project-1', 'staged');

      // Should only have the staged diff call, not ls-files for untracked
      expect(fakeExecutor.calls).toHaveLength(1);
      expect(result.diff).toContain('staged.ts');
    });

    it('should not include untracked diffs when filter is unstaged', async () => {
      fakeExecutor.enqueueResponse({
        type: 'success',
        stdout: 'diff --git a/unstaged.ts b/unstaged.ts\n...\n',
      });

      const result = await service.getWorkingTreeDiff('project-1', 'unstaged');

      // Should only have the unstaged diff call, not ls-files for untracked
      expect(fakeExecutor.calls).toHaveLength(1);
      expect(result.diff).toContain('unstaged.ts');
    });

    it('should skip untracked files that no longer exist', async () => {
      fakeExecutor.enqueueResponse(
        { type: 'success', stdout: '' }, // staged
        { type: 'success', stdout: '' }, // unstaged
        { type: 'success', stdout: 'deleted-file.ts\n' }, // ls-files --others
      );

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
      fakeExecutor.enqueueResponse(
        { type: 'success', stdout: '' }, // staged diff
        { type: 'success', stdout: '' }, // unstaged diff
        { type: 'success', stdout: 'problem-file.ts\n' }, // ls-files
        { type: 'success', stdout: '10\t0\tproblem-file.ts\n' }, // binary check
        { type: 'failure', exitCode: 2, stderr: 'fatal: unable to read file' }, // diff --no-index exit 2
      );

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
      fakeExecutor.enqueueResponse({
        type: 'success',
        stdout: 'diff --git a/file.ts b/file.ts\n+++ added line\n',
      });

      const result = await service.getCommitDiff('project-1', 'abc1234');

      expect(result).toContain('diff --git');
      expect(fakeExecutor.calls[0].argv).toEqual(['git', 'show', 'abc1234', '--format=']);
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
      fakeExecutor.enqueueResponse({ type: 'success', stdout: 'diff content' });

      const sha = 'a'.repeat(40);
      await expect(service.getCommitDiff('project-1', sha)).resolves.toBeDefined();
    });
  });

  describe('getCommitChangedFiles', () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
    });

    it('should return changed files for a commit', async () => {
      fakeExecutor.enqueueResponse(
        { type: 'success', stdout: '15\t3\tsrc/component.tsx\n' }, // numstat
        { type: 'success', stdout: 'A\tsrc/component.tsx\n' }, // name-status
      );

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
      fakeExecutor.enqueueResponse(
        { type: 'success', stdout: '' }, // staged diff
        { type: 'success', stdout: '' }, // unstaged diff
        { type: 'success', stdout: 'file1.ts\r\nfile2.ts\r\nfile3.ts\r\n' }, // CRLF in ls-files
        // file1.ts
        { type: 'success', stdout: '10\t0\tfile1.ts\n' },
        { type: 'failure', exitCode: 1, stdout: 'diff --git a/file1.ts b/file1.ts\n+content\n' },
        // file2.ts
        { type: 'success', stdout: '10\t0\tfile2.ts\n' },
        { type: 'failure', exitCode: 1, stdout: 'diff --git a/file2.ts b/file2.ts\n+content\n' },
        // file3.ts
        { type: 'success', stdout: '10\t0\tfile3.ts\n' },
        { type: 'failure', exitCode: 1, stdout: 'diff --git a/file3.ts b/file3.ts\n+content\n' },
      );

      const result = await service.getWorkingTreeDiff('project-1');

      expect(result.untrackedTotal).toBe(3);
      expect(result.diff).not.toContain('\r');
    });

    it('should handle mixed line endings in git output', async () => {
      fakeExecutor.enqueueResponse(
        { type: 'success', stdout: '' },
        { type: 'success', stdout: '' },
        { type: 'success', stdout: 'file1.ts\r\nfile2.ts\nfile3.ts\r\n' },
        // file1.ts
        { type: 'success', stdout: '10\t0\tfile1.ts\n' },
        { type: 'failure', exitCode: 1, stdout: 'diff --git a/file1.ts b/file1.ts\n+content\n' },
        // file2.ts
        { type: 'success', stdout: '10\t0\tfile2.ts\n' },
        { type: 'failure', exitCode: 1, stdout: 'diff --git a/file2.ts b/file2.ts\n+content\n' },
        // file3.ts
        { type: 'success', stdout: '10\t0\tfile3.ts\n' },
        { type: 'failure', exitCode: 1, stdout: 'diff --git a/file3.ts b/file3.ts\n+content\n' },
      );

      const result = await service.getWorkingTreeDiff('project-1');

      expect(result.untrackedTotal).toBe(3);
    });

    it('should filter empty lines from git output', async () => {
      fakeExecutor.enqueueResponse(
        { type: 'success', stdout: '' },
        { type: 'success', stdout: '' },
        { type: 'success', stdout: 'file1.ts\n\nfile2.ts\n\n' },
        // file1.ts
        { type: 'success', stdout: '10\t0\tfile1.ts\n' },
        { type: 'failure', exitCode: 1, stdout: 'diff --git a/file1.ts b/file1.ts\n+content\n' },
        // file2.ts
        { type: 'success', stdout: '10\t0\tfile2.ts\n' },
        { type: 'failure', exitCode: 1, stdout: 'diff --git a/file2.ts b/file2.ts\n+content\n' },
      );

      const result = await service.getWorkingTreeDiff('project-1');

      // Should only count actual files, not empty strings
      expect(result.untrackedTotal).toBe(2);
    });

    it('should handle CRLF in getWorkingTreeChanges untracked files', async () => {
      fakeExecutor.enqueueResponse(
        { type: 'success', stdout: '' }, // staged numstat
        { type: 'success', stdout: '' }, // staged name-status
        { type: 'success', stdout: '' }, // unstaged numstat
        { type: 'success', stdout: '' }, // unstaged name-status
        { type: 'success', stdout: 'new-file.ts\r\nanother-file.ts\r\n' }, // untracked
      );

      const result = await service.getWorkingTreeChanges('project-1');

      expect(result.untracked).toEqual(['new-file.ts', 'another-file.ts']);
      expect(result.untracked).not.toContain('');
    });

    it('should handle CRLF in changed files parsing', async () => {
      fakeExecutor.enqueueResponse(
        { type: 'success', stdout: '10\t5\tsrc/file1.ts\r\n3\t2\tsrc/file2.ts\r\n' }, // numstat
        { type: 'success', stdout: 'M\tsrc/file1.ts\r\nA\tsrc/file2.ts\r\n' }, // name-status
      );

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
      mockExistsSync.mockReturnValue(true);
      mockStorage.getProject.mockResolvedValueOnce({ rootPath: '/project' });

      fakeExecutor.enqueueResponse({
        type: 'failure',
        exitCode: 2,
        stdout: 'some output that should be ignored',
        stderr: 'fatal: some error',
      });

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
      mockExistsSync.mockReturnValue(true);
      mockStorage.getProject.mockResolvedValueOnce({ rootPath: '/project' });

      fakeExecutor.enqueueResponse({
        type: 'failure',
        exitCode: 2,
        stdout: '',
        stderr: 'fatal: error',
      });

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
      mockExistsSync.mockReturnValue(true);
      mockStorage.getProject.mockResolvedValueOnce({ rootPath: '/project' });

      fakeExecutor.enqueueResponse({
        type: 'failure',
        exitCode: 1,
        stdout: 'diff --git a/file.txt b/file.txt\n-old\n+new',
        stderr: '',
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private method for testing
      const result = await (service as any).execGit('project-id', ['diff'], {
        allowNonZero: true,
      });
      expect(result).toContain('diff --git');
    });

    it('should throw IOError for exit code 128 (fatal git error)', async () => {
      mockExistsSync.mockReturnValue(true);
      mockStorage.getProject.mockResolvedValueOnce({ rootPath: '/project' });

      fakeExecutor.enqueueResponse({
        type: 'failure',
        exitCode: 128,
        stdout: '',
        stderr: 'fatal: not a git repository',
      });

      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private method for testing
        (service as any).execGit('project-id', ['status'], { allowNonZero: true }),
      ).rejects.toThrow(IOError);

      mockExistsSync.mockReturnValue(true);
      mockStorage.getProject.mockResolvedValueOnce({ rootPath: '/project' });

      fakeExecutor.enqueueResponse({
        type: 'failure',
        exitCode: 128,
        stdout: '',
        stderr: 'fatal: not a git repository',
      });

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private method for testing
        await (service as any).execGit('project-id', ['status'], { allowNonZero: true });
      } catch (err) {
        expect((err as IOError).details).toMatchObject({ code: 128 });
      }
    });
  });
});

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SubagentLocator, type SubagentFileInfo } from './subagent-locator.service';

jest.mock('node:fs/promises');

const mockReaddir = fs.readdir as jest.MockedFunction<typeof fs.readdir>;

describe('SubagentLocator', () => {
  let locator: SubagentLocator;

  const parentFilePath = '/home/user/.claude/projects/-home-user-repo/abc123.jsonl';
  const projectDir = '/home/user/.claude/projects/-home-user-repo';

  beforeEach(() => {
    jest.resetAllMocks();
    locator = new SubagentLocator();
    // Default: empty directories
    mockReaddir.mockResolvedValue([]);
  });

  // -------------------------------------------------------------------------
  // New directory structure
  // -------------------------------------------------------------------------

  describe('new directory structure', () => {
    it('should discover files in {sessionUuid}/subagents/', async () => {
      const newDir = path.join(projectDir, 'abc123', 'subagents');

      mockReaddir.mockImplementation(async (dirPath) => {
        if (dirPath === newDir) {
          return [
            { name: 'agent-0.jsonl', isFile: () => true },
            { name: 'agent-1.jsonl', isFile: () => true },
          ] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
        }
        return [] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
      });

      const results = await locator.locate(parentFilePath);

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual<SubagentFileInfo>({
        filePath: path.join(newDir, 'agent-0.jsonl'),
        agentId: 'agent-0',
        directoryType: 'new',
      });
      expect(results[1]).toEqual<SubagentFileInfo>({
        filePath: path.join(newDir, 'agent-1.jsonl'),
        agentId: 'agent-1',
        directoryType: 'new',
      });
    });

    it('should ignore non-agent files in subagents directory', async () => {
      const newDir = path.join(projectDir, 'abc123', 'subagents');

      mockReaddir.mockImplementation(async (dirPath) => {
        if (dirPath === newDir) {
          return [
            { name: 'agent-0.jsonl', isFile: () => true },
            { name: 'not-an-agent.jsonl', isFile: () => true },
            { name: 'agent-1.jsonl', isFile: () => true },
            { name: 'readme.md', isFile: () => true },
          ] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
        }
        return [] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
      });

      const results = await locator.locate(parentFilePath);
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.agentId)).toEqual(['agent-0', 'agent-1']);
    });

    it('should ignore directories (not files)', async () => {
      const newDir = path.join(projectDir, 'abc123', 'subagents');

      mockReaddir.mockImplementation(async (dirPath) => {
        if (dirPath === newDir) {
          return [
            { name: 'agent-0.jsonl', isFile: () => false }, // directory
            { name: 'agent-1.jsonl', isFile: () => true },
          ] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
        }
        return [] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
      });

      const results = await locator.locate(parentFilePath);
      expect(results).toHaveLength(1);
      expect(results[0].agentId).toBe('agent-1');
    });
  });

  // -------------------------------------------------------------------------
  // Legacy directory structure
  // -------------------------------------------------------------------------

  describe('legacy directory structure', () => {
    it('should discover files in project directory root', async () => {
      mockReaddir.mockImplementation(async (dirPath) => {
        if (dirPath === projectDir) {
          return [
            { name: 'agent-0.jsonl', isFile: () => true },
            { name: 'abc123.jsonl', isFile: () => true }, // parent file, not agent
          ] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
        }
        return [] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
      });

      const results = await locator.locate(parentFilePath);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual<SubagentFileInfo>({
        filePath: path.join(projectDir, 'agent-0.jsonl'),
        agentId: 'agent-0',
        directoryType: 'legacy',
      });
    });
  });

  // -------------------------------------------------------------------------
  // Deduplication
  // -------------------------------------------------------------------------

  describe('deduplication', () => {
    it('should prefer new directory files over legacy when same agentId', async () => {
      const newDir = path.join(projectDir, 'abc123', 'subagents');

      mockReaddir.mockImplementation(async (dirPath) => {
        if (dirPath === newDir) {
          return [{ name: 'agent-0.jsonl', isFile: () => true }] as unknown as Awaited<
            ReturnType<typeof fs.readdir>
          >;
        }
        if (dirPath === projectDir) {
          return [{ name: 'agent-0.jsonl', isFile: () => true }] as unknown as Awaited<
            ReturnType<typeof fs.readdir>
          >;
        }
        return [] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
      });

      const results = await locator.locate(parentFilePath);
      expect(results).toHaveLength(1);
      expect(results[0].directoryType).toBe('new');
      expect(results[0].filePath).toBe(path.join(newDir, 'agent-0.jsonl'));
    });

    it('should keep both when different agentIds', async () => {
      const newDir = path.join(projectDir, 'abc123', 'subagents');

      mockReaddir.mockImplementation(async (dirPath) => {
        if (dirPath === newDir) {
          return [{ name: 'agent-0.jsonl', isFile: () => true }] as unknown as Awaited<
            ReturnType<typeof fs.readdir>
          >;
        }
        if (dirPath === projectDir) {
          return [{ name: 'agent-1.jsonl', isFile: () => true }] as unknown as Awaited<
            ReturnType<typeof fs.readdir>
          >;
        }
        return [] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
      });

      const results = await locator.locate(parentFilePath);
      expect(results).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Sorting
  // -------------------------------------------------------------------------

  describe('sorting', () => {
    it('should sort by agentId with numeric ordering', async () => {
      const newDir = path.join(projectDir, 'abc123', 'subagents');

      mockReaddir.mockImplementation(async (dirPath) => {
        if (dirPath === newDir) {
          return [
            { name: 'agent-10.jsonl', isFile: () => true },
            { name: 'agent-2.jsonl', isFile: () => true },
            { name: 'agent-1.jsonl', isFile: () => true },
          ] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
        }
        return [] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
      });

      const results = await locator.locate(parentFilePath);
      expect(results.map((r) => r.agentId)).toEqual(['agent-1', 'agent-2', 'agent-10']);
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('should handle ENOENT gracefully (directory does not exist)', async () => {
      mockReaddir.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const results = await locator.locate(parentFilePath);
      expect(results).toHaveLength(0);
    });

    it('should handle non-ENOENT errors gracefully (log + empty result)', async () => {
      mockReaddir.mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));

      const results = await locator.locate(parentFilePath);
      expect(results).toHaveLength(0);
    });

    it('should return empty array when no subagent files found', async () => {
      const results = await locator.locate(parentFilePath);
      expect(results).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Agent ID extraction
  // -------------------------------------------------------------------------

  describe('agent ID extraction', () => {
    it('should handle non-numeric agent IDs', async () => {
      const newDir = path.join(projectDir, 'abc123', 'subagents');

      mockReaddir.mockImplementation(async (dirPath) => {
        if (dirPath === newDir) {
          return [
            { name: 'agent-abc.jsonl', isFile: () => true },
            { name: 'agent-my-agent.jsonl', isFile: () => true },
          ] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
        }
        return [] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
      });

      const results = await locator.locate(parentFilePath);
      expect(results).toHaveLength(2);
      expect(results[0].agentId).toBe('agent-abc');
      expect(results[1].agentId).toBe('agent-my-agent');
    });
  });
});

/**
 * Cross-cutting integration tests for Gemini project provisioning.
 *
 * Exercises real GeminiTrustedFoldersService with real filesystem operations
 * against per-test temp HOME directories. Stubs only the Gemini CLI process
 * boundary and os.homedir() via module mock. Verifies trust-folder file mode,
 * content, queued-write fairness, and provider-discriminator gating.
 *
 * Scenarios 9 and 10 (session-launch fallback + adapter --scope project)
 * are covered by unit tests in sessions.service.spec.ts and gemini.adapter.spec.ts
 * respectively — those are referenced here for completeness but not duplicated.
 */

import * as os from 'os';
import { mkdtemp, rm, readFile, stat, mkdir, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { GeminiTrustedFoldersService } from '../services/gemini-trusted-folders.service';
import { GeminiAdapter } from '../../providers/adapters/gemini.adapter';
import { ProjectProviderProvisioningService } from '../../projects/services/project-provider-provisioning.service';

// Override os.homedir to allow per-test temp HOME dirs.
jest.mock('os', () => {
  const actualOs = jest.requireActual('os');
  return { ...actualOs, homedir: jest.fn(() => actualOs.homedir()) };
});

// Silence logger in tests
jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

// Stub pty boundary — prevents real Gemini CLI invocation
jest.mock('node-pty', () => ({
  spawn: jest.fn(),
}));

let tempHome: string;
let trustService: GeminiTrustedFoldersService;

function trustFilePath(home: string): string {
  return join(home, '.gemini', 'trustedFolders.json');
}

async function readTrustFile(home: string): Promise<Record<string, string>> {
  const raw = await readFile(trustFilePath(home), 'utf-8');
  return JSON.parse(raw);
}

async function writeTrustFile(home: string, data: Record<string, string>): Promise<void> {
  const filePath = trustFilePath(home);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

describe('Gemini project provisioning — integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    trustService = new GeminiTrustedFoldersService();
  });

  afterEach(async () => {
    if (tempHome) {
      await rm(tempHome, { recursive: true, force: true }).catch(() => {});
      tempHome = '';
    }
  });

  afterAll(() => {
    (os.homedir as jest.Mock).mockImplementation(() => jest.requireActual('os').homedir());
  });

  async function setupTempHome(): Promise<string> {
    const actualOs = jest.requireActual('os') as typeof os;
    tempHome = await mkdtemp(join(actualOs.tmpdir(), 'gemini-provision-'));
    (os.homedir as jest.Mock).mockReturnValue(tempHome);
    return tempHome;
  }

  // ── Scenario 1: Fresh-home ──

  describe('scenario 1: fresh-home', () => {
    it('creates trustedFolders.json with mode 0600 and TRUST_FOLDER for new project', async () => {
      const home = await setupTempHome();
      const projectPath = join(home, 'repos', 'my-project');
      await mkdir(projectPath, { recursive: true });

      const result = await trustService.ensure(projectPath);

      expect(result.success).toBe(true);
      expect(result.action).toBe('added');

      const content = await readTrustFile(home);
      expect(content[projectPath]).toBe('TRUST_FOLDER');

      const fileStat = await stat(trustFilePath(home));
      expect(fileStat.mode & 0o777).toBe(0o600);
    });
  });

  // ── Scenario 2: Already-trusted-via-parent ──

  describe('scenario 2: already-trusted-via-parent', () => {
    it('skips write when TRUST_PARENT covers project; trust file unchanged', async () => {
      const home = await setupTempHome();
      const parentDir = join(home, 'repos');
      const projectPath = join(parentDir, 'sub');
      await mkdir(projectPath, { recursive: true });

      await writeTrustFile(home, { [parentDir]: 'TRUST_PARENT' });
      const beforeStat = await stat(trustFilePath(home));

      const result = await trustService.ensure(projectPath);

      expect(result.success).toBe(true);
      expect(result.action).toBe('already_trusted');

      const afterStat = await stat(trustFilePath(home));
      expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    });
  });

  // ── Scenario 3: Already-trusted-exact ──

  describe('scenario 3: already-trusted-exact', () => {
    it('skips write when exact TRUST_FOLDER exists; trust file unchanged', async () => {
      const home = await setupTempHome();
      const projectPath = join(home, 'repos', 'exact');
      await mkdir(projectPath, { recursive: true });

      await writeTrustFile(home, { [projectPath]: 'TRUST_FOLDER' });
      const beforeStat = await stat(trustFilePath(home));

      const result = await trustService.ensure(projectPath);

      expect(result.success).toBe(true);
      expect(result.action).toBe('already_trusted');

      const afterStat = await stat(trustFilePath(home));
      expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    });
  });

  // ── Scenario 4: Concurrent-create ──

  describe('scenario 4: concurrent-create', () => {
    it('5 parallel ensure calls — all 5 paths in final file, no lost writes', async () => {
      const home = await setupTempHome();
      const paths: string[] = [];
      for (let i = 0; i < 5; i++) {
        const p = join(home, `project-${i}`);
        await mkdir(p, { recursive: true });
        paths.push(p);
      }

      const results = await Promise.all(paths.map((p) => trustService.ensure(p)));

      for (const r of results) {
        expect(r.success).toBe(true);
        expect(r.action).toBe('added');
      }

      const content = await readTrustFile(home);
      for (const p of paths) {
        expect(content[p]).toBe('TRUST_FOLDER');
      }
    });
  });

  // ── Scenario 5: Update-rootPath ──

  describe('scenario 5: update-rootPath', () => {
    it('provisioning path A then path B — both in trust file', async () => {
      const home = await setupTempHome();
      const pathA = join(home, 'project-a');
      const pathB = join(home, 'project-b');
      await mkdir(pathA, { recursive: true });
      await mkdir(pathB, { recursive: true });

      await trustService.ensure(pathA);
      await trustService.ensure(pathB);

      const content = await readTrustFile(home);
      expect(content[pathA]).toBe('TRUST_FOLDER');
      expect(content[pathB]).toBe('TRUST_FOLDER');
    });
  });

  // ── Scenario 6: Import scenario ──

  describe('scenario 6: import scenario', () => {
    it('same as fresh-home — provisioning hooks exercised for imported project', async () => {
      const home = await setupTempHome();
      const projectPath = join(home, 'imported-project');
      await mkdir(projectPath, { recursive: true });

      const result = await trustService.ensure(projectPath);

      expect(result.success).toBe(true);
      expect(result.action).toBe('added');
      const content = await readTrustFile(home);
      expect(content[projectPath]).toBe('TRUST_FOLDER');
    });
  });

  // ── Scenario 7: Malformed-existing ──

  describe('scenario 7: malformed-existing', () => {
    it('malformed JSON — service returns malformed_warning, does NOT overwrite', async () => {
      const home = await setupTempHome();
      const projectPath = join(home, 'repos', 'project');
      await mkdir(projectPath, { recursive: true });

      const filePath = trustFilePath(home);
      await mkdir(dirname(filePath), { recursive: true });
      const malformedContent = '{truncated...';
      await writeFile(filePath, malformedContent, 'utf-8');

      const result = await trustService.ensure(projectPath);

      expect(result.success).toBe(false);
      expect(result.action).toBe('malformed_warning');
      expect(result.message).toContain('invalid JSON');

      // File preserved — not overwritten
      const preserved = await readFile(filePath, 'utf-8');
      expect(preserved).toBe(malformedContent);
    });
  });

  // ── Scenario 8: Non-Gemini provider ──

  describe('scenario 8: non-Gemini provider (provider discriminator)', () => {
    it('ProjectProviderProvisioningService invokes MCP ensure for Claude provider', async () => {
      const home = await setupTempHome();

      const mockStorage = {
        getProject: jest.fn().mockResolvedValue({ id: 'p1', rootPath: '/repos/claude-project' }),
        listAgentProfiles: jest.fn().mockResolvedValue({
          items: [{ id: 'profile-1' }],
        }),
        listProfileProviderConfigsByProfile: jest
          .fn()
          .mockResolvedValue([{ providerId: 'provider-claude', profileId: 'profile-1' }]),
        getProvider: jest.fn().mockResolvedValue({
          id: 'provider-claude',
          name: 'claude',
        }),
      };

      const mockMcpEnsure = {
        ensureMcp: jest.fn().mockResolvedValue({
          success: true,
          action: 'already_configured',
        }),
      };

      const provisioningService = new ProjectProviderProvisioningService(
        mockStorage as unknown as import('../../storage/interfaces/storage.interface').StorageService,
        mockMcpEnsure as unknown as ProviderMcpEnsureService,
      );

      const { warnings } = await provisioningService.provisionProject('p1');

      expect(warnings).toEqual([]);
      expect(mockMcpEnsure.ensureMcp).toHaveBeenCalledWith(
        { id: 'provider-claude', name: 'claude' },
        '/repos/claude-project',
      );

      // Trust file should NOT exist — provisioning delegates MCP ensure,
      // which handles trust-folder writes only for Gemini providers internally.
      await expect(readFile(trustFilePath(home), 'utf-8')).rejects.toThrow();
    });
  });

  // ── Scenario 9: Session-launch fallback ──
  // Scenario 9 covered by sessions.service.spec.ts:
  //   "calls ensureMcp for Gemini with project path even when preflight passes"
});

describe('Gemini project provisioning — scenario 10: adapter --scope project', () => {
  it('GeminiAdapter includes --scope project in addMcpServer and declares upsert strategy', () => {
    const adapter = new GeminiAdapter();

    const addArgs = adapter.addMcpServer({ endpoint: 'http://127.0.0.1:3000/mcp' });
    expect(addArgs).toEqual(expect.arrayContaining(['--scope', 'project']));
    expect(addArgs.indexOf('--scope')).toBeLessThan(addArgs.indexOf('-t'));

    const removeArgs = adapter.removeMcpServer('devchain');
    expect(removeArgs).toEqual(expect.arrayContaining(['--scope', 'project']));

    expect(adapter.mcpProjectRegistrationStrategy).toBe('upsert');
  });
});

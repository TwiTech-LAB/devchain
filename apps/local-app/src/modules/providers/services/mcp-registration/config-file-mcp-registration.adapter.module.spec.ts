import { execFileSync } from 'child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { ProviderAdaptersModule } from '../../../providers/adapters/provider-adapters.module';
import { ProcessExecutorModule } from '../../../terminal/services/process-executor/process-executor.module';
import type { Provider } from '../../../storage/models/domain.models';
import { ConfigFileMcpRegistrationAdapter } from './config-file-mcp-registration.adapter';

jest.mock('../../../../common/logging/logger', () => {
  const instance = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { createLogger: () => instance };
});

describe('ConfigFileMcpRegistrationAdapter — module wiring', () => {
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [ProviderAdaptersModule, ProcessExecutorModule],
      providers: [ConfigFileMcpRegistrationAdapter],
    }).compile();
  });

  afterEach(async () => {
    await module.close();
  });

  it('resolves when McpModule imports ProviderAdaptersModule and registers ConfigFileMcpRegistrationAdapter', () => {
    const adapter = module.get(ConfigFileMcpRegistrationAdapter);
    expect(adapter).toBeDefined();
    expect(typeof adapter.register).toBe('function');
  });

  // Project create, import and rootPath update write the Devin MCP file before
  // any Devin launch, so the write itself must keep the file out of git.
  it('keeps the Devin MCP file out of git status when it writes the file in a repository', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'devin-mcp-exclude-'));
    try {
      execFileSync('git', ['init', '-q', repo]);
      // Seeded without a DevChain entry: in a Jest VM context, Node's ENOENT is
      // not `instanceof Error`, so the adapter's missing-file branch cannot run here.
      await mkdir(join(repo, '.devin'), { recursive: true });
      await writeFile(join(repo, '.devin', 'mcp_config.local.json'), '{}\n');
      const devin = { id: 'p-devin', name: 'devin', binPath: 'devin' } as Provider;
      const adapter = module.get(ConfigFileMcpRegistrationAdapter);

      const result = await adapter.register(
        devin,
        { endpoint: 'http://127.0.0.1:3000/mcp', alias: 'devchain' },
        { cwd: repo },
      );

      expect(result.success).toBe(true);
      const exclude = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf-8');
      expect(
        exclude.split('\n').filter((line) => line === '.devin/mcp_config.local.json'),
      ).toHaveLength(1);
      const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
        cwd: repo,
        encoding: 'utf-8',
      });
      expect(status).toBe('');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

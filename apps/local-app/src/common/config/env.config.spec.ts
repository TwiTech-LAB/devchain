import { getEnvConfig, resetEnvConfig } from './env.config';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

describe('env.config', () => {
  const originalEnv = process.env;
  let tempRepoRoot: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.DEVCHAIN_MODE;
    delete process.env.DATABASE_URL;
    delete process.env.REPO_ROOT;
    delete process.env.WORKTREES_ROOT;
    delete process.env.WORKTREES_DATA_ROOT;
    delete process.env.CONTAINER_PROJECT_ID;
    delete process.env.RUNTIME_TOKEN;
    tempRepoRoot = mkdtempSync(join(tmpdir(), 'devchain-env-config-'));
    resetEnvConfig();
  });

  afterEach(() => {
    rmSync(tempRepoRoot, { recursive: true, force: true });
  });

  afterAll(() => {
    process.env = originalEnv;
    resetEnvConfig();
  });

  it('defaults DEVCHAIN_MODE to normal', () => {
    const config = getEnvConfig();
    expect(config.DEVCHAIN_MODE).toBe('normal');
  });

  it('accepts main mode when REPO_ROOT is provided', () => {
    process.env.DEVCHAIN_MODE = 'main';
    process.env.REPO_ROOT = tempRepoRoot;

    const config = getEnvConfig();

    expect(config.DEVCHAIN_MODE).toBe('main');
    expect(config.REPO_ROOT).toBe(resolve(tempRepoRoot));
    expect(config.WORKTREES_ROOT).toBe(resolve(tempRepoRoot, '.devchain', 'worktrees'));
    expect(config.WORKTREES_DATA_ROOT).toBe(resolve(tempRepoRoot, '.devchain', 'worktrees-data'));
  });

  it('rejects orchestrator as DEVCHAIN_MODE', () => {
    process.env.DEVCHAIN_MODE = 'orchestrator';
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => getEnvConfig()).toThrow('Environment validation failed');

    consoleSpy.mockRestore();
  });

  it('throws when REPO_ROOT is missing in main mode', () => {
    process.env.DEVCHAIN_MODE = 'main';
    delete process.env.REPO_ROOT;
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => getEnvConfig()).toThrow('Environment validation failed');

    consoleSpy.mockRestore();
  });

  it('throws when REPO_ROOT path does not exist in main mode', () => {
    process.env.DEVCHAIN_MODE = 'main';
    process.env.REPO_ROOT = join(tempRepoRoot, 'does-not-exist');
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => getEnvConfig()).toThrow('Environment validation failed');

    consoleSpy.mockRestore();
  });

  it('does not resolve worktree paths in normal mode', () => {
    process.env.DEVCHAIN_MODE = 'normal';
    process.env.REPO_ROOT = tempRepoRoot;
    delete process.env.WORKTREES_ROOT;
    delete process.env.WORKTREES_DATA_ROOT;

    const config = getEnvConfig();

    expect(config.DEVCHAIN_MODE).toBe('normal');
    expect(config.REPO_ROOT).toBe(tempRepoRoot);
    expect(config.WORKTREES_ROOT).toBeUndefined();
    expect(config.WORKTREES_DATA_ROOT).toBeUndefined();
  });

  it('accepts valid CONTAINER_PROJECT_ID', () => {
    process.env.CONTAINER_PROJECT_ID = '11111111-1111-4111-8111-111111111111';

    const config = getEnvConfig();

    expect(config.CONTAINER_PROJECT_ID).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('accepts optional RUNTIME_TOKEN', () => {
    process.env.RUNTIME_TOKEN = 'runtime-token-123';

    const config = getEnvConfig();

    expect(config.RUNTIME_TOKEN).toBe('runtime-token-123');
  });

  it('throws when CONTAINER_PROJECT_ID is not a valid UUID', () => {
    process.env.CONTAINER_PROJECT_ID = 'not-a-uuid';
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => getEnvConfig()).toThrow('Environment validation failed');

    consoleSpy.mockRestore();
  });
});

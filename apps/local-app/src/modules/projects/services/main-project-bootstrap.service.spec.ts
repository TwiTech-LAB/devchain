import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { resetEnvConfig } from '../../../common/config/env.config';
import { StorageService } from '../../storage/interfaces/storage.interface';
import { MainProjectBootstrapService } from './main-project-bootstrap.service';

describe('MainProjectBootstrapService', () => {
  const originalEnv = process.env;
  let tempRepoRoot: string;
  let storage: jest.Mocked<StorageService>;

  beforeEach(() => {
    tempRepoRoot = mkdtempSync(join(tmpdir(), 'main-project-bootstrap-'));
    process.env = { ...originalEnv };
    delete process.env.DEVCHAIN_MODE;
    delete process.env.DATABASE_URL;
    delete process.env.REPO_ROOT;
    resetEnvConfig();

    storage = {
      listProjects: jest.fn(),
      createProject: jest.fn(),
    } as unknown as jest.Mocked<StorageService>;
  });

  afterEach(() => {
    rmSync(tempRepoRoot, { recursive: true, force: true });
  });

  afterAll(() => {
    process.env = originalEnv;
    resetEnvConfig();
  });

  it('does nothing outside main mode', async () => {
    const service = new MainProjectBootstrapService(storage);

    await service.onApplicationBootstrap();

    expect(service.getMainProjectId()).toBeNull();
    expect(storage.listProjects).not.toHaveBeenCalled();
    expect(storage.createProject).not.toHaveBeenCalled();
  });

  it('auto-creates main project when no projects exist', async () => {
    process.env.DEVCHAIN_MODE = 'main';
    process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/devchain';
    process.env.REPO_ROOT = tempRepoRoot;
    resetEnvConfig();

    storage.listProjects.mockResolvedValue({
      items: [],
      total: 0,
      limit: 1000,
      offset: 0,
    });
    storage.createProject.mockResolvedValue({
      id: 'project-main',
      name: 'auto-name',
      description: null,
      rootPath: resolve(tempRepoRoot),
      isTemplate: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const service = new MainProjectBootstrapService(storage);
    await service.onApplicationBootstrap();

    expect(storage.createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        name: expect.any(String),
        rootPath: resolve(tempRepoRoot),
        isTemplate: false,
      }),
    );
    expect(service.getMainProjectId()).toBe('project-main');
  });

  it('uses existing project for matching REPO_ROOT and avoids duplicates', async () => {
    process.env.DEVCHAIN_MODE = 'main';
    process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/devchain';
    process.env.REPO_ROOT = tempRepoRoot;
    resetEnvConfig();

    storage.listProjects.mockResolvedValue({
      items: [
        {
          id: 'project-existing',
          name: 'repo',
          description: null,
          rootPath: resolve(tempRepoRoot),
          isTemplate: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      total: 1,
      limit: 1000,
      offset: 0,
    });

    const service = new MainProjectBootstrapService(storage);
    await service.onApplicationBootstrap();
    await service.ensureMainProjectId();

    expect(storage.createProject).not.toHaveBeenCalled();
    expect(service.getMainProjectId()).toBe('project-existing');
    expect(storage.listProjects).toHaveBeenCalledTimes(1);
  });
});

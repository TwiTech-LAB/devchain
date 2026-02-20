import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { OrchestratorDatabase } from '../../orchestrator/orchestrator-storage/db/orchestrator.provider';
import { OrchestratorDockerService } from '../../orchestrator/docker/services/docker.service';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import { MainReadinessCheckerService } from './main-readiness-checker.service';

jest.mock('../../storage/db/sqlite-raw', () => ({
  getRawSqliteClient: jest.fn(),
}));

describe('MainReadinessCheckerService', () => {
  const mockGetRawSqliteClient = jest.mocked(getRawSqliteClient);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns db+orchestratorDb+docker ok when all probes pass', async () => {
    const db = {} as BetterSQLite3Database;
    const orchestratorDb = {
      execute: jest.fn().mockResolvedValue([{ value: 1 }]),
    } as unknown as OrchestratorDatabase;
    const dockerService = {
      ping: jest.fn().mockResolvedValue(true),
    } as unknown as OrchestratorDockerService;

    const prepare = jest.fn().mockReturnValue({ get: jest.fn() });
    mockGetRawSqliteClient.mockReturnValue({ prepare } as unknown as ReturnType<
      typeof getRawSqliteClient
    >);

    const service = new MainReadinessCheckerService(db, orchestratorDb, dockerService);
    const result = await service.getChecks();

    expect(result).toEqual({
      db: 'ok',
      orchestratorDb: 'ok',
      docker: 'ok',
    });
  });

  it('returns fail statuses when probes fail', async () => {
    const db = {} as BetterSQLite3Database;
    const orchestratorDb = {
      execute: jest.fn().mockRejectedValue(new Error('pg down')),
    } as unknown as OrchestratorDatabase;
    const dockerService = {
      ping: jest.fn().mockResolvedValue(false),
    } as unknown as OrchestratorDockerService;

    mockGetRawSqliteClient.mockImplementation(() => {
      throw new Error('sqlite down');
    });

    const service = new MainReadinessCheckerService(db, orchestratorDb, dockerService);
    const result = await service.getChecks();

    expect(result).toEqual({
      db: 'fail',
      orchestratorDb: 'fail',
      docker: 'fail',
    });
  });

  it('returns fail statuses when dependencies are not injected', async () => {
    const service = new MainReadinessCheckerService(undefined, undefined, undefined);
    const result = await service.getChecks();

    expect(result).toEqual({
      db: 'fail',
      orchestratorDb: 'fail',
      docker: 'fail',
    });
  });
});

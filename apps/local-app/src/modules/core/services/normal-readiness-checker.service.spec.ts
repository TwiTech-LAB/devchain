import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import { NormalReadinessCheckerService } from './normal-readiness-checker.service';
import { FakeProcessExecutor } from '../../terminal/services/process-executor/fake-process-executor';

jest.mock('../../storage/db/sqlite-raw', () => ({
  getRawSqliteClient: jest.fn(),
}));

describe('NormalReadinessCheckerService', () => {
  let service: NormalReadinessCheckerService;
  let fakeExecutor: FakeProcessExecutor;
  const mockGetRawSqliteClient = jest.mocked(getRawSqliteClient);

  beforeEach(() => {
    fakeExecutor = new FakeProcessExecutor();
    service = new NormalReadinessCheckerService(fakeExecutor, {} as BetterSQLite3Database);
    jest.clearAllMocks();
  });

  it('returns db+tmux ok and caches tmux check result', async () => {
    const get = jest.fn();
    const prepare = jest.fn().mockReturnValue({ get });
    mockGetRawSqliteClient.mockReturnValue({ prepare } as unknown as ReturnType<
      typeof getRawSqliteClient
    >);
    fakeExecutor.enqueueResponse({ type: 'success', stdout: 'tmux 3.3a' });

    service.onModuleInit();
    const first = await service.getChecks();
    const second = await service.getChecks();

    expect(first).toEqual({
      db: 'ok',
      tmux: 'ok',
    });
    expect(second).toEqual(first);
    expect(fakeExecutor.calls).toHaveLength(1);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('returns db fail when sqlite probe throws', async () => {
    mockGetRawSqliteClient.mockImplementation(() => {
      throw new Error('db unavailable');
    });
    fakeExecutor.enqueueResponse({ type: 'success', stdout: 'tmux 3.3a' });

    const result = await service.getChecks();

    expect(result).toEqual({
      db: 'fail',
      tmux: 'ok',
    });
  });

  it('returns tmux fail when tmux probe fails', async () => {
    const prepare = jest.fn().mockReturnValue({ get: jest.fn() });
    mockGetRawSqliteClient.mockReturnValue({ prepare } as unknown as ReturnType<
      typeof getRawSqliteClient
    >);
    fakeExecutor.enqueueResponse({ type: 'failure', exitCode: 127, stderr: 'tmux: not found' });

    const result = await service.getChecks();

    expect(result).toEqual({
      db: 'ok',
      tmux: 'fail',
    });
  });
});

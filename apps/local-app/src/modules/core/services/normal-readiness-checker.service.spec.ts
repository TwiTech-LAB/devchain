import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { execFile } from 'child_process';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import { NormalReadinessCheckerService } from './normal-readiness-checker.service';

jest.mock('../../storage/db/sqlite-raw', () => ({
  getRawSqliteClient: jest.fn(),
}));

jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

describe('NormalReadinessCheckerService', () => {
  let service: NormalReadinessCheckerService;
  const mockGetRawSqliteClient = jest.mocked(getRawSqliteClient);
  const mockExecFile = jest.mocked(execFile);

  const mockTmuxCheck = (ok: boolean) => {
    mockExecFile.mockImplementation((...args) => {
      const callback = args.find((arg) => typeof arg === 'function') as (
        error: Error | null,
        stdout: string,
        stderr: string,
      ) => void;
      callback(ok ? null : new Error('tmux missing'), ok ? 'tmux 3.3a' : '', '');
      return {} as ReturnType<typeof execFile>;
    });
  };

  beforeEach(() => {
    service = new NormalReadinessCheckerService({} as BetterSQLite3Database);
    jest.clearAllMocks();
  });

  it('returns db+tmux ok and caches tmux check result', async () => {
    const get = jest.fn();
    const prepare = jest.fn().mockReturnValue({ get });
    mockGetRawSqliteClient.mockReturnValue({ prepare } as unknown as ReturnType<
      typeof getRawSqliteClient
    >);
    mockTmuxCheck(true);

    service.onModuleInit();
    const first = await service.getChecks();
    const second = await service.getChecks();

    expect(first).toEqual({
      db: 'ok',
      tmux: 'ok',
    });
    expect(second).toEqual(first);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('returns db fail when sqlite probe throws', async () => {
    mockGetRawSqliteClient.mockImplementation(() => {
      throw new Error('db unavailable');
    });
    mockTmuxCheck(true);

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
    mockTmuxCheck(false);

    const result = await service.getChecks();

    expect(result).toEqual({
      db: 'ok',
      tmux: 'fail',
    });
  });
});

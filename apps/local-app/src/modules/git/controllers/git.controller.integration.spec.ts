import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { GitController } from './git.controller';
import { GitService } from '../services/git.service';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { FakeProcessExecutor } from '../../terminal/services/process-executor/fake-process-executor';

// HTTP injection verifies query parsing and error mapping with the real GitService guard.
describe('Git ref HTTP admission', () => {
  let app: NestFastifyApplication;
  let executor: FakeProcessExecutor;
  const getProject = jest.fn();

  beforeAll(async () => {
    executor = new FakeProcessExecutor();
    const module = await Test.createTestingModule({
      controllers: [GitController],
      providers: [
        GitService,
        { provide: STORAGE_SERVICE, useValue: { getProject } },
        { provide: ProcessExecutor, useValue: executor },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => app.close());

  it('returns 400 for an option-like commit ref before running git', async () => {
    const query = new URLSearchParams({
      projectId: '550e8400-e29b-41d4-a716-446655440000',
      ref: '--output=/tmp/x',
    });
    const response = await app.inject({ method: 'GET', url: `/api/git/commits?${query}` });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toBe('Git ref must not start with "-"');
    expect(getProject).not.toHaveBeenCalled();
    expect(executor.calls).toEqual([]);
  });
});

import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AllExceptionsFilter } from '../../../common/filters/http-exception.filter';
import { RemoteApiKeyController } from './remote-api-key.controller';
import { RemoteApiKeyManagementService } from '../auth/remote-api-key-management.service';

// A small real HTTP application verifies route verbs, Zod errors and bodyless secret-free replies.
describe('home API key HTTP routes', () => {
  const id = '12345678-1234-4234-8234-123456789abc';
  const key = `dck_${'a'.repeat(43)}`;
  let app: NestFastifyApplication;
  let enter: jest.Mock;
  let reset: jest.Mock;
  beforeEach(async () => {
    enter = jest.fn().mockResolvedValue(undefined);
    reset = jest.fn().mockResolvedValue(undefined);
    const module = await Test.createTestingModule({
      controllers: [RemoteApiKeyController],
      providers: [{ provide: RemoteApiKeyManagementService, useValue: { enter, reset } }],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterEach(async () => app.close());
  it('accepts key entry and reset with 204 and no response body', async () => {
    const entered = await app.inject({
      method: 'PUT',
      url: `/api/remotes/${id}/api-key`,
      payload: { apiKey: key },
    });
    expect(entered.statusCode).toBe(204);
    expect(entered.body).toBe('');
    expect(enter).toHaveBeenCalledWith(id, key);
    const rotated = await app.inject({
      method: 'POST',
      url: `/api/remotes/${id}/api-key/reset`,
      payload: {},
    });
    expect(rotated.statusCode).toBe(204);
    expect(rotated.body).toBe('');
    expect(reset).toHaveBeenCalledWith(id);
  });
  it('refuses malformed keys without echoing them or calling the service', async () => {
    const candidate = `${key}-invalid`;
    const response = await app.inject({
      method: 'PUT',
      url: `/api/remotes/${id}/api-key`,
      payload: { apiKey: candidate },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(candidate);
    expect(enter).not.toHaveBeenCalled();
  });
});

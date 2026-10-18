/**
 * Request validation of the host VM routes.
 * Test layer: controller unit with a stubbed HostHelperService.
 */
import { ZodError } from 'zod';
import { HostUpdateController } from './host-update.controller';
import type { HostHelperService } from './host-helper.service';

describe('HostUpdateController', () => {
  const helper = {
    requestDocker: jest.fn().mockResolvedValue({ jobId: 'job' }),
    readDockerStatus: jest.fn().mockReturnValue(null),
    isClaimedHost: jest.fn().mockReturnValue(true),
    requestUpdate: jest.fn().mockResolvedValue(undefined),
    readUpdateStatus: jest.fn().mockReturnValue(null),
    createProjectRoot: jest.fn().mockResolvedValue({ path: '/srv/work/demo', created: true }),
  };
  const controller = new HostUpdateController(helper as unknown as HostHelperService);

  beforeEach(() => jest.clearAllMocks());

  it.each([
    { body: { version: '0.25.0-rc.1' }, registry: undefined },
    {
      body: { version: '0.25.0-rc.1', npmRegistry: 'http://lan.test:4873/' },
      registry: 'http://lan.test:4873/',
    },
  ])('starts an update for body $body', async ({ body, registry }) => {
    await expect(controller.update(body)).resolves.toEqual({
      version: '0.25.0-rc.1',
      state: 'pending',
    });
    expect(helper.requestUpdate).toHaveBeenCalledWith('0.25.0-rc.1', registry);
  });

  it.each([
    { version: 'latest' },
    { version: '1.2' },
    { version: '1.2.3', extra: 1 },
    { version: '1.2.3', npmRegistry: 'lan' },
    {},
  ])('refuses update body %p before any helper runs', async (body) => {
    await expect(controller.update(body)).rejects.toBeInstanceOf(ZodError);
    expect(helper.requestUpdate).not.toHaveBeenCalled();
  });

  it('refuses a claim with 409: a VM running DevChain is claimed already', () => {
    expect(() => controller.claim()).toThrow(
      expect.objectContaining({ statusCode: 409, details: { code: 'ALREADY_CLAIMED' } }),
    );
    helper.isClaimedHost.mockReturnValueOnce(false);
    expect(() => controller.claim()).toThrow(
      expect.objectContaining({ statusCode: 409, details: { code: 'NOT_A_HOST' } }),
    );
  });
});

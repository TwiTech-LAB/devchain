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

  it('starts an update for a semantic version', async () => {
    await expect(controller.update({ version: '0.25.0-rc.1' })).resolves.toEqual({
      version: '0.25.0-rc.1',
      state: 'pending',
    });
    expect(helper.requestUpdate).toHaveBeenCalledWith('0.25.0-rc.1');
  });

  it.each([{ version: 'latest' }, { version: '1.2' }, { version: '1.2.3', extra: 1 }, {}])(
    'refuses update body %p before any helper runs',
    async (body) => {
      await expect(controller.update(body)).rejects.toBeInstanceOf(ZodError);
      expect(helper.requestUpdate).not.toHaveBeenCalled();
    },
  );

  it('creates a project root through the helper', async () => {
    await expect(controller.createProjectRoot({ path: '/srv/work/demo' })).resolves.toEqual({
      path: '/srv/work/demo',
      created: true,
    });
    await expect(controller.createProjectRoot({})).rejects.toBeInstanceOf(ZodError);
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

  it('reports the update status', () => {
    expect(controller.status()).toEqual({ status: null });
  });
  it('accepts Docker install without version inputs and exposes status', async () => {
    await expect(controller.docker({})).resolves.toEqual({ state: 'pending', jobId: 'job' });
    expect(controller.dockerStatus()).toEqual({ status: null });
    await expect(controller.docker({ version: '1.0.0' })).rejects.toBeInstanceOf(ZodError);
    expect(helper.requestDocker).toHaveBeenCalledTimes(1);
  });
});

import { VmOperationsController } from './vm-operations.controller';
import type { VmOperationsService } from './vm-operations.service';

const CONNECTION_ID = '293ee02d-9338-441a-a229-a17d57ed3a4a';
const REMOTE_ID = '254257d3-e2f5-4eae-893f-2fe690d7bc88';

describe('VmOperationsController', () => {
  const create = jest.fn().mockResolvedValue({ id: 'create-operation' });
  const reset = jest.fn().mockResolvedValue({ id: 'reset-operation' });
  const destroy = jest.fn().mockResolvedValue({ id: 'destroy-operation' });
  const controller = new VmOperationsController({
    create,
    reset,
    destroy,
  } as unknown as VmOperationsService);

  beforeEach(() => jest.clearAllMocks());

  it('validates and starts a VM creation', async () => {
    await expect(
      controller.create(CONNECTION_ID, {
        name: 'alpha',
        cores: 2,
        memory: 4096,
        disk: 30,
      }),
    ).resolves.toEqual({ id: 'create-operation' });
    expect(create).toHaveBeenCalledWith(CONNECTION_ID, {
      name: 'alpha',
      cores: 2,
      memory: 4096,
      disk: 30,
      providerAuth: {},
    });
    expect(() => controller.create(CONNECTION_ID, { name: 'alpha' })).toThrow();
  });

  it('validates and starts a reset with explicit force', async () => {
    await expect(controller.reset(REMOTE_ID, { force: true })).resolves.toEqual({
      id: 'reset-operation',
    });
    expect(reset).toHaveBeenCalledWith(REMOTE_ID, { force: true, providerAuth: {} });
    expect(() => controller.reset(REMOTE_ID, { force: 'yes' })).toThrow();
  });

  it('validates and starts a guarded VM destroy', async () => {
    await expect(controller.destroy(REMOTE_ID, {})).resolves.toEqual({ id: 'destroy-operation' });
    expect(destroy).toHaveBeenCalledWith(REMOTE_ID, { force: false });
    expect(() => controller.destroy(REMOTE_ID, { force: 'yes' })).toThrow();
    expect(() => controller.destroy(REMOTE_ID, { force: true, detach: true })).toThrow();
  });
});

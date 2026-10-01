import { Test, type TestingModule } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AllExceptionsFilter } from '../../../common/filters/http-exception.filter';
import { VmProvidersController } from '../vm-providers.controller';
import { VmProvidersService } from '../vm-providers.service';
import * as setupBlock from './setup-block';

describe('Proxmox setup block API', () => {
  let app: NestFastifyApplication;
  let moduleRef: TestingModule;
  let generateBlock: jest.SpiedFunction<typeof setupBlock.generateProxmoxSetupBlock>;

  beforeEach(async () => {
    generateBlock = jest.spyOn(setupBlock, 'generateProxmoxSetupBlock').mockReturnValue('block');
    moduleRef = await Test.createTestingModule({
      controllers: [VmProvidersController],
      providers: [{ provide: VmProvidersService, useValue: {} }],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
    await moduleRef.close();
    generateBlock.mockRestore();
  });

  it('returns a generated block for a valid Proxmox address', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/vm-providers/proxmox/setup-block?pool=devchain&storage=local-lvm&imageStorage=local&bridge=vmbr0&node=pve1&address=192.168.1.128',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ block: 'block' });
    expect(generateBlock).toHaveBeenCalledWith({
      pool: 'devchain',
      storage: 'local-lvm',
      imageStorage: 'local',
      bridge: 'vmbr0',
      node: 'pve1',
      address: '192.168.1.128',
    });
  });

  // HTTP injection is the smallest layer that verifies empty query values survive parsing.
  it.each(['?node=&storage=&imageStorage=&bridge=', ''])(
    'discovers omitted or empty placement values (%s)',
    async (query) => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/vm-providers/proxmox/setup-block' + query,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ block: 'block' });
      expect(generateBlock).toHaveBeenCalledWith({
        pool: 'devchain',
        node: '',
        storage: '',
        imageStorage: '',
        bridge: '',
      });
    },
  );

  it.each(['pool', 'node', 'storage', 'imageStorage', 'bridge'])(
    'rejects shell metacharacters in %s',
    async (field) => {
      const query = new URLSearchParams({ [field]: 'bad;touch /tmp/pwned' });
      const response = await app.inject({
        method: 'GET',
        url: '/api/vm-providers/proxmox/setup-block?' + query,
      });
      expect(response.statusCode).toBe(400);
      expect(generateBlock).not.toHaveBeenCalled();
    },
  );

  it('returns 400 for shell metacharacters without generating a block', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/vm-providers/proxmox/setup-block?pool=devchain&storage=local-lvm&imageStorage=local&bridge=vmbr0&node=pve1&address=192.168.1.128%3Btouch%20%2Ftmp%2Fpwned',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ statusCode: 400 });
    expect(generateBlock).not.toHaveBeenCalled();
  });
});

import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as hostInstallBlock from './host-install-block';
import { resetEnvConfig } from '../../../common/config/env.config';
import {
  ProcessExecutor,
  type ProcessExecutorOptions,
} from '../../terminal/services/process-executor/process-executor.port';
import { BASE_URL_MESSAGE } from '../dtos/remote.dto';
import { HostInstallController } from './host-install.controller';
import { HostInstallService } from './host-install.service';
import { ProjectSizeService, type ProjectSizeEstimate } from './project-size.service';

class FakePackExecutor extends ProcessExecutor {
  calls: ProcessExecutorOptions[] = [];

  async run(options: ProcessExecutorOptions) {
    this.calls.push(options);
    const destination = options.argv[options.argv.indexOf('--pack-destination') + 1];
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, 'devchain-host-bootstrap-0.1.0.tgz'), 'bootstrap archive');
    return {
      success: true,
      exitCode: 0,
      stdout: JSON.stringify([{ filename: 'devchain-host-bootstrap-0.1.0.tgz' }]),
      stderr: '',
      timedOut: false,
      truncated: false,
    };
  }

  async spawnDaemon(): Promise<{ pid: number }> {
    throw new Error('not used');
  }
}

describe('HostInstallController', () => {
  const originalEnv = process.env;
  let dataDir: string;
  let controller: HostInstallController;
  let storage: { getProject: jest.Mock };
  let projectSize: { measure: jest.Mock<Promise<ProjectSizeEstimate>> };
  let executor: FakePackExecutor;
  let operations: { installHost: jest.Mock };
  let sshKeys: { list: jest.Mock; listPublic: jest.Mock };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'devchain-host-install-controller-'));
    process.env = {
      ...originalEnv,
      HOST: '127.0.0.1',
      DB_PATH: dataDir,
      DEVCHAIN_CLOUD_UI_ENABLED: 'true',
      HOST_NPM_REGISTRY: 'https://registry.example.test/',
    };
    resetEnvConfig();
    storage = { getProject: jest.fn() };
    projectSize = { measure: jest.fn() };
    executor = new FakePackExecutor();
    operations = {
      installHost: jest.fn().mockResolvedValue({ id: 'operation-1', remoteId: 'remote-1' }),
    };
    sshKeys = {
      list: jest.fn().mockResolvedValue([]),
      listPublic: jest.fn().mockResolvedValue([]),
    };
    const hostInstall = new HostInstallService(executor, {
      moduleDirectory: __dirname,
      cwd: process.cwd(),
      dataDirectory: dataDir,
    });
    controller = new HostInstallController(
      storage as never,
      projectSize as unknown as ProjectSizeService,
      hostInstall,
      operations as never,
      sshKeys as never,
    );
  });

  afterEach(() => {
    process.env = originalEnv;
    resetEnvConfig();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns project details and excludes unknown sizes from required disk arithmetic', async () => {
    storage.getProject.mockImplementation(async (id: string) => ({
      id,
      name: id === 'project-1' ? 'One' : 'Two',
      rootPath: `/projects/${id}`,
    }));
    projectSize.measure
      .mockResolvedValueOnce({ bytes: 1024 ** 3, approximate: false })
      .mockResolvedValueOnce({ bytes: null, approximate: true });

    await expect(controller.estimate({ projectIds: ['project-1', 'project-2'] })).resolves.toEqual({
      projects: [
        {
          id: 'project-1',
          name: 'One',
          rootPath: '/projects/project-1',
          bytes: 1024 ** 3,
          approximate: false,
        },
        {
          id: 'project-2',
          name: 'Two',
          rootPath: '/projects/project-2',
          bytes: null,
          approximate: true,
        },
      ],
      requiredDiskGib: 10,
    });
    expect(projectSize.measure).toHaveBeenNthCalledWith(1, 'project-1', '/projects/project-1');
    expect(projectSize.measure).toHaveBeenNthCalledWith(2, 'project-2', '/projects/project-2');
  });

  it('loads source inputs once and passes the requested disk and registry to the generator', async () => {
    const generate = jest
      .spyOn(hostInstallBlock, 'generateHostInstallBlock')
      .mockReturnValue('block');
    try {
      await expect(controller.block({ minDiskGib: '17' })).resolves.toEqual({ block: 'block' });
      await expect(controller.block({ minDiskGib: '18' })).resolves.toEqual({ block: 'block' });

      expect(executor.calls).toHaveLength(1);
      expect(generate).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          minDiskGib: 17,
          homePort: 3000,
          imageVersion: '1.4.0',
          pins: expect.objectContaining({ npmRegistry: 'https://registry.example.test/' }),
        }),
      );
      expect(generate).toHaveBeenNthCalledWith(2, expect.objectContaining({ minDiskGib: 18 }));
    } finally {
      generate.mockRestore();
    }
  });

  it('validates the SSH install request and forwards credentials only to the operation service', async () => {
    const ssh = { user: 'vm-admin', password: 'ssh-secret', sudoPassword: 'sudo-secret' };

    await controller.install({
      address: '192.168.1.20',
      ssh,
      providerAuth: {},
      minDiskGib: 12,
    });

    expect(operations.installHost).toHaveBeenCalledWith({
      address: 'https://192.168.1.20',
      ssh,
      providerAuth: {},
      minDiskGib: 12,
    });
  });

  it('refuses a plain http address before starting an install', async () => {
    await expect(
      controller.install({
        address: 'http://192.168.1.20',
        ssh: { user: 'vm-admin', password: 'ssh-secret' },
        providerAuth: {},
        minDiskGib: 12,
      }),
    ).rejects.toThrow(BASE_URL_MESSAGE);
    expect(operations.installHost).not.toHaveBeenCalled();
  });

  it('returns no key metadata when the app is bound beyond loopback', async () => {
    process.env.HOST = '0.0.0.0';
    resetEnvConfig();

    await expect(controller.listSshKeys()).resolves.toEqual({
      available: false,
      reason: 'non_loopback_host',
    });
    expect(sshKeys.list).not.toHaveBeenCalled();
    await expect(controller.listSshPublicKeys()).resolves.toEqual({
      available: false,
      reason: 'non_loopback_host',
    });
    expect(sshKeys.listPublic).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'public contents',
      publicOnly: true,
      keys: [
        {
          name: 'id_ed25519.pub',
          type: 'ssh-ed25519',
          fingerprint: 'SHA256:abc',
          comment: 'PC',
          content: 'public key',
        },
      ],
    },
    {
      name: 'key metadata',
      publicOnly: false,
      keys: [
        { name: 'id_rsa', type: 'ssh-rsa', encrypted: false },
        { name: 'id_ed25519', type: null, encrypted: true },
      ],
    },
  ])('returns $name on loopback', async ({ publicOnly, keys }) => {
    const list = publicOnly ? sshKeys.listPublic : sshKeys.list;
    list.mockResolvedValue(keys);
    const result = await (publicOnly ? controller.listSshPublicKeys() : controller.listSshKeys());
    expect(result).toEqual({ available: true, keys });
  });
});

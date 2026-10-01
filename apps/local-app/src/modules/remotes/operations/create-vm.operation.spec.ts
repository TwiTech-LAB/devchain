import { ProxmoxRemoteError } from '@devchain/proxmox-client';
import { resetEnvConfig } from '../../../common/config/env.config';
import * as hostImageConfig from '../../../common/config/host-image.config';
import type { BuiltInHostImage } from '../../../common/config/host-image.config';
import type { RemoteOperationStepRun } from './remote-operation.types';
import type { HostImage } from '../../vm-providers/proxmox-vm-lifecycle.service';
import { CreateVmOperation, resolveCreateVmImage } from './create-vm.operation';

const SHA = 'a'.repeat(64);
const BUILT_IN_IMAGE: BuiltInHostImage = {
  version: '1.2.3',
  url: 'https://github.com/TwiTech-LAB/devchain/releases/download/host-image-v1.2.3/devchain-host-1.2.3.qcow2',
  sha256: SHA,
};

function imageFrom(url: string, sha256: string): HostImage {
  const version = /devchain-host-(.+)\.qcow2$/.exec(new URL(url).pathname)?.[1] ?? '';
  return {
    url,
    sha256: sha256.toLowerCase(),
    version,
    filename: `devchain-host-${version}-${sha256.toLowerCase()}.qcow2`,
  };
}

describe('CreateVmOperation image selection', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.HOST_IMAGE_URL;
    delete process.env.HOST_IMAGE_SHA256;
    resetEnvConfig();
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(() => {
    process.env = originalEnv;
    resetEnvConfig();
  });

  it('uses the built-in release URL and SHA-256 when environment overrides are unset', () => {
    const lifecycle = { image: jest.fn(imageFrom) };

    const image = resolveCreateVmImage(lifecycle, {}, BUILT_IN_IMAGE);

    expect(lifecycle.image).toHaveBeenCalledWith(BUILT_IN_IMAGE.url, BUILT_IN_IMAGE.sha256);
    expect(image).toEqual(imageFrom(BUILT_IN_IMAGE.url, BUILT_IN_IMAGE.sha256));
  });

  it('uses both environment overrides instead of the built-in entry', () => {
    const lifecycle = { image: jest.fn(imageFrom) };
    const environment = {
      HOST_IMAGE_URL: 'https://images.example/devchain-host-2.0.0.qcow2',
      HOST_IMAGE_SHA256: 'b'.repeat(64),
    };

    resolveCreateVmImage(lifecycle, environment, BUILT_IN_IMAGE);

    expect(lifecycle.image).toHaveBeenCalledWith(
      environment.HOST_IMAGE_URL,
      environment.HOST_IMAGE_SHA256,
    );
  });

  it('keeps create_vm refused when there is no built-in entry or complete environment override', async () => {
    jest.replaceProperty(hostImageConfig, 'BUILT_IN_HOST_IMAGE', null);
    const lifecycle = { image: jest.fn(imageFrom) };
    const create = new CreateVmOperation(
      {} as never,
      lifecycle as never,
      {} as never,
      { steps: [] } as never,
      {} as never,
    );
    const preflight = create.steps.find((step) => step.id === 'vm_preflight');
    if (!preflight) throw new Error('vm_preflight step not found');

    const details = {
      connectionId: 'connection-1',
      vmName: 'devchain-test',
      spec: { cores: 1, memory: 4096, disk: 1 },
    };
    const run = {
      operation: {} as never,
      details,
      progress: async () => undefined,
    } as RemoteOperationStepRun;

    await expect(preflight.run(run)).rejects.toMatchObject({ code: 'HOST_IMAGE_NOT_CONFIGURED' });
    expect(lifecycle.image).not.toHaveBeenCalled();
  });

  it('does not combine a partial environment override with the built-in entry', () => {
    const lifecycle = { image: jest.fn(imageFrom) };

    const image = resolveCreateVmImage(
      lifecycle,
      { HOST_IMAGE_URL: 'https://images.example/devchain-host-2.0.0.qcow2' },
      BUILT_IN_IMAGE,
    );

    expect(image).toBeNull();
    expect(lifecycle.image).not.toHaveBeenCalled();
  });
});

describe('CreateVmOperation VM certificate', () => {
  const PEM = '-----BEGIN CERTIFICATE-----\nVM\n-----END CERTIFICATE-----\n';
  const IMAGE = imageFrom('https://images.example/devchain-host-1.3.0.qcow2', SHA);

  function setup(readCertificate: jest.Mock) {
    const storage = {
      updateRemoteBaseUrl: jest.fn().mockResolvedValue(undefined),
      updateRemoteTlsCertificate: jest.fn().mockResolvedValue(undefined),
      updateRemoteVmIdentity: jest.fn().mockResolvedValue(undefined),
    };
    const lifecycle = {
      waitIp: jest.fn().mockResolvedValue({
        address: 'https://10.0.0.7:3100',
        bootstrapUrl: 'https://10.0.0.7:3000',
      }),
      readCertificate,
      clone: jest.fn().mockResolvedValue('vm-identity'),
    };
    const host = { runtimeAt: jest.fn().mockResolvedValue({ state: 'unclaimed' }) };
    const create = new CreateVmOperation(
      storage as never,
      lifecycle as never,
      {} as never,
      { steps: [] } as never,
      host as never,
    );
    const details: Record<string, unknown> = {
      connectionId: 'connection-1',
      vmName: 'devchain-test',
      spec: { cores: 1, memory: 4096, disk: 1 },
      port: 3100,
      image: IMAGE,
      templateVmid: 900,
      vmid: 901,
    };
    const progress = jest.fn().mockResolvedValue(undefined);
    const run = (id: string) =>
      create.steps
        .find((step) => step.id === id)!
        .run({
          operation: { id: 'operation-1', remoteId: 'remote-1' } as never,
          details,
          progress,
        });
    return { storage, lifecycle, host, details, progress, run };
  }

  afterEach(() => jest.useRealTimers());

  it('polls the guest agent for the certificate, then saves it and pins the bootstrap to it', async () => {
    jest.useFakeTimers();
    const { storage, host, details, progress, run } = setup(
      jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(PEM),
    );

    const done = run('wait_ip');
    await jest.advanceTimersByTimeAsync(2_000);
    await done;

    expect(details.tlsCertificate).toBe(PEM);
    expect(progress).toHaveBeenCalledWith({ tlsCertificate: PEM });
    expect(storage.updateRemoteTlsCertificate).toHaveBeenCalledWith('remote-1', PEM);
    expect(host.runtimeAt).toHaveBeenCalledWith('https://10.0.0.7:3000', PEM);
    expect(storage.updateRemoteTlsCertificate.mock.invocationCallOrder[0]).toBeLessThan(
      host.runtimeAt.mock.invocationCallOrder[0],
    );
  });

  it('reuses the certificate a failed attempt saved when the step is retried', async () => {
    const readCertificate = jest.fn();
    const { storage, host, details, run } = setup(readCertificate);
    details.tlsCertificate = PEM;

    await run('wait_ip');

    expect(readCertificate).not.toHaveBeenCalled();
    expect(storage.updateRemoteTlsCertificate).toHaveBeenCalledWith('remote-1', PEM);
    expect(host.runtimeAt).toHaveBeenCalledWith('https://10.0.0.7:3000', PEM);
  });

  it('fails without contacting the VM when no certificate appears before the bootstrap timeout', async () => {
    jest.useFakeTimers();
    const readCertificate = jest.fn().mockResolvedValue(null);
    const { storage, host, details, run } = setup(readCertificate);

    const done = expect(run('wait_ip')).rejects.toMatchObject({ code: 'VM_CERTIFICATE_TIMEOUT' });
    await jest.advanceTimersByTimeAsync(60_000);
    await done;

    expect(readCertificate.mock.calls.length).toBeGreaterThan(1);
    expect(details.tlsCertificate).toBeUndefined();
    expect(storage.updateRemoteTlsCertificate).not.toHaveBeenCalled();
    expect(host.runtimeAt).not.toHaveBeenCalled();
  });

  it('names the file-read privilege when Proxmox refuses the guest file read', async () => {
    const { host, run } = setup(
      jest.fn().mockRejectedValue(new ProxmoxRemoteError('proxmox_denied', 'denied')),
    );

    await expect(run('wait_ip')).rejects.toMatchObject({
      code: 'PROXMOX_PERMISSIONS_MISSING',
      message: expect.stringContaining('VM.GuestAgent.FileRead (PVE 9) or VM.Monitor (PVE 8)'),
    });
    expect(host.runtimeAt).not.toHaveBeenCalled();
  });

  it('drops a saved certificate when the clone step runs again', async () => {
    const { details, run } = setup(jest.fn());
    details.tlsCertificate = PEM;

    await run('clone');

    expect(details).not.toHaveProperty('tlsCertificate');
  });
});

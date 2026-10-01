import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetEnvConfig } from '../../../common/config/env.config';
import { findHostInstallDist, HostInstallService } from './host-install.service';

function writePackedInputs(packageRoot: string): string {
  const inputDirectory = join(packageRoot, 'dist/host-install');
  mkdirSync(inputDirectory, { recursive: true });
  writeFileSync(join(inputDirectory, 'devchain-host-bootstrap.tgz'), 'packed archive');
  writeFileSync(
    join(inputDirectory, 'pins.json'),
    JSON.stringify({
      nodeVersion: '24.21.0',
      syncthingVersion: '2.1.5',
      npmRegistry: 'https://registry.original.test/',
      bootstrap: {
        package: 'devchain-host-bootstrap',
        version: '0.1.0',
        sha256: 'a'.repeat(64),
      },
      aptPackages: ['qemu-guest-agent', 'curl'],
    }),
  );
  writeFileSync(join(inputDirectory, 'devchain-bootstrap.service'), '[Service]\n');
  writeFileSync(join(inputDirectory, '60-devchain-inotify.conf'), 'fs.inotify.max=1\n');
  writeFileSync(join(inputDirectory, 'devchain-no-session-bus.pref'), 'Package: dbus-x11\n');
  return inputDirectory;
}

describe('HostInstallService packaged inputs', () => {
  const originalEnv = process.env;
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'devchain-host-install-packed-'));
    process.env = {
      ...originalEnv,
      HOST_NPM_REGISTRY: 'https://registry.override.test/',
    };
    resetEnvConfig();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetEnvConfig();
    rmSync(directory, { recursive: true, force: true });
  });

  it('loads the packaged payload without invoking npm pack and applies the registry override', async () => {
    writePackedInputs(directory);
    const processExecutor = { run: jest.fn() };
    const service = new HostInstallService(processExecutor as never, {
      moduleDirectory: join(directory, 'dist/modules/remotes/host-install'),
      cwd: join(directory, 'elsewhere'),
      dataDirectory: join(directory, 'data'),
    });

    const block = await service.render({
      minDiskGib: 12,
      homePort: 3001,
      imageVersion: '0.1.0',
      homeUser: 'devchain',
      homePath: '/home/devchain',
      devchainVersion: '1.0.0',
    });

    expect(block).toContain("DEVCHAIN_NPM_REGISTRY='https://registry.override.test/'");
    expect(block).toContain(
      `DEVCHAIN_BOOTSTRAP_TGZ_BASE64='${Buffer.from('packed archive').toString('base64')}'`,
    );
    expect(block).toContain('DEVCHAIN_MIN_DISK_GIB=12');
    expect(processExecutor.run).not.toHaveBeenCalled();
  });

  it('finds the packed inputs under an npm prefix that contains src', () => {
    const packageRoot = join(directory, 'home/u/src/npm-global/lib/node_modules/devchain-cli');
    const inputDirectory = writePackedInputs(packageRoot);
    const moduleDirectory = join(packageRoot, 'dist/server/modules/remotes/host-install');

    expect(findHostInstallDist(moduleDirectory)).toBe(inputDirectory);
  });

  it('returns null for a source run so the repository fallback packs the inputs', () => {
    const moduleDirectory = join(directory, 'apps/local-app/src/modules/remotes/host-install');

    expect(findHostInstallDist(moduleDirectory)).toBeNull();
  });

  it('ignores a stale packed build at the repository root during a source run', () => {
    writePackedInputs(directory);
    const moduleDirectory = join(directory, 'apps/local-app/src/modules/remotes/host-install');

    expect(findHostInstallDist(moduleDirectory)).toBeNull();
  });
});

import { Test } from '@nestjs/testing';
import fs from 'fs/promises';
import { join } from 'path';
import { ProcessExecutor } from '../terminal/services/process-executor/process-executor.port';
import { createProductionFileSyncPaths } from './file-sync-paths';
import {
  SYNCTHING_INSTALL_GUIDANCE,
  HOST_SYNCTHING_BINARY,
  findSyncthingBinary,
  hasOwnershipCapabilities,
  NodeSyncthingLauncher,
  parseSyncthingVersion,
  type BinaryLookupDeps,
} from './syncthing-launcher';

// Pure unit: discovery order and version gating are decisions over injected
// file checks and `--version` output, so no binary or filesystem is needed.

const V2 = 'syncthing v2.1.5 "Hafnium Hornet" (go1.27.1 linux-amd64) builder@github.syncthing.net';
const V1 = 'syncthing v1.30.0 "Gold Grasshopper" (go1.24.4 linux-amd64) debian@debian';

function deps(
  binaries: Record<string, string>,
  overrides: Partial<BinaryLookupDeps> = {},
): BinaryLookupDeps {
  return {
    explicitPath: undefined,
    pathEnv: ['/usr/local/bin', '/usr/bin'].join(':'),
    homeDir: '/home/dev',
    platform: 'linux',
    isExecutable: async (path) => path in binaries,
    readVersionOutput: async (path) => binaries[path],
    ...overrides,
  };
}

describe('parseSyncthingVersion', () => {
  it('reads the version and major from --version output', () => {
    expect(parseSyncthingVersion(V2)).toEqual({ version: 'v2.1.5', major: 2 });
    expect(parseSyncthingVersion('syncthing v2.0.0-rc.1 "x"')).toEqual({
      version: 'v2.0.0-rc.1',
      major: 2,
    });
    expect(parseSyncthingVersion('not syncthing')).toBeNull();
  });
});

describe('findSyncthingBinary', () => {
  it('uses only SYNCTHING_BIN when it is set', async () => {
    const lookup = await findSyncthingBinary(
      deps(
        { '/opt/st/syncthing': V2, [HOST_SYNCTHING_BINARY]: V2, '/usr/bin/syncthing': V2 },
        { explicitPath: '/opt/st/syncthing' },
      ),
    );
    expect(lookup).toEqual({ found: true, path: '/opt/st/syncthing', version: 'v2.1.5' });

    const missing = await findSyncthingBinary(
      deps({ '/usr/bin/syncthing': V2 }, { explicitPath: '/opt/none/syncthing' }),
    );
    expect(missing).toEqual({
      found: false,
      version: null,
      error: `SYNCTHING_BIN points at /opt/none/syncthing, which is not an executable file. ${SYNCTHING_INSTALL_GUIDANCE}`,
    });
  });

  it('prefers the executable host copy over PATH without an explicit override', async () => {
    await expect(
      findSyncthingBinary(deps({ [HOST_SYNCTHING_BINARY]: V2, '/usr/bin/syncthing': V2 })),
    ).resolves.toEqual({ found: true, path: HOST_SYNCTHING_BINARY, version: 'v2.1.5' });
  });

  it('searches PATH in order, then ~/.devchain/bin', async () => {
    const onPath = await findSyncthingBinary(
      deps({ '/usr/bin/syncthing': V2, '/home/dev/.devchain/bin/syncthing': V2 }),
    );
    expect(onPath).toMatchObject({ found: true, path: '/usr/bin/syncthing' });

    const inDevchainBin = await findSyncthingBinary(
      deps({ '/home/dev/.devchain/bin/syncthing': V2 }),
    );
    expect(inDevchainBin).toMatchObject({
      found: true,
      path: join('/home/dev', '.devchain', 'bin', 'syncthing'),
    });
  });

  it('passes over a v1 binary to a later v2 one', async () => {
    const lookup = await findSyncthingBinary(
      deps({ '/usr/bin/syncthing': V1, '/home/dev/.devchain/bin/syncthing': V2 }),
    );
    expect(lookup).toMatchObject({ found: true, path: '/home/dev/.devchain/bin/syncthing' });
  });

  it('reports an unsupported version with guidance when no v2 binary exists', async () => {
    const lookup = await findSyncthingBinary(deps({ '/usr/bin/syncthing': V1 }));
    expect(lookup).toEqual({
      found: false,
      version: 'v1.30.0',
      error: `Syncthing v1.30.0 at /usr/bin/syncthing is not supported; DevChain needs v2.x. ${SYNCTHING_INSTALL_GUIDANCE}`,
    });
  });

  it('reports a missing binary with guidance', async () => {
    const lookup = await findSyncthingBinary(deps({}));
    expect(lookup).toEqual({
      found: false,
      version: null,
      error: `Syncthing was not found on PATH or in ~/.devchain/bin. ${SYNCTHING_INSTALL_GUIDANCE}`,
    });
  });

  it('treats a binary whose --version fails as unusable', async () => {
    const lookup = await findSyncthingBinary(
      deps(
        { '/usr/bin/syncthing': V2 },
        {
          readVersionOutput: async () => {
            throw new Error('exec format error');
          },
        },
      ),
    );
    expect(lookup).toMatchObject({ found: false, version: null });
    expect(lookup.found === false && lookup.error).toContain(
      '/usr/bin/syncthing did not report a Syncthing version.',
    );
  });
});

describe('hasOwnershipCapabilities', () => {
  it.each([
    ['000000000000000b', true],
    ['000000000000000f', true],
    ['000001000000000B', true],
    ['000000000000000a', false],
    ['0000000000000009', false],
    ['0000000000000003', false],
    ['0000000000000000', false],
    ['invalid', false],
  ])('requires all three effective capabilities for %s', (effective, privileged) => {
    expect(hasOwnershipCapabilities(`Name:\tsyncthing\nCapEff:\t${effective}\n`)).toBe(privileged);
  });

  it('does not use permitted capabilities or assume privilege without CapEff', () => {
    expect(hasOwnershipCapabilities('CapPrm:\t000000000000000b\n')).toBe(false);
  });
});

(process.platform === 'linux' ? describe : describe.skip)(
  'NodeSyncthingLauncher capabilities',
  () => {
    it('reads the requested process and fails closed when its status cannot be read', async () => {
      const moduleRef = await Test.createTestingModule({
        providers: [NodeSyncthingLauncher, { provide: ProcessExecutor, useValue: {} }],
      }).compile();
      const read = jest.spyOn(fs, 'readFile').mockResolvedValue('CapEff:\t000000000000000b\n');
      try {
        const launcher = moduleRef.get(NodeSyncthingLauncher);
        await expect(launcher.hasOwnershipCapabilities(123)).resolves.toBe(true);
        expect(read).toHaveBeenCalledWith('/proc/123/status', 'utf8');
        read.mockRejectedValue(new Error('process gone'));
        await expect(launcher.hasOwnershipCapabilities(124)).resolves.toBe(false);
      } finally {
        read.mockRestore();
        await moduleRef.close();
      }
    });
  },
);

describe('createProductionFileSyncPaths', () => {
  const paths = createProductionFileSyncPaths('/home/dev');
  const project = { id: 'p1', rootPath: '/home/dev/repos/demo' };

  it('keeps Syncthing under ~/.devchain and shares the project root as is', () => {
    expect(paths.syncthingHome()).toBe('/home/dev/.devchain/syncthing');
    expect(paths.codeFolder(project)).toBe('/home/dev/repos/demo');
  });
});

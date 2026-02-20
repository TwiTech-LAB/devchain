const cliModule = jest.requireActual('../../../../scripts/cli.js') as {
  __test__: {
    detectGlobalPackageManager: (
      packageName: string,
      deps?: {
        realpathSyncFn?: (p: string) => string;
        execFileSyncFn?: (cmd: string, args: string[], opts?: object) => string;
        argvPath?: string;
      },
    ) => {
      name: 'npm' | 'pnpm';
      installCmd: string[];
      sudoInstallCmd: string[] | null;
      manualCmd: string;
    } | null;
  };
};

const { detectGlobalPackageManager } = cliModule.__test__;

const PKG = 'devchain-cli';
const PNPM_GLOBAL_ROOT = '/home/user/.local/share/pnpm/global/5/node_modules';
const NPM_GLOBAL_ROOT = '/usr/lib/node_modules';

/**
 * Build a mock execFileSyncFn.
 * @param available - PM names available on PATH (version check succeeds)
 * @param roots - Map of PM name → global root path returned by `root -g`
 */
function buildExecFileSyncMock(available: string[], roots: Record<string, string> = {}) {
  return (cmd: string, args: string[], _opts?: object): string => {
    // Version probe: execFileSyncFn('pnpm', ['--version'], ...)
    if (args.length === 1 && args[0] === '--version') {
      if (available.includes(cmd)) return '9.0.0';
      throw new Error(`${cmd}: not found`);
    }
    // Root probe: execFileSyncFn('pnpm', ['root', '-g'], ...)
    if (args.length === 2 && args[0] === 'root' && args[1] === '-g') {
      if (roots[cmd]) return roots[cmd] + '\n';
      throw new Error(`${cmd} root -g failed`);
    }
    throw new Error(`Unexpected call: ${cmd} ${args.join(' ')}`);
  };
}

describe('detectGlobalPackageManager', () => {
  it('returns pnpm when script is under pnpm global root', () => {
    const scriptPath = `${PNPM_GLOBAL_ROOT}/devchain-cli/scripts/cli.js`;
    const result = detectGlobalPackageManager(PKG, {
      realpathSyncFn: () => scriptPath,
      execFileSyncFn: buildExecFileSyncMock(['pnpm', 'npm'], {
        pnpm: PNPM_GLOBAL_ROOT,
        npm: NPM_GLOBAL_ROOT,
      }),
      argvPath: '/fake/bin/devchain',
    });

    expect(result).not.toBeNull();
    expect(result!.name).toBe('pnpm');
    expect(result!.installCmd).toEqual(['pnpm', 'add', '-g', `${PKG}@latest`]);
    expect(result!.manualCmd).toBe(`pnpm add -g ${PKG}`);
  });

  it('returns npm when script is under npm global root', () => {
    const scriptPath = `${NPM_GLOBAL_ROOT}/devchain-cli/scripts/cli.js`;
    const result = detectGlobalPackageManager(PKG, {
      realpathSyncFn: () => scriptPath,
      execFileSyncFn: buildExecFileSyncMock(['pnpm', 'npm'], {
        pnpm: PNPM_GLOBAL_ROOT,
        npm: NPM_GLOBAL_ROOT,
      }),
      argvPath: '/fake/bin/devchain',
    });

    expect(result).not.toBeNull();
    expect(result!.name).toBe('npm');
    expect(result!.installCmd).toEqual(['npm', 'install', '-g', `${PKG}@latest`]);
    expect(result!.manualCmd).toBe(`npm install -g ${PKG}`);
  });

  it('returns null when script is not under any PM global root', () => {
    const scriptPath = '/opt/custom/devchain-cli/scripts/cli.js';
    const result = detectGlobalPackageManager(PKG, {
      realpathSyncFn: () => scriptPath,
      execFileSyncFn: buildExecFileSyncMock(['pnpm', 'npm'], {
        pnpm: PNPM_GLOBAL_ROOT,
        npm: NPM_GLOBAL_ROOT,
      }),
      argvPath: '/fake/bin/devchain',
    });

    expect(result).toBeNull();
  });

  it('detects pnpm when only pnpm is available on PATH', () => {
    const scriptPath = `${PNPM_GLOBAL_ROOT}/devchain-cli/scripts/cli.js`;
    const result = detectGlobalPackageManager(PKG, {
      realpathSyncFn: () => scriptPath,
      execFileSyncFn: buildExecFileSyncMock(['pnpm'], {
        pnpm: PNPM_GLOBAL_ROOT,
      }),
      argvPath: '/fake/bin/devchain',
    });

    expect(result).not.toBeNull();
    expect(result!.name).toBe('pnpm');
  });

  it('detects npm when only npm is available on PATH', () => {
    const scriptPath = `${NPM_GLOBAL_ROOT}/devchain-cli/scripts/cli.js`;
    const result = detectGlobalPackageManager(PKG, {
      realpathSyncFn: () => scriptPath,
      execFileSyncFn: buildExecFileSyncMock(['npm'], {
        npm: NPM_GLOBAL_ROOT,
      }),
      argvPath: '/fake/bin/devchain',
    });

    expect(result).not.toBeNull();
    expect(result!.name).toBe('npm');
  });

  it('returns null when neither PM is available on PATH', () => {
    const result = detectGlobalPackageManager(PKG, {
      realpathSyncFn: () => '/some/path/cli.js',
      execFileSyncFn: buildExecFileSyncMock([], {}),
      argvPath: '/fake/bin/devchain',
    });

    expect(result).toBeNull();
  });

  it('returns null when both PMs claim ownership (ambiguous)', () => {
    // Script is under a shared prefix that both roots match
    const sharedRoot = '/usr/lib/node_modules';
    const scriptPath = `${sharedRoot}/devchain-cli/scripts/cli.js`;
    const result = detectGlobalPackageManager(PKG, {
      realpathSyncFn: () => scriptPath,
      execFileSyncFn: buildExecFileSyncMock(['pnpm', 'npm'], {
        pnpm: sharedRoot,
        npm: sharedRoot,
      }),
      argvPath: '/fake/bin/devchain',
    });

    expect(result).toBeNull();
  });

  it('returns null when realpathSync throws', () => {
    const result = detectGlobalPackageManager(PKG, {
      realpathSyncFn: () => {
        throw new Error('ENOENT');
      },
      execFileSyncFn: buildExecFileSyncMock(['npm'], { npm: NPM_GLOBAL_ROOT }),
      argvPath: '/nonexistent/path',
    });

    expect(result).toBeNull();
  });

  it('handles Windows-style paths correctly', () => {
    const winNpmRoot = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules';
    const scriptPath = `${winNpmRoot}\\devchain-cli\\scripts\\cli.js`;
    const result = detectGlobalPackageManager(PKG, {
      realpathSyncFn: () => scriptPath,
      execFileSyncFn: buildExecFileSyncMock(['npm'], {
        npm: winNpmRoot,
      }),
      argvPath: 'C:\\Users\\dev\\AppData\\Roaming\\npm\\devchain',
    });

    expect(result).not.toBeNull();
    expect(result!.name).toBe('npm');
  });

  it('returns correct install command arrays for npm', () => {
    const scriptPath = `${NPM_GLOBAL_ROOT}/devchain-cli/scripts/cli.js`;
    const result = detectGlobalPackageManager(PKG, {
      realpathSyncFn: () => scriptPath,
      execFileSyncFn: buildExecFileSyncMock(['npm'], { npm: NPM_GLOBAL_ROOT }),
      argvPath: '/fake/bin/devchain',
    });

    expect(result).not.toBeNull();
    expect(result!.installCmd).toEqual(['npm', 'install', '-g', `${PKG}@latest`]);
    // sudoInstallCmd depends on platform — test that it's an array or null
    if (result!.sudoInstallCmd) {
      expect(result!.sudoInstallCmd).toEqual(['sudo', 'npm', 'install', '-g', `${PKG}@latest`]);
    }
    expect(result!.manualCmd).toBe(`npm install -g ${PKG}`);
  });

  it('returns correct install command arrays for pnpm', () => {
    const scriptPath = `${PNPM_GLOBAL_ROOT}/devchain-cli/scripts/cli.js`;
    const result = detectGlobalPackageManager(PKG, {
      realpathSyncFn: () => scriptPath,
      execFileSyncFn: buildExecFileSyncMock(['pnpm'], { pnpm: PNPM_GLOBAL_ROOT }),
      argvPath: '/fake/bin/devchain',
    });

    expect(result).not.toBeNull();
    expect(result!.installCmd).toEqual(['pnpm', 'add', '-g', `${PKG}@latest`]);
    if (result!.sudoInstallCmd) {
      expect(result!.sudoInstallCmd).toEqual(['sudo', 'pnpm', 'add', '-g', `${PKG}@latest`]);
    }
    expect(result!.manualCmd).toBe(`pnpm add -g ${PKG}`);
  });

  it('returns null when root -g fails for the only available PM', () => {
    const result = detectGlobalPackageManager(PKG, {
      realpathSyncFn: () => '/some/path/cli.js',
      execFileSyncFn: buildExecFileSyncMock(['npm'], {}), // npm available but no root configured → throws
      argvPath: '/fake/bin/devchain',
    });

    expect(result).toBeNull();
  });
});

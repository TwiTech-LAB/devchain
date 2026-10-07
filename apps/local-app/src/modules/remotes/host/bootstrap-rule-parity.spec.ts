import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as semver from 'semver';
import {
  baseHostInstallAptPackages,
  generateHostInstallBlock,
  HOST_INSTALL_BOOTSTRAP_PORT,
  HOST_INSTALL_MIN_MEMORY_MIB,
  type HostInstallPins,
} from '../host-install/host-install-block';
import { HostInstallService, parseVersionsEnv } from '../host-install/host-install.service';
import { HOME_ROOTS, USER_NAME } from '../operations/claim.operation';
import { MIN_HOST_IMAGE_VERSION } from '../host-image';
import { MIN_VM_MEMORY_MIB } from '../operations/vm-operations.dto';
import { REFUSED_FILES, renderHostEnvFile } from './host-provider-auth.service';

interface BootstrapValidationModule {
  USER_NAME: RegExp;
  HOME_ROOTS: string[];
  REFUSED_HOME_FILES: string[];
}

interface BootstrapRenderModule {
  renderEnvFile(env: Record<string, string>): string;
}

const requireFromTest = createRequire(__filename);
const bootstrapValidation = requireFromTest(
  '../../../../../host-bootstrap/lib/validate.js',
) as BootstrapValidationModule;
const bootstrapRender = requireFromTest(
  '../../../../../host-bootstrap/lib/render.js',
) as BootstrapRenderModule;

const imageVersions = parseVersionsEnv(
  readFileSync(join(__dirname, '../../../../../host-image/versions.env'), 'utf8'),
);
const imageRequiredPackages = imageVersions.DEVCHAIN_REQUIRED_PACKAGES.split(/\s+/);
const imageToolPackages = imageVersions.DEVCHAIN_TOOL_PACKAGES.split(/\s+/);

const installerPins: HostInstallPins = {
  nodeVersion: '24.21.0',
  syncthingVersion: '2.1.5',
  npmRegistry: 'https://registry.npmjs.org/',
  bootstrap: { package: '@devchain/host-bootstrap', version: '0.1.0', sha256: 'a'.repeat(64) },
  aptPackages: imageRequiredPackages,
  toolPackages: imageToolPackages,
};

describe('host bootstrap rule parity', () => {
  it('uses the same POSIX user name pattern', () => {
    expect(bootstrapValidation.USER_NAME.source).toBe(USER_NAME.source);
    expect(bootstrapValidation.USER_NAME.flags).toBe(USER_NAME.flags);
  });

  it('allows the same home roots', () => {
    expect(bootstrapValidation.HOME_ROOTS).toEqual(
      HOME_ROOTS.map((root) => root.replace(/\/$/, '')),
    );
  });

  it('refuses the same provider auth files', () => {
    expect(bootstrapValidation.REFUSED_HOME_FILES).toEqual(REFUSED_FILES);
  });

  it('renders escaped host environment values the same way', () => {
    const env = {
      PLAIN: 'plain value',
      BACKSLASH: '\\',
      DOUBLE_QUOTE: '"',
      BACKTICK: '`',
      DOLLAR: '$',
    };

    expect(renderHostEnvFile(env).split('\n').slice(1)).toEqual(
      bootstrapRender.renderEnvFile(env).split('\n').slice(1),
    );
  });

  it('installs the image package set with guest tools selected by the hypervisor', () => {
    expect(baseHostInstallAptPackages(installerPins)).toEqual(
      imageRequiredPackages.filter((name) => name !== 'qemu-guest-agent'),
    );
  });

  // Loading source pins catches drift in the producer without running npm pack.
  it('pins both image package lists and keeps agent tools separate from requirements', async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), 'devchain-image-package-pins-'));
    const processExecutor = {
      run: jest.fn(async () => {
        writeFileSync(join(dataDirectory, 'bootstrap.tgz'), 'archive');
        return { success: true, stdout: '[{"filename":"bootstrap.tgz"}]' };
      }),
    };
    try {
      const service = new HostInstallService(processExecutor as never, {
        moduleDirectory: __dirname,
        cwd: join(__dirname, '../../../../../..'),
        dataDirectory,
      });
      const { pins } = await service.loadInputs();
      expect(pins.aptPackages).toEqual(imageRequiredPackages);
      expect(pins.toolPackages).toEqual(imageToolPackages);
    } finally {
      rmSync(dataDirectory, { recursive: true, force: true });
    }
    expect(imageRequiredPackages).toEqual([
      'qemu-guest-agent',
      'tmux',
      'git',
      'curl',
      'ca-certificates',
      'xz-utils',
      'build-essential',
      'python3',
      'jq',
      'openssl',
      'procps',
    ]);
    expect(imageToolPackages).not.toContain('yq');
    expect(imageToolPackages.filter((name) => imageRequiredPackages.includes(name))).toEqual([]);
    const expected = [
      'jq',
      'ripgrep',
      'python-is-python3',
      'python3-pip',
      'python3-venv',
      'file',
      'sqlite3',
      'bsdextrautils',
      'rsync',
      'unzip',
      'openssl',
      'screen',
      'psmisc',
      'procps',
      'time',
      'lsof',
      'strace',
      'htop',
      'less',
      'nano',
      'vim-tiny',
      'tree',
      'zip',
      'net-tools',
      'iputils-ping',
      'inetutils-telnet',
      'netcat-openbsd',
      'bind9-dnsutils',
      'traceroute',
      'mtr-tiny',
      'tcpdump',
      'socat',
      'fd-find',
      'universal-ctags',
      'gawk',
      'shellcheck',
      'cloc',
      'git-lfs',
    ];
    const imagePackages = [...imageRequiredPackages, ...imageToolPackages];
    for (const name of expected) {
      expect(imagePackages).toContain(name);
    }
  });

  it('keeps the MemTotal floor 512 MiB below configured VM memory', () => {
    expect(HOST_INSTALL_MIN_MEMORY_MIB).toBe(MIN_VM_MEMORY_MIB - 512);
  });

  it('uses the bootstrap unit port', () => {
    const unit = readFileSync(
      join(__dirname, '../../../../../host-bootstrap/systemd/devchain-bootstrap.service'),
      'utf8',
    );
    const port = Number(/Environment=DEVCHAIN_BOOTSTRAP_PORT=(\d+)/.exec(unit)?.[1]);

    expect(HOST_INSTALL_BOOTSTRAP_PORT).toBe(port);
  });

  it('renders the minimum image version accepted by the home claim gate', () => {
    const block = generateHostInstallBlock({
      pins: installerPins,
      bootstrapTgzBase64: 'eA==',
      bootstrapUnit: 'unit',
      sysctlConfig: 'sysctl',
      aptPreference: 'preference',
      minDiskGib: 8,
      homePort: 3001,
      imageVersion: MIN_HOST_IMAGE_VERSION,
      homeUser: 'devchain',
      homePath: '/home/devchain',
      devchainVersion: '1.0.0',
    });

    expect(semver.valid(MIN_HOST_IMAGE_VERSION)).not.toBeNull();
    expect(semver.gte(MIN_HOST_IMAGE_VERSION, MIN_HOST_IMAGE_VERSION)).toBe(true);
    expect(block).toContain(`DEVCHAIN_IMAGE_VERSION='${MIN_HOST_IMAGE_VERSION}'`);
  });
});

import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateHostInstallBlock, type HostInstallBlockOptions } from './host-install-block';

const REQUIRED_FLAGS = ['cx16', 'pni', 'ssse3', 'sse4_1', 'sse4_2', 'popcnt', 'pclmulqdq'];
const CPU_FLAGS = {
  host: 'fpu cx16 pni ssse3 sse4_1 sse4_2 popcnt pclmulqdq aes avx',
  'x86-64-v2-AES': 'fpu cx16 pni ssse3 sse4_1 sse4_2 popcnt aes',
  kvm64: 'fpu cx16 pni sse sse2',
};
const cpuInfo = (flags: string, count = 2) =>
  Array.from({ length: count }, (_, index) => `processor : ${index}\nflags : ${flags}\n`).join(
    '\n',
  );

const ARCHIVE = Buffer.from('packed bootstrap fixture');
const FAKE_COMMAND = `#!/bin/bash
name="\${0##*/}"
printf '%s\\t%s\\n' "$name" "$*" >> "$FAKE_LOG"
# usage: fake_lock_refusal <counter> <refusals> <message> <status>; the first calls fail on a lock
fake_lock_refusal() {
  local calls=0
  [[ -f "$FAKE_LOG.$1" ]] && calls="$(/bin/cat "$FAKE_LOG.$1")"
  calls=$((calls + 1))
  printf '%s' "$calls" > "$FAKE_LOG.$1"
  if (( calls <= $2 )); then printf '%s\\n' "$3" >&2; exit "$4"; fi
}
case "$name" in
  apt-get)
    if [[ " $* " == *' update '* && -n "\${FAKE_APT_LOCK_TIMES:-}" ]]; then
      fake_lock_refusal apt-calls "$FAKE_APT_LOCK_TIMES" \
        'E: Could not get lock /var/lib/apt/lists/lock. It is held by process 123 (apt-get)' 100
    fi
    if [[ " $* " == *' -s '* ]]; then
      printf '%b\\n' "\${FAKE_PURGE_PREVIEW:-Remv gnome-keyring [1.0]}"
    fi
    ;;
  curl)
    url="\${!#}"
    if [[ "$url" == */devchain-cli/* ]]; then
      printf '%s' "\${FAKE_VERSION_STATUS:-200}"
      exit "\${FAKE_VERSION_EXIT:-0}"
    fi
    if [[ "$*" == *'-fsSI'* ]]; then
      [[ -z "\${FAKE_REACH_FAIL:-}" || "$url" != *"$FAKE_REACH_FAIL"* ]]
      return_code=$?
      (( return_code == 0 )) || exit "$return_code"
    fi
    out=''
    want_out=0
    for value in "$@"; do
      if (( want_out == 1 )); then out="$value"; want_out=0; continue; fi
      [[ "$value" == -o || "$value" == *o ]] && want_out=1
    done
    if [[ -n "$out" ]]; then
      if [[ "$out" == *SHASUMS256.txt ]]; then
        hash="$(printf 'node archive' | /usr/bin/sha256sum | /usr/bin/awk '{print $1}')"
        printf '%s  node-v24.21.0-linux-x64.tar.xz\\n' "$hash" > "$out"
      else
        printf 'node archive' > "$out"
      fi
    fi
    ;;
  df)
    printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'
    printf '/dev/fake 40000000 1 %s 1%% /\\n' "\${FAKE_FREE_KIB:-30000000}"
    ;;
  findmnt)
    printf '%s' "\${FAKE_ROOT_SOURCE:-/dev/sda1}"
    exit "\${FAKE_FINDMNT_EXIT:-0}"
    ;;
  lvs)
    printf '%s' "\${FAKE_LVS:-}"
    exit "\${FAKE_LVS_EXIT:-0}"
    ;;
  dpkg)
    if [[ "\${1:-}" == --print-architecture ]]; then printf '%s\\n' "\${FAKE_ARCH:-amd64}"; fi
    if [[ "\${1:-}" == --configure ]]; then
      if [[ -n "\${FAKE_DPKG_LOCK_TIMES:-}" ]]; then
        fake_lock_refusal dpkg-calls "$FAKE_DPKG_LOCK_TIMES" \
          'dpkg: error: dpkg frontend lock is locked by another process' 2
      fi
      [[ -z "\${FAKE_DPKG_ERROR:-}" ]] || printf '%b\\n' "$FAKE_DPKG_ERROR" >&2
      exit "\${FAKE_DPKG_EXIT:-0}"
    fi
    ;;
  dpkg-query)
    if [[ "$*" == *'Status-Status'* ]]; then
      for package in ubuntu-desktop gnome-shell dbus-user-session dbus-x11 gnome-keyring snapd; do
        if [[ " \${FAKE_DESKTOP:-} \${FAKE_HEADLESS:-} " == *" $package "* ]]; then
          printf '%s installed\\n' "$package"
        fi
      done
    else
      printf '1.0'
    fi
    ;;
  getent)
    if [[ "\${1:-}" == passwd && -n "\${FAKE_ACCOUNT_HOME:-}" ]]; then
      printf 'devchain:x:1000:1000::%s:/bin/bash\\n' "$FAKE_ACCOUNT_HOME"
    fi
    ;;
  ip)
    printf '2: eth0    inet %s brd 192.168.1.255 scope global eth0\\n' "\${FAKE_IP:-192.168.1.20/24}"
    ;;
  npm)
    if [[ "\${1:-}" == --version ]]; then printf '10.0.0\\n'; fi
    ;;
  sha256sum)
    if [[ "\${1:-}" == -c ]]; then /bin/cat >/dev/null; else /usr/bin/sha256sum "$@"; fi
    ;;
  snap) printf 'Name Version Rev Tracking Publisher Notes\\n' ;;
  ss)
    if [[ -n "\${FAKE_BUSY_PORT:-}" ]]; then
      printf 'LISTEN 0 128 0.0.0.0:%s 0.0.0.0:*\\n' "$FAKE_BUSY_PORT"
    fi
    ;;
  syncthing)
    if [[ -z "\${HOME:-}" ]]; then printf '$HOME is not defined'; exit 1; fi
    printf 'syncthing v2.1.5 linux-amd64\\n'
    ;;

  systemctl)
    if [[ "\${1:-}" == is-enabled ]]; then
      [[ "\${FAKE_DISPLAY_MANAGER:-0}" == 1 ]]
    elif [[ "\${1:-}" == start ]]; then
      if [[ -f "$DEVCHAIN_HOST_INSTALL_ROOT/usr/share/devchain-host/manifest.json" ]]; then
        printf 'manifest-before-start=yes\\n' >> "$FAKE_LOG"
        if [[ "\${FAKE_NO_CERT:-0}" != 1 ]]; then
          /bin/mkdir -p "$DEVCHAIN_HOST_INSTALL_ROOT/etc/devchain-host/tls"
          printf 'fake certificate\\n' > "$DEVCHAIN_HOST_INSTALL_ROOT/etc/devchain-host/tls/cert.pem"
        fi
      else
        printf 'manifest-before-start=no\\n' >> "$FAKE_LOG"
        exit 1
      fi
    fi
    ;;
  openssl)
    [[ " $* " == *" -in $DEVCHAIN_HOST_INSTALL_ROOT/etc/devchain-host/tls/cert.pem "* && -f "$DEVCHAIN_HOST_INSTALL_ROOT/etc/devchain-host/tls/cert.pem" ]] || exit 1
    printf 'sha256 Fingerprint=%s\\n' "$FAKE_FINGERPRINT"
    ;;
  systemd-detect-virt) printf '%s\\n' "\${FAKE_VIRT:-qemu}" ;;
  ufw) printf 'Status: %s\\n' "\${FAKE_UFW_STATUS:-inactive}" ;;
esac
`;

const FAKE_FINGERPRINT = Array.from({ length: 32 }, (_, index) =>
  index.toString(16).padStart(2, '0').toUpperCase(),
).join(':');

const REAL_COMMANDS = [
  'awk',
  'base64',
  'cat',
  'chmod',
  'grep',
  'install',
  'mkdir',
  'mktemp',
  'rm',
  'sed',
  'sleep',
  'tr',
];

const FAKE_COMMANDS = [
  'apt-get',
  'curl',
  'df',
  'findmnt',
  'lvs',
  'dpkg',
  'dpkg-query',
  'getent',
  'id',
  'ip',
  'npm',
  'openssl',
  'sha256sum',
  'snap',
  'ss',
  'sudo',
  'syncthing',
  'sysctl',
  'systemctl',
  'systemd-detect-virt',
  'systemd-run',
  'tar',
  'useradd',
  'ufw',
  'visudo',
  'xz',
];

describe('host install block', () => {
  let directory: string;
  let root: string;
  let fakeBin: string;
  let logPath: string;

  const options = (overrides: Partial<HostInstallBlockOptions> = {}): HostInstallBlockOptions => ({
    pins: {
      nodeVersion: '24.21.0',
      syncthingVersion: '2.1.5',
      npmRegistry: 'https://registry.npmjs.org/',
      bootstrap: {
        package: '@devchain/host-bootstrap',
        version: '0.1.0',
        sha256: createHash('sha256').update(ARCHIVE).digest('hex'),
      },
      aptPackages: [
        'qemu-guest-agent',
        'tmux',
        'git',
        'curl',
        'ca-certificates',
        'xz-utils',
        'build-essential',
        'python3',
      ],
    },
    bootstrapTgzBase64: ARCHIVE.toString('base64'),
    bootstrapUnit: '[Service]\nEnvironment=DEVCHAIN_BOOTSTRAP_PORT=3000\n',
    sysctlConfig: 'fs.inotify.max_user_watches=1048576\n',
    aptPreference: 'Package: dbus-user-session\nPin-Priority: -1\n',
    minDiskGib: 8,
    homePort: 3001,
    imageVersion: '0.1.0',
    homeUser: 'devchain',
    homePath: '/home/devchain',
    devchainVersion: '1.2.3',
    ...overrides,
  });

  function writeRoot(path: string, content: string): void {
    const target = join(root, path.replace(/^\//, ''));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }

  function run(
    input: Partial<HostInstallBlockOptions> = {},
    env: Record<string, string | undefined> = {},
  ): ReturnType<typeof spawnSync> {
    return spawnSync('/bin/bash', ['-s'], {
      input: generateHostInstallBlock(options(input)),
      encoding: 'utf8',
      env: {
        ...process.env,
        DEVCHAIN_HOST_INSTALL_ROOT: root,
        DEVCHAIN_HOST_INSTALL_PATH: fakeBin,
        DEVCHAIN_HOST_INSTALL_EUID: '0',
        FAKE_LOG: logPath,
        FAKE_FINGERPRINT,
        ...env,
      },
    });
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'devchain-host-install-'));
    root = join(directory, 'root');
    fakeBin = join(directory, 'bin');
    logPath = join(directory, 'commands.log');
    mkdirSync(root);
    mkdirSync(fakeBin);
    writeFileSync(logPath, '');
    writeRoot('/proc/1/comm', 'systemd\n');
    writeRoot('/proc/meminfo', 'MemTotal:       4194304 kB\n');
    writeRoot('/proc/cpuinfo', cpuInfo(CPU_FLAGS.host));
    writeRoot('/etc/os-release', 'ID=ubuntu\nVERSION_ID="24.04"\n');
    mkdirSync(join(root, 'etc/sudoers.d'), { recursive: true });

    const dispatcher = join(fakeBin, '_fake');
    writeFileSync(dispatcher, FAKE_COMMAND);
    chmodSync(dispatcher, 0o755);
    for (const name of FAKE_COMMANDS) symlinkSync(dispatcher, join(fakeBin, name));
    for (const name of REAL_COMMANDS) symlinkSync(join('/usr/bin', name), join(fakeBin, name));
    // Node is not always in /usr/bin (nvm, /usr/local/bin): link the one running the tests.
    symlinkSync(process.execPath, join(fakeBin, 'node'));
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('is valid bash, uses return-based failures, and renders check mode explicitly', () => {
    const block = generateHostInstallBlock(options({ checkOnly: true }));
    const syntax = spawnSync('/bin/bash', ['-n'], { input: block, encoding: 'utf8' });

    expect(syntax.status).toBe(0);
    expect(syntax.stderr).toBe('');
    expect(block).not.toMatch(/^\s*exit\b/m);
    expect(block.trimEnd().endsWith('devchain_host_install --check')).toBe(true);
  });

  it.each(['exit', 'exit 1', '  exit 2'])(
    'the shell-exit guard rejects an actual %s statement',
    (statement) => {
      const block = generateHostInstallBlock(options({ checkOnly: true }));
      const withShellExit = block.replace('    return 1', statement);
      expect(withShellExit).not.toBe(block);
      expect(withShellExit).toMatch(/^\s*exit\b/m);
    },
  );

  // The block travels as an SFTP-uploaded script, not as an argv command, so the cap is a
  // bloat tripwire: the real packed bootstrap is ~16.9 KiB and the shipped block is ~43 KiB.
  it('stays below 48 KiB with a packed bootstrap-sized payload', () => {
    const archive = Buffer.alloc(16 * 1024, 1);
    const block = generateHostInstallBlock(
      options({
        pins: {
          ...options().pins,
          bootstrap: {
            ...options().pins.bootstrap,
            sha256: createHash('sha256').update(archive).digest('hex'),
          },
        },
        bootstrapTgzBase64: archive.toString('base64'),
        bootstrapUnit: readFileSync(
          join(__dirname, '../../../../../host-bootstrap/systemd/devchain-bootstrap.service'),
          'utf8',
        ),
        sysctlConfig: readFileSync(
          join(__dirname, '../../../../../host-image/files/60-devchain-inotify.conf'),
          'utf8',
        ),
        aptPreference: readFileSync(
          join(__dirname, '../../../../../host-image/files/devchain-no-session-bus.pref'),
          'utf8',
        ),
      }),
    );

    expect(Buffer.byteLength(block)).toBeLessThan(48 * 1024);
  });

  // Running the generated shell against fixtures verifies refusal before mutation without a VM.
  it.each(['x86-64-v2-AES', 'kvm64'] as const)(
    'refuses %s CPU flags before installation',
    (model) => {
      const flags = CPU_FLAGS[model];
      writeRoot('/proc/cpuinfo', cpuInfo(flags));
      const result = run();
      const missing = REQUIRED_FLAGS.filter((flag) => !flags.split(' ').includes(flag));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`The VM CPU lacks ${missing.join(' ')}.`);
      expect(result.stderr).toContain('Set the VM CPU type to host');
      expect(result.stderr).toContain('then shut down and start the VM');
      expect(readFileSync(logPath, 'utf8')).not.toContain('dpkg\t--configure -a');
      expect(existsSync(join(root, 'usr/share/devchain-host/manifest.json'))).toBe(false);
    },
  );

  it.each([1, 2])('accepts host CPU flags with %i processors', (count) => {
    writeRoot('/proc/cpuinfo', cpuInfo(CPU_FLAGS.host, count));
    const result = run({ checkOnly: true });
    expect(result.status).toBe(0);
    if (count === 1) {
      expect(result.stderr).toContain(
        'WARNING: The VM has 1 vCPU. 2 or more are recommended for agent sessions.',
      );
    } else {
      expect(result.stderr).not.toContain('vCPU');
    }
  });

  it.each(['200', '404', '503', '000', '401', '403'])(
    'checks the registry version response %s',
    (status) => {
      const result = run(
        {},
        { FAKE_VERSION_STATUS: status, FAKE_VERSION_EXIT: status === '000' ? '28' : '0' },
      );
      expect(result.status).toBe(status === '200' ? 0 : 1);
      const log = readFileSync(logPath, 'utf8');
      expect(log).toContain(
        'curl\t-sS -o /dev/null -w %{http_code} --max-time 10 https://registry.npmjs.org/devchain-cli/1.2.3',
      );
      if (status === '404') {
        expect(result.stderr).toContain('has no devchain-cli 1.2.3');
        expect(result.stderr).toContain('HOST_NPM_REGISTRY');
      } else if (status !== '200') {
        expect(result.stderr).toContain(
          `Could not verify devchain-cli 1.2.3 at https://registry.npmjs.org/ (answered ${status}).`,
        );
        expect(result.stderr).not.toContain('Publish it there');
      }
      if (status !== '200') expect(log).not.toContain('dpkg\t--configure -a');
    },
  );

  it('reports found memory and free disk values', () => {
    writeRoot('/proc/meminfo', 'MemTotal: 2097152 kB\n');
    const result = run({ checkOnly: true }, { FAKE_FREE_KIB: '3145728' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('found 2048 MiB.');
    expect(result.stderr).toContain('found 3 GiB free.');
  });

  it.each(['15.00', '1.00', '<15.50', '<1.00', '0.50', '0', ''])(
    'adds an LVM hint only for available VG space (%s)',
    (free) => {
      const result = run(
        { checkOnly: true },
        {
          FAKE_FREE_KIB: '3145728',
          FAKE_ROOT_SOURCE: '/dev/mapper/ubuntu--vg-ubuntu--lv',
          FAKE_LVS: free ? `  /dev/ubuntu-vg/ubuntu-lv ubuntu-vg ${free}` : '',
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('found 3 GiB free.');
      if (Number(free.replace('<', '')) >= 1 && free !== '<1.00') {
        expect(result.stderr).toContain(`Volume group ubuntu-vg has ${free} GiB unused.`);
        expect(result.stderr).toContain(
          'Run: sudo lvextend -r -l +100%FREE /dev/ubuntu-vg/ubuntu-lv',
        );
      } else {
        expect(result.stderr).not.toContain('lvextend');
      }
    },
  );

  it.each(['findmnt', 'lvs'])('keeps the disk error when %s is unavailable', (tool) => {
    unlinkSync(join(fakeBin, tool));
    const result = run({ checkOnly: true }, { FAKE_FREE_KIB: '3145728' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('found 3 GiB free.');
    expect(result.stderr).not.toContain('lvextend');
    expect(result.stderr).not.toContain('command not found');
  });

  it.each(['FAKE_FINDMNT_EXIT', 'FAKE_LVS_EXIT'])('keeps the disk error when %s fails', (key) => {
    const result = run({ checkOnly: true }, { FAKE_FREE_KIB: '3145728', [key]: '5' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('found 3 GiB free.');
    expect(result.stderr).not.toContain('lvextend');
  });

  it('records the syncthing version when the detached environment has no HOME', () => {
    const result = run({}, { HOME: undefined });
    expect(result.status).toBe(0);
    const manifest = JSON.parse(
      readFileSync(join(root, 'usr/share/devchain-host/manifest.json'), 'utf8'),
    );
    expect(manifest.syncthingCli).toBe('syncthing v2.1.5 linux-amd64');
  });

  it('runs every pre-validation, reports all failures, and changes no install target in check mode', () => {
    writeRoot('/proc/1/comm', 'init\n');
    writeRoot('/etc/os-release', 'ID=fedora\nVERSION_ID="42"\n');
    const result = run(
      { checkOnly: true },
      {
        DEVCHAIN_HOST_INSTALL_EUID: '1000',
        FAKE_ARCH: 'arm64',
        FAKE_DESKTOP: 'gnome-shell',
        FAKE_FREE_KIB: '10',
        FAKE_BUSY_PORT: '3000',
        FAKE_REACH_FAIL: 'nodejs.org',
        FAKE_HEADLESS: 'gnome-keyring',
        FAKE_PURGE_PREVIEW: 'Remv sudo [1.0]',
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('run with sudo');
    expect(result.stderr).toContain('systemd must be PID 1');
    expect(result.stderr).toContain('Only Ubuntu');
    expect(result.stderr).toContain('architecture must be amd64');
    expect(result.stderr).toContain('Desktop packages are installed');
    expect(result.stderr).toContain('free space');
    expect(result.stderr).toContain('TCP port 3000');
    expect(result.stderr).toContain('Cannot reach https://nodejs.org/');
    expect(result.stderr).toContain('headless purge would remove');
    expect(result.stderr).toMatch(/Pre-validation found \d+ problem/);
    expect(existsSync(join(root, 'usr/share/devchain-host/manifest.json'))).toBe(false);
    expect(existsSync(join(root, 'etc/sysctl.d/60-devchain-inotify.conf'))).toBe(false);
    expect(readFileSync(logPath, 'utf8')).not.toContain('dpkg\t--configure -a');
  });

  it.each([
    ['root', () => ({ env: { DEVCHAIN_HOST_INSTALL_EUID: '1000' }, message: 'run with sudo' })],
    [
      'systemd PID 1',
      () => {
        writeRoot('/proc/1/comm', 'init\n');
        return { message: 'systemd must be PID 1' };
      },
    ],
    [
      'supported OS',
      () => {
        writeRoot('/etc/os-release', 'ID=debian\nVERSION_ID="11"\n');
        return { message: 'Debian 12 or newer' };
      },
    ],
    ['amd64', () => ({ env: { FAKE_ARCH: 'arm64' }, message: 'architecture must be amd64' })],
    [
      'unclaimed host',
      () => {
        writeRoot('/etc/devchain-host/claim.json', '{}\n');
        return { message: 'already a claimed' };
      },
    ],
    [
      'non-image host',
      () => {
        writeRoot('/usr/share/devchain-host/manifest.json', '{"schemaVersion":1}\n');
        return { message: 'created from a DevChain host image' };
      },
    ],
    [
      'no display manager',
      () => ({ env: { FAKE_DISPLAY_MANAGER: '1' }, message: 'display manager is enabled' }),
    ],
    [
      'no desktop packages',
      () => ({
        env: { FAKE_DESKTOP: 'ubuntu-desktop' },
        message: 'Desktop packages are installed',
      }),
    ],
    [
      'memory floor',
      () => {
        writeRoot('/proc/meminfo', 'MemTotal:       3000000 kB\n');
        return { message: '3584 MiB of memory' };
      },
    ],
    ['free disk', () => ({ env: { FAKE_FREE_KIB: '1000' }, message: 'free space' })],
    ['bootstrap port', () => ({ env: { FAKE_BUSY_PORT: '3000' }, message: 'TCP port 3000' })],
    ['home port', () => ({ env: { FAKE_BUSY_PORT: '3001' }, message: 'TCP port 3001' })],
    [
      'sudoers directory',
      () => {
        rmSync(join(root, 'etc/sudoers.d'), { recursive: true });
        return { message: '/etc/sudoers.d is missing' };
      },
    ],
    [
      'reachability',
      () => ({ env: { FAKE_REACH_FAIL: 'apt.syncthing.net' }, message: 'Cannot reach' }),
    ],
    [
      'embedded archive digest',
      () => ({
        input: { bootstrapTgzBase64: Buffer.from('damaged').toString('base64') },
        message: 'archive is damaged',
      }),
    ],
    [
      'safe purge',
      () => ({
        env: { FAKE_HEADLESS: 'gnome-keyring', FAKE_PURGE_PREVIEW: 'Remv systemd [1.0]' },
        message: 'headless purge would remove',
      }),
    ],
  ])('refuses a failed %s check', (_name, arrange) => {
    const scenario = arrange() as {
      input?: Partial<HostInstallBlockOptions>;
      env?: Record<string, string>;
      message: string;
    };
    const result = run({ checkOnly: true, ...scenario.input }, scenario.env);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(scenario.message);
  });

  it('fails without printing an address when the bootstrap started without its certificate', () => {
    const result = run({}, { FAKE_NO_CERT: '1' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'The bootstrap started without its certificate /etc/devchain-host/tls/cert.pem.',
    );
    expect(result.stdout).not.toContain('bootstrap is ready');
  });

  it('explains an unclaimed install when the bootstrap port is busy', () => {
    writeRoot(
      '/usr/share/devchain-host/manifest.json',
      '{"install":{"method":"devchain-host-install"}}\n',
    );
    writeRoot('/etc/devchain-host/tls/cert.pem', 'certificate\n');
    const result = run({ checkOnly: true }, { FAKE_BUSY_PORT: '3000' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "DevChain is already installed on this VM but not claimed. Choose “Set up a new VM” on the Cloud page and enter this VM's address to claim it.",
    );
    expect(result.stderr).toContain(
      'print it with: openssl x509 -in /etc/devchain-host/tls/cert.pem -noout -fingerprint -sha256',
    );
    expect(result.stderr).not.toContain('TCP port 3000 is already listening.');
  });

  it('asks to stop an older installer that has no certificate', () => {
    writeRoot(
      '/usr/share/devchain-host/manifest.json',
      '{"install":{"method":"devchain-host-install"}}\n',
    );
    const result = run({ checkOnly: true }, { FAKE_BUSY_PORT: '3000' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'An older DevChain installer is running on this VM. Stop it with: sudo systemctl disable --now devchain-bootstrap.service. Then run this install again.',
    );
    expect(result.stderr).not.toContain('fingerprint');
  });

  it('keeps the plain busy-port error when the VM is claimed or another port is busy', () => {
    writeRoot(
      '/usr/share/devchain-host/manifest.json',
      '{"install":{"method":"devchain-host-install"}}\n',
    );

    writeRoot('/etc/devchain-host/claim.json', '{}\n');
    const claimed = run({ checkOnly: true }, { FAKE_BUSY_PORT: '3000' });
    expect(claimed.stderr).toContain('already a claimed');
    expect(claimed.stderr).toContain('TCP port 3000 is already listening.');
    expect(claimed.stderr).not.toContain('not claimed');

    rmSync(join(root, 'etc/devchain-host/claim.json'));
    const homePort = run({ checkOnly: true }, { FAKE_BUSY_PORT: '3001' });
    expect(homePort.stderr).toContain('TCP port 3001 is already listening.');
    expect(homePort.stderr).not.toContain('not claimed');
  });

  it.each([
    'curl',
    'apt-get',
    'dpkg',
    'tar',
    'xz',
    'systemctl',
    'systemd-run',
    'ss',
    'useradd',
    'visudo',
    'getent',
    'id',
    'sudo',
  ])('reports the missing required tool %s', (tool) => {
    unlinkSync(join(fakeBin, tool));
    const result = run({ checkOnly: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Required command is missing: ${tool}`);
  });

  it.each([
    'nodejs.org',
    'syncthing.net',
    'apt.syncthing.net',
    'registry.npmjs.org',
    'antigravity.google',
  ])('refuses when %s is unreachable', (host) => {
    const result = run({ checkOnly: true }, { FAKE_REACH_FAIL: host });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Cannot reach');
    expect(result.stderr).toContain(host);
  });

  it.each([
    'openssh-server',
    'sudo',
    'systemd',
    'dbus',
    'netplan.io',
    'systemd-networkd',
    'ifupdown',
  ])('refuses when the headless purge would remove %s', (packageName) => {
    const result = run(
      { checkOnly: true },
      { FAKE_HEADLESS: 'gnome-keyring', FAKE_PURGE_PREVIEW: `Remv ${packageName} [1.0]` },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('headless purge would remove');
  });

  it('refuses an Ubuntu release below 22.04', () => {
    writeRoot('/etc/os-release', 'ID=ubuntu\nVERSION_ID="20.04"\n');

    const result = run({ checkOnly: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Ubuntu 22.04 or newer');
  });

  it('prints every warning without turning warnings into refusals', () => {
    writeRoot('/etc/os-release', 'ID=ubuntu\nVERSION_ID="25.10"\n');
    const result = run(
      { checkOnly: true },
      {
        FAKE_IP: '203.0.113.8/24',
        FAKE_UFW_STATUS: 'active',
        FAKE_ACCOUNT_HOME: '/home/devchain',
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('not an LTS release');
    expect(result.stderr).toContain('address 203.0.113.8 is public');
    expect(result.stderr).toContain('ufw is active');
    expect(result.stderr).toContain('claim reuses it and grants passwordless sudo');
  });

  it('accepts Debian 12 with its integer VERSION_ID', () => {
    writeRoot('/etc/os-release', 'ID=debian\nVERSION_ID="12"\n');

    const result = run({ checkOnly: true });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('warns when the requested account has a different home', () => {
    const result = run({ checkOnly: true }, { FAKE_ACCOUNT_HOME: '/srv/elsewhere' });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('choose another user or home in Set up VM');
  });

  it('installs in order, writes the full manifest before start, and safely reruns partial state', () => {
    writeRoot('/etc/systemd/system/devchain-bootstrap.service', 'partial unit\n');
    writeRoot('/usr/share/devchain-host/manifest.json', '{"install":{"method":"partial"}}\n');
    mkdirSync(join(root, 'opt/devchain-host'), { recursive: true });

    const first = run();
    expect(first.status).toBe(0);
    expect(first.stderr).toBe('');
    expect(first.stdout).toContain('https://192.168.1.20:3000');
    expect(first.stdout).toContain(`Certificate fingerprint (SHA-256): ${FAKE_FINGERPRINT}\n`);
    expect(first.stdout).toContain(
      'In Cloud, choose Set up a new VM, enter this address, and paste this fingerprint.',
    );

    const manifestPath = join(root, 'usr/share/devchain-host/manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      imageVersion: '0.1.0',
      arch: 'amd64',
      base: { name: 'ubuntu-24.04-installed' },
      npmRegistry: 'https://registry.npmjs.org/',
      bootstrap: { package: '@devchain/host-bootstrap', version: '0.1.0' },
      runtimes: { npm: '10.0.0' },
      install: { method: 'devchain-host-install', devchainVersion: '1.2.3' },
    });
    expect((manifest.packages as Record<string, string>)['qemu-guest-agent']).toBe('1.0');
    expect(
      readFileSync(join(root, 'etc/systemd/system/devchain-bootstrap.service'), 'utf8'),
    ).toContain('DEVCHAIN_BOOTSTRAP_PORT=3000');
    expect(readFileSync(join(root, 'etc/sysctl.d/60-devchain-inotify.conf'), 'utf8')).toContain(
      'max_user_watches',
    );
    expect(
      readFileSync(join(root, 'etc/apt/preferences.d/devchain-no-session-bus.pref'), 'utf8'),
    ).toContain('Pin-Priority');

    const log = readFileSync(logPath, 'utf8');
    expect(log).toContain('manifest-before-start=yes');
    expect(log).toContain('systemctl\tdaemon-reload');
    expect(log).toContain('systemctl\tenable devchain-bootstrap.service');
    expect(log).toContain('sysctl\t--system');
    const configure = log.indexOf('dpkg\t--configure -a');
    const firstMutatingApt = log.indexOf('apt-get\t-o DPkg::Lock::Timeout=600 update');
    expect(configure).toBeGreaterThanOrEqual(0);
    expect(firstMutatingApt).toBeGreaterThan(configure);
    for (const line of log.split('\n').filter((entry) => entry.startsWith('apt-get\t'))) {
      expect(line).toContain('-o DPkg::Lock::Timeout=600');
    }

    const second = run();
    expect(second.status).toBe(0);
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toMatchObject({
      install: { method: 'devchain-host-install' },
    });
  });

  const lockCases = [
    { lock: 'dpkg', env: 'FAKE_DPKG_LOCK_TIMES', command: /^dpkg\t--configure -a$/gm, runs: 3 },
    {
      lock: 'apt lists',
      env: 'FAKE_APT_LOCK_TIMES',
      command: /^apt-get\t-o DPkg::Lock::Timeout=600 update$/gm,
      // two refusals, then the success, then the update for the Syncthing list
      runs: 4,
    },
  ];

  it.each(lockCases)(
    'waits for the $lock lock and continues once it is released',
    ({ env, command, runs }) => {
      const result = run({}, { [env]: '2', DEVCHAIN_PACKAGE_LOCK_RETRY_SECONDS: '0' });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(readFileSync(logPath, 'utf8').match(command)).toHaveLength(runs);
      expect(existsSync(join(root, 'usr/share/devchain-host/manifest.json'))).toBe(true);
    },
  );

  it.each(lockCases)(
    'fails with a retry hint when the $lock lock stays busy for the whole budget',
    ({ lock, env, command }) => {
      const result = run({}, { [env]: '999999', DEVCHAIN_PACKAGE_LOCK_TIMEOUT: '0' });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `The ${lock} lock stayed busy for 10 minutes (probably automatic updates). Wait for them to finish, then press Retry.`,
      );
      const log = readFileSync(logPath, 'utf8');
      expect(log.match(command)).toHaveLength(1);
      expect(log).not.toContain('install -y');
      expect(existsSync(join(root, 'usr/share/devchain-host/manifest.json'))).toBe(false);
    },
  );

  it('fails at once when dpkg fails for a reason other than the lock', () => {
    const result = run(
      {},
      { FAKE_DPKG_EXIT: '2', FAKE_DPKG_ERROR: 'dpkg: error: processing package broken-package' },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('dpkg: error: processing package broken-package');
    expect(result.stderr).not.toContain('stayed busy');
    expect(readFileSync(logPath, 'utf8').match(/^dpkg\t--configure -a$/gm)).toHaveLength(1);
  });

  it.each([
    ['vmware', 'open-vm-tools'],
    ['docker', null],
  ])('selects the guest tools for %s', (virtualization, guestPackage) => {
    const result = run({}, { FAKE_VIRT: virtualization });

    expect(result.status).toBe(0);
    const manifest = JSON.parse(
      readFileSync(join(root, 'usr/share/devchain-host/manifest.json'), 'utf8'),
    ) as { packages: Record<string, string> };
    if (guestPackage) {
      expect(manifest.packages[guestPackage]).toBe('1.0');
    } else {
      expect(manifest.packages).not.toHaveProperty('qemu-guest-agent');
      expect(manifest.packages).not.toHaveProperty('open-vm-tools');
    }
  });

  it('refuses claimed and image hosts while accepting an installer manifest', () => {
    writeRoot(
      '/usr/share/devchain-host/manifest.json',
      '{"install":{"method":"devchain-host-install"}}\n',
    );
    expect(run({ checkOnly: true }).status).toBe(0);

    writeRoot('/etc/devchain-host/claim.json', '{}\n');
    expect(run({ checkOnly: true }).stderr).toContain('already a claimed');
    rmSync(join(root, 'etc/devchain-host/claim.json'));

    writeRoot('/usr/share/devchain-host/manifest.json', '{"schemaVersion":1}\n');
    expect(run({ checkOnly: true }).stderr).toContain('created from a DevChain host image');
  });
});

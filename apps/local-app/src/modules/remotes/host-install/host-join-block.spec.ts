import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateHostJoinBlock, type HostJoinBlockOptions } from './host-join-block';

// Executing the generated script against temp files catches shell/Node interpolation
// and version-path mistakes without installing packages or needing root.
describe('shared VM join script', () => {
  let root: string;
  let bin: string;
  let log: string;
  let options: HostJoinBlockOptions;
  const archive = Buffer.from('bootstrap fixture');
  const source = resolve(__dirname, '../../../../../host-bootstrap');

  function put(file: string, contents: string): void {
    const target = join(root, file);
    mkdirSync(resolve(target, '..'), { recursive: true });
    writeFileSync(target, contents);
  }

  function instance(userName: string, version: string, marker: unknown = 1, legacy = false): void {
    const etc = legacy ? 'etc/devchain-host' : `etc/devchain-host/instances/${userName}`;
    const install = legacy ? 'opt/devchain-host' : `opt/devchain-host/instances/${userName}`;
    put(
      `${etc}/claim.json`,
      JSON.stringify({
        userName,
        homePath: `/home/${userName}`,
        version,
        port: legacy ? 3000 : 3001,
      }),
    );
    put(
      `${install}/versions/${version}/lib/node_modules/devchain-cli/dist/host-install/pins.json`,
      JSON.stringify({ sharedVmProtocol: marker }),
    );
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'host-join-script-'));
    bin = join(root, 'fake-bin');
    log = join(root, 'commands.log');
    mkdirSync(bin);
    mkdirSync(join(root, 'tmp'));
    mkdirSync(join(root, 'etc/systemd/system'), { recursive: true });
    instance('alice', '0.25.0', 1, true);
    put('proc/meminfo', 'MemAvailable: 3145728 kB\n');
    for (const name of ['node', 'flock'])
      symlinkSync(name === 'node' ? process.execPath : '/usr/bin/flock', join(bin, name));
    const command = `#!/bin/bash
name="\${0##*/}"
printf '%s %s\\n' "$name" "$*" >> "$JOIN_TEST_LOG"
case "$name" in
getent) exit 2 ;;
df) printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/fake 40000000 1 30000000 1%% /\\n' ;;
syncthing) printf 'syncthing v2.1.5 linux-amd64\\n' ;;
npm) for arg in "$@"; do if [[ "$arg" == --prefix=* ]]; then prefix="\${arg#--prefix=}"; fi; done
  "$JOIN_TEST_NODE" -e 'const fs=require("node:fs");fs.mkdirSync(process.argv[2]+"/lib/node_modules",{recursive:true});fs.cpSync(process.argv[1],process.argv[2]+"/lib/node_modules/devchain-host-bootstrap",{recursive:true});fs.mkdirSync(process.argv[2]+"/bin",{recursive:true});fs.symlinkSync("../lib/node_modules/devchain-host-bootstrap/bin/devchain-bootstrap.js",process.argv[2]+"/bin/devchain-bootstrap");' "$JOIN_TEST_SOURCE" "$prefix" ;;
esac
`;
    for (const name of ['getent', 'df', 'syncthing', 'npm', 'systemctl', 'ss']) {
      writeFileSync(join(bin, name), command);
      chmodSync(join(bin, name), 0o755);
    }
    options = {
      homeUser: 'bob',
      homePath: '/home/bob',
      homePort: 3000,
      minDiskGib: 8,
      requestId: 'join-bob',
      checkOnly: true,
      pins: {
        nodeVersion: '24.21.0',
        syncthingVersion: '2.1.5',
        npmRegistry: 'https://registry.test/',
        bootstrap: {
          package: 'devchain-host-bootstrap',
          version: '0.1.0',
          sha256: createHash('sha256').update(archive).digest('hex'),
        },
        aptPackages: ['tmux'],
      },
      bootstrapTgzBase64: archive.toString('base64'),
    };
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function run(): ReturnType<typeof spawnSync> {
    return spawnSync('/bin/bash', ['-s'], {
      input: generateHostJoinBlock(options),
      encoding: 'utf8',
      env: {
        ...process.env,
        DEVCHAIN_HOST_JOIN_ROOT: root,
        DEVCHAIN_HOST_JOIN_PATH: bin,
        JOIN_TEST_LOG: log,
        JOIN_TEST_NODE: process.execPath,
        JOIN_TEST_SOURCE: source,
      },
    });
  }

  it('accepts a claimed image VM and warns using available memory without preparing its baseline', () => {
    put('usr/share/devchain-host/manifest.json', '{"imageVersion":"1.4.0"}');
    put('proc/meminfo', 'MemAvailable: 1048576 kB\n');
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('WARNING: The VM has 1024 MiB available memory');
    expect(readFileSync(log, 'utf8')).not.toMatch(/apt|npm|systemctl|node install/);
  });

  it.each([undefined, 2, '1', null, 'malformed', 'missing'])(
    'refuses marker %s from an existing version and names all affected instances',
    (marker) => {
      instance('carol', '0.26.0', marker);
      const file = join(
        root,
        'opt/devchain-host/instances/carol/versions/0.26.0/lib/node_modules/devchain-cli/dist/host-install/pins.json',
      );
      if (marker === undefined) writeFileSync(file, '{}');
      if (marker === 'malformed') writeFileSync(file, 'not json');
      if (marker === 'missing') rmSync(file);
      put(
        'opt/devchain-host/versions/0.25.0/lib/node_modules/devchain-cli/dist/host-install/pins.json',
        '{}',
      );
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('HOST_JOIN_VERSION_UNSUPPORTED');
      expect(result.stderr).toContain('alice (0.25.0), carol (0.26.0)');
    },
  );

  it.each(['/home/bob', '/Users/bob'])(
    'refuses an existing user with home %s using the instance name and port',
    (home) => {
      instance('bob', '0.25.0');
      put(
        'etc/devchain-host/instances/bob/claim.json',
        JSON.stringify({ userName: 'bob', homePath: home, port: 3001, version: '0.25.0' }),
      );
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('INSTANCE_EXISTS');
      expect(result.stderr).toContain('bob on port 3001.');
      expect(result.stderr.includes('Add it by address.')).toBe(home === options.homePath);
    },
  );

  it('refuses a destroy fence before installing the helper', () => {
    put('etc/devchain-host/fence.json', '{}');
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('HOST_JOIN_FENCED');
    expect(existsSync(log)).toBe(false);
  });

  it('refuses an account with another home using the existing account-collision code', () => {
    writeFileSync(
      join(bin, 'getent'),
      '#!/bin/bash\nprintf "bob:x:1001:1001::/srv/bob:/bin/bash\\n"\n',
    );
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('HOST_INSTALL_ACCOUNT_COLLISION');
    expect(result.stderr).toContain('"accountHome":"/srv/bob"');
  });

  it.each(['disk', 'syncthing'])(
    'refuses an inadequate %s baseline without replacing it',
    (baseline) => {
      const file = join(bin, baseline === 'disk' ? 'df' : 'syncthing');
      writeFileSync(
        file,
        baseline === 'disk'
          ? '#!/bin/bash\nprintf "Filesystem blocks Used Available Capacity Mounted\\n/dev/fake 4000 1 1024 1%% /\\n"\n'
          : '#!/bin/bash\nprintf "syncthing v1.2.3 linux-amd64\\n"\n',
      );
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        baseline === 'disk' ? 'HOST_INSTALL_DISK_TOO_SMALL' : 'HOST_JOIN_SYNCTHING_UNSUPPORTED',
      );
      expect(readFileSync(log, 'utf8')).not.toContain('npm install');
    },
  );

  it('installs and reserves under the host lock without writing the nonce into its log', () => {
    options.checkOnly = false;
    const before = readFileSync(join(root, 'etc/devchain-host/claim.json'));
    const result = run();
    expect(result.status).toBe(0);
    const reservation = JSON.parse(
      readFileSync(join(root, 'etc/devchain-host/instances/bob/join.json'), 'utf8'),
    ) as { port: number };
    const nonce = readFileSync(
      join(root, 'etc/devchain-host/instances/bob/join.nonce'),
      'utf8',
    ).trim();
    expect(reservation.port).toBe(3001);
    expect(result.stdout).not.toContain(nonce);
    expect(result.stderr).not.toContain(nonce);
    expect(readFileSync(log, 'utf8')).not.toContain(nonce);
    expect(readFileSync(log, 'utf8')).toContain(
      `--prefix=${root}/opt/devchain-host/instances/bob/helper`,
    );
    expect(readFileSync(join(root, 'etc/devchain-host/claim.json'))).toEqual(before);
  });
});

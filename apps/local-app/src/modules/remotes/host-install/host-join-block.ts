import { USER_NAME } from '../operations/claim.operation';
import { SHARED_VM_PROTOCOL, type HostInstallPins } from './host-install-block';

export interface HostJoinRenderOptions {
  homeUser: string;
  homePath: string;
  homePort: number;
  uid?: number;
  gid?: number;
  minDiskGib: number;
  requestId: string;
  checkOnly?: boolean;
}

export interface HostJoinBlockOptions extends HostJoinRenderOptions {
  pins: HostInstallPins;
  bootstrapTgzBase64: string;
}

/** Checks the shared VM baseline and installs only this user's bootstrap package. */
export function generateHostJoinBlock(options: HostJoinBlockOptions): string {
  if (
    !USER_NAME.test(options.homeUser) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(options.requestId) ||
    !Number.isSafeInteger(options.minDiskGib) ||
    options.minDiskGib < 1 ||
    !/^[a-f0-9]{64}$/.test(options.pins.bootstrap.sha256) ||
    !/^\/(home|Users|var\/home)\/[A-Za-z0-9._/-]+$/.test(options.homePath)
  )
    throw new Error('Invalid host join inputs.');
  const settings = {
    userName: options.homeUser,
    homePath: options.homePath,
    port: options.homePort,
    uid: options.uid,
    minDiskGib: options.minDiskGib,
    requestId: options.requestId,
    sha256: options.pins.bootstrap.sha256,
    archive: options.bootstrapTgzBase64,
    checkOnly: options.checkOnly === true,
  };
  return `#!/bin/bash
set -Eeuo pipefail
export PATH="\${DEVCHAIN_HOST_JOIN_PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"
export HOME="\${HOME:-/root}"
umask 077
flock --exclusive "\${DEVCHAIN_HOST_JOIN_ROOT:-}/etc/devchain-host/registry.lock" node <<'DEVCHAIN_HOST_JOIN'
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { promisify } = require('node:util');
const run = promisify(require('node:child_process').execFile);
const settings = ${JSON.stringify(settings)};
const root = process.env.DEVCHAIN_HOST_JOIN_ROOT || '';
const at = (name) => path.join(root, name);
const userPattern = /^[a-z_][a-z0-9_-]{0,31}$/;
const versionPattern = /^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$/;
const fail = (code, message, extra) => { throw Object.assign(new Error(message), { code, ...extra }); };
const json = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
async function present(file) { try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function check() {
  if (!root && process.getuid() !== 0) fail('HOST_JOIN_CHECK_FAILED', 'Run the VM join as root.');
  if (await present(at('/etc/devchain-host/fence.json'))) fail('HOST_JOIN_FENCED', 'This VM is being destroyed; joining is refused.');
  const legacyFile = at('/etc/devchain-host/claim.json');
  if (!(await present(legacyFile))) fail('HOST_NOT_CLAIMED', 'This VM is not a claimed DevChain host.');
  const records = [];
  try {
    records.push({ claim: await json(legacyFile), installRoot: at('/opt/devchain-host') });
    const dir = at('/etc/devchain-host/instances');
    if (await present(dir)) for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !userPattern.test(entry.name)) fail('HOST_JOIN_CHECK_FAILED', 'The instance registry is invalid.');
      const ownDir = path.join(dir, entry.name);
      const claimFile = path.join(ownDir, 'claim.json');
      if (await present(claimFile)) {
        const claim = await json(claimFile);
        if (claim.userName !== entry.name) fail('HOST_JOIN_CHECK_FAILED', 'An instance claim does not match its registry entry.');
        records.push({ claim, installRoot: at('/opt/devchain-host/instances/' + entry.name) });
      } else if (entry.name === settings.userName && await present(path.join(ownDir, 'join.json'))) {
        const join = await json(path.join(ownDir, 'join.json'));
        if (join.requestId !== settings.requestId && (join.claimStartedAt || Date.parse(join.expiresAt) > Date.now()))
          fail('INSTANCE_EXISTS', 'This VM already runs DevChain for ' + entry.name + ' on port ' + join.port + '.');
      }
    }
  } catch (error) {
    if (error.code === 'HOST_JOIN_CHECK_FAILED' || error.code === 'INSTANCE_EXISTS') throw error;
    fail('HOST_JOIN_CHECK_FAILED', 'Cannot read the VM instance registry.');
  }
  const unsupported = [];
  for (const { claim, installRoot } of records) {
    if (!userPattern.test(claim.userName) || !versionPattern.test(claim.version) || typeof claim.homePath !== 'string' || !Number.isInteger(claim.port))
      fail('HOST_JOIN_CHECK_FAILED', 'An instance claim is invalid.');
    let capable = false;
    try { capable = (await json(path.join(installRoot, 'versions', claim.version, 'lib/node_modules/devchain-cli/dist/host-install/pins.json'))).sharedVmProtocol === ${SHARED_VM_PROTOCOL}; } catch {}
    if (!capable) unsupported.push(claim.userName + ' (' + claim.version + ')');
  }
  if (unsupported.length) fail('HOST_JOIN_VERSION_UNSUPPORTED', 'Update these VM instances to a shared-capable DevChain version before joining: ' + unsupported.join(', ') + '.');
  const duplicate = records.find(({ claim }) => claim.userName === settings.userName)?.claim;
  if (duplicate) fail('INSTANCE_EXISTS', duplicate.homePath === settings.homePath
    ? 'DevChain already runs for ' + duplicate.userName + ' on port ' + duplicate.port + '. Add it by address.'
    : 'This VM already runs DevChain for ' + duplicate.userName + ' on port ' + duplicate.port + '.');
  let account;
  try { account = (await run('getent', ['passwd', settings.userName])).stdout.trim().split(':'); }
  catch (error) { if (error.code !== 2) fail('HOST_INSTALL_ACCOUNT_CHECK_FAILED', 'Could not check the requested account on the VM.'); }
  if (account && account[5] !== settings.homePath)
    fail('HOST_INSTALL_ACCOUNT_COLLISION', 'The VM account uses another home folder.', { accountHome: account[5] });
  const memory = await fs.readFile(at('/proc/meminfo'), 'utf8');
  const available = Number(memory.match(/^MemAvailable:\\s+(\\d+)/m)?.[1]);
  if (!Number.isFinite(available)) fail('HOST_JOIN_CHECK_FAILED', 'Cannot inspect the VM available memory.');
  if (available < 2048 * 1024) console.log('WARNING: The VM has ' + Math.floor(available / 1024) + ' MiB available memory; at least 2048 MiB is recommended when joining.');
  const free = Number((await run('df', ['-Pk', root || '/'])).stdout.trim().split('\\n')[1]?.trim().split(/\\s+/)[3]);
  if (!Number.isFinite(free) || free < settings.minDiskGib * 1024 * 1024)
    fail('HOST_INSTALL_DISK_TOO_SMALL', 'At least ' + settings.minDiskGib + ' GiB of free disk space is required for this join.');
  let syncthing;
  try { syncthing = (await run('syncthing', ['--version'])).stdout; } catch {}
  if (!/^syncthing v2\\./.test(syncthing || '')) fail('HOST_JOIN_SYNCTHING_UNSUPPORTED', 'The VM must already have Syncthing v2 before joining.');
}
async function main() {
  await check();
  if (settings.checkOnly) { console.log('Pre-validation passed.'); return; }
  const dir = await fs.mkdtemp(at('/tmp/devchain-host-join-'));
  try {
    const archive = Buffer.from(settings.archive, 'base64');
    if (createHash('sha256').update(archive).digest('hex') !== settings.sha256) fail('HOST_JOIN_PACKAGE_INVALID', 'The bootstrap package SHA-256 does not match.');
    const file = path.join(dir, 'bootstrap.tgz');
    await fs.writeFile(file, archive, { mode: 0o600 });
    await run('npm', ['install', '-g', '--prefix=' + at('/opt/devchain-host/instances/' + settings.userName + '/helper'), '--omit=dev', '--no-fund', '--no-audit', '--ignore-scripts', file], { timeout: 15 * 60_000, maxBuffer: 1000000 });
    const lib = at('/opt/devchain-host/instances/' + settings.userName + '/helper/lib/node_modules/devchain-host-bootstrap/lib');
    const sys = require(path.join(lib, 'system')).createSystem(root ? { paths: { etcDir: at('/etc/devchain-host'), installRoot: at('/opt/devchain-host'), tlsDir: at('/etc/devchain-host/tls'), systemdDir: at('/etc/systemd/system'), sudoersDir: at('/etc/sudoers.d'), profileDir: at('/etc/profile.d'), binDir: at('/usr/local/bin'), cliPrefix: at('/usr/local'), manifestFile: at('/usr/share/devchain-host/manifest.json') } } : {});
    // The wrapper already holds this kernel lock; acquiring it again would deadlock.
    sys.withHostLock = async (action) => action();
    await require(path.join(lib, 'instances')).reserveJoin({ userName: settings.userName, homePath: settings.homePath, port: settings.port, requestId: settings.requestId, ...(settings.uid !== undefined ? { uid: settings.uid } : {}) }, sys);
    console.log('The instance bootstrap is installed and its join is reserved.');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
main().catch((error) => { process.stderr.write(JSON.stringify({ code: error.code || 'HOST_JOIN_CHECK_FAILED', message: error.code ? error.message : 'The VM join check or helper installation failed.', ...(error.accountHome ? { accountHome: error.accountHome } : {}) }) + '\\n'); process.exitCode = 1; });
DEVCHAIN_HOST_JOIN
`;
}

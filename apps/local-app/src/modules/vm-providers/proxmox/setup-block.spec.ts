import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProxmoxConnectionString } from './connection-string';
import {
  generateProxmoxSetupBlock,
  ProxmoxSetupBlockQuerySchema,
  type ProxmoxSetupBlockOptions,
} from './setup-block';

const FAKE_PVEUM = `#!/usr/bin/env node
const fs = require('node:fs');
const statePath = process.env.FAKE_STATE_FILE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);
if (!args.includes('list')) fs.appendFileSync(process.env.FAKE_WRITES_FILE, 'pveum ' + args.join(' ') + '\\n');
const value = (key) => args[args.indexOf(key) + 1];
const write = () => fs.writeFileSync(statePath, JSON.stringify(state));
const json = (data) => process.stdout.write(JSON.stringify(data));
if (args[0] === 'user' && args[1] === 'token') {
  if (args[2] === 'list') {
    json(state.token ? [{ tokenid: 'agent', privsep: 0 }] : []);
  } else if (args[2] === 'remove') {
    if (!state.token || args[3] !== 'devchain@pve' || args[4] !== 'agent') process.exit(2);
    state.token = null;
    state.tokenOperations.push('remove');
    write();
  } else if (args[2] === 'add') {
    if (state.token || args[3] !== 'devchain@pve' || args[4] !== 'agent') process.exit(2);
    state.token = { secret: 'fake-secret-' + (state.rotations + 1), privsep: value('--privsep') };
    state.rotations += 1;
    state.tokenOperations.push('add');
    write();
    json({ value: state.token.secret, 'full-tokenid': 'devchain@pve!agent' });
  } else {
    process.exit(2);
  }
} else {
switch (args.slice(0, 2).join(' ')) {
  case 'pool list': json(state.pools.map((poolid) => ({ poolid }))); break;
  case 'pool add': state.pools.push(args[2]); write(); break;
  case 'user list': json(state.users.map((userid) => ({ userid }))); break;
  case 'user add': state.users.push(args[2]); write(); break;
  case 'role list': json(state.roles.map(([roleid, privs]) => ({ roleid, privs }))); break;
  case 'role add':
  case 'role modify': {
    const role = args[2];
    const row = [role, value('--privs')];
    const index = state.roles.findIndex(([roleid]) => roleid === role);
    if (index < 0) state.roles.push(row); else state.roles[index] = row;
    write();
    break;
  }
  case 'acl modify': {
    const path = args[2];
    state.acls[path] = { user: value('--users'), roles: value('--roles'), propagate: value('--propagate') };
    write();
    break;
  }
  default: process.exit(2);
}
}
`;

const FAKE_PVESM = `#!/usr/bin/env node
const fs = require('node:fs');
const path = process.env.PVE_STORAGE_CFG;
const args = process.argv.slice(2);
if (args[0] !== 'set') process.exit(2);
fs.appendFileSync(process.env.FAKE_WRITES_FILE, 'pvesm ' + args.join(' ') + '\\n');
if (process.env.FAKE_PVESM_FAIL === '1') process.exit(1);
const content = args[args.indexOf('--content') + 1];
const source = fs.readFileSync(path, 'utf8');
fs.writeFileSync(path, source.replace(/(^\\s*content\\s+).+$/m, '$1' + content));
`;

const FAKE_PVESH = `#!/usr/bin/env node
const fs = require('node:fs');
const data = JSON.parse(fs.readFileSync(process.env.FAKE_DISCOVERY_FILE, 'utf8'));
const args = process.argv.slice(2);
const value = (key) => args[args.indexOf(key) + 1];
if (args[0] !== 'get' || value('--output-format') !== 'json') process.exit(2);
let result;
if (args[1] === '/cluster/status') result = data.nodes;
else if (/^\\/nodes\\/[^/]+\\/storage$/.test(args[1]) && value('--enabled') === '1') {
  if (args.includes('--format')) {
    if (value('--format') !== '1' || value('--content') !== 'images') process.exit(2);
    result = data.vmStorage;
  } else result = data.imageStorage;
} else if (/^\\/nodes\\/[^/]+\\/network$/.test(args[1]) && value('--type') === 'any_local_bridge') {
  result = data.networks[args[1].split('/')[2]];
} else process.exit(2);
process.stdout.write(JSON.stringify(result));
`;

interface DiscoveryFixture {
  nodes: Array<Record<string, unknown>>;
  vmStorage: Array<Record<string, unknown>>;
  imageStorage: Array<Record<string, unknown>>;
  networks: Record<string, Array<Record<string, unknown>>>;
}

interface FakePveState {
  pools: string[];
  users: string[];
  roles: Array<[string, string]>;
  acls: Record<string, { user: string; roles: string; propagate: string }>;
  token: null | { secret: string; privsep: string };
  rotations: number;
  tokenOperations: string[];
}

// Executing the rendered Bash with fake Proxmox commands covers quoting, selection and write ordering.
describe('Proxmox setup block', () => {
  let directory: string;
  let fakeBin: string;
  let storageConfig: string;
  let certificatePath: string;
  let statePath: string;
  let discoveryPath: string;
  let writesPath: string;
  let discovery: DiscoveryFixture;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'devchain-proxmox-setup-'));
    fakeBin = join(directory, 'bin');
    mkdirSync(fakeBin);
    storageConfig = join(directory, 'storage.cfg');
    certificatePath = join(directory, 'pve-ssl.pem');
    statePath = join(directory, 'pve-state.json');
    discoveryPath = join(directory, 'discovery.json');
    writesPath = join(directory, 'writes.log');
    writeFileSync(writesPath, '');
    discovery = {
      nodes: [
        { type: 'cluster', name: 'cluster' },
        { type: 'node', name: 'pve1', local: 1 },
      ],
      vmStorage: [{ storage: 'local-lvm', active: 1, avail: 100 * 1024 ** 3 }],
      imageStorage: [{ storage: 'local', active: 1, type: 'dir' }],
      networks: {
        pve1: [{ iface: 'vmbr0', active: 1, gateway: '192.0.2.1', cidr: '192.0.2.2/24' }],
      },
    };
    writeFileSync(
      storageConfig,
      'dir: local\n  path /var/lib/vz\n  content iso,vztmpl,backup\n\n' +
        'lvmthin: local-lvm\n  thinpool data\n  vgname pve\n  content images,rootdir\n',
    );
    writeFileSync(
      statePath,
      JSON.stringify({
        pools: [],
        users: [],
        roles: [],
        acls: {},
        token: null,
        rotations: 0,
        tokenOperations: [],
      } satisfies FakePveState),
    );
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(directory, 'pve.key'),
        '-out',
        certificatePath,
        '-days',
        '2',
        '-subj',
        '/CN=pve.test',
      ],
      { stdio: 'ignore' },
    );
    for (const [name, source] of [
      ['pveum', FAKE_PVEUM],
      ['pvesm', FAKE_PVESM],
      ['pvesh', FAKE_PVESH],
      ['hostname', "#!/bin/sh\nprintf 'pve-node.example\\n'\n"],
    ]) {
      const path = join(fakeBin, name);
      writeFileSync(path, source);
      chmodSync(path, 0o755);
    }
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  const block = (options: Partial<ProxmoxSetupBlockOptions> = {}) =>
    generateProxmoxSetupBlock(ProxmoxSetupBlockQuerySchema.parse(options));

  function runSetup(
    rotate = false,
    options: Partial<ProxmoxSetupBlockOptions> & { pveHost?: string; failStorage?: boolean } = {},
  ) {
    const { pveHost, failStorage, ...placement } = options;
    writeFileSync(discoveryPath, JSON.stringify(discovery));
    return spawnSync('bash', ['-s', '--', ...(rotate ? ['--rotate'] : [])], {
      input: block(placement),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        FAKE_STATE_FILE: statePath,
        FAKE_DISCOVERY_FILE: discoveryPath,
        FAKE_WRITES_FILE: writesPath,
        FAKE_PVESM_FAIL: failStorage ? '1' : '0',
        PVE_STORAGE_CFG: storageConfig,
        PVE_CERT_PATH: certificatePath,
        PVE_ROOT_CA_PATH: certificatePath,
        PVE_HOST: pveHost ?? 'pve.test',
      },
    });
  }

  it('creates the scoped setup once and safely reruns without losing the token secret', () => {
    const first = runSetup();
    expect(first.status).toBe(0);
    expect(first.stderr).toContain('Node: pve1');
    expect(first.stderr).toContain('VM storage: local-lvm — 100.0 GiB free (information only)');
    expect(first.stderr).toContain('Image storage: local');
    expect(first.stderr).toContain('Bridge: vmbr0');
    expect(first.stderr).toContain('Address: pve.test');
    expect(readFileSync(writesPath, 'utf8').split('\n')[0]).toBe(
      'pvesm set local --content iso,vztmpl,backup,import',
    );
    const lines = first.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    const connection = new URL(lines[0]);
    expect(connection.protocol).toBe('devchain-proxmox:');
    expect(connection.hostname).toBe('pve.test');
    expect(connection.port).toBe('8006');
    expect(connection.pathname).toBe('/pve1');
    expect(connection.searchParams.get('pool')).toBe('devchain');
    expect(connection.searchParams.get('token')).toBe('devchain@pve!agent:fake-secret-1');
    expect(parseProxmoxConnectionString(lines[0])).toMatchObject({
      apiUrl: 'https://pve.test:8006',
      node: 'pve1',
      pool: 'devchain',
      caPem: readFileSync(certificatePath, 'utf8'),
      tokenSecret: 'fake-secret-1',
    });
    expect(Buffer.from(connection.searchParams.get('ca')!, 'base64').toString()).toBe(
      readFileSync(certificatePath, 'utf8'),
    );

    const firstState = JSON.parse(readFileSync(statePath, 'utf8')) as FakePveState;
    expect(firstState.pools).toEqual(['devchain']);
    expect(firstState.users).toEqual(['devchain@pve']);
    expect(firstState.roles).toEqual([
      ['DevChainImageUpload', 'Datastore.AllocateTemplate Datastore.Audit'],
      ['DevChainNetFetch', 'Sys.AccessNetwork'],
    ]);
    expect(Object.keys(firstState.acls).sort()).toEqual(
      [
        '/pool/devchain',
        '/storage/local-lvm',
        '/storage/local',
        '/sdn/zones/localnetwork/vmbr0',
        '/nodes/pve1',
      ].sort(),
    );
    expect(firstState.acls['/pool/devchain'].roles).toBe('PVEVMAdmin,PVEPoolUser');
    expect(firstState.acls['/storage/local'].roles).toBe('PVEDatastoreUser,DevChainImageUpload');
    expect(firstState.token).toEqual({ secret: 'fake-secret-1', privsep: '0' });
    expect(readFileSync(storageConfig, 'utf8')).toContain('content iso,vztmpl,backup,import');

    const second = runSetup();
    expect(second.status).toBe(0);
    expect(second.stdout).toBe('');
    expect(second.stderr).toContain(first.stderr);
    expect(second.stderr).toContain('existing token was preserved');
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual(firstState);
  });

  it('removes and re-adds the fixed token only when --rotate is passed', () => {
    const renderedBlock = block();
    const removeCallIndex = renderedBlock.indexOf(
      'pveum user token remove "$DEVCHAIN_USER" "$DEVCHAIN_TOKEN_ID"',
    );
    const addCallIndex = renderedBlock.indexOf(
      'pveum user token add "$DEVCHAIN_USER" "$DEVCHAIN_TOKEN_ID"',
      removeCallIndex,
    );
    expect(removeCallIndex).toBeGreaterThanOrEqual(0);
    expect(addCallIndex).toBeGreaterThan(removeCallIndex);
    // pveum 8.4 has no `token modify --regenerate`; rotation is remove + add, and the fake
    // exits non-zero on any `token modify` so a regression fails at runtime as well.
    expect(renderedBlock).not.toContain('pveum user token modify');

    expect(runSetup().status).toBe(0);
    const rotated = runSetup(true);
    expect(rotated.status).toBe(0);
    expect(rotated.stdout).toContain('token=devchain@pve!agent:fake-secret-2');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as FakePveState;
    expect(state).toMatchObject({
      token: { secret: 'fake-secret-2', privsep: '0' },
      rotations: 2,
    });
    expect(state.tokenOperations).toEqual(['add', 'remove', 'add']);
  });

  it('uses an optional address as the default Proxmox host', () => {
    const result = runSetup(false, { address: '192.168.1.128', pveHost: '' });
    expect(result.status).toBe(0);
    expect(new URL(result.stdout.trim()).hostname).toBe('192.168.1.128');
  });

  it('preserves an explicit PVE_HOST override over the optional address', () => {
    const result = runSetup(false, {
      address: '192.168.1.128',
      pveHost: 'pve.override.example',
    });
    expect(result.status).toBe(0);
    expect(new URL(result.stdout.trim()).hostname).toBe('pve.override.example');
  });

  it('falls back to hostname -f when the default bridge has no IPv4', () => {
    discovery.networks.pve1[0].cidr = '2001:db8::1/64';
    const result = runSetup(false, { pveHost: '' });
    expect(result.status).toBe(0);
    expect(new URL(result.stdout.trim()).hostname).toBe('pve-node.example');
  });

  it('renders valid Bash with no placement inputs', () => {
    const result = spawnSync('bash', ['-n'], { input: block(), encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('discovers all placement values and the default bridge IPv4 with no inputs', () => {
    const result = runSetup(false, { pveHost: '' });
    expect(result.status).toBe(0);
    expect(parseProxmoxConnectionString(result.stdout.trim())).toMatchObject({
      node: 'pve1',
      storage: 'local-lvm',
      imageStorage: 'local',
      bridge: 'vmbr0',
      pool: 'devchain',
      apiUrl: 'https://192.0.2.2:8006',
    });
  });

  it.each([
    [['zeta', 'local-zfs', 'alpha', 'local-lvm'], 'local-lvm'],
    [['zeta', 'local-zfs', 'alpha'], 'local-zfs'],
    [['zeta', 'alpha'], 'alpha'],
  ])('selects VM storage stably from %j', (names, expected) => {
    discovery.vmStorage = [
      ...names.map((storage) => ({ storage, active: 1, avail: 0 })),
      { storage: 'aaa-iscsi', type: 'iscsi', active: 1, select_existing: 1 },
      { storage: 'aaa-offline', active: 0 },
    ];
    const result = runSetup();
    expect(result.status).toBe(0);
    expect(new URL(result.stdout.trim()).searchParams.get('storage')).toBe(expected);
    expect(result.stderr).toContain('0.0 GiB free (information only)');
    expect(result.stderr).toContain(
      'alternatives: ' +
        names
          .filter((name) => name !== expected)
          .sort()
          .join(', '),
    );
  });

  it('prefers local image storage and the gateway bridge regardless of order', () => {
    discovery.imageStorage.unshift({ storage: 'aaa-images', active: 1, type: 'nfs' });
    discovery.networks.pve1.unshift({ iface: 'vmbr1', active: 1 });
    const result = runSetup();
    expect(result.status).toBe(0);
    const url = new URL(result.stdout.trim());
    expect(url.searchParams.get('imageStorage')).toBe('local');
    expect(url.searchParams.get('bridge')).toBe('vmbr0');
    expect(result.stderr).toContain('Image storage: local (alternatives: aaa-images)');
    expect(result.stderr).toContain('Bridge: vmbr0 (alternatives: vmbr1)');
  });

  it('selects image storage by name when local is unavailable', () => {
    discovery.imageStorage = [
      { storage: 'zeta', active: 1, type: 'nfs' },
      { storage: 'local', active: 0, type: 'dir' },
      { storage: 'aaa-block', active: 1, type: 'lvmthin' },
      { storage: 'alpha', active: 1, type: 'btrfs' },
    ];
    writeFileSync(storageConfig, 'btrfs: alpha\n  content images\n');
    const result = runSetup();
    expect(result.status).toBe(0);
    expect(new URL(result.stdout.trim()).searchParams.get('imageStorage')).toBe('alpha');
  });

  function expectNoWrites(result: ReturnType<typeof runSetup>, message: string) {
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(message);
    expect(readFileSync(writesPath, 'utf8')).toBe('');
    expect(readFileSync(storageConfig, 'utf8')).not.toContain('import');
  }

  it.each([
    ['node', 'Node bad', 'pve1'],
    ['storage', 'VM storage bad', 'local-lvm'],
    ['imageStorage', 'Image storage bad', 'local'],
    ['bridge', 'Bridge bad', 'vmbr0'],
  ])('refuses an invalid %s override before any write', (field, message, choices) => {
    const result = runSetup(false, { [field]: 'bad' });
    expectNoWrites(result, message);
    expect(result.stderr).toContain('available: ' + choices);
  });

  it('refuses an iSCSI override with its allocation limitation before any write', () => {
    discovery.vmStorage.push({ storage: 'iscsi', active: 1, select_existing: 1 });
    const result = runSetup(false, { storage: 'iscsi' });
    expectNoWrites(result, 'VM storage iscsi cannot allocate disks (select_existing)');
    expect(result.stderr).toContain('available: local-lvm');
  });

  it.each(['vmStorage', 'imageStorage'] as const)(
    'refuses when %s has no eligible candidates',
    (field) => {
      discovery[field] = [{ storage: 'offline', active: 0, type: 'dir' }];
      expectNoWrites(runSetup(), 'available: none');
    },
  );

  it('refuses discovery when no cluster node is local', () => {
    discovery.nodes = [{ type: 'node', name: 'pve1', local: 0 }];
    expectNoWrites(runSetup(), 'Node <discover> cannot be selected automatically; available: pve1');
  });

  it.each([
    ['malformed JSON', "printf 'not-json'"],
    ['a non-list response', "printf '{}'"],
    ['a failed pvesh command', 'exit 1'],
  ])('refuses %s before any write', (_label, command) => {
    writeFileSync(join(fakeBin, 'pvesh'), '#!/bin/sh\n' + command + '\n');
    expectNoWrites(runSetup(), 'Could not discover /cluster/status');
  });

  it('refuses when no active bridge is available', () => {
    discovery.networks.pve1 = [{ iface: 'vmbr0', active: 0 }, { iface: 'vmbr1' }];
    expectNoWrites(
      runSetup(),
      'Bridge <discover> cannot be selected automatically; available: none',
    );
  });

  it('refuses ambiguous bridges and lists both choices', () => {
    discovery.networks.pve1 = [
      { iface: 'vmbr1', active: 1 },
      { iface: 'vmbr0', active: 1 },
    ];
    expectNoWrites(
      runSetup(),
      'Bridge <discover> cannot be selected automatically; available: vmbr0, vmbr1',
    );
  });

  it('selects the only active bridge without a gateway and ignores a missing active flag', () => {
    discovery.networks.pve1 = [
      { iface: 'vmbr1' },
      { iface: 'vmbr0', active: 1, cidr: '192.0.2.3/24' },
    ];
    const result = runSetup(false, { pveHost: '' });
    expect(result.status).toBe(0);
    expect(new URL(result.stdout.trim()).hostname).toBe('192.0.2.3');
    expect(new URL(result.stdout.trim()).searchParams.get('bridge')).toBe('vmbr0');
  });

  it('accepts an explicit bridge among ambiguous active bridges', () => {
    discovery.networks.pve1 = [
      { iface: 'vmbr1', active: 1 },
      { iface: 'vmbr0', active: 1 },
    ];
    const result = runSetup(false, { bridge: 'vmbr1' });
    expect(result.status).toBe(0);
    expect(new URL(result.stdout.trim()).searchParams.get('bridge')).toBe('vmbr1');
  });

  it('refuses an inactive bridge override before any write', () => {
    discovery.networks.pve1.push({ iface: 'vmbr1' });
    expectNoWrites(runSetup(false, { bridge: 'vmbr1' }), 'available: vmbr0');
  });

  it('uses the executing node default bridge IP when placement is on another node', () => {
    discovery.nodes.push({ type: 'node', name: 'pve2', local: 0 });
    discovery.networks.pve2 = [
      { iface: 'vmbr2', active: 1, gateway: '198.51.100.1', cidr: '198.51.100.2/24' },
    ];
    const result = runSetup(false, { node: 'pve2', pveHost: '' });
    expect(result.status).toBe(0);
    expect(parseProxmoxConnectionString(result.stdout.trim())).toMatchObject({
      node: 'pve2',
      bridge: 'vmbr2',
      apiUrl: 'https://192.0.2.2:8006',
    });
  });

  it('honors valid storage overrides and keeps the default bridge IP with a bridge override', () => {
    discovery.vmStorage.push({ storage: 'other-vm', active: 1 });
    discovery.imageStorage.push({ storage: 'other-images', active: 1, type: 'cifs' });
    discovery.networks.pve1.push({ iface: 'vmbr1', active: 1, cidr: '198.51.100.2/24' });
    writeFileSync(storageConfig, 'cifs: other-images\n  content images\n');
    const result = runSetup(false, {
      storage: 'other-vm',
      imageStorage: 'other-images',
      bridge: 'vmbr1',
      pveHost: '',
    });
    expect(result.status).toBe(0);
    expect(parseProxmoxConnectionString(result.stdout.trim())).toMatchObject({
      storage: 'other-vm',
      imageStorage: 'other-images',
      bridge: 'vmbr1',
      apiUrl: 'https://192.0.2.2:8006',
    });
  });

  it('stops before pool, user, role, ACL and token writes when import setup fails', () => {
    const result = runSetup(false, { failStorage: true });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(readFileSync(writesPath, 'utf8').trim()).toBe(
      'pvesm set local --content iso,vztmpl,backup,import',
    );
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
      pools: [],
      users: [],
      roles: [],
      acls: {},
      token: null,
    });
  });

  it('refuses a missing certificate before any write', () => {
    rmSync(certificatePath);
    expectNoWrites(runSetup(), 'Could not read the Proxmox node certificate');
  });

  it('rejects shell metacharacters in Proxmox resource identifiers', () => {
    expect(() =>
      ProxmoxSetupBlockQuerySchema.parse({
        pool: 'devchain; touch /tmp/pwned',
        storage: 'local-lvm',
        imageStorage: 'local',
        bridge: 'vmbr0',
        node: 'pve1',
      }),
    ).toThrow();
  });

  it('accepts host names and IPs and rejects shell metacharacters in Proxmox address', () => {
    const values = {
      pool: 'devchain',
      storage: 'local-lvm',
      imageStorage: 'local',
      bridge: 'vmbr0',
      node: 'pve1',
    };
    expect(() =>
      ProxmoxSetupBlockQuerySchema.parse({ ...values, address: 'pve.example.test' }),
    ).not.toThrow();
    expect(() =>
      ProxmoxSetupBlockQuerySchema.parse({ ...values, address: '[2001:db8::1]' }),
    ).not.toThrow();
    expect(() =>
      ProxmoxSetupBlockQuerySchema.parse({ ...values, address: '[pve.example.test]' }),
    ).toThrow();
    expect(() =>
      ProxmoxSetupBlockQuerySchema.parse({ ...values, address: '192.168.1.128;touch /tmp/pwned' }),
    ).toThrow();
  });
});

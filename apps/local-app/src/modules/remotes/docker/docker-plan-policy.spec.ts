import { buildRecord } from './docker-handoff';
import { copiedMounts } from './docker-plan-fit';
// Selection/reconnect decisions are pure policy; no engine or HTTP is needed.
import type { DockerScanResult } from '../host/host-docker.dto';
import {
  applyDockerPolicy,
  applyDockerDataPolicy,
  blocksMode,
  dockerReconnect,
  dockerNetworkPolicy,
  dockerNetworkWarnings,
} from './docker-plan-policy';
import type { DockerPlanItem, DockerPlanMount, DockerSelectionItem } from './docker-plan.dto';
import type { ConnectDockerChoice } from '../connect-choices.dto';
const target = (): DockerScanResult => ({
  architecture: 'amd64',
  containers: [],
  volumes: [],
  paths: [],
});
const item = (): DockerPlanItem => ({
  id: 'c',
  kind: 'container',
  name: 'web',
  composeProject: 'app',
  linkedReasons: ['bind:/home/code'],
  defaultSelected: false,
  selectedMode: null,
  choices: [],
  temporary: false,
  images: [{ id: 'img', architecture: 'amd64', size: { bytes: 10, unknown: false } }],
  mounts: [],
  writerGroup: ['c'],
  alsoStops: [],
  blockers: [],
  warnings: [],
  notes: [],
  writableLayer: { bytes: 3, unknown: false },
  targetAction: 'create',
});
const mount = (kind: DockerPlanMount['kind'], source = '/home/data'): DockerPlanMount => ({
  kind,
  source,
  destination: '/data',
  readOnly: false,
  size: { bytes: 1, unknown: false },
  driver: 'local',
});
const apply = (
  a: DockerPlanItem,
  t = target(),
  items?: DockerSelectionItem[],
  remembered?: Record<string, ConnectDockerChoice>,
) =>
  applyDockerPolicy(
    [a],
    { remoteId: 'r', ...(items === undefined ? {} : { items }) },
    t,
    'p',
    '/home',
    '/home/code',
    remembered,
  );

it.each<{
  name: string;
  saved: Record<string, ConnectDockerChoice>;
  selected: boolean;
  mode: DockerPlanItem['selectedMode'];
}>([
  {
    name: 'excluded container',
    saved: { 'container:web': { included: false } },
    selected: false,
    mode: null,
  },
  {
    name: 'valid mode',
    saved: { 'container:web': { included: true, mode: 'without-data' } },
    selected: true,
    mode: 'without-data',
  },
  {
    name: 'unavailable mode',
    saved: { 'container:web': { included: true, mode: 'data-only' } },
    selected: true,
    mode: 'container-and-data',
  },
  {
    name: 'missing mode',
    saved: { 'container:web': { included: true } },
    selected: true,
    mode: 'container-and-data',
  },
  {
    name: 'unknown name',
    saved: { 'container:gone': { included: false } },
    selected: true,
    mode: 'container-and-data',
  },
  {
    name: 'same name with another kind',
    saved: { 'compose-project:web': { included: false } },
    selected: true,
    mode: 'container-and-data',
  },
])('restores Docker defaults: $name', ({ saved, selected, mode }) => {
  const a = item();
  apply(a, target(), undefined, saved);
  expect({ selected: a.defaultSelected, mode: a.selectedMode }).toEqual({ selected, mode });
});

it('uses an explicit Docker selection over remembered defaults', () => {
  const a = item();
  apply(a, target(), [], { 'container:web': { included: true, mode: 'without-data' } });
  expect(a.selectedMode).toBeNull();
});

it('requires fresh privileged acceptance for a remembered container mode', () => {
  const a = { ...item(), privileged: true };
  apply(a, target(), undefined, { 'container:web': { included: true, mode: 'without-data' } });
  expect(a.selectedMode).toBe('without-data');
  expect(a.blockers.map((blocker) => blocker.code)).toContain('privileged-not-accepted');
});

it.each([
  {
    name: 'safe missing network',
    vmSubnets: undefined,
    routes: [],
    overlap: undefined,
    warning: undefined,
  },
  {
    name: 'missing network overlaps Docker',
    vmSubnets: ['172.19.128.0/17'],
    routes: [],
    overlap: 'vm-other',
    warning: 'network-automatic-range',
  },
  {
    name: 'missing network overlaps on-link route',
    vmSubnets: undefined,
    routes: ['172.19.0.0/24'],
    overlap: '172.19.0.0/24',
    warning: 'network-automatic-range',
  },
  {
    name: 'reused different range',
    vmSubnets: ['172.20.0.0/16'],
    reused: true,
    routes: [],
    warning: 'network-range-differs',
  },
  {
    name: 'reused different range for Compose-kept container',
    vmSubnets: ['172.20.0.0/16'],
    reused: true,
    kept: 'compose',
    routes: [],
    warning: 'network-range-differs',
  },
  {
    name: 'reused different range for keep-vm choice',
    vmSubnets: ['172.20.0.0/16'],
    reused: true,
    kept: 'keep-vm',
    routes: [],
    warning: 'network-range-differs',
  },
  {
    name: 'reused different range whose home range another VM network holds',
    vmSubnets: ['172.20.0.0/16'],
    reused: true,
    taken: ['172.19.0.0/16'],
    routes: [],
    overlap: 'vm-other',
    warning: 'network-range-differs',
  },
  {
    name: 'reused different range whose home range overlaps an on-link route',
    vmSubnets: ['172.20.0.0/16'],
    reused: true,
    routes: ['172.20.0.0/16', '172.19.0.0/24'],
    overlap: '172.19.0.0/24',
    warning: 'network-range-differs',
  },
  {
    name: 'reused overlapping range with only its own route',
    vmSubnets: ['172.19.0.0/24'],
    reused: true,
    routes: ['172.19.0.0/24'],
    warning: 'network-range-differs',
  },
  {
    name: 'reused same range',
    vmSubnets: ['172.19.0.0/16'],
    reused: true,
    routes: [],
    warning: undefined,
  },
  {
    name: 'reused one shared subnet',
    vmSubnets: ['172.20.0.0/16', '172.19.0.0/16'],
    reused: true,
    routes: [],
    warning: undefined,
  },
  {
    name: 'fixed address overlaps on-link route',
    vmSubnets: undefined,
    routes: ['172.19.0.0/24'],
    fixed: true,
    warning: undefined,
  },
])(
  'plans network ranges: $name',
  ({ vmSubnets, routes, overlap, warning, reused, kept, fixed, taken }) => {
    const a = item();
    a.networks = [{ name: 'shared-network', subnets: ['172.19.0.0/16'] }];
    if (fixed)
      a.fixedIPv4 = [
        { network: 'shared-network', address: '172.19.0.200', subnets: ['172.19.0.0/16'] },
      ];
    const t = target();
    t.routes = routes;
    t.networks = vmSubnets
      ? [{ name: reused ? 'shared-network' : 'vm-other', subnets: vmSubnets }]
      : [];
    if (taken) t.networks.push({ name: 'vm-other', subnets: taken });
    if (kept) {
      t.containers = [
        {
          id: 'vm-web',
          name: 'web',
          labels:
            kept === 'compose'
              ? { 'com.docker.compose.project': 'app' }
              : { 'dev.devchain.project': 'p' },
          mounts: [],
        },
      ];
      if (kept === 'compose')
        t.volumes = [
          {
            name: 'app_data',
            driver: 'local',
            labels: { 'dev.devchain.project': 'p', 'com.docker.compose.project': 'app' },
          },
        ];
    }
    apply(a, t);
    if (kept === 'keep-vm')
      applyDockerDataPolicy(
        [a],
        [{ itemIds: [a.id], volumes: [], bindPaths: [], state: 'vm-newer' }],
        { remoteId: 'r' },
        t,
      );
    if (kept) expect(a.targetAction).toBe('leave-as-is');
    // Multiple selected containers can refer to one network; its warning is emitted once.
    const b = { ...a, id: 'second' };
    const networks = dockerNetworkPolicy([a, b], t);
    const warnings = dockerNetworkWarnings(networks);
    if (fixed) {
      expect(a.blockers).toEqual([
        {
          code: 'fixed-ipv4-unavailable',
          message: expect.stringContaining('VM on-link route 172.19.0.0/24'),
        },
      ]);
      expect(a.choices).toEqual(['data-only']);
    } else {
      expect(networks).toEqual([
        {
          name: 'shared-network',
          subnets: ['172.19.0.0/16'],
          ...(reused
            ? {
                kind: 'reused',
                vmSubnets,
                differs: Boolean(warning),
                ...(overlap ? { overlaps: overlap } : {}),
              }
            : overlap
              ? { kind: 'automatic-range', overlaps: overlap }
              : { kind: 'home-range' }),
        },
      ]);
    }
    expect(warnings).toEqual(warning ? [{ code: warning, message: expect.any(String) }] : []);
    if (warning) {
      expect(warnings[0].message).toContain('shared-network');
      expect(warnings[0].message).toContain('172.19.0.0/16');
      expect(warnings[0].message).toContain(overlap ?? vmSubnets![0]);
      if (reused)
        expect(warnings[0].message).toBe(
          `VM network shared-network uses ${vmSubnets!.join(', ')}, not the home range 172.19.0.0/16. ${
            overlap
              ? `The home range overlaps ${overlap} on the VM, so removing the VM network would not restore it. Keep the VM range, or free the home range on the VM first.`
              : 'Remove the VM network when no container uses it, then connect again.'
          }`,
        );
    }
  },
);
it.each<[string, string, boolean]>([
  ['10.0.0.0/24', '10.0.0.255', true],
  ['10.0.0.0/24', '10.0.1.0', false],
  ['0.0.0.0/0', '255.255.255.255', true],
  ['172.19.0.200/32', '172.19.0.200', true],
  ['172.19.0.200/32', '172.19.0.201', false],
  ['172.19.0.0/33', '172.19.0.200', false],
  ['fd00::/64', '172.19.0.200', false],
])('checks IPv4 containment at CIDR boundaries (%s, %s)', (subnet, address, allowed) => {
  const a = item();
  a.fixedIPv4 = [{ network: 'fixed', address, subnets: [] }];
  const t = target();
  t.networks = [{ name: 'fixed', subnets: [subnet] }];
  apply(a, t);
  expect(a.blockers.some((b) => b.code === 'fixed-ipv4-unavailable')).toBe(!allowed);
});

it.each<[string, string, boolean]>([
  ['172.19.0.0/16', '172.19.128.0/17', true],
  ['172.19.128.0/17', '172.19.0.0/16', true],
  ['172.19.0.0/17', '172.19.128.0/17', false],
])('checks overlap in both directions (%s, %s)', (home, remote, overlaps) => {
  const a = item();
  a.fixedIPv4 = [{ network: 'missing', address: '172.19.0.200', subnets: [home] }];
  const t = target();
  t.networks = [{ name: 'existing', subnets: [remote] }];
  apply(a, t);
  expect(a.blockers.some((b) => b.code === 'fixed-ipv4-unavailable')).toBe(overlaps);
});

it.each(['outside-range', 'used-address', 'overlap'])(
  'explains a fixed IPv4 refusal for %s and permits data-only',
  (reason) => {
    const a = item();
    a.fixedIPv4 = [
      { network: 'shared-network', address: '172.19.0.200', subnets: ['172.19.0.0/16'] },
    ];
    const t = target();
    t.networks = [{ name: 'shared-network', subnets: ['172.19.0.0/16'], addresses: [] }];
    if (reason === 'outside-range') t.networks[0].subnets = ['172.20.0.0/16'];
    if (reason === 'used-address')
      t.networks[0].addresses = [
        { address: '172.19.0.200', containerId: 'unrelated-id', containerName: 'other-project' },
      ];
    if (reason === 'overlap') t.networks = [{ name: 'vm-bridge', subnets: ['172.19.128.0/17'] }];
    apply(a, t);
    expect(a.blockers).toEqual([{ code: 'fixed-ipv4-unavailable', message: expect.any(String) }]);
    const message = a.blockers[0].message;
    for (const text of ['web', 'shared-network', '172.19.0.200', 'on the PC'])
      expect(message).toContain(text);
    if (reason === 'outside-range') expect(message).toContain('when no container uses it');
    if (reason === 'used-address') expect(message).toContain('other-project');
    if (reason === 'overlap') expect(message).toContain('vm-bridge');
    expect(a.choices).toEqual(['data-only']);
    expect(a.defaultSelected).toBe(false);
    expect(blocksMode('container-and-data', 'fixed-ipv4-unavailable')).toBe(true);
    expect(blocksMode('without-data', 'fixed-ipv4-unavailable')).toBe(true);
    expect(blocksMode('data-only', 'fixed-ipv4-unavailable')).toBe(false);
  },
);

it('counts a same-name address holder when the project cannot replace or keep it', () => {
  const a = item();
  a.fixedIPv4 = [{ network: 'fixed', address: '172.19.0.200', subnets: ['172.19.0.0/16'] }];
  const t = target();
  t.containers = [{ id: 'unowned', name: 'web', labels: {}, mounts: [] }];
  t.networks = [
    {
      name: 'fixed',
      subnets: ['172.19.0.0/16'],
      addresses: [{ address: '172.19.0.200', containerId: 'unowned', containerName: 'web' }],
    },
  ];
  apply(a, t);
  expect(a.blockers).toContainEqual({
    code: 'fixed-ipv4-unavailable',
    message: expect.stringContaining('VM container web uses that address'),
  });
});

it('keeps data-only available when IPv4 and runtime blockers coexist', () => {
  const a = item();
  a.blockers = [{ code: 'runtime-bound', message: 'device' }];
  a.fixedIPv4 = [{ network: 'fixed', address: '172.19.0.200', subnets: [] }];
  const t = target();
  t.networks = [{ name: 'fixed', subnets: ['172.20.0.0/16'] }];
  apply(a, t);
  expect(a.choices).toEqual(['data-only']);
});

it('defaults linked containers on, other containers off, honors explicit empty selection', () => {
  const a = item();
  apply(a);
  expect(a.selectedMode).toBe('container-and-data');
  const b = item();
  b.linkedReasons = [];
  apply(b);
  expect(b.selectedMode).toBeNull();
  const c = item();
  apply(c, target(), []);
  expect(c.selectedMode).toBeNull();
});
describe('privileged acceptance', () => {
  const blocker = {
    code: 'privileged-not-accepted',
    message: 'Accept Run privileged for this container, or pick Copy its data only.',
  };
  it.each(['container-and-data', 'without-data'] as const)(
    'gates %s without hiding the container or data-only choices',
    (mode) => {
      for (const accepted of [false, true]) {
        const a = { ...item(), privileged: true };
        apply(a, target(), [{ id: a.id, mode, ...(accepted ? { acceptPrivileged: true } : {}) }]);
        expect(a.choices).toEqual(['container-and-data', 'without-data', 'data-only']);
        expect(a.defaultSelected).toBe(true);
        expect(a.selectedMode).toBe(mode);
        expect(a.blockers).toEqual(accepted ? [] : [blocker]);
      }
      expect(blocksMode(mode, blocker.code)).toBe(true);
    },
  );
  it('permits data-only and skips without acceptance', () => {
    for (const items of [[{ id: 'c', mode: 'data-only' as const }], []]) {
      const a = { ...item(), privileged: true };
      apply(a, target(), items);
      expect(a.blockers).toEqual([]);
    }
    expect(blocksMode('data-only', blocker.code)).toBe(false);
    const unrelated = { ...item(), privileged: true, linkedReasons: [] };
    apply(unrelated);
    expect(unrelated.selectedMode).toBeNull();
    expect(unrelated.blockers).toEqual([]);
  });
  it('keeps runtime-bound and temporary containers data-only without requiring acceptance', () => {
    for (const a of [
      { ...item(), privileged: true, blockers: [{ code: 'runtime-bound', message: 'device' }] },
      { ...item(), privileged: true, temporary: true },
    ]) {
      apply(a, target(), [{ id: a.id, mode: 'data-only' }]);
      expect(a.choices).toEqual(['data-only']);
      expect(a.blockers.some((b) => b.code === blocker.code)).toBe(false);
    }
  });
  it('offers only without-data when privileged container data cannot move', () => {
    const a = { ...item(), privileged: true, mounts: [mount('external-bind', '/srv/db')] };
    apply(a, target(), [{ id: a.id, mode: 'without-data' }]);
    expect(a.choices).toEqual(['without-data']);
    expect(a.blockers).toContainEqual(blocker);
    expect(a.blockers.some((b) => b.code === 'external-writable-bind')).toBe(true);
  });
  it('requires acceptance even for a Compose counterpart left on the VM', () => {
    const a = { ...item(), privileged: true };
    const t = target();
    t.volumes = [
      {
        name: 'db',
        driver: 'local',
        labels: { 'dev.devchain.project': 'p', 'com.docker.compose.project': 'app' },
      },
    ];
    t.containers = [
      { id: 'vm', name: a.name, labels: { 'com.docker.compose.project': 'app' }, mounts: [] },
    ];
    apply(a, t);
    expect(a.targetAction).toBe('leave-as-is');
    expect(a.blockers).toEqual([blocker]);
  });
});
it('offers without-data for unmovable data and data-only for runtime-bound containers', () => {
  const a = item();
  a.mounts = [mount('external-bind', '/srv/db')];
  apply(a);
  expect(a.choices).toEqual(['without-data']);
  expect(a.defaultSelected).toBe(false);
  const b = item();
  b.blockers = [{ code: 'runtime-bound', message: 'device' }];
  apply(b);
  expect(b.choices).toEqual(['data-only']);
});
it.each(['non-local-volume', 'architecture-mismatch', 'readonly-path-missing', 'bind-destination'])(
  'blocks %s',
  (code) => {
    const a = item();
    if (code === 'non-local-volume') a.mounts = [{ ...mount('named-volume', 'v'), driver: 'nfs' }];
    if (code === 'architecture-mismatch') a.images[0].architecture = 'arm64';
    if (code === 'readonly-path-missing') a.mounts = [mount('readonly-external-bind', '/etc/cert')];
    if (code === 'bind-destination') a.mounts = [mount('project-bind', '/elsewhere/code')];
    apply(a);
    expect(a.blockers.some((b) => b.code === code)).toBe(true);
    expect(a.selectedMode).toBeNull();
  },
);
it('keeps existing external RO paths', () => {
  const a = item();
  a.mounts = [mount('readonly-external-bind', '/etc/cert')];
  const t = target();
  t.paths = [{ path: '/etc/cert', exists: true }];
  apply(a, t);
  expect(a.blockers).toEqual([]);
});
// Record construction is pure; only copied images can supply the archive helper fallback.
it('chooses a copied image when a data-only item has no image of its own', () => {
  const kept = {
    ...item(),
    buildsFromProject: true,
    selectedMode: 'container-and-data' as const,
    dataAction: 'keep-vm' as const,
    targetAction: 'leave-as-is' as const,
  };
  const available = {
    ...item(),
    id: 'available',
    selectedMode: 'container-and-data' as const,
    images: [{ id: 'copied', architecture: 'amd64', size: { bytes: 10, unknown: false } }],
  };
  const data = {
    ...item(),
    id: 'data',
    selectedMode: 'data-only' as const,
    targetAction: 'data-only' as const,
    images: [],
    mounts: [mount('named-volume', 'db')],
  };
  const items = [kept, available, data];
  const record = buildRecord(items, items, '1.47', '/home/code');
  expect(record.volumes).toEqual([{ name: 'db', helperImage: 'copied', sizeBytes: 1 }]);
});

it('temporary containers stay unchecked and permit only named-volume data', () => {
  const a = item();
  a.temporary = true;
  a.mounts = [mount('external-bind', '/srv/tmp')];
  apply(a);
  expect(a.choices).toEqual(['data-only']);
  expect(a.selectedMode).toBeNull();
  expect(a.targetAction).toBe('data-only');
});
it('reports unowned conflicts and unrelated volume holders without offering replacement', () => {
  const a = item();
  a.mounts = [mount('named-volume', 'db')];
  const t = target();
  t.volumes = [{ name: 'db', driver: 'local', labels: {} }];
  t.containers = [
    {
      id: 'other',
      name: 'web',
      labels: {},
      mounts: [{ type: 'volume', name: 'db', destination: '/data' }],
    },
  ];
  apply(a, t);
  expect(a.targetAction).toBe('conflict');
  expect(a.blockers.map((b) => b.code)).toEqual(
    expect.arrayContaining(['container-conflict', 'volume-conflict', 'unrelated-holder']),
  );
});
// Pure policy verifies attribution and replacement without Docker or transport mocks.
it.each([
  {
    name: 'hand-made volume holder',
    data: 'volume',
    workingDir: '/home/code',
    vmMount: true,
    action: 'replace',
  },
  {
    name: 'config file inside root',
    data: 'volume',
    configFiles: '/etc/other.yml,/home/code/compose.yml',
    vmMount: true,
    action: 'replace',
  },
  { name: 'code-only counterpart', data: 'code', workingDir: '/home/code', action: 'leave-as-is' },
  {
    name: 'bind-only explicit replacement',
    data: 'bind',
    workingDir: '/home/code',
    vmMount: true,
    action: 'replace',
  },
  {
    name: 'stateless VM and stateful home',
    data: 'volume',
    workingDir: '/home/code',
    action: 'replace',
  },
  {
    name: 'working dir outside root',
    data: 'volume',
    workingDir: '/elsewhere',
    vmMount: true,
    action: 'conflict',
  },
  {
    name: 'working dir with shared prefix',
    data: 'volume',
    workingDir: '/home/code-other',
    vmMount: true,
    action: 'conflict',
  },
  { name: 'missing path labels', data: 'volume', vmMount: true, action: 'conflict' },
  {
    name: 'relative config file',
    data: 'volume',
    configFiles: 'compose.yml',
    vmMount: true,
    action: 'conflict',
  },
  {
    name: 'another project owner',
    data: 'volume',
    workingDir: '/home/code',
    owner: 'other',
    vmMount: true,
    action: 'conflict',
  },
  {
    name: 'another owner on a Compose-labelled imported volume',
    data: 'volume',
    workingDir: '/home/code',
    owner: 'other',
    vmMount: true,
    importedCompose: true,
    action: 'conflict',
  },
  { name: 'stateless DevChain counterpart', data: 'code', owner: 'p', action: 'replace' },
])(
  'plans the $name with $action',
  ({ data, workingDir, configFiles, owner, vmMount, importedCompose, action }) => {
    const a = item();
    a.mounts = [
      data === 'volume'
        ? mount('named-volume', 'handmade')
        : mount(data === 'bind' ? 'project-bind' : 'project-code', '/home/code/state'),
    ];
    const t = target();
    if (data === 'volume')
      t.volumes = [
        {
          name: 'handmade',
          driver: 'local',
          labels: {
            'dev.devchain.project': 'p',
            ...(importedCompose ? { 'com.docker.compose.project': 'app' } : {}),
          },
        },
      ];
    t.containers = [
      {
        id: 'vm',
        name: a.name,
        labels: {
          'com.docker.compose.project': 'app',
          ...(workingDir ? { 'com.docker.compose.project.working_dir': workingDir } : {}),
          ...(configFiles ? { 'com.docker.compose.project.config_files': configFiles } : {}),
          ...(owner ? { 'dev.devchain.project': owner } : {}),
        },
        mounts: !vmMount
          ? []
          : [
              data === 'volume'
                ? { type: 'volume', name: 'handmade', destination: '/data' }
                : { type: 'bind', source: '/home/code/state', destination: '/data' },
            ],
      },
    ];
    const selections: DockerSelectionItem[] = [
      { id: a.id, mode: 'container-and-data', dataChoice: 'replace-home' },
    ];
    apply(a, t, selections);
    expect(a.targetAction).toBe(action);
    if (action === 'conflict') {
      expect(a.blockers.map((blocker) => blocker.code)).toEqual(
        expect.arrayContaining(['container-conflict', 'unrelated-holder']),
      );
    } else expect(a.blockers).toEqual([]);
    if (data === 'bind') {
      const group = {
        itemIds: [a.id],
        volumes: [],
        bindPaths: ['/home/code/state'],
        state: 'vm-newer' as const,
      };
      applyDockerDataPolicy([a], [group], { remoteId: 'r', items: selections }, t);
      expect(a.targetAction).toBe('replace');
      expect(buildRecord([a], [a], '1.47', '/home/code').binds.map((bind) => bind.path)).toEqual([
        '/home/code/state',
      ]);
    }
  },
);

it('replaces owned Compose holders but leaves imported stateless Compose containers alone', () => {
  const t = target();
  t.volumes = [
    {
      name: 'db',
      driver: 'local',
      labels: { 'dev.devchain.project': 'p', 'com.docker.compose.project': 'app' },
    },
  ];
  t.containers = [
    { id: 'vm', name: 'web', labels: { 'com.docker.compose.project': 'app' }, mounts: [] },
  ];
  const a = item();
  apply(a, t);
  expect(a.targetAction).toBe('leave-as-is');
  const statefulHome = item();
  statefulHome.mounts = [mount('named-volume', 'db')];
  apply(statefulHome, t);
  expect(statefulHome.targetAction).toBe('leave-as-is');
  t.containers[0].mounts = [{ type: 'volume', name: 'db', destination: '/data' }];
  const b = item();
  apply(b, t);
  expect(b.targetAction).toBe('replace');
});
it('reconnect retains the import date and warns replacement loses uncopied VM changes', () => {
  const a = item();
  apply(a);
  expect(
    dockerReconnect(
      [a],
      {
        importedAt: '2026-01-01T00:00:00Z',
        items: [{ name: 'web', imageId: 'img', volumes: [], bindPaths: [], sizeBytes: 0 }],
      },
      '/home/code',
    ),
  ).toMatchObject({
    importedAt: '2026-01-01T00:00:00Z',
    replacing: ['web'],
    lossNotice: expect.stringContaining('Cancel cannot recover'),
  });
});
it('refuses client modes or ids that do not match the fresh scan', () => {
  expect(() => apply(item(), target(), [{ id: 'not-scanned', mode: 'data-only' }])).toThrow(
    'unknown',
  );
  expect(() => apply(item(), target(), [{ id: 'c', mode: 'data-only' }])).toThrow('Unavailable');
});
it('reconnect matches prior bind data by its project-anchored path', () => {
  const a = item();
  a.name = 'renamed';
  a.mounts = [mount('project-bind', '/home/code/state/db')];
  apply(a);
  expect(
    dockerReconnect(
      [a],
      {
        importedAt: '2026-01-01T00:00:00Z',
        items: [
          { name: 'web', imageId: 'img', volumes: [], bindPaths: ['/state/db'], sizeBytes: 0 },
          { name: 'old', imageId: 'img', volumes: [], bindPaths: ['/state/other'], sizeBytes: 0 },
        ],
      },
      '/home/code',
    )?.replacing,
  ).toEqual(['web']);
});

// Pure policy plus the record projection catches destructive keep plans without engine I/O.
describe('per-group data decisions', () => {
  const setup = () => {
    const a = item();
    a.mounts = [mount('named-volume', 'data'), mount('project-bind', '/home/code/state')];
    const t = target();
    t.volumes = [
      {
        name: 'data',
        driver: 'local',
        labels: {
          'dev.devchain.project': 'p',
        },
      },
    ];
    t.paths = [{ path: '/home/code/state', exists: true }];
    t.containers = [{ id: 'vm', name: 'web', labels: { 'dev.devchain.project': 'p' }, mounts: [] }];
    return { a, t };
  };
  it.each([false, true])(
    'requires privileged acceptance while keeping an owned counterpart (%s)',
    (accepted) => {
      const { a, t } = setup();
      a.privileged = true;
      const items: DockerSelectionItem[] = [
        { id: a.id, mode: 'container-and-data', ...(accepted ? { acceptPrivileged: true } : {}) },
      ];
      apply(a, t, items);
      applyDockerDataPolicy(
        [a],
        [{ itemIds: [a.id], volumes: ['data'], bindPaths: ['/home/code/state'], state: 'in-sync' }],
        { remoteId: 'r', items },
        t,
      );
      expect(a.targetAction).toBe('leave-as-is');
      expect(a.choices).toEqual(['container-and-data', 'data-only']);
      expect(a.blockers.some((b) => b.code === 'privileged-not-accepted')).toBe(!accepted);
    },
  );
  it.each(['in-sync', 'vm-newer', 'home-newer', 'both-changed', 'unknown', 'no-record'] as const)(
    'handles %s without replacing newer VM data by default',
    (state) => {
      const { a, t } = setup();
      apply(a, t);
      applyDockerDataPolicy(
        [a],
        [{ itemIds: [a.id], volumes: ['data'], bindPaths: ['/home/code/state'], state }],
        { remoteId: 'r' },
        t,
      );
      const keep = state === 'in-sync' || state === 'vm-newer';
      expect(a.dataAction).toBe(
        keep ? 'keep-vm' : ['both-changed', 'unknown'].includes(state) ? undefined : 'replace-home',
      );
      expect(a.blockers.some((b) => b.code === 'data-choice-required')).toBe(
        ['both-changed', 'unknown'].includes(state),
      );
      if (keep) {
        expect(a.targetAction).toBe('leave-as-is');
        expect(copiedMounts(a)).toEqual([]);
        const record = buildRecord([a], [a], '1.47', '/home/code');
        expect(record.volumes).toEqual([]);
        expect(record.binds).toEqual([]);
        expect(record.items[0].volumes).toEqual([]);
        expect(record.items[0].binds).toEqual([]);
        expect(record.stopIds).toEqual(['c']);
        expect(record.images).toHaveLength(1);
      }
    },
  );
  it('creates missing containers and resources while preserving surviving data', () => {
    const { a, t } = setup();
    t.containers = [];
    a.mounts.push(mount('named-volume', 'added'));
    apply(a, t);
    applyDockerDataPolicy(
      [a],
      [
        {
          itemIds: [a.id],
          volumes: ['data', 'added'],
          bindPaths: ['/home/code/state'],
          state: 'vm-newer',
        },
      ],
      { remoteId: 'r' },
      t,
    );
    const record = buildRecord([a], [a], '1.47', '/home/code');
    expect(record.items[0].createsContainer).toBe(true);
    expect(record.volumes).toEqual([]);
    expect(record.ensureVolumes).toEqual(['added']);
  });
  it('requires explicit replacement for partly present home-newer groups', () => {
    const { a, t } = setup();
    apply(a, t);
    applyDockerDataPolicy(
      [a],
      [{ itemIds: [a.id], volumes: ['data', 'added'], bindPaths: [], state: 'home-newer' }],
      { remoteId: 'r' },
      t,
    );
    expect(a.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'data-choice-required' })]),
    );
  });
  it('rejects conflicting choices across read-only group members', () => {
    const { a, t } = setup();
    const b = { ...a, id: 'b', name: 'other', blockers: [], choices: [] };
    applyDockerPolicy([a, b], { remoteId: 'r' }, t, 'p', '/home', '/home/code');
    expect(() =>
      applyDockerDataPolicy(
        [a, b],
        [{ itemIds: [a.id, b.id], volumes: ['data'], bindPaths: [], state: 'both-changed' }],
        {
          remoteId: 'r',
          items: [
            { id: a.id, mode: 'container-and-data', dataChoice: 'keep-vm' },
            { id: b.id, mode: 'container-and-data', dataChoice: 'replace-home' },
          ],
        },
        t,
      ),
    ).toThrow(/same data choice/);
  });
  it.each([
    ['no data', undefined, ['container-and-data'], 'container-and-data'],
    ['no VM data', 'no-record', ['container-and-data', 'without-data'], 'without-data'],
    ['VM data', 'in-sync', ['container-and-data'], 'container-and-data'],
    ['changed VM data', 'vm-newer', ['container-and-data'], 'container-and-data'],
    ['unknown VM data', 'unknown', ['container-and-data'], 'container-and-data'],
  ] as const)(
    'offers without-data only for data the VM lacks; a remembered one falls back (%s)',
    (_case, state, choices, mode) => {
      const { a, t } = setup();
      apply(a, t, undefined, { 'container:web': { included: true, mode: 'without-data' } });
      applyDockerDataPolicy(
        [a],
        state ? [{ itemIds: [a.id], volumes: ['data'], bindPaths: [], state }] : [],
        { remoteId: 'r' },
        t,
      );
      expect(a.choices).toEqual(choices);
      expect(a.selectedMode).toBe(mode);
    },
  );
  const sharedPair = (kind: DockerPlanItem['kind']) => {
    const a = item();
    const b: DockerPlanItem = { ...item(), id: 'b', name: 'admin', kind };
    for (const shared of [a, b]) shared.mounts = [mount('named-volume', 'data')];
    return { a, b, group: { itemIds: ['c', 'b'], volumes: ['data'], bindPaths: [] } };
  };
  it.each([
    ['a default container follows it', 'container', 'container-and-data', 'without-data', true],
    ['a member without that mode is unselected', 'compose-project', 'data-only', null, false],
  ] as const)(
    'lets a remembered without-data decide for its shared data group: %s',
    (_case, kind, defaultMode, mode, selected) => {
      const { a, b, group } = sharedPair(kind);
      applyDockerPolicy([a, b], { remoteId: 'r' }, target(), 'p', '/home', '/home/code', {
        'container:web': { included: true, mode: 'without-data' },
      });
      expect(b.selectedMode).toBe(defaultMode);
      applyDockerDataPolicy(
        [a, b],
        [{ ...group, state: 'no-record' }],
        { remoteId: 'r' },
        target(),
      );
      expect(a.selectedMode).toBe('without-data');
      expect({ selected: b.defaultSelected, mode: b.selectedMode }).toEqual({ selected, mode });
    },
  );
  it('still refuses an explicit mix of replacement and without-data in a shared data group', () => {
    const { a, b, group } = sharedPair('container');
    const items: DockerSelectionItem[] = [
      { id: a.id, mode: 'without-data' },
      { id: b.id, mode: 'container-and-data' },
    ];
    applyDockerPolicy([a, b], { remoteId: 'r', items }, target(), 'p', '/home', '/home/code');
    expect(() =>
      applyDockerDataPolicy(
        [a, b],
        [{ ...group, state: 'no-record' }],
        { remoteId: 'r', items },
        target(),
      ),
    ).toThrow(/cannot mix replacement and without-data/);
  });
  it('refuses without-data where the VM holds the data, but keeps it for data that cannot move', () => {
    const { a, t } = setup();
    const items = [{ id: a.id, mode: 'without-data' as const }];
    apply(a, t, items);
    expect(() =>
      applyDockerDataPolicy(
        [a],
        [{ itemIds: [a.id], volumes: ['data'], bindPaths: [], state: 'vm-newer' }],
        { remoteId: 'r', items },
        t,
      ),
    ).toThrow(/Unavailable Docker selection mode/);
    const b = item();
    b.mounts = [mount('external-bind', '/srv/db')];
    apply(b);
    applyDockerDataPolicy([b], [], { remoteId: 'r' }, target());
    expect(b.choices).toEqual(['without-data']);
  });
  it('keeps ownership conflicts as refusals', () => {
    const { a, t } = setup();
    t.volumes[0].labels = {};
    apply(a, t);
    applyDockerDataPolicy(
      [a],
      [{ itemIds: [a.id], volumes: ['data'], bindPaths: [], state: 'vm-newer' }],
      { remoteId: 'r' },
      t,
    );
    expect(a.blockers.some((b) => b.code === 'volume-conflict')).toBe(true);
  });
  it('names only replaced groups in the loss notice', () => {
    const { a, t } = setup();
    apply(a, t);
    a.dataAction = 'keep-vm';
    const b = {
      ...a,
      id: 'b',
      name: 'replace',
      dataAction: 'replace-home' as const,
      mounts: [mount('named-volume', 'other')],
    };
    const inventory = {
      importedAt: '2026-09-01T00:00:00.000Z',
      items: [a, b].map((i) => ({
        name: i.name,
        imageId: 'img',
        volumes: [{ name: i.mounts[0].source, sizeBytes: 1 }],
        bindPaths: [],
        sizeBytes: 1,
      })),
    };
    expect(dockerReconnect([a, b], inventory, '/home/code')?.replacing).toEqual(['replace']);
  });
});

it('stops the writers of every member of a kept read-only-linked group', () => {
  const a = {
    ...item(),
    id: 'a',
    dataAction: 'keep-vm' as const,
    selectedMode: 'container-and-data' as const,
    dataGroup: ['a', 'b'],
    writerGroup: ['a'],
    mounts: [{ ...mount('named-volume', 'shared'), readOnly: true }],
  };
  const b = {
    ...item(),
    id: 'b',
    writerGroup: ['b', 'c'],
    mounts: [
      { ...mount('named-volume', 'shared'), readOnly: true },
      mount('named-volume', 'written'),
    ],
  };
  const c = {
    ...item(),
    id: 'c',
    writerGroup: ['b', 'c'],
    mounts: [mount('named-volume', 'written')],
  };
  const record = buildRecord([a, b, c], [a], '1.47', '/home/code');
  expect(record.volumes).toEqual([]);
  expect(record.stopIds.sort()).toEqual(['a', 'b', 'c']);
});

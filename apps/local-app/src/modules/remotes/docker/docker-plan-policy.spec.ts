import { buildRecord } from './docker-handoff';
import { copiedMounts } from './docker-plan-fit';
// Selection/reconnect decisions are pure policy; no engine or HTTP is needed.
import type { DockerScanResult } from '../host/host-docker.dto';
import { applyDockerPolicy, applyDockerDataPolicy, dockerReconnect } from './docker-plan-policy';
import type { DockerPlanItem, DockerPlanMount } from './docker-plan.dto';
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
  items?: Array<{ id: string; mode: 'container-and-data' | 'without-data' | 'data-only' }>,
) =>
  applyDockerPolicy(
    [a],
    { remoteId: 'r', ...(items === undefined ? {} : { items }) },
    t,
    'p',
    '/home',
    2000,
    1000,
  );
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
it('keeps existing external RO paths and warns on home uid mismatch', () => {
  const a = item();
  a.mounts = [mount('readonly-external-bind', '/etc/cert')];
  a.warnings = [{ code: 'home-uid', message: '' }];
  const t = target();
  t.paths = [{ path: '/etc/cert', exists: true }];
  apply(a, t);
  expect(a.blockers).toEqual([]);
  expect(a.warnings[0].message).toContain('1000');
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
    t.volumes = [{ name: 'data', driver: 'local', labels: { 'dev.devchain.project': 'p' } }];
    t.paths = [{ path: '/home/code/state', exists: true }];
    t.containers = [{ id: 'vm', name: 'web', labels: { 'dev.devchain.project': 'p' }, mounts: [] }];
    return { a, t };
  };
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
    applyDockerPolicy([a, b], { remoteId: 'r' }, t, 'p', '/home', 1000, 1000);
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

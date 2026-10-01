// Pure unit tests are sufficient for the metadata decision table and transitive grouping.
import { checkDockerDataGroup, groupDockerData, type DockerDataHolder } from './docker-data-groups';
import type { DockerDataGroup, DockerPlanItem } from './docker-plan.dto';
import type { DockerDataGroupRecord } from '../operations/docker-import-inventory.store';
import type { DockerScanResult } from '../host/host-docker.dto';

const old = '2026-09-20T00:00:00.000Z';
const baseline = '2026-09-21T00:00:00.000Z';
const recent = '2026-09-22T00:00:00.000Z';
const group: DockerDataGroup = { itemIds: ['db'], volumes: ['data'], bindPaths: [] };
const record: DockerDataGroupRecord = {
  ...group,
  lastSyncedAt: baseline,
  lastSyncDirection: 'to-vm',
};
const metadata = { created: old, startedAt: old, running: false };
const home = (change = false): DockerDataHolder[] => [
  { volumes: ['data'], bindPaths: [], metadata: { ...metadata, startedAt: change ? recent : old } },
];
const vm = (change = false): DockerScanResult => ({
  architecture: 'amd64',
  paths: [],
  volumes: [{ name: 'data', driver: 'local', labels: { 'dev.devchain.project': 'p' } }],
  containers: [
    {
      id: 'vm-db',
      name: 'db',
      labels: {},
      mounts: [{ type: 'volume', name: 'data', destination: '/data' }],
      metadata: { ...metadata, startedAt: change ? recent : old },
    },
  ],
});

it.each([
  [false, false, 'in-sync'],
  [false, true, 'vm-newer'],
  [true, false, 'home-newer'],
  [true, true, 'both-changed'],
])('home changed=%s VM changed=%s gives %s', (h, v, expected) => {
  expect(checkDockerDataGroup(group, [record], home(Boolean(h)), vm(Boolean(v)), 'p').state).toBe(
    expected,
  );
});
it('does not use the shared import time for old records', () => {
  expect(checkDockerDataGroup(group, [], home(), vm(), 'p').state).toBe('unknown');
});
it('returns no-record only when all resources are absent', () => {
  expect(checkDockerDataGroup(group, [record], home(), { ...vm(), volumes: [] }, 'p').state).toBe(
    'no-record',
  );
  expect(
    checkDockerDataGroup({ ...group, volumes: ['data', 'added'] }, [record], home(), vm(true), 'p')
      .state,
  ).toBe('vm-newer');
});
it('retains the surviving bind state across changed membership', () => {
  const g = { itemIds: ['db'], volumes: [], bindPaths: ['/home/state', '/home/added'] };
  const r = { ...record, volumes: [], bindPaths: ['/home/state'] };
  const target = {
    ...vm(),
    volumes: [],
    containers: [],
    paths: [
      { path: '/home/state', exists: true },
      { path: '/home/added', exists: false },
    ],
  };
  expect(checkDockerDataGroup(g, [r], [], target, 'p').state).toBe('in-sync');
});
it('counts running holders, new containers, missing metadata and unavailable engines as changed', () => {
  const target = vm();
  target.containers[0].metadata = { ...metadata, running: true };
  expect(checkDockerDataGroup(group, [record], home(), target, 'p').state).toBe('vm-newer');
  target.containers[0].metadata = { ...metadata, created: recent };
  expect(checkDockerDataGroup(group, [record], home(), target, 'p').state).toBe('vm-newer');
  delete target.containers[0].metadata;
  expect(checkDockerDataGroup(group, [record], home(), target, 'p').state).toBe('vm-newer');
  expect(checkDockerDataGroup(group, [record], null, vm(), 'p').state).toBe('home-newer');
  expect(checkDockerDataGroup(group, [record], home(), null, 'p').state).toBe('vm-newer');
});
it('uses independent discarded baselines', () => {
  expect(
    checkDockerDataGroup(group, [{ ...record, vmDiscardedAt: recent }], home(true), vm(true), 'p')
      .state,
  ).toBe('home-newer');
  expect(
    checkDockerDataGroup(group, [{ ...record, homeDiscardedAt: recent }], home(true), vm(true), 'p')
      .state,
  ).toBe('vm-newer');
});
it('does not mistake ownership conflicts or unknown presence for a safe absence', () => {
  const target = vm();
  target.volumes[0].labels = {};
  expect(checkDockerDataGroup(group, [record], home(), target, 'p').state).toBe('vm-newer');
  const g = { ...group, volumes: [], bindPaths: ['/home/state'] };
  expect(
    checkDockerDataGroup(
      g,
      [{ ...record, ...g }],
      [],
      { ...vm(), paths: [{ path: '/home/state', unknown: true }] },
      'p',
    ).state,
  ).toBe('vm-newer');
});
it('groups read-only shares transitively while excluding the project-root bind', () => {
  const mount = (source: string, kind = 'named-volume') => ({
    source,
    kind,
    readOnly: true,
    destination: '/data',
    size: { bytes: 0, unknown: false },
  });
  const items = [
    { id: 'a', mounts: [mount('data')] },
    { id: 'b', mounts: [mount('data'), mount('/home/project/state', 'project-bind')] },
    { id: 'c', mounts: [mount('/home/project/state/nested', 'project-bind')] },
    { id: 'code', mounts: [mount('/home/project', 'project-bind')] },
  ] as DockerPlanItem[];
  expect(groupDockerData(items, '/home/project')).toEqual([
    {
      itemIds: ['a', 'b', 'c'],
      volumes: ['data'],
      bindPaths: ['/home/project/state', '/home/project/state/nested'],
    },
  ]);
});

it('acknowledges only the explicitly discarded subgroup after membership splits', () => {
  const oldGroup = { ...record, volumes: ['data', 'other'] };
  const discarded = { volumes: ['data'], bindPaths: [], homeDiscardedAt: recent };
  expect(checkDockerDataGroup(group, [oldGroup, discarded], home(true), vm(true), 'p').state).toBe(
    'vm-newer',
  );
  const other = { ...group, volumes: ['other'] };
  const target = vm();
  target.volumes[0].name = 'other';
  target.containers[0].mounts[0].name = 'other';
  expect(
    checkDockerDataGroup(
      other,
      [oldGroup, discarded],
      [{ ...home(true)[0], volumes: ['other'] }],
      target,
      'p',
    ).state,
  ).toBe('home-newer');
});

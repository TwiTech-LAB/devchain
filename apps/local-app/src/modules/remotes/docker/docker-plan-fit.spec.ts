// Pure policy tests are sufficient for destination grouping and arithmetic.
import {
  planDockerFit,
  estimateDockerPlan,
  DOCKER_LOAD_MARGIN_BYTES,
  uniqueCopiedMounts,
  writerStops,
} from './docker-plan-fit';
import type { DockerPlanItem, DockerPlanMount } from './docker-plan.dto';
const ROOT = '/home/project';
const mount = (
  source: string,
  bytes: number,
  kind: DockerPlanMount['kind'] = 'project-bind',
): DockerPlanMount => ({
  kind,
  source,
  destination: '/data',
  readOnly: false,
  size: { bytes, unknown: false },
});
const item = (mounts: DockerPlanMount[] = []): DockerPlanItem => ({
  id: 'c',
  kind: 'container',
  name: 'c',
  composeProject: null,
  linkedReasons: [],
  defaultSelected: true,
  selectedMode: 'container-and-data',
  choices: ['container-and-data'],
  temporary: false,
  images: [],
  mounts,
  writerGroup: ['c'],
  alsoStops: [],
  blockers: [],
  warnings: [],
  notes: [],
  writableLayer: { bytes: 0, unknown: false },
  targetAction: 'create',
});
const sample = (path: string, filesystemId: string, freeBytes = 1000) => ({
  path,
  filesystemId,
  freeBytes,
});
it('groups target filesystem IDs while keeping nested mounts separate; refuses >100% and warns >80%', () => {
  const result = planDockerFit(
    [
      item([
        mount('v', 500, 'named-volume'),
        mount('/home/code', 350),
        mount('/home/nested', 1001),
      ]),
    ],
    [],
    {
      dockerRoot: sample('/docker', 'a'),
      imageStore: null,
      binds: [sample('/home/code', 'a'), sample('/home/nested', 'b')],
    },
    ROOT,
  );
  expect(result.filesystems).toEqual([
    expect.objectContaining({ filesystemId: 'a', requiredBytes: 850, status: 'warning' }),
    expect.objectContaining({ filesystemId: 'b', requiredBytes: 1001, status: 'refused' }),
  ]);
  expect(result.fit).toBe('refused');
});
it('deduplicates volume and overlapping bind coverage across selected items', () => {
  const first = item([mount('/home/data', 50), mount('shared', 20, 'named-volume')]);
  const second = item([mount('/home/data/sub', 30), mount('shared', 20, 'named-volume')]);
  expect(uniqueCopiedMounts([first, second], ROOT).map((m) => m.source)).toEqual([
    '/home/data',
    'shared',
  ]);
});
it('cached images cost zero; uncached images reserve the largest load plus margin once', () => {
  const a = item();
  a.images = [
    { id: 'cached', architecture: 'amd64', size: { bytes: 900, unknown: false } },
    { id: 'new', architecture: 'amd64', size: { bytes: 100, unknown: false } },
  ];
  const result = planDockerFit(
    [a, a],
    ['cached'],
    {
      dockerRoot: null,
      imageStore: sample('/images', 'a', 1e9),
      binds: [],
    },
    ROOT,
  );
  expect(result.bytes).toBe(100);
  expect(result.filesystems[0]).toMatchObject({
    requiredBytes: 200 + DOCKER_LOAD_MARGIN_BYTES,
    headroomBytes: 100 + DOCKER_LOAD_MARGIN_BYTES,
    status: 'fits',
  });
});
it('unknown data and unknown capacity never report a definitive fit; lower bounds still refuse', () => {
  const a = item([mount('/data', 99)]);
  a.mounts[0].size.unknown = true;
  expect(
    planDockerFit(
      [a],
      [],
      {
        dockerRoot: null,
        imageStore: null,
        binds: [sample('/data', 'x', 100)],
      },
      ROOT,
    ).fit,
  ).toBe('unknown');
  expect(
    planDockerFit(
      [a],
      [],
      {
        dockerRoot: null,
        imageStore: null,
        binds: [sample('/data', 'x', 98)],
      },
      ROOT,
    ).fit,
  ).toBe('refused');
  expect(
    planDockerFit(
      [a],
      [],
      {
        dockerRoot: null,
        imageStore: null,
        binds: [{ path: '/data', unknown: true }],
      },
      ROOT,
    ).fit,
  ).toBe('unknown');
});
it('counts helper images and only named volumes for temporary containers', () => {
  const a = item([
    mount('named', 10, 'named-volume'),
    mount('anonymous', 20, 'anonymous-volume'),
    mount('/bind', 30),
  ]);
  a.temporary = true;
  a.selectedMode = 'data-only';
  a.images = [{ id: 'x', architecture: 'amd64', size: { bytes: 100, unknown: false } }];
  expect(
    planDockerFit(
      [a],
      [],
      { dockerRoot: sample('/docker', 'a'), imageStore: null, binds: [] },
      ROOT,
    ).bytes,
  ).toBe(110);
  a.temporary = false;
  a.kind = 'compose-project';
  a.mounts = [];
  expect(
    planDockerFit(
      [a],
      [],
      { dockerRoot: null, imageStore: sample('/images', 'x', 1e9), binds: [] },
      ROOT,
    ).bytes,
  ).toBe(100);
});
it('estimates overlapping export/transfer with an honest uncalibrated load-tail range', () => {
  const bytes = 16 * 1024 * 1024;
  expect(estimateDockerPlan(bytes, 2, bytes)).toMatchObject({
    minSeconds: 2,
    maxSeconds: 9,
    loadTailKnown: false,
  });
  expect(estimateDockerPlan(bytes, 2, null)).toBeNull();
});

describe('writerStops', () => {
  const containers = new Set(['c', 'db', 'web']);
  const withGroup = (overrides: Partial<DockerPlanItem>, mounts: DockerPlanMount[]) => ({
    ...item(mounts),
    writerGroup: ['c', 'db', 'compose:app', 'web'],
    ...overrides,
  });

  it('stops the containers of the writer group when the item copies data', () => {
    expect(writerStops(withGroup({}, [mount('/home/project/data', 1)]), containers, ROOT)).toEqual([
      'c',
      'db',
      'web',
    ]);
  });

  it('stops nobody when the item copies no data', () => {
    const data = [mount('/home/project/data', 1)];
    expect(
      writerStops(withGroup({ selectedMode: 'without-data' }, data), containers, ROOT),
    ).toEqual([]);
    expect(writerStops(withGroup({ targetAction: 'leave-as-is' }, data), containers, ROOT)).toEqual(
      [],
    );
    expect(writerStops(withGroup({ selectedMode: null }, data), containers, ROOT)).toEqual([]);
    // A bind of the whole project root is code that file sync carries, not copied data.
    expect(writerStops(withGroup({}, [mount(ROOT, 1)]), containers, ROOT)).toEqual([]);
  });
});

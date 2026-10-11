// Pure metadata tests are the cheapest layer for attribution and the foreign-owner veto.
import {
  COMPOSE_PROJECT_LABEL as COMPOSE,
  DOCKER_PROJECT_LABEL as OWNER,
} from '../host/host-docker.dto';
import { projectContainer, projectVolume } from './docker-project-resources';

const root = '/home/user/project';
const imported = [{ labels: { [OWNER]: 'p', [COMPOSE]: 'app' } }];

const cases: Array<{
  name: string;
  labels: Record<string, string>;
  mounts: Array<{ type: string; source?: string }>;
  owned: boolean;
}> = [
  { name: 'DevChain label', labels: { [OWNER]: 'p' }, mounts: [], owned: true },
  {
    name: 'Compose working dir',
    labels: { [COMPOSE]: 'app', [`${COMPOSE}.working_dir`]: root },
    mounts: [],
    owned: true,
  },
  {
    name: 'Compose config',
    labels: { [COMPOSE]: 'app', [`${COMPOSE}.config_files`]: `/etc/other.yml,${root}/compose.yml` },
    mounts: [],
    owned: true,
  },
  {
    name: 'plain bind',
    labels: {},
    mounts: [{ type: 'bind', source: `${root}/data` }],
    owned: true,
  },
  { name: 'imported Compose', labels: { [COMPOSE]: 'app' }, mounts: [], owned: true },
  {
    name: 'shared prefix',
    labels: {},
    mounts: [{ type: 'bind', source: `${root}-other/data` }],
    owned: false,
  },
  {
    name: 'relative Compose path',
    labels: { [COMPOSE]: 'other', [`${COMPOSE}.config_files`]: 'compose.yml' },
    mounts: [],
    owned: false,
  },
  {
    name: 'unrelated holder',
    labels: {},
    mounts: [{ type: 'volume', source: `${root}/data` }],
    owned: false,
  },
];
it.each(cases)('attributes $name and vetoes a foreign owner', ({ labels, mounts, owned }) => {
  const container = { labels, mounts };
  expect(projectContainer(container, root, 'p', imported)).toBe(owned);
  expect(
    projectContainer(
      { ...container, labels: { ...labels, [OWNER]: 'other' } },
      root,
      'p',
      imported,
    ),
  ).toBe(false);
});

it('derives Compose volume association only from recognized containers on the same engine', () => {
  const labels = { [COMPOSE]: 'app' };
  const containers = [{ labels, mounts: [] }];
  expect(projectVolume(labels, containers, root, 'p')).toBe(false);
  expect(projectVolume(labels, containers, root, 'p', imported)).toBe(true);
  expect(projectVolume({ ...labels, [OWNER]: 'other' }, containers, root, 'p', imported)).toBe(
    false,
  );
  expect(
    projectVolume(
      labels,
      [{ labels: { ...labels, [OWNER]: 'other' }, mounts: [] }],
      root,
      'p',
      imported,
    ),
  ).toBe(false);
  expect(projectVolume(labels, [], root, 'p', imported)).toBe(false);
});

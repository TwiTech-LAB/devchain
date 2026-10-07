// Pure comparison tests cover inspect compatibility without an engine or HTTP server.
import fixtures from './__fixtures__/docker-image-inspect.json';
import { dockerImageMetadata, dockerImageMetadataMatches } from './docker-image-metadata';

const metadata = dockerImageMetadata(fixtures.classic.inspect);

it('matches real classic-store and containerd-store inspects of the same image', () => {
  expect(fixtures.classic.inspect.Id).not.toBe(fixtures.containerd.inspect.Id);
  expect(
    dockerImageMetadataMatches(metadata, dockerImageMetadata(fixtures.containerd.inspect)),
  ).toBe(true);
});

it.each([undefined, null, ''] as const)(
  'equates absent optional metadata (%s) with empty fields',
  (empty) => {
    const home = {
      ...metadata,
      Variant: empty,
      Created: empty,
      Config: {
        Cmd: empty === '' ? [] : empty,
        Volumes: empty === '' ? {} : empty,
        Labels: empty === '' ? {} : empty,
        User: empty,
        Healthcheck: empty === '' ? {} : empty,
      },
    };
    const vm = { ...metadata, Variant: '', Created: '0001-01-01T00:00:00Z', Config: {} };
    expect(dockerImageMetadataMatches(home, vm)).toBe(true);
  },
);

it.each([
  ['missing OS', { ...metadata, Os: undefined }],
  ['empty architecture', { ...metadata, Architecture: '' }],
  ['missing config', { ...metadata, Config: undefined }],
  ['null config', { ...metadata, Config: null }],
  ['missing layers', { ...metadata, RootFS: {} }],
  ['malformed layers', { ...metadata, RootFS: { Layers: [null] } }],
  ['malformed config', { ...metadata, Config: { Cmd: [123] } }],
  ['malformed timestamp', { ...metadata, Created: 'yesterday' }],
])('never matches %s, even to itself', (_name, invalid) => {
  expect(dockerImageMetadataMatches(invalid, invalid)).toBe(false);
});

it.each([
  ['array order', { Env: ['A=1', 'B=2'] }, { Env: ['B=2', 'A=1'] }],
  ['empty array element', { Cmd: ['run', ''] }, { Cmd: ['run'] }],
  ['unknown empty map key', { Extension: { enabled: {} } }, { Extension: {} }],
  ['healthcheck', { Healthcheck: { Test: ['CMD', 'true'] } }, { Healthcheck: {} }],
  ['Cmd', { Cmd: ['postgres'] }, { Cmd: ['other'] }],
  ['Env', { Env: ['MODE=home'] }, { Env: ['MODE=other'] }],
  ['volume keys', { Volumes: { '/data': {} } }, { Volumes: { '/other': {} } }],
  ['exposed port keys', { ExposedPorts: { '8080/tcp': {} } }, { ExposedPorts: { '8081/tcp': {} } }],
])('preserves %s', (_name, home, vm) => {
  expect(
    dockerImageMetadataMatches({ ...metadata, Config: home }, { ...metadata, Config: vm }),
  ).toBe(false);
});

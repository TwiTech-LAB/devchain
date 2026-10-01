import { homedir } from 'node:os';
import { startTwoInstances, type TwoInstances } from '../../common/test/two-instance.fixture';
import { BASE_URL_MESSAGE } from './dtos/remote.dto';

async function post(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

// Integration: the routes through the real app, its module wiring and error
// filter; the probe's cases live in remote-probe.integration.spec.ts.
describe('remote probe routes across two instances', () => {
  let instances: TwoInstances;

  beforeAll(async () => {
    instances = await startTwoInstances({ healthIntervalMs: 600_000 });
  }, 60_000);

  afterAll(async () => {
    await instances?.close();
  });

  it('finds the registered DevChain at an address and creates nothing', async () => {
    const remote = await instances.registerRemote('probed');
    const hostUrl = instances.host.url.replace(/^http:/, 'https:');
    const before = await instances.home.storage.listRemotes();

    const result = await post(`${instances.home.url}/api/remotes/probe`, {
      address: hostUrl,
      checkSsh: false,
    });

    expect(result).toEqual({
      status: 200,
      body: expect.objectContaining({
        kind: 'devchain',
        baseUrl: hostUrl,
        versionMatches: true,
        homePathMatches: true,
        remoteId: remote.id,
      }),
    });
    expect((await instances.home.storage.listRemotes()).total).toBe(before.total);
    expect(await instances.home.storage.listRemoteOperations({})).toEqual([]);
  }, 30_000);

  it('answers 400 with the address rule for an invalid address', async () => {
    const result = await post(`${instances.home.url}/api/remotes/probe`, {
      address: 'https://127.0.0.1:4000/path',
    });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ message: BASE_URL_MESSAGE });
  });

  it('reports the PC check', async () => {
    const response = await fetch(`${instances.home.url}/api/remotes/readiness`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      syncthing: { ok: boolean; message: string | null };
      identity: { homePath: string };
      docker: { ok: boolean; message: string | null };
    };
    // The fixture's file sync is a fake that is always available.
    expect(body.syncthing).toMatchObject({ ok: true, message: null });
    expect(body.identity.homePath).toBe(homedir());
    expect(body.docker.ok).toBe(body.docker.message === null);
  });
});

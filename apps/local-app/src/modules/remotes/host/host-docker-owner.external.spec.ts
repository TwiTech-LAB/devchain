// A real engine proves that directory entries set owners (including a reset to
// the VM user) without starting helpers. Uses an already-present image only.
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DockerArchiveJournal } from '../../core/controllers/docker-archive-journal';
import { DockerEngineClient } from '../../core/controllers/docker-engine.client';
import { HostDockerService } from './host-docker.service';

const image = process.env.DOCKER_EMPTY_OWNER_IMAGE ?? 'busybox:1.36';
let available = false;
try {
  execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore' });
  available = true;
} catch {
  // External lane reports its missing prerequisite as a skipped test.
}
const real = available ? it : it.skip;
jest.setTimeout(60_000);

real(
  'sets the exact empty-folder owner and resets it to the VM user through never-started helpers',
  async () => {
    const fixture = await mkdtemp(join(homedir(), '.docker-empty-owner-'));
    const path = join(fixture, `empty-${'é'.repeat(60)}`);
    const uid = process.getuid!();
    const gid = process.getgid!();
    const owner = { uid: uid + 1, gid: gid + 2 };
    const client = await DockerEngineClient.connect();
    const connect = jest.spyOn(DockerEngineClient, 'connect').mockResolvedValue(client);
    const requests = jest.spyOn(client, 'json');
    const service = new HostDockerService(
      new DockerArchiveJournal(join(fixture, 'journal')),
      {} as never,
    );
    try {
      await service.prepareBinds({
        projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        paths: [{ path, replace: false, image, owner }],
      });
      expect(await stat(path)).toMatchObject(owner);
      await service.prepareBinds({
        projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        paths: [{ path, replace: true, image, owner: { uid, gid } }],
      });
      expect(await stat(path)).toMatchObject({ uid, gid });
      expect(
        requests.mock.calls.some(
          ([method, route]) => method === 'POST' && route.endsWith('/start'),
        ),
      ).toBe(false);
      const helpers = requests.mock.calls.filter(
        ([method, route]) => method === 'DELETE' && route.startsWith('/containers/'),
      );
      expect(helpers).toHaveLength(2);
    } finally {
      connect.mockRestore();
      requests.mockRestore();
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

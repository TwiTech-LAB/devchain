import { DockerArchiveJournal, type JournaledDockerHelper } from './docker-archive-journal';
// Only a real engine can verify archive ownership, directory headers and image VOLUME side effects.
// Opt in via Jest's external-integration project; use sudo on hosts requiring socket privileges.
import { mkdtemp, mkdir, writeFile, chmod, chown, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { create, list } from 'tar';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { DockerEngineClient } from './docker-engine.client';
import { projectDockerCreate, type DockerContainerInspect } from './docker-settings';
import { readDockerArchive, writeDockerArchive } from './docker-archive';

jest.setTimeout(60_000);

it('round-trips owners, file/root modes and symlinks without starting helpers or leaking helper volumes', async () => {
  const client = await DockerEngineClient.connect();
  const image = 'postgres:17-alpine';
  // Use a cached service image with VOLUME so anonymous-volume ownership is exercised without a pull.
  await client.json('GET', `/images/${encodeURIComponent(image)}/json`);
  const before = await client.json<{ Volumes: Array<{ Name: string }> | null }>('GET', '/volumes');
  const existing = (before.Volumes ?? []).map((volume) => volume.Name);
  const prefix = `dc-archive-test-${randomUUID()}`;
  const volumes: string[] = [];
  const helpers: JournaledDockerHelper[] = [];
  const owned: string[] = [];
  const root = await mkdtemp(join(tmpdir(), 'dc-archive-test-'));
  const journal = new DockerArchiveJournal(root);
  try {
    await mkdir(join(root, 'data/nested'), { recursive: true });
    await chmod(join(root, 'data'), 0o700);
    await writeFile(join(root, 'data/nested/file'), 'archive marker\n');
    await chmod(join(root, 'data/nested/file'), 0o640);
    await chown(join(root, 'data/nested'), 1234, 2345);
    await chown(join(root, 'data/nested/file'), 1234, 2345);
    await symlink('nested/file', join(root, 'data/link'));
    for (const suffix of ['source', 'target']) {
      const volume = await client.json<{ Name: string }>('POST', '/volumes/create', {
        Name: `${prefix}-${suffix}`,
        Labels: { 'dev.devchain.test': prefix },
      });
      volumes.push(volume.Name);
      const helper = await journal.create(client, image, [
        { Type: 'volume', Source: volume.Name, Target: '/data' },
      ]);
      helpers.push(helper);
      owned.push(...helper.ownedVolumeIds);
      expect(helper.ownedVolumeIds.length).toBeGreaterThan(0);
      const saved = await client.json<DockerContainerInspect>(
        'GET',
        `/containers/${helper.id}/json`,
      );
      const projected = projectDockerCreate(saved);
      expect(projected.Image === saved.Image).toBe(true);
      expect(projected.HostConfig).toMatchObject({ NetworkMode: 'none' });
    }
    await writeDockerArchive(client, helpers[0].id, Readable.from(create({ cwd: root }, ['data'])));
    await writeDockerArchive(client, helpers[1].id, await readDockerArchive(client, helpers[0].id));
    const entries: Record<
      string,
      { uid?: number; gid?: number; mode?: number; linkpath?: string; content: string }
    > = {};
    await pipeline(
      await readDockerArchive(client, helpers[1].id),
      list({
        onReadEntry(entry) {
          const record = {
            uid: entry.uid,
            gid: entry.gid,
            mode: entry.mode,
            linkpath: entry.linkpath,
            content: '',
          };
          entries[entry.path.replace(/\/$/, '')] = record;
          entry.on('data', (chunk) => (record.content += chunk.toString()));
        },
      }),
    );
    expect(entries.data).toMatchObject({ uid: 0, gid: 0, mode: 0o700 });
    expect(entries['data/nested']).toMatchObject({ uid: 1234, gid: 2345 });
    expect(entries['data/nested/file']).toMatchObject({
      uid: 1234,
      gid: 2345,
      mode: 0o640,
      content: 'archive marker\n',
    });
    expect(entries['data/link']).toMatchObject({ linkpath: 'nested/file' });
    for (const helper of helpers) {
      const inspect = await client.json<{ State: { Status: string } }>(
        'GET',
        `/containers/${helper.id}/json`,
      );
      expect(inspect.State.Status).toBe('created');
      await journal.cleanup(client, helper);
    }
    const after = await client.json<{ Volumes: Array<{ Name: string }> }>('GET', '/volumes');
    const remaining = after.Volumes.map((volume) => volume.Name);
    expect(remaining).toEqual(expect.arrayContaining([...existing, ...volumes]));
    expect(remaining.filter((id) => owned.includes(id))).toEqual([]);
  } finally {
    for (const helper of helpers) await journal.cleanup(client, helper);
    for (const name of volumes) await client.json('DELETE', `/volumes/${encodeURIComponent(name)}`);
    expect(await journal.hasPending()).toBe(false);
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps an existing empty volume empty over populated image content and preserves it on helper cleanup', async () => {
  const client = await DockerEngineClient.connect();
  const image = 'alpine:3.22';
  const imageInfo = await client.json<{ Id: string }>(
    'GET',
    `/images/${encodeURIComponent(image)}/json`,
  );
  const volumeName = `dc-archive-test-${randomUUID()}-empty`;
  const helpers: JournaledDockerHelper[] = [];
  const root = await mkdtemp(join(tmpdir(), 'dc-archive-test-'));
  const journal = new DockerArchiveJournal(root);
  let volumeCreated = false;
  const entriesAt = async (id: string, path: string): Promise<string[]> => {
    const entries: string[] = [];
    await pipeline(
      await client.stream('GET', `/containers/${id}/archive?path=${encodeURIComponent(path)}`),
      list({
        onReadEntry(entry) {
          entries.push(entry.path.replace(/\/$/, ''));
          entry.resume();
        },
      }),
    );
    return entries;
  };
  try {
    await client.json('POST', '/volumes/create', {
      Name: volumeName,
      Labels: { 'dev.devchain.test': volumeName },
    });
    volumeCreated = true;
    const helper = await journal.create(client, imageInfo.Id, [
      { Type: 'volume', Source: volumeName, Target: '/etc' },
    ]);
    helpers.push(helper);
    const reader = await journal.create(client, imageInfo.Id, [
      { Type: 'volume', Source: volumeName, Target: '/data', ReadOnly: true },
    ]);
    helpers.push(reader);
    // The reader's unmounted /etc proves the fixture actually has image content to seed.
    expect(await entriesAt(reader.id, '/etc')).toContain('etc/alpine-release');
    expect(await entriesAt(reader.id, '/data')).toEqual(['data']);
    expect(await entriesAt(helper.id, '/etc')).toEqual(['etc']);
    expect(await entriesAt(reader.id, '/data')).toEqual(['data']);
    for (const item of helpers) {
      const inspected = await client.json<{ State: { Status: string } }>(
        'GET',
        `/containers/${item.id}/json`,
      );
      expect(inspected.State.Status).toBe('created');
      await journal.cleanup(client, item);
    }
    const preserved = await client.json<{ Name: string }>('GET', `/volumes/${volumeName}`);
    expect(preserved.Name).toBe(volumeName);
    const verifier = await journal.create(client, imageInfo.Id, [
      { Type: 'volume', Source: volumeName, Target: '/data', ReadOnly: true },
    ]);
    helpers.push(verifier);
    expect(await entriesAt(verifier.id, '/data')).toEqual(['data']);
  } finally {
    for (const helper of helpers) await journal.cleanup(client, helper);
    if (volumeCreated) await client.json('DELETE', `/volumes/${volumeName}`);
    expect(await journal.hasPending()).toBe(false);
    await rm(root, { recursive: true, force: true });
  }
});

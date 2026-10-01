import { ClaudeAdapter, CodexAdapter, ProviderAdapterFactory } from '../../providers/adapters';
import { TerminalIOService } from '../../terminal/services/terminal-io/terminal-io.service';
import { PtyService } from '../../terminal/services/pty.service';
import { SessionRuntime } from '../../sessions/services/session-runtime/session-runtime.service';
// Two booted apps exercise the real operation ordering, replica rows, streaming parser and filesystem isolation.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { request as httpRequest, type Server } from 'node:http';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import {
  startTwoInstances,
  waitForValue,
  type TwoInstances,
  type TestInstance,
} from '../../../common/test/two-instance.fixture';
import { certificateFingerprint } from '../../../common/tls/certificate';
import { fixtureTls } from '../../../common/test/tls-fixture';
import {
  seedReplicaSource,
  replicaSeeder,
  ensureProvider,
  T,
} from '../replica/__fixtures__/replica-seed';
import type { RemoteOperation } from '../../storage/models/domain.models';
import { TranscriptFilesService } from './transcript-files.service';
import { RemoteHostClient } from '../operations/remote-host.client';
import { TranscriptHandoff } from '../operations/transcript-handoff';
import type { TranscriptFile } from './transcript-transfer.dto';

const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const claude: TranscriptFile = { provider: 'claude', path: `-tmp-A/${uuid}.jsonl` };
const codex: TranscriptFile = {
  provider: 'codex',
  path: '2026/09/26/rollout-2026-09-26T12-00-00-session.jsonl',
};
const sub: TranscriptFile = {
  provider: 'claude',
  path: `-tmp-A/${uuid}/subagents/agent-abc.jsonl`,
};
const tool: TranscriptFile = { provider: 'claude', path: `-tmp-A/${uuid}/tool-results/output.txt` };

jest.setTimeout(60_000);

describe('recorded transcript handoff', () => {
  let instances: TwoInstances;
  let remoteId: string;
  const files = (instance: TestInstance) => instance.app.get(TranscriptFilesService);
  const client = () => instances.home.app.get(RemoteHostClient);
  const bytes = Buffer.alloc(2 * 1024 * 1024, 'x');

  async function put(
    instance: TestInstance,
    file: TranscriptFile,
    body: string | Buffer,
  ): Promise<void> {
    const path = files(instance).path(file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }
  function session(instance: TestInstance, id: string, file: TranscriptFile): void {
    // Both real machines use the same absolute HOME. Separate test roots represent the physical disks.
    replicaSeeder(instance.sqlite).insert('sessions', {
      id,
      agent_id: file.provider === 'codex' ? 'agent-2' : 'agent-1',
      status: 'stopped',
      started_at: T,
      ended_at: T,
      transcript_path: files(instances.home).path(file),
      provider_name_at_launch: file.provider,
      provider_session_id: id,
      created_at: T,
      updated_at: T,
    });
  }
  async function operation(kind: 'attach' | 'detach', extra: Record<string, unknown> = {}) {
    const response = await fetch(`${instances.home.url}/api/remotes/${remoteId}/${kind}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'A', ...extra }),
    });
    expect(response.status).toBe(202);
    const started = (await response.json()) as RemoteOperation;
    return waitForValue(async () => {
      const result = await fetch(`${instances.home.url}/api/remotes/operations/${started.id}`);
      const value = (await result.json()) as RemoteOperation;
      if (value.state === 'failed') throw new Error(JSON.stringify(value.steps));
      return value.state === 'done' ? value : null;
    }, 30_000);
  }

  beforeAll(async () => {
    instances = await startTwoInstances({
      transcriptRoots: (_name, dir) => ({
        claude: [join(dir, 'claude')],
        codex: [join(dir, 'codex')],
      }),
    });
    seedReplicaSource(instances.home.sqlite);
    ensureProvider(instances.host.sqlite, 'host-claude', 'claude', null);
    ensureProvider(instances.host.sqlite, 'host-codex', 'codex', null);
    remoteId = (await instances.registerRemote()).id;
    await waitForValue(async () => {
      const result = await fetch(`${instances.home.url}/api/remotes`);
      return (await result.json()).items[0]?.online;
    }, 10_000);
  });
  afterAll(async () => {
    await instances?.close();
  });

  it('copies Claude companions and a >1 MiB Codex file on Connect, and returns host-only files on Disconnect', async () => {
    const { home, host } = instances;
    for (const file of [claude, sub, tool]) await put(home, file, `contents:${file.path}`);
    await put(home, codex, bytes);
    session(home, 'claude-recorded', claude);
    home.sqlite
      .prepare(
        "UPDATE profile_provider_configs SET provider_id = (SELECT id FROM providers WHERE name = 'codex') WHERE id = 'profile-a-config'",
      )
      .run();
    session(home, 'codex-recorded', codex);
    session(home, 'codex-missing', { provider: 'codex', path: '2026/09/26/rollout-missing.jsonl' });
    // A transcript outside the provider root is skipped and counted; it must not block Connect.
    replicaSeeder(home.sqlite).insert('sessions', {
      id: 'codex-elsewhere',
      agent_id: 'agent-2',
      status: 'stopped',
      started_at: T,
      ended_at: T,
      transcript_path: '/elsewhere/rollout-2026-09-26T00-00-00-elsewhere.jsonl',
      provider_name_at_launch: 'codex',
      provider_session_id: 'codex-elsewhere',
      created_at: T,
      updated_at: T,
    });
    await put(
      home,
      { provider: 'codex', path: '2026/09/26/rollout-unrecorded.jsonl' },
      'never moves',
    );
    const attached = await operation('attach');
    expect(attached.details.transcripts).toMatchObject({
      filesDone: 4,
      filesTotal: 4,
      missing: 1,
      skipped: 1,
    });
    expect(await readFile(files(host).path(codex))).toEqual(bytes);
    for (const file of [claude, sub, tool])
      expect(await readFile(files(host).path(file), 'utf8')).toBe(`contents:${file.path}`);
    expect(
      host.sqlite
        .prepare('SELECT provider_session_id FROM sessions WHERE id = ?')
        .get('codex-recorded'),
    ).toEqual({ provider_session_id: 'codex-recorded' });
    expect(await readdir(dirname(files(host).path(codex)))).toEqual([codex.path.split('/').at(-1)]);

    host.sqlite
      .prepare("UPDATE providers SET bin_path = '/usr/bin/codex' WHERE name = 'codex'")
      .run();
    const upload = jest.spyOn(client(), 'uploadTranscript');
    const report = jest.fn().mockResolvedValue(undefined);
    await home.app
      .get(TranscriptHandoff)
      .copy({ operation: attached, details: {}, progress: report }, 'A', 'push');
    expect(upload).not.toHaveBeenCalled();
    expect(report).toHaveBeenLastCalledWith({
      transcripts: {
        filesDone: 0,
        filesTotal: 0,
        bytesDone: 0,
        bytesTotal: 0,
        missing: 1,
        skipped: 1,
      },
    });
    upload.mockRestore();

    const adapters = host.app.get(ProviderAdapterFactory);
    const adapter = jest
      .spyOn(adapters, 'getAdapter')
      .mockImplementation((name) => host.app.get(name === 'claude' ? ClaudeAdapter : CodexAdapter));
    host.sqlite
      .prepare("UPDATE providers SET bin_path = '/usr/bin/claude' WHERE name = 'claude'")
      .run();
    host.sqlite
      .prepare(
        "UPDATE profile_provider_configs SET provider_id = (SELECT id FROM providers WHERE name = 'claude') WHERE id = 'profile-a-config'",
      )
      .run();
    const terminal = host.app.get(TerminalIOService);
    Object.assign(terminal, { startHealthCheck: jest.fn(), stopHealthCheck: jest.fn() });
    const streaming = jest.spyOn(host.app.get(PtyService), 'startStreaming').mockResolvedValue();
    try {
      for (const [sessionId, resumeFlag] of [
        ['codex-recorded', 'resume'],
        ['claude-recorded', '--resume'],
      ]) {
        const restored = await host.app.get(SessionRuntime).restore(sessionId, 'A');
        expect(restored.status).toBe('running');
        expect(terminal.typeCommand).toHaveBeenLastCalledWith(
          expect.anything(),
          expect.arrayContaining([resumeFlag, sessionId]),
        );
        expect(
          host.sqlite
            .prepare('SELECT status, provider_session_id FROM sessions WHERE id = ?')
            .get(sessionId),
        ).toEqual({ status: 'running', provider_session_id: sessionId });
      }
    } finally {
      streaming.mockRestore();
      adapter.mockRestore();
      host.sqlite
        .prepare(
          "UPDATE sessions SET status = 'stopped', ended_at = ? WHERE id IN ('codex-recorded', 'claude-recorded')",
        )
        .run(T);
    }

    const remoteCodex: TranscriptFile = {
      provider: 'codex',
      path: '2026/09/26/rollout-host-only.jsonl',
    };
    const remoteSub: TranscriptFile = {
      provider: 'claude',
      path: `-tmp-A/${uuid}/subagents/agent-new.jsonl`,
    };
    const remoteTool: TranscriptFile = {
      provider: 'claude',
      path: `-tmp-A/${uuid}/tool-results/new.txt`,
    };
    session(host, 'codex-host-only', remoteCodex);
    for (const file of [remoteCodex, remoteSub, remoteTool])
      await put(host, file, 'host-only contents');
    await put(host, claude, 'changed on host');
    await expect(readFile(files(home).path(remoteSub))).rejects.toThrow();
    const detached = await operation('detach');
    // Missing counts the host side (the source); files just copied home are not missing.
    expect(detached.details.transcripts).toMatchObject({
      filesDone: 4,
      filesTotal: 4,
      missing: 1,
      skipped: 1,
    });
    for (const file of [remoteCodex, remoteSub, remoteTool]) {
      const opened = await files(home).read(file);
      let text = '';
      for await (const chunk of opened.stream) text += chunk.toString();
      expect(text).toBe('host-only contents');
    }
    expect(await readFile(files(home).path(claude), 'utf8')).toBe('changed on host');
  });

  it('an interrupted HTTP upload retains its old destination and retry completes', async () => {
    await put(instances.host, codex, 'old');
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        `${instances.host.url}/api/host/transcripts?${new URLSearchParams(codex)}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream', 'content-length': bytes.length },
        },
      );
      req.on('error', () => resolve());
      req.write(bytes.subarray(0, 65536), () => {
        setTimeout(() => req.destroy(new Error('interrupted')), 50);
      });
      req.on('response', () => reject(new Error('upload unexpectedly completed')));
    });
    await waitForValue(
      async () =>
        !(await readdir(dirname(files(instances.host).path(codex)))).some((name) =>
          name.endsWith('.part'),
        ),
    );
    expect(await readFile(files(instances.host).path(codex), 'utf8')).toBe('old');
    await client().uploadTranscript(remoteId, codex, files(instances.home));
    expect(await readFile(files(instances.host).path(codex))).toEqual(bytes);
  });

  it('an interrupted HTTP download retains its old destination and retry completes', async () => {
    let interrupted = true;
    const server: Server = createServer(
      { key: fixtureTls.key, cert: fixtureTls.cert },
      (req, res) => {
        if (!req.url?.startsWith('/api/host/transcripts')) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'content-length': bytes.length });
        if (interrupted) {
          res.write(bytes.subarray(0, 65536));
          setTimeout(() => res.destroy(), 10);
        } else res.end(bytes);
      },
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const response = await fetch(`${instances.home.url}/api/remotes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'broken-transfer',
        baseUrl: address,
        certificateFingerprint: certificateFingerprint(fixtureTls.cert),
      }),
    });
    const remote = (await response.json()) as { id: string };
    try {
      await put(instances.home, codex, 'old');
      await expect(
        client().downloadTranscript(remote.id, codex, files(instances.home)),
      ).rejects.toThrow();
      expect(await readFile(files(instances.home).path(codex), 'utf8')).toBe('old');
      expect(
        (await readdir(dirname(files(instances.home).path(codex)))).some((name) =>
          name.endsWith('.part'),
        ),
      ).toBe(false);
      interrupted = false;
      await client().downloadTranscript(remote.id, codex, files(instances.home));
      expect(await readFile(files(instances.home).path(codex))).toEqual(bytes);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects missing or excessive Content-Length and invalid path patterns through HTTP', async () => {
    for (const [path, length] of [
      [codex.path, String(1024 ** 3 + 1)],
      ['../secret', '0'],
    ] as const) {
      const response = await instances.host.app.inject({
        method: 'PUT',
        url: `/api/host/transcripts?provider=codex&path=${encodeURIComponent(path)}`,
        headers: { 'content-type': 'application/octet-stream', 'content-length': length },
        payload: '',
      });
      expect(response.statusCode).toBe(400);
    }
    const response = await fetch(
      `${instances.host.url}/api/host/transcripts?${new URLSearchParams(codex)}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: Readable.from('body') as unknown as BodyInit,
        duplex: 'half',
      } as RequestInit,
    );
    expect(response.status).toBe(400);
    await response.text();
  });
});

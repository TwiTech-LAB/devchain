import {
  PROJECT_REPLICA_CONTENT_TYPE,
  ProjectReplicaChangesSchema,
  type ProjectReplicaV1,
} from '@devchain/shared';
import { startTwoInstances, type TwoInstances } from '../../../common/test/two-instance.fixture';
import { ProjectReplicaBuilder } from '../replica/project-replica.builder';
import {
  T,
  ensureProvider,
  replicaSeeder,
  seedReplicaSource,
  stamps,
} from '../replica/__fixtures__/replica-seed';
import { ScheduledEpicRunnerService } from '../../scheduled-epics/services/scheduled-epic-runner.service';
import { ProjectWriteAdmissionService } from '../admission/project-write-admission.service';
import { ProjectReplicaApplier } from '../replica/project-replica.applier';
import { ProjectFreezeService } from './project-freeze.service';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import * as tar from 'tar';
import { HostHelperService } from './host-helper.service';
import { HostSkillSettingsService } from './host-skill-settings.service';
import { SkillSourceLifecycleService } from '../../skills/services/skill-source-lifecycle.service';

const WORKSPACE = 'workspace-team';

describe('host API between two instances', () => {
  let instances: TwoInstances;
  let hostUrl: string;

  beforeAll(async () => {
    instances = await startTwoInstances();
    hostUrl = instances.host.url;
    const home = instances.home.sqlite;
    seedReplicaSource(home);
    home.exec(`
      INSERT INTO project_workspaces (id, name, is_default, position, created_at, updated_at)
      VALUES ('${WORKSPACE}', 'Team', 0, 1, '${T}', '${T}');
      UPDATE projects SET workspace_id = '${WORKSPACE}' WHERE id IN ('A', 'B', 'C');
    `);
    // One large epic pushes the attach body past the default 1 MiB JSON limit.
    home.prepare("UPDATE epics SET description = ? WHERE id = 'epic-1'").run('x'.repeat(1_200_000));
    ensureProvider(instances.host.sqlite, 'host-claude', 'claude', { HOST_ONLY: 'h' });
    ensureProvider(instances.host.sqlite, 'host-codex', 'codex', null);
  }, 60_000);

  afterAll(async () => {
    await instances?.close();
  });

  async function attachReplica(projectId: string): Promise<ProjectReplicaV1> {
    const result = await instances.home.app
      .get(ProjectReplicaBuilder)
      .build({ projectIds: [projectId], scope: 'attach' });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    return result.replica;
  }

  function post(path: string, body?: unknown, contentType = PROJECT_REPLICA_CONTENT_TYPE) {
    return fetch(`${hostUrl}${path}`, {
      method: 'POST',
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': contentType }, body: JSON.stringify(body) }),
    });
  }

  const hostCount = (sql: string, ...params: unknown[]): number =>
    (
      instances.host.sqlite.prepare(`SELECT COUNT(*) AS n FROM (${sql})`).get(...params) as {
        n: number;
      }
    ).n;

  describe('import', () => {
    it('creates the workspace, project and rows with the same IDs, past the default body limit', async () => {
      const replica = await attachReplica('A');

      const response = await post('/api/host/projects/import', replica);

      expect(response.status).toBe(201);
      const body = (await response.json()) as { projectId: string; cursor: string };
      expect(body.projectId).toBe('A');
      expect(Date.parse(body.cursor)).not.toBeNaN();
      expect(
        instances.host.sqlite
          .prepare('SELECT id, name FROM project_workspaces WHERE id = ?')
          .get(WORKSPACE),
      ).toEqual({ id: WORKSPACE, name: 'Team' });
      expect(instances.host.sqlite.prepare('SELECT id FROM epics ORDER BY id').all()).toEqual([
        { id: 'epic-1' },
        { id: 'epic-2' },
      ]);
      expect(hostCount("SELECT 1 FROM agents WHERE project_id = 'A'")).toBe(2);
      expect(hostCount("SELECT 1 FROM epic_comments WHERE id = 'comment-1'")).toBe(1);
    });

    it('refuses the default JSON parser for a body over its limit', async () => {
      const response = await post(
        '/api/host/projects/import',
        await attachReplica('A'),
        'application/json',
      );

      expect(response.status).toBe(413);
    });

    it('refuses a second import with 409 unless mode=resnapshot', async () => {
      const replica = await attachReplica('A');

      const again = await post('/api/host/projects/import', replica);
      const resnapshot = await post('/api/host/projects/import?mode=resnapshot', replica);

      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({ details: { code: 'PROJECT_EXISTS' } });
      expect(resnapshot.status).toBe(201);
    });

    it('rejects a payload that is not an attach replica of one project', async () => {
      const replica = await attachReplica('A');

      const response = await post('/api/host/projects/import', {
        ...replica,
        scope: 'live',
        tables: { ...replica.tables },
      });

      expect(response.status).toBe(400);
    });
  });

  describe('changes', () => {
    async function changes(query: string) {
      const response = await fetch(`${hostUrl}/api/host/projects/A/changes?${query}`);
      expect(response.status).toBe(200);
      const text = await response.text();
      return { text, body: ProjectReplicaChangesSchema.parse(JSON.parse(text)) };
    }

    it('returns an epic whose only change is a new comment, with whole small tables', async () => {
      const { body: first } = await changes('');
      expect(first.replica.tables.epics.map((epic) => epic.id)).toEqual(['epic-1', 'epic-2']);
      expect(first.cursor).toBe(first.replica.generatedAt);

      await instances.host.storage.createEpicComment({
        epicId: 'epic-2',
        authorName: 'Host agent',
        content: 'Only a comment changed',
      });
      const { body, text } = await changes(`since=${encodeURIComponent(first.cursor)}`);

      const { tables } = body.replica;
      expect(tables.epics.map((epic) => epic.id)).toEqual(['epic-2']);
      expect(tables.epic_comments.map((comment) => comment.content)).toEqual([
        'Only a comment changed',
      ]);
      expect(tables.statuses.map((status) => status.id)).toEqual(['A-status']);
      expect(tables.tags.map((tag) => tag.id)).toEqual(['tag-a']);
      expect(tables.agents.map((agent) => agent.id).sort()).toEqual(['agent-1', 'agent-2']);
      expect(tables.agent_profiles.map((profile) => profile.id).sort()).toEqual([
        'profile-a',
        'profile-global',
      ]);
      expect(tables.profile_provider_configs).toHaveLength(2);
      expect(tables.epic_relations.map((relation) => relation.id)).toEqual(['relation-internal']);
      expect(body.idSets).toBeUndefined();
      expect(text).not.toContain('secret-a');
      expect(Date.parse(body.cursor)).toBeGreaterThanOrEqual(Date.parse(first.cursor));
    });

    it('adds the complete ID sets when full=true', async () => {
      // Past the 5 s overlap, so no epic counts as changed and only the ID sets remain.
      const since = new Date(Date.now() + 60_000).toISOString();
      const { body } = await changes(`since=${encodeURIComponent(since)}&full=true`);

      expect(body.replica.tables.epics).toEqual([]);
      expect(body.idSets).toEqual({
        epics: ['epic-1', 'epic-2'],
        epic_comments: expect.arrayContaining(['comment-1']),
        epic_relations: ['relation-internal'],
        epic_time_segments: ['segment-settled'],
      });
      expect(body.idSets?.epic_comments).toHaveLength(2);
    });
  });

  describe('replica export', () => {
    it('returns a detach replica with sessions', async () => {
      const response = await fetch(`${hostUrl}/api/host/projects/A/replica?scope=detach`);

      expect(response.status).toBe(200);
      const replica = (await response.json()) as Extract<ProjectReplicaV1, { scope: 'detach' }>;
      expect(replica.scope).toBe('detach');
      expect(replica.tables.epics.map((epic) => epic.id)).toEqual(['epic-1', 'epic-2']);
      expect(replica.tables).toHaveProperty('sessions');
    });

    it('serves an attach replica with sessions and watermarks for a re-snapshot', async () => {
      const response = await fetch(`${hostUrl}/api/host/projects/A/replica?scope=attach`);

      expect(response.status).toBe(200);
      const replica = (await response.json()) as Extract<ProjectReplicaV1, { scope: 'attach' }>;
      expect(replica.scope).toBe('attach');
      expect(replica.tables.sessions.map((session) => session.id)).toEqual(['session-1']);
      expect(replica.tables.epic_time_session_watermarks).toHaveLength(1);
    });

    it('rejects another scope and an unknown project', async () => {
      const live = await fetch(`${hostUrl}/api/host/projects/A/replica?scope=live`);
      const missing = await fetch(`${hostUrl}/api/host/projects/nope/replica?scope=detach`);

      expect(live.status).toBe(400);
      expect(missing.status).toBe(404);
    });
  });

  describe('idempotency lookup', () => {
    it('returns the epic id for a stored key and 404 otherwise', async () => {
      instances.host.sqlite
        .prepare("UPDATE epics SET data = ? WHERE id = 'epic-1'")
        .run(JSON.stringify({ idempotencyKey: 'import-key-1' }));

      const found = await fetch(
        `${hostUrl}/api/host/projects/A/epics/by-idempotency-key/import-key-1`,
      );
      const missing = await fetch(`${hostUrl}/api/host/projects/A/epics/by-idempotency-key/other`);

      expect(found.status).toBe(200);
      expect(await found.json()).toEqual({ epicId: 'epic-1' });
      expect(missing.status).toBe(404);
    });
  });

  describe('freeze and thaw', () => {
    it('answers 404 for an unknown project', async () => {
      expect((await post('/api/host/projects/nope/freeze')).status).toBe(404);
    });
  });

  describe('release', () => {
    it('refuses an unfrozen project', async () => {
      expect((await post('/api/host/projects/A/thaw')).status).toBe(204);
      const response = await post('/api/host/projects/A/release');

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ details: { code: 'PROJECT_NOT_FROZEN' } });
    });

    it('deletes a frozen project with its sessions, segments and events and keeps a shared workspace', async () => {
      const host = replicaSeeder(instances.host.sqlite);
      const hostClaudeEnvKeys = () =>
        Object.keys(
          JSON.parse(
            (
              instances.host.sqlite
                .prepare("SELECT env FROM providers WHERE name = 'claude'")
                .get() as { env: string | null }
            ).env ?? '{}',
          ),
        ).sort();
      host.insert('projects', {
        id: 'other',
        workspace_id: WORKSPACE,
        name: 'Other',
        root_path: '/tmp/other',
        is_template: 0,
        is_private: 0,
        ...stamps,
      });
      host.insert('sessions', {
        id: 'host-session',
        agent_id: 'agent-1',
        status: 'stopped',
        started_at: T,
        ...stamps,
      });
      expect(
        hostCount("SELECT 1 FROM events WHERE json_extract(payload_json, '$.projectId') = 'A'"),
      ).toBeGreaterThan(0);
      // The import matched home's env: API_KEY is scoped to project A only, UNSCOPED
      // stays unscoped, and HOST_ONLY (set by hand on the host) is gone.
      expect(hostClaudeEnvKeys()).toEqual(['API_KEY', 'UNSCOPED']);
      await post('/api/host/projects/A/freeze');

      const response = await post('/api/host/projects/A/release');

      expect(response.status).toBe(204);
      expect(hostCount("SELECT 1 FROM projects WHERE id = 'A'")).toBe(0);
      expect(hostCount("SELECT 1 FROM epics WHERE project_id = 'A'")).toBe(0);
      expect(hostCount("SELECT 1 FROM agents WHERE project_id = 'A'")).toBe(0);
      expect(hostCount('SELECT 1 FROM sessions')).toBe(0);
      expect(hostCount("SELECT 1 FROM epic_time_segments WHERE project_id = 'A'")).toBe(0);
      expect(
        hostCount("SELECT 1 FROM events WHERE json_extract(payload_json, '$.projectId') = 'A'"),
      ).toBe(0);
      expect(hostCount('SELECT 1 FROM project_workspaces WHERE id = ?', WORKSPACE)).toBe(1);
      expect(instances.host.app.get(ProjectFreezeService).isFrozen('A')).toBe(false);
      // The key that was scoped only to the detached project no longer sits in
      // the host provider env applying to every remaining project.
      expect(hostClaudeEnvKeys()).toEqual(['UNSCOPED']);
    });

    it('deletes the workspace with the last project that used it', async () => {
      expect((await post('/api/host/projects/import', await attachReplica('B'))).status).toBe(201);
      instances.host.sqlite.exec("DELETE FROM projects WHERE id = 'other'");
      await post('/api/host/projects/B/freeze');

      const response = await post('/api/host/projects/B/release');

      expect(response.status).toBe(204);
      expect(hostCount('SELECT 1 FROM project_workspaces WHERE id = ?', WORKSPACE)).toBe(0);
    });
  });
  describe('import freezes the copy until the explicit thaw', () => {
    const hostFreeze = () => instances.host.app.get(ProjectFreezeService);
    const hostAdmission = () => instances.host.app.get(ProjectWriteAdmissionService);

    function putStatus(statusId: string, label: string): Promise<Response> {
      return fetch(`${hostUrl}/api/statuses/${statusId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label }),
      });
    }

    it('leaves no row and no freeze after a failed import; the next import of the id succeeds', async () => {
      const replica = await attachReplica('C');
      const broken = {
        ...replica,
        tables: {
          ...replica.tables,
          providers: replica.tables.providers.map((provider) => ({
            ...provider,
            name: 'not-installed-here',
          })),
        },
      };

      const failed = await post('/api/host/projects/import', broken);

      expect(failed.status).toBeGreaterThanOrEqual(400);
      expect(hostCount("SELECT 1 FROM projects WHERE id = 'C'")).toBe(0);
      expect(hostFreeze().isFrozen('C')).toBe(false);
      expect(hostAdmission().isWritable('C')).toBe(true);

      const retried = await post('/api/host/projects/import', replica);

      expect(retried.status).toBe(201);
    });

    it('refuses host writes and schedules from the import response until the thaw', async () => {
      const imported = await post(
        '/api/host/projects/import?mode=resnapshot',
        await attachReplica('C'),
      );
      const { cursor } = (await imported.json()) as { cursor: string };

      // The row was committed frozen, at the cursor the import returned.
      expect(await instances.host.storage.listFrozenProjects()).toContainEqual({
        projectId: 'C',
        frozenAt: cursor,
      });
      const refused = await putStatus('C-status', 'Written before the thaw');
      expect({ status: refused.status, body: await refused.json() }).toMatchObject({
        status: 423,
        body: { code: 'PROJECT_FROZEN' },
      });
      expect(hostAdmission().listNonWritableProjectIds()).toContain('C');
      replicaSeeder(instances.host.sqlite).insert('scheduled_epics', {
        id: 'schedule-c',
        project_id: 'C',
        name: 'Due',
        cron_expression: '0 0 * * *',
        timezone: 'UTC',
        enabled: 1,
        title_template: 'Due',
        allow_overlap: 0,
        missed_run_policy: 'skip',
        config_version: 1,
        next_run_at: '2020-01-01T00:00:00.000Z',
        ...stamps,
      });
      const runner = instances.host.app.get(ScheduledEpicRunnerService);
      await (runner as unknown as { scanAndExecute(): Promise<void> }).scanAndExecute();
      expect(hostCount("SELECT 1 FROM scheduled_epic_runs WHERE schedule_id = 'schedule-c'")).toBe(
        0,
      );
      expect(
        instances.host.sqlite.prepare("SELECT label FROM statuses WHERE id = 'C-status'").get(),
      ).toEqual({ label: 'New' });

      expect((await post('/api/host/projects/C/thaw')).status).toBe(204);

      expect((await putStatus('C-status', 'Written after the thaw')).status).toBe(200);
    });

    it('keeps the project unwritable while the import is in flight', async () => {
      const applier = instances.host.app.get(ProjectReplicaApplier);
      const apply = applier.apply.bind(applier);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let started!: () => void;
      const applying = new Promise<void>((resolve) => (started = resolve));
      const spy = jest.spyOn(applier, 'apply').mockImplementationOnce(async (...args) => {
        started();
        await gate;
        return apply(...args);
      });

      const importing = post('/api/host/projects/import', await attachReplica('B'));
      let writableDuringApply: boolean;
      let admissionError: unknown;
      let restStatus: number;
      try {
        await applying;
        writableDuringApply = hostAdmission().isWritable('B');
        try {
          hostAdmission().assertWritable('B');
        } catch (error) {
          admissionError = error;
        }
        // The row is not committed yet: the write is refused or finds nothing.
        restStatus = (await putStatus('B-status', 'During import')).status;
      } finally {
        release();
        spy.mockRestore();
      }
      expect((await importing).status).toBe(201);

      expect(writableDuringApply).toBe(false);
      expect(admissionError).toMatchObject({ statusCode: 423, code: 'PROJECT_FROZEN' });
      expect([404, 423]).toContain(restStatus);
      const afterImport = await putStatus('B-status', 'After import');
      expect({ status: afterImport.status, body: await afterImport.json() }).toMatchObject({
        status: 423,
        body: { code: 'PROJECT_FROZEN' },
      });
      expect(
        instances.host.sqlite.prepare("SELECT label FROM statuses WHERE id = 'B-status'").get(),
      ).toEqual({ label: 'New' });
    });
  });

  const body = {
    revision: 'one',
    communitySources: [],
    localSources: [],
    sourcesEnabled: {},
    projectIds: [],
    projectSourceSwitches: [],
  };
  describe('Host skill settings HTTP', () => {
    let homeMarker: jest.SpyInstance;
    let hostMarker: jest.SpyInstance;
    let managedRoot: jest.SpyInstance;
    beforeAll(async () => {
      homeMarker = jest
        .spyOn(instances.home.app.get(HostHelperService), 'isClaimedHost')
        .mockReturnValue(false);
      hostMarker = jest
        .spyOn(instances.host.app.get(HostHelperService), 'isClaimedHost')
        .mockReturnValue(true);
      managedRoot = jest
        .spyOn(instances.host.app.get(HostSkillSettingsService), 'managedRoot')
        .mockReturnValue(join(instances.rootDir, 'managed-skills'));
    }, 60000);
    afterAll(async () => {
      if (instances) {
        await instances.host.app
          .get(SkillSourceLifecycleService)
          .enqueueExclusiveJob(async () => undefined);
      }
      managedRoot?.mockRestore();
      hostMarker?.mockRestore();
      homeMarker?.mockRestore();
    });
    const put = (url: string, value: unknown) =>
      fetch(`${url}/api/host/skill-settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value),
      });
    async function status() {
      return (await fetch(`${instances.host.url}/api/host/skill-settings/status`)).json();
    }
    it('refuses all routes on a plain instance and validates the settings body', async () => {
      expect((await put(instances.home.url, body)).status).toBe(409);
      expect((await fetch(`${instances.home.url}/api/host/skill-settings/status`)).status).toBe(
        409,
      );
      expect(
        (
          await fetch(
            `${instances.home.url}/api/host/skill-settings/local-sources/local/content?contentHash=h`,
            { method: 'PUT', headers: { 'content-type': 'application/x-tar' }, body: 'bad' },
          )
        ).status,
      ).toBe(409);
      expect((await put(instances.host.url, { revision: 'bad' })).status).toBe(400);
    });
    it('queues settings with 202 and reports the applied revision', async () => {
      expect((await put(instances.host.url, body)).status).toBe(202);
      for (let i = 0; i < 50 && (await status()).pendingRevision; i++)
        await new Promise((resolve) => setImmediate(resolve));
      expect(await status()).toEqual({
        appliedRevision: 'one',
        pendingRevision: null,
        skipped: [],
        needsContent: [],
      });
    });

    it('streams gzip tar, replaces copies and imports each version into the catalog, including content uploaded while off', async () => {
      const input = join(instances.rootDir, 'upload-input');
      await fs.mkdir(join(input, 'skills', 'example'), { recursive: true });
      const lifecycle = instances.host.app.get(SkillSourceLifecycleService);
      for (const [index, text] of ['one', 'two', 'new'].entries()) {
        const hash = `hash${index}`;
        const request = {
          ...body,
          revision: hash,
          localSources: [{ name: 'http-local', folderPath: '/home/local', contentHash: hash }],
          sourcesEnabled: { 'http-local': index !== 2 },
        };
        expect((await put(instances.host.url, request)).status).toBe(202);
        for (let i = 0; i < 50 && (await status()).pendingRevision; i++)
          await new Promise((resolve) => setImmediate(resolve));
        const file = join(input, 'skills', 'example', 'SKILL.md');
        await fs.writeFile(file, `---\nname: example\ndescription: Example\n---\n${text}`);
        await fs.utimes(file, 1700000000, 1700000000);
        const chunks: Buffer[] = [];
        for await (const chunk of tar.c({ cwd: input, gzip: true }, ['skills']))
          chunks.push(Buffer.from(chunk));
        const response = await fetch(
          `${instances.host.url}/api/host/skill-settings/local-sources/http-local/content?contentHash=${hash}`,
          {
            method: 'PUT',
            headers: { 'content-type': 'application/x-tar' },
            body: Buffer.concat(chunks),
          },
        );
        expect(response.status).toBe(200);
        await lifecycle.enqueueExclusiveJob(async () => undefined);
        const content = () =>
          instances.host.sqlite
            .prepare("SELECT instruction_content FROM skills WHERE source = 'http-local'")
            .get();
        if (index === 2) {
          expect(content()).toEqual({ instruction_content: 'two' });
          await put(instances.host.url, {
            ...request,
            revision: 'enabled',
            sourcesEnabled: { 'http-local': true },
          });
          for (let i = 0; i < 50 && (await status()).pendingRevision; i++)
            await new Promise((resolve) => setImmediate(resolve));
          await lifecycle.enqueueExclusiveJob(async () => undefined);
        }
        expect(content()).toEqual({ instruction_content: text });
        expect((await status()).needsContent).toEqual([]);
      }
    }, 20000);
  });
});

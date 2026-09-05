import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { ValidationError } from '../../common/errors/error-types';
import { EventsService } from '../events/services/events.service';
import { EpicTimeService } from './services/epic-time.service';
import { EpicTimeStore } from './services/epic-time.store';
import { LocalStorageService } from '../storage/local/local-storage.service';
import type { Epic, Project } from '../storage/models/domain.models';

const MIGRATIONS_FOLDER = join(__dirname, '../../../drizzle');
const TIME_ZONE = 'UTC';

// Layer: backend integration. Convergence correctness depends on the real
// relation write path (canonical pairs, enforcement, confirmation) feeding the
// real resolver over migrated SQLite; raw-row resolver behavior is owned by
// epic-time.store.integration.spec.ts.
describe('related-time rollup convergence', () => {
  let sqlite: Database.Database;
  let storage: LocalStorageService;
  let timeService: EpicTimeService;
  let project: Project;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    sqlite.pragma('foreign_keys = ON');
    storage = new LocalStorageService(db);
    timeService = new EpicTimeService(
      new EpicTimeStore(db as unknown as BetterSQLite3Database),
      // The convergence lane never assigns buffers; a fail-loud publish stub
      // keeps any accidental event publication visible.
      { publish: async () => null } as unknown as EventsService,
    );
    project = await storage.createProject({
      name: 'Convergence',
      description: null,
      rootPath: '/tmp/convergence',
    });
  });

  afterEach(() => sqlite.close());

  async function createRoot(title: string): Promise<Epic> {
    return storage.createEpicForProject(project.id, { title, description: null });
  }

  async function createChild(parentId: string, title: string): Promise<Epic> {
    return storage.createEpicForProject(project.id, { title, description: null, parentId });
  }

  function insertSegment(epicId: string, durationMs = 60_000): void {
    sqlite
      .prepare(
        `INSERT INTO epic_time_segments
           (id, project_id, epic_id, session_id_snapshot, agent_id_snapshot,
            agent_name_snapshot, started_at, last_activity_at, closed_at,
            duration_ms, created_at, updated_at)
         VALUES (?, ?, ?, 'session-convergence', 'agent-convergence', 'Coder',
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z',
                 '2026-01-01T00:01:00.000Z', ?, '2026-01-01T00:01:00.000Z',
                 '2026-01-01T00:01:00.000Z')`,
      )
      .run(`seg-${epicId}`, project.id, epicId, durationMs);
  }

  function insertExternalLink(epicId: string): void {
    sqlite
      .prepare(
        `INSERT INTO external_task_links
           (id, epic_id, provider, remote_scope_key, remote_task_id,
            source_snapshot, created_at, updated_at)
         VALUES (?, ?, 'clickup', 'scope', ?, '{}',
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run(`link-${epicId}`, epicId, `task-${epicId}`);
  }

  function insertSegmentAt(
    epicId: string,
    segmentId: string,
    lastActivityAt: string,
    durationMs = 60_000,
  ): void {
    sqlite
      .prepare(
        `INSERT INTO epic_time_segments
           (id, project_id, epic_id, session_id_snapshot, agent_id_snapshot,
            agent_name_snapshot, started_at, last_activity_at, closed_at,
            duration_ms, created_at, updated_at)
         VALUES (?, ?, ?, 'session-convergence', 'agent-convergence', 'Coder',
                 ?, ?, ?, ?, '2026-01-01T00:00:00.000Z',
                 '2026-01-01T00:00:00.000Z')`,
      )
      .run(
        segmentId,
        project.id,
        epicId,
        lastActivityAt,
        lastActivityAt,
        lastActivityAt,
        durationMs,
      );
  }

  function routeFrom(source: Epic, target: Epic): Promise<unknown> {
    // The write's endpoint order defines direction: source is the first
    // address, target the second.
    return storage.setEpicRelation({
      epicId: source.id,
      relatedEpicId: target.id,
      type: 'related',
      createdBy: 'user',
    });
  }

  function detailTotal(epicId: string): number {
    return timeService.getDetail(epicId, TIME_ZONE).totalMinutes;
  }

  it('aggregates the authoritative linked-anchor split with matching detail and batch totals', async () => {
    const [one, two, three, four] = await Promise.all([
      createRoot('Epic 1'),
      createRoot('Epic 2'),
      createRoot('Epic 3'),
      createRoot('Epic 4'),
    ]);
    for (const epic of [one, two, three, four]) {
      insertSegment(epic.id);
    }
    insertExternalLink(one.id);
    insertExternalLink(three.id);
    await routeFrom(two, one);
    await routeFrom(three, two);
    await routeFrom(four, three);

    const oneDetail = timeService.getDetail(one.id, TIME_ZONE);
    const threeDetail = timeService.getDetail(three.id, TIME_ZONE);
    // Epic 1 logs Epic 1 plus Epic 2; Epic 3 logs Epic 3 plus Epic 4. The
    // linked Epic 3 stops Epic 1's traversal, so no time leaks upstream.
    expect(oneDetail.totalMinutes).toBe(2);
    expect(oneDetail.includesRelatedTime).toBe(true);
    expect(threeDetail.totalMinutes).toBe(2);
    expect(detailTotal(two.id)).toBe(1);

    const batch = timeService.getBatch([one.id, three.id, two.id], TIME_ZONE);
    expect(batch.items).toEqual([
      { epicId: one.id, totalMinutes: oneDetail.totalMinutes },
      { epicId: three.id, totalMinutes: threeDetail.totalMinutes },
      { epicId: two.id, totalMinutes: 1 },
    ]);

    const taskSum = oneDetail.taskItems.reduce((sum, item) => sum + item.minutes, 0);
    expect(taskSum).toBe(oneDetail.totalMinutes);
  });

  it('keeps child detail self-only and applies the linked-boundary expansions exactly', async () => {
    const focal = await createRoot('Focal');
    const routed = await createRoot('Routed');
    const routedChildOpen = await createChild(routed.id, 'Routed child open');
    const routedChildLinked = await createChild(routed.id, 'Routed child linked');
    const focalChildLinked = await createChild(focal.id, 'Focal child linked');
    insertExternalLink(routedChildLinked.id);
    insertExternalLink(focalChildLinked.id);
    for (const epic of [focal, routed, routedChildOpen, routedChildLinked, focalChildLinked]) {
      insertSegment(epic.id);
    }
    await routeFrom(routed, focal);

    // Focal keeps its unfiltered direct-child expansion, the routed root
    // contributes itself and its unlinked children, a linked child under the
    // routed root contributes nothing, and the linked focal child stays in.
    const focalDetail = timeService.getDetail(focal.id, TIME_ZONE);
    const contributors = focalDetail.taskItems.map((item) => item.epicId).sort();
    expect(contributors).toEqual(
      [focal.id, focalChildLinked.id, routed.id, routedChildOpen.id].sort(),
    );
    expect(focalDetail.totalMinutes).toBe(4);
    expect(focalDetail.directMinutes).toBe(1);
    const taskSum = focalDetail.taskItems.reduce((sum, item) => sum + item.minutes, 0);
    expect(taskSum).toBe(focalDetail.totalMinutes);

    const childDetail = timeService.getDetail(routedChildOpen.id, TIME_ZONE);
    expect(childDetail.totalMinutes).toBe(1);
    expect(childDetail.includesRelatedTime).toBe(false);
    // A linked child exports only itself: it appears in no routed expansion
    // and its own detail stays self-only.
    expect(focalDetail.taskItems.some((item) => item.epicId === routedChildLinked.id)).toBe(false);
    expect(timeService.getDetail(routedChildLinked.id, TIME_ZONE).totalMinutes).toBe(1);
  });

  it('groups contributors by display owner and converges batch totals across focals', async () => {
    const focal = await createRoot('Focal');
    const focalChild = await createChild(focal.id, 'Focal child');
    const routed = await createRoot('Routed');
    const routedChild = await createChild(routed.id, 'Routed child');
    for (const epic of [focal, focalChild, routed, routedChild]) {
      insertSegment(epic.id);
    }
    await routeFrom(routed, focal);

    const focalDetail = timeService.getDetail(focal.id, TIME_ZONE);
    expect(focalDetail.totalMinutes).toBe(4);
    expect(
      focalDetail.taskItems.map((item) => ({
        epicId: item.epicId,
        groupEpicId: item.groupEpicId,
        groupEpicTitle: item.groupEpicTitle,
        minutes: item.minutes,
      })),
    ).toEqual([
      { epicId: focal.id, groupEpicId: focal.id, groupEpicTitle: 'Focal', minutes: 1 },
      { epicId: focalChild.id, groupEpicId: focal.id, groupEpicTitle: 'Focal', minutes: 1 },
      { epicId: routed.id, groupEpicId: routed.id, groupEpicTitle: 'Routed', minutes: 1 },
      { epicId: routedChild.id, groupEpicId: routed.id, groupEpicTitle: 'Routed', minutes: 1 },
    ]);

    // Group totals sum the already allocated task rows exactly once: the two
    // groups cover every row and add up to the detail total.
    const groupTotals = new Map<string, number>();
    for (const item of focalDetail.taskItems) {
      const key = item.groupEpicId ?? '';
      groupTotals.set(key, (groupTotals.get(key) ?? 0) + item.minutes);
    }
    expect(groupTotals).toEqual(
      new Map([
        [focal.id, 2],
        [routed.id, 2],
      ]),
    );
    expect([...groupTotals.values()].reduce((total, minutes) => total + minutes, 0)).toBe(
      focalDetail.totalMinutes,
    );

    // Group metadata never reaches the daily projection: grouping the detail
    // items still reproduces it byte for byte on a multi-group scope.
    const projection = timeService.getDailyProjection(focal.id, TIME_ZONE);
    const grouped = new Map<string, number>();
    for (const item of focalDetail.items) {
      grouped.set(item.activityDate, (grouped.get(item.activityDate) ?? 0) + item.minutes);
    }
    expect(projection.totalMinutes).toBe(focalDetail.totalMinutes);
    expect(projection.currentByDate).toEqual(
      [...grouped.entries()]
        .map(([activityDate, minutes]) => ({ activityDate, minutes }))
        .sort((left, right) => left.activityDate.localeCompare(right.activityDate)),
    );

    // The batch stays partitioned only by requested focal rootEpicId, and a
    // child focal groups under itself while staying self-only.
    expect(
      timeService.getBatch([focal.id, focalChild.id, routed.id, routedChild.id], TIME_ZONE),
    ).toEqual({
      items: [
        { epicId: focal.id, totalMinutes: 4 },
        { epicId: focalChild.id, totalMinutes: 1 },
        { epicId: routed.id, totalMinutes: 2 },
        { epicId: routedChild.id, totalMinutes: 1 },
      ],
    });
    expect(timeService.getDetail(focalChild.id, TIME_ZONE).taskItems).toEqual([
      expect.objectContaining({
        epicId: focalChild.id,
        groupEpicId: focalChild.id,
        groupEpicTitle: 'Focal child',
      }),
    ]);
  });

  it('supplies a routed root title through contributing child rows when the root has no own minutes', async () => {
    const focal = await createRoot('Focal');
    const routed = await createRoot('Silent routed');
    const routedChild = await createChild(routed.id, 'Routed child');
    insertSegment(focal.id);
    insertSegment(routedChild.id);
    await routeFrom(routed, focal);

    const detail = timeService.getDetail(focal.id, TIME_ZONE);
    expect(detail.includesRelatedTime).toBe(true);
    expect(detail.taskItems).toEqual([
      expect.objectContaining({
        epicId: focal.id,
        groupEpicId: focal.id,
        groupEpicTitle: 'Focal',
        minutes: 1,
      }),
      expect.objectContaining({
        epicId: routedChild.id,
        groupEpicId: routed.id,
        groupEpicTitle: 'Silent routed',
        minutes: 1,
      }),
    ]);
    expect(detail.taskItems.reduce((sum, item) => sum + item.minutes, 0)).toBe(detail.totalMinutes);
  });

  it('never double-counts a segment across focals and keeps detail totals additive', async () => {
    const one = await createRoot('One');
    const two = await createRoot('Two');
    insertSegment(one.id, 120_000);
    insertSegment(two.id, 60_000);
    await routeFrom(two, one);

    const detail = timeService.getDetail(one.id, TIME_ZONE);
    // One focal's own minutes plus the routed root's minutes, each segment
    // once: three whole minutes, with the task breakdown matching.
    expect(detail.totalMinutes).toBe(3);
    expect(detail.taskItems.reduce((sum, item) => sum + item.minutes, 0)).toBe(3);
    const batch = timeService.getBatch([one.id, two.id], TIME_ZONE);
    expect(batch.items).toEqual([
      { epicId: one.id, totalMinutes: 3 },
      { epicId: two.id, totalMinutes: 1 },
    ]);
  });

  it('refreshes the aggregate as routes, link boundaries, and parents transition', async () => {
    const focal = await createRoot('Focal');
    const routed = await createRoot('Routed');
    const routedChild = await createChild(routed.id, 'Routed child');
    const soloChild = await createChild(routed.id, 'Solo child');
    for (const epic of [focal, routed, routedChild, soloChild]) {
      insertSegment(epic.id);
    }

    expect(detailTotal(focal.id)).toBe(1);

    await routeFrom(routed, focal);
    expect(detailTotal(focal.id)).toBe(4);
    expect(timeService.getDetail(focal.id, TIME_ZONE).includesRelatedTime).toBe(true);

    // Linking the routed root withdraws its whole branch from the focal.
    insertExternalLink(routed.id);
    expect(detailTotal(focal.id)).toBe(1);
    expect(timeService.getDetail(focal.id, TIME_ZONE).includesRelatedTime).toBe(false);

    sqlite.prepare('DELETE FROM external_task_links WHERE epic_id = ?').run(routed.id);
    // Removing the link restores the branch with no relation write at all:
    // the resolver reads current state, so the same route serves both sides.
    expect(detailTotal(focal.id)).toBe(4);

    // Moving a child out of the routed root's expansion drops its minutes.
    const soloChildNow = await storage.getEpic(soloChild.id);
    await storage.updateEpic(soloChild.id, { parentId: null }, soloChildNow.version);
    expect(detailTotal(focal.id)).toBe(3);
  });

  it('requires fresh destructive confirmation when an agent edit races a human retry', async () => {
    const a = await createRoot('A');
    const b = await createRoot('B');
    const d = await createRoot('D');
    insertSegment(a.id);
    await routeFrom(a, b);

    // The human asks to replace a's route and receives the current facts.
    await expect(routeFrom(a, d)).rejects.toMatchObject({
      code: 'relation_confirmation_required',
      details: { currentEffect: { sourceEpicId: a.id, targetEpicId: b.id } },
    });

    // While the human decides, an agent command deletes the old pair and
    // establishes the reverse route d->a. Both writes serialize onto one
    // queue; the human retry runs after them and must receive the fresh facts
    // instead of displacing the new route with stale ones.
    const agent = await seedAgent('Racer');
    const agentContext = { actor: { type: 'agent', id: agent.id } };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = storage.runInTransaction(async () => gate);
    const agentDelete = storage.deleteEpicRelation(a.id, b.id, agentContext);
    const agentRoute = storage.setEpicRelation(
      {
        epicId: d.id,
        relatedEpicId: a.id,
        type: 'related',
        createdBy: 'agent',
        createdByAgentId: agent.id,
      },
      agentContext,
    );
    const humanRetry = storage.setEpicRelation({
      epicId: a.id,
      relatedEpicId: d.id,
      type: 'related',
      acceptedRouteEffect: { sourceEpicId: a.id, targetEpicId: b.id },
      createdBy: 'user',
    });
    release();
    await held;

    await expect(agentDelete).resolves.toMatchObject({ deleted: true });
    await expect(agentRoute).resolves.toBeDefined();
    await expect(humanRetry).rejects.toMatchObject({
      code: 'relation_confirmation_required',
      details: { currentEffect: { sourceEpicId: d.id, targetEpicId: a.id } },
    });
    const row = sqlite.prepare('SELECT direction FROM epic_relations').get() as {
      direction: string;
    };
    expect(row.direction).not.toBe('none');
  });

  it('uses one recursive prepared statement with a single bounded JSON focal seed', async () => {
    const epics = await Promise.all([createRoot('Q1'), createRoot('Q2'), createRoot('Q3')]);
    for (const epic of epics) {
      insertSegment(epic.id);
    }

    // Detail resolves segments and routed metadata through ONE traversal, so
    // a route mutation can never split the total and includesRelatedTime
    // snapshots; batch resolves every focal through the same single statement.
    const detailPrepareSpy = jest.spyOn(sqlite, 'prepare');
    timeService.getDetail(epics[0]!.id, TIME_ZONE);
    const detailStatements = detailPrepareSpy.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => sql.includes('json_each'));
    expect(detailStatements).toHaveLength(1);
    detailPrepareSpy.mockRestore();

    const prepareSpy = jest.spyOn(sqlite, 'prepare');
    timeService.getBatch(
      epics.map((epic) => epic.id),
      TIME_ZONE,
    );
    const recursiveStatements = prepareSpy.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => sql.includes('json_each'));
    expect(recursiveStatements).toHaveLength(1);
    prepareSpy.mockRestore();

    expect(() =>
      timeService.getBatch(
        Array.from({ length: 1001 }, (_, index) => `${epics[0]!.id}-${index}`),
        TIME_ZONE,
      ),
    ).toThrow(ValidationError);
  });

  it('converges the daily projection with detail totals across routed scope and zones', async () => {
    const one = await createRoot('One');
    const two = await createRoot('Two');
    insertSegmentAt(one.id, 'seg-one-early', '2026-01-02T12:30:00.000Z', 60_000);
    insertSegmentAt(one.id, 'seg-one-late', '2026-01-03T02:30:00.000Z', 120_000);
    insertSegmentAt(two.id, 'seg-two', '2026-01-02T20:30:00.000Z', 60_000);
    await routeFrom(two, one);

    // One focal's daily projection groups the same quantized items the
    // detail summary exposes — itself plus the routed root's time — and
    // sums exactly to the detail total from the same single resolved read.
    const projection = timeService.getDailyProjection(one.id, TIME_ZONE);
    const detail = timeService.getDetail(one.id, TIME_ZONE);
    expect(projection.canonicalTimeZone).toBe('UTC');
    expect(projection.totalMinutes).toBe(detail.totalMinutes);
    expect(projection.currentByDate).toEqual([
      { activityDate: '2026-01-02', minutes: 2 },
      { activityDate: '2026-01-03', minutes: 2 },
    ]);
    const grouped = new Map<string, number>();
    for (const item of detail.items) {
      grouped.set(item.activityDate, (grouped.get(item.activityDate) ?? 0) + item.minutes);
    }
    expect(projection.currentByDate).toEqual(
      [...grouped.entries()]
        .map(([activityDate, minutes]) => ({ activityDate, minutes }))
        .sort((left, right) => left.activityDate.localeCompare(right.activityDate)),
    );

    // The same instants group onto different local dates in another zone;
    // detail and the daily projection stay converged there too.
    const zoned = timeService.getDailyProjection(one.id, 'America/New_York');
    const zonedDetail = timeService.getDetail(one.id, 'America/New_York');
    expect(zoned.canonicalTimeZone).toBe('America/New_York');
    expect(zoned.totalMinutes).toBe(zonedDetail.totalMinutes);
    expect(zoned.currentByDate).toEqual([{ activityDate: '2026-01-02', minutes: 4 }]);
    expect(zoned.currentByDate).not.toEqual(projection.currentByDate);
  });

  async function seedAgent(name: string): Promise<{ id: string }> {
    const provider = await storage.createProvider({ name: `provider-${name}` });
    const profile = await storage.createAgentProfile({
      projectId: project.id,
      name: `profile-${name}`,
    });
    const config = await storage.createProfileProviderConfig({
      profileId: profile.id,
      providerId: provider.id,
      name: `config-${name}`,
    });
    return storage.createAgent({
      projectId: project.id,
      profileId: profile.id,
      providerConfigId: config.id,
      name,
      isProjectOwner: true,
    });
  }
});

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../../common/errors/error-types';
import { DEFAULT_PROJECT_WORKSPACE_ID } from '../db/schema';
import type { Agent, Epic, Project, ProjectWorkspace } from '../models/domain.models';
import { LocalStorageService } from './local-storage.service';

const MIGRATIONS_FOLDER = join(__dirname, '../../../../drizzle');

describe('LocalStorageService Epic relations', () => {
  let sqlite: Database.Database;
  let service: LocalStorageService;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    sqlite.pragma('foreign_keys = ON');
    service = new LocalStorageService(db);
  });

  afterEach(() => sqlite.close());

  async function createWorkspace(name: string): Promise<ProjectWorkspace> {
    return service.createProjectWorkspace(name);
  }

  async function createProject(
    name: string,
    workspaceId = DEFAULT_PROJECT_WORKSPACE_ID,
    isTemplate = false,
  ): Promise<Project> {
    return service.createProject({
      name,
      description: null,
      rootPath: `/tmp/${name.toLowerCase().replaceAll(' ', '-')}`,
      isTemplate,
      workspaceId,
    });
  }

  async function createEpic(projectId: string, title: string, parentId?: string): Promise<Epic> {
    return service.createEpicForProject(projectId, {
      title,
      description: null,
      ...(parentId ? { parentId } : {}),
    });
  }

  async function createAgent(
    projectId: string,
    name: string,
    isProjectOwner = false,
  ): Promise<Agent> {
    const key = name.toLowerCase().replaceAll(' ', '-');
    const provider = await service.createProvider({ name: `provider-${key}` });
    const profile = await service.createAgentProfile({ projectId, name: `profile-${name}` });
    const config = await service.createProfileProviderConfig({
      profileId: profile.id,
      providerId: provider.id,
      name: `config-${name}`,
    });
    return service.createAgent({
      projectId,
      profileId: profile.id,
      providerConfigId: config.id,
      name,
      isProjectOwner,
    });
  }

  function holdTransaction(): { held: Promise<void>; release: () => void } {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { held: service.runInTransaction(async () => gate), release };
  }

  it('stores one canonical pair and maps directed values relative to either focal Epic', async () => {
    const project = await createProject('Canonical');
    const first = await createEpic(project.id, 'First');
    const second = await createEpic(project.id, 'Second');
    const [left, right] = first.id < second.id ? [first, second] : [second, first];

    const leftBlocks = await service.setEpicRelation({
      epicId: left.id,
      relatedEpicId: right.id,
      type: 'blocks',
      createdBy: 'user',
    });
    expect(leftBlocks).toMatchObject({
      leftEpicId: left.id,
      rightEpicId: right.id,
      type: 'blocks',
      direction: 'left_to_right',
      createdBy: 'user',
    });
    expect((await service.listEpicRelations(left.id)).items[0].type).toBe('blocks');
    expect((await service.listEpicRelations(right.id)).items[0].type).toBe('blocked_by');

    const rightBlocks = await service.setEpicRelation({
      epicId: right.id,
      relatedEpicId: left.id,
      type: 'blocks',
    });
    expect(rightBlocks).toMatchObject({
      id: leftBlocks.id,
      direction: 'right_to_left',
      createdBy: 'user',
    });
    expect((await service.listEpicRelations(right.id)).items[0].type).toBe('blocks');
    expect((await service.listEpicRelations(left.id)).items[0].type).toBe('blocked_by');

    const related = await service.setEpicRelation({
      epicId: left.id,
      relatedEpicId: right.id,
      type: 'related',
    });
    expect(related).toMatchObject({
      id: leftBlocks.id,
      type: 'related',
      direction: 'left_to_right',
      sourceEpicId: left.id,
      targetEpicId: right.id,
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM epic_relations').get()).toEqual({
      count: 1,
    });

    const summaries = await service.summarizeEpicRelationsBatch([left.id, right.id, left.id]);
    expect(summaries.get(left.id)).toEqual({
      epicId: left.id,
      related: 1,
      blocks: 0,
      blockedBy: 0,
      total: 1,
      relatedSources: 0,
      relatedTargets: 1,
      relatedNeutral: 0,
    });
    expect(summaries.get(right.id)).toEqual({
      epicId: right.id,
      related: 1,
      blocks: 0,
      blockedBy: 0,
      total: 1,
      relatedSources: 1,
      relatedTargets: 0,
      relatedNeutral: 0,
    });

    await expect(service.deleteEpicRelation(right.id, left.id)).resolves.toMatchObject({
      deleted: true,
    });
    await expect(service.deleteEpicRelation(left.id, right.id)).resolves.toMatchObject({
      deleted: false,
    });
  });

  it('writes Related linkages directionally by endpoint order and derives source and target on reads', async () => {
    const project = await createProject('Direction');
    const first = await createEpic(project.id, 'First');
    const second = await createEpic(project.id, 'Second');
    const [left, right] = first.id < second.id ? [first, second] : [second, first];

    const created = await service.setEpicRelation({
      epicId: left.id,
      relatedEpicId: right.id,
      type: 'related',
      createdBy: 'user',
    });
    expect(created).toMatchObject({
      leftEpicId: left.id,
      rightEpicId: right.id,
      type: 'related',
      direction: 'left_to_right',
      sourceEpicId: left.id,
      targetEpicId: right.id,
      createdBy: 'user',
    });

    // The same pair written from the other endpoint flips the stored direction
    // on the same canonical row: the write's first Epic is always the source.
    // The flip displaces the stored route, so the human confirms its facts.
    const flipped = await service.setEpicRelation({
      epicId: right.id,
      relatedEpicId: left.id,
      type: 'related',
      acceptedRouteEffect: { sourceEpicId: left.id, targetEpicId: right.id },
    });
    expect(flipped).toMatchObject({
      id: created.id,
      direction: 'right_to_left',
      sourceEpicId: right.id,
      targetEpicId: left.id,
      changed: true,
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM epic_relations').get()).toEqual({
      count: 1,
    });

    const listed = await service.listEpicRelations(left.id);
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      epicId: right.id,
      relationId: created.id,
      type: 'related',
      sourceEpicId: right.id,
      targetEpicId: left.id,
    });
    const listedFromTarget = await service.listEpicRelations(right.id);
    expect(listedFromTarget.items[0]).toMatchObject({
      epicId: left.id,
      sourceEpicId: right.id,
      targetEpicId: left.id,
    });

    const unchanged = await service.setEpicRelation({
      epicId: right.id,
      relatedEpicId: left.id,
      type: 'related',
    });
    expect(unchanged).toMatchObject({ changed: false });

    // A Blocks conversion recomputes direction from the Blocks semantic: the
    // source blocks the target. It displaces the flipped route, so the human
    // confirms the current facts.
    const converted = await service.setEpicRelation({
      epicId: left.id,
      relatedEpicId: right.id,
      type: 'blocks',
      acceptedRouteEffect: { sourceEpicId: right.id, targetEpicId: left.id },
    });
    expect(converted).toMatchObject({
      id: created.id,
      type: 'blocks',
      direction: 'left_to_right',
      sourceEpicId: left.id,
      targetEpicId: right.id,
      changed: true,
    });
    expect((await service.listEpicRelations(right.id)).items[0].type).toBe('blocked_by');
  });

  it('tolerates legacy direction none rows on reads without offering none to Related writes', async () => {
    const project = await createProject('Legacy');
    const first = await createEpic(project.id, 'First');
    const second = await createEpic(project.id, 'Second');
    const [left, right] = first.id < second.id ? [first, second] : [second, first];

    // Pre-feature rows may still carry direction 'none'; reads must expose
    // them as neutral rows instead of failing.
    sqlite
      .prepare(
        `INSERT INTO epic_relations (id, left_epic_id, right_epic_id, type, direction, created_at, updated_at)
         VALUES ('legacy-relation', ?, ?, 'related', 'none', ?, ?)`,
      )
      .run(left.id, right.id, new Date().toISOString(), new Date().toISOString());

    const listed = await service.listEpicRelations(left.id);
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      type: 'related',
      sourceEpicId: null,
      targetEpicId: null,
    });

    // Re-writing the legacy pair replaces the neutral direction with the
    // endpoint-order direction; no write path can store 'none' for Related.
    const rewritten = await service.setEpicRelation({
      epicId: left.id,
      relatedEpicId: right.id,
      type: 'related',
    });
    expect(rewritten).toMatchObject({
      id: 'legacy-relation',
      direction: 'left_to_right',
      sourceEpicId: left.id,
      targetEpicId: right.id,
      changed: true,
    });
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM epic_relations WHERE direction = 'none'").get(),
    ).toEqual({ count: 0 });
  });

  it('splits Related batch summaries into directional counts from the stored direction', async () => {
    const project = await createProject('Directional Summary');
    const first = await createEpic(project.id, 'First');
    const second = await createEpic(project.id, 'Second');
    const third = await createEpic(project.id, 'Third');
    // Endpoint order defines direction for Related writes: epicId is the
    // source and relatedEpicId is the target.
    const [a, b, c] = [first, second, third];

    await service.setEpicRelation({ epicId: a.id, relatedEpicId: b.id, type: 'related' });
    let summaries = await service.summarizeEpicRelationsBatch([a.id, b.id]);
    expect(summaries.get(a.id)).toEqual({
      epicId: a.id,
      related: 1,
      blocks: 0,
      blockedBy: 0,
      total: 1,
      relatedSources: 0,
      relatedTargets: 1,
      relatedNeutral: 0,
    });
    expect(summaries.get(b.id)).toEqual({
      epicId: b.id,
      related: 1,
      blocks: 0,
      blockedBy: 0,
      total: 1,
      relatedSources: 1,
      relatedTargets: 0,
      relatedNeutral: 0,
    });

    // The flip displaces the stored route, so the human confirms its facts.
    await service.setEpicRelation({
      epicId: b.id,
      relatedEpicId: a.id,
      type: 'related',
      acceptedRouteEffect: { sourceEpicId: a.id, targetEpicId: b.id },
    });
    summaries = await service.summarizeEpicRelationsBatch([a.id, b.id]);
    expect(summaries.get(a.id)).toMatchObject({
      relatedSources: 1,
      relatedTargets: 0,
      relatedNeutral: 0,
    });
    expect(summaries.get(b.id)).toMatchObject({
      relatedSources: 0,
      relatedTargets: 1,
      relatedNeutral: 0,
    });

    sqlite
      .prepare(
        `INSERT INTO epic_relations (id, left_epic_id, right_epic_id, type, direction, created_at, updated_at)
         VALUES ('legacy-neutral', ?, ?, 'related', 'none', ?, ?)`,
      )
      .run(a.id, c.id, new Date().toISOString(), new Date().toISOString());

    // Epic a now mixes one incoming directed row and one legacy neutral row;
    // every summary keeps related = sources + targets + neutral.
    summaries = await service.summarizeEpicRelationsBatch([a.id, b.id, c.id]);
    expect(summaries.get(a.id)).toEqual({
      epicId: a.id,
      related: 2,
      blocks: 0,
      blockedBy: 0,
      total: 2,
      relatedSources: 1,
      relatedTargets: 0,
      relatedNeutral: 1,
    });
    expect(summaries.get(c.id)).toMatchObject({
      related: 1,
      relatedSources: 0,
      relatedTargets: 0,
      relatedNeutral: 1,
    });
    for (const summary of summaries.values()) {
      expect(summary.related).toBe(
        summary.relatedSources + summary.relatedTargets + summary.relatedNeutral,
      );
    }
  });

  it('returns stable bounded relation pages with exact totals and validates storage bounds', async () => {
    const focalProject = await createProject('Pagination Focal');
    const alphaProject = await createProject('Alpha Page');
    const zuluProject = await createProject('Zulu Page');
    const focal = await createEpic(focalProject.id, 'Focal');
    const alphaAlpha = await createEpic(alphaProject.id, 'Alpha');
    const alphaCharlie = await createEpic(alphaProject.id, 'Charlie');
    const zuluAlpha = await createEpic(zuluProject.id, 'Alpha');
    const zuluBravo = await createEpic(zuluProject.id, 'Bravo');
    for (const target of [zuluBravo, alphaCharlie, zuluAlpha, alphaAlpha]) {
      await service.setEpicRelation({
        epicId: focal.id,
        relatedEpicId: target.id,
        type: 'related',
      });
    }

    await expect(service.listEpicRelations(focal.id)).resolves.toMatchObject({
      items: [
        expect.objectContaining({ epicId: alphaAlpha.id }),
        expect.objectContaining({ epicId: alphaCharlie.id }),
        expect.objectContaining({ epicId: zuluAlpha.id }),
        expect.objectContaining({ epicId: zuluBravo.id }),
      ],
      total: 4,
      limit: 50,
      offset: 0,
    });

    const prepareSpy = jest.spyOn(sqlite, 'prepare');
    const page = await service.listEpicRelations(focal.id, { limit: 2, offset: 1 });
    expect(page).toEqual({
      items: [
        expect.objectContaining({ epicId: alphaCharlie.id }),
        expect.objectContaining({ epicId: zuluAlpha.id }),
      ],
      total: 4,
      limit: 2,
      offset: 1,
    });
    expect(await service.listEpicRelations(focal.id, { limit: 2, offset: 1 })).toEqual(page);
    expect(
      prepareSpy.mock.calls.some(([statement]) =>
        String(statement).includes(
          'ORDER BY lower(project.name), lower(target.title), target.id\n         LIMIT ? OFFSET ?',
        ),
      ),
    ).toBe(true);
    prepareSpy.mockRestore();

    await expect(service.listEpicRelations(focal.id, { limit: 2, offset: 10 })).resolves.toEqual({
      items: [],
      total: 4,
      limit: 2,
      offset: 10,
    });
    await expect(service.listEpicRelations(focal.id, { limit: 0 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(service.listEpicRelations(focal.id, { limit: 101 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(service.listEpicRelations(focal.id, { limit: 1.5 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(service.listEpicRelations(focal.id, { offset: -1 })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('rejects invalid pairs inside the transaction and permits siblings and cross-project peers', async () => {
    const otherWorkspace = await createWorkspace('Other');
    const project = await createProject('Primary');
    const peerProject = await createProject('Peer');
    const foreignProject = await createProject('Foreign', otherWorkspace.id);
    const parent = await createEpic(project.id, 'Parent');
    const child = await createEpic(project.id, 'Child', parent.id);
    const sibling = await createEpic(project.id, 'Sibling', parent.id);
    const peer = await createEpic(peerProject.id, 'Peer Epic');
    const foreign = await createEpic(foreignProject.id, 'Foreign Epic');

    await expect(
      service.setEpicRelation({ epicId: parent.id, relatedEpicId: parent.id, type: 'related' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.setEpicRelation({ epicId: parent.id, relatedEpicId: child.id, type: 'related' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.setEpicRelation({ epicId: parent.id, relatedEpicId: 'missing', type: 'related' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      service.setEpicRelation({ epicId: parent.id, relatedEpicId: foreign.id, type: 'related' }),
    ).rejects.toBeInstanceOf(NotFoundError);

    await expect(
      service.setEpicRelation({ epicId: child.id, relatedEpicId: sibling.id, type: 'related' }),
    ).resolves.toBeDefined();
    await expect(
      service.setEpicRelation({ epicId: parent.id, relatedEpicId: peer.id, type: 'blocks' }),
    ).resolves.toBeDefined();

    const unrelated = await createEpic(project.id, 'Unrelated');
    await service.setEpicRelation({
      epicId: child.id,
      relatedEpicId: unrelated.id,
      type: 'related',
    });
    await expect(
      service.updateEpic(unrelated.id, { parentId: child.id }, unrelated.version),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('joins an owning transaction so composite creation can roll back the relation', async () => {
    const project = await createProject('Atomic');
    const first = await createEpic(project.id, 'First');
    const second = await createEpic(project.id, 'Second');

    await expect(
      service.runInTransaction(async () => {
        await service.setEpicRelation({
          epicId: first.id,
          relatedEpicId: second.id,
          type: 'related',
        });
        throw new Error('rollback composite relation');
      }),
    ).rejects.toThrow('rollback composite relation');
    expect(sqlite.prepare('SELECT * FROM epic_relations').all()).toEqual([]);
  });

  it('bounds and filters candidates while resolving workspace UUID prefixes', async () => {
    const otherWorkspace = await createWorkspace('Other');
    const project = await createProject('Primary');
    const peerProject = await createProject('Peer');
    const templateProject = await createProject('Template', DEFAULT_PROJECT_WORKSPACE_ID, true);
    const foreignProject = await createProject('Foreign', otherWorkspace.id);
    const parent = await createEpic(project.id, 'Parent');
    const focal = await createEpic(project.id, 'Focal', parent.id);
    const sibling = await createEpic(project.id, 'Sibling', parent.id);
    const peer = await createEpic(peerProject.id, 'Peer Candidate');
    const template = await createEpic(templateProject.id, 'Template Candidate');
    const foreign = await createEpic(foreignProject.id, 'Foreign Candidate');
    await service.setEpicRelation({ epicId: focal.id, relatedEpicId: sibling.id, type: 'related' });

    const candidates = await service.listEpicRelationCandidates(focal.id, {
      q: 'candidate',
      limit: 10,
    });
    expect(candidates.items.map((candidate) => candidate.id)).toEqual([peer.id]);
    expect(candidates.total).toBe(1);
    expect(candidates.items.map((candidate) => candidate.id)).not.toEqual(
      expect.arrayContaining([focal.id, parent.id, sibling.id, template.id, foreign.id]),
    );

    expect(await service.getWorkspaceEpicsByIdPrefix(focal.id, peer.id.slice(0, 8))).toEqual([
      expect.objectContaining({ id: peer.id, projectId: peerProject.id }),
    ]);
    expect(await service.getWorkspaceEpicsByIdPrefix(focal.id, template.id.slice(0, 8))).toEqual(
      [],
    );
    expect(await service.getWorkspaceEpicsByIdPrefix(focal.id, foreign.id.slice(0, 8))).toEqual([]);
    expect(await service.getWorkspaceEpicsByIdPrefix(focal.id, '%wildcard')).toEqual([]);
    await expect(
      service.listEpicRelations(focal.id, { workspaceId: otherWorkspace.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      service.listEpicRelationCandidates(focal.id, { workspaceId: otherWorkspace.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(
      await service.summarizeEpicRelationsBatch([focal.id], {
        workspaceId: otherWorkspace.id,
      }),
    ).toEqual(new Map());
    await expect(
      service.listEpicRelationCandidates(focal.id, { limit: 101 }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.summarizeEpicRelationsBatch(
        Array.from({ length: 1001 }, (_, index) => `id-${index}`),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('filters MCP-hidden targets from lists, candidates, and one-read batch totals', async () => {
    const project = await createProject('Visibility');
    const focal = await createEpic(project.id, 'Focal');
    const visible = await createEpic(project.id, 'Visible');
    const hidden = await createEpic(project.id, 'Hidden');
    const hiddenCandidate = await createEpic(project.id, 'Hidden Candidate');
    const hiddenStatus = await service.createStatus({
      projectId: project.id,
      label: 'MCP Hidden',
      color: '#111111',
      position: 20,
      mcpHidden: true,
    });
    await service.updateEpic(hidden.id, { statusId: hiddenStatus.id }, hidden.version);
    await service.updateEpic(
      hiddenCandidate.id,
      { statusId: hiddenStatus.id },
      hiddenCandidate.version,
    );
    await service.setEpicRelation({
      epicId: focal.id,
      relatedEpicId: visible.id,
      type: 'related',
    });
    await service.setEpicRelation({
      epicId: focal.id,
      relatedEpicId: hidden.id,
      type: 'blocks',
    });

    expect(await service.listEpicRelations(focal.id)).toMatchObject({
      total: 2,
      limit: 50,
      offset: 0,
    });
    expect(
      await service.listEpicRelations(focal.id, {
        excludeMcpHidden: true,
        limit: 1,
        offset: 0,
      }),
    ).toEqual({
      items: [expect.objectContaining({ epicId: visible.id, statusMcpHidden: false })],
      total: 1,
      limit: 1,
      offset: 0,
    });
    expect(
      await service.listEpicRelationCandidates(focal.id, {
        q: 'hidden candidate',
        excludeMcpHidden: true,
      }),
    ).toMatchObject({ items: [], total: 0 });

    const prepareSpy = jest.spyOn(sqlite, 'prepare');
    const all = await service.summarizeEpicRelationsBatch([focal.id]);
    expect(all.get(focal.id)).toMatchObject({ related: 1, blocks: 1, total: 2 });
    expect(
      prepareSpy.mock.calls.filter(([statement]) => String(statement).includes('WITH requested')),
    ).toHaveLength(1);
    prepareSpy.mockClear();
    const visibleOnly = await service.summarizeEpicRelationsBatch([focal.id], {
      excludeMcpHidden: true,
    });
    expect(visibleOnly.get(focal.id)).toEqual({
      epicId: focal.id,
      related: 1,
      blocks: 0,
      blockedBy: 0,
      total: 1,
      relatedSources: 0,
      relatedTargets: 1,
      relatedNeutral: 0,
    });
    expect(
      prepareSpy.mock.calls.filter(([statement]) => String(statement).includes('WITH requested')),
    ).toHaveLength(1);
    prepareSpy.mockRestore();
  });

  it('rechecks current project membership and ownership inside queued relation writes', async () => {
    const foreignWorkspace = await createWorkspace('Foreign Workspace');
    const focalProject = await createProject('Auth Focal');
    const peerProject = await createProject('Auth Peer');
    const foreignProject = await createProject('Auth Foreign', foreignWorkspace.id);
    const focal = await createEpic(focalProject.id, 'Focal');
    const sameProject = await createEpic(focalProject.id, 'Same Project');
    const peer = await createEpic(peerProject.id, 'Peer');
    const foreign = await createEpic(foreignProject.id, 'Foreign');
    const owner = await createAgent(focalProject.id, 'Owner', true);
    const member = await createAgent(focalProject.id, 'Member');
    const peerAgent = await createAgent(peerProject.id, 'Peer Agent');

    await expect(
      service.setEpicRelation(
        { epicId: focal.id, relatedEpicId: sameProject.id, type: 'related' },
        { actor: { type: 'agent', id: member.id } },
      ),
    ).resolves.toMatchObject({ changed: true });
    await expect(
      service.setEpicRelation(
        { epicId: focal.id, relatedEpicId: peer.id, type: 'related' },
        { actor: { type: 'agent', id: member.id } },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      service.setEpicRelation(
        { epicId: focal.id, relatedEpicId: peer.id, type: 'related' },
        { actor: { type: 'agent', id: peerAgent.id } },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      service.setEpicRelation(
        { epicId: focal.id, relatedEpicId: peer.id, type: 'related' },
        { actor: { type: 'guest', id: 'guest-1' } },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const held = holdTransaction();
    const revoke = service.updateAgent(owner.id, { isProjectOwner: false });
    const pendingWrite = service.setEpicRelation(
      { epicId: focal.id, relatedEpicId: peer.id, type: 'blocks' },
      { actor: { type: 'agent', id: owner.id } },
    );
    held.release();
    await held.held;
    await expect(revoke).resolves.toMatchObject({ isProjectOwner: false });
    await expect(pendingWrite).rejects.toBeInstanceOf(ForbiddenError);

    const missing = service.setEpicRelation({
      epicId: focal.id,
      relatedEpicId: 'missing-target',
      type: 'related',
    });
    const outOfWorkspace = service.setEpicRelation({
      epicId: focal.id,
      relatedEpicId: foreign.id,
      type: 'related',
    });
    await expect(missing).rejects.toThrow('Related Epic not found');
    await expect(outOfWorkspace).rejects.toThrow('Related Epic not found');
  });

  it('guards individual workspace moves but allows same-project and complete-workspace moves', async () => {
    const target = await createWorkspace('Target');
    const source = await createWorkspace('Source');
    const sameProject = await createProject('Same Project');
    const sameA = await createEpic(sameProject.id, 'Same A');
    const sameB = await createEpic(sameProject.id, 'Same B');
    await service.setEpicRelation({ epicId: sameA.id, relatedEpicId: sameB.id, type: 'related' });
    await expect(
      service.updateProject(sameProject.id, { workspaceId: target.id }),
    ).resolves.toMatchObject({ workspaceId: target.id });

    const crossAProject = await createProject('Cross A');
    const crossBProject = await createProject('Cross B');
    const crossA = await createEpic(crossAProject.id, 'Cross A');
    const crossB = await createEpic(crossBProject.id, 'Cross B');
    await service.setEpicRelation({ epicId: crossA.id, relatedEpicId: crossB.id, type: 'related' });
    await expect(
      service.updateProject(crossAProject.id, { workspaceId: target.id }),
    ).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'PROJECT_WORKSPACE_RELATION_CONFLICT' }),
    });

    const sourceAProject = await createProject('Source A', source.id);
    const sourceBProject = await createProject('Source B', source.id);
    const sourceA = await createEpic(sourceAProject.id, 'Source A');
    const sourceB = await createEpic(sourceBProject.id, 'Source B');
    await service.setEpicRelation({
      epicId: sourceA.id,
      relatedEpicId: sourceB.id,
      type: 'blocks',
    });
    await expect(service.deleteProjectWorkspace(source.id, target.id)).resolves.toMatchObject({
      movedProjectCount: 2,
    });
    expect((await service.getProject(sourceAProject.id)).workspaceId).toBe(target.id);
    expect((await service.getProject(sourceBProject.id)).workspaceId).toBe(target.id);
    expect((await service.listEpicRelations(sourceA.id)).items).toHaveLength(1);
  });

  it('serializes relation creation against project moves in either queue order', async () => {
    const target = await createWorkspace('Target');
    const projectA = await createProject('Race A');
    const projectB = await createProject('Race B');
    const epicA = await createEpic(projectA.id, 'Race A');
    const epicB = await createEpic(projectB.id, 'Race B');
    const firstGate = holdTransaction();
    const relationFirst = service.setEpicRelation({
      epicId: epicA.id,
      relatedEpicId: epicB.id,
      type: 'related',
    });
    const moveSecond = service.updateProject(projectA.id, { workspaceId: target.id });
    firstGate.release();
    await firstGate.held;
    await expect(relationFirst).resolves.toBeDefined();
    await expect(moveSecond).rejects.toBeInstanceOf(ConflictError);
    expect((await service.getProject(projectA.id)).workspaceId).toBe(DEFAULT_PROJECT_WORKSPACE_ID);

    await service.deleteEpicRelation(epicA.id, epicB.id);
    const projectC = await createProject('Race C');
    const projectD = await createProject('Race D');
    const epicC = await createEpic(projectC.id, 'Race C');
    const epicD = await createEpic(projectD.id, 'Race D');
    const secondGate = holdTransaction();
    const moveFirst = service.updateProject(projectC.id, { workspaceId: target.id });
    const relationSecond = service.setEpicRelation({
      epicId: epicC.id,
      relatedEpicId: epicD.id,
      type: 'related',
    });
    secondGate.release();
    await secondGate.held;
    await expect(moveFirst).resolves.toMatchObject({ workspaceId: target.id });
    await expect(relationSecond).rejects.toBeInstanceOf(NotFoundError);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM epic_relations').get()).toEqual({
      count: 0,
    });
  });

  describe('eligible time-route ownership', () => {
    function routeFrom(
      source: Epic,
      target: Epic,
      options: {
        acceptedRouteEffect?: { sourceEpicId: string; targetEpicId: string };
        actor?: Agent;
      } = {},
    ) {
      return service.setEpicRelation(
        {
          epicId: source.id,
          relatedEpicId: target.id,
          type: 'related',
          createdBy: options.actor ? 'agent' : 'user',
          createdByAgentId: options.actor?.id ?? null,
          acceptedRouteEffect: options.acceptedRouteEffect,
        },
        options.actor
          ? { actor: { type: 'agent', id: options.actor.id } }
          : { trustedLocalHuman: true },
      );
    }

    function storedPair(source: Epic, target: Epic) {
      const [left, right] = source.id < target.id ? [source.id, target.id] : [target.id, source.id];
      return sqlite
        .prepare('SELECT * FROM epic_relations WHERE left_epic_id = ? AND right_epic_id = ?')
        .get(left, right) as
        | {
            id: string;
            type: string;
            direction: string;
            created_by: string | null;
            created_at: string;
            updated_at: string;
          }
        | undefined;
    }

    function confirmationFacts(source: Epic, target: Epic) {
      return { sourceEpicId: source.id, targetEpicId: target.id };
    }

    it('keeps child and cross-project Related linkages directional without consuming route ownership', async () => {
      const project = await createProject('Ownership');
      const otherProject = await createProject('Ownership Peer');
      const parent = await createEpic(project.id, 'Parent');
      const child = await createEpic(project.id, 'Child', parent.id);
      const root = await createEpic(project.id, 'Root');
      const secondRoot = await createEpic(project.id, 'Second Root');
      const foreign = await createEpic(otherProject.id, 'Foreign');

      const childLink = await routeFrom(child, root);
      expect(childLink).toMatchObject({
        type: 'related',
        sourceEpicId: child.id,
        targetEpicId: root.id,
      });
      const crossLink = await routeFrom(root, foreign);
      expect(crossLink).toMatchObject({
        type: 'related',
        sourceEpicId: root.id,
        targetEpicId: foreign.id,
      });

      // Neither ineligible link owns root's eligible outgoing target, so a
      // root-to-root route needs no displacement confirmation.
      const eligible = await routeFrom(root, secondRoot);
      expect(eligible).toMatchObject({
        changed: true,
        sourceEpicId: root.id,
        targetEpicId: secondRoot.id,
      });
      expect(storedPair(child, root)?.direction).not.toBe('none');
      expect(storedPair(root, foreign)?.direction).not.toBe('none');

      // Flipping an ineligible pair is a plain directional update.
      const flipped = await routeFrom(root, child);
      expect(flipped).toMatchObject({
        id: childLink.id,
        sourceEpicId: root.id,
        targetEpicId: child.id,
        changed: true,
      });
    });

    it('requires current accepted facts for human replacement and deletes the displaced pair', async () => {
      const project = await createProject('Replacement');
      const a = await createEpic(project.id, 'A');
      const b = await createEpic(project.id, 'B');
      const c = await createEpic(project.id, 'C');
      await routeFrom(a, b);
      const original = storedPair(a, b);

      await expect(routeFrom(a, c)).rejects.toMatchObject({
        code: 'relation_confirmation_required',
        details: { currentEffect: confirmationFacts(a, b) },
      });

      const replaced = await routeFrom(a, c, { acceptedRouteEffect: confirmationFacts(a, b) });
      expect(replaced).toMatchObject({
        changed: true,
        sourceEpicId: a.id,
        targetEpicId: c.id,
      });
      // The confirmed replacement deletes the old Related pair; it cannot stay
      // behind as a plain link because every Related pair is directional.
      expect(storedPair(a, b)).toBeUndefined();
      expect(original).toMatchObject({ created_by: 'user' });
      const newRow = storedPair(a, c);
      expect(newRow).toMatchObject({ type: 'related', created_by: 'user' });
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM epic_relations').get()).toEqual({
        count: 1,
      });

      // Stale accepted facts are rechecked against current state: a's route
      // changed, so the old facts no longer authorize a second displacement.
      await expect(
        routeFrom(a, b, { acceptedRouteEffect: confirmationFacts(a, b) }),
      ).rejects.toMatchObject({
        code: 'relation_confirmation_required',
        details: { currentEffect: confirmationFacts(a, c) },
      });
    });

    it('refuses silent agent replacement and accepts it after an explicit delete', async () => {
      const project = await createProject('Agent Replace');
      const a = await createEpic(project.id, 'A');
      const b = await createEpic(project.id, 'B');
      const c = await createEpic(project.id, 'C');
      const agent = await createAgent(project.id, 'Routed Agent');
      await routeFrom(a, b);

      await expect(routeFrom(a, c, { actor: agent })).rejects.toMatchObject({
        code: 'relation_confirmation_required',
        details: { currentEffect: confirmationFacts(a, b) },
      });
      expect(storedPair(a, b)).toBeDefined();

      // Explicit pair deletion is the one unconfirmed way to remove a pair —
      // for agents and humans alike.
      await expect(service.deleteEpicRelation(a.id, b.id)).resolves.toMatchObject({
        deleted: true,
      });
      await expect(routeFrom(a, c, { actor: agent })).resolves.toMatchObject({
        sourceEpicId: a.id,
        targetEpicId: c.id,
      });
    });

    it('flips direction on the same canonical pair after confirmation', async () => {
      const project = await createProject('Flip');
      const a = await createEpic(project.id, 'A');
      const b = await createEpic(project.id, 'B');
      const created = await routeFrom(a, b);

      await expect(routeFrom(b, a)).rejects.toMatchObject({
        code: 'relation_confirmation_required',
        details: { currentEffect: confirmationFacts(a, b) },
      });

      const flipped = await routeFrom(b, a, { acceptedRouteEffect: confirmationFacts(a, b) });
      expect(flipped).toMatchObject({
        id: created.id,
        changed: true,
        sourceEpicId: b.id,
        targetEpicId: a.id,
      });
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM epic_relations').get()).toEqual({
        count: 1,
      });
    });

    it('rejects a combined flip-plus-replacement that would displace two routes', async () => {
      const project = await createProject('Double');
      const a = await createEpic(project.id, 'A');
      const b = await createEpic(project.id, 'B');
      const c = await createEpic(project.id, 'C');
      await routeFrom(a, b);
      await routeFrom(b, c);

      // Flipping a→b makes b the source while b already routes to c: one
      // accepted-effect fact can never cover both displaced routes.
      await expect(
        routeFrom(b, a, { acceptedRouteEffect: confirmationFacts(a, b) }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(storedPair(a, b)).toMatchObject({ type: 'related' });
      expect(storedPair(b, c)).toMatchObject({ type: 'related' });
    });

    it('rejects eligible route cycles while ineligible links never join the walk', async () => {
      const project = await createProject('Triangle');
      const a = await createEpic(project.id, 'A');
      const b = await createEpic(project.id, 'B');
      const c = await createEpic(project.id, 'C');
      const parent = await createEpic(project.id, 'Parent');
      const child = await createEpic(project.id, 'Child', parent.id);
      await routeFrom(a, b);
      await routeFrom(b, c);

      await expect(routeFrom(c, a)).rejects.toBeInstanceOf(ValidationError);

      // A child endpoint makes the closing edge ineligible: the pair stays a
      // valid plain link and contributes no time-route edge.
      await expect(routeFrom(c, child)).resolves.toMatchObject({
        sourceEpicId: c.id,
        targetEpicId: child.id,
      });
    });

    it('confirms Blocks conversion of a routed pair and frees the source ownership', async () => {
      const project = await createProject('Blocks Guard');
      const a = await createEpic(project.id, 'A');
      const b = await createEpic(project.id, 'B');
      const d = await createEpic(project.id, 'D');
      await routeFrom(a, b);

      await expect(
        service.setEpicRelation({
          epicId: a.id,
          relatedEpicId: b.id,
          type: 'blocks',
          createdBy: 'user',
        }),
      ).rejects.toMatchObject({
        code: 'relation_confirmation_required',
        details: { currentEffect: confirmationFacts(a, b) },
      });

      const converted = await service.setEpicRelation({
        epicId: a.id,
        relatedEpicId: b.id,
        type: 'blocks',
        createdBy: 'user',
        acceptedRouteEffect: confirmationFacts(a, b),
      });
      expect(converted).toMatchObject({
        type: 'blocks',
        sourceEpicId: a.id,
        targetEpicId: b.id,
      });
      expect(storedPair(a, b)).toMatchObject({ type: 'blocks' });

      // The Blocks row owns no route: a may route to another root without
      // confirmation.
      await expect(routeFrom(a, d)).resolves.toMatchObject({
        sourceEpicId: a.id,
        targetEpicId: d.id,
      });
    });

    it('blocks reparenting of an eligible route endpoint until the pair is deleted', async () => {
      const project = await createProject('Reparent');
      const a = await createEpic(project.id, 'A');
      const b = await createEpic(project.id, 'B');
      const newParent = await createEpic(project.id, 'New Parent');
      const parent = await createEpic(project.id, 'Parent');
      const child = await createEpic(project.id, 'Child', parent.id);
      const peer = await createEpic(project.id, 'Peer');
      await routeFrom(a, b);

      const current = await service.getEpic(a.id);
      await expect(
        service.updateEpic(a.id, { parentId: newParent.id }, current.version),
      ).rejects.toBeInstanceOf(ValidationError);

      await service.deleteEpicRelation(a.id, b.id);
      const cleared = await service.getEpic(a.id);
      await expect(
        service.updateEpic(a.id, { parentId: newParent.id }, cleared.version),
      ).resolves.toMatchObject({ parentId: newParent.id });

      // Ineligible links never block reparenting.
      await routeFrom(child, peer);
      const childCurrent = await service.getEpic(child.id);
      await expect(
        service.updateEpic(child.id, { parentId: newParent.id }, childCurrent.version),
      ).resolves.toMatchObject({ parentId: newParent.id });
    });

    it('serializes route ownership against reparenting in queue order', async () => {
      const project = await createProject('Ownership Race');
      const a = await createEpic(project.id, 'A');
      const b = await createEpic(project.id, 'B');
      const c = await createEpic(project.id, 'C');
      const parent = await createEpic(project.id, 'Race Parent');
      await routeFrom(a, b);

      const firstGate = holdTransaction();
      const replacement = routeFrom(a, c, { acceptedRouteEffect: confirmationFacts(a, b) });
      const reparentSecond = (async () => {
        const current = await service.getEpic(a.id);
        return service.updateEpic(a.id, { parentId: parent.id }, current.version);
      })();
      firstGate.release();
      await firstGate.held;
      await expect(replacement).resolves.toBeDefined();
      await expect(reparentSecond).rejects.toBeInstanceOf(ValidationError);

      const secondGate = holdTransaction();
      const deleteFirst = service.deleteEpicRelation(a.id, c.id);
      const reparentAfter = (async () => {
        const current = await service.getEpic(a.id);
        return service.updateEpic(a.id, { parentId: parent.id }, current.version);
      })();
      secondGate.release();
      await secondGate.held;
      // FIFO admission runs the queued delete before the reparent, so both
      // succeed in this order; the reverse order is the rejection above.
      await expect(deleteFirst).resolves.toMatchObject({ deleted: true });
      await expect(reparentAfter).resolves.toMatchObject({ parentId: parent.id });
    });
  });

  describe('promotion route validation', () => {
    function link(source: Epic, target: Epic): Promise<unknown> {
      // A plain directional write; while the source or target is a child the
      // pair stays ineligible and consumes no route ownership.
      return service.setEpicRelation({
        epicId: source.id,
        relatedEpicId: target.id,
        type: 'related',
        createdBy: 'user',
      });
    }

    async function promote(epic: Epic): Promise<unknown> {
      const current = await service.getEpic(epic.id);
      return service.updateEpic(epic.id, { parentId: null }, current.version);
    }

    it('permits promotion when exactly one outgoing route becomes eligible', async () => {
      const project = await createProject('Promote One');
      const parent = await createEpic(project.id, 'Parent');
      const child = await createEpic(project.id, 'Child', parent.id);
      const root = await createEpic(project.id, 'Root');
      await link(child, root);

      await expect(promote(child)).resolves.toMatchObject({ parentId: null });
      // The link needs no rewrite: eligibility is derived from Epic rows.
      expect(storedPairIds(child, root)).toMatchObject({ type: 'related' });
    });

    it('rejects promotion that activates two outgoing eligible targets', async () => {
      const project = await createProject('Promote Two');
      const parent = await createEpic(project.id, 'Parent');
      const child = await createEpic(project.id, 'Child', parent.id);
      const first = await createEpic(project.id, 'First');
      const second = await createEpic(project.id, 'Second');
      await link(child, first);
      await link(child, second);

      await expect(promote(child)).rejects.toBeInstanceOf(ValidationError);
      const after = await service.getEpic(child.id);
      expect(after.parentId).toBe(parent.id);
    });

    it('rejects promotion that completes a route cycle', async () => {
      const project = await createProject('Promote Cycle');
      const parent = await createEpic(project.id, 'Parent');
      const child = await createEpic(project.id, 'Child', parent.id);
      const a = await createEpic(project.id, 'A');
      const b = await createEpic(project.id, 'B');
      await link(a, b);
      await link(b, child);
      await link(child, a);

      await expect(promote(child)).rejects.toBeInstanceOf(ValidationError);
      const after = await service.getEpic(child.id);
      expect(after.parentId).toBe(parent.id);
    });

    it('rejects promotion that would give an already-routing source a second target', async () => {
      const project = await createProject('Promote Second');
      const parent = await createEpic(project.id, 'Parent');
      const child = await createEpic(project.id, 'Child', parent.id);
      const source = await createEpic(project.id, 'Source');
      const routed = await createEpic(project.id, 'Routed');
      await link(source, routed);
      await link(source, child);

      await expect(promote(child)).rejects.toBeInstanceOf(ValidationError);
      const after = await service.getEpic(child.id);
      expect(after.parentId).toBe(parent.id);
    });

    it('keeps child-to-child moves valid while routes stay ineligible', async () => {
      const project = await createProject('Child Move');
      const firstParent = await createEpic(project.id, 'First Parent');
      const secondParent = await createEpic(project.id, 'Second Parent');
      const child = await createEpic(project.id, 'Child', firstParent.id);
      const peer = await createEpic(project.id, 'Peer', secondParent.id);
      await link(child, peer);

      const current = await service.getEpic(child.id);
      await expect(
        service.updateEpic(child.id, { parentId: secondParent.id }, current.version),
      ).resolves.toMatchObject({ parentId: secondParent.id });
    });

    it('does not block promotion when the activated links stay cross-project', async () => {
      const project = await createProject('Promote Cross');
      const otherProject = await createProject('Promote Cross Peer');
      const parent = await createEpic(project.id, 'Parent');
      const child = await createEpic(project.id, 'Child', parent.id);
      const foreign = await createEpic(otherProject.id, 'Foreign');
      await link(child, foreign);

      await expect(promote(child)).resolves.toMatchObject({ parentId: null });
    });

    it('converges to one valid state across route-write and promotion queue orders', async () => {
      const project = await createProject('Promote Race A');
      const parent = await createEpic(project.id, 'Parent');
      const source = await createEpic(project.id, 'Source');
      const routed = await createEpic(project.id, 'Routed');
      const child = await createEpic(project.id, 'Child', parent.id);
      await link(source, routed);

      // Route write first: the link lands as a plain ineligible pair, then
      // the promotion is rejected because the source would hold two targets.
      const firstGate = holdTransaction();
      const writeFirst = link(source, child);
      const promoteSecond = promote(child);
      firstGate.release();
      await firstGate.held;
      await expect(writeFirst).resolves.toBeDefined();
      await expect(promoteSecond).rejects.toBeInstanceOf(ValidationError);
      expect((await service.getEpic(child.id)).parentId).toBe(parent.id);

      // Promotion first: the child has no activated duplicate, so it becomes
      // a root, and the later route write is refused as a displacement that
      // no human has confirmed. The version is read before the gate so the
      // promotion queues ahead of the link write.
      const secondProject = await createProject('Promote Race B');
      const secondParent = await createEpic(secondProject.id, 'Parent');
      const secondSource = await createEpic(secondProject.id, 'Source');
      const secondRouted = await createEpic(secondProject.id, 'Routed');
      const secondChild = await createEpic(secondProject.id, 'Child', secondParent.id);
      await link(secondSource, secondRouted);
      const childVersion = (await service.getEpic(secondChild.id)).version;

      const secondGate = holdTransaction();
      const promoteFirst = service.updateEpic(secondChild.id, { parentId: null }, childVersion);
      const writeSecond = link(secondSource, secondChild);
      secondGate.release();
      await secondGate.held;
      await expect(promoteFirst).resolves.toMatchObject({ parentId: null });
      await expect(writeSecond).rejects.toMatchObject({
        code: 'relation_confirmation_required',
        details: {
          currentEffect: { sourceEpicId: secondSource.id, targetEpicId: secondRouted.id },
        },
      });
      expect((await service.getEpic(secondChild.id)).parentId).toBeNull();
    });

    function storedPairIds(a: Epic, b: Epic): { type: string } {
      const [left, right] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
      return sqlite
        .prepare('SELECT type FROM epic_relations WHERE left_epic_id = ? AND right_epic_id = ?')
        .get(left, right) as { type: string };
    }
  });
});

import { ValidationError } from '../../../common/errors/error-types';
import { createTestDatabase } from '../../../common/test/test-database.helper';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { Agent, Project } from '../models/domain.models';
import { LocalStorageService } from './local-storage.service';

describe('LocalStorageService - synchronous transaction atomicity', () => {
  let sqlite: Database.Database;
  let service: LocalStorageService;

  beforeEach(() => {
    sqlite = createTestDatabase().sqlite;
    const db = drizzle(sqlite);
    sqlite.pragma('foreign_keys = ON');
    service = new LocalStorageService(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  async function createProject(name = `Project-${randomUUID()}`): Promise<Project> {
    return service.createProject({
      name,
      description: null,
      rootPath: `/tmp/${name}`,
      isTemplate: false,
    });
  }

  async function createAgent(projectId: string, name: string): Promise<Agent> {
    const provider = await service.createProvider({ name: `provider-${name}` });
    const profile = await service.createAgentProfile({
      projectId,
      name: `profile-${name}`,
    });
    const config = await service.createProfileProviderConfig({
      profileId: profile.id,
      providerId: provider.id,
      name: `config-${name}`,
      options: null,
      env: null,
    });
    return service.createAgent({
      projectId,
      profileId: profile.id,
      providerConfigId: config.id,
      name,
    });
  }

  function insertSession(id: string, agentId: string, status: 'stopped' | 'failed'): void {
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO sessions (
           id, agent_id, tmux_session_id, status, started_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, agentId, `tmux-${id}`, status, now, now, now);
  }

  function insertSkill(id: string, sourceName: string): void {
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO skills (id, slug, name, display_name, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, `${sourceName}/${id}`, id, id, sourceName, now, now);
  }

  it('should rollback all create-core changes when runInTransaction fails', async () => {
    await expect(
      service.runInTransaction(async () => {
        const project = await service.createProjectShell({
          name: 'Rollback Test Project',
          description: 'Should not persist',
          rootPath: '/test/rollback',
          isTemplate: false,
        });
        await service.createStatus({
          projectId: project.id,
          label: 'Backlog',
          color: '#6c757d',
          position: 0,
        });
        await service.createPrompt({
          projectId: project.id,
          title: 'Test Prompt',
          content: 'Test content',
          tags: [],
        });
        await service.createAgentProfile({
          projectId: project.id,
          name: 'Test Profile',
          familySlug: null,
          systemPrompt: null,
          instructions: null,
          temperature: null,
          maxTokens: null,
        });

        throw new ValidationError('Profile mapping missing for agent Test Agent');
      }),
    ).rejects.toThrow(ValidationError);

    const projects = sqlite.prepare('SELECT * FROM projects').all();
    expect(projects).toHaveLength(0);

    const statuses = sqlite.prepare('SELECT * FROM statuses').all();
    expect(statuses).toHaveLength(0);

    const prompts = sqlite.prepare('SELECT * FROM prompts').all();
    expect(prompts).toHaveLength(0);

    const profiles = sqlite.prepare('SELECT * FROM agent_profiles').all();
    expect(profiles).toHaveLength(0);

    const agents = sqlite.prepare('SELECT * FROM agents').all();
    expect(agents).toHaveLength(0);
  });

  it('rolls back a project and preceding default statuses when status creation fails', async () => {
    sqlite.exec(`
      CREATE TRIGGER fail_review_status_insert
      BEFORE INSERT ON statuses
      WHEN NEW.label = 'Review'
      BEGIN
        SELECT RAISE(FAIL, 'injected status failure');
      END;
    `);

    await expect(createProject('Failing-Project')).rejects.toThrow('injected status failure');

    expect(sqlite.prepare('SELECT * FROM projects').all()).toEqual([]);
    expect(sqlite.prepare('SELECT * FROM statuses').all()).toEqual([]);
  });

  it('rolls back community source cleanup when enablement deletion fails', async () => {
    const source = await service.createCommunitySkillSource({
      name: 'community-source',
      repoOwner: 'owner',
      repoName: 'community-repo',
      branch: 'main',
    });
    await createProject('Community-Project');
    insertSkill('community-skill', source.name);

    sqlite.exec(`
      CREATE TRIGGER fail_community_enablement_delete
      BEFORE DELETE ON source_project_enabled
      WHEN OLD.source_name = 'community-source'
      BEGIN
        SELECT RAISE(FAIL, 'injected community enablement failure');
      END;
    `);

    await expect(service.deleteCommunitySkillSource(source.id)).rejects.toThrow(
      'injected community enablement failure',
    );

    expect(
      sqlite.prepare('SELECT id FROM community_skill_sources WHERE id = ?').get(source.id),
    ).toBeDefined();
    expect(
      sqlite.prepare('SELECT id FROM skills WHERE id = ?').get('community-skill'),
    ).toBeDefined();
    expect(
      sqlite
        .prepare('SELECT id FROM source_project_enabled WHERE source_name = ?')
        .get(source.name),
    ).toBeDefined();
  });

  it('rolls back local source cleanup when enablement deletion fails', async () => {
    const source = await service.createLocalSkillSource({
      name: 'local-source',
      folderPath: '/tmp/local-source',
    });
    await createProject('Local-Project');
    insertSkill('local-skill', source.name);

    sqlite.exec(`
      CREATE TRIGGER fail_local_enablement_delete
      BEFORE DELETE ON source_project_enabled
      WHEN OLD.source_name = 'local-source'
      BEGIN
        SELECT RAISE(FAIL, 'injected local enablement failure');
      END;
    `);

    await expect(service.deleteLocalSkillSource(source.id)).rejects.toThrow(
      'injected local enablement failure',
    );

    expect(
      sqlite.prepare('SELECT id FROM local_skill_sources WHERE id = ?').get(source.id),
    ).toBeDefined();
    expect(sqlite.prepare('SELECT id FROM skills WHERE id = ?').get('local-skill')).toBeDefined();
    expect(
      sqlite
        .prepare('SELECT id FROM source_project_enabled WHERE source_name = ?')
        .get(source.name),
    ).toBeDefined();
  });

  it('restores prior profile prompts when replacement insertion fails', async () => {
    const project = await createProject('Prompt-Project');
    const profile = await service.createAgentProfile({
      projectId: project.id,
      name: 'Prompt Profile',
    });
    const originalPrompt = await service.createPrompt({
      projectId: project.id,
      title: 'Original Prompt',
      content: 'original',
      tags: [],
    });
    const replacementPrompt = await service.createPrompt({
      projectId: project.id,
      title: 'Replacement Prompt',
      content: 'replacement',
      tags: [],
    });
    await service.setAgentProfilePrompts(profile.id, [originalPrompt.id]);

    sqlite.exec(`
      CREATE TRIGGER fail_replacement_prompt_insert
      BEFORE INSERT ON agent_profile_prompts
      WHEN NEW.prompt_id = '${replacementPrompt.id}'
      BEGIN
        SELECT RAISE(FAIL, 'injected prompt assignment failure');
      END;
    `);

    await expect(
      service.setAgentProfilePrompts(profile.id, [replacementPrompt.id]),
    ).rejects.toThrow('injected prompt assignment failure');

    const assignments = sqlite
      .prepare(
        'SELECT prompt_id FROM agent_profile_prompts WHERE profile_id = ? ORDER BY created_at',
      )
      .all(profile.id) as Array<{ prompt_id: string }>;
    expect(assignments).toEqual([{ prompt_id: originalPrompt.id }]);
  });

  it('rolls back session deletion when a later reassignment fails', async () => {
    const project = await createProject('Session-Project');
    const oldAgent = await createAgent(project.id, 'Old-Agent');
    const newAgent = await createAgent(project.id, 'New-Agent');
    insertSession('delete-session', oldAgent.id, 'stopped');
    insertSession('keep-session', oldAgent.id, 'failed');

    sqlite.exec(`
      CREATE TRIGGER fail_session_reassignment
      BEFORE UPDATE ON sessions
      WHEN OLD.id = 'keep-session'
      BEGIN
        SELECT RAISE(FAIL, 'injected session reassignment failure');
      END;
    `);

    await expect(
      service.applySessionPlan(
        [{ sessionId: 'keep-session', newAgentId: newAgent.id }],
        ['delete-session'],
      ),
    ).rejects.toThrow('injected session reassignment failure');

    expect(
      sqlite.prepare('SELECT agent_id FROM sessions WHERE id = ?').get('delete-session'),
    ).toEqual({ agent_id: oldAgent.id });
    expect(
      sqlite.prepare('SELECT agent_id FROM sessions WHERE id = ?').get('keep-session'),
    ).toEqual({ agent_id: oldAgent.id });
  });

  it('rolls back team and session cleanup when final agent deletion fails', async () => {
    const project = await createProject('Agent-Project');
    const agent = await createAgent(project.id, 'Delete-Agent');
    insertSession('completed-session', agent.id, 'stopped');

    const teamId = randomUUID();
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO teams (id, project_id, name, team_lead_agent_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(teamId, project.id, 'Solo Team', agent.id, now, now);
    sqlite
      .prepare('INSERT INTO team_members (team_id, agent_id, created_at) VALUES (?, ?, ?)')
      .run(teamId, agent.id, now);

    sqlite.exec(`
      CREATE TRIGGER fail_agent_delete
      BEFORE DELETE ON agents
      WHEN OLD.id = '${agent.id}'
      BEGIN
        SELECT RAISE(FAIL, 'injected agent delete failure');
      END;
    `);

    await expect(service.deleteAgent(agent.id)).rejects.toThrow('injected agent delete failure');

    expect(sqlite.prepare('SELECT id FROM agents WHERE id = ?').get(agent.id)).toBeDefined();
    expect(
      sqlite.prepare('SELECT id FROM sessions WHERE id = ?').get('completed-session'),
    ).toBeDefined();
    expect(sqlite.prepare('SELECT id FROM teams WHERE id = ?').get(teamId)).toBeDefined();
    expect(
      sqlite
        .prepare('SELECT team_id FROM team_members WHERE team_id = ? AND agent_id = ?')
        .get(teamId, agent.id),
    ).toBeDefined();
  });
});

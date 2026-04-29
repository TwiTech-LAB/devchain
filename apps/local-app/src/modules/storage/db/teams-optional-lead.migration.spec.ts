import { readFileSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';

describe('0051 teams optional lead migration', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');

    sqlite.exec(`
      CREATE TABLE projects (
        id text PRIMARY KEY NOT NULL
      );

      CREATE TABLE agents (
        id text PRIMARY KEY NOT NULL
      );

      CREATE TABLE teams (
        id text PRIMARY KEY NOT NULL,
        project_id text NOT NULL,
        name text NOT NULL,
        description text,
        team_lead_agent_id text NOT NULL,
        created_at text NOT NULL,
        updated_at text NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE no action ON DELETE cascade,
        FOREIGN KEY (team_lead_agent_id) REFERENCES agents(id) ON UPDATE no action ON DELETE restrict
      );

      CREATE UNIQUE INDEX teams_project_name_unique
        ON teams (project_id, name COLLATE NOCASE);

      CREATE INDEX teams_project_id_idx
        ON teams (project_id);

      CREATE TABLE team_members (
        team_id text NOT NULL,
        agent_id text NOT NULL,
        created_at text NOT NULL,
        PRIMARY KEY (team_id, agent_id),
        FOREIGN KEY (team_id) REFERENCES teams(id) ON UPDATE no action ON DELETE cascade,
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON UPDATE no action ON DELETE cascade
      );
    `);
  });

  afterEach(() => {
    sqlite.close();
  });

  it('recreates teams with nullable lead, preserves data, and sets lead to null on agent deletion', () => {
    sqlite.exec(`
      INSERT INTO projects (id) VALUES ('project-1');
      INSERT INTO agents (id) VALUES ('agent-1');
      INSERT INTO agents (id) VALUES ('agent-2');
      INSERT INTO teams (id, project_id, name, description, team_lead_agent_id, created_at, updated_at)
      VALUES ('team-1', 'project-1', 'Backend Team', 'Core delivery', 'agent-1', '2026-03-08T00:00:00.000Z', '2026-03-08T00:00:00.000Z');
      INSERT INTO team_members (team_id, agent_id, created_at)
      VALUES ('team-1', 'agent-2', '2026-03-08T00:00:00.000Z');
    `);

    const migrationSql = readFileSync(
      join(__dirname, '../../../../drizzle/0051_teams_optional_lead.sql'),
      'utf8',
    ).replace(/--> statement-breakpoint/g, '');

    sqlite.pragma('foreign_keys = OFF');
    sqlite.exec(migrationSql);
    sqlite.pragma('foreign_keys = ON');

    const columns = sqlite.prepare("PRAGMA table_info('teams')").all() as Array<{
      name: string;
      notnull: number;
    }>;
    const teamLeadColumn = columns.find((column) => column.name === 'team_lead_agent_id');
    expect(teamLeadColumn).toBeDefined();
    expect(teamLeadColumn?.notnull).toBe(0);

    const indexes = sqlite.prepare("PRAGMA index_list('teams')").all() as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(['teams_project_name_unique', 'teams_project_id_idx']),
    );

    const teamBeforeDelete = sqlite
      .prepare(
        'SELECT id, project_id, name, description, team_lead_agent_id FROM teams WHERE id = ?',
      )
      .get('team-1') as {
      id: string;
      project_id: string;
      name: string;
      description: string | null;
      team_lead_agent_id: string | null;
    };

    expect(teamBeforeDelete).toEqual({
      id: 'team-1',
      project_id: 'project-1',
      name: 'Backend Team',
      description: 'Core delivery',
      team_lead_agent_id: 'agent-1',
    });

    expect(sqlite.prepare('SELECT team_id, agent_id FROM team_members').all()).toEqual([
      { team_id: 'team-1', agent_id: 'agent-2' },
    ]);
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    sqlite.prepare('DELETE FROM agents WHERE id = ?').run('agent-1');

    const teamAfterDelete = sqlite
      .prepare('SELECT team_lead_agent_id FROM teams WHERE id = ?')
      .get('team-1') as { team_lead_agent_id: string | null };
    expect(teamAfterDelete.team_lead_agent_id).toBeNull();
  });
});

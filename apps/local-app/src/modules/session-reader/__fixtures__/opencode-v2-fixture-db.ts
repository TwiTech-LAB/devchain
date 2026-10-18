import Database from 'better-sqlite3';

/**
 * Fixture builder for an OpenCode 2 SQLite container (`session_v2` / `session_message`).
 *
 * The DDL is the schema OpenCode 2.0.31 creates on a fresh DB (project, session_v2,
 * session_message, credential). Row payloads were captured from a live
 * `opencode run --standalone` session and sanitized: no keys, credentials or real paths.
 *
 * `session_message.data` is an opaque JSON blob whose shape depends on `type`:
 *   - `user`:      `{ time, text, files }`
 *   - `assistant`: `{ time, agent, model, content: [reasoning | tool | text …], finish, tokens, cost }`
 *   - `idle`:      `{ time, outcome }`
 * One assistant message is one model step: a step that calls a tool ends with
 * `finish: 'tool-calls'` and the next step is a new assistant message.
 */

const SCHEMA_SQL = `
  CREATE TABLE \`project\` (
            \`id\` text PRIMARY KEY,
            \`worktree\` text NOT NULL,
            \`vcs\` text,
            \`name\` text,
            \`icon_url\` text,
            \`icon_url_override\` text,
            \`icon_color\` text,
            \`time_created\` integer NOT NULL,
            \`time_updated\` integer NOT NULL,
            \`time_initialized\` integer,
            \`time_active\` integer DEFAULT 0 NOT NULL,
            \`time_archived\` integer,
            \`sandboxes\` text NOT NULL,
            \`commands\` text
          );
  CREATE TABLE \`session_v2\` (
            \`id\` text PRIMARY KEY,
            \`project_id\` text NOT NULL,
            \`workspace_id\` text,
            \`parent_id\` text,
            \`fork_session_id\` text,
            \`fork_boundary\` text,
            \`slug\` text NOT NULL,
            \`directory\` text NOT NULL,
            \`path\` text,
            \`title\` text,
            \`version\` text NOT NULL,
            \`share_url\` text,
            \`summary_additions\` integer,
            \`summary_deletions\` integer,
            \`summary_files\` integer,
            \`summary_diffs\` text,
            \`metadata\` text,
            \`cost\` real DEFAULT 0 NOT NULL,
            \`tokens_input\` integer DEFAULT 0 NOT NULL,
            \`tokens_output\` integer DEFAULT 0 NOT NULL,
            \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
            \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
            \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
            \`revert\` text,
            \`permission\` text,
            \`agent\` text,
            \`model\` text,
            \`time_created\` integer NOT NULL,
            \`time_updated\` integer NOT NULL,
            \`time_idle\` integer,
            \`time_viewed\` integer,
            \`idle_outcome\` text,
            \`time_compacting\` integer,
            \`time_archived\` integer,
            \`time_suspended\` integer,
            \`resume_attempts\` integer DEFAULT 0 NOT NULL,
            CONSTRAINT \`fk_session_v2_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
          );
  CREATE INDEX \`session_v2_parent_idx\` ON \`session_v2\` (\`parent_id\`);
  CREATE INDEX \`session_v2_project_idx\` ON \`session_v2\` (\`project_id\`);
  CREATE INDEX \`session_v2_time_suspended_idx\` ON \`session_v2\` (\`time_suspended\`) WHERE "session_v2"."time_suspended" is not null;
  CREATE INDEX \`session_v2_workspace_idx\` ON \`session_v2\` (\`workspace_id\`);
  CREATE TABLE \`session_message\` (
            \`id\` text PRIMARY KEY,
            \`session_id\` text NOT NULL,
            \`type\` text NOT NULL,
            \`seq\` integer NOT NULL,
            \`time_created\` integer NOT NULL,
            \`time_updated\` integer NOT NULL,
            \`data\` text NOT NULL,
            CONSTRAINT \`fk_session_message_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
          );
  CREATE UNIQUE INDEX \`session_message_session_seq_idx\` ON \`session_message\` (\`session_id\`,\`seq\`);
  CREATE INDEX \`session_message_session_time_created_id_idx\` ON \`session_message\` (\`session_id\`,\`time_created\`,\`id\`);
  CREATE INDEX \`session_message_session_type_seq_idx\` ON \`session_message\` (\`session_id\`,\`type\`,\`seq\`);
  CREATE INDEX \`session_message_time_created_idx\` ON \`session_message\` (\`time_created\`);
  CREATE TABLE \`credential\` (
            \`id\` text PRIMARY KEY,
            \`integration_id\` text,
            \`label\` text NOT NULL,
            \`value\` text NOT NULL,
            \`connector_id\` text,
            \`method_id\` text,
            \`active\` integer,
            \`time_created\` integer NOT NULL,
            \`time_updated\` integer NOT NULL
          );
  CREATE TABLE \`kv\` (
    \`key\` text PRIMARY KEY,
    \`value\` text NOT NULL,
    \`time_created\` integer NOT NULL,
    \`time_updated\` integer NOT NULL
  );
`;

export interface V2SeedMessage {
  id: string;
  type: 'user' | 'assistant' | 'idle' | 'synthetic' | (string & {});
  /** Per-session sequence number; unique within a session. */
  seq: number;
  /** Opaque payload, stored as JSON. */
  data: Record<string, unknown>;
  timeCreated: number;
  timeUpdated?: number;
}

export interface V2SeedSession {
  id: string;
  projectId: string;
  directory: string;
  slug?: string;
  title?: string | null;
  /** Stored as JSON, e.g. `{ id: 'demo-model', providerID: 'demo' }`. */
  model?: Record<string, unknown> | null;
  agent?: string | null;
  parentId?: string | null;
  version?: string;
  /** Cumulative session totals (`session_v2.tokens_*`, `cost`); default 0. */
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
  };
  cost?: number;
  timeCreated: number;
  timeUpdated?: number;
  messages: V2SeedMessage[];
}

export interface V2SeedProject {
  id: string;
  worktree: string;
}

export interface V2SeedCredential {
  id: string;
  integrationId: string;
  label: string;
  /** Opaque credential payload, stored as JSON. */
  value: Record<string, unknown>;
  active?: boolean;
  timeCreated: number;
  timeUpdated?: number;
}

type WritableDb = ReturnType<typeof Database>;

/** Open a writable WAL connection (as OpenCode does; the readers must read WAL DBs), run `fn`, close it. */
export function withWritableOpencodeDb(dbPath: string, fn: (db: WritableDb) => void): void {
  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    fn(db);
  } finally {
    db.close();
  }
}

function insertSession(db: WritableDb, s: V2SeedSession): void {
  db.prepare(
    `INSERT INTO session_v2 (id, project_id, parent_id, slug, directory, title, version, agent, model,
       cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
       time_created, time_updated)
     VALUES (@id, @projectId, @parentId, @slug, @directory, @title, @version, @agent, @model,
       @cost, @tokensInput, @tokensOutput, @tokensReasoning, @tokensCacheRead, @tokensCacheWrite,
       @timeCreated, @timeUpdated)`,
  ).run({
    id: s.id,
    projectId: s.projectId,
    parentId: s.parentId ?? null,
    slug: s.slug ?? 'fixture-session',
    directory: s.directory,
    title: s.title ?? null,
    version: s.version ?? '2.0.31',
    agent: s.agent ?? 'build',
    model: s.model ? JSON.stringify(s.model) : null,
    cost: s.cost ?? 0,
    tokensInput: s.tokens?.input ?? 0,
    tokensOutput: s.tokens?.output ?? 0,
    tokensReasoning: s.tokens?.reasoning ?? 0,
    tokensCacheRead: s.tokens?.cacheRead ?? 0,
    tokensCacheWrite: s.tokens?.cacheWrite ?? 0,
    timeCreated: s.timeCreated,
    timeUpdated: s.timeUpdated ?? s.timeCreated,
  });

  const insMsg = db.prepare(
    `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const m of s.messages) {
    insMsg.run(
      m.id,
      s.id,
      m.type,
      m.seq,
      m.timeCreated,
      m.timeUpdated ?? m.timeCreated,
      JSON.stringify(m.data),
    );
  }
}

/** Create + seed a fixture OpenCode 2 DB at `dbPath`. */
export function createOpencodeV2FixtureDb(
  dbPath: string,
  args: {
    sessions: V2SeedSession[];
    projects?: V2SeedProject[];
    credentials?: V2SeedCredential[];
    /** models.dev catalog as `{ <providerID>: { models: { <modelID>: { limit: { context } } } } }`. */
    catalog?: Record<string, unknown>;
  },
): void {
  withWritableOpencodeDb(dbPath, (db) => {
    db.exec(SCHEMA_SQL);
    if (args.catalog) writeCatalog(db, args.catalog, 1_000);
    const insProject = db.prepare(
      `INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES (?, ?, '[]', 0, 0)`,
    );
    for (const p of args.projects ?? []) insProject.run(p.id, p.worktree);
    for (const s of args.sessions) insertSession(db, s);
    const insCred = db.prepare(
      `INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const c of args.credentials ?? []) {
      insCred.run(
        c.id,
        c.integrationId,
        c.label,
        JSON.stringify(c.value),
        c.active === false ? 0 : 1,
        c.timeCreated,
        c.timeUpdated ?? c.timeCreated,
      );
    }
  });
}

/** OpenCode stores the catalog as `{ updatedAt, digest, body }` with `body` a JSON string. */
function writeCatalog(db: WritableDb, catalog: Record<string, unknown>, timeUpdated: number): void {
  db.prepare(
    `INSERT OR REPLACE INTO kv (key, value, time_created, time_updated)
     VALUES ('models-dev:catalog', ?, ?, ?)`,
  ).run(
    JSON.stringify({
      updatedAt: timeUpdated,
      digest: '0'.repeat(64),
      body: JSON.stringify(catalog),
    }),
    timeUpdated,
    timeUpdated,
  );
}

/** Replace the catalog in place, as OpenCode does when it refreshes it. */
export function updateV2Catalog(
  dbPath: string,
  catalog: Record<string, unknown>,
  timeUpdated: number,
): void {
  withWritableOpencodeDb(dbPath, (db) => writeCatalog(db, catalog, timeUpdated));
}

export const V2_FIXTURE_PROJECT: V2SeedProject = {
  id: '0000000000000000000000000000000000000001',
  worktree: '/workspace/demo',
};

/**
 * One user prompt answered by a single assistant message that holds reasoning, a
 * completed `read` tool call and the final text.
 */
export const V2_FIXTURE_SESSION: V2SeedSession = {
  id: 'ses_fixture0000000000000001',
  projectId: V2_FIXTURE_PROJECT.id,
  directory: '/workspace/demo',
  slug: 'kind-rocket',
  title: 'Read a note',
  model: { id: 'demo-model', providerID: 'demo' },
  timeCreated: 1_000,
  timeUpdated: 1_900,
  messages: [
    {
      id: 'msg_fixture0000000000000001',
      type: 'user',
      seq: 4,
      timeCreated: 1_000,
      data: {
        time: { created: 1_000 },
        text: 'Read note.txt with the read tool, then reply with one short sentence.',
        files: [],
      },
    },
    {
      id: 'msg_fixture0000000000000002',
      type: 'assistant',
      seq: 5,
      timeCreated: 1_100,
      timeUpdated: 1_800,
      data: {
        time: { created: 1_100, streamed: 1_790, completed: 1_800 },
        agent: 'build',
        model: { id: 'demo-model', providerID: 'demo', variant: 'default' },
        content: [
          {
            type: 'reasoning',
            text: 'The user wants me to read note.txt. Let me read the file first.',
            state: { reasoningField: 'reasoning_content' },
            time: { created: 1_200, completed: 1_210 },
          },
          {
            type: 'tool',
            id: 'call_fixture0000000001',
            name: 'read',
            executed: false,
            state: {
              status: 'completed',
              input: { path: 'note.txt' },
              content: [{ type: 'text', text: 'Read file note.txt, lines 1-1\n1: hello fixture' }],
              metadata: { truncated: false },
            },
            time: { created: 1_300, ran: 1_310, completed: 1_320 },
          },
          { type: 'text', text: 'The note.txt file contains the single line "hello fixture".' },
        ],
        finish: 'stop',
        rawFinish: 'stop',
        cost: 0,
        tokens: { input: 100, output: 20, reasoning: 10, cache: { read: 0, write: 0 } },
      },
    },
    {
      id: 'msg_fixture0000000000000003',
      type: 'idle',
      seq: 10,
      timeCreated: 1_900,
      data: { time: { created: 1_900 }, outcome: 'succeeded' },
    },
  ],
};

/** Rewrite a message row in place (e.g. a streaming assistant step gaining a block). */
export function updateV2MessageInPlace(
  dbPath: string,
  args: { messageId: string; data: Record<string, unknown>; timeUpdated: number },
): void {
  withWritableOpencodeDb(dbPath, (db) => {
    db.prepare(`UPDATE session_message SET data = ?, time_updated = ? WHERE id = ?`).run(
      JSON.stringify(args.data),
      args.timeUpdated,
      args.messageId,
    );
  });
}

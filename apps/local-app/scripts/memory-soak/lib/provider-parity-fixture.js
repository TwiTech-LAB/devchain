'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const Database = require('better-sqlite3');

const PROVIDER_FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'provider-transcripts');
const PROVIDER_MANIFEST_PATH = path.join(PROVIDER_FIXTURE_ROOT, 'manifest.json');
const PROVIDER_REGISTRY_PRELOAD = path.join(
  __dirname,
  '..',
  'fixtures',
  'provider-registry-capture.js',
);
const PROJECT_ID = '10000000-0000-4000-8000-0000000000ff';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadProviderManifest(manifestPath = PROVIDER_MANIFEST_PATH) {
  const manifest = readJson(manifestPath);
  if (
    manifest?.schemaVersion !== 1 ||
    !manifest.fixtures ||
    typeof manifest.fixtures !== 'object'
  ) {
    throw new Error('Provider transcript fixture manifest must use schemaVersion 1');
  }
  return manifest;
}

function createProviderFixturePlan(registryProviders, manifest = loadProviderManifest()) {
  const availableFixtureProviders = Object.keys(manifest.fixtures).sort();
  const available = new Set(availableFixtureProviders);
  const loadedProviders = registryProviders.filter((provider) => available.has(provider));
  const missingProviders = registryProviders.filter((provider) => !available.has(provider));
  return {
    registryProviders: [...registryProviders],
    availableFixtureProviders,
    loadedProviders,
    missingProviders,
    coverageRatio:
      registryProviders.length === 0 ? 0 : loadedProviders.length / registryProviders.length,
  };
}

function configureProviderRegistryCapture(fixture) {
  const capturePath = path.join(fixture.tempRoot, 'provider-registry.json');
  const existingNodeOptions = fixture.childEnv.NODE_OPTIONS?.trim();
  fixture.childEnv.NODE_OPTIONS = [existingNodeOptions, `--require=${PROVIDER_REGISTRY_PRELOAD}`]
    .filter(Boolean)
    .join(' ');
  fixture.childEnv.MEMORY_SOAK_PROVIDER_REGISTRY_FILE = capturePath;
  return capturePath;
}

function readProviderRegistryCapture(capturePath) {
  const capture = readJson(capturePath);
  if (!Array.isArray(capture.providers) || capture.providers.length === 0) {
    throw new Error('Disposable app did not expose a populated session-reader adapter registry');
  }
  return capture;
}

function safeFixtureSource(fileName) {
  const resolved = path.resolve(PROVIDER_FIXTURE_ROOT, fileName);
  if (!resolved.startsWith(`${path.resolve(PROVIDER_FIXTURE_ROOT)}${path.sep}`)) {
    throw new Error(`Provider fixture source escapes the committed fixture root: ${fileName}`);
  }
  return resolved;
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
}

function createOpencodeDb(dbPath, source) {
  ensureParent(dbPath);
  const database = new Database(dbPath);
  try {
    database.pragma('journal_mode = WAL');
    database.exec(`
      CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL);
      CREATE TABLE session (
        id TEXT PRIMARY KEY, title TEXT, model TEXT, agent TEXT, parent_id TEXT,
        directory TEXT, project_id TEXT, time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX message_session_time_created_id_idx
        ON message (session_id, time_created, id);
      CREATE INDEX part_session_idx ON part (session_id);
      CREATE INDEX part_message_id_id_idx ON part (message_id, id);
    `);
    const session = source.session;
    database
      .prepare(
        `INSERT INTO session
           (id, title, model, agent, parent_id, directory, project_id, time_created, time_updated)
         VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        session.id,
        session.title,
        session.model,
        session.agent,
        session.timeCreated,
        session.timeUpdated,
      );
    const insertMessage = database.prepare(
      `INSERT INTO message (id, session_id, time_created, time_updated, data)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertPart = database.prepare(
      `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const message of source.messages) {
      insertMessage.run(
        message.id,
        session.id,
        message.timeCreated,
        message.timeUpdated ?? message.timeCreated,
        JSON.stringify(message.data),
      );
      for (const part of message.parts) {
        insertPart.run(
          part.id,
          message.id,
          session.id,
          part.timeCreated ?? message.timeCreated,
          part.timeUpdated ?? part.timeCreated ?? message.timeCreated,
          JSON.stringify(part.data),
        );
      }
    }
  } finally {
    database.close();
  }
}

function varint(value) {
  const bytes = [];
  let remaining = value;
  while (remaining > 0x7f) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining);
  return Buffer.from(bytes);
}

function protobufTag(field, wireType) {
  return varint(field * 8 + wireType);
}

function protobufVarint(field, value) {
  return Buffer.concat([protobufTag(field, 0), varint(value)]);
}

function protobufLengthDelimited(field, value) {
  return Buffer.concat([protobufTag(field, 2), varint(value.length), value]);
}

function protobufString(field, value) {
  return protobufLengthDelimited(field, Buffer.from(value, 'utf8'));
}

function antigravityMetadataBlob(generation) {
  const usage = Buffer.concat([
    protobufVarint(2, generation.inputTokens),
    protobufVarint(3, generation.outputTokens),
  ]);
  const wrapper = Buffer.concat([
    protobufLengthDelimited(4, usage),
    protobufString(19, generation.modelId),
    protobufString(21, generation.displayName),
  ]);
  return protobufLengthDelimited(1, wrapper);
}

function createAntigravityDb(dbPath, providerSessionId, source) {
  ensureParent(dbPath);
  const database = new Database(dbPath);
  try {
    database.pragma('journal_mode = WAL');
    database.exec(
      'CREATE TABLE trajectory_meta(trajectory_id TEXT, cascade_id TEXT, trajectory_type INT, source INT);' +
        'CREATE TABLE gen_metadata(idx INT, data BLOB, size INT);',
    );
    database
      .prepare('INSERT INTO trajectory_meta VALUES (?, ?, ?, ?)')
      .run('memory-soak-trajectory', providerSessionId, 4, 17);
    const insertGeneration = database.prepare('INSERT INTO gen_metadata VALUES (?, ?, ?)');
    source.generations.forEach((generation, index) => {
      const blob = antigravityMetadataBlob(generation);
      insertGeneration.run(index, blob, blob.length);
    });
  } finally {
    database.close();
  }
}

function materializeProviderSource(fixture, providerName, specification) {
  if (specification.kind === 'file') {
    const transcriptPath = path.join(fixture.homeDir, specification.relativePath);
    ensureParent(transcriptPath);
    fs.copyFileSync(safeFixtureSource(specification.transcript), transcriptPath);
    return { transcriptPath, providerSessionId: null };
  }
  if (specification.kind === 'opencode') {
    const transcriptPath = path.join(fixture.homeDir, '.local', 'share', 'opencode', 'opencode.db');
    createOpencodeDb(transcriptPath, readJson(safeFixtureSource(specification.transcript)));
    return { transcriptPath, providerSessionId: specification.providerSessionId };
  }
  if (specification.kind === 'antigravity') {
    const agyRoot = path.join(fixture.homeDir, '.gemini', 'antigravity-cli');
    const transcriptPath = path.join(
      agyRoot,
      'conversations',
      `${specification.providerSessionId}.db`,
    );
    createAntigravityDb(
      transcriptPath,
      specification.providerSessionId,
      readJson(safeFixtureSource(specification.metrics)),
    );
    const jsonlPath = path.join(
      agyRoot,
      'brain',
      specification.providerSessionId,
      '.system_generated',
      'logs',
      'transcript_full.jsonl',
    );
    ensureParent(jsonlPath);
    fs.copyFileSync(safeFixtureSource(specification.transcript), jsonlPath);
    return { transcriptPath, providerSessionId: specification.providerSessionId };
  }
  throw new Error(`Unsupported provider fixture kind for ${providerName}: ${specification.kind}`);
}

function deterministicUuid(label) {
  const hex = crypto.createHash('sha256').update(label).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function seedProviderSession(fixture, providerName, specification, source) {
  const database = new Database(path.join(fixture.storageDir, 'devchain.db'));
  try {
    database.pragma('foreign_keys = ON');
    database.pragma('busy_timeout = 5000');
    const now = '2026-07-13T08:00:00.000Z';
    database
      .prepare(
        `INSERT OR IGNORE INTO projects
           (id, name, root_path, is_template, is_private, created_at, updated_at)
         VALUES (?, 'Memory soak provider parity', ?, 0, 1, ?, ?)`,
      )
      .run(PROJECT_ID, fixture.workspaceDir, now, now);
    let provider = database
      .prepare('SELECT id FROM providers WHERE lower(name) = lower(?)')
      .get(providerName);
    if (!provider) {
      provider = { id: deterministicUuid(`provider:${providerName}`) };
      database
        .prepare(
          `INSERT INTO providers
             (id, name, mcp_configured, one_million_context_enabled, created_at, updated_at)
           VALUES (?, ?, 0, 0, ?, ?)`,
        )
        .run(provider.id, providerName, now, now);
    }
    const profileId = deterministicUuid(`profile:${providerName}`);
    const configId = deterministicUuid(`config:${providerName}`);
    const agentId = deterministicUuid(`agent:${providerName}`);
    database
      .prepare(
        `INSERT INTO agent_profiles (id, project_id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(profileId, PROJECT_ID, `Provider parity ${providerName}`, now, now);
    database
      .prepare(
        `INSERT INTO profile_provider_configs
           (id, profile_id, provider_id, name, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(configId, profileId, provider.id, `Provider parity ${providerName}`, now, now);
    database
      .prepare(
        `INSERT INTO agents
           (id, project_id, profile_id, provider_config_id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(agentId, PROJECT_ID, profileId, configId, `Provider parity ${providerName}`, now, now);
    database
      .prepare(
        `INSERT INTO sessions
           (id, agent_id, status, started_at, ended_at, transcript_path, provider_session_id,
            provider_name_at_launch, size_bytes, created_at, updated_at)
         VALUES (?, ?, 'stopped', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        specification.sessionId,
        agentId,
        now,
        now,
        source.transcriptPath,
        source.providerSessionId,
        providerName,
        fs.statSync(source.transcriptPath).size,
        now,
        now,
      );
    return {
      providerName,
      sessionId: specification.sessionId,
      providerSessionId: source.providerSessionId,
    };
  } finally {
    database.close();
  }
}

function loadProviderFixtures(fixture, registryProviders, manifest = loadProviderManifest()) {
  const planned = createProviderFixturePlan(registryProviders, manifest);
  const sessions = [];
  const loadErrors = [];
  for (const providerName of planned.loadedProviders) {
    const specification = manifest.fixtures[providerName];
    try {
      const source = materializeProviderSource(fixture, providerName, specification);
      sessions.push(seedProviderSession(fixture, providerName, specification, source));
    } catch (error) {
      loadErrors.push({ providerName, error: String(error?.message ?? error) });
    }
  }
  const loadedProviders = sessions.map((session) => session.providerName);
  const missingProviders = registryProviders.filter(
    (providerName) => !loadedProviders.includes(providerName),
  );
  return {
    ...planned,
    loadedProviders,
    missingProviders,
    coverageRatio:
      registryProviders.length === 0 ? 0 : loadedProviders.length / registryProviders.length,
    sessions,
    loadErrors,
  };
}

function metricDifference(field, summaryMetrics, fullMetrics) {
  return {
    field,
    summary: summaryMetrics[field],
    full: fullMetrics[field],
  };
}

function compareProviderMetrics(summaryMetrics, fullMetrics, contract) {
  const exactFields = Array.isArray(contract?.exactFields) ? [...contract.exactFields] : [];
  const approximateFields = Array.isArray(contract?.approximateFields)
    ? [...contract.approximateFields]
    : [];
  const declaredFields = new Set([...exactFields, ...approximateFields]);
  const observedFields = [
    ...new Set([...Object.keys(summaryMetrics), ...Object.keys(fullMetrics)]),
  ];
  const exactMismatches = exactFields
    .filter((field) => !isDeepStrictEqual(summaryMetrics[field], fullMetrics[field]))
    .map((field) => metricDifference(field, summaryMetrics, fullMetrics));
  const toleratedDifferences = approximateFields
    .filter((field) => !isDeepStrictEqual(summaryMetrics[field], fullMetrics[field]))
    .map((field) => ({
      ...metricDifference(field, summaryMetrics, fullMetrics),
      reason: 'adapter-declared approximate summary field',
    }));
  const unclassifiedFields = observedFields.filter((field) => !declaredFields.has(field));
  return {
    exactFields,
    approximateFields,
    exactMismatches,
    toleratedDifferences,
    unclassifiedFields,
    metricsEqual: exactMismatches.length === 0 && unclassifiedFields.length === 0,
  };
}

module.exports = {
  PROVIDER_MANIFEST_PATH,
  compareProviderMetrics,
  configureProviderRegistryCapture,
  createProviderFixturePlan,
  loadProviderFixtures,
  loadProviderManifest,
  readProviderRegistryCapture,
};

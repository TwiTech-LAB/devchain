'use strict';

/** Layer: pure unit plus a local child-process integration for /proc resolution. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  captureTargetProvenance,
  createHarnessProvenance,
  fingerprintPath,
  noTargetProvenance,
  resolveBuildSubject,
} = require('./lib/provenance');
const { validateReportSchema } = require('./lib/evaluate');

test('pure unit: directory fingerprint is content-addressed and path-order deterministic', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devchain-provenance-'));
  try {
    fs.mkdirSync(path.join(root, 'nested'));
    fs.writeFileSync(path.join(root, 'nested', 'b.js'), 'bravo');
    fs.writeFileSync(path.join(root, 'a.js'), 'alpha');

    const first = fingerprintPath(root);
    fs.utimesSync(path.join(root, 'a.js'), new Date(), new Date(Date.now() + 10_000));
    const mtimeOnly = fingerprintPath(root);
    fs.writeFileSync(path.join(root, 'a.js'), 'changed');
    const changed = fingerprintPath(root);

    assert.equal(first.subjectKind, 'directory-tree');
    assert.equal(first.fileCount, 2);
    assert.equal(first.digest, mtimeOnly.digest);
    assert.notEqual(first.digest, changed.digest);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pure unit: build subject expands a dist entrypoint to the complete build tree', () => {
  assert.equal(
    resolveBuildSubject('/opt/devchain/dist/modules/main.js', '/usr/bin/node'),
    '/opt/devchain/dist',
  );
  assert.equal(
    resolveBuildSubject('/opt/devchain/main.js', '/usr/bin/node'),
    '/opt/devchain/main.js',
  );
  assert.equal(resolveBuildSubject(null, '/usr/bin/native-app'), '/usr/bin/native-app');
});

test('pure unit: target provenance binds the running executable to a SHA-256 fingerprint', () => {
  const provenance = captureTargetProvenance(process.pid);

  assert.equal(provenance.method, 'linux-procfs-sha256-v1');
  assert.match(provenance.executable.sha256, /^[a-f0-9]{64}$/);
  assert.match(provenance.buildFingerprint.digest, /^[a-f0-9]{64}$/);
  assert.ok(provenance.buildFingerprint.fileCount >= 1);
  assert.ok(Number.isFinite(provenance.executable.mtimeMs));
  assert.ok(!Object.hasOwn(provenance, 'arguments'));
});

test('local integration: Node target provenance fingerprints its complete dist tree', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devchain-target-build-'));
  const dist = path.join(root, 'dist');
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(dist, 'main.js'), 'setInterval(() => {}, 1000);');
  fs.writeFileSync(path.join(dist, 'module.js'), 'module.exports = 42;');
  const child = spawn(process.execPath, [path.join(dist, 'main')], {
    cwd: root,
    stdio: 'ignore',
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const provenance = captureTargetProvenance(child.pid);

    assert.equal(provenance.entrypoint.path, path.join(dist, 'main.js'));
    assert.equal(provenance.buildFingerprint.subjectKind, 'directory-tree');
    assert.equal(provenance.buildFingerprint.subjectPath, dist);
    assert.equal(provenance.buildFingerprint.fileCount, 2);
    assert.equal(provenance.commit, null);
    assert.equal(provenance.dirty, null);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pure unit: absent target is explicit rather than missing provenance', () => {
  const provenance = noTargetProvenance();
  assert.ok(Number.isFinite(Date.parse(provenance.capturedAt)));
  assert.deepEqual(
    { ...provenance, capturedAt: '<captured>' },
    {
      method: 'not-requested',
      capturedAt: '<captured>',
      repositoryRoot: null,
      commit: null,
      branch: null,
      dirty: null,
      cwd: null,
      executable: null,
      entrypoint: null,
      buildFingerprint: null,
    },
  );
});

test('pure unit: harness provenance remains distinct checkout metadata', () => {
  const provenance = createHarnessProvenance({
    root: '/repo',
    commit: 'a'.repeat(40),
    branch: 'main',
    dirty: true,
  });

  assert.equal(provenance.method, 'git-checkout');
  assert.equal(provenance.repositoryRoot, '/repo');
  assert.equal(provenance.commit, 'a'.repeat(40));
  assert.equal(provenance.dirty, true);
});

test('pure unit: schema-v2 report without target provenance is rejected', () => {
  const baselineName = fs
    .readdirSync(path.join(__dirname, 'baselines'))
    .find((name) => /^phase1-instrumented-.*\.json$/.test(name));
  assert.ok(baselineName, 'current-schema baseline fixture must exist');
  const report = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'baselines', baselineName), 'utf8'),
  );
  report.target = { ...report.target };
  delete report.target.provenance;

  const missing = validateReportSchema(report);
  const complete = validateReportSchema({
    ...report,
    target: { ...report.target, provenance: noTargetProvenance() },
  });

  assert.equal(missing.valid, false);
  assert.match(missing.reason, /target\.provenance/);
  assert.deepEqual(complete, { valid: true });
});

#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const {
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { promisify } = require("node:util");

const runFile = promisify(execFile);
const REGISTRY = "https://registry.npmjs.org/";
const DEPENDENCY_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
];
const METADATA_FIELDS = ["engines", "peerDependenciesMeta"];

function checkDeclarations(manifest, label) {
  for (const field of DEPENDENCY_FIELDS) {
    const entries = manifest[field] ?? {};
    assert.ok(
      entries && typeof entries === "object" && !Array.isArray(entries),
      `${label}.${field} must be a dependency map`,
    );
    for (const [name, spec] of Object.entries(entries)) {
      assert.ok(
        typeof spec === "string" && spec.trim().length > 0,
        `${label}.${field}.${name} must have a dependency spec`,
      );
      const localPath =
        /^(?:workspace:|link:|file:|\.\.?(?:[/\\]|$)|~[/\\]|[/\\]|[a-z]:[/\\])/i.test(
          spec.trim(),
        );
      const localArchive =
        /\.(?:tgz|tar\.gz)$/i.test(spec.trim()) &&
        !/^https?:\/\//i.test(spec.trim());
      assert.ok(
        !localPath && !localArchive,
        `${label}.${field}.${name} must not use a workspace, link, or local-file dependency`,
      );
    }
  }
}

/** Project only the fields npm needs to resolve the published runtime tree. */
function projectRuntimeManifest(manifest) {
  assert.ok(typeof manifest.name === "string" && manifest.name.length > 0);
  assert.ok(
    typeof manifest.version === "string" && manifest.version.length > 0,
  );
  checkDeclarations(manifest, "package.json");
  const projected = { name: manifest.name, version: manifest.version };
  for (const field of [...METADATA_FIELDS, ...DEPENDENCY_FIELDS]) {
    if (manifest[field] !== undefined) {
      projected[field] = JSON.parse(JSON.stringify(manifest[field]));
    }
  }
  return projected;
}

/** Validate declarations and public package records without resolving dependencies. */
function validateShrinkwrap(manifest, lock) {
  const expected = projectRuntimeManifest(manifest);
  assert.equal(
    lock?.lockfileVersion,
    3,
    "npm shrinkwrap must use lockfileVersion 3",
  );
  assert.equal(
    lock.name,
    expected.name,
    "shrinkwrap package identity is stale",
  );
  assert.ok(
    lock.packages &&
      typeof lock.packages === "object" &&
      !Array.isArray(lock.packages),
    "shrinkwrap is missing its packages map",
  );
  const root = lock.packages[""];
  assert.ok(root, "shrinkwrap is missing its root package");
  assert.equal(
    root.name,
    expected.name,
    "shrinkwrap root package identity is stale",
  );
  // A version-only release (including a LAN suffix) keeps the same runtime pins.
  for (const field of [...DEPENDENCY_FIELDS, ...METADATA_FIELDS]) {
    assert.deepEqual(
      root[field] ?? {},
      expected[field] ?? {},
      `shrinkwrap root ${field} are stale; run npm run shrinkwrap:reconcile`,
    );
  }
  assert.equal(
    root.devDependencies,
    undefined,
    "shrinkwrap must exclude development dependencies",
  );
  assert.equal(
    root.workspaces,
    undefined,
    "shrinkwrap must exclude workspace configuration",
  );

  for (const [location, record] of Object.entries(lock.packages)) {
    assert.ok(
      record && typeof record === "object" && !Array.isArray(record),
      `invalid package record: ${location}`,
    );
    checkDeclarations(record, `packages[${JSON.stringify(location)}]`);
    assert.ok(!record.link, `shrinkwrap contains a local link: ${location}`);
    if (location === "") continue;
    assert.match(
      location,
      /^(?:node_modules\/(?:@[^/]+\/)?[^/.][^/]*)(?:\/node_modules\/(?:@[^/]+\/)?[^/.][^/]*)*$/,
      `shrinkwrap contains a local package path: ${location}`,
    );
    assert.ok(
      !record.dev,
      `shrinkwrap contains a development-only package: ${location}`,
    );
    assert.ok(
      typeof record.version === "string" && record.version.length > 0,
      `missing version: ${location}`,
    );
    assert.ok(
      typeof record.integrity === "string" && record.integrity.length > 0,
      `missing integrity: ${location}`,
    );
    let resolved;
    try {
      resolved = new URL(record.resolved);
    } catch {
      throw new Error(
        `shrinkwrap package must resolve from ${REGISTRY}: ${location}`,
      );
    }
    assert.ok(
      resolved.origin === REGISTRY.slice(0, -1) &&
        !resolved.username &&
        !resolved.password,
      `shrinkwrap package must resolve from ${REGISTRY}: ${location}`,
    );
  }

  for (const field of DEPENDENCY_FIELDS) {
    for (const name of Object.keys(expected[field] ?? {})) {
      if (
        field === "peerDependencies" &&
        expected.peerDependenciesMeta?.[name]?.optional
      )
        continue;
      assert.ok(
        lock.packages[`node_modules/${name}`],
        `shrinkwrap is missing a runtime package: ${name}`,
      );
    }
  }
  return lock;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function checkShrinkwrap(packageRoot) {
  const [manifest, lock] = await Promise.all([
    readJson(join(packageRoot, "package.json")),
    readJson(join(packageRoot, "npm-shrinkwrap.json")),
  ]);
  return validateShrinkwrap(manifest, lock);
}

async function generateShrinkwrap(packageRoot, operation) {
  assert.ok(
    ["reconcile", "refresh"].includes(operation),
    "unknown generation operation",
  );
  const manifest = projectRuntimeManifest(
    await readJson(join(packageRoot, "package.json")),
  );
  const lockPath = join(packageRoot, "npm-shrinkwrap.json");
  const temporary = await mkdtemp(join(tmpdir(), "devchain-npm-shrinkwrap-"));
  const replacement = `${lockPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      join(temporary, "package.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    if (operation === "reconcile") {
      try {
        await writeFile(
          join(temporary, "package-lock.json"),
          await readFile(lockPath),
        );
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    // Ignore user/scoped registry settings so no private resolution can enter the runtime lock.
    const userConfig = join(temporary, "user.npmrc");
    const globalConfig = join(temporary, "global.npmrc");
    await Promise.all([writeFile(userConfig, ""), writeFile(globalConfig, "")]);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !/^npm_config_/i.test(name),
      ),
    );
    const flags = [
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--workspaces=false",
      `--registry=${REGISTRY}`,
      `--userconfig=${userConfig}`,
      `--globalconfig=${globalConfig}`,
    ];
    await runFile(
      "npm",
      [
        "install",
        "--package-lock-only",
        "--lockfile-version=3",
        "--omit=dev",
        "--include=optional",
        "--include=peer",
        ...flags,
      ],
      { cwd: temporary, env, maxBuffer: 16 * 1024 * 1024 },
    );
    await runFile("npm", ["shrinkwrap", ...flags], { cwd: temporary, env });
    const generated = await readFile(
      join(temporary, "npm-shrinkwrap.json"),
      "utf8",
    );
    validateShrinkwrap(manifest, JSON.parse(generated));
    await writeFile(replacement, generated);
    await rename(replacement, lockPath);
  } finally {
    await Promise.all([
      rm(temporary, { recursive: true, force: true }),
      rm(replacement, { force: true }),
    ]);
  }
}

async function main() {
  const operation = process.argv[2];
  const packageRoot = join(__dirname, "..");
  if (operation === "check") {
    await checkShrinkwrap(packageRoot);
  } else if (["reconcile", "refresh"].includes(operation)) {
    await generateShrinkwrap(packageRoot, operation);
  } else {
    throw new Error(
      "Usage: node scripts/npm-shrinkwrap.js <reconcile|refresh|check>",
    );
  }
  process.stdout.write(`Runtime shrinkwrap ${operation} passed.\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Runtime shrinkwrap failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  projectRuntimeManifest,
  validateShrinkwrap,
  checkShrinkwrap,
  generateShrinkwrap,
};

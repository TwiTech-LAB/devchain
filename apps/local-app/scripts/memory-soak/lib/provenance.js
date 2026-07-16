'use strict';

const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function hashFile(filePath) {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function fileProvenance(filePath) {
  const resolvedPath = fs.realpathSync(filePath);
  const stats = fs.statSync(resolvedPath);
  if (!stats.isFile()) throw new Error(`Provenance subject is not a file: ${resolvedPath}`);
  return {
    path: resolvedPath,
    sha256: hashFile(resolvedPath),
    sizeBytes: stats.size,
    mtimeMs: stats.mtimeMs,
  };
}

function listTreeEntries(rootPath, currentPath = rootPath, entries = []) {
  const children = fs
    .readdirSync(currentPath, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    const absolutePath = path.join(currentPath, child.name);
    const relativePath = path.relative(rootPath, absolutePath);
    if (child.isDirectory()) {
      listTreeEntries(rootPath, absolutePath, entries);
    } else if (child.isFile() || child.isSymbolicLink()) {
      entries.push({ absolutePath, relativePath, symbolicLink: child.isSymbolicLink() });
    }
  }
  return entries;
}

function fingerprintPath(subjectPath) {
  const resolvedPath = fs.realpathSync(subjectPath);
  const stats = fs.statSync(resolvedPath);
  if (stats.isFile()) {
    return {
      algorithm: 'sha256',
      digest: hashFile(resolvedPath),
      subjectKind: 'file',
      subjectPath: resolvedPath,
      fileCount: 1,
      totalBytes: stats.size,
    };
  }
  if (!stats.isDirectory()) {
    throw new Error(`Unsupported provenance subject: ${resolvedPath}`);
  }

  const hash = createHash('sha256');
  let fileCount = 0;
  let totalBytes = 0;
  for (const entry of listTreeEntries(resolvedPath)) {
    hash.update(entry.symbolicLink ? 'L\0' : 'F\0');
    hash.update(entry.relativePath);
    hash.update('\0');
    if (entry.symbolicLink) {
      hash.update(fs.readlinkSync(entry.absolutePath));
    } else {
      const contents = fs.readFileSync(entry.absolutePath);
      hash.update(contents);
      totalBytes += contents.byteLength;
    }
    hash.update('\0');
    fileCount += 1;
  }
  return {
    algorithm: 'sha256',
    digest: hash.digest('hex'),
    subjectKind: 'directory-tree',
    subjectPath: resolvedPath,
    fileCount,
    totalBytes,
  };
}

function readGitProvenance(cwd) {
  try {
    const git = (...args) =>
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    return {
      repositoryRoot: fs.realpathSync(git('rev-parse', '--show-toplevel')),
      commit: git('rev-parse', 'HEAD'),
      branch: git('branch', '--show-current') || null,
      dirty: git('status', '--porcelain').length > 0,
    };
  } catch {
    return { repositoryRoot: null, commit: null, branch: null, dirty: null };
  }
}

function createHarnessProvenance(git) {
  return {
    method: 'git-checkout',
    capturedAt: new Date().toISOString(),
    repositoryRoot: git.root,
    commit: git.commit,
    branch: git.branch || null,
    dirty: git.dirty,
  };
}

function readProcessArguments(pid) {
  return fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0').filter(Boolean);
}

function resolveEntrypoint(pid, cwd) {
  const [, ...argumentsList] = readProcessArguments(pid);
  const candidates = [];
  for (const argument of argumentsList) {
    if (argument.startsWith('-')) continue;
    const unresolved = path.isAbsolute(argument) ? argument : path.resolve(cwd, argument);
    const possiblePaths = path.extname(unresolved)
      ? [unresolved]
      : [unresolved, `${unresolved}.js`, `${unresolved}.cjs`, `${unresolved}.mjs`];
    for (const candidate of possiblePaths) {
      try {
        if (fs.statSync(candidate).isFile() && /\.(?:c?js|mjs|ts|tsx)$/.test(candidate)) {
          candidates.push(fs.realpathSync(candidate));
          break;
        }
      } catch {
        // Non-path arguments are expected after the entrypoint.
      }
    }
  }
  return (
    candidates.find((candidate) => candidate.split(path.sep).includes('dist')) ||
    candidates[0] ||
    null
  );
}

function resolveBuildSubject(entrypointPath, executablePath) {
  if (!entrypointPath) return executablePath;
  let current = path.dirname(entrypointPath);
  while (true) {
    if (path.basename(current) === 'dist') return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return entrypointPath;
}

function noTargetProvenance() {
  return {
    method: 'not-requested',
    capturedAt: new Date().toISOString(),
    repositoryRoot: null,
    commit: null,
    branch: null,
    dirty: null,
    cwd: null,
    executable: null,
    entrypoint: null,
    buildFingerprint: null,
  };
}

function captureTargetProvenance(pid) {
  if (pid === undefined || pid === null) return noTargetProvenance();
  if (!Number.isInteger(pid) || pid <= 0)
    throw new Error(`Invalid target PID for provenance: ${pid}`);

  try {
    const cwd = fs.realpathSync(`/proc/${pid}/cwd`);
    const executablePath = fs.realpathSync(`/proc/${pid}/exe`);
    const entrypointPath = resolveEntrypoint(pid, cwd);
    const buildSubject = resolveBuildSubject(entrypointPath, executablePath);
    const git = readGitProvenance(cwd);
    return {
      method: 'linux-procfs-sha256-v1',
      capturedAt: new Date().toISOString(),
      ...git,
      cwd,
      executable: fileProvenance(executablePath),
      entrypoint: entrypointPath ? fileProvenance(entrypointPath) : null,
      buildFingerprint: fingerprintPath(buildSubject),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to capture provenance for target PID ${pid}: ${detail}`);
  }
}

module.exports = {
  captureTargetProvenance,
  createHarnessProvenance,
  fileProvenance,
  fingerprintPath,
  noTargetProvenance,
  resolveBuildSubject,
  resolveEntrypoint,
};

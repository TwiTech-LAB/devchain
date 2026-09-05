"use strict";

const fs = require("fs");
const path = require("path");
const { composeTemplate, decomposeTemplate } = require("./codec.js");

// Mirror of SLUG_PATTERN in
// apps/local-app/src/common/validation/template-validation.ts — the single
// repository authority for destination slugs. Keep both in sync.
const SLUG_PATTERN = /^[a-zA-Z0-9_-]+$/;

const SOURCE_DIR_NAME = "templates-src";
const DIST_DIR_NAME = "templates";

function defaultRoots() {
  const repoRoot = path.resolve(__dirname, "..", "..");
  return {
    repoRoot,
    srcDir: path.join(repoRoot, "apps", "local-app", SOURCE_DIR_NAME),
    distDir: path.join(repoRoot, "apps", "local-app", DIST_DIR_NAME),
  };
}

function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function relativeToRoot(roots, targetPath) {
  return toPosix(path.relative(roots.repoRoot, targetPath));
}

function validateSlug(slug, label = "slug") {
  if (typeof slug !== "string" || !SLUG_PATTERN.test(slug)) {
    throw new Error(
      `invalid ${label} ${JSON.stringify(slug)}: must contain only alphanumeric characters, hyphens, and underscores`,
    );
  }
  return slug;
}

function assertInsideRoot(rootDir, targetPath, label) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetPath);
  if (
    resolvedTarget !== resolvedRoot &&
    !resolvedTarget.startsWith(resolvedRoot + path.sep)
  ) {
    throw new Error(
      `${label} ${targetPath} escapes the repository template root ${resolvedRoot}; refusing to mutate`,
    );
  }
  return resolvedTarget;
}

function assertNotSymlink(targetPath, label) {
  const stats = fs.lstatSync(targetPath);
  if (stats.isSymbolicLink()) {
    throw new Error(`${label} ${targetPath} is a symlink; refusing to mutate`);
  }
  return stats;
}

function assertDirectory(targetPath, label) {
  const stats = assertNotSymlink(targetPath, label);
  if (!stats.isDirectory()) {
    throw new Error(`${label} ${targetPath} is not a directory`);
  }
  return stats;
}

function tempSiblingName(prefix, suffix) {
  const unique = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  return `.${prefix}.tmp-${unique}${suffix}`;
}

function removeTree(bestEffortPath) {
  fs.rmSync(bestEffortPath, { recursive: true, force: true });
}

// Every mutation root must be a real directory. assertInsideRoot is purely
// lexical, so a symlinked root would silently redirect all writes beneath it
// outside the repository; verify the root itself before anything is staged.
function ensureRealDirectoryRoot(dirPath, label) {
  let stats = null;
  try {
    stats = fs.lstatSync(dirPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (stats === null) {
    fs.mkdirSync(dirPath, { recursive: true });
    stats = fs.lstatSync(dirPath);
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`${label} ${dirPath} is a symlink; refusing to mutate`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`${label} ${dirPath} is not a directory`);
  }
}

function listSourceSlugs(roots) {
  let entries;
  try {
    entries = fs.readdirSync(roots.srcDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const slugs = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory()) continue;
    validateSlug(
      entry.name,
      `source template directory ${relativeToRoot(roots, path.join(roots.srcDir, entry.name))}`,
    );
    slugs.push(entry.name);
  }
  return slugs.sort();
}

function readSourceEntryFile(dir, name) {
  const filePath = path.join(dir, name);
  const stats = assertNotSymlink(filePath, "source file");
  if (!stats.isFile()) {
    throw new Error(`source entry ${filePath} is not a regular file`);
  }
  return fs.readFileSync(filePath, "utf8");
}

function loadSourceTree(roots, slug) {
  validateSlug(slug, "source slug");
  const sourceDir = path.join(roots.srcDir, slug);
  assertDirectory(
    sourceDir,
    `source template ${relativeToRoot(roots, sourceDir)}`,
  );
  assertInsideRoot(roots.srcDir, sourceDir, "source template");

  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  const files = {};
  let templateJson = null;

  for (const entry of entries) {
    if (entry.name === "template.json") {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error(
          `template.json in ${relativeToRoot(roots, sourceDir)} must be a regular file`,
        );
      }
      templateJson = readSourceEntryFile(sourceDir, entry.name);
      continue;
    }
    if (entry.name === "prompts" || entry.name === "profiles") {
      const kindDir = path.join(sourceDir, entry.name);
      assertDirectory(
        kindDir,
        `source directory ${relativeToRoot(roots, kindDir)}`,
      );
      for (const fileEntry of fs.readdirSync(kindDir, {
        withFileTypes: true,
      })) {
        if (fileEntry.isDirectory()) {
          throw new Error(
            `unexpected directory ${relativeToRoot(roots, path.join(kindDir, fileEntry.name))}: ${entry.name}/ must stay flat`,
          );
        }
        files[`${entry.name}/${fileEntry.name}`] = readSourceEntryFile(
          kindDir,
          fileEntry.name,
        );
      }
      continue;
    }
    throw new Error(
      `unexpected entry ${JSON.stringify(entry.name)} in ${relativeToRoot(roots, sourceDir)}: only template.json, prompts/, and profiles/ are allowed`,
    );
  }

  if (templateJson === null) {
    throw new Error(
      `missing template.json in ${relativeToRoot(roots, sourceDir)}`,
    );
  }

  let template;
  try {
    template = JSON.parse(templateJson);
  } catch (error) {
    throw new Error(
      `${relativeToRoot(roots, path.join(sourceDir, "template.json"))}: invalid JSON (${error.message})`,
    );
  }

  return { template, files };
}

function writeCompiledArtifact(roots, slug, serialized) {
  const distPath = path.join(roots.distDir, `${slug}.json`);
  assertInsideRoot(roots.distDir, distPath, "compiled template");
  ensureRealDirectoryRoot(roots.distDir, "compiled template root");

  try {
    const existing = fs.lstatSync(distPath);
    if (existing.isSymbolicLink()) {
      throw new Error(
        `compiled template ${relativeToRoot(roots, distPath)} is a symlink; refusing to mutate`,
      );
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const tempPath = path.join(
    path.dirname(distPath),
    tempSiblingName(path.basename(distPath), ""),
  );
  try {
    fs.writeFileSync(tempPath, serialized);
    fs.renameSync(tempPath, distPath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch (_) {
      // best effort: the failed temp sibling is inert and hidden
    }
    throw error;
  }
  return distPath;
}

function serializeTemplate(assembled) {
  // Matches the DevChain export serialization (ExportDialog writes
  // JSON.stringify(data, null, 2) with no trailing newline); drift here
  // breaks the byte-for-byte round-trip contract.
  return JSON.stringify(assembled, null, 2);
}

function byteCompareOrUndefined(distPath) {
  try {
    return fs.readFileSync(distPath);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function runBuild({ slug, check, roots = defaultRoots(), validate }) {
  if (typeof validate !== "function") {
    throw new TypeError("validate must be a function");
  }

  let slugs;
  if (slug === undefined || slug === null) {
    slugs = listSourceSlugs(roots);
  } else {
    validateSlug(slug, "build slug");
    const available = listSourceSlugs(roots);
    if (!available.includes(slug)) {
      throw new Error(
        `no source template ${JSON.stringify(slug)} under ${roots.srcDir}${available.length ? ` (available: ${available.join(", ")})` : ""}`,
      );
    }
    slugs = [slug];
  }

  const results = [];
  for (const currentSlug of slugs) {
    let serialized;
    try {
      const { template, files } = loadSourceTree(roots, currentSlug);
      const assembled = composeTemplate(template, files, validate);
      serialized = serializeTemplate(assembled);
    } catch (error) {
      throw new Error(`template ${currentSlug}: ${error.message}`);
    }
    const distPath = path.join(roots.distDir, `${currentSlug}.json`);

    if (check) {
      const existing = byteCompareOrUndefined(distPath);
      if (existing === undefined) {
        results.push({
          slug: currentSlug,
          status: "missing",
          ok: false,
          detail: `${relativeToRoot(roots, distPath)} is missing; run: pnpm templates:build`,
        });
        continue;
      }
      if (!existing.equals(Buffer.from(serialized, "utf8"))) {
        results.push({
          slug: currentSlug,
          status: "drift",
          ok: false,
          detail: `${relativeToRoot(roots, distPath)} does not match the source; run: pnpm templates:build`,
        });
        continue;
      }
      results.push({
        slug: currentSlug,
        status: "up-to-date",
        ok: true,
        detail: `${relativeToRoot(roots, distPath)} is up to date`,
      });
      continue;
    }

    try {
      writeCompiledArtifact(roots, currentSlug, serialized);
    } catch (error) {
      throw new Error(`template ${currentSlug}: ${error.message}`);
    }
    results.push({
      slug: currentSlug,
      status: "built",
      ok: true,
      detail: `wrote ${relativeToRoot(roots, distPath)}`,
    });
  }

  return results;
}

function readExportFile(jsonPath) {
  if (typeof jsonPath !== "string" || jsonPath.trim() === "") {
    throw new Error("extract requires an explicit JSON input path");
  }
  let raw;
  try {
    raw = fs.readFileSync(jsonPath, "utf8");
  } catch (error) {
    throw new Error(`cannot read JSON input ${jsonPath}: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${jsonPath}: invalid JSON (${error.message})`);
  }
}

function resolveExtractSlug(rawExport, requestedSlug) {
  const manifest =
    rawExport && typeof rawExport === "object"
      ? rawExport._manifest
      : undefined;
  const manifestSlug =
    manifest && typeof manifest.slug === "string" && manifest.slug.trim() !== ""
      ? manifest.slug
      : undefined;

  if (requestedSlug !== undefined && requestedSlug !== null) {
    validateSlug(requestedSlug, "--slug");
    if (manifestSlug && manifestSlug !== requestedSlug) {
      throw new Error(
        `manifest slug ${JSON.stringify(manifestSlug)} conflicts with --slug ${JSON.stringify(requestedSlug)}`,
      );
    }
    return requestedSlug;
  }
  if (!manifestSlug) {
    throw new Error(
      "template has no _manifest.slug; pass --slug to choose the destination slug",
    );
  }
  return validateSlug(manifestSlug, "_manifest.slug");
}

function stageSourceTree(roots, slug, source) {
  const stagingDir = path.join(roots.srcDir, tempSiblingName(slug, ""));
  assertInsideRoot(roots.srcDir, stagingDir, "staging directory");

  fs.mkdirSync(stagingDir, { recursive: true });
  fs.writeFileSync(
    path.join(stagingDir, "template.json"),
    serializeTemplate(source.template),
  );

  for (const relativePath of Object.keys(source.files).sort()) {
    const targetPath = path.join(stagingDir, relativePath);
    assertInsideRoot(stagingDir, targetPath, "staged file");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, source.files[relativePath]);
  }
  return stagingDir;
}

function runExtract({
  jsonPath,
  slug,
  force,
  roots = defaultRoots(),
  validate,
  renameSync = fs.renameSync,
}) {
  if (typeof validate !== "function") {
    throw new TypeError("validate must be a function");
  }

  const rawExport = readExportFile(jsonPath);
  const resolvedSlug = resolveExtractSlug(rawExport, slug);
  const source = decomposeTemplate(rawExport, validate);

  const destDir = path.join(roots.srcDir, resolvedSlug);
  assertInsideRoot(roots.srcDir, destDir, "extract destination");

  let destStats = null;
  try {
    destStats = fs.lstatSync(destDir);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (destStats !== null) {
    if (destStats.isSymbolicLink()) {
      throw new Error(
        `extract destination ${relativeToRoot(roots, destDir)} is a symlink; refusing to mutate`,
      );
    }
    if (!destStats.isDirectory()) {
      throw new Error(
        `extract destination ${relativeToRoot(roots, destDir)} is not a directory`,
      );
    }
  }
  const destExists = destStats !== null;
  if (destExists && !force) {
    throw new Error(
      `extract destination ${relativeToRoot(roots, destDir)} already exists; pass --force to replace it`,
    );
  }

  ensureRealDirectoryRoot(roots.srcDir, "source template root");
  const stagingDir = stageSourceTree(roots, resolvedSlug, source);

  let backupDir = null;
  try {
    if (destExists) {
      backupDir = path.join(
        roots.srcDir,
        tempSiblingName(resolvedSlug, ".backup"),
      );
      assertInsideRoot(roots.srcDir, backupDir, "backup directory");
      renameSync(destDir, backupDir);
    }
    try {
      renameSync(stagingDir, destDir);
    } catch (swapError) {
      if (backupDir === null) throw swapError;
      try {
        renameSync(backupDir, destDir);
      } catch (restoreError) {
        throw new Error(
          `extract failed (${swapError.message}); the prior tree is retained at ${relativeToRoot(roots, backupDir)} (${restoreError.message})`,
        );
      }
      throw swapError;
    }
  } catch (error) {
    removeTree(stagingDir);
    throw error;
  }

  if (backupDir !== null) {
    try {
      removeTree(backupDir);
    } catch (error) {
      console.warn(
        `warning: replaced ${relativeToRoot(roots, destDir)} but could not remove the backup at ${relativeToRoot(roots, backupDir)} (${error.message})`,
      );
    }
  }

  return {
    slug: resolvedSlug,
    status: destExists ? "replaced" : "extracted",
    detail: `${relativeToRoot(roots, destDir)} (${path.resolve(jsonPath)})`,
  };
}

module.exports = {
  DIST_DIR_NAME,
  SLUG_PATTERN,
  SOURCE_DIR_NAME,
  defaultRoots,
  runBuild,
  runExtract,
};

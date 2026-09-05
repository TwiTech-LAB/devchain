#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { Command } = require("commander");
const { defaultRoots, runBuild, runExtract } = require("./filesystem.js");

// The shared package ships as ESM while this CLI is CommonJS, so the built
// ExportSchema can only be reached through a dynamic import of a file:// URL
// (same resolver strategy as scripts/cli.js). Resolution is deferred until a
// command action runs so argument errors never pay the import cost.
function resolveSharedDistSpecifier() {
  const candidates = [
    path.resolve(
      __dirname,
      "..",
      "..",
      "packages",
      "shared",
      "dist",
      "index.js",
    ),
    path.resolve(
      __dirname,
      "..",
      "..",
      "node_modules",
      "@devchain",
      "shared",
      "dist",
      "index.js",
    ),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return pathToFileURL(candidate).href;
    }
  }
  return null;
}

async function loadSchemaValidator() {
  const specifier = resolveSharedDistSpecifier();
  if (specifier === null) {
    throw new Error(
      "packages/shared/dist/index.js not found; run `pnpm --filter shared build` first",
    );
  }
  const shared = await import(specifier);
  if (!shared.ExportSchema) {
    throw new Error(`${specifier} does not export ExportSchema`);
  }
  return (rawTemplate) => {
    const result = shared.ExportSchema.safeParse(rawTemplate);
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ");
      throw new Error(`template failed ExportSchema validation: ${issues}`);
    }
  };
}

function reportBuildResults(results, roots) {
  if (results.length === 0) {
    console.log(
      `no source templates found under ${path.relative(roots.repoRoot, roots.srcDir)}`,
    );
    return;
  }
  for (const result of results) {
    let prefix = "drift";
    if (result.status === "built") {
      prefix = "built";
    } else if (result.status === "up-to-date") {
      prefix = "checked";
    }
    console.log(`${prefix} ${result.slug}: ${result.detail}`);
  }
  if (results.some((result) => !result.ok)) {
    process.exitCode = 1;
  }
}

async function main() {
  const pkg = require("../../package.json");
  const program = new Command();

  program
    .name("templates")
    .description("Compose and decompose bundled template sources")
    .version(pkg.version);

  program
    .command("build")
    .description(
      "Compose templates-src/<slug>/ sources into templates/<slug>.json (all sources when no slug is given)",
    )
    .argument("[slug]", "source template slug to build")
    .option("--check", "validate and byte-compare without writing")
    .action(async (slug, options) => {
      const validate = await loadSchemaValidator();
      const roots = defaultRoots();
      const results = runBuild({
        slug,
        check: Boolean(options.check),
        roots,
        validate,
      });
      reportBuildResults(results, roots);
    });

  program
    .command("extract")
    .description(
      "Decompose a template export JSON into templates-src/<slug>/ (slug from _manifest.slug unless --slug is given)",
    )
    .argument("<json-path>", "path to the exported template JSON")
    .option(
      "--slug <slug>",
      "destination slug (must match _manifest.slug when present)",
    )
    .option("--force", "replace an existing source directory")
    .action(async (jsonPath, options) => {
      const validate = await loadSchemaValidator();
      const result = runExtract({
        jsonPath,
        slug: options.slug,
        force: Boolean(options.force),
        validate,
      });
      console.log(`${result.status} ${result.slug}: ${result.detail}`);
    });

  await program.parseAsync(process.argv);
}

main().catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exitCode = 1;
});

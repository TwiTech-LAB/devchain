const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { FILE_POINTER_KEY } = require("../templates/codec.js");
const {
  defaultRoots,
  runBuild,
  runExtract,
} = require("../templates/filesystem.js");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CLI_PATH = path.join(REPO_ROOT, "scripts", "templates", "index.js");

const validate = () => {};

const tmpRoots = [];

function makeRoots() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "templates-cli-"));
  tmpRoots.push(repoRoot);
  return {
    repoRoot,
    srcDir: path.join(repoRoot, "templates-src"),
    distDir: path.join(repoRoot, "templates"),
  };
}

afterEach(() => {
  while (tmpRoots.length > 0) {
    fs.rmSync(tmpRoots.pop(), { recursive: true, force: true });
  }
});

function pointer(filePath) {
  return { [FILE_POINTER_KEY]: filePath };
}

function makeSourceTemplate(slug) {
  return {
    _manifest: { slug, name: "Test Template" },
    prompts: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        title: "P One",
        content: pointer("prompts/001-p-one.md"),
      },
    ],
    profiles: [
      {
        id: "44444444-4444-4444-8444-444444444444",
        name: "Prof",
        instructions: pointer("profiles/001-prof.md"),
      },
    ],
  };
}

function makeSourceFiles() {
  return {
    "prompts/001-p-one.md": "hello\r\nbytes  ",
    "profiles/001-prof.md": "instructions\n",
  };
}

function makeRawExport(slug) {
  return {
    _manifest: { slug, name: "Test Template" },
    prompts: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        title: "P One",
        content: "hello\r\nbytes  ",
      },
    ],
    profiles: [
      {
        id: "44444444-4444-4444-8444-444444444444",
        name: "Prof",
        instructions: "instructions\n",
      },
    ],
  };
}

function seedSource(roots, slug, template, files) {
  const sourceDir = path.join(roots.srcDir, slug);
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(
    path.join(sourceDir, "template.json"),
    JSON.stringify(template, null, 2),
  );
  for (const [relativePath, content] of Object.entries(files)) {
    const targetPath = path.join(sourceDir, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content);
  }
  return sourceDir;
}

function hiddenEntries(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => name.startsWith("."));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

describe("templates build", () => {
  it("builds every source template when no slug is given", () => {
    const roots = makeRoots();
    seedSource(roots, "alpha", makeSourceTemplate("alpha"), makeSourceFiles());
    seedSource(roots, "beta", makeSourceTemplate("beta"), makeSourceFiles());

    const results = runBuild({ roots, validate });

    expect(results.map((result) => result.slug).sort()).toEqual([
      "alpha",
      "beta",
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    for (const slug of ["alpha", "beta"]) {
      expect(
        fs.readFileSync(path.join(roots.distDir, `${slug}.json`), "utf8"),
      ).toBe(JSON.stringify(makeRawExport(slug), null, 2));
    }
  });

  it("builds only the requested slug", () => {
    const roots = makeRoots();
    seedSource(roots, "alpha", makeSourceTemplate("alpha"), makeSourceFiles());
    seedSource(roots, "beta", makeSourceTemplate("beta"), makeSourceFiles());

    const results = runBuild({ slug: "alpha", roots, validate });

    expect(results.map((result) => result.slug)).toEqual(["alpha"]);
    expect(fs.existsSync(path.join(roots.distDir, "alpha.json"))).toBe(true);
    expect(fs.existsSync(path.join(roots.distDir, "beta.json"))).toBe(false);
  });

  it("rejects an unknown slug and lists what is available", () => {
    const roots = makeRoots();
    seedSource(roots, "alpha", makeSourceTemplate("alpha"), makeSourceFiles());

    expect(() => runBuild({ slug: "ghost", roots, validate })).toThrow(
      /no source template "ghost".*available: alpha/,
    );
    expect(fs.existsSync(roots.distDir)).toBe(false);
  });

  it("rejects slugs outside the repository slug pattern before any mutation", () => {
    const roots = makeRoots();
    seedSource(roots, "alpha", makeSourceTemplate("alpha"), makeSourceFiles());

    expect(() => runBuild({ slug: "../escape", roots, validate })).toThrow(
      /invalid build slug/,
    );
    expect(fs.existsSync(roots.distDir)).toBe(false);
  });

  it("byte-compares without writing when --check is used", () => {
    const roots = makeRoots();
    seedSource(roots, "alpha", makeSourceTemplate("alpha"), makeSourceFiles());
    runBuild({ roots, validate });

    let results = runBuild({ check: true, roots, validate });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      slug: "alpha",
      status: "up-to-date",
      ok: true,
    });

    fs.writeFileSync(path.join(roots.distDir, "alpha.json"), "{}");
    results = runBuild({ check: true, roots, validate });
    expect(results[0]).toMatchObject({
      slug: "alpha",
      status: "drift",
      ok: false,
    });
    expect(
      fs.readFileSync(path.join(roots.distDir, "alpha.json"), "utf8"),
    ).toBe("{}");

    fs.rmSync(path.join(roots.distDir, "alpha.json"));
    results = runBuild({ check: true, roots, validate });
    expect(results[0]).toMatchObject({
      slug: "alpha",
      status: "missing",
      ok: false,
    });
    expect(fs.existsSync(path.join(roots.distDir, "alpha.json"))).toBe(false);
    expect(hiddenEntries(roots.distDir)).toEqual([]);
  });

  it("validates during --check so broken sources fail even without an artifact", () => {
    const roots = makeRoots();
    const broken = makeSourceTemplate("alpha");
    broken.prompts[0].content = "inline string";
    seedSource(roots, "alpha", broken, makeSourceFiles());

    expect(() => runBuild({ check: true, roots, validate })).toThrow(
      /inline strings are not allowed/,
    );
    expect(fs.existsSync(roots.distDir)).toBe(false);
  });

  it("keeps the prior artifact and leaves no temp sibling when validation fails", () => {
    const roots = makeRoots();
    seedSource(roots, "alpha", makeSourceTemplate("alpha"), makeSourceFiles());
    runBuild({ roots, validate });
    const distPath = path.join(roots.distDir, "alpha.json");
    const before = fs.readFileSync(distPath, "utf8");

    const brokenFiles = makeSourceFiles();
    delete brokenFiles["prompts/001-p-one.md"];
    seedSource(roots, "alpha", makeSourceTemplate("alpha"), brokenFiles);
    fs.rmSync(path.join(roots.srcDir, "alpha", "prompts", "001-p-one.md"));

    expect(() => runBuild({ roots, validate })).toThrow(/missing file/);
    expect(fs.readFileSync(distPath, "utf8")).toBe(before);
    expect(hiddenEntries(roots.distDir)).toEqual([]);
  });

  it("fails before mutation when the compiled destination is a symlink", () => {
    const roots = makeRoots();
    seedSource(roots, "alpha", makeSourceTemplate("alpha"), makeSourceFiles());
    fs.mkdirSync(roots.distDir, { recursive: true });
    const targetPath = path.join(roots.distDir, "real-target.json");
    fs.writeFileSync(targetPath, "prior bytes");
    fs.symlinkSync(targetPath, path.join(roots.distDir, "alpha.json"));

    expect(() => runBuild({ roots, validate })).toThrow(/symlink/);
    expect(fs.readFileSync(targetPath, "utf8")).toBe("prior bytes");
    expect(hiddenEntries(roots.distDir)).toEqual([]);
  });

  it("fails before mutation when the compiled template root is a symlink", () => {
    const roots = makeRoots();
    seedSource(roots, "alpha", makeSourceTemplate("alpha"), makeSourceFiles());
    const externalDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "templates-external-"),
    );
    tmpRoots.push(externalDir);
    fs.symlinkSync(externalDir, roots.distDir);

    expect(() => runBuild({ roots, validate })).toThrow(
      /compiled template root .* is a symlink; refusing to mutate/,
    );
    expect(fs.readdirSync(externalDir)).toEqual([]);
  });

  it("rejects unexpected entries and nested directories in source trees", () => {
    const roots = makeRoots();
    seedSource(roots, "alpha", makeSourceTemplate("alpha"), makeSourceFiles());
    fs.mkdirSync(path.join(roots.srcDir, "alpha", "extra"));
    expect(() => runBuild({ roots, validate })).toThrow(/unexpected entry/);

    const rootsTwo = makeRoots();
    seedSource(
      rootsTwo,
      "alpha",
      makeSourceTemplate("alpha"),
      makeSourceFiles(),
    );
    fs.mkdirSync(path.join(rootsTwo.srcDir, "alpha", "prompts", "nested"));
    expect(() => runBuild({ roots: rootsTwo, validate })).toThrow(
      /must stay flat/,
    );
  });

  it("rejects symlinked source prose files", () => {
    const roots = makeRoots();
    seedSource(roots, "alpha", makeSourceTemplate("alpha"), makeSourceFiles());
    const profDir = path.join(roots.srcDir, "alpha", "profiles");
    const outsidePath = path.join(roots.repoRoot, "outside.md");
    fs.renameSync(path.join(profDir, "001-prof.md"), outsidePath);
    fs.symlinkSync(outsidePath, path.join(profDir, "001-prof.md"));

    expect(() => runBuild({ roots, validate })).toThrow(/symlink/);
  });

  it("reports the template slug when a source fails schema validation", () => {
    const roots = makeRoots();
    seedSource(roots, "alpha", makeSourceTemplate("alpha"), makeSourceFiles());

    const failingValidate = () => {
      throw new Error("schema rejected the raw value");
    };

    expect(() => runBuild({ roots, validate: failingValidate })).toThrow(
      /template alpha: schema rejected/,
    );
    expect(fs.existsSync(roots.distDir)).toBe(false);
  });
});

describe("templates extract", () => {
  function writeExportFile(roots, rawExport) {
    const exportPath = path.join(roots.repoRoot, "export.json");
    fs.writeFileSync(exportPath, JSON.stringify(rawExport, null, 2));
    return exportPath;
  }

  it("extracts using _manifest.slug and preserves prose bytes exactly", () => {
    const roots = makeRoots();
    const exportPath = writeExportFile(roots, makeRawExport("teams-dev"));

    const result = runExtract({ jsonPath: exportPath, roots, validate });

    expect(result).toMatchObject({ slug: "teams-dev", status: "extracted" });
    const sourceDir = path.join(roots.srcDir, "teams-dev");
    expect(fs.readFileSync(path.join(sourceDir, "template.json"), "utf8")).toBe(
      JSON.stringify(makeSourceTemplate("teams-dev"), null, 2),
    );
    expect(
      fs.readFileSync(path.join(sourceDir, "prompts", "001-p-one.md"), "utf8"),
    ).toBe("hello\r\nbytes  ");
    expect(
      fs.readFileSync(path.join(sourceDir, "profiles", "001-prof.md"), "utf8"),
    ).toBe("instructions\n");
    expect(hiddenEntries(roots.srcDir)).toEqual([]);
  });

  it("round-trips through build byte-for-byte", () => {
    const roots = makeRoots();
    const exportPath = writeExportFile(roots, makeRawExport("teams-dev"));
    runExtract({ jsonPath: exportPath, roots, validate });

    runBuild({ roots, validate });

    expect(
      fs.readFileSync(path.join(roots.distDir, "teams-dev.json"), "utf8"),
    ).toBe(JSON.stringify(makeRawExport("teams-dev"), null, 2));
  });

  it("requires an explicit JSON input path", () => {
    const roots = makeRoots();
    expect(() => runExtract({ roots, validate })).toThrow(
      /requires an explicit JSON input path/,
    );
    expect(() =>
      runExtract({
        jsonPath: path.join(roots.repoRoot, "nope.json"),
        roots,
        validate,
      }),
    ).toThrow(/cannot read JSON input/);
  });

  it("requires --slug when the manifest slug is absent", () => {
    const roots = makeRoots();
    const raw = makeRawExport("teams-dev");
    delete raw._manifest.slug;
    const exportPath = writeExportFile(roots, raw);

    expect(() => runExtract({ jsonPath: exportPath, roots, validate })).toThrow(
      /no _manifest\.slug/,
    );

    const result = runExtract({
      jsonPath: exportPath,
      slug: "renamed",
      roots,
      validate,
    });
    expect(result).toMatchObject({ slug: "renamed" });
    expect(fs.existsSync(path.join(roots.srcDir, "renamed"))).toBe(true);
  });

  it("rejects disagreement between _manifest.slug and --slug", () => {
    const roots = makeRoots();
    const exportPath = writeExportFile(roots, makeRawExport("teams-dev"));

    expect(() =>
      runExtract({ jsonPath: exportPath, slug: "other", roots, validate }),
    ).toThrow(/conflicts with --slug/);
    expect(fs.existsSync(roots.srcDir)).toBe(false);
  });

  it("requires --force before replacing an existing source directory", () => {
    const roots = makeRoots();
    const exportPath = writeExportFile(roots, makeRawExport("teams-dev"));
    runExtract({ jsonPath: exportPath, roots, validate });
    const markerPath = path.join(roots.srcDir, "teams-dev", "stale-marker.txt");
    fs.writeFileSync(markerPath, "stale");

    expect(() => runExtract({ jsonPath: exportPath, roots, validate })).toThrow(
      /already exists; pass --force/,
    );
    expect(fs.readFileSync(markerPath, "utf8")).toBe("stale");

    const result = runExtract({
      jsonPath: exportPath,
      slug: "teams-dev",
      force: true,
      roots,
      validate,
    });
    expect(result).toMatchObject({ slug: "teams-dev", status: "replaced" });
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(
      fs.readFileSync(
        path.join(roots.srcDir, "teams-dev", "prompts", "001-p-one.md"),
        "utf8",
      ),
    ).toBe("hello\r\nbytes  ");
    expect(hiddenEntries(roots.srcDir)).toEqual([]);
  });

  it("fails before mutation when the destination is a symlink", () => {
    const roots = makeRoots();
    const exportPath = writeExportFile(roots, makeRawExport("teams-dev"));
    fs.mkdirSync(roots.srcDir, { recursive: true });
    const targetDir = path.join(roots.srcDir, "real-tree");
    fs.mkdirSync(targetDir);
    fs.symlinkSync(targetDir, path.join(roots.srcDir, "teams-dev"));

    expect(() => runExtract({ jsonPath: exportPath, roots, validate })).toThrow(
      /symlink/,
    );
    expect(fs.readdirSync(targetDir)).toEqual([]);
    expect(hiddenEntries(roots.srcDir)).toEqual([]);
  });

  it("rejects a symlinked source root and leaves the symlink target untouched", () => {
    const roots = makeRoots();
    const externalDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "templates-external-"),
    );
    tmpRoots.push(externalDir);
    fs.symlinkSync(externalDir, roots.srcDir);
    const exportPath = writeExportFile(roots, makeRawExport("teams-dev"));

    expect(() => runExtract({ jsonPath: exportPath, roots, validate })).toThrow(
      /source template root .* is a symlink; refusing to mutate/,
    );
    expect(fs.existsSync(path.join(externalDir, "teams-dev"))).toBe(false);
    expect(fs.readdirSync(externalDir)).toEqual([]);
    expect(fs.lstatSync(roots.srcDir).isSymbolicLink()).toBe(true);
  });

  it("rejects a symlinked source root even with --force and an occupied target", () => {
    const roots = makeRoots();
    const externalDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "templates-external-"),
    );
    tmpRoots.push(externalDir);
    fs.mkdirSync(path.join(externalDir, "teams-dev"));
    fs.symlinkSync(externalDir, roots.srcDir);
    const exportPath = writeExportFile(roots, makeRawExport("teams-dev"));

    expect(() =>
      runExtract({ jsonPath: exportPath, force: true, roots, validate }),
    ).toThrow(/source template root .* is a symlink/);
    expect(fs.readdirSync(path.join(externalDir, "teams-dev"))).toEqual([]);
  });

  it("retains the prior tree when the staged swap fails", () => {
    const roots = makeRoots();
    const exportPath = writeExportFile(roots, makeRawExport("teams-dev"));
    runExtract({ jsonPath: exportPath, roots, validate });
    fs.writeFileSync(
      path.join(roots.srcDir, "teams-dev", "prior-marker.txt"),
      "prior",
    );

    const realRename = fs.renameSync;
    let calls = 0;
    const failingRename = (from, to) => {
      calls += 1;
      if (calls === 2) throw new Error("simulated swap failure");
      return realRename(from, to);
    };

    expect(() =>
      runExtract({
        jsonPath: exportPath,
        force: true,
        roots,
        validate,
        renameSync: failingRename,
      }),
    ).toThrow(/simulated swap failure/);
    expect(
      fs.readFileSync(
        path.join(roots.srcDir, "teams-dev", "prior-marker.txt"),
        "utf8",
      ),
    ).toBe("prior");
    expect(hiddenEntries(roots.srcDir)).toEqual([]);
  });

  it("reports the retained backup path when both swap and restore fail", () => {
    const roots = makeRoots();
    const exportPath = writeExportFile(roots, makeRawExport("teams-dev"));
    runExtract({ jsonPath: exportPath, roots, validate });
    fs.writeFileSync(
      path.join(roots.srcDir, "teams-dev", "prior-marker.txt"),
      "prior",
    );

    const realRename = fs.renameSync;
    let calls = 0;
    const failingRename = (from, to) => {
      calls += 1;
      if (calls >= 2) throw new Error("simulated swap failure");
      return realRename(from, to);
    };

    let error = null;
    try {
      runExtract({
        jsonPath: exportPath,
        force: true,
        roots,
        validate,
        renameSync: failingRename,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).not.toBeNull();
    expect(error.message).toMatch(/retained at/);
    const backupMatch = error.message.match(/retained at (\S+)/);
    expect(backupMatch).not.toBeNull();
    const backupDir = path.join(roots.repoRoot, backupMatch[1]);
    expect(
      fs.readFileSync(path.join(backupDir, "prior-marker.txt"), "utf8"),
    ).toBe("prior");
  });
});

describe("templates CLI child process (read-only against tracked files)", () => {
  const cli = (args) =>
    spawnSync(process.execPath, [CLI_PATH, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 120000,
    });

  it("loads the built ESM ExportSchema and completes a read-only check", () => {
    const realSrcDir = path.join(
      REPO_ROOT,
      "apps",
      "local-app",
      "templates-src",
    );
    const existedBefore = fs.existsSync(realSrcDir);

    const result = cli(["build", "--check"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    if (!existedBefore) {
      expect(fs.existsSync(realSrcDir)).toBe(false);
    }
  });

  it("requires an explicit JSON path for extract", () => {
    const result = cli(["extract"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/missing required argument/i);
  });

  it("renders help for the command surface", () => {
    const help = cli(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/\bbuild\b/);
    expect(help.stdout).toMatch(/\bextract\b/);

    const buildHelp = cli(["build", "--help"]);
    expect(buildHelp.status).toBe(0);
    expect(buildHelp.stdout).toMatch(/--check/);

    const extractHelp = cli(["extract", "--help"]);
    expect(extractHelp.status).toBe(0);
    expect(extractHelp.stdout).toMatch(/--slug/);
    expect(extractHelp.stdout).toMatch(/--force/);
  });
});

describe("repository guards for the template tooling", () => {
  it("exposes root aliases and a direct read-only check in the root build", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
    );
    expect(pkg.scripts["templates:help"]).toBe(
      "node scripts/templates/index.js --help",
    );
    expect(pkg.scripts["templates:build"]).toBe(
      "node scripts/templates/index.js build",
    );
    expect(pkg.scripts["templates:extract"]).toBe(
      "node scripts/templates/index.js extract",
    );
    expect(pkg.scripts["check:templates"]).toBe(
      "node scripts/templates/index.js build --check",
    );
    expect(pkg.scripts.build).toContain(
      "pnpm --filter shared build && node scripts/templates/index.js build --check",
    );
  });

  it("scopes turbo test cache inputs to the codec and its matching tests", () => {
    const rootTurbo = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "turbo.json"), "utf8"),
    );
    const localAppTurbo = JSON.parse(
      fs.readFileSync(
        path.join(REPO_ROOT, "apps", "local-app", "turbo.json"),
        "utf8",
      ),
    );
    expect(rootTurbo.tasks["apps/local-app#test"]).toBeUndefined();
    expect(rootTurbo.tasks.test.inputs).toEqual(["$TURBO_DEFAULT$"]);
    expect(localAppTurbo.tasks.test.inputs).toEqual([
      "$TURBO_DEFAULT$",
      "$TURBO_ROOT$/scripts/templates/**",
      "$TURBO_ROOT$/scripts/__tests__/templates-*.test.js",
    ]);
  });

  it("protects template source bytes from EOL and formatter rewriting", () => {
    const gitattributes = fs.readFileSync(
      path.join(REPO_ROOT, ".gitattributes"),
      "utf8",
    );
    expect(gitattributes).toContain("apps/local-app/templates-src/** -text");
    expect(gitattributes).toContain("apps/local-app/templates/** -text");

    const editorconfig = fs.readFileSync(
      path.join(REPO_ROOT, ".editorconfig"),
      "utf8",
    );
    expect(editorconfig).toContain("[apps/local-app/templates-src/**]");
    expect(editorconfig).toContain("[apps/local-app/templates/**]");
    expect(editorconfig).toContain("insert_final_newline = false");
    expect(editorconfig).toContain("trim_trailing_whitespace = false");

    const prettierignore = fs.readFileSync(
      path.join(REPO_ROOT, ".prettierignore"),
      "utf8",
    );
    expect(prettierignore).toContain("apps/local-app/templates-src/");
    expect(prettierignore).toContain("apps/local-app/templates/");
  });

  it("defaults to the tracked repository template directories", () => {
    const roots = defaultRoots();
    expect(roots.srcDir).toBe(
      path.join(REPO_ROOT, "apps", "local-app", "templates-src"),
    );
    expect(roots.distDir).toBe(
      path.join(REPO_ROOT, "apps", "local-app", "templates"),
    );
  });
});

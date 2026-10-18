"use strict";

const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const {
  projectRuntimeManifest,
  validateShrinkwrap,
  checkShrinkwrap,
} = require("../npm-shrinkwrap.js");

function fixture() {
  const manifest = {
    name: "fixture-cli",
    version: "1.0.0",
    engines: { node: ">=24.0.0" },
    dependencies: { runtime: "^1.0.0" },
    optionalDependencies: { "platform-addon": "2.0.0" },
    peerDependencies: { peer: "^3.0.0" },
    peerDependenciesMeta: { peer: { optional: true } },
    devDependencies: { jest: "30.0.0" },
    scripts: { postinstall: "exit 1" },
    workspaces: ["apps/*"],
  };
  const record = (name, version, extra = {}) => ({
    version,
    resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
    integrity: "sha512-Zml4dHVyZQ==",
    ...extra,
  });
  const lock = {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": projectRuntimeManifest(manifest),
      "node_modules/runtime": record("runtime", "1.2.0", {
        optionalDependencies: { "platform-child": "2.0.0" },
      }),
      "node_modules/platform-addon": record("platform-addon", "2.0.0", {
        optional: true,
        os: ["darwin"],
        cpu: ["arm64"],
      }),
      "node_modules/platform-child": record("platform-child", "2.0.0", {
        optional: true,
        os: ["linux"],
        cpu: ["x64"],
        libc: ["musl"],
      }),
    },
  };
  return { manifest, lock };
}

// Pure fixtures exercise the packing contract without an npm process or registry.
describe("runtime shrinkwrap validation", () => {
  it("projects runtime resolution fields without development or workspace configuration", () => {
    const { manifest } = fixture();
    expect(projectRuntimeManifest(manifest)).toEqual({
      name: "fixture-cli",
      version: "1.0.0",
      engines: { node: ">=24.0.0" },
      dependencies: { runtime: "^1.0.0" },
      optionalDependencies: { "platform-addon": "2.0.0" },
      peerDependencies: { peer: "^3.0.0" },
      peerDependenciesMeta: { peer: { optional: true } },
    });
    expect(manifest.devDependencies).toEqual({ jest: "30.0.0" });
  });

  it("preserves optional records for other operating systems, CPUs, and libc variants", () => {
    const { manifest, lock } = fixture();
    const original = structuredClone(lock);
    expect(validateShrinkwrap(manifest, lock)).toEqual(original);
    expect(lock).toEqual(original);
  });

  it.each(["1.0.1", "1.0.0-lan.202610111800"])(
    "accepts package version %s while leaving the lock and dependency pins unchanged",
    (version) => {
      const { manifest, lock } = fixture();
      const original = structuredClone(lock);
      expect(validateShrinkwrap({ ...manifest, version }, lock)).toEqual(
        original,
      );
    },
  );

  it.each(["dependencies", "optionalDependencies", "peerDependencies"])(
    "rejects missing or stale specs in %s",
    (field) => {
      const { manifest, lock } = fixture();
      const name = Object.keys(manifest[field])[0];
      lock.packages[""][field][name] = "*";
      expect(() => validateShrinkwrap(manifest, lock)).toThrow(
        `root ${field} are stale`,
      );
      delete lock.packages[""][field][name];
      expect(() => validateShrinkwrap(manifest, lock)).toThrow(
        `root ${field} are stale`,
      );
    },
  );

  it.each(["addition", "removal", "type change"])(
    "rejects a runtime dependency %s until reconciliation",
    (change) => {
      const { manifest, lock } = fixture();
      if (change === "addition") manifest.dependencies.added = "1.0.0";
      if (change === "removal") delete manifest.dependencies.runtime;
      if (change === "type change") {
        manifest.optionalDependencies.runtime = manifest.dependencies.runtime;
        delete manifest.dependencies.runtime;
      }
      expect(() => validateShrinkwrap(manifest, lock)).toThrow(
        "root dependencies are stale",
      );
    },
  );

  it.each([
    "workspace:*",
    "link:../runtime",
    "file:../runtime.tgz",
    "../runtime",
    "./runtime",
    ".",
    "~/runtime",
    "runtime.tgz",
    "runtime.tar.gz",
    "/tmp/runtime",
    "C:\\runtime",
  ])(
    "rejects the local dependency spec %s in root and transitive declarations",
    (spec) => {
      const { manifest, lock } = fixture();
      manifest.dependencies.runtime = spec;
      expect(() => validateShrinkwrap(manifest, lock)).toThrow(
        "must not use a workspace, link, or local-file dependency",
      );
      manifest.dependencies.runtime = "^1.0.0";
      lock.packages["node_modules/runtime"].dependencies = { local: spec };
      expect(() => validateShrinkwrap(manifest, lock)).toThrow(
        "must not use a workspace, link, or local-file dependency",
      );
    },
  );

  it.each([
    "file:../runtime",
    "https://private.example/runtime.tgz",
    "https://registry.npmjs.org.evil.example/runtime.tgz",
    "https://user:pass@registry.npmjs.org/runtime.tgz",
  ])("rejects non-public resolution %s", (resolved) => {
    const { manifest, lock } = fixture();
    lock.packages["node_modules/runtime"].resolved = resolved;
    expect(() => validateShrinkwrap(manifest, lock)).toThrow(
      "must resolve from https://registry.npmjs.org/",
    );
  });

  it.each([
    [
      "package identity",
      (lock) => {
        lock.name = "other-cli";
      },
      "package identity is stale",
    ],
    [
      "root identity",
      (lock) => {
        lock.packages[""].name = "other-cli";
      },
      "root package identity is stale",
    ],
    [
      "lock format",
      (lock) => {
        lock.lockfileVersion = 2;
      },
      "lockfileVersion 3",
    ],
    [
      "root package",
      (lock) => {
        delete lock.packages[""];
      },
      "missing its root package",
    ],
    [
      "runtime record",
      (lock) => {
        delete lock.packages["node_modules/runtime"];
      },
      "missing a runtime package",
    ],
    [
      "local link",
      (lock) => {
        lock.packages["node_modules/runtime"].link = true;
      },
      "contains a local link",
    ],
    [
      "local package path",
      (lock) => {
        lock.packages["apps/runtime"] = lock.packages["node_modules/runtime"];
      },
      "contains a local package path",
    ],
    [
      "development declarations",
      (lock) => {
        lock.packages[""].devDependencies = { jest: "*" };
      },
      "exclude development dependencies",
    ],
    [
      "workspace configuration",
      (lock) => {
        lock.packages[""].workspaces = ["apps/*"];
      },
      "exclude workspace configuration",
    ],
    [
      "development record",
      (lock) => {
        lock.packages["node_modules/runtime"].dev = true;
      },
      "development-only package",
    ],
    [
      "missing integrity",
      (lock) => {
        delete lock.packages["node_modules/runtime"].integrity;
      },
      "missing integrity",
    ],
    [
      "required peer",
      (lock) => {
        lock.packages[""].peerDependenciesMeta.peer.optional = false;
      },
      "peerDependenciesMeta are stale",
    ],
  ])("rejects invalid %s", (_label, mutate, expected) => {
    const { manifest, lock } = fixture();
    mutate(lock);
    expect(() => validateShrinkwrap(manifest, lock)).toThrow(expected);
  });

  it("checks files offline without modifying the shrinkwrap and reports a missing lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shrinkwrap-fixture-"));
    const { manifest, lock } = fixture();
    const lockText = JSON.stringify(lock, null, 2) + "\n";
    try {
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify(manifest),
      );
      await writeFile(join(directory, "npm-shrinkwrap.json"), lockText);
      expect(await checkShrinkwrap(directory)).toEqual(lock);
      expect(
        await readFile(join(directory, "npm-shrinkwrap.json"), "utf8"),
      ).toBe(lockText);
      await rm(join(directory, "npm-shrinkwrap.json"));
      await expect(checkShrinkwrap(directory)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

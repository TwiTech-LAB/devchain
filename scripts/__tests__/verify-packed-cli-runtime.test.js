"use strict";

const { mkdtemp, mkdir, rm, symlink, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { verifyInstalledVersions } = require("../verify-packed-cli-runtime.js");

// Real filesystem fixtures catch version and symlink errors without an npm install.
describe("installed runtime versions", () => {
  let directory;
  let packageRoot;
  let originalLock;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "installed-runtime-fixture-"));
    packageRoot = join(directory, "package");
    await mkdir(packageRoot);
    originalLock = {
      packages: {
        "": { name: "fixture-cli", version: "1.0.0" },
        "node_modules/runtime": { version: "1.2.0" },
        "node_modules/runtime/node_modules/nested": { version: "2.0.0" },
        "node_modules/platform-addon": {
          version: "3.0.0",
          optional: true,
          os: ["darwin"],
          cpu: ["arm64"],
        },
      },
    };
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function installFixture(overrides = {}, omitted = []) {
    for (const [location, record] of Object.entries(originalLock.packages)) {
      if (location === "" || omitted.includes(location)) continue;
      await mkdir(join(packageRoot, location), { recursive: true });
      await writeFile(
        join(packageRoot, location, "package.json"),
        JSON.stringify({ version: overrides[location] ?? record.version }),
      );
    }
  }

  it("compares direct and nested runtime pins while allowing an omitted optional platform package", async () => {
    await installFixture({}, ["node_modules/platform-addon"]);
    expect(await verifyInstalledVersions(packageRoot, originalLock)).toEqual({
      checked: 2,
      omittedOptional: 1,
    });
  });

  it.each([
    "node_modules/runtime",
    "node_modules/runtime/node_modules/nested",
    "node_modules/platform-addon",
  ])(
    "rejects a changed installed pin at %s even if npm rewrote its on-disk lock",
    async (location) => {
      await installFixture({ [location]: "9.0.0" });
      const rewritten = JSON.parse(JSON.stringify(originalLock));
      rewritten.packages[location].version = "9.0.0";
      await writeFile(
        join(packageRoot, "npm-shrinkwrap.json"),
        JSON.stringify(rewritten),
      );
      await expect(
        verifyInstalledVersions(packageRoot, originalLock),
      ).rejects.toThrow(
        `installed version differs from the original packed lock: ${location}`,
      );
    },
  );

  it("rejects a missing required runtime package", async () => {
    await installFixture({}, ["node_modules/runtime/node_modules/nested"]);
    await expect(
      verifyInstalledVersions(packageRoot, originalLock),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a checkout dependency symlink even when its version matches", async () => {
    await installFixture();
    const external = join(directory, "checkout", "runtime");
    await mkdir(external, { recursive: true });
    await writeFile(
      join(external, "package.json"),
      JSON.stringify({ version: "1.2.0" }),
    );
    await rm(join(packageRoot, "node_modules/runtime"), { recursive: true });
    await symlink(
      external,
      join(packageRoot, "node_modules/runtime"),
      "junction",
    );
    await expect(
      verifyInstalledVersions(packageRoot, originalLock),
    ).rejects.toThrow(
      "installed package escapes the extracted installation: node_modules/runtime",
    );
  });
});

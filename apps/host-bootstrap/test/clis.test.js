"use strict";

// A staged filesystem plus fake downloads tests atomic replacement and cleanup
// without running the third-party installer or touching installed binaries.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { installAgy, installClis } = require("../lib/clis");
const { fakeSystem, mode, pinnedCliVersions } = require("./helpers");

async function installDevchainVersion(sys, version) {
  await sys.run("npm", [
    "install",
    "-g",
    `--prefix=${path.join(sys.paths.installRoot, "versions", version)}`,
    `devchain-cli@${version}`,
  ]);
}

for (const outcome of [
  "new",
  "equal",
  "download-fails",
  "binary-fails",
  "empty-version",
]) {
  test(`agy staging: ${outcome}`, async (t) => {
    const { sys, cleanup } = fakeSystem();
    t.after(cleanup);
    const binary = path.join(sys.paths.binDir, "agy");
    fs.writeFileSync(binary, "old binary");
    const before = fs.statSync(binary).ino;
    let temporaryRoot;
    sys.run = async (command, args, options) => {
      if (command === "curl") {
        temporaryRoot = path.dirname(args.at(-1));
        if (outcome === "download-fails") throw new Error("download failed");
      } else if (command === "bash") {
        const stagedDir = args.at(-1);
        assert.deepEqual(fs.readdirSync(stagedDir), []);
        assert.equal(options.env.HOME, path.join(temporaryRoot, "home"));
        fs.writeFileSync(path.join(stagedDir, "agy"), "new binary");
      } else if (command.endsWith("/agy")) {
        if (command === binary) return { stdout: "agy 1.0.0", stderr: "" };
        if (outcome === "binary-fails") throw new Error("bad staged binary");
        return {
          stdout:
            outcome === "empty-version"
              ? ""
              : outcome === "equal"
                ? "agy 1.0.0"
                : "agy 2.0.0",
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    };
    if (["new", "equal"].includes(outcome)) {
      assert.equal(
        await installAgy(sys),
        outcome === "new" ? "agy 2.0.0" : "agy 1.0.0",
      );
    } else {
      await assert.rejects(
        installAgy(sys),
        /download failed|bad staged binary|no version/,
      );
    }
    assert.equal(
      fs.readFileSync(binary, "utf8"),
      outcome === "new" ? "new binary" : "old binary",
    );
    if (outcome === "new") assert.equal(mode(binary), 0o755);
    else assert.equal(fs.statSync(binary).ino, before);
    assert.equal(fs.existsSync(temporaryRoot), false);
    assert.equal(fs.existsSync(path.join(sys.paths.binDir, ".agy.new")), false);
  });
}

test("agy staging replaces a broken installed agy", async (t) => {
  const { sys, cleanup } = fakeSystem();
  t.after(cleanup);
  const binary = path.join(sys.paths.binDir, "agy");
  fs.writeFileSync(binary, "broken binary");
  sys.run = async (command, args) => {
    if (command === "bash") {
      fs.writeFileSync(path.join(args.at(-1), "agy"), "new binary");
    } else if (command === binary) {
      throw new Error("agy: exec format error");
    } else if (command.endsWith("/agy")) {
      return { stdout: "agy 2.0.0", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  assert.equal(await installAgy(sys), "agy 2.0.0");
  assert.equal(fs.readFileSync(binary, "utf8"), "new binary");
  assert.equal(mode(binary), 0o755);
});

for (const scenario of ["missing", "broken"]) {
  test(`installClis fails when the download fails and agy is ${scenario}`, async (t) => {
    const { sys, cleanup } = fakeSystem({
      failOn: (command) => command === "curl",
    });
    t.after(cleanup);
    await installDevchainVersion(sys, "1.0.0");
    const run = sys.run;
    if (scenario === "broken") {
      fs.writeFileSync(path.join(sys.paths.binDir, "agy"), "old agy");
      sys.run = async (command, args, options) => {
        if (command === path.join(sys.paths.binDir, "agy")) {
          throw new Error("agy: exec format error");
        }
        return run(command, args, options);
      };
    }
    await assert.rejects(
      installClis("1.0.0", sys),
      /CLI agy failed: curl failed/,
    );
  });
}

test("installClis keeps a working agy when the download fails", async (t) => {
  const { sys, cleanup } = fakeSystem({
    failOn: (command) => command === "curl",
  });
  t.after(cleanup);
  await installDevchainVersion(sys, "1.0.0");
  fs.writeFileSync(path.join(sys.paths.binDir, "agy"), "old agy");
  const stderrLines = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    stderrLines.push(String(chunk));
    return true;
  };
  try {
    assert.deepEqual(await installClis("1.0.0", sys), pinnedCliVersions());
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.deepEqual(
    stderrLines.filter((line) => line.startsWith("agy update skipped")),
    ["agy update skipped: curl failed; kept agy 1.0.0\n"],
  );
  assert.equal(
    fs.readFileSync(path.join(sys.paths.binDir, "agy"), "utf8"),
    "old agy",
  );
});

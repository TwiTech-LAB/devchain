"use strict";

// Temp-file and command-boundary tests exercise package integrity and handoff
// without installing global packages or requiring root.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { fakeSystem } = require("./helpers");
const { installVersion } = require("../lib/claim");
const {
  refreshHelper,
  runClisHelper,
  NPM_INSTALL_TIMEOUT_MS,
  CLIS_HELPER_TIMEOUT_MS,
} = require("../lib/refresh-helper");

function directory(sys) {
  return path.join(
    sys.paths.installRoot,
    "versions/0.25.0/lib/node_modules/devchain-cli/dist/host-install",
  );
}

test("refresh verifies the archive then installs with the bounded script-free prefix command", async (t) => {
  const { sys, callDetails, cleanup } = fakeSystem();
  t.after(cleanup);
  await installVersion("0.25.0", "https://registry.example/", sys);
  await refreshHelper("0.25.0", sys);
  assert.deepEqual(callDetails.at(-1), {
    command: "npm",
    args: [
      "install",
      "-g",
      `--prefix=${sys.paths.cliPrefix}`,
      "--omit=dev",
      "--no-fund",
      "--no-audit",
      "--ignore-scripts",
      path.join(directory(sys), "devchain-host-bootstrap.tgz"),
    ],
    options: { timeoutMs: NPM_INSTALL_TIMEOUT_MS },
  });
});

test("missing or damaged helper archives fail before npm runs", async (t) => {
  const { sys, calls, cleanup } = fakeSystem();
  t.after(cleanup);
  await installVersion("0.25.0", "https://registry.example/", sys);
  const before = calls.length;
  const archive = path.join(directory(sys), "devchain-host-bootstrap.tgz");
  fs.writeFileSync(archive, "damaged");
  await assert.rejects(refreshHelper("0.25.0", sys), /SHA-256 mismatch/);
  fs.rmSync(archive);
  await assert.rejects(
    refreshHelper("0.25.0", sys),
    /Cannot read bootstrap helper/,
  );
  assert.equal(calls.length, before);
});

test("the caller uses the new helper result and a 45-minute deadline", async () => {
  const calls = [];
  const sys = {
    paths: { binDir: "/usr/local/bin" },
    run: async (...args) => {
      calls.push(args);
      return { stdout: '{"cliVersions":{"future-provider":"9.0.0"}}\n' };
    },
  };
  assert.deepEqual(await runClisHelper("0.25.0", sys), {
    "future-provider": "9.0.0",
  });
  assert.deepEqual(calls, [
    [
      "/usr/local/bin/devchain-host-update",
      ["--clis", "0.25.0"],
      { timeoutMs: CLIS_HELPER_TIMEOUT_MS },
    ],
  ]);
});

async function executeBin(
  argv,
  install,
  packages = async () => {},
  claim = { refreshHostUnit: async () => false },
) {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  let finish;
  const completed = new Promise((resolve) => {
    finish = resolve;
  });
  vm.runInNewContext(
    fs.readFileSync(
      path.join(__dirname, "../bin/devchain-host-update.js"),
      "utf8",
    ),
    {
      require: (name) => {
        if (name === "../lib/system")
          return { createSystem: () => ({ marker: true }) };
        if (name === "../lib/clis") return { installClis: install };
        if (name === "../lib/packages") return { ensureBasePackages: packages };
        if (name === "../lib/update") return {};
        if (name === "../lib/claim") return claim;
        return require(name);
      },
      process: {
        argv: ["node", "devchain-host-update", ...argv],
        getuid: () => 0,
        stdout: {
          write: (value) => {
            stdout += value;
            finish();
          },
        },
        stderr: {
          write: (value) => {
            stderr += value;
          },
        },
        exit: (code) => {
          exitCode = code;
          finish();
        },
      },
    },
  );
  await completed;
  return { stdout, stderr, exitCode };
}

test("--clis emits exactly one JSON line", async () => {
  const order = [];
  const result = await executeBin(
    ["--clis", "0.25.0"],
    async (version, sys) => {
      order.push("clis");
      assert.equal(version, "0.25.0");
      assert.equal(sys.marker, true);
      return { agy: "agy 2.0.0" };
    },
    async (version, sys) => {
      assert.equal(version, "0.25.0");
      assert.equal(sys.marker, true);
      order.push("packages");
    },
  );
  assert.deepEqual(order, ["packages", "clis"]);
  assert.deepEqual(result, {
    stdout: '{"cliVersions":{"agy":"agy 2.0.0"}}\n',
    stderr: "",
    exitCode: 0,
  });
});

test("--clis re-writes the host unit on a claimed VM after the CLIs, logging to stderr only", async () => {
  const order = [];
  const result = await executeBin(
    ["--clis", "0.25.0"],
    async () => {
      order.push("clis");
      return { agy: "agy 2.0.0" };
    },
    async () => {
      order.push("packages");
    },
    {
      refreshHostUnit: async (sys) => {
        assert.equal(sys.marker, true);
        order.push("unit");
        return true;
      },
    },
  );
  assert.deepEqual(order, ["packages", "clis", "unit"]);
  assert.deepEqual(result, {
    stdout: '{"cliVersions":{"agy":"agy 2.0.0"}}\n',
    stderr: "devchain-host.service refreshed from this version's template.\n",
    exitCode: 0,
  });
});

test("--clis package failure preserves PACKAGES_FAILED and skips CLI installation", async () => {
  const result = await executeBin(
    ["--clis", "0.25.0"],
    async () => assert.fail("CLI installation must not run"),
    async () => {
      throw Object.assign(
        new Error("apt-get install failed: E: Unable to fetch jq"),
        {
          code: "PACKAGES_FAILED",
        },
      );
    },
  );
  assert.deepEqual(result, {
    stdout: "",
    stderr:
      '{"code":"PACKAGES_FAILED","message":"apt-get install failed: E: Unable to fetch jq"}\n',
    exitCode: 1,
  });
});

test("--clis errors use JSON stderr and preserve failure and validation exit codes", async () => {
  const fail = async () => {
    throw new Error("download failed");
  };
  const result = await executeBin(["--clis", "0.25.0"], fail);
  assert.equal(result.stdout, "");
  assert.equal(result.exitCode, 1);
  assert.deepEqual(JSON.parse(result.stderr), {
    code: "UPDATE_FAILED",
    message: "download failed",
  });
  const invalid = await executeBin(["--clis", "../bad"], fail);
  assert.equal(invalid.exitCode, 2);
  assert.equal(JSON.parse(invalid.stderr).code, "INVALID_VERSION");
});

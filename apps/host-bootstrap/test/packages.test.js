"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { fakeSystem } = require("./helpers");
const { ensureBasePackages } = require("../lib/packages");
const { CommandError } = require("../lib/system");

function fixture(
  t,
  aptPackages = ["git", "jq", "qemu-guest-agent"],
  output = "git installed\n",
) {
  const { sys, cleanup } = fakeSystem();
  t.after(cleanup);
  const file = path.join(
    sys.paths.installRoot,
    "versions/0.25.0/lib/node_modules/devchain-cli/dist/host-install/pins.json",
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ aptPackages }));
  const calls = [];
  const sleeps = [];
  let time = 0;
  sys.now = () => new Date(time);
  sys.sleep = async (ms) => {
    sleeps.push(ms);
    time += ms;
  };
  sys.run = async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout: command === "dpkg-query" ? output : "", stderr: "" };
  };
  return { sys, calls, sleeps, file };
}

test("unknown and unconfigured packages are installed with only the missing names", async (t) => {
  const { sys, calls } = fixture(
    t,
    ["git", "jq", "file", "jq", "qemu-guest-agent"],
    "git installed\nfile unpacked\nqemu-guest-agent installed\n",
  );
  await ensureBasePackages("0.25.0", sys);
  assert.deepEqual(
    calls.map(({ command, args }) => [command, ...args]),
    [
      ["dpkg-query", "-W", "-f=${Package} ${db:Status-Status}\\n"],
      ["dpkg", "--configure", "-a"],
      ["apt-get", "-o", "DPkg::Lock::Timeout=600", "update"],
      [
        "apt-get",
        "-o",
        "DPkg::Lock::Timeout=600",
        "install",
        "-y",
        "--no-install-recommends",
        "--no-remove",
        "jq",
        "file",
      ],
    ],
  );
  assert.deepEqual(
    calls.slice(1).map(({ options }) => options.timeoutMs),
    [600_000, 600_000, 1_200_000],
  );
  for (const { options } of calls) {
    assert.equal(options.env.DEBIAN_FRONTEND, "noninteractive");
    assert.equal(options.env.LC_ALL, "C");
    assert.equal(options.env.PATH, process.env.PATH);
  }
});

test("all packages installed skips configure and apt, ignoring the guest agent", async (t) => {
  const { sys, calls } = fixture(t, undefined, "git installed\njq installed\n");
  await ensureBasePackages("0.25.0", sys);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "dpkg-query");
});

for (const invalid of [
  undefined,
  [],
  "jq",
  ["--help"],
  ["jq;id"],
  ["jq\n"],
  [4],
  [null],
  ["a b"],
]) {
  test(`invalid package list ${JSON.stringify(invalid)} fails before commands`, async (t) => {
    const { sys, calls, file } = fixture(t);
    fs.writeFileSync(file, JSON.stringify({ aptPackages: invalid }));
    await assert.rejects(ensureBasePackages("0.25.0", sys), {
      code: "PACKAGES_FAILED",
      message: /aptPackages.*valid Debian package names/,
    });
    assert.equal(calls.length, 0);
  });
}

for (const contents of [null, "invalid json"]) {
  test(`missing or malformed pins (${contents}) preserve the read error`, async (t) => {
    const { sys, calls, file } = fixture(t);
    if (contents === null) fs.rmSync(file);
    else fs.writeFileSync(file, contents);
    await assert.rejects(ensureBasePackages("0.25.0", sys), {
      code: "PACKAGES_FAILED",
      message: /Cannot read bootstrap helper for DevChain 0.25.0/,
    });
    assert.equal(calls.length, 0);
  });
}

for (const { lock, command, detail } of [
  {
    lock: "dpkg",
    command: "dpkg",
    detail:
      "dpkg: error: dpkg frontend lock was locked by another process with pid 123",
  },
  {
    lock: "apt lists",
    command: "apt-get update",
    detail:
      "E: Could not get lock /var/lib/apt/lists/lock. It is held by process 123 (apt-get)",
  },
]) {
  for (const released of [true, false]) {
    test(`${lock} lock ${released ? "released after retries" : "held for 600 seconds"}`, async (t) => {
      const { sys, calls, sleeps } = fixture(t);
      const run = sys.run;
      let attempts = 0;
      sys.run = async (...args) => {
        const result = await run(...args);
        const stage =
          args[0] === "dpkg"
            ? "dpkg"
            : args[1].at(-1) === "update"
              ? "apt lists"
              : null;
        if (stage === lock && (++attempts <= 2 || !released))
          throw new CommandError(command, detail);
        return result;
      };
      if (released) {
        await ensureBasePackages("0.25.0", sys);
        assert.equal(attempts, 3);
        assert.deepEqual(sleeps, [5000, 5000]);
        assert.equal(calls.at(-1).args.includes("install"), true);
      } else {
        await assert.rejects(ensureBasePackages("0.25.0", sys), {
          code: "PACKAGES_FAILED",
          message: new RegExp(`The ${lock} lock stayed busy for 600 seconds`),
        });
        assert.equal(
          sleeps.reduce((a, b) => a + b, 0),
          600_000,
        );
        assert.equal(
          calls.some(({ args }) => args.includes("install")),
          false,
        );
      }
    });
  }
}

for (const failure of ["query", "configure", "update", "install"]) {
  test(`${failure} failure stops immediately with package diagnostics`, async (t) => {
    const { sys, calls, sleeps } = fixture(t);
    const run = sys.run;
    sys.run = async (...args) => {
      const result = await run(...args);
      const stage =
        args[0] === "dpkg-query"
          ? "query"
          : args[0] === "dpkg"
            ? "configure"
            : args[1][2];
      if (stage === failure)
        throw new CommandError(
          args[0],
          "cannot access database lock: Permission denied",
        );
      return result;
    };
    await assert.rejects(ensureBasePackages("0.25.0", sys), {
      code: "PACKAGES_FAILED",
      message: /Permission denied/,
    });
    assert.equal(
      calls.length,
      ["query", "configure", "update", "install"].indexOf(failure) + 1,
    );
    assert.deepEqual(sleeps, []);
  });
}

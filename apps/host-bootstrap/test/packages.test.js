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
  return {
    sys,
    calls,
    sleeps,
    file,
    advance: (ms) => {
      time += ms;
    },
  };
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

// A held dpkg lock fails the required step; a held lists lock only skips the update.
for (const { lock, command, detail, fatal } of [
  {
    lock: "dpkg",
    command: "dpkg",
    detail:
      "dpkg: error: dpkg frontend lock was locked by another process with pid 123",
    fatal: true,
  },
  {
    lock: "apt lists",
    command: "apt-get update",
    detail:
      "E: Could not get lock /var/lib/apt/lists/lock. It is held by process 123 (apt-get)",
    fatal: false,
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
        if (fatal) {
          await assert.rejects(ensureBasePackages("0.25.0", sys), {
            code: "PACKAGES_FAILED",
            message: new RegExp(`The ${lock} lock stayed busy for 600 seconds`),
          });
        } else {
          const messages = [];
          t.mock.method(process.stderr, "write", (message) =>
            messages.push(message),
          );
          assert.deepEqual(await ensureBasePackages("0.25.0", sys), {
            skippedTools: [],
          });
          assert.match(
            messages.join(""),
            new RegExp(`The ${lock} lock stayed busy for 600 seconds`),
          );
        }
        assert.equal(
          sleeps.reduce((a, b) => a + b, 0),
          600_000,
        );
        assert.equal(
          calls.some(({ args }) => args.includes("install")),
          !fatal,
        );
      }
    });
  }
}

for (const [failure, callCount] of [
  ["query", 1],
  ["configure", 2],
]) {
  test(`${failure} failure stops immediately with package diagnostics`, async (t) => {
    const { sys, calls, sleeps } = fixture(t);
    const run = sys.run;
    const stages = { "dpkg-query": "query", dpkg: "configure" };
    sys.run = async (...args) => {
      const result = await run(...args);
      if (stages[args[0]] === failure)
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
    assert.equal(calls.length, callCount);
    assert.deepEqual(sleeps, []);
  });
}

// The command boundary is the cheapest layer for apt failures and deadlines;
// a fake clock exercises exhaustion without running apt or waiting in real time.
test("required and best-effort package cases", async (t) => {
  for (const scenario of [
    {
      name: "unknown tool is skipped",
      tools: ["renamed-tool"],
      fail: () => "Unable to locate package renamed-tool",
      installs: [["renamed-tool"], ["renamed-tool"]],
      skipped: ["renamed-tool"],
    },
    {
      name: "failed group falls back to successful, failed and timed-out tools",
      tools: ["file", "missing-tool", "slow-tool"],
      fail: (names) =>
        names.length > 1 || names[0] !== "file" ? "install failed" : null,
      spendTimeout: (names) => names[0] === "slow-tool",
      installs: [
        ["file", "missing-tool", "slow-tool"],
        ["file"],
        ["missing-tool"],
        ["slow-tool"],
      ],
      skipped: ["missing-tool", "slow-tool"],
    },
    {
      name: "an unconfigured tool is purged, so the next tool still installs",
      tools: ["broken-tool", "file"],
      unconfigured: "broken-tool",
      installs: [["broken-tool", "file"], ["broken-tool"], ["file"]],
      skipped: ["broken-tool"],
      purged: true,
    },
    {
      name: "cleanup keeps a package that was installed before the tools phase",
      tools: ["trigger-tool"],
      unconfigured: "trigger-tool",
      unsettles: "jq",
      installs: [["trigger-tool"], ["trigger-tool"]],
      skipped: ["trigger-tool"],
      remains: "jq",
    },
    {
      name: "a tool that would upgrade an installed package is skipped without an install",
      tools: ["newtool", "file"],
      changes: (names) =>
        names.includes("newtool")
          ? "Inst libshared [1.0] (2.0 Ubuntu [amd64])\nInst newtool (1.0 Ubuntu [amd64])\n"
          : "Inst file (1.0 Ubuntu [amd64])\n",
      installs: [["file"]],
      skipped: ["newtool"],
      message: /newtool: it would change the installed packages libshared/,
    },
    {
      name: "tools preparation error skips tools without throwing",
      tools: ["file"],
      configureError: true,
      installs: [],
      skipped: ["file"],
    },
    {
      name: "installed tools are excluded from a successful group",
      tools: ["file", "ripgrep", "ripgrep"],
      output: "git installed\njq installed\nfile installed\n",
      installs: [["ripgrep"]],
      skipped: [],
    },
    {
      name: "installed tools and requirements need no apt commands",
      tools: ["file"],
      output: "git installed\njq installed\nfile installed\n",
      installs: [],
      skipped: [],
      readOnly: true,
    },
    {
      name: "one deadline bounds the group and every fallback, skipping unattempted tools",
      tools: ["one", "two", "three", "four", "five"],
      fail: () => "timed out",
      spendTimeout: () => true,
      installs: [
        ["one", "two", "three", "four", "five"],
        ["one"],
        ["two"],
        ["three"],
        ["four"],
      ],
      skipped: ["one", "two", "three", "four", "five"],
      timeouts: [180_000, 120_000, 120_000, 120_000, 60_000],
    },
    {
      name: "old pins install missing packages strictly without a tools phase",
      output: "git installed\n",
      installs: [["jq"]],
      skipped: [],
    },
    {
      name: "update failure is logged and required install decides",
      tools: ["file"],
      output: "git installed\n",
      updateError: true,
      installs: [["jq"], ["file"]],
      skipped: [],
    },
    {
      name: "required failure stops before tools",
      tools: ["file"],
      output: "git installed\n",
      fail: () => "Unable to fetch jq",
      installs: [["jq"]],
      requiredFailure: true,
    },
  ]) {
    await t.test(scenario.name, async (t) => {
      const { sys, calls, file, advance } = fixture(
        t,
        undefined,
        scenario.output ?? "git installed\njq installed\n",
      );
      fs.writeFileSync(
        file,
        JSON.stringify({
          aptPackages: ["git", "jq", "qemu-guest-agent"],
          toolPackages: scenario.tools,
        }),
      );
      const messages = [];
      t.mock.method(process.stderr, "write", (message) =>
        messages.push(message),
      );
      const run = sys.run;
      // apt refuses every install while a package stays unconfigured, until dpkg purges it.
      let unconfigured = null;
      sys.run = async (command, args, options) => {
        const result = await run(command, args, options);
        if (scenario.configureError && command === "dpkg")
          throw new Error("dpkg failed");
        if (scenario.updateError && args.includes("update"))
          throw new Error("repository unavailable");
        if (command === "dpkg" && args[0] === "--purge")
          if (args.includes(unconfigured)) unconfigured = null;
        if (command === "dpkg-query" && unconfigured)
          return {
            stdout: `${result.stdout}${unconfigured} half-configured\n`,
          };
        const names = args.slice(args.indexOf("--no-remove") + 1);
        // A dry run reports what apt would install; failures belong to the real install.
        if (args[0] === "-s")
          return { stdout: scenario.changes?.(names) ?? "", stderr: "" };
        if (args.includes("install")) {
          if (unconfigured) throw new Error("1 not fully installed or removed");
          if (names.includes(scenario.unconfigured)) {
            unconfigured = scenario.unsettles ?? scenario.unconfigured;
            throw new Error(`${unconfigured} post-installation script failed`);
          }
          if (scenario.spendTimeout?.(names)) advance(options.timeoutMs);
          const error = scenario.fail?.(names);
          if (error) throw new Error(error);
        }
        return result;
      };
      if (scenario.requiredFailure) {
        await assert.rejects(ensureBasePackages("0.25.0", sys), {
          code: "PACKAGES_FAILED",
          message: /Unable to fetch jq/,
        });
      } else {
        assert.deepEqual(await ensureBasePackages("0.25.0", sys), {
          skippedTools: scenario.skipped,
        });
        for (const name of scenario.skipped)
          assert.match(messages.join(""), new RegExp(name));
      }
      const installs = calls.filter(
        ({ args }) => args.includes("install") && args[0] !== "-s",
      );
      assert.deepEqual(
        installs.map(({ args }) => args.slice(args.indexOf("--no-remove") + 1)),
        scenario.installs,
      );
      for (const { args, options } of installs) {
        assert.ok(args.includes("--no-install-recommends"));
        assert.ok(args.includes("--no-remove"));
        assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 20 * 60_000);
      }
      if (scenario.timeouts) {
        assert.deepEqual(
          installs.map(({ options }) => options.timeoutMs),
          scenario.timeouts,
        );
        assert.equal(sys.now().getTime(), 600_000);
      }
      assert.equal(
        calls.some(({ args }) => args[0] === "--purge"),
        Boolean(scenario.purged),
      );
      assert.equal(unconfigured, scenario.remains ?? null);
      if (scenario.message) assert.match(messages.join(""), scenario.message);
      if (scenario.updateError)
        assert.match(
          messages.join(""),
          /apt-get update failed: repository unavailable/,
        );
      if (scenario.readOnly)
        assert.deepEqual(
          calls.map(({ command }) => command),
          ["dpkg-query"],
        );
    });
  }
});

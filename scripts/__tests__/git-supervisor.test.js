const { execFileSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { existsSync } = require("node:fs");
const { chmod, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { runGitSupervisor } = require("../lib/git-supervisor");

// Real processes are required: the gate, exec under the registered pid, the process group and
// signal delivery are kernel behavior. The local DevChain API is replaced by a fetch stub.
const describePosix = process.platform === "win32" ? describe.skip : describe;

function response(body, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

describePosix("git supervisor", () => {
  let directory;
  let git;
  let stderr;
  let calls;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "git-supervisor-"));
    git = join(directory, "git");
    await writeFile(
      git,
      [
        "#!/bin/sh",
        // Jest sandboxes process.env, so the script reads its settings from files beside it.
        'D=$(dirname "$0")',
        'printf "%s\\n" "hold=$DEVCHAIN_GIT_HOLD" "$@" > "$D/args"',
        'ps -o pgid= -p $$ | tr -d " " > "$D/pgid"',
        '[ -f "$D/sleep" ] && exec sleep "$(cat "$D/sleep")"',
        'exit "$(cat "$D/exit" 2>/dev/null || echo 0)"',
        "",
      ].join("\n"),
    );
    await chmod(git, 0o755);
    stderr = { lines: [], isTTY: false, write: (text) => stderr.lines.push(text) };
    calls = [];
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function run(args, routes, dependencies = {}) {
    const fetch = async (url, init) => {
      const path = url.pathname;
      calls.push(path);
      const route = routes[path];
      if (!route) throw new Error(`unexpected request ${path}`);
      return route(JSON.parse(init.body ?? "null"), init);
    };
    return runGitSupervisor(args, {
      git,
      stderr,
      fetch,
      cwd: directory,
      getLocalApiBaseUrl: async () => "http://127.0.0.1:1",
      ...dependencies,
    });
  }

  const connected = () => response({ projectId: "p", remoteName: "vm-01" });

  it("registers the write before git starts, passes argv and the exit code through, and never waits for the VM", async () => {
    await writeFile(join(directory, "exit"), "3");
    let acquired;
    const code = await run(["commit", "-m", "two words"], {
      "/api/git-writes/project": connected,
      "/api/git-writes/acquire": (body) => {
        acquired = { ...body, gitRan: existsSync(join(directory, "args")) };
        return response({ writeId: "hw-1" });
      },
    });
    expect(code).toBe(3);
    expect(calls).toEqual(["/api/git-writes/project", "/api/git-writes/acquire"]);
    expect(acquired).toEqual({ projectId: "p", pid: expect.any(Number), gitRan: false });
    expect((await readFile(join(directory, "args"), "utf8")).split("\n")).toEqual([
      "hold=hw-1",
      "-c",
      "gc.auto=0",
      "commit",
      "-m",
      "two words",
      "",
    ]);
    // Same process group as the supervisor: the child is never detached from the terminal.
    const pgid = execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], {
      encoding: "utf8",
    }).trim();
    expect(await readFile(join(directory, "pgid"), "utf8")).toBe(`${pgid}\n`);
    expect(stderr.lines).toEqual([]);
  });

  it("retries a VM that does not respond for about 60 s with one line, then fails without git", async () => {
    let now = 0;
    const code = await run(
      ["commit"],
      {
        "/api/git-writes/project": connected,
        "/api/git-writes/acquire": () =>
          response({ code: "GIT_VM_UNREACHABLE", message: "offline" }, 503),
      },
      { now: () => (now += 10_000), sleep: async () => {} },
    );
    expect(code).toBe(1);
    expect(calls.filter((path) => path.endsWith("acquire")).length).toBeGreaterThan(1);
    expect(existsSync(join(directory, "args"))).toBe(false);
    expect(stderr.lines).toEqual([
      "git: the VM 'vm-01' does not respond; retrying for up to 60 s.\n",
      "git: the VM 'vm-01' did not respond for 60 s; Git did not run.\n",
    ]);
  });

  it("forwards a termination signal to git and returns git's signal exit code", async () => {
    await writeFile(join(directory, "sleep"), "10");
    const signals = new EventEmitter();
    const started = setInterval(() => {
      if (existsSync(join(directory, "pgid"))) signals.emit("SIGTERM", "SIGTERM");
    }, 10);
    try {
      const code = await run(
        ["fetch"],
        {
          "/api/git-writes/project": connected,
          "/api/git-writes/acquire": () => response({ writeId: "hw-1" }),
        },
        { signals },
      );
      expect(code).toBe(143);
    } finally {
      clearInterval(started);
    }
  });

  it("ends on Ctrl-C while the write waits, without git, and closes the waiting request", async () => {
    const signals = new EventEmitter();
    let closed = false;
    const code = await run(
      ["commit"],
      {
        "/api/git-writes/project": connected,
        "/api/git-writes/acquire": (_body, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => {
              closed = true;
              reject(new Error("aborted"));
            });
            setTimeout(() => signals.emit("SIGINT", "SIGINT"), 20);
          }),
      },
      { signals },
    );
    expect(code).toBe(130);
    expect(closed).toBe(true);
    expect(existsSync(join(directory, "args"))).toBe(false);
    expect(stderr.lines).toEqual([]);
  });

  it("runs git directly, without a write, outside connected projects", async () => {
    const code = await run(["commit"], {
      "/api/git-writes/project": () => response({ projectId: "p", remoteName: null }),
    });
    expect(code).toBe(0);
    expect(calls).toEqual(["/api/git-writes/project"]);
    expect(await readFile(join(directory, "args"), "utf8")).toBe("hold=\ncommit\n");
  });

  describe("on the VM", () => {
    const vm = { DEVCHAIN_GIT_PROJECT: "p", DEVCHAIN_GIT_SIDE: "vm" };
    const identity = (pid) => `boot:${pid}0`;

    it("holds Git for the git process before it starts and releases it after it exits", async () => {
      await writeFile(join(directory, "exit"), "4");
      let acquired;
      let released;
      const code = await run(
        ["commit", "-m", "x"],
        {
          "/api/git-coordinator/projects/p/acquire": (body) => {
            acquired = { ...body, gitRan: existsSync(join(directory, "args")) };
            return response({ owner: "vm" });
          },
          "/api/git-coordinator/projects/p/release": (body) => {
            released = body;
            return response(null);
          },
        },
        { env: vm, processIdentity: identity },
      );
      expect(code).toBe(4);
      const hold = {
        holdId: `vm-${acquired.pid}-${acquired.pid}0`,
        pid: expect.any(Number),
        processStartTime: `boot:${acquired.pid}0`,
      };
      expect(acquired).toEqual({ ...hold, gitRan: false });
      expect(released).toEqual(hold);
      expect((await readFile(join(directory, "args"), "utf8")).split("\n").slice(0, 2)).toEqual([
        `hold=${hold.holdId}`,
        "-c",
      ]);
      expect(stderr.lines).toEqual([]);
    });

    it("prints one line after 1 s of waiting on a terminal", async () => {
      const code = await run(
        ["commit"],
        {
          "/api/git-coordinator/projects/p/acquire": () =>
            new Promise((done) => setTimeout(() => done(response({ owner: "vm" })), 1_100)),
          "/api/git-coordinator/projects/p/release": () => response(null),
        },
        { env: vm, processIdentity: identity, isTTY: true },
      );
      expect(code).toBe(0);
      expect(stderr.lines).toEqual(["git: waiting for Git to come back to this VM…\n"]);
    });

    it("never runs git when the hold is refused", async () => {
      const code = await run(
        ["commit"],
        {
          "/api/git-coordinator/projects/p/acquire": () =>
            response({ code: "GIT_PROJECT_DISCONNECTING", message: "Disconnecting." }, 409),
        },
        { env: vm, processIdentity: identity },
      );
      expect(code).toBe(1);
      expect(existsSync(join(directory, "args"))).toBe(false);
      expect(stderr.lines).toEqual(["git: Disconnecting.\n"]);
    });
  });

  it("refuses to run a write while DevChain is not running", async () => {
    expect(await run(["commit"], {}, { getLocalApiBaseUrl: async () => null })).toBe(1);
    expect(existsSync(join(directory, "args"))).toBe(false);
    expect(stderr.lines[0]).toMatch(/^git: DevChain is not running/);
  });
});

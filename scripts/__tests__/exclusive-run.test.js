const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const { tmpdir, constants } = require("node:os");
const { join } = require("node:path");

// Real processes are the cheapest reliable layer for mkdir races and Unix group lifetimes.
describe("exclusive command process integration", () => {
  let root;
  let env;
  let children;
  let roots;
  const runner = join(__dirname, "fixtures", "queue-runner.js");
  const delay = (ms) => new Promise((done) => setTimeout(done, ms));
  const fileCode = (file, value = "ready") =>
    `require('node:fs').writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(value)});`;
  const exists = (file) => fs.existsSync(file);
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
  };
  async function until(check) {
    const deadline = Date.now() + 4000;
    while (!check()) {
      if (Date.now() > deadline)
        throw new Error("Timed out waiting for queue test condition");
      await delay(10);
    }
  }
  function launch(name, code, options = {}, envOverrides = {}, cwd) {
    const child = spawn(
      process.execPath,
      [
        runner,
        JSON.stringify({
          name,
          command: process.execPath,
          args: ["-e", code],
          pollMs: 20,
          ...options,
        }),
      ],
      {
        env: { ...env, ...envOverrides },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        cwd,
      },
    );
    child.output = "";
    child.errors = "";
    child.stdout.on("data", (data) => {
      child.output += data;
    });
    child.stderr.on("data", (data) => {
      child.errors += data;
    });
    child.result = new Promise((done) =>
      child.once("close", (code, signal) => done({ code, signal })),
    );
    children.push(child);
    return child;
  }
  function holdCode(start, stop) {
    return `${fileCode(start)}
      const timer = setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(stop)})) clearInterval(timer); }, 10);`;
  }
  const ownerFile = (name, lockRoot = root) =>
    join(lockRoot, name, "owner.json");
  const owner = (name, lockRoot) =>
    JSON.parse(fs.readFileSync(ownerFile(name, lockRoot), "utf8"));
  const waiting = (child) =>
    until(() => child.errors.includes("waiting for pid"));
  const touch = (file) => fs.writeFileSync(file, "go");

  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), "devchain-queue-"));
    env = { ...process.env, DEVCHAIN_QUEUE_DIR: root };
    delete env.DEVCHAIN_QUEUE_HELD;
    children = [];
    roots = [root];
  });

  afterEach(async () => {
    for (const lockRoot of roots) {
      for (const name of fs.readdirSync(lockRoot)) {
        try {
          const record = owner(name, lockRoot);
          if (record.pgid && alive(-record.pgid))
            process.kill(-record.pgid, "SIGKILL");
        } catch (error) {
          if (!["ENOENT", "ENOTDIR", "ESRCH"].includes(error.code)) throw error;
        }
      }
    }
    for (const child of children) {
      if (alive(-child.pid)) process.kill(-child.pid, "SIGKILL");
    }
    await Promise.all(children.map((child) => child.result));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("serializes the same name and publishes the holder metadata", async () => {
    const start = join(root, "one-start");
    const stop = join(root, "one-stop");
    const secondStart = join(root, "two-start");
    const first = launch("serialize", holdCode(start, stop));
    await until(() => exists(start));
    const record = owner("serialize");
    expect(record).toEqual(
      expect.objectContaining({
        pid: first.pid,
        pgid: expect.any(Number),
        token: expect.any(String),
        name: "serialize",
        cwd: process.cwd(),
        command: expect.stringContaining(process.execPath),
      }),
    );
    expect(Number.isFinite(Date.parse(record.startedAt))).toBe(true);
    const second = launch("serialize", fileCode(secondStart));
    await waiting(second);
    expect(second.errors).toContain(String(first.pid));
    expect(second.errors).toContain(record.startedAt);
    expect(exists(secondStart)).toBe(false);
    touch(stop);
    expect(await first.result).toEqual({ code: 0, signal: null });
    expect(await second.result).toEqual({ code: 0, signal: null });
    expect(exists(secondStart)).toBe(true);
    expect(exists(join(root, "serialize"))).toBe(false);
    expect(first.errors).toBe("");
    expect(second.errors).toMatch(
      /Queue "serialize" waited \d+s before this run\.\n$/,
    );
  });

  it("runs different names independently and supports an explicit lock root", async () => {
    const separate = join(root, "separate-root");
    fs.mkdirSync(separate);
    roots.push(separate);
    const stop = join(root, "stop");
    const firstStart = join(root, "first-start");
    const secondStart = join(root, "second-start");
    const first = launch("first", holdCode(firstStart, stop));
    await until(() => exists(firstStart));
    const second = launch("second", holdCode(secondStart, stop), {
      lockRoot: separate,
    });
    await until(() => exists(secondStart));
    expect(owner("second", separate).pid).toBe(second.pid);
    touch(stop);
    expect((await first.result).code).toBe(0);
    expect((await second.result).code).toBe(0);
  });

  it("shares the queue across project working directories and repeats the wait notice once per minute", async () => {
    const firstProject = join(root, "project-one");
    const secondProject = join(root, "project-two");
    fs.mkdirSync(firstProject);
    fs.mkdirSync(secondProject);
    const ready = join(root, "ready");
    const stop = join(root, "stop");
    const clockFile = join(root, "clock-step");
    const first = launch(
      "projects",
      holdCode(ready, stop),
      {},
      {},
      firstProject,
    );
    await until(() => exists(ready));
    expect(owner("projects").cwd).toBe(firstProject);
    const second = launch(
      "projects",
      "process.exit(0)",
      {},
      { QUEUE_TEST_CLOCK_FILE: clockFile },
      secondProject,
    );
    await waiting(second);
    expect(second.errors.match(/waiting for pid/g)).toHaveLength(1);
    expect(second.errors).not.toContain("Waited");
    touch(clockFile);
    await until(() => second.errors.match(/waiting for pid/g)?.length === 2);
    expect(second.errors).toMatch(/\. Waited 1m \d+s\.\n/);
    expect(owner("projects").pid).toBe(first.pid);
    touch(stop);
    expect((await first.result).code).toBe(0);
    expect((await second.result).code).toBe(0);
    expect(second.errors).toMatch(
      /Queue "projects" waited 1m \d+s before this run\.\n$/,
    );
  });

  it.each(["SIGINT", "SIGTERM", "SIGHUP"])(
    "forwards %s to a launcher and grandchild and holds the lock until the grandchild exits",
    async (signal) => {
      const childReady = join(root, "grandchild-ready");
      const childSignal = join(root, "grandchild-signal");
      const stop = join(root, "grandchild-stop");
      const secondStart = join(root, "second-start");
      const grandchildCode = `for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { ${fileCode(childSignal, signal)} });
      ${holdCode(childReady, stop)}`;
      const launcherCode = `const { spawn } = require('node:child_process');
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(0));
      spawn(process.execPath, ['-e', ${JSON.stringify(grandchildCode)}], { stdio: 'inherit' });`;
      const first = launch("tree", launcherCode);
      await until(() => exists(childReady));
      const record = owner("tree");
      const second = launch("tree", fileCode(secondStart));
      await waiting(second);
      first.kill(signal);
      await until(() => exists(childSignal) && !alive(record.pgid));
      expect(fs.readFileSync(childSignal, "utf8")).toBe(signal);
      expect(alive(-record.pgid)).toBe(true);
      expect(owner("tree").token).toBe(record.token);
      expect(exists(secondStart)).toBe(false);
      touch(stop);
      expect(await first.result).toEqual({
        code: 128 + constants.signals[signal],
        signal: null,
      });
      expect((await second.result).code).toBe(0);
      expect(alive(-record.pgid)).toBe(false);
    },
  );

  it("keeps the lock while a slow command handles SIGTERM", async () => {
    const ready = join(root, "ready");
    const signalled = join(root, "signalled");
    const stop = join(root, "stop");
    const first = launch(
      "slow",
      `process.on('SIGTERM', () => { ${fileCode(signalled)} });
      ${holdCode(ready, stop)}`,
    );
    await until(() => exists(ready));
    const record = owner("slow");
    const second = launch("slow", "process.exit(0)");
    await waiting(second);
    first.kill("SIGTERM");
    await until(() => exists(signalled));
    expect(alive(record.pgid)).toBe(true);
    expect(owner("slow").token).toBe(record.token);
    touch(stop);
    expect((await first.result).code).toBe(143);
    expect((await second.result).code).toBe(0);
  });

  it("retains a killed queue owner lock until its command group ends, then reclaims it", async () => {
    const ready = join(root, "ready");
    const stop = join(root, "stop");
    const secondStart = join(root, "second-start");
    const first = launch("orphan", holdCode(ready, stop));
    await until(() => exists(ready));
    const record = owner("orphan");
    first.kill("SIGKILL");
    await until(() => !alive(first.pid));
    const second = launch("orphan", fileCode(secondStart));
    await waiting(second);
    expect(owner("orphan").token).toBe(record.token);
    expect(exists(secondStart)).toBe(false);
    touch(stop);
    expect((await second.result).code).toBe(0);
    expect(exists(secondStart)).toBe(true);
    expect((await first.result).signal).toBe("SIGKILL");
  });

  it("does not let a second stale reader remove the replacement owner lock", async () => {
    fs.mkdirSync(join(root, "race"));
    const dead = {
      pid: 2147483647,
      pgid: 2147483647,
      token: "dead",
      command: "dead command",
      startedAt: new Date(0).toISOString(),
    };
    fs.writeFileSync(ownerFile("race"), JSON.stringify(dead));
    const gateA = join(root, "gate-a");
    const gateB = join(root, "gate-b");
    const startA = join(root, "start-a");
    const startB = join(root, "start-b");
    const stopA = join(root, "stop-a");
    const a = launch(
      "race",
      holdCode(startA, stopA),
      {},
      { QUEUE_TEST_READ_GATE: gateA, QUEUE_TEST_OWNER_FILE: ownerFile("race") },
    );
    const b = launch(
      "race",
      fileCode(startB),
      {},
      { QUEUE_TEST_READ_GATE: gateB, QUEUE_TEST_OWNER_FILE: ownerFile("race") },
    );
    await until(() => exists(`${gateA}.read`) && exists(`${gateB}.read`));
    expect(JSON.parse(fs.readFileSync(`${gateA}.read`, "utf8")).token).toBe(
      "dead",
    );
    expect(JSON.parse(fs.readFileSync(`${gateB}.read`, "utf8")).token).toBe(
      "dead",
    );
    touch(gateA);
    await until(() => exists(startA));
    const replacement = owner("race");
    touch(gateB);
    await waiting(b);
    expect(owner("race").token).toBe(replacement.token);
    expect(exists(startB)).toBe(false);
    touch(stopA);
    expect((await a.result).code).toBe(0);
    expect((await b.result).code).toBe(0);
  });

  it.each(["recent-dead", "old-live", "old-dead"])(
    "respects the reclaim guard age and liveness for %s",
    async (kind) => {
      fs.mkdirSync(join(root, "guarded"));
      fs.writeFileSync(
        ownerFile("guarded"),
        JSON.stringify({ pid: 2147483647, pgid: 2147483647, token: "dead" }),
      );
      const guard = join(root, "guarded.reclaim");
      fs.mkdirSync(guard);
      fs.writeFileSync(
        join(guard, "owner-aabb.json"),
        JSON.stringify({
          pid: kind === "old-live" ? process.pid : 2147483647,
          startedAt: new Date(
            Date.now() - (kind === "recent-dead" ? 1000 : 61000),
          ).toISOString(),
        }),
      );
      const start = join(root, "start");
      const child = launch("guarded", fileCode(start));
      if (kind !== "old-dead") {
        await waiting(child);
        expect(exists(start)).toBe(false);
        expect(owner("guarded").token).toBe("dead");
        fs.rmSync(guard, { recursive: true });
      }
      expect((await child.result).code).toBe(0);
      expect(exists(start)).toBe(true);
      expect(exists(guard)).toBe(false);
    },
  );

  it("runs a live nested queue immediately without releasing the outer lock", async () => {
    const nested = join(root, "nested-start");
    const ready = join(root, "ready");
    const stop = join(root, "stop");
    const nestedOptions = {
      name: "nested",
      command: process.execPath,
      args: ["-e", fileCode(nested)],
      pollMs: 20,
    };
    const first = launch(
      "nested",
      `require('node:child_process').execFileSync(process.execPath, [${JSON.stringify(runner)}, ${JSON.stringify(JSON.stringify(nestedOptions))}], { stdio: 'inherit' }); ${holdCode(ready, stop)}`,
    );
    await until(() => exists(ready));
    expect(exists(nested)).toBe(true);
    expect(owner("nested").pid).toBe(first.pid);
    const second = launch("nested", "process.exit(0)");
    await waiting(second);
    touch(stop);
    expect((await first.result).code).toBe(0);
    expect((await second.result).code).toBe(0);
  });

  it.each(["stale-token", "foreign-root", "dead-owner"])(
    "does not skip the lock for a %s marker",
    async (kind) => {
      const ready = join(root, "ready");
      const stop = join(root, "stop");
      const started = join(root, "started");
      const first = launch("marker", holdCode(ready, stop));
      await until(() => exists(ready));
      const record = owner("marker");
      let token = record.token;
      let lockRoot = root;
      if (kind === "stale-token") token = "stale";
      if (kind === "dead-owner") {
        first.kill("SIGKILL");
        await until(() => !alive(first.pid));
      }
      if (kind === "foreign-root") {
        lockRoot = join(root, "foreign-root");
        fs.mkdirSync(lockRoot);
        roots.push(lockRoot);
        fs.mkdirSync(join(lockRoot, "marker"));
        fs.writeFileSync(
          ownerFile("marker", lockRoot),
          JSON.stringify({ ...record, token: "different", pid: process.pid }),
        );
      }
      const second = launch(
        "marker",
        fileCode(started),
        {},
        {
          DEVCHAIN_QUEUE_HELD: `marker@${token}`,
          DEVCHAIN_QUEUE_DIR: lockRoot,
        },
      );
      await waiting(second);
      expect(exists(started)).toBe(false);
      if (kind === "foreign-root")
        fs.rmSync(join(lockRoot, "marker"), { recursive: true });
      touch(stop);
      expect((await second.result).code).toBe(0);
      await first.result;
    },
  );

  it("cancels a waiter without running its command or removing the holder lock", async () => {
    const ready = join(root, "ready");
    const stop = join(root, "stop");
    const started = join(root, "started");
    const first = launch("wait-cancel", holdCode(ready, stop));
    await until(() => exists(ready));
    const record = owner("wait-cancel");
    const second = launch("wait-cancel", fileCode(started), { pollMs: 2000 });
    await waiting(second);
    second.kill("SIGINT");
    expect((await second.result).code).toBe(130);
    expect(exists(started)).toBe(false);
    expect(owner("wait-cancel").token).toBe(record.token);
    touch(stop);
    await first.result;
  });

  it("returns exit codes and command signals for the unlocked runner", async () => {
    const exit = launch("unlocked", "process.exit(7)", { unlocked: true });
    expect((await exit.result).code).toBe(7);
    const signal = launch("unlocked", "process.kill(process.pid, 'SIGTERM')", {
      unlocked: true,
    });
    expect((await signal.result).code).toBe(143);
    expect(exists(join(root, "unlocked"))).toBe(false);
  });

  const userScope =
    process.platform === "linux" &&
    spawnSync(
      "systemd-run",
      [
        "--user",
        "--scope",
        "--quiet",
        "--collect",
        "--expand-environment=no",
        "--",
        "true",
      ],
      { stdio: "ignore" },
    ).status === 0;

  (userScope ? it : it.skip)(
    "runs the command in its own user scope with literal arguments",
    async () => {
      const report = join(root, "report.json");
      const literal = "literal ${HOME} $$ \\$x";
      const child = launch("scoped", "", {
        unlocked: true,
        args: [
          "-e",
          `const fs = require('node:fs');
            fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({
              arg: process.argv[1],
              cgroup: fs.readFileSync('/proc/self/cgroup', 'utf8'),
            }));`,
          literal,
        ],
      });
      expect((await child.result).code).toBe(0);
      const { arg, cgroup } = JSON.parse(fs.readFileSync(report, "utf8"));
      expect(arg).toBe(literal);
      expect(cgroup).toMatch(/\/run-[^/]+\.scope$/m);
      expect(cgroup).not.toBe(fs.readFileSync("/proc/self/cgroup", "utf8"));
    },
  );
});

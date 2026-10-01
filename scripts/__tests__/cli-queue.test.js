const { spawnSync } = require("node:child_process");
const { mkdtempSync, rmSync, readdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

// A CLI subprocess is the cheapest reliable layer for Commander parsing and exit status.
describe("devchain queue CLI", () => {
  let root;
  let env;
  const cli = join(__dirname, "..", "cli.js");
  const run = (...args) =>
    spawnSync(process.execPath, [cli, ...args], {
      env,
      encoding: "utf8",
      timeout: 8000,
    });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "devchain-queue-cli-"));
    env = { ...process.env, DEVCHAIN_QUEUE_DIR: root };
    delete env.DEVCHAIN_QUEUE_HELD;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("runs a command through PATH and returns its exit code", () => {
    const result = run(
      "queue",
      "full-tests",
      "--",
      "node",
      "-e",
      'console.log("queued"); process.exit(7)',
    );
    expect(result.stdout.trim()).toBe("queued");
    expect(result.status).toBe(7);
    expect(result.stderr).toBe("");
    expect(readdirSync(root)).toEqual([]);
  });

  it("passes nested --, --version, -h, and shell metacharacters as literal arguments", () => {
    const args = [
      "--",
      "--version",
      "-h",
      "space separated",
      "$(exit 8)",
      ";exit 9",
      "*",
    ];
    const result = run(
      "queue",
      "args",
      "--",
      process.execPath,
      "-e",
      "console.log(JSON.stringify(process.argv.slice(1)))",
      "--",
      ...args,
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(args);
  });

  it.each([
    ["queue", "empty"],
    ["queue", "empty", "--"],
    ["queue", "missing-separator", "node"],
    ["queue", "late-separator", "node", "--", "-h"],
  ])("requires a command after the required separator: %j", (...args) => {
    const result = run(...args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "usage: devchain queue <name> -- <command>",
    );
    expect(readdirSync(root)).toEqual([]);
  });

  it.each(["../escape", "UPPER", "has space", "x".repeat(65)])(
    "rejects invalid queue name %s",
    (name) => {
      const result = run(
        "queue",
        name,
        "--",
        process.execPath,
        "-e",
        "process.exit(0)",
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("queue name must match");
      expect(readdirSync(root)).toEqual([]);
    },
  );

  it("names the queue and missing command in an ENOENT error and releases the lock", () => {
    const result = run(
      "queue",
      "missing",
      "--",
      "devchain-no-such-queue-command",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Queue "missing"');
    expect(result.stderr).toContain("devchain-no-such-queue-command");
    expect(result.stderr).toContain("ENOENT");
    expect(readdirSync(root)).toEqual([]);
  });

  it("returns 128 plus the command signal number", () => {
    const result = run(
      "queue",
      "signal-code",
      "--",
      process.execPath,
      "-e",
      "process.kill(process.pid, 'SIGTERM')",
    );
    expect(result.status).toBe(143);
  });

  it("documents the required separator in help while preserving start and host options", () => {
    expect(run("queue", "--help").stdout).toContain(
      "devchain queue <name> -- <command> [args…]",
    );
    expect(run("start", "--help").stdout).toContain("--no-open");
    expect(run("host", "install", "--help").stdout).toContain(
      "--password-stdin",
    );
    expect(run("--version").status).toBe(0);
  });
});
